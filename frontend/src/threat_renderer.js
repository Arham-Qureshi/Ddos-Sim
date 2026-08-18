// threat_renderer.js — PixiJS WebGL driver for the threat map (t14/mission-control).
// Five layers on one PIXI.Application: backdrop (vignette + ambient tint + radar
// sweep), vector links, nodes (host / bots on an orbit ring / shield), particle
// FX (arc flights with fading trails, muzzle flash, shield bursts, ripples), and
// a HUD (shield state + bot tooltips — counters moved to the HTML strip).
//
// Playback runs on a live-edge playhead (never races ahead of the WS stream, so
// it can't snap back). Packets fly as eased quadratic arcs; DROPPED ones get
// clamped to the shield ring and burst. A reduced-motion flag drops every effect
// while keeping the data. On any failure it degrades to the t10 Canvas 2D renderer.
// Geometry lives in topology.js / particles.js / threat_stats.js / threat_level.js.

import { buildTopology, clamp, BOT_MIN, BOT_MAX } from "./topology.js";
import { dormantDisplay, activeDisplay, fanOut, collapse, initThreatMap } from "./threat_map.js";
import { threatLevel } from "./threat_level.js";
import {
  projectPacket,
  resolveBotIndex,
  shieldHitFraction,
  shieldHitPoint,
  buildVectorLinks,
  shatterBurst,
  pickFrame,
  continuousProgress,
  arcControlPoint,
  projectArcEased,
} from "./particles.js";
import { emptyStats, statsFromFrames } from "./threat_stats.js";
import { FRAME_MS, FLIGHT_FRAMES } from "./timeline_buffer.js";

export const PARTICLE_POOL = 256;
export const TRAIL_POOL = 768;
export const FRAGMENT_POOL = 256;

export const PARTICLE_ALLOWED = 0x38bdf8; // cyan
export const PARTICLE_DROPPED = 0xfb7185; // rose
export const PARTICLE_FRAGMENT = 0x94a3b8; // slate
export const SHIELD_COLOR = 0x34d399; // emerald
export const LINK_COLOR = 0x64748b; // slate
export const HOST_TINT = 0x64748b;
export const TARGET_TINT = 0x38bdf8;
export const BOT_TINT = 0xf59e0b;

const DOT_R = 1.6; // particle dot radius (px)
const DOT_SCALE = DOT_R / 4; // dotTex is a 4px-radius circle
const TRAIL_COUNT = 4; // dots fading out behind each flying packet
const TRAIL_SPACING = 0.05; // trail dots trail behind by fixed progress steps
const HUD_WINDOW = 60; // frames folded into the tooltip stats
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

function makeSprite(P, texture, tint, radius) {
  const s = new P.Sprite(texture);
  s.anchor.set(0.5);
  s.tint = tint;
  s.scale.set(radius / 4); // texture dot has radius 4px
  s.visible = false;
  return s;
}

