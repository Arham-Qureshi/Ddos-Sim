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

// host at 20% width, target at 80% width, both vertically centered. N bots
// orbit the host on a radius that self-scales and always stays inside the
// canvas (host.x = 0.2W so radius <= 0.2W never crosses the left edge).
export function buildTopology(N, width, height) {
  if (!(width > 0) || !(height > 0)) {
    return { host: null, target: null, bots: [], radius: 0 };
  }
  const count = normalizeBotCount(N);
  const host = { x: 0.2 * width, y: height / 2, label: "Attacker Host" };
  const target = { x: 0.8 * width, y: height / 2, label: "Target Server" };
  const radius = Math.min(0.2 * width, 0.4 * height);
  const bots = [];
  for (let i = 0; i < count; i++) {
    const angle = (2 * Math.PI * i) / count;
    bots.push({
      id: i + 1,
      label: `Bot-${String(i + 1).padStart(3, "0")}`,
      vip: `10.0.0.${i + 1}`,
      x: host.x + radius * Math.cos(angle),
      y: host.y + radius * Math.sin(angle),
      angle,
      r: radius,
    });
  }
  return { host, target, bots, radius };
}