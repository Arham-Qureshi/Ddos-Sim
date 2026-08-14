// admin_panel.js — persistent control sidebar (Ticket 8). Holds the pure
// payload/validation helpers (unit-testable, no DOM) plus the wiring that
// turns sidebar changes into dispatch calls handed back to dashboard.js.

// hard client-side caps so a rogue slider can never ask the engine for
// something the UI contract doesn't allow (engine caps are wider: 10-1000,
// 1-64, 1-300; the sidebar narrows them for demo safety).
export const RPS_MIN = 10;
export const RPS_MAX = 200;
export const BOTS_MIN = 1;
export const BOTS_MAX = 32;
export const DURATION_MIN = 5;
export const DURATION_MAX = 60;

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// attack payload: bot count slider feeds BOTH the attack thread count and
// the baseline fan-out. duration is clamped to the 5-60s sidebar range.
export function buildAttackPayload({ rps, bots, duration }) {
  return {
    rps: clamp(Math.round(rps), RPS_MIN, RPS_MAX),
    threads: clamp(Math.round(bots), BOTS_MIN, BOTS_MAX),
    duration: clamp(Math.round(duration), DURATION_MIN, DURATION_MAX),
  };
}

// baseline: same bot count feed; throws on garbage so callers surface it.
export function baselineCmd({ enabled, bots }) {
  if (!enabled) return "CMD_SET_BASELINE off";
  const n = clamp(Math.round(bots), BOTS_MIN, BOTS_MAX);
  return `CMD_SET_BASELINE on ${n}`;
}

// algorithm selector is a whitelist; anything else is a bug, refuse loudly.
export function algorithmCmd(alg) {
  if (alg !== "token_bucket" && alg !== "sliding_window") {
    throw new Error(`unknown algorithm: ${alg}`);
  }
  return `CMD_SET_ALGORITHM ${alg}`;
}

// wire the sidebar DOM; actions are injected so dashboard.js stays the only
// owner of network + state. Returns { getParams, setStatus } for sync.
export function initAdminPanel(els, actions) {
  const params = {
    rps: Number(els.rps.value) || RPS_MAX,
    bots: Number(els.bots.value) || 8,
    duration: Number(els.duration.value) || 10,
  };

  const renderValues = () => {
    els.rpsVal.textContent = params.rps;
    els.botsVal.textContent = params.bots;
  };

  // live param edits just update the panel + rerun baseline when it's on
  els.rps.addEventListener("input", () => {
    params.rps = clamp(Math.round(Number(els.rps.value)), RPS_MIN, RPS_MAX);
    renderValues();
    if (els.baseline.checked) actions.baseline({ enabled: true, bots: params.bots });
  });
  els.bots.addEventListener("input", () => {
    params.bots = clamp(Math.round(Number(els.bots.value)), BOTS_MIN, BOTS_MAX);
    renderValues();
    if (els.baseline.checked) actions.baseline({ enabled: true, bots: params.bots });
  });
  els.duration.addEventListener("change", () => {
    params.duration = clamp(Math.round(Number(els.duration.value)), DURATION_MIN, DURATION_MAX);
    els.duration.value = params.duration;
  });

  els.launch.addEventListener("click", () =>
    actions.launch(buildAttackPayload(params)));
  els.stop.addEventListener("click", () => actions.stop());
  els.mitigation.addEventListener("click", () => actions.mitigation());
  els.emergency.addEventListener("click", () => actions.emergency());

  els.baseline.addEventListener("change", () =>
    actions.baseline({ enabled: els.baseline.checked, bots: params.bots }));
  els.algorithm.addEventListener("change", () =>
    actions.algorithm(els.algorithm.value));

  renderValues();

  return {
    getParams: () => params,
    // reflect engine state back onto the sidebar after a status sync
    setStatus: (status) => {
      els.baseline.checked = Boolean(status.baseline_running);
      if (els.algorithm.value !== status.algorithm) {
        els.algorithm.value = status.algorithm;
      }
      params.bots = clamp(
        status.baseline_bots || params.bots, BOTS_MIN, BOTS_MAX);
      els.bots.value = params.bots;
      renderValues();
    },
  };
}
