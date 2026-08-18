// particles.test.js — geometry that drives the t12 WebGL particle engine.
// Pure math, no Pixi: covered fully under jsdom so the renderer stays thin.
import { describe, it, expect } from "vitest";
import {
  SHIELD_R,
  shieldHitFraction,
  shieldHitPoint,
  projectPacket,
  projectPacketEased,
  arcControlPoint,
  quadBezier,
  projectArcEased,
  easeFlight,
  easeVel,
  streakLength,
  resolveBotIndex,
  buildVectorLinks,
  shatterBurst,
  mulberry32,
  pickFrame,
  continuousProgress,
} from "./particles.js";

const bot = { x: 0, y: 0 };
const target = { x: 100, y: 0 };

describe("shieldHitFraction", () => {
  it("returns 1 - r/d on-axis", () => {
    expect(shieldHitFraction(bot, target, 40)).toBeCloseTo(0.6, 5);
  });

  it("is rotation-invariant (off-axis segment)", () => {
    const t = { x: 60, y: 80 }; // d = 100
    expect(shieldHitFraction(bot, t, 40)).toBeCloseTo(0.6, 5);
  });

  it("clamps to 0 when the bot is already inside the shield", () => {
    const t = { x: 20, y: 0 }; // d = 20 < r
    expect(shieldHitFraction(bot, t, 40)).toBe(0);
  });

  it("uses SHIELD_R by default", () => {
    expect(shieldHitFraction(bot, target)).toBeCloseTo(1 - SHIELD_R / 100, 5);
  });
});

describe("projectPacket", () => {
  it("places ALLOWED packets along bot->target at progress", () => {
    const p = projectPacket({ progress: 0.5, status: "ALLOWED" }, bot, target);
    expect(p.x).toBeCloseTo(50, 5);
    expect(p.y).toBe(0);
  });

  it("clamps DROPPED packets to the shield hit point", () => {
    const p = projectPacket({ progress: 1, status: "DROPPED" }, bot, target);
    expect(p.x).toBeCloseTo(60, 5);
    expect(p.y).toBe(0);
  });

  it("leaves DROPPED packets short of the shield untouched", () => {
    const p = projectPacket({ progress: 0.3, status: "DROPPED" }, bot, target);
    expect(p.x).toBeCloseTo(30, 5);
  });

  it("shieldHitPoint matches the DROPPED clamp", () => {
    const hit = shieldHitPoint(bot, target);
    const p = projectPacket({ progress: 1, status: "DROPPED" }, bot, target);
    expect(hit.x).toBeCloseTo(p.x, 5);
    expect(hit.y).toBeCloseTo(p.y, 5);
  });
});

