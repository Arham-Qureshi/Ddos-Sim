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

// chartData + a live tip extrapolated to `nowMs` so the line keeps gliding at
// 60fps between the 2Hz ws ticks. the projection eases out (exponential decay)
// so the tip starts on the real slope then settles instead of driving a hard
// straight line that snaps when the next real point lands. flat-hold with a
// single point; clamped so rps/pct never dip below zero.
const TIP_TAU_MS = 250; // time-constant that softens the extrapolated slope

export function chartDataLive(series, key, nowMs) {
  const pts = chartData(series, key);
  const last = pts[pts.length - 1];
  if (!last || nowMs <= last[0]) return pts;
  let val = last[1];
  if (pts.length >= 2) {
    const [t0, v0] = pts[pts.length - 2];
    const dt = last[0] - t0;
    if (dt > 0) {
      const slope = (last[1] - v0) / dt;
      const elapsed = nowMs - last[0];
      val = last[1] + slope * TIP_TAU_MS * (1 - Math.exp(-elapsed / TIP_TAU_MS));
    }
  }
  return [...pts, [nowMs, Math.max(0, val)]];
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