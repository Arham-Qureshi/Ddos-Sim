import { describe, it, expect } from "vitest";
import {
  RingBuffer,
  seedSeries,
  ingestFrame,
  chartData,
  floorCountdown,
} from "../src/telemetry.js";

describe("RingBuffer", () => {
  it("append keeps newest points", () => {
    const r = new RingBuffer(3);
    r.push({ ts: 1, value: 1 });
    r.push({ ts: 2, value: 2 });
    r.push({ ts: 3, value: 3 });
    r.push({ ts: 4, value: 4 });
    expect(r.toArray()).toEqual([
      { ts: 2, value: 2 },
      { ts: 3, value: 3 },
      { ts: 4, value: 4 },
    ]);
  });

  it("never grows past capacity", () => {
    const r = new RingBuffer(5);
    for (let i = 0; i < 100; i++) r.push({ ts: i, value: i });
    expect(r.toArray().length).toBe(5);
  });

  it("defaults to the 120-point window", () => {
    const r = new RingBuffer();
    for (let i = 0; i < 500; i++) r.push({ ts: i, value: i });
    expect(r.toArray().length).toBe(120);
  });
});

describe("seedSeries", () => {
  it("maps history into all five buffers", () => {
    const hist = [
      {
        timestamp: 1,
        metrics: {
          normal_rps: 1, attack_rps: 10, blocked_rps: 2,
          connections_per_sec: 8, cpu_load_pct: 40,
        },
      },
      { timestamp: 2, metrics: { normal_rps: 3, attack_rps: 0, blocked_rps: 0 } },
    ];
    const s = seedSeries(hist);
    expect(s.normal.toArray().map((p) => p.value)).toEqual([1, 3]);
    expect(s.attack.toArray().map((p) => p.value)).toEqual([10, 0]);
    expect(s.blocked.toArray().map((p) => p.value)).toEqual([2, 0]);
    expect(s.conns.toArray().map((p) => p.value)).toEqual([8, 0]);
    expect(s.cpu.toArray().map((p) => p.value)).toEqual([40, 0]);
    expect(s.normal.toArray()[0].ts).toBe(1);
  });

  it("tolerates missing metrics", () => {
    const s = seedSeries([{ timestamp: 7 }]);
    expect(s.normal.toArray()).toEqual([{ ts: 7, value: 0 }]);
    expect(s.conns.toArray()).toEqual([{ ts: 7, value: 0 }]);
  });
});

describe("chartData", () => {
  it("returns [] when series is missing (boot-safe)", () => {
    expect(chartData(null, "normal")).toEqual([]);
  });

  it("returns [] for an unknown key", () => {
    expect(chartData({ normal: new RingBuffer() }, "attack")).toEqual([]);
  });

  it("maps buffer points to [ms, value] pairs for echarts", () => {
    const buf = new RingBuffer();
    buf.push({ ts: 1, value: 10 });
    buf.push({ ts: 2, value: 20 });
    expect(chartData({ attack: buf }, "attack")).toEqual([
      [1000, 10],
      [2000, 20],
    ]);
  });
});

describe("ingestFrame", () => {
  it("appends a live frame to all five series", () => {
    const s = seedSeries([{ timestamp: 1, metrics: { normal_rps: 1 } }]);
    ingestFrame(
      {
        ts: 2, normal_rps: 5, attack_rps: 100, blocked_rps: 7,
        connections_per_sec: 12, cpu_load_pct: 55,
      },
      s,
    );
    expect(s.normal.toArray().map((p) => p.value)).toEqual([1, 5]);
    expect(s.attack.toArray().map((p) => p.value)).toEqual([0, 100]);
    expect(s.blocked.toArray().map((p) => p.value)).toEqual([0, 7]);
    expect(s.conns.toArray().map((p) => p.value)).toEqual([0, 12]);
    expect(s.cpu.toArray().map((p) => p.value)).toEqual([0, 55]);
  });
});

describe("floorCountdown", () => {
  it("keeps a ticking countdown whole and floors at zero", () => {
    expect(floorCountdown(8.4)).toBe(9); // ceil toward expiry
    expect(floorCountdown(2.3)).toBe(3);
    expect(floorCountdown(0.4)).toBe(1);
    expect(floorCountdown(0)).toBe(0);
  });

  it("treats null as permanent (no countdown)", () => {
    expect(floorCountdown(null)).toBeNull();
    expect(floorCountdown(undefined)).toBeNull();
  });
});