// tiny string hash so burst keys become stable RNG seeds
function hashKey(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

// degraded mode: the t10 canvas 2d renderer, no particles/links/shield
function canvasFallback(canvas, gsap) {
  const fallback = initThreatMap({ canvas, gsap });
  return Object.assign(fallback, {
    isPixi: false,
    setMitigation() {},
    setBlockedRate() {},
    setVisible() {},
    renderFrame() {},
    highlightBot() {},
    onBotHover() {},
    setConnected() {},
  });
}

function pixiFacade(app, canvas, timeline, gsap, P, opts) {
  const stage = app.stage;
  const reduceMotion = !!opts.reduceMotion;
  const rateLimitMaxRps = opts.rateLimitMaxRps || 2;
  const clock = opts.clock || (() => performance.now());

  const dotTex = (() => {
    const g = new P.Graphics();
    g.beginFill(0xffffff);
    g.drawCircle(0, 0, 4);
    g.endFill();
    return app.renderer.generateTexture(g);
  })();

  // bottom -> top: backdrop, links, nodes (+shield), particles, HUD
  const bgLayer = new P.Container();
  const linksLayer = new P.Container();
  const nodesLayer = new P.Container();
  const fxLayer = new P.Container();
  const hudLayer = new P.Container();
  stage.addChild(bgLayer, linksLayer, nodesLayer, fxLayer, hudLayer);

  const bg = new P.Graphics();
  const ambient = new P.Graphics();
  const sweep = new P.Graphics();
  bgLayer.addChild(bg, ambient, sweep);

  const links = new P.Graphics();
  linksLayer.addChild(links);

  const hostSprite = makeSprite(P, dotTex, HOST_TINT, 7);
  const targetSprite = makeSprite(P, dotTex, TARGET_TINT, 9);
  hostSprite.visible = true;
  targetSprite.visible = true;
  nodesLayer.addChild(hostSprite, targetSprite);

  const shield = new P.Graphics();
  shield.visible = false;
  const spinRing = new P.Graphics();
  spinRing.visible = false;
  const flashRing = new P.Graphics();
  flashRing.visible = false;
  nodesLayer.addChild(shield, spinRing, flashRing);

  const botSprites = [];
  const particles = [];
  const trails = [];
  const fragments = [];
  for (let i = 0; i < PARTICLE_POOL; i++) particles.push(makeSprite(P, dotTex, PARTICLE_ALLOWED, DOT_R));
  for (let i = 0; i < TRAIL_POOL; i++) trails.push(makeSprite(P, dotTex, PARTICLE_ALLOWED, DOT_R));
  for (let i = 0; i < FRAGMENT_POOL; i++) fragments.push(makeSprite(P, dotTex, PARTICLE_FRAGMENT, 1.2));
  const ripples = [];
  for (let i = 0; i < 12; i++) {
    const r = new P.Graphics();
    r.visible = false;
    ripples.push(r);
  }
  fxLayer.addChild(...particles, ...trails, ...fragments, ...ripples);

  const hudStyle = (fill) => ({ fontFamily: MONO, fontSize: 12, fill, fontWeight: 500 });
  const hudShield = new P.Text("SHIELD OFF", hudStyle(SHIELD_COLOR));
  const tooltip = new P.Text("", { ...hudStyle(0xcbd5e1), fontSize: 10, tooltip: true });
  hudShield.anchor.set(1, 0);
  tooltip.anchor.set(0.5, 1);
  tooltip.visible = false;
  hudShield.visible = true;
  hudLayer.addChild(hudShield, tooltip);

  let count = 8;
  let attackActive = false;
  let mitigationOn = true;
  let blockedRate = 0;
  let visible = true;
  let connected = true;
  let highlight = null;
  let hoverCb = null;
  let playhead = 0;
  let lastNow = null;
  let ambientColor = null;
  let topo = buildTopology(count, 640, 360);
  let display = dormantDisplay(topo.bots, topo.host);
  const activeFragments = []; // { sprite, dx, dy, age, life, gravity }
  const activeRipples = []; // { gfx, age, life }
  const burstKeys = new Map(); // burstKey -> spawnStep, pruned as it ages out
  const arrivalKeys = new Map(); // same, but for allowed arrivals (ripples)
  const recent = []; // rolling window for tooltip stats
  let flash = null; // { age, life } single shield flash

  function updateHud() {
    hudShield.text = mitigationOn ? `SHIELD ON · ${Math.round(blockedRate)} rps` : "SHIELD OFF";
  }

  function anchorHud() {
    const w = canvas.clientWidth || 640;
    hudShield.x = w - 16;
  }

  function syncBots() {
    topo.bots.forEach((b, i) => {
      const d = display[i];
      const s = botSprites[i];
      if (!s) return;
      s.x = d.x;
      s.y = d.y;
      const boosted = i === highlight ? 1.3 : 1;
      s.scale.set(0.9 * d.scale * boosted);
      s.alpha = i === highlight ? 1 : d.opacity;
      s.visible = true;
      if (s.hitArea) {
        s.hitArea.x = d.x;
        s.hitArea.y = d.y;
      }
    });
    for (let i = topo.bots.length; i < botSprites.length; i++) botSprites[i].visible = false;
  }

  function showTooltip(i, s) {
    const stats = statsFromFrames(recent);
    const e = stats.byBot.get(i + 1) || { sent: 0, blocked: 0 };
    tooltip.text = `10.0.0.${i + 1} · ${e.sent} sent · ${e.blocked} blocked`;
    tooltip.x = clamp(s.x, 60, (canvas.clientWidth || 640) - 60);
    tooltip.y = s.y - 22;
    tooltip.visible = true;
  }

  function hideTooltip() {
    tooltip.visible = false;
  }

  function syncNodes() {
    if (!topo.host || !topo.target) return;
    hostSprite.x = topo.host.x;
    hostSprite.y = topo.host.y;
    targetSprite.x = topo.target.x;
    targetSprite.y = topo.target.y;

    while (botSprites.length < topo.bots.length) {
      const i = botSprites.length;
      const s = makeSprite(P, dotTex, BOT_TINT, 3.5);
      s.eventMode = "static";
      s.hitArea = new P.Circle(0, 0, 20);
      s.on("pointerover", () => {
        showTooltip(i, s);
        if (hoverCb) hoverCb(i, true);
      });
      s.on("pointerout", () => {
        hideTooltip();
        if (hoverCb) hoverCb(i, false);
      });
      botSprites.push(s);
      nodesLayer.addChild(s);
    }

    links.clear();
    links.lineStyle({ width: 1, color: LINK_COLOR, alpha: 0.18 });
    for (const l of buildVectorLinks(topo.bots, topo.host, topo.target)) {
      links.moveTo(l.x1, l.y1).lineTo(l.x2, l.y2);
    }

    shield.clear();
    shield.lineStyle({ width: 3, color: SHIELD_COLOR, alpha: 1 });
    shield.drawCircle(topo.target.x, topo.target.y, topo.shieldRadius);

    syncBots();
  }

  function buildBackdrop() {
    bg.clear();
    const w = canvas.clientWidth || 640;
    const h = canvas.clientHeight || 360;
    const cx = topo.target ? topo.target.x : w / 2;
    const cy = topo.target ? topo.target.y : h / 2;
    // faint radial cyan vignette pooling on the target
    const maxR = Math.max(w, h) * 0.7;
    for (let i = 40; i > 0; i--) {
      const a = 0.001 * (40 - i);
      if (a <= 0) continue;
      bg.beginFill(TARGET_TINT, a);
      bg.drawCircle(cx, cy, (maxR * i) / 40);
      bg.endFill();
    }
    // sparse dot grid, barely there
    for (let gx = 14; gx < w; gx += 28) {
      for (let gy = 14; gy < h; gy += 28) {
        bg.beginFill(LINK_COLOR, 0.05);
        bg.drawCircle(gx, gy, 1);
        bg.endFill();
      }
    }
  }

  // full-canvas threat-colored wash that shifts with the blocked rate; rebuilt
  // only when the level actually changes (cheap, so renderFrame calls it freely)
  function updateAmbient() {
    const color = threatLevel(blockedRate, rateLimitMaxRps).color;
    if (color === ambientColor) return;
    ambientColor = color;
    ambient.clear();
    ambient.beginFill(color, 0.04);
    ambient.drawRect(0, 0, canvas.clientWidth || 640, canvas.clientHeight || 360);
    ambient.endFill();
  }

  // slow radar sweep that rotates around the target; hidden when offline or
  // under reduced motion so a dead dashboard doesn't pretend to scan
  function updateSweep() {
    const on = connected && !reduceMotion;
    sweep.visible = on;
    if (!on) return;
    const a = (clock() / 1000) * ((Math.PI * 2) / 8); // one revolution per 8s
    sweep.clear();
    sweep.lineStyle({ width: 2, color: threatLevel(blockedRate, rateLimitMaxRps).color, alpha: 0.05 });
    sweep.moveTo(topo.target.x, topo.target.y);
    sweep.lineTo(topo.target.x + Math.cos(a) * (topo.shieldRadius + 60), topo.target.y + Math.sin(a) * (topo.shieldRadius + 60));
  }

  function rebuild() {
    topo = buildTopology(count, canvas.clientWidth || 640, canvas.clientHeight || 360);
    display = attackActive ? activeDisplay(topo.bots) : dormantDisplay(topo.bots, topo.host);
    syncNodes();
    buildBackdrop();
    anchorHud();
    updateAmbient();
    updateSweep();
  }

  function drawSpinRing(phase) {
    spinRing.clear();
    spinRing.lineStyle({ width: 2, color: SHIELD_COLOR, alpha: 0.7 });
    const cx = topo.target.x;
    const cy = topo.target.y;
    const R = topo.shieldRadius + 12;
    const N = 18;
    const seg = (Math.PI * 2) / N;
    for (let i = 0; i < N; i++) {
      const a0 = i * seg + phase;
      const a1 = a0 + seg * 0.35;
      spinRing.moveTo(cx + Math.cos(a0) * R, cy + Math.sin(a0) * R);
      spinRing.lineTo(cx + Math.cos(a1) * R, cy + Math.sin(a1) * R);
    }
  }

  function updateShield(dtSec = 0) {
    const on = !!(mitigationOn && topo.target);
    shield.visible = on;
    if (!on) {
      spinRing.visible = false;
      flashRing.visible = false;
      return;
    }
    const t = clock() / 1000;
    const intensity = clamp(blockedRate / 50, 0, 1);
    // pulse slows to a steady glow under reduced motion
    const pulse = reduceMotion ? 1 : 0.5 + 0.5 * Math.sin((2 * Math.PI * t) / 1.2);
    shield.alpha = 0.3 + 0.35 * pulse + 0.35 * intensity;
    spinRing.visible = !reduceMotion;
    if (spinRing.visible) drawSpinRing(t * 0.6);

    if (flash) {
      flash.age += dtSec;
      if (flash.age >= flash.life) {
        flash = null;
        flashRing.visible = false;
      } else {
        const p = flash.age / flash.life;
        flashRing.visible = true;
        flashRing.clear();
        flashRing.lineStyle({ width: 3, color: SHIELD_COLOR, alpha: (1 - p) * 0.9 });
        flashRing.drawCircle(topo.target.x, topo.target.y, topo.shieldRadius + p * 30);
      }
    }
  }

  function maybeBurst(packet, proj, bot, step) {
    if (packet.status !== "DROPPED") return;
    if (proj.progress < shieldHitFraction(bot, topo.target, topo.shieldRadius)) return;
    // spawnStep is frame-independent: p.progress and floor(step) move together
    const spawnStep = Math.floor(step) - Math.round(packet.progress * FLIGHT_FRAMES);
    const key = `${packet.srcIp}:${spawnStep}`;
    if (burstKeys.has(key)) return;
    burstKeys.set(key, spawnStep);
    for (const [k, s] of burstKeys) {
      if (s < Math.floor(step) - 12) burstKeys.delete(k);
    }
    // tiny muzzle pop right at the bot muzzle, no gravity
    for (let m = 0; m < 3; m++) {
      const sprite = fragments.pop();
      if (!sprite) break;
      sprite.visible = true;
      sprite.x = bot.x;
      sprite.y = bot.y;
      sprite.tint = PARTICLE_FRAGMENT;
      sprite.alpha = 1;
      const a = (hashKey(key + "m" + m) % 360) * (Math.PI / 180);
      const spd = 0.4 + (hashKey(key + "v" + m) % 100) / 200;
      activeFragments.push({ sprite, dx: Math.cos(a) * spd, dy: Math.sin(a) * spd, age: 0, life: 0.2 + (m % 2) * 0.15, gravity: false });
    }
    const hit = shieldHitPoint(bot, topo.target, topo.shieldRadius);
    const frags = shatterBurst(hit.x, hit.y, hashKey(key));
    for (const f of frags) {
      const sprite = fragments.pop();
      if (!sprite) break;
      sprite.visible = true;
      sprite.x = hit.x;
      sprite.y = hit.y;
      sprite.tint = PARTICLE_FRAGMENT;
      sprite.alpha = 1;
      activeFragments.push({ sprite, dx: f.dx, dy: f.dy, age: 0, life: f.life });
    }
    // one shield flash per impact (dropped under reduced motion)
    if (!reduceMotion) flash = flash || { age: 0, life: 0.35 };
  }

  function maybeRipple(packet, proj, step) {
    if (reduceMotion) return;
    if (packet.status !== "ALLOWED" || proj.progress < 0.7) return;
    const spawnStep = Math.floor(step) - Math.round(packet.progress * FLIGHT_FRAMES);
    const key = `${packet.srcIp}:${spawnStep}`;
    if (arrivalKeys.has(key)) return;
    arrivalKeys.set(key, spawnStep);
    for (const [k, s] of arrivalKeys) {
      if (s < Math.floor(step) - 12) arrivalKeys.delete(k);
    }
    const gfx = ripples.find((r) => !r.visible);
    if (!gfx) return;
    gfx.visible = true;
    gfx.x = topo.target.x;
    gfx.y = topo.target.y;
    activeRipples.push({ gfx, age: 0, life: 0.6 });
  }

  // stateless per frame: repurpose pooled sprites from the frame's packets so
  // the t13 scrubber can replay any historical frame with this same call
  function renderFrame(frame, step) {
    if (!frame) return;
    if (recent.length === HUD_WINDOW) recent.shift();
    recent.push(frame);
    const packets = frame.activePackets || [];
    let used = 0;
    let trailUsed = 0;
    for (let i = 0; i < packets.length && i < particles.length; i++) {
      const p = packets[i];
      const botIdx = resolveBotIndex(p.botId, topo.bots.length);
      const bot = botIdx >= 0 ? topo.bots[botIdx] : topo.host;
      const prog = continuousProgress(p, step, FLIGHT_FRAMES);
      const raw = { ...p, progress: prog };
      const tint = p.status === "DROPPED" ? PARTICLE_DROPPED : PARTICLE_ALLOWED;
      const head = particles[i];
      head.visible = true;
      head.tint = tint;
      head.scale.set(DOT_SCALE, DOT_SCALE);
      if (reduceMotion) {
        // data-only path: plain dots, straight projection, no FX
        const proj = projectPacket(raw, bot, topo.target, topo.shieldRadius);
        head.x = proj.x;
        head.y = proj.y;
        head.blendMode = P.BLEND_MODES.NORMAL;
      } else {
        const ctrl = arcControlPoint(bot, topo.target, topo.target);
        const proj = projectArcEased(raw, bot, topo.target, ctrl, topo.shieldRadius);
        head.x = proj.x;
        head.y = proj.y;
        head.blendMode = P.BLEND_MODES.ADD;
        // fading trail dots reusing the same clamped arc projection
        for (let k = 1; k <= TRAIL_COUNT; k++) {
          const tp = projectArcEased({ ...raw, progress: clamp(prog - k * TRAIL_SPACING, 0, 1) }, bot, topo.target, ctrl, topo.shieldRadius);
          const dot = trails[trailUsed++];
          if (!dot) break;
          dot.visible = true;
          dot.x = tp.x;
          dot.y = tp.y;
          dot.tint = tint;
          dot.blendMode = P.BLEND_MODES.ADD;
          dot.alpha = 0.5 * (1 - k / (TRAIL_COUNT + 1));
          dot.scale.set(DOT_SCALE, DOT_SCALE);
        }
        maybeBurst(p, proj, bot, step);
        maybeRipple(p, proj, step);
      }
      used++;
    }
    for (let i = used; i < particles.length; i++) particles[i].visible = false;
    for (let i = trailUsed; i < trails.length; i++) trails[i].visible = false;
    updateShield(0);
    updateHud();
    updateAmbient();
  }

  function updateFragments(dtSec) {
    if (!activeFragments.length) return;
    for (let i = activeFragments.length - 1; i >= 0; i--) {
      const f = activeFragments[i];
      f.age += dtSec;
      if (f.age >= f.life) {
        f.sprite.visible = false;
        fragments.push(f.sprite);
        activeFragments.splice(i, 1);
        continue;
      }
      f.sprite.x += f.dx;
      f.sprite.y += f.dy;
      if (f.gravity !== false) f.dy += 0.02; // light gravity
      f.sprite.alpha = Math.max(0, 1 - f.age / f.life);
    }
  }

  function updateRipples(dtSec) {
    if (!activeRipples.length) return;
    for (let i = activeRipples.length - 1; i >= 0; i--) {
      const r = activeRipples[i];
      r.age += dtSec;
      if (r.age >= r.life) {
        r.gfx.visible = false;
        activeRipples.splice(i, 1);
        continue;
      }
      const p = r.age / r.life;
      r.gfx.clear();
      r.gfx.beginFill(PARTICLE_ALLOWED, 0.5 * (1 - p));
      r.gfx.drawCircle(r.gfx.x, r.gfx.y, 4 + p * topo.shieldRadius);
      r.gfx.endFill();
    }
  }

  app.ticker.add(() => {
    const now = clock();
    const dtMs = lastNow == null ? FRAME_MS : now - lastNow;
    lastNow = now;
    if (!visible) return; // only the visible tab spends CPU (Ticket 9)
    const live = timeline ? timeline.liveStepIndex() ?? 0 : Number.MAX_SAFE_INTEGER;
    // live-edge: glide toward the newest frame, never past it (no snap-back)
    playhead = reduceMotion ? live : Math.min(playhead + dtMs / FRAME_MS, live);
    const frame = timeline ? pickFrame(timeline.frames(), playhead) : null;
    if (frame) renderFrame(frame, playhead);
    updateFragments(dtMs / 1000);
    updateRipples(dtMs / 1000);
    updateShield(dtMs / 1000);
    updateSweep();
  });

  function setBotCount(N) {
    count = clamp(Math.round(Number(N)) || BOT_MIN, BOT_MIN, BOT_MAX);
    rebuild();
  }

  function setAttackActive(on) {
    attackActive = !!on;
    const G = gsap || window.gsap || null;
    if (!G || reduceMotion) {
      // instant fan-out/collapse under reduced motion (no tween, no motion)
      display = attackActive ? activeDisplay(topo.bots) : dormantDisplay(topo.bots, topo.host);
      syncBots();
      return;
    }
    return attackActive
      ? fanOut(topo.bots, topo.host, display, G, syncBots)
      : collapse(topo.bots, topo.host, display, G, syncBots);
  }

  function setMitigation(on) {
    mitigationOn = !!on;
    updateShield(0);
    updateHud();
  }

  function setBlockedRate(r) {
    blockedRate = Number(r) || 0;
  }

  function setVisible(on) {
    visible = !!on;
    if (!on) {
      for (const sp of particles) sp.visible = false;
      for (const sp of trails) sp.visible = false;
      hideTooltip();
    }
  }

  // highlight a bot by index (strip hover); null clears it
  function highlightBot(i) {
    highlight = i == null ? null : clamp(Math.round(i), 0, topo.bots.length - 1);
    syncBots();
  }

  // notify the strip when a bot is hovered so it can follow along
  function onBotHover(cb) {
    hoverCb = cb;
  }

  // reflect WS connection state on the radar sweep (never fake a scan offline)
  function setConnected(on) {
    connected = !!on;
    updateSweep();
  }

  function resize() {
    const w = canvas.clientWidth || 640;
    const h = canvas.clientHeight || 360;
    app.renderer.resize(w, h);
    rebuild();
  }

  rebuild();
  updateShield(0);
  updateHud();

  return {
    setBotCount,
    setAttackActive,
    setMitigation,
    setBlockedRate,
    setVisible,
    highlightBot,
    onBotHover,
    setConnected,
    resize,
    renderFrame,
    isPixi: true,
  };
}

// initThreatRenderer({ canvas, timeline, gsap, pixi, reduceMotion, clock, rateLimitMaxRps }) -> facade.
// pixi lets tests inject a stub; runtime uses window.PIXI (vendored global).
// reduceMotion drops effects (trails, spin, pulse, ripples, sweep) but keeps data.
// clock lets tests drive the ticker deterministically; default is performance.now.
export function initThreatRenderer({ canvas, timeline = null, gsap = null, pixi = null, reduceMotion = false, clock = null, rateLimitMaxRps = 2 } = {}) {
  const P = pixi || window.PIXI || null;
  let app = null;
  if (P) {
    try {
      app = new P.Application({
        view: canvas,
        antialias: true,
        backgroundAlpha: 0,
        resolution: window.devicePixelRatio || 1,
        width: (canvas && canvas.clientWidth) || 640,
        height: (canvas && canvas.clientHeight) || 360,
      });
    } catch {
      app = null;
    }
  }
  if (!app) return canvasFallback(canvas, gsap);
  return pixiFacade(app, canvas, timeline, gsap, P, { reduceMotion, clock, rateLimitMaxRps });
}