describe("buildVectorLinks", () => {
  it("emits host->bot and bot->target for every bot, no NaN", () => {
    const bots = [
      { x: 10, y: 20 },
      { x: -5, y: 7 },
      { x: 30, y: -12 },
    ];
    const host = { x: 0, y: 0 };
    const tgt = { x: 80, y: 0 };
    const links = buildVectorLinks(bots, host, tgt);
    expect(links).toHaveLength(6);
    for (const l of links) {
      for (const v of [l.x1, l.y1, l.x2, l.y2]) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("returns [] for no bots", () => {
    expect(buildVectorLinks([], { x: 0, y: 0 }, { x: 1, y: 0 })).toEqual([]);
  });
});

describe("shatterBurst / mulberry32", () => {
  it("is deterministic for the same seed", () => {
    expect(shatterBurst(10, 20, 42)).toEqual(shatterBurst(10, 20, 42));
  });

  it("differs across seeds", () => {
    expect(shatterBurst(10, 20, 1)).not.toEqual(shatterBurst(10, 20, 2));
  });

  it("emits the requested count with sane velocities and lifetimes", () => {
    const frags = shatterBurst(0, 0, 7, 8);
    expect(frags).toHaveLength(8);
    for (const f of frags) {
      expect(Math.abs(f.dx)).toBeLessThan(2.1);
      expect(Math.abs(f.dy)).toBeLessThan(2.1);
      expect(f.life).toBeGreaterThan(0.4);
      expect(f.life).toBeLessThan(1);
    }
  });

  it("mulberry32 stays in [0, 1)", () => {
    const rnd = mulberry32(5);
    for (let i = 0; i < 100; i++) {
      const v = rnd();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("pickFrame", () => {
  const frames = [0, 1, 2, 3, 4].map((s) => ({ stepIndex: s }));

  it("returns null for an empty buffer", () => {
    expect(pickFrame([], 3)).toBeNull();
  });

  it("clamps to the oldest frame when the playhead is behind", () => {
    expect(pickFrame(frames, 0).stepIndex).toBe(0);
  });

  it("clamps to the newest frame when the playhead is ahead", () => {
    expect(pickFrame(frames, 99).stepIndex).toBe(4);
  });

  it("picks the frame at floor(playhead) mid-window", () => {
    expect(pickFrame(frames, 2.4).stepIndex).toBe(2);
    expect(pickFrame(frames, 3.9).stepIndex).toBe(3);
  });

  it("handles a wrapped ring window (not starting at 0)", () => {
    const wrapped = [10, 11, 12, 13].map((s) => ({ stepIndex: s }));
    expect(pickFrame(wrapped, 11.5).stepIndex).toBe(11);
    expect(pickFrame(wrapped, 12.9).stepIndex).toBe(12);
  });
});

describe("continuousProgress", () => {
  it("equals packet.progress at the integer step", () => {
    expect(continuousProgress({ progress: 0.25 }, 10, 4)).toBeCloseTo(0.25, 5);
  });

  it("advances with the fractional playhead", () => {
    expect(continuousProgress({ progress: 0.25 }, 10.5, 4)).toBeCloseTo(0.375, 5);
  });

  it("clamps to [0, 1]", () => {
    expect(continuousProgress({ progress: 0.9 }, 10.8, 4)).toBe(1);
    expect(continuousProgress({ progress: -0.1 }, 10, 4)).toBe(0);
  });
});

describe("resolveBotIndex", () => {
  it("maps in-range VIPs 1:1", () => {
    expect(resolveBotIndex(1, 4)).toBe(0);
    expect(resolveBotIndex(4, 4)).toBe(3);
  });

  it("wraps out-of-range VIPs deterministically", () => {
    expect(resolveBotIndex(5, 4)).toBe(0);
    expect(resolveBotIndex(234, 8)).toBe(1);
  });

  it("returns -1 when there are no bots", () => {
    expect(resolveBotIndex(3, 0)).toBe(-1);
  });
});

describe("easeFlight / easeVel / streakLength", () => {
  it("easeFlight smoothsteps between 0 and 1", () => {
    expect(easeFlight(0)).toBe(0);
    expect(easeFlight(1)).toBe(1);
    expect(easeFlight(0.5)).toBeCloseTo(0.5, 5);
  });

  it("easeVel peaks mid-flight (fastest at the midpoint)", () => {
    expect(easeVel(0)).toBe(0);
    expect(easeVel(1)).toBe(0);
    expect(easeVel(0.5)).toBeCloseTo(1.5, 5);
  });

  it("streakLength scales with eased velocity and stays bounded", () => {
    expect(streakLength(0)).toBe(2);
    expect(streakLength(1)).toBe(2);
    expect(streakLength(0.5)).toBe(18); // 18*1.5 = 27 -> clamped to maxLen
  });
});

describe("projectPacketEased", () => {
  it("eases ALLOWED progress instead of using it linearly", () => {
    const p = projectPacketEased({ progress: 0.5, status: "ALLOWED" }, bot, target, 40);
    expect(p.x).toBeCloseTo(100 * easeFlight(0.5), 1);
  });

  it("still clamps DROPPED packets to the shield boundary", () => {
    const d = projectPacketEased({ progress: 1, status: "DROPPED" }, bot, target, 40);
    expect(d.x).toBeCloseTo(60, 5);
  });
});

describe("arc flights", () => {
  const a = { x: 400, y: 0 };
  const t = { x: 400, y: 300 };
  const c = arcControlPoint(a, t, t);

  it("sweeps perpendicular with consistent handedness", () => {
    const mid = quadBezier(a, c, t, 0.5);
    expect(mid.x).toBeLessThan(400); // bows left for a top-to-bottom chord
    expect(mid.y).toBeCloseTo(150, 5); // still on the chord's axis
  });

  it("quadBezier hits both endpoints", () => {
    expect(quadBezier(a, c, t, 0).x).toBeCloseTo(400, 5);
    expect(quadBezier(a, c, t, 0).y).toBeCloseTo(0, 5);
    expect(quadBezier(a, c, t, 1).x).toBeCloseTo(400, 5);
    expect(quadBezier(a, c, t, 1).y).toBeCloseTo(300, 5);
  });

  it("caps the control lift so arcs never fly too wide", () => {
    const far = arcControlPoint({ x: 0, y: 0 }, { x: 2000, y: 0 }, t);
    expect(Math.abs(far.x - 1000)).toBeLessThanOrEqual(80);
  });

  it("projectArcEased eases the midpoint to the bezier midpoint", () => {
    const p = projectArcEased({ progress: 0.5, status: "ALLOWED" }, a, t, c, 40);
    const mid = quadBezier(a, c, t, easeFlight(0.5));
    expect(p.x).toBeCloseTo(mid.x, 1);
    expect(p.y).toBeCloseTo(mid.y, 1);
  });

  it("clamps DROPPED packets to the shield ring", () => {
    const p = projectArcEased({ progress: 1, status: "DROPPED" }, a, t, c, 40);
    expect(Math.hypot(p.x - t.x, p.y - t.y)).toBeCloseTo(40, 3);
    expect(p.status).toBe("DROPPED");
  });

  it("lets ALLOWED packets reach the target", () => {
    const p = projectArcEased({ progress: 1, status: "ALLOWED" }, a, t, c, 40);
    expect(p.x).toBeCloseTo(t.x, 5);
    expect(p.y).toBeCloseTo(t.y, 5);
  });
});