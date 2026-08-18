// threat_renderer.test.js — Pixi driver + Canvas 2D fallback for the threat map.
// jsdom has no WebGL, so the fallback path is always exercised for real; the
// Pixi stage is covered with an injected stub PIXI. Expected canvas positions
// are computed from the pure geometry modules, never hardcoded.
import { describe, it, expect, vi } from "vitest";
import { initThreatRenderer, PARTICLE_ALLOWED, PARTICLE_DROPPED, PARTICLE_FRAGMENT } from "./threat_renderer.js";
import { FRAME_MS } from "./timeline_buffer.js";
import { buildTopology } from "./topology.js";
import { arcControlPoint, quadBezier, projectArcEased, easeFlight, clamp } from "./particles.js";

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

// a fake PIXI with just enough surface for the renderer to construct itself
function makePixiStub({ failInit = false } = {}) {
  const instances = [];
  class Graphics {
    constructor() {
      this.clear = vi.fn(() => this);
      this.lineStyle = vi.fn(() => this);
      this.moveTo = vi.fn(() => this);
      this.lineTo = vi.fn(() => this);
      this.beginFill = vi.fn(() => this);
      this.drawCircle = vi.fn(() => this);
      this.drawRect = vi.fn(() => this);
      this.endFill = vi.fn(() => this);
      this.visible = true;
      this.alpha = 1;
      this.x = 0;
      this.y = 0;
      this.rotation = 0;
      this.blendMode = "normal";
    }
  }
  class Container {
    constructor() { this.children = []; }
    addChild(...c) { this.children.push(...c); return this; }
  }
  class Sprite {
    constructor() {
      this.x = 0; this.y = 0; this.alpha = 1; this.visible = false; this.tint = 0;
      this.rotation = 0; this.blendMode = "normal"; this.texture = null;
      this.eventMode = "none"; this.hitArea = null;
      this.anchor = { set: vi.fn() };
      this.scale = { set: vi.fn() };
      this.events = {};
      this.on = vi.fn((evt, fn) => { this.events[evt] = fn; return this; });
    }
  }
  class Text {
    constructor(text, style) {
      this.text = text; this.style = style; this.visible = false;
      this.x = 0; this.y = 0; this.alpha = 1;
      this.anchor = { set: vi.fn() };
    }
  }
  class Circle {
    constructor(x = 0, y = 0, radius = 0) { this.x = x; this.y = y; this.radius = radius; }
  }
  const ticker = { add: vi.fn(), cb: null };
  ticker.add.mockImplementation((cb) => { ticker.cb = cb; });
  const app = {
    stage: new Container(),
    renderer: { resize: vi.fn(), generateTexture: vi.fn(() => ({ tex: true })) },
    ticker,
  };
  const Application = class {
    constructor() { if (failInit) throw new Error("no webgl"); instances.push(app); return app; }
  };
  Application.instances = instances;
  return { Application, Graphics, Container, Sprite, Text, Circle, BLEND_MODES: { ADD: "add", NORMAL: "normal" }, app };
}

// orbit geometry for the 1000x500 test canvas at 4 bots
const topo = buildTopology(4, 1000, 500);
const bot1 = topo.bots[0]; // angle -PI/2 -> (500, 80)
const ctrl = arcControlPoint(bot1, topo.target, topo.target);
const expArc = (prog, status) =>
  projectArcEased({ progress: prog, status }, bot1, topo.target, ctrl, topo.shieldRadius);

