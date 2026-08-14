// pure data helpers for the dashboard — unit-testable, no DOM/echarts here

export const WINDOW_CAPACITY = 120; // ~60s at 2Hz, mirrors server history

// tiny fixed-size ring buffer of {ts, value} points per series
export class RingBuffer {
  constructor(capacity = WINDOW_CAPACITY) {
    this.capacity = capacity;
    this.points = [];
  }

  push(point) {
    this.points.push(point);
    if (this.points.length > this.capacity) {
      this.points.shift(); // oldest out, window stays bounded
    }
  }

  toArray() {
    return this.points.slice();
  }
}

// the five series the dashboard renders (rps + the sparkline pair)
const KEYS = ["normal", "attack", "blocked", "conns", "cpu"];

// seed five buffers from the server's history REST payload
export function seedSeries(history = []) {
  const series = {};
  for (const key of KEYS) series[key] = new RingBuffer();
  for (const f of history) {
    const m = f.metrics || {};
    const ts = f.timestamp;
    series.normal.push({ ts, value: m.normal_rps ?? 0 });
    series.attack.push({ ts, value: m.attack_rps ?? 0 });
    series.blocked.push({ ts, value: m.blocked_rps ?? 0 });
    series.conns.push({ ts, value: m.connections_per_sec ?? 0 });
    series.cpu.push({ ts, value: m.cpu_load_pct ?? 0 });
  }
  return series;
}

// shape one series buffer into echarts [timeMs, value] points (null-safe)
export function chartData(series, key) {
  const buf = series?.[key];
  return buf ? buf.toArray().map((p) => [p.ts * 1000, p.value]) : [];
}

// ingest one live ws frame into the buffers
export function ingestFrame(frame, series) {
  series.normal.push({ ts: frame.ts, value: frame.normal_rps ?? 0 });
  series.attack.push({ ts: frame.ts, value: frame.attack_rps ?? 0 });
  series.blocked.push({ ts: frame.ts, value: frame.blocked_rps ?? 0 });
  series.conns.push({ ts: frame.ts, value: frame.connections_per_sec ?? 0 });
  series.cpu.push({ ts: frame.ts, value: frame.cpu_load_pct ?? 0 });
}

// cosmetic one-liner to floor a ticking countdown at zero (none => "permanent")
export function floorCountdown(remaining) {
  if (remaining === null || remaining === undefined) return null;
  return Math.max(0, Math.ceil(remaining));
}