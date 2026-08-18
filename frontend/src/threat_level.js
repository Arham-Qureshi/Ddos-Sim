// threat_level.js — judgment-first status: turn the live blocked rate into a
// single, glanceable threat level (nominal/elevated/severe) + one-line reason.
// Pure and deterministic; the banner and the canvas ambient both consume it.

export function threatLevel(blockedRps, capRps = 2) {
  const b = Number(blockedRps) || 0;
  if (b <= 0) {
    return { level: "nominal", label: "NOMINAL", color: 0x38bdf8, detail: "no traffic blocked" };
  }
  if (b < capRps * 2) {
    return { level: "elevated", label: "ELEVATED", color: 0xf59e0b, detail: `blocking ${Math.round(b)} rps` };
  }
  return {
    level: "severe",
    label: "SEVERE",
    color: 0xfb7185,
    detail: `blocked ${Math.round(b)} rps — attack in progress`,
  };
}