describe("initThreatRenderer fallback (jsdom)", () => {
  it("returns the canvas 2d facade when PIXI is unavailable", () => {
    const map = initThreatRenderer({ canvas: makeCanvas() });
    expect(map.isPixi).toBe(false);
    for (const call of [
      () => map.setBotCount(8),
      () => map.setAttackActive(true),
      () => map.resize(),
      () => map.setMitigation(true),
      () => map.setBlockedRate(4),
      () => map.setVisible(false),
      () => map.highlightBot(2),
      () => map.onBotHover(() => {}),
      () => map.setConnected(false),
      () => map.renderFrame(null, 0),
    ]) expect(call).not.toThrow();
  });

  it("returns the canvas 2d facade when the pixi app fails to init", () => {
    const P = makePixiStub({ failInit: true });
    const map = initThreatRenderer({ canvas: makeCanvas(), pixi: P });
    expect(map.isPixi).toBe(false);
  });

  it("is a safe no-op facade without a canvas", () => {
    const map = initThreatRenderer({ canvas: null });
    expect(map.isPixi).toBe(false);
    expect(() => map.setBotCount(4)).not.toThrow();
    expect(() => map.setAttackActive(true)).not.toThrow();
  });
});

describe("initThreatRenderer pixi stage", () => {
  it("builds a pixi app and exposes the full facade", () => {
    const P = makePixiStub();
    const map = initThreatRenderer({ canvas: makeCanvas(), pixi: P });
    expect(map.isPixi).toBe(true);
    expect(P.app.stage.children.length).toBe(5); // bg / links / nodes / fx / hud layers
    for (const call of [
      () => map.setBotCount(4),
      () => map.setAttackActive(true),
      () => map.setMitigation(false),
      () => map.setBlockedRate(10),
      () => map.setVisible(true),
      () => map.highlightBot(1),
      () => map.onBotHover(() => {}),
      () => map.setConnected(true),
      () => map.resize(),
    ]) expect(call).not.toThrow();
    expect(P.app.renderer.resize).toHaveBeenCalled();
  });

  it("grows a bot sprite per bot and hides the extras when N shrinks", () => {
    const P = makePixiStub();
    const map = initThreatRenderer({ canvas: makeCanvas(), pixi: P });
    const nodesLayer = P.app.stage.children[2];
    const botSprites = nodesLayer.children.filter((c) => c.constructor.name === "Sprite");
    expect(botSprites).toHaveLength(10); // boot pool: host + target + 8 bots
    expect(botSprites.filter((s) => s.visible)).toHaveLength(10); // all visible at 8 bots
    map.setBotCount(4);
    expect(botSprites.filter((s) => s.visible)).toHaveLength(6); // 2 nodes + 4 bots
    map.setBotCount(12);
    expect(nodesLayer.children.filter((c) => c.constructor.name === "Sprite")).toHaveLength(14);
    expect(nodesLayer.children.filter((c) => c.constructor.name === "Sprite" && c.visible)).toHaveLength(14);
  });

  it("hides the shield when mitigation is off", () => {
    const P = makePixiStub();
    const map = initThreatRenderer({ canvas: makeCanvas(), pixi: P });
    const nodesLayer = P.app.stage.children[2];
    const shield = nodesLayer.children.find((c) => c.constructor.name === "Graphics");
    expect(shield.visible).toBe(true); // mitigation on by default
    map.setMitigation(false);
    expect(shield.visible).toBe(false);
  });

  it("places an ALLOWED packet head along its arc and colors it cyan", () => {
    const P = makePixiStub();
    const map = initThreatRenderer({ canvas: makeCanvas(), pixi: P });
    map.setBotCount(4);
    const frame = { activePackets: [{ srcIp: "10.0.0.1", botId: 1, progress: 0.5, status: "ALLOWED" }] };
    map.renderFrame(frame, 0);
    const fx = P.app.stage.children[3].children;
    const head = fx.find((s) => s.visible && s.alpha === 1 && s.blendMode === "add");
    const e = expArc(0.5, "ALLOWED");
    expect(head).toBeTruthy();
    expect(head.x).toBeCloseTo(e.x, 1);
    expect(head.y).toBeCloseTo(e.y, 1);
    expect(head.tint).toBe(PARTICLE_ALLOWED);
  });

  it("renders a fading trail behind a flying packet", () => {
    const P = makePixiStub();
    const map = initThreatRenderer({ canvas: makeCanvas(), pixi: P });
    map.setBotCount(4);
    const frame = { activePackets: [{ srcIp: "10.0.0.1", botId: 1, progress: 0.5, status: "ALLOWED" }] };
    map.renderFrame(frame, 0);
    const fx = P.app.stage.children[3].children;
    const glowing = fx.filter((s) => s.visible && s.blendMode === "add");
    expect(glowing.length).toBeGreaterThan(1); // head + trail dots
    const head = glowing.find((s) => s.alpha === 1);
    for (const dot of glowing.filter((s) => s !== head)) {
      expect(dot.alpha).toBeLessThan(1); // trails fade behind the head
    }
  });

  it("clamps a DROPPED packet to the shield, colors it red and bursts", () => {
    const P = makePixiStub();
    const map = initThreatRenderer({ canvas: makeCanvas(), pixi: P });
    map.setBotCount(4);
    const frame = { activePackets: [{ srcIp: "10.0.0.1", botId: 1, progress: 1, status: "DROPPED" }] };
    map.renderFrame(frame, 0);
    const fx = P.app.stage.children[3].children;
    const head = fx.find((s) => s.visible && s.alpha === 1 && s.tint === PARTICLE_DROPPED);
    expect(head).toBeTruthy();
    expect(Math.hypot(head.x - topo.target.x, head.y - topo.target.y)).toBeCloseTo(topo.shieldRadius, 0);
    const fragments = fx.filter((s) => s.visible && s.tint === PARTICLE_FRAGMENT);
    expect(fragments.length).toBeGreaterThanOrEqual(6);
  });

  it("re-hides packets that leave the frame", () => {
    const P = makePixiStub();
    const map = initThreatRenderer({ canvas: makeCanvas(), pixi: P });
    map.setBotCount(4);
    const frame = { activePackets: [{ srcIp: "10.0.0.1", botId: 1, progress: 0.5, status: "ALLOWED" }] };
    map.renderFrame(frame, 0);
    map.renderFrame({ activePackets: [] }, 0.5);
    const fx = P.app.stage.children[3].children;
    expect(fx.filter((s) => s.visible && s.blendMode === "add")).toHaveLength(0);
  });

  it("scales the shield HUD with the blocked rate", () => {
    const P = makePixiStub();
    const map = initThreatRenderer({ canvas: makeCanvas(), pixi: P });
    map.setBlockedRate(6);
    map.renderFrame({ activePackets: [] }, 0);
    const hudLayer = P.app.stage.children[4];
    const shield = hudLayer.children.find((t) => t.text.startsWith("SHIELD"));
    expect(shield.text).toBe("SHIELD ON · 6 rps");
    map.setMitigation(false);
    expect(shield.text).toBe("SHIELD OFF");
  });

  it("holds the playhead when paused and still renders the frame", () => {
    const P = makePixiStub();
    let now = 0;
    const frames = Array.from({ length: 6 }, (_, i) => ({
      stepIndex: i,
      activePackets: [{ srcIp: "10.0.0.1", botId: 1, progress: i / 6, status: "ALLOWED" }],
    }));
    const timeline = { frames: () => frames, liveStepIndex: () => 5 };
    const map = initThreatRenderer({ canvas: makeCanvas(), pixi: P, timeline, clock: () => now });
    map.setBotCount(4);
    map.setPlayhead(3);
    map.setPlayback({ playing: false });
    for (let i = 0; i < 10; i++) { now += FRAME_MS; P.app.ticker.cb(); }
    expect(map.getPlayhead()).toBe(3); // paused: never advances
    const fx = P.app.stage.children[3].children;
    expect(fx.some((s) => s.visible && s.alpha === 1 && s.blendMode === "add")).toBe(true);
  });

  it("advances the playhead at the chosen speed", () => {
    const P = makePixiStub();
    let now = 0;
    const frames = Array.from({ length: 20 }, (_, i) => ({
      stepIndex: i,
      activePackets: [{ srcIp: "10.0.0.1", botId: 1, progress: i / 20, status: "ALLOWED" }],
    }));
    const timeline = { frames: () => frames, liveStepIndex: () => 19 };
    const map = initThreatRenderer({ canvas: makeCanvas(), pixi: P, timeline, clock: () => now });
    map.setBotCount(4);
    map.setPlayhead(0);
    map.setPlayback({ playing: true, speed: 2 });
    for (let i = 0; i < 5; i++) { now += FRAME_MS; P.app.ticker.cb(); }
    expect(map.getPlayhead()).toBeCloseTo(10, 5); // 5 ticks at 2x -> +10 frames
  });

  it("clamps setPlayhead to the live edge", () => {
    const P = makePixiStub();
    const timeline = { frames: () => [{ stepIndex: 0, activePackets: [] }], liveStepIndex: () => 7 };
    const map = initThreatRenderer({ canvas: makeCanvas(), pixi: P, timeline });
    map.setPlayhead(99);
    expect(map.getPlayhead()).toBe(7);
    map.setPlayhead(-3);
    expect(map.getPlayhead()).toBe(0);
  });

  it("onBotClick fires with the bot index", () => {
    const P = makePixiStub();
    const map = initThreatRenderer({ canvas: makeCanvas(), pixi: P });
    map.setBotCount(4);
    const cb = vi.fn();
    map.onBotClick(cb);
    const nodesLayer = P.app.stage.children[2];
    const bot = nodesLayer.children.find((s) => s.constructor.name === "Sprite" && s.tint === 0xf59e0b);
    bot.events.pointerdown();
    expect(cb).toHaveBeenCalledWith(0);
  });
});

