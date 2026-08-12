import { RingBuffer, seedSeries, ingestFrame, chartData } from "./telemetry.js";

const STALE_MS = 2500; // mirror backend stale_threshold_s
const WS_TICK_MS = 500; // server pushes every 0.5s
const MAX_ATTACK_DELAY_BACKOFF = 8000;
const ATTACK_PARAMS = { rps: 200, threads: 4, duration: 10 };

const state = {
  series: null,
  chart: null,
  buffers: {
    conns: new RingBuffer(),
    cpu: new RingBuffer(),
  },
  ws: null,
  backoff: 500,
  lastMessageAt: 0,
  engineLive: false,
  lastAttackAt: 0,
  mitigationOn: true,
  attackActive: false,
  engineReachable: true,
  controlTimer: null,
};

const $ = (id) => document.getElementById(id);

const els = {
  statusDot: $("status-dot"),
  statusText: $("status-text"),
  chart: $("traffic-chart"),
  conns: $("metric-conns"),
  cpu: $("metric-cpu"),
  blocked: $("metric-blocked"),
  last: $("metric-last"),
  log: $("security-log"),
  logEmpty: $("log-empty"),
  attackBtn: $("launch-attack"),
  stopBtn: $("stop-attack"),
  mitigationBtn: $("mitigation-toggle"),
  vipInput: $("vip-input"),
  vipBan: $("vip-ban"),
  vipUnban: $("vip-unban"),
  toast: $("toast"),
};

// ---- status pill ----
function setStatus(kind, text) {
  const palette = {
    live: ["bg-emerald-400", "text-emerald-300"],
    down: ["bg-rose-500", "text-rose-300"],
    connecting: ["bg-amber-400", "text-amber-300"],
  };
  const [dot, txt] = palette[kind] || palette.connecting;
  els.statusDot.className = `h-3 w-3 rounded-full ${dot} pulse-dot`;
  els.statusText.textContent = text;
  els.statusText.className = `mono text-sm uppercase tracking-widest ${txt}`;
  if (kind === "live") els.statusDot.classList.remove("pulse-dot");
}

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.remove("hide", "hidden");
  setTimeout(() => els.toast.classList.add("hide"), 2600);
}

// ---- charts ----
function buildChartOptions() {
  const axisStyle = {
    axisLine: { lineStyle: { color: "rgba(148,163,184,0.25)" } },
    axisLabel: { color: "#7c8aa0" },
    splitLine: { lineStyle: { color: "rgba(148,163,184,0.08)" } },
  };
  const seriesDef = [
    { key: "attack", name: "attack rps", color: "#f59e0b", fill: "rgba(245,158,11,0.25)" },
    { key: "blocked", name: "blocked rps", color: "#fb7185", fill: "rgba(251,113,133,0.25)" },
    { key: "normal", name: "normal rps", color: "#38bdf8", fill: "rgba(56,189,248,0.25)" },
  ];
  return {
    animationDuration: 0, // stream smooth, no bounce on every tick
    grid: { left: 48, right: 16, top: 32, bottom: 28 },
    tooltip: {
      trigger: "axis",
      backgroundColor: "#131b29",
      borderColor: "rgba(148,163,184,0.25)",
      textStyle: { color: "#cbd5e1" },
    },
    xAxis: {
      type: "time",
      ...axisStyle,
      axisLabel: { ...axisStyle.axisLabel, formatter: "{HH}:{mm}:{ss}" },
    },
    yAxis: { type: "value", ...axisStyle, name: "rps", nameTextStyle: { color: "#7c8aa0" } },
    series: seriesDef.map((s) => ({
      key: s.key,
      name: s.name,
      type: "line",
      showSymbol: false,
      smooth: true,
      lineStyle: { width: 2, color: s.color },
      itemStyle: { color: s.color },
      areaStyle: { color: s.fill },
      data: [],
    })),
  };
}

function render() {
  const opts = buildChartOptions();
  opts.series.forEach((s) => {
    s.data = chartData(state.series, s.key);
  });
  state.chart.setOption(opts, true);
}

// ---- security log ----
const knownVips = new Set();
let lastBlocks = [];

