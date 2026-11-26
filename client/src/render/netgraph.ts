/**
 * Оверлей Netgraph і панель налагодження мережі (перемикається клавішами Tab або F3).
 */

import type { NetClient, NetHistorySample } from '../net/net_client.ts';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

interface SliderHandle {
  readonly row: HTMLLabelElement;
  setValue(num: number): void;
  setDisabled(disabled: boolean): void;
}

function makeSlider({
  label,
  min,
  max,
  step,
  value,
  format,
  onInput,
}: {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly value: number;
  readonly format: (v: number) => string;
  readonly onInput: (v: number) => void;
}): SliderHandle {
  const row = el('label', 'netgraph__slider');
  const head = el('span', 'netgraph__slider-head');
  const title = el('span', '', label);
  const readout = el('span', 'netgraph__value', format(value));
  head.append(title, readout);

  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener('input', () => {
    const num = Number(input.value);
    readout.textContent = format(num);
    onInput(num);
  });

  row.append(head, input);
  return {
    row,
    setValue(num: number) {
      input.value = String(num);
      readout.textContent = format(num);
    },
    setDisabled(disabled: boolean) {
      input.disabled = disabled;
    },
  };
}

export interface NetgraphHandle {
  toggle(): void;
  update(now: number): void;
  destroy(): void;
}

