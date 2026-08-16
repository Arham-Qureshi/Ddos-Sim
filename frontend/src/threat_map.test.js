// pure tween-builder tests — no DOM, no real GSAP needed
import { describe, it, expect, vi } from "vitest";
import { dormantDisplay, activeDisplay, fanOut, collapse, initThreatMap } from "./threat_map.js";
import { buildTopology } from "./topology.js";

const topo = buildTopology(4, 1000, 500);

function makeGsap() {
  return { to: vi.fn(() => ({})) };
}

describe("dormantDisplay / activeDisplay", () => {
  it("collapses bots onto the host with zero scale and opacity", () => {
    const d = dormantDisplay(topo.bots, topo.host);
    expect(d).toHaveLength(4);
    d.forEach((p) => {
      expect(p.x).toBe(topo.host.x);
      expect(p.y).toBe(topo.host.y);
      expect(p.scale).toBe(0);
      expect(p.opacity).toBe(0);
    });
  });

  it("places bots at final positions with full scale and opacity", () => {
    const d = activeDisplay(topo.bots);
    d.forEach((p, i) => {
      expect(p.x).toBe(topo.bots[i].x);
      expect(p.y).toBe(topo.bots[i].y);
      expect(p.scale).toBe(1);
      expect(p.opacity).toBe(1);
    });
  });
});

describe("fanOut / collapse tweens", () => {
  it("fanOut tweens each bot to its final position with a stagger", () => {
    const g = makeGsap();
    const d = dormantDisplay(topo.bots, topo.host);
    const tweens = fanOut(topo.bots, topo.host, d, g, undefined);
    expect(tweens).toHaveLength(4);
    expect(g.to).toHaveBeenCalledTimes(4);
    topo.bots.forEach((b, i) => {
      expect(g.to).toHaveBeenCalledWith(d[i], expect.objectContaining({
        x: b.x, y: b.y, scale: 1, opacity: 1,
        delay: i * 0.03, ease: "back.out(1.4)",
      }));
    });
  });

  it("collapse tweens bots back onto the host", () => {
    const g = makeGsap();
    const d = activeDisplay(topo.bots);
    collapse(topo.bots, topo.host, d, g, undefined);
    topo.bots.forEach((_, i) => {
      expect(g.to).toHaveBeenCalledWith(d[i], expect.objectContaining({
        x: topo.host.x, y: topo.host.y, scale: 0, opacity: 0,
        delay: i * 0.02,
      }));
    });
  });
});

function makeCtx() {
  return {
    setTransform: vi.fn(), clearRect: vi.fn(), beginPath: vi.fn(),
    arc: vi.fn(), fill: vi.fn(), fillText: vi.fn(),
    globalAlpha: 1, fillStyle: "", font: "", textAlign: "",
  };
}
function makeCanvas(ctx = makeCtx()) {
  return {
    width: 1000, height: 500, clientWidth: 1000, clientHeight: 500,
    getContext: () => ctx,
  };
}

describe("initThreatMap", () => {
  it("returns a no-op map without a canvas or when 2d context is missing", () => {
    for (const canvas of [undefined, null, { getContext: () => null }]) {
      const map = initThreatMap({ canvas });
      expect(() => map.setBotCount(8)).not.toThrow();
      expect(() => map.setAttackActive(true)).not.toThrow();
      expect(() => map.resize()).not.toThrow();
    }
  });

  it("setAttackActive(true) fans out via the injected gsap with a stagger", () => {
    const g = { to: vi.fn(() => ({})) };
    const map = initThreatMap({ canvas: makeCanvas(), gsap: g });
    map.setBotCount(4);
    map.setAttackActive(true);
    expect(g.to).toHaveBeenCalledTimes(4);
    expect(g.to.mock.calls[0][1].delay).toBe(0);
    expect(g.to.mock.calls[3][1].delay).toBeCloseTo(0.09, 5);
  });

  it("setAttackActive(false) collapses via the injected gsap", () => {
    const g = { to: vi.fn(() => ({})) };
    const map = initThreatMap({ canvas: makeCanvas(), gsap: g });
    map.setBotCount(4);
    map.setAttackActive(true);
    g.to.mockClear();
    map.setAttackActive(false);
    expect(g.to).toHaveBeenCalledTimes(4);
    expect(g.to.mock.calls[0][1].scale).toBe(0);
  });

  it("clamps the bot count to BOT_MIN..BOT_MAX", () => {
    const g = { to: vi.fn(() => ({})) };
    const map = initThreatMap({ canvas: makeCanvas(), gsap: g });
    map.setBotCount(99);
    map.setAttackActive(true);
    expect(g.to).toHaveBeenCalledTimes(32);
  });

  it("redraws immediately (no gsap) and draws host, target and bots", () => {
    const ctx = makeCtx();
    initThreatMap({ canvas: makeCanvas(ctx) }); // window.gsap is undefined in jsdom
    expect(ctx.clearRect).toHaveBeenCalled();
    expect(ctx.arc).toHaveBeenCalled();
  });

  it("resize re-measures the canvas backing store for devicePixelRatio", () => {
    const ctx = makeCtx();
    const canvas = makeCanvas(ctx);
    const map = initThreatMap({ canvas });
    map.resize();
    expect(ctx.setTransform).toHaveBeenCalled();
  });
});