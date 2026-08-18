// threat_stats.js — pure counters for the t12/v2 threat-map HUD and bot
// tooltips. No Pixi, no DOM: fold a rolling window of frames into totals the
// renderer can read at a glance. Stats are computed immutably (each fold
// returns a fresh object) so stale HUD reads never alias live data.

export function emptyStats() {
  return { allowed: 0, blocked: 0, byBot: new Map() };
}

// fold a frame's packets into a copy of `stats` (the input is never mutated)
export function addPackets(stats, packets) {
  const out = { allowed: stats.allowed, blocked: stats.blocked, byBot: new Map(stats.byBot) };
  for (const p of packets || []) {
    if (p.status === "DROPPED") out.blocked++;
    else out.allowed++;
    const e = out.byBot.get(p.botId) || { sent: 0, blocked: 0 };
    e.sent++;
    if (p.status === "DROPPED") e.blocked++;
    out.byBot.set(p.botId, e);
  }
  return out;
}

// totals across a window of frames (renderer keeps the last ~60 frames)
export function statsFromFrames(frames) {
  let stats = emptyStats();
  for (const f of frames || []) stats = addPackets(stats, f && f.activePackets);
  return stats;
}