// threat_map.js — Canvas 2D renderer + GSAP fan-out for the threat map (t10).
// The tween builders are pure and unit-testable; initThreatMap (next task)
// wires them to a canvas. GSAP is a vendored global (window.gsap) with a
// graceful fallback to instant redraw when absent.

import { buildTopology, clamp, BOT_MIN, BOT_MAX } from "./topology.js";

export const BOT_RADIUS = 3.5;

// display is a parallel array to topology.bots; gsap tweens mutate it and the
// draw pass reads it, so animation and geometry never fight over one object.
export function dormantDisplay(bots, host) {
  return bots.map(() => ({ x: host.x, y: host.y, scale: 0, opacity: 0 }));
}

export function activeDisplay(bots) {
  return bots.map((b) => ({ x: b.x, y: b.y, scale: 1, opacity: 1 }));
}

export function fanOut(bots, host, display, gsap, onUpdate) {
  return bots.map((b, i) =>
    gsap.to(display[i], {
      x: b.x, y: b.y, scale: 1, opacity: 1,
      duration: 0.6, delay: i * 0.03, ease: "back.out(1.4)", onUpdate,
    })
  );
}

export function collapse(bots, host, display, gsap, onUpdate) {
  return bots.map((_, i) =>
    gsap.to(display[i], {
      x: host.x, y: host.y, scale: 0, opacity: 0,
      duration: 0.4, delay: i * 0.02, ease: "power1.in", onUpdate,
    })
  );
}

const COLORS = {
  host: "#64748b",
  target: "#38bdf8",
  botDormant: "rgba(148,163,184,0.4)",
  botActive: "#f59e0b",
  label: "#7c8aa0",
};

function drawNode(ctx, x, y, r, color, alpha = 1) {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawLabel(ctx, text, x, y, alpha = 1) {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = COLORS.label;
  ctx.font = "10px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.fillText(text, x, y);
  ctx.globalAlpha = 1;
}

function noopMap() {
  return { setBotCount() {}, setAttackActive() {}, resize() {} };
}

// initThreatMap({ canvas, gsap }) -> { setBotCount, setAttackActive, resize }
export function initThreatMap({ canvas, gsap = null }) {
  const ctx = canvas && canvas.getContext && canvas.getContext("2d");
  if (!ctx) return noopMap();

  const G = gsap || window.gsap || null;
  let count = 8;
  let attackActive = false;
  let topo = buildTopology(count, 640, 360);
  let display = dormantDisplay(topo.bots, topo.host);

  rebuild();
  draw();

  function measure() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 640;
    const h = canvas.clientHeight || 360;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  function rebuild() {
    const { w, h } = measure();
    topo = buildTopology(count, w, h);
    display = attackActive
      ? activeDisplay(topo.bots)
      : dormantDisplay(topo.bots, topo.host);
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!topo.host || !topo.target) return;
    drawNode(ctx, topo.host.x, topo.host.y, 7, COLORS.host);
    drawLabel(ctx, topo.host.label, topo.host.x, topo.host.y + 22);
    drawNode(ctx, topo.target.x, topo.target.y, 9, COLORS.target);
    drawLabel(ctx, topo.target.label, topo.target.x, topo.target.y + 24);
    topo.bots.forEach((b, i) => {
      const d = display[i];
      if (!d || d.scale <= 0.01) return;
      drawNode(ctx, d.x, d.y, BOT_RADIUS * d.scale,
               attackActive ? COLORS.botActive : COLORS.botDormant, d.opacity);
      if (attackActive) drawLabel(ctx, b.vip, d.x, d.y - 10, d.opacity);
    });
  }

  return {
    setBotCount(N) {
      count = clamp(Math.round(Number(N)) || BOT_MIN, BOT_MIN, BOT_MAX);
      rebuild();
      draw();
    },
    setAttackActive(on) {
      attackActive = !!on;
      if (!G) {
        rebuild();
        draw();
        return [];
      }
      return on
        ? fanOut(topo.bots, topo.host, display, G, draw)
        : collapse(topo.bots, topo.host, display, G, draw);
    },
    resize() {
      rebuild();
      draw();
    },
  };
}