describe("threat map mission-control (arcs, sweep, ambient, tooltips)", () => {
  it("clamps the playhead to the live edge so playback never snaps back", () => {
    const P = makePixiStub();
    let now = 0;
    const frames = Array.from({ length: 10 }, (_, i) => ({
      stepIndex: i,
      activePackets: [{ srcIp: "10.0.0.1", botId: 1, progress: i / 10, status: "ALLOWED" }],
    }));
    let live = 9;
    const timeline = { frames: () => frames, liveStepIndex: () => live };
    const map = initThreatRenderer({ canvas: makeCanvas(), pixi: P, timeline, clock: () => now });
    map.setBotCount(4);
    for (let i = 0; i < 60; i++) { now += FRAME_MS; P.app.ticker.cb(); }
    live = 5;
    for (let i = 0; i < 20; i++) { now += FRAME_MS; P.app.ticker.cb(); }
    const fx = P.app.stage.children[3].children;
    const head = fx.find((s) => s.visible && s.alpha === 1 && s.blendMode === "add");
    const e = expArc(0.5, "ALLOWED"); // playhead pinned at step 5 -> progress 0.5
    expect(head.x).toBeCloseTo(e.x, 1);
    expect(Number.isFinite(head.x)).toBe(true);
  });

  it("recolors the ambient toward the threat color under load", () => {
    const P = makePixiStub();
    const map = initThreatRenderer({ canvas: makeCanvas(), pixi: P, rateLimitMaxRps: 2 });
    map.setBotCount(4);
    const bgLayer = P.app.stage.children[0];
    const ambient = bgLayer.children.find((c) => c.constructor.name === "Graphics" && c !== bgLayer.children[0]);
    map.setBlockedRate(40);
    map.renderFrame({ activePackets: [] }, 0);
    const lastFill = ambient.beginFill.mock.calls.at(-1);
    expect(lastFill[0]).toBe(0xfb7185); // severe -> rose
    expect(lastFill[1]).toBeLessThanOrEqual(0.05); // barely-there tint
  });

  it("hides the radar sweep when disconnected and under reduced motion", () => {
    const P = makePixiStub();
    const map = initThreatRenderer({ canvas: makeCanvas(), pixi: P });
    const bgLayer = P.app.stage.children[0];
    const sweep = bgLayer.children.at(-1);
    expect(sweep.visible).toBe(true); // connected by default
    map.setConnected(false);
    expect(sweep.visible).toBe(false);
  });

  it("fans bots out instantly under reduced motion and skips trails", () => {
    const P = makePixiStub();
    const gsap = { to: vi.fn() };
    const map = initThreatRenderer({ canvas: makeCanvas(), pixi: P, gsap, reduceMotion: true });
    map.setBotCount(4);
    map.setAttackActive(true);
    expect(gsap.to).not.toHaveBeenCalled();
    const nodesLayer = P.app.stage.children[2];
    const bot = nodesLayer.children.find((s) => s.constructor.name === "Sprite" && s.tint === 0xf59e0b);
    expect(bot.x).not.toBe(120); // fanned out of the dormant host corner
    const bgLayer = P.app.stage.children[0];
    expect(bgLayer.children.at(-1).visible).toBe(false); // no sweep under reduceMotion
    const frame = { activePackets: [{ srcIp: "10.0.0.1", botId: 1, progress: 0.5, status: "ALLOWED" }] };
    map.renderFrame(frame, 0);
    const fx = P.app.stage.children[3].children;
    const visible = fx.filter((s) => s.visible);
    expect(visible).toHaveLength(1); // head only, no trails
    expect(visible[0].blendMode).toBe("normal");
  });

  it("highlightBot bumps the highlighted bot sprite", () => {
    const P = makePixiStub();
    const map = initThreatRenderer({ canvas: makeCanvas(), pixi: P });
    map.setBotCount(4);
    map.setAttackActive(true); // instant, no gsap -> bots at full scale
    const nodesLayer = P.app.stage.children[2];
    const bots = nodesLayer.children.filter((s) => s.constructor.name === "Sprite" && s.tint === 0xf59e0b);
    map.highlightBot(2);
    const scaleOf = (s) => s.scale.set.mock.calls.at(-1)[0];
    expect(scaleOf(bots[2])).toBeGreaterThan(scaleOf(bots[0]));
    map.highlightBot(null);
    expect(scaleOf(bots[2])).toBeCloseTo(scaleOf(bots[0]), 5);
  });

  it("onBotHover fires on bot pointer events", () => {
    const P = makePixiStub();
    const map = initThreatRenderer({ canvas: makeCanvas(), pixi: P });
    map.setBotCount(4);
    const cb = vi.fn();
    map.onBotHover(cb);
    const nodesLayer = P.app.stage.children[2];
    const bot = nodesLayer.children.find((s) => s.constructor.name === "Sprite" && s.tint === 0xf59e0b);
    expect(bot.eventMode).toBe("static");
    bot.events.pointerover();
    expect(cb).toHaveBeenCalledWith(0, true);
    bot.events.pointerout();
    expect(cb).toHaveBeenCalledWith(0, false);
  });

  it("shows a bot tooltip on pointerover and hides on pointerout", () => {
    const P = makePixiStub();
    const map = initThreatRenderer({ canvas: makeCanvas(), pixi: P });
    map.setBotCount(4);
    const nodesLayer = P.app.stage.children[2];
    const bot = nodesLayer.children.find((s) => s.constructor.name === "Sprite" && s.tint === 0xf59e0b);
    bot.events.pointerover();
    const hudLayer = P.app.stage.children[4];
    const tooltip = hudLayer.children.find((t) => t.style && t.style.tooltip);
    expect(tooltip.visible).toBe(true);
    expect(tooltip.text).toMatch(/10\.0\.0\.\d/);
    bot.events.pointerout();
    expect(tooltip.visible).toBe(false);
  });
});