function renderLogWith(blocks) {
  if (!blocks) return;
  lastBlocks = blocks;
  const tbody = els.log;
  tbody.textContent = "";
  const all = blocks.map((b) => b.vip);
  for (const b of blocks) {
    const tr = document.createElement("tr");
    tr.className = "px-4 py-2";
    if (!knownVips.has(b.vip)) {
      tr.classList.add("flash-row");
    }
    const vip = document.createElement("td");
    vip.className = "px-4 py-2 text-slate-100";
    vip.textContent = b.vip;
    const status = document.createElement("td");
    status.className = "px-4 py-2";
    status.innerHTML = `<span class="rounded bg-rose-900/40 px-2 py-0.5 text-[10px] uppercase tracking-widest text-rose-300">blocked</span>`;
    const clock = document.createElement("td");
    clock.className = "px-4 py-2 text-right text-slate-500";
    clock.textContent = b.unblock_ts === 0 ? "permanent" : (b.unblock_ts ?? "—");
    tr.append(vip, status, clock);
    tbody.prepend(tr); // newest on top
  }
  knownVips.clear();
  all.forEach((v) => knownVips.add(v));
  els.logEmpty.style.display = blocks.length ? "none" : "";
}

function updateMetrics(f) {
  els.conns.textContent = String(f.active_connections ?? 0);
  els.cpu.textContent = `${((f.cpu_load_pct ?? 0) * 100).toFixed(0)}%`;
  els.blocked.textContent = String(f.blocked_rps ?? 0);
  const ago = Date.now() - state.lastMessageAt;
  els.last.textContent = `${(ago / 1000).toFixed(1)}s`;
}

// ---- websocket ----
function wsUrl() {
  const base = window.__API_BASE__ || ""; // e.g. "localhost:8000" when http.server serves this page
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const host = base || location.host;
  return `${proto}//${host}/api/ws/telemetry`;
}

function scheduleReconnect() {
  setTimeout(connect, state.backoff);
  state.backoff = Math.min(state.backoff * 2, MAX_ATTACK_DELAY_BACKOFF);
  setStatus("connecting", "reconnecting…");
}

function connect() {
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;
  const ws = new WebSocket(wsUrl());
  state.ws = ws;

  ws.onopen = () => {
    state.backoff = 500; // reset backoff on a clean connect
    setStatus("connecting", "syncing…");
    seedFromRest();
    syncControlState();
  };

  ws.onmessage = (ev) => {
    state.lastMessageAt = Date.now();
    let frame = null;
    try {
      frame = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!frame) return; // engine silent
    if (!state.series) {
      state.series = seedSeries([{ timestamp: frame.ts, metrics: frame }]);
    }
    ingestFrame(frame, state.series);
    render();
    renderLogWith(frame.blocks || []);
    updateMetrics(frame);
    setEngineLive(true);
    setStatus("live", "engine live");
  };

  ws.onclose = () => {
    setStatus("down", "sim went dark — reconnecting");
    scheduleReconnect();
  };
  ws.onerror = () => ws.close();
}

async function seedFromRest() {
  const base = window.__API_BASE__ || location.host;
  try {
    const res = await fetch(`http://${base}/api/telemetry/latest`);
    if (!res.ok) return;
    const body = await res.json();
    const hist = body.history || [];
    if (hist.length) {
      state.series = seedSeries(hist);
      render();
    }
    setEngineLive(body.engine_connected);
  } catch {
    // REST seed is best-effort; live ws frames will fill the chart anyway
  }
}

let staleTimer = null;
function setEngineLive(live) {
  state.engineLive = live;
  if (staleTimer) clearTimeout(staleTimer);
  if (live) {
    // if frames stop arriving but ws stays open, flip the pill to dark
    staleTimer = setTimeout(() => setEngineLive(false), STALE_MS);
  }
}

// ---- control socket (Ticket 7) ----
function apiBase() {
  return window.__API_BASE__ || location.host;
}

// find where FastAPI actually lives when the static host can't proxy /api.
// nginx (or FastAPI serving the page) answers on the page origin -> keep it;
// python http.server returns 404 for /api -> point REST+WS at :8000 instead.
async function resolveApiBase() {
  if (window.__API_BASE__) return; // explicitly overridden in the console
  try {
    const host = location.host || "localhost:8000";
    const res = await fetch(`http://${host}/api/control/status`);
    if (res.ok) return; // same-origin proxy already works
  } catch { /* origin unreachable -> fall through */ }
  window.__API_BASE__ = `${location.hostname || "localhost"}:8000`;
}