export function createNetgraph({
  container,
  net = null,
}: {
  readonly container: HTMLElement;
  readonly net?: NetClient | null;
}): NetgraphHandle {
  const panel = el('aside', 'netgraph');
  panel.setAttribute('aria-label', 'Netgraph');
  panel.hidden = true;

  const header = el('div', 'netgraph__header');
  const title = el('strong', 'netgraph__title', net ? 'NETGRAPH (ONLINE)' : 'NETGRAPH (OFFLINE)');
  const codecBtn = el('button', 'netgraph__codec', net ? net.codec.toUpperCase() : 'LOCAL');
  codecBtn.type = 'button';
  codecBtn.disabled = !net;
  header.append(title, codecBtn);

  const graph = document.createElement('canvas');
  graph.className = 'netgraph__canvas';
  graph.width = 260;
  graph.height = 68;
  const gctx = graph.getContext('2d');

  const grid = el('dl', 'netgraph__metrics');
  const rttCell = el('dd', '', '—');
  const ageCell = el('dd', '', '—');
  const bwCell = el('dd', '', '—');
  const pendingCell = el('dd', '', '—');
  const corrCell = el('dd', '', '—');
  const tickCell = el('dd', '', '—');

  const rows: readonly (readonly [string, HTMLElement])[] = [
    ['RTT', rttCell],
    ['Snapshot age', ageCell],
    ['In / Out', bwCell],
    ['Pending inputs', pendingCell],
    ['Correction', corrCell],
    ['Server tick', tickCell],
  ];
  for (const [label, dd] of rows) {
    grid.append(el('dt', '', label), dd);
  }

  const controls = el('div', 'netgraph__controls');
  if (net) {
    codecBtn.addEventListener('click', () => {
      const next = net.codec === 'binary' ? 'json' : 'binary';
      net.setCodec(next);
      codecBtn.textContent = next.toUpperCase();
    });

    const latencySlider = makeSlider({
      label: 'Latency',
      min: 0,
      max: 400,
      step: 10,
      value: net.netsim.latency,
      format: (v) => `${v} ms`,
      onInput: (latency) => net.setNetsim({ latency }),
    });
    const jitterSlider = makeSlider({
      label: 'Jitter',
      min: 0,
      max: 150,
      step: 5,
      value: net.netsim.jitter,
      format: (v) => `${v} ms`,
      onInput: (jitter) => net.setNetsim({ jitter }),
    });
    const dropSlider = makeSlider({
      label: 'Packet Drop',
      min: 0,
      max: 25,
      step: 1,
      value: Math.round(net.netsim.drop * 100),
      format: (v) => `${v}%`,
      onInput: (pct) => net.setNetsim({ drop: pct / 100 }),
    });
    const interpSlider = makeSlider({
      label: 'Interp Delay',
      min: 0,
      max: 250,
      step: 10,
      value: net.interpolationDelayMs,
      format: (v) => `${v} ms`,
      onInput: (ms) => net.setInterpolationDelay(ms),
    });
    controls.append(latencySlider.row, jitterSlider.row, dropSlider.row, interpSlider.row);

    net.addEventListener('started', () => {
      codecBtn.textContent = net.codec.toUpperCase();
      latencySlider.setValue(net.netsim.latency);
      jitterSlider.setValue(net.netsim.jitter);
      dropSlider.setValue(Math.round(net.netsim.drop * 100));
      const disabled = !net.netsimEnabled;
      latencySlider.setDisabled(disabled);
      jitterSlider.setDisabled(disabled);
      dropSlider.setDisabled(disabled);
    });
  } else {
    controls.append(el('p', 'netgraph__offline', 'Офлайн-режим: локальна симуляція без мережі'));
  }

  panel.append(header, graph, grid, controls);
  container.append(panel);

  function toggle(): void {
    panel.hidden = !panel.hidden;
  }

  function onKeyDown(event: KeyboardEvent): void {
    if ((event.code === 'Tab' || event.code === 'F3') && !event.repeat) {
      event.preventDefault();
      toggle();
    }
  }
  window.addEventListener('keydown', onKeyDown);

  let lastDrawAt = 0;

  function drawSparkline(history: readonly NetHistorySample[]): void {
    if (!gctx) return;
    const { width, height } = graph;
    gctx.fillStyle = '#070d18';
    gctx.fillRect(0, 0, width, height);

    gctx.strokeStyle = 'rgba(130, 170, 230, 0.14)';
    gctx.lineWidth = 1;
    gctx.beginPath();
    gctx.moveTo(0, height * 0.5);
    gctx.lineTo(width, height * 0.5);
    gctx.stroke();

    if (!history.length) return;
    const maxRtt = Math.max(100, ...history.map((h) => h.rttMs));
    const maxCorr = Math.max(20, ...history.map((h) => h.correctionMag));
    const stepX = width / Math.max(1, history.length - 1);

    gctx.strokeStyle = '#5fd7ff';
    gctx.lineWidth = 1.5;
    gctx.beginPath();
    history.forEach((h, i) => {
      const x = i * stepX;
      const y = height - 4 - (h.rttMs / maxRtt) * (height - 10);
      if (i === 0) gctx.moveTo(x, y);
      else gctx.lineTo(x, y);
    });
    gctx.stroke();

    gctx.strokeStyle = '#ffb84d';
    gctx.lineWidth = 1.3;
    gctx.beginPath();
    history.forEach((h, i) => {
      const x = i * stepX;
      const y = height - 4 - (h.correctionMag / maxCorr) * (height - 10);
      if (i === 0) gctx.moveTo(x, y);
      else gctx.lineTo(x, y);
    });
    gctx.stroke();
  }

  function update(now: number): void {
    if (panel.hidden || now - lastDrawAt < 100) return;
    lastDrawAt = now;
    if (!net) {
      rttCell.textContent = '0 ms';
      ageCell.textContent = '0 ms';
      bwCell.textContent = '0.0 / 0.0 KB/s';
      pendingCell.textContent = '0';
      corrCell.textContent = '0.0 px';
      tickCell.textContent = 'local';
      drawSparkline([]);
      return;
    }
    const m = net.getMetrics(now);
    codecBtn.textContent = m.codec.toUpperCase();
    rttCell.textContent = `${m.rttMs.toFixed(1)} ms`;
    ageCell.textContent = `${m.snapshotAgeMs.toFixed(0)} ms`;
    bwCell.textContent = `${m.kbInPerSec.toFixed(1)} / ${m.kbOutPerSec.toFixed(1)} KB/s`;
    pendingCell.textContent = String(m.pendingInputs);
    corrCell.textContent = `${m.correctionMag.toFixed(1)} px`;
    tickCell.textContent = String(m.tick);
    drawSparkline(m.history);
  }

  return {
    toggle,
    update,
    destroy() {
      window.removeEventListener('keydown', onKeyDown);
      panel.remove();
    },
  };
}
