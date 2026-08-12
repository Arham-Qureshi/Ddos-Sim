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

// seed three buffers from the server's history REST payload
export function seedSeries(history = []) {
  const normal = new RingBuffer();
  const attack = new RingBuffer();
  const blocked = new RingBuffer();
  for (const f of history) {
    const m = f.metrics || {};
    const ts = f.timestamp;
    normal.push({ ts, value: m.normal_rps ?? 0 });
    attack.push({ ts, value: m.attack_rps ?? 0 });
    blocked.push({ ts, value: m.blocked_rps ?? 0 });
  }
  return { normal, attack, blocked };
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
}