async function controlRequest(method, path, body = null) {
  const res = await fetch(`http://${apiBase()}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 204 or non-json */ }
  return { status: res.status, data };
}

function replyText(data) {
  // FastAPI error envelopes live under detail; happy path is the body itself
  return data?.reply || data?.detail?.reply || "no reply";
}

// reflect engine state (control socket) into the header buttons
async function syncControlState() {
  let status = null;
  try {
    const { status: code, data } = await controlRequest("GET", "/api/control/status");
    status = code === 200 ? data : null;
  } catch { /* engine dark */ }
  if (!status) {
    state.engineReachable = false;
    state.attackActive = false;
  } else {
    state.engineReachable = status.engine_reachable ?? true;
    state.attackActive = Boolean(status.attack_running);
    state.mitigationOn = Boolean(status.mitigation_on);
  }
  updateControlUi();
}

function updateControlUi() {
  const down = !state.engineReachable;
  els.attackBtn.disabled = down || state.attackActive;
  els.stopBtn.disabled = down || !state.attackActive;
  els.mitigationBtn.disabled = down;
  els.vipBan.disabled = down;
  els.vipUnban.disabled = down;

  if (state.mitigationOn) {
    els.mitigationBtn.textContent = "Mitigation: On";
    els.mitigationBtn.className = "btn-focus mono rounded-md border border-emerald-700/60 bg-emerald-950/40 px-4 py-2 text-sm font-semibold uppercase tracking-widest text-emerald-300 transition-colors hover:border-emerald-500 disabled:cursor-not-allowed disabled:opacity-40";
  } else {
    els.mitigationBtn.textContent = "Mitigation: Off";
    els.mitigationBtn.className = "btn-focus mono rounded-md border border-amber-700/60 bg-amber-950/40 px-4 py-2 text-sm font-semibold uppercase tracking-widest text-amber-300 transition-colors hover:border-amber-500 disabled:cursor-not-allowed disabled:opacity-40";
  }
}

function handleAttack() {
  const now = Date.now();
  if (now - state.lastAttackAt < 5000) return; // client debounce on top of backend cooldown
  state.lastAttackAt = now;
  toast("launching attack…");
  controlRequest("POST", "/api/control/attack", ATTACK_PARAMS).then(({ status, data }) => {
    if (status === 200 && data?.ok) {
      state.attackActive = true;
      toast("attack started");
      clearTimeout(state.controlTimer);
      state.controlTimer = setTimeout(syncControlState, (ATTACK_PARAMS.duration + 1) * 1000);
    } else if (status === 429 || (data && !data.ok)) {
      toast(replyText(data) || "cooling down");
    } else if (status === 503 || status === 0) {
      state.engineReachable = false;
      toast("engine offline — start ddos_server");
    } else {
      toast(replyText(data) || "attack failed");
    }
    updateControlUi();
  }).catch(() => {
    state.engineReachable = false;
    toast("engine offline — start ddos_server");
    updateControlUi();
  });
}

async function handleStop() {
  toast("stopping attack…");
  try {
    const { data } = await controlRequest("POST", "/api/control/attack/stop");
    toast(replyText(data) || "stopped");
    state.attackActive = false;
  } catch {
    state.engineReachable = false;
    toast("engine offline — start ddos_server");
    state.attackActive = false;
  }
  clearTimeout(state.controlTimer);
  syncControlState();
}

async function handleMitigation() {
  const next = !state.mitigationOn;
  toast(`mitigation → ${next ? "on" : "off"}…`);
  try {
    const { data } = await controlRequest("POST", "/api/control/mitigation", { enabled: next });
    toast(replyText(data) || "mitigation toggled");
  } catch {
    state.engineReachable = false;
    toast("engine offline — start ddos_server");
  }
  syncControlState();
}

function handleVip(actionStr) {
  const vip = (els.vipInput.value || "").trim();
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(vip) || vip === "127.0.0.1") {
    toast("enter a valid non-loopback IPv4");
    return;
  }
  const path = actionStr === "ban" ? "/api/control/vips/ban" : "/api/control/vips/unban";
  toast(`${actionStr}ning ${vip}…`);
  controlRequest("POST", path, { vip }).then(({ status, data }) => {
    toast(replyText(data) || `${actionStr}ned`);
    if (status === 503) {
      state.engineReachable = false;
      updateControlUi();
    }
  }).catch(() => {
    state.engineReachable = false;
    toast("engine offline — start ddos_server");
    updateControlUi();
  });
}

// ---- boot ----
if (state.chart) {
  throw new Error("bootstrap ran twice");
}
state.chart = echarts.init(els.chart);
render();
renderLogWith([]);

async function init() {
  await resolveApiBase(); // REST/WS must hit FastAPI, not the static host
  connect();
  updateControlUi();
  syncControlState();
  els.attackBtn.addEventListener("click", handleAttack);
  els.stopBtn.addEventListener("click", handleStop);
  els.mitigationBtn.addEventListener("click", handleMitigation);
  els.vipBan.addEventListener("click", () => handleVip("ban"));
  els.vipUnban.addEventListener("click", () => handleVip("unban"));
  els.vipInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleVip("ban");
  });
}
init();

// keep chart sized if the window resizes
window.addEventListener("resize", () => state.chart && state.chart.resize());