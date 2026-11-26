/**
 * Оверлей Netgraph і панель налагодження мережі (перемикається клавішами Tab або F3).
 *
 * Показує в реальному часі:
 *   - RTT (ms), Snapshot age (ms), Bytes In/Out (KB/s), Pending inputs, Correction magnitude;
 *   - графік RTT та величини коррекції;
 *   - перемикач кодека (Binary / JSON) і повзунки емуляції мережі (Latency, Jitter, Packet Drop %)
 *     та затримки інтерполяції (Interpolation Delay).
 */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function makeSlider({ label, min, max, step, value, format, onInput }) {
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
    setValue(num) {
      input.value = String(num);
      readout.textContent = format(num);
    },
    setDisabled(disabled) {
      input.disabled = disabled;
    },
  };
}

/**
 * @param {object} options
 * @param {HTMLElement} options.container
 * @param {import('../net/net_client.js').NetClient | null} [options.net]
 */
export function createNetgraph({ container, net = null }) {
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
  const cells = {};
  for (const [key, label] of [
    ['rtt', 'RTT'],
    ['age', 'Snapshot age'],
    ['bw', 'In / Out'],
    ['pending', 'Pending inputs'],
    ['corr', 'Correction'],
    ['tick', 'Server tick'],
  ]) {
    const dt = el('dt', '', label);
    const dd = el('dd', '', '—');
    grid.append(dt, dd);
    cells[key] = dd;
  }

  const controls = el('div', 'netgraph__controls');
  let latencySlider;
  let jitterSlider;
  let dropSlider;
  let interpSlider;

  if (net) {
    codecBtn.addEventListener('click', () => {
      const next = net.codec === 'binary' ? 'json' : 'binary';
      net.setCodec(next);
      codecBtn.textContent = next.toUpperCase();
    });

    latencySlider = makeSlider({
      label: 'Latency',
      min: 0,
      max: 400,
      step: 10,
      value: net.netsim.latency,
      format: (v) => `${v} ms`,
      onInput: (latency) => net.setNetsim({ latency }),
    });
    jitterSlider = makeSlider({
      label: 'Jitter',
      min: 0,
      max: 150,
      step: 5,
      value: net.netsim.jitter,
      format: (v) => `${v} ms`,
      onInput: (jitter) => net.setNetsim({ jitter }),
    });
    dropSlider = makeSlider({
      label: 'Packet Drop',
      min: 0,
      max: 25,
      step: 1,
      value: Math.round(net.netsim.drop * 100),
      format: (v) => `${v}%`,
      onInput: (pct) => net.setNetsim({ drop: pct / 100 }),
    });
    interpSlider = makeSlider({
      label: 'Interp Delay',
      min: 0,
      max: 250,
      step: 10,
      value: net.interpolationDelayMs,
      format: (v) => `${v} ms`,
      onInput: (ms) => net.setInterpolationDelay(ms),
    });
    controls.append(latencySlider.row, jitterSlider.row, dropSlider.row, interpSlider.row);

    const onStarted = () => {
      codecBtn.textContent = net.codec.toUpperCase();
      latencySlider.setValue(net.netsim.latency);
      jitterSlider.setValue(net.netsim.jitter);
      dropSlider.setValue(Math.round(net.netsim.drop * 100));
      const disabled = !net.netsimEnabled;
      latencySlider.setDisabled(disabled);
      jitterSlider.setDisabled(disabled);
      dropSlider.setDisabled(disabled);
    };
    net.addEventListener('started', onStarted);
  } else {
    controls.append(el('p', 'netgraph__offline', 'Офлайн-режим: локальна симуляція без мережі'));
  }

  panel.append(header, graph, grid, controls);
  container.append(panel);

  function toggle() {
    panel.hidden = !panel.hidden;
  }

  function onKeyDown(event) {
    if ((event.code === 'Tab' || event.code === 'F3') && !event.repeat) {
      event.preventDefault();
      toggle();
    }
  }
  window.addEventListener('keydown', onKeyDown);

  let lastDrawAt = 0;

  function drawSparkline(history) {
    if (!gctx) return;
    const { width, height } = graph;
    gctx.fillStyle = '#070d18';
    gctx.fillRect(0, 0, width, height);

    // Сітка
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

    // RTT (блакитний)
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

    // Величина коррекції (бурштиновий)
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

  function update(now) {
    if (panel.hidden || now - lastDrawAt < 100) return;
    lastDrawAt = now;
    if (!net) {
      cells.rtt.textContent = '0 ms';
      cells.age.textContent = '0 ms';
      cells.bw.textContent = '0.0 / 0.0 KB/s';
      cells.pending.textContent = '0';
      cells.corr.textContent = '0.0 px';
      cells.tick.textContent = 'local';
      drawSparkline([]);
      return;
    }
    const m = net.getMetrics(now);
    codecBtn.textContent = m.codec.toUpperCase();
    cells.rtt.textContent = `${m.rttMs.toFixed(1)} ms`;
    cells.age.textContent = `${m.snapshotAgeMs.toFixed(0)} ms`;
    cells.bw.textContent = `${m.kbInPerSec.toFixed(1)} / ${m.kbOutPerSec.toFixed(1)} KB/s`;
    cells.pending.textContent = String(m.pendingInputs);
    cells.corr.textContent = `${m.correctionMag.toFixed(1)} px`;
    cells.tick.textContent = String(m.tick);
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
