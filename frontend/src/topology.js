// topology.js — pure geometry for the threat map (Ticket 10).
// No DOM, no GSAP: the layout math t11 will also consume.

export const BOT_MIN = 1;
export const BOT_MAX = 32;

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeBotCount(n) {
  return clamp(Math.round(Number(n)) || BOT_MIN, BOT_MIN, BOT_MAX);
}

// target centered, host bottom-left, bots on an orbit ring around the target.
// radius self-scales to the canvas; bot 1 sits at the top of the ring so the
// orbit reads cleanly from 12 o'clock. shieldRadius drives the renderer's
// mitigation ring, spin ring and impact effects.
export function buildTopology(N, width, height) {
  if (!(width > 0) || !(height > 0)) {
    return { host: null, target: null, bots: [], radius: 0, shieldRadius: 0 };
  }
  const count = normalizeBotCount(N);
  const host = { x: 0.12 * width, y: 0.85 * height, label: "Attacker Host" };
  const target = { x: 0.5 * width, y: 0.5 * height, label: "Target Server" };
  const radius = Math.min(0.34 * width, 0.34 * height);
  const shieldRadius = Math.max(Math.min(width, height) * 0.12, 28);
  const bots = [];
  for (let i = 0; i < count; i++) {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / count;
    bots.push({
      id: i + 1,
      label: `Bot-${String(i + 1).padStart(3, "0")}`,
      vip: `10.0.0.${i + 1}`,
      x: target.x + radius * Math.cos(angle),
      y: target.y + radius * Math.sin(angle),
      angle,
      r: radius,
    });
  }
  return { host, target, bots, radius, shieldRadius };
}