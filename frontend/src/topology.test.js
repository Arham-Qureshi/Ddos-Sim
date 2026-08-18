// pure-geometry tests for topology.js — no DOM, no GSAP stubs needed
import { describe, it, expect } from "vitest";
import { BOT_MIN, BOT_MAX, clamp, normalizeBotCount, buildTopology } from "./topology.js";

describe("clamp", () => {
  it("passes through in-range values", () => {
    expect(clamp(5, 1, 32)).toBe(5);
  });

  it("floors below the lower bound", () => {
    expect(clamp(0, 1, 32)).toBe(1);
  });

  it("caps above the upper bound", () => {
    expect(clamp(99, 1, 32)).toBe(32);
  });
});

describe("normalizeBotCount", () => {
  it("rounds to a whole number", () => {
    expect(normalizeBotCount(4.6)).toBe(5);
  });

  it("clamps to the configured bot range", () => {
    expect(normalizeBotCount(0)).toBe(BOT_MIN);
    expect(normalizeBotCount(50)).toBe(BOT_MAX);
  });
});

describe("buildTopology", () => {
  const size = { width: 800, height: 400 };
  const topo = buildTopology(3, size.width, size.height);

  it("centers the target and anchors the host bottom-left", () => {
    expect(topo.target).toMatchObject({ x: 400, y: 200 });
    expect(topo.host).toMatchObject({ x: 96, y: 340 });
  });

  it("keeps the orbit ring radius inside the canvas", () => {
    expect(topo.radius).toBe(Math.min(0.34 * 800, 0.34 * 400));
    expect(topo.radius).toBe(136);
  });

  it("scales the shield radius with the canvas", () => {
    expect(topo.shieldRadius).toBe(Math.max(Math.min(800, 400) * 0.12, 28));
    expect(topo.shieldRadius).toBe(48);
  });

  it("produces one bot per requested node", () => {
    expect(topo.bots).toHaveLength(3);
  });

  it("keeps every bot inside the canvas bounds", () => {
    for (const bot of topo.bots) {
      expect(bot.x).toBeGreaterThanOrEqual(0);
      expect(bot.x).toBeLessThanOrEqual(size.width);
      expect(bot.y).toBeGreaterThanOrEqual(0);
      expect(bot.y).toBeLessThanOrEqual(size.height);
    }
  });

  it("normalizes a stray count into the valid range", () => {
    expect(buildTopology(99, size.width, size.height).bots).toHaveLength(BOT_MAX);
  });

  it("distributes bots evenly around the target", () => {
    const angles = topo.bots
      .map((bot) => Math.atan2(bot.y - topo.target.y, bot.x - topo.target.x))
      .sort((a, b) => a - b);
    for (let i = 1; i < angles.length; i++) {
      const gap = angles[i] - angles[i - 1];
      expect(gap).toBeCloseTo((2 * Math.PI) / 3, 3);
    }
  });

  it("places bot 1 at the top of the ring", () => {
    const b = topo.bots[0];
    expect(b.y).toBeLessThan(topo.target.y);
    expect(Math.abs(b.x - topo.target.x)).toBeLessThan(1e-6);
    expect(b.x).toBeCloseTo(400, 5);
    expect(b.y).toBeCloseTo(200 - 136, 5);
  });
});