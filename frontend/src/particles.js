// particles.js — pure flight geometry for the t12 threat map particle engine.
// No Pixi, no DOM: every position/state the WebGL renderer draws derives from
// these helpers, so the math is fully covered under jsdom.

import { clamp } from "./topology.js";

export const SHIELD_R = 40; // px radius of the mitigation shield ring

// fraction of the bot->target journey where the segment first crosses the
// shield circle (right-triangle solve: nearest point is r away from target)
export function shieldHitFraction(bot, target, r = SHIELD_R) {
  const d = Math.hypot(target.x - bot.x, target.y - bot.y);
  if (d <= 0) return 0;
  return clamp(1 - r / d, 0, 1);
}

export function shieldHitPoint(bot, target, r = SHIELD_R) {
  const f = shieldHitFraction(bot, target, r);
  return { x: bot.x + (target.x - bot.x) * f, y: bot.y + (target.y - bot.y) * f };
}

// interpolate a packet along bot->target; DROPPED packets stop at the shield
// boundary so they visibly shatter there instead of flying through
export function projectPacket(packet, bot, target, r = SHIELD_R) {
  const p = packet.status === "DROPPED"
    ? Math.min(packet.progress, shieldHitFraction(bot, target, r))
    : packet.progress;
  return {
    x: bot.x + (target.x - bot.x) * p,
    y: bot.y + (target.y - bot.y) * p,
    progress: p,
    status: packet.status,
  };
}

// safe source->screen mapping: engine VIPs are pinned to 1..threads, but any
// replay of old frames or a stray VIP must land on a real bot, not the host
export function resolveBotIndex(botId, n) {
  if (n <= 0) return -1;
  const i = Number(botId) || 0;
  return i >= 1 && i <= n ? i - 1 : (((i - 1) % n) + n) % n;
}

// smoothstep easing: packets ease out of the source and settle at the target
export function easeFlight(t) {
  return t * t * (3 - 2 * t);
}

// derivative of smoothstep -> velocity envelope, peak at the midpoint; feeds
// streak length so particles stretch while moving fast and shrink at rest
export function easeVel(t) {
  return 6 * t * (1 - t);
}

export function streakLength(easedT, maxLen = 18) {
  return clamp(maxLen * easeVel(clamp(easedT, 0, 1)), 2, maxLen);
}

// eased flight position; DROPPED still clamps to the shield ring
export function projectPacketEased(packet, bot, target, r = SHIELD_R) {
  const eased = easeFlight(clamp(packet.progress, 0, 1));
  return projectPacket({ ...packet, progress: eased }, bot, target, r);
}

// ---- arc flights: packets travel a quadratic bezier for a great-circle
// swoop instead of a straight line ----

// control point perpendicular to a->b with a fixed handedness: every chord
// bows in the same rotational direction, so radial bot->target flights read
// as one gently orbiting system. `center` is accepted for API stability but
// radial chords are symmetric around it, so the bow is purely tangential.
export function arcControlPoint(a, b, center, lift = 0.22) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const d = Math.min(len * lift, 80);
  return { x: mx - (dy / len) * d, y: my + (dx / len) * d };
}

export function quadBezier(p0, c, p1, t) {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x,
    y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y,
  };
}

// eased position along the arc; DROPPED packets snap to the shield ring along
// the ray from the target so they shatter on the shield exactly like straight
// flights did. at the degenerate arrival point the ray falls back to the
// bot->target chord so the snap still has a direction.
export function projectArcEased(packet, bot, target, ctrl, r = SHIELD_R) {
  const e = easeFlight(clamp(packet.progress, 0, 1));
  const pt = quadBezier(bot, ctrl, target, e);
  const dist = Math.hypot(pt.x - target.x, pt.y - target.y);
  if (packet.status === "DROPPED" && dist < r) {
    const chordLen = Math.hypot(bot.x - target.x, bot.y - target.y) || 1;
    const nx = dist > 0 ? (pt.x - target.x) / dist : (bot.x - target.x) / chordLen;
    const ny = dist > 0 ? (pt.y - target.y) / dist : (bot.y - target.y) / chordLen;
    return { x: target.x + nx * r, y: target.y + ny * r, progress: e, dist: r, status: "DROPPED" };
  }
  return { x: pt.x, y: pt.y, progress: e, dist, status: packet.status };
}

// host->bot and bot->target connector lines for the given topology
export function buildVectorLinks(bots, host, target) {
  const links = [];
  for (const b of bots) {
    links.push({ x1: host.x, y1: host.y, x2: b.x, y2: b.y });
    links.push({ x1: b.x, y1: b.y, x2: target.x, y2: target.y });
  }
  return links;
}

// tiny deterministic PRNG so shatter bursts (and their tests) are stable
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// deterministic burst of drift fragments at a shield hit point
export function shatterBurst(x, y, seed = 1, count = 7) {
  const rnd = mulberry32(seed);
  const out = [];
  for (let i = 0; i < count; i++) {
    const angle = rnd() * Math.PI * 2;
    const speed = 0.5 + rnd() * 1.5;
    out.push({
      dx: Math.cos(angle) * speed,
      dy: Math.sin(angle) * speed - 0.6,
      life: 0.5 + rnd() * 0.4,
    });
  }
  return out;
}

// TimelineBuffer.frames() is a contiguous ring, newest last. Return the frame
// at floor(playheadStep) when it is in the window, else the closest frame.
export function pickFrame(frames, playheadStep) {
  if (!frames.length) return null;
  const oldest = frames[0];
  const latest = frames[frames.length - 1];
  const target = Math.floor(playheadStep);
  if (target <= oldest.stepIndex) return oldest;
  if (target >= latest.stepIndex) return latest;
  const idx = frames.length - 1 - (latest.stepIndex - target);
  return frames[clamp(idx, 0, frames.length - 1)];
}

// smooth progress between the 100ms integer steps: stored packet.progress is
// the value at the current frame, extrapolate it along the flight so particles
// glide at 60fps instead of jumping 10fps
export function continuousProgress(packet, playheadStep, flightFrames = 4) {
  const frac = (playheadStep - Math.floor(playheadStep)) / flightFrames;
  return clamp(packet.progress + frac, 0, 1);
}