/**
 * Метрики Prometheus (prom-client) для GET /metrics.
 * Кожен екземпляр App має власний Registry (безпечно для паралельних тестів).
 */

import { performance } from 'node:perf_hooks';
import { Counter, Gauge, Registry } from 'prom-client';

export type RejectionReason =
  'origin' | 'ip_limit' | 'rate_limit' | 'invalid_payload' | 'server_full' | 'policy';

export interface MetricsCollector {
  readonly registry: Registry;
  recordMessage(direction: 'in' | 'out', bytes: number): void;
  recordRejection(reason: RejectionReason): void;
  render(snapshot: {
    readonly players: number;
    readonly rooms: number;
    readonly tickP99Ms: number;
  }): Promise<{ readonly contentType: string; readonly body: string }>;
}

export function createMetrics(): MetricsCollector {
  const registry = new Registry();

  const playersConnected = new Gauge({
    name: 'dogfight_players_connected',
    help: 'Number of currently connected WebSocket clients',
    registers: [registry],
  });

  const roomsActive = new Gauge({
    name: 'dogfight_rooms_active',
    help: 'Number of active game rooms',
    registers: [registry],
  });

  const wsMessages = new Counter({
    name: 'dogfight_ws_messages_total',
    help: 'Total WebSocket messages processed by direction',
    labelNames: ['direction'] as const,
    registers: [registry],
  });

  const wsBytes = new Counter({
    name: 'dogfight_ws_bytes_total',
    help: 'Total WebSocket bytes transferred by direction',
    labelNames: ['direction'] as const,
    registers: [registry],
  });

  const tickP99 = new Gauge({
    name: 'dogfight_tick_duration_p99_ms',
    help: '99th percentile authoritative server tick duration in milliseconds',
    registers: [registry],
  });

  const eluGauge = new Gauge({
    name: 'dogfight_event_loop_utilization',
    help: 'Node.js event loop utilization ratio (0..1)',
    registers: [registry],
  });

  const rssGauge = new Gauge({
    name: 'dogfight_process_rss_bytes',
    help: 'Resident set size memory usage in bytes',
    registers: [registry],
  });

  const wsRejected = new Counter({
    name: 'dogfight_ws_rejected_total',
    help: 'Total rejected WebSocket connections or frames by reason',
    labelNames: ['reason'] as const,
    registers: [registry],
  });

  return {
    registry,
    recordMessage(direction, bytes) {
      wsMessages.inc({ direction }, 1);
      if (bytes > 0) wsBytes.inc({ direction }, bytes);
    },
    recordRejection(reason) {
      wsRejected.inc({ reason }, 1);
    },
    async render({ players, rooms, tickP99Ms }) {
      playersConnected.set(players);
      roomsActive.set(rooms);
      tickP99.set(tickP99Ms);
      eluGauge.set(performance.eventLoopUtilization().utilization);
      rssGauge.set(process.memoryUsage().rss);
      return {
        contentType: registry.contentType,
        body: await registry.metrics(),
      };
    },
  };
}
