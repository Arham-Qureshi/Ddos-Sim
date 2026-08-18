import {
  seedSeries,
  ingestFrame,
  chartDataLive,
  floorCountdown,
  WINDOW_CAPACITY,
} from "./telemetry.js";
import { initTabs } from "./tabs.js";
import { initAdminPanel } from "./admin_panel.js";
import { initThreatRenderer } from "./threat_renderer.js";
import { TimelineBuffer } from "./timeline_buffer.js";
import { threatLevel } from "./threat_level.js";
import { drawSparkline } from "./sparkline.js";
import { statsFromFrames } from "./threat_stats.js";
import { initScrubber } from "./scrubber_controls.js";
import { initNodeInspector } from "./node_inspector.js";

const STALE_MS = 2500; // mirror backend stale_threshold_s
const WS_TICK_MS = 500; // server pushes every 0.5s
const WINDOW_MS = WINDOW_CAPACITY * WS_TICK_MS; // fixed 60s rolling window
const MAX_RECONNECT_BACKOFF = 8000;
const SPARK_CAP = 120; // ~1 minute of strip sparkline history at 0.5s ticks

const state = {
  series: null,
  chart: null,
  sparkConns: null,
  sparkCpu: null,
  ws: null,
  backoff: 500,
  lastMessageAt: 0,
  config: {
    rateLimitMaxRps: 20,
    rateLimitBlockSeconds: 10,
  },
  attackWindows: [], // [{ startAt, endAt }] for chart shading (ms)
  totalBlocked: 0,
  events: [], // [{ at, kind, text }] newest first
  engineReachable: true,
  attackActive: false,
  mitigationOn: true,
  algorithm: "token_bucket",
  lastAttackAt: 0,
  seedRendered: false,
  activeTab: "command-center", // visible tab; only it repaints (Ticket 9)
  sparkAttack: [], // rolling attack-rps series for the strip sparkline
  sparkBlocked: [], // rolling blocked-rps series for the strip sparkline
  bots: 8, // last known bot count, drives the strip tiles
  hoverBot: null, // bot index hovered on the map or the strip (highlight sync)
};

const $ = (id) => document.getElementById(id);

const els = {
  statusDot: $("status-dot"),
  statusText: $("status-text"),
  freshnessAge: $("freshness-age"),
  freshnessBar: $("freshness-bar"),
  chart: $("traffic-chart"),
  sparkConns: $("spark-conns"),
  sparkCpu: $("spark-cpu"),
  conns: $("metric-conns"),
  cpu: $("metric-cpu"),
  blocked: $("metric-blocked"),
  totalBlocked: $("metric-total-blocked"),
  log: $("security-log"),
  logEmpty: $("log-empty"),
  events: $("event-log"),
  eventsEmpty: $("event-empty"),
  droppedFrames: $("health-dropped"),
  uptime: $("health-uptime"),
  attackBtn: $("launch-attack"),
  stopBtn: $("stop-attack"),
  mitigationBtn: $("mitigation-toggle"),
  vipInput: $("vip-input"),
  vipBan: $("vip-ban"),
  vipUnban: $("vip-unban"),
  toast: $("toast"),
  sidebarRps: $("attack-rps"),
  sidebarRpsVal: $("attack-rps-val"),
  sidebarBots: $("bot-count"),
  sidebarBotsVal: $("bot-count-val"),
  sidebarDuration: $("attack-duration"),
  sidebarBaseline: $("baseline-toggle"),
  sidebarAlgorithm: $("algorithm-select"),
  sidebarEmergency: $("emergency-stop"),
  bannerDot: $("banner-dot"),
  bannerLabel: $("banner-label"),
  bannerDetail: $("banner-detail"),
  botStrip: $("bot-strip"),
  sparkAttack: $("spark-attack"),
  sparkBlocked: $("spark-blocked"),
  counterAllowed: $("counter-allowed"),
  counterBlocked: $("counter-blocked"),
  scrubPrev: $("scrub-prev"),
  scrubPlay: $("scrub-play"),
  scrubNext: $("scrub-next"),
  scrubFrame: $("scrub-frame"),
  scrubRange: $("scrub-range"),
  scrubSpeed: $("scrub-speed"),
  scrubLive: $("scrub-live"),
  scrubBanner: $("scrub-banner"),
  inspectorCard: $("inspector-card"),
  inspectorClose: $("inspector-close"),
  inspectorVip: $("inspector-vip"),
  inspectorWorker: $("inspector-worker"),
  inspectorRps: $("inspector-rps"),
  inspectorSent: $("inspector-sent"),
  inspectorBlocked: $("inspector-blocked"),
  inspectorStatus: $("inspector-status"),
};

// ---- status pill + freshness gauge ----
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
  else els.statusDot.classList.add("pulse-dot");
}

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.remove("hide", "hidden");
  setTimeout(() => els.toast.classList.add("hide"), 2600);
}

// freshness gauge re-armed on every frame and twice per second between them
function updateFreshness() {
  if (!state.lastMessageAt) return; // nothing seen yet, keep the placeholder
  const age = Date.now() - state.lastMessageAt;
  const fresh = age < STALE_MS - 500;
  els.freshnessAge.textContent = `${(age / 1000).toFixed(1)}s`;
  const thumbs = ["bg-emerald-500", "bg-amber-500", "bg-rose-500"];
  els.freshnessBar.className = `h-1.5 rounded-full transition-colors ${
    fresh ? thumbs[0] : age < STALE_MS + 500 ? thumbs[1] : thumbs[2]
  }`;
  if (!fresh && els.statusDot.classList.contains("bg-emerald-400")) {
    setStatus("down", "engine stale — reconnecting");
  }
}

// ---- charts ----
const SERIES_DEF = [
  { key: "normal", name: "normal rps", color: "#38bdf8", fill: "rgba(56,189,248,0.12)" },
  { key: "attack", name: "attack rps", color: "#f59e0b", fill: "rgba(245,158,11,0.22)" },
  { key: "blocked", name: "blocked rps", color: "#fb7185", fill: "rgba(251,113,133,0.22)" },
];

function buildChartOptions() {
  const axisStyle = {
    axisLine: { lineStyle: { color: "rgba(148,163,184,0.25)" } },
    axisLabel: { color: "#7c8aa0" },
    splitLine: { lineStyle: { color: "rgba(148,163,184,0.08)" } },
  };
  return {
    animation: false, // stream smooth, no bounce on every tick
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
    yAxis: {
      type: "value",
      ...axisStyle,
      name: "rps",
      scale: true,
      nameTextStyle: { color: "#7c8aa0" },
      markLine: {
        data: [{ yAxis: state.config.rateLimitMaxRps }],
        lineStyle: { color: "#f59e0b", type: "dashed", width: 1 },
        label: { formatter: "limit ${rateLimitMaxRps} rps", color: "#f59e0b", position: "insideEndTop" },
      },
    },
    series: SERIES_DEF.map((s) => ({
      id: s.key,
      name: s.name,
      type: "line",
      showSymbol: false,
      smooth: "monotone", // smooth slope, never overshoots between points
      lineStyle: { width: 2, color: s.color },
      itemStyle: { color: s.color },
      areaStyle: { color: s.fill },
      data: [],
    })),
  };
}

// full merge-mode repaint: structural options are set once, only the window and
// streamed data move. runs once per WS tick (render) and again every animation
// frame (paint) so the axis AND the line tips glide at 60fps between ticks.
function paint(now) {
  if (!state.series || !state.chart) return;
  if (state.activeTab !== "command-center") return; // hidden tab: keep ingesting, skip repaint
  const patch = {
    xAxis: { min: now - WINDOW_MS, max: now },
    series: [],
  };
  for (const s of SERIES_DEF) {
    const seriesPatch = { id: s.key, data: chartDataLive(state.series, s.key, now) };
    if (s.key === "attack") seriesPatch.markArea = attackMarkArea();
    patch.series.push(seriesPatch);
  }
  state.chart.setOption(patch);
  sparkRender(state.sparkConns, chartDataLive(state.series, "conns", now));
  sparkRender(state.sparkCpu, chartDataLive(state.series, "cpu", now));
}

function render() {
  paint(Date.now());
}

// 60fps glide: the rolling window and the live line tips track the wall clock
// every animation frame (rAF self-pauses in hidden tabs) so the chart scrolls
// smoothly instead of stepping on the 2Hz WS ticks.
function startFrameLoop() {
  const frame = () => {
    paint(Date.now());
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function attackMarkArea() {
  const areas = [];
  for (const w of state.attackWindows) {
    const start = w.startAt;
    if (start == null) continue;
    const end = w.endAt ?? Date.now();
    areas.push([
      {
        xAxis: start,
        itemStyle: { color: "rgba(245,158,11,0.08)" },
        label: { show: false },
      },
      { xAxis: end, label: { show: false } },
    ]);
  }
  return { silent: true, data: areas };
}

function sparkOptions(color) {
  return {
    animation: false,
    grid: { left: 2, right: 2, top: 2, bottom: 2 },
    xAxis: { type: "time", show: false },
    yAxis: { type: "value", show: false, scale: true },
    series: [{ type: "line", showSymbol: false, smooth: "monotone", lineStyle: { width: 1.5, color }, itemStyle: { color }, data: [] }],
  };
}

function sparkRender(chart, points) {
  if (!chart) return;
  chart.setOption({ series: [{ id: "spark", data: points }] });
}

// ---- security log (human ban clock) ----
let pinnedBot = null; // bot the inspector is pinned to (click), survives hover-out
let lastBlocks = [];
const seenBannedVips = new Set(); // persistent across renders -> flash only once per new ban

function renderLogWith(blocks) {
  if (!blocks) return;
  lastBlocks = blocks;
  const tbody = els.log;
  tbody.textContent = "";
  for (const b of blocks) {
    const isNew = !seenBannedVips.has(b.vip);
    if (isNew) seenBannedVips.add(b.vip);
    const tr = document.createElement("tr");
    tr.className = "px-4 py-2";
    if (isNew) tr.classList.add("flash-row");
    tr.classList.add("divide-x", "divide-slate-800/60"); // subtle row separation

    const vip = document.createElement("td");
    vip.className = "px-4 py-2 text-slate-100";
    vip.textContent = b.vip;

    const status = document.createElement("td");
    status.className = "px-4 py-2";
    status.innerHTML = `<span class="rounded bg-rose-900/40 px-2 py-0.5 text-[10px] uppercase tracking-widest text-rose-300">blocked</span>`;

    const clock = document.createElement("td");
    clock.className = "px-4 py-2 text-right";
    const remaining = floorCountdown(b.remaining_s);
    clock.textContent = remaining === null ? "permanent" : `expires in ${remaining}s`;
    clock.className += remaining === null
      ? " text-slate-500"
      : remaining <= 3 ? " text-rose-300" : " text-slate-400";

    tr.append(vip, status, clock);
    tbody.prepend(tr); // newest on top
  }
  els.logEmpty.style.display = blocks.length ? "none" : "";
}

// ---- event strip ----
function pushEvent(kind, text) {
  state.events.unshift({ at: Date.now(), kind, text });
  state.events = state.events.slice(0, 60); // bounded
  renderEvents();
}

function renderEvents() {
  els.events.querySelectorAll("li:not(#event-empty)").forEach((li) => li.remove());
  const palette = {
    attack: "text-amber-300",
    stop: "text-slate-400",
    mitigation: "text-emerald-300",
    ban: "text-rose-300",
  };
  for (const e of state.events) {
    const li = document.createElement("li");
    li.className = "px-4 py-1.5 text-xs break-words flex gap-2";
    const time = document.createElement("span");
    time.className = "mono shrink-0 text-slate-600";
    time.textContent = new Date(e.at).toLocaleTimeString();
    const body = document.createElement("span");
    body.className = palette[e.kind] || "text-slate-300";
    body.textContent = e.text;
    li.append(time, body);
    els.events.appendChild(li);
  }
  els.eventsEmpty.style.display = state.events.length ? "none" : "";
}

function handleAttackWindowChange() {
  // called after attack state flips; maintain shading + events
  threatMap.setAttackActive(state.attackActive); // fan bots out / collapse them
  if (state.attackActive) {
    state.attackWindows.push({ startAt: Date.now(), endAt: null });
    const p = panel.getParams();
    pushEvent("attack", `attack launched @ ${p.rps} rps · ${p.duration}s`);
  } else {
    const open = state.attackWindows[state.attackWindows.length - 1];
    if (open && open.endAt == null) open.endAt = Date.now();
    render(); // close shading immediately
  }
}

// ---- metrics ----
function updateMetrics(f) {
  els.conns.textContent = String(Math.round(f.connections_per_sec ?? 0));
  els.cpu.textContent = `${Math.round(f.cpu_load_pct ?? 0)}%`;
  els.blocked.textContent = String(f.blocked_rps ?? 0);
  // cumulative blocked traffic estimate (rps * 0.5s tick)
  const nowBlocked = f.blocked_rps ?? 0;
  if (nowBlocked > 0) {
    state.totalBlocked += nowBlocked * (WS_TICK_MS / 1000);
    els.totalBlocked.textContent = Math.round(state.totalBlocked);
  }
}

function renderHealth(health) {
  els.droppedFrames.textContent = health?.dropped_frames ?? "—";
  els.uptime.textContent = health ? `${Math.round(health.uptime_s)}s` : "—";
}

// ---- threat-map instrument strip (t14) ----
function hexColor(n) {
  return `#${n.toString(16).padStart(6, "0")}`;
}

// verdict banner + sparklines + rolling counters + bot tiles; runs once per WS
// tick so the strip always matches the frame that just arrived
function renderThreatStrip(frame) {
  const lvl = threatLevel(frame.blocked_rps ?? 0, state.config.rateLimitMaxRps);
  const color = hexColor(lvl.color);
  els.bannerLabel.textContent = lvl.label;
  els.bannerDetail.textContent = lvl.detail;
  els.bannerDot.style.background = color;
  els.bannerDot.style.boxShadow = `0 0 10px ${color}`;

  state.sparkAttack.push(frame.attack_rps ?? 0);
  state.sparkBlocked.push(frame.blocked_rps ?? 0);
  if (state.sparkAttack.length > SPARK_CAP) state.sparkAttack.shift();
  if (state.sparkBlocked.length > SPARK_CAP) state.sparkBlocked.shift();
  drawSparkline(els.sparkAttack.getContext("2d"), state.sparkAttack, {
    width: els.sparkAttack.width,
    height: els.sparkAttack.height,
    color: "#f59e0b",
    stroke: 1.5,
  });
  drawSparkline(els.sparkBlocked.getContext("2d"), state.sparkBlocked, {
    width: els.sparkBlocked.width,
    height: els.sparkBlocked.height,
    color: "#fb7185",
    stroke: 1.5,
  });

  const stats = statsFromFrames(timeline.frames());
  els.counterAllowed.textContent = String(stats.allowed).padStart(4, "0");
  els.counterBlocked.textContent = String(stats.blocked).padStart(4, "0");
  syncBotStrip();
}

// one tile per bot: counts the recent window, lights up under block pressure,
// and follows the canvas highlight (and vice-versa) so hover never disconnects
function syncBotStrip() {
  const n = state.bots;
  while (els.botStrip.children.length > n) els.botStrip.removeChild(els.botStrip.lastChild);
  while (els.botStrip.children.length < n) {
    const i = els.botStrip.children.length;
    const tile = document.createElement("span");
    Object.assign(tile.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      height: "24px",
      minWidth: "22px",
      padding: "0 4px",
      borderRadius: "4px",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: "10px",
    });
    tile.addEventListener("mouseenter", () => {
      state.hoverBot = i;
      threatMap.highlightBot(i);
      syncBotStrip();
    });
    tile.addEventListener("mouseleave", () => {
      state.hoverBot = null;
      threatMap.highlightBot(null);
      syncBotStrip();
    });
    tile.addEventListener("click", () => {
      pinnedBot = i;
      inspector.preview(i);
    });
    els.botStrip.appendChild(tile);
  }
  const stats = statsFromFrames(timeline.frames());
  for (let i = 0; i < n; i++) {
    const tile = els.botStrip.children[i];
    const e = stats.byBot.get(i + 1) || { sent: 0, blocked: 0 };
    tile.textContent = `${i + 1}`;
    tile.title = `10.0.0.${i + 1} · ${e.sent} sent · ${e.blocked} blocked`;
    if (i === state.hoverBot) {
      tile.style.background = "rgba(100,116,139,0.6)";
      tile.style.color = "#ffffff";
    } else if (e.blocked > 0) {
      tile.style.background = "rgba(136,19,55,0.6)";
      tile.style.color = "#fda4af";
    } else {
      tile.style.background = "#1e293b";
      tile.style.color = "#94a3b8";
    }
  }
}

// ---- websocket ----
function wsUrl() {
  const base = window.__API_BASE__ || "";
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const host = base || location.host;
  return `${proto}//${host}/api/ws/telemetry`;
}

function scheduleReconnect() {
  setTimeout(connect, state.backoff);
  state.backoff = Math.min(state.backoff * 2, MAX_RECONNECT_BACKOFF);
  setStatus("connecting", "reconnecting…");
}

function connect() {
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;
  const ws = new WebSocket(wsUrl());
  state.ws = ws;

  ws.onopen = () => {
    state.backoff = 500;
    threatMap.setConnected(true); // resume the radar sweep
    setStatus("connecting", "syncing…");
    seedFromRest();
    refreshConfigAndHealth();
    syncControlState();
  };

  ws.onmessage = (ev) => {
    let frame = null;
    try {
      frame = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!frame) return; // engine silent
    state.lastMessageAt = Date.now(); // only real frames prove liveness
    if (!state.series) {
      state.series = seedSeries([{ timestamp: frame.ts, metrics: frame }]);
      state.chart.setOption(buildChartOptions()); // structural options once
      if (!state.sparkConns) { initSparkCharts(); }
      state.seedRendered = true;
    }
    ingestFrame(frame, state.series);
    timeline.setAlgorithm(state.algorithm);
    timeline.ingest(frame);
    threatMap.setBlockedRate(frame.blocked_rps ?? 0); // shield intensity
    renderThreatStrip(frame); // banner / sparklines / counters / bot tiles
    inspector.setFrame(frame); // live per-VIP stats for the inspector card
    render();
    renderLogWith(frame.blocks || []);
    updateMetrics(frame);
    updateFreshness();
    setStatus("live", "engine live");
  };

  ws.onclose = () => {
    threatMap.setConnected(false); // radar sweep must not fake a scan offline
    setStatus("down", "sim went dark — reconnecting");
    scheduleReconnect();
  };
  ws.onerror = () => ws.close();
}

// ---- REST seeding: config, latest telemetry, health ----
async function seedFromRest() {
  const base = window.__API_BASE__ || location.host;
  try {
    const res = await fetch(`http://${base}/api/telemetry/latest`);
    if (!res.ok) return;
    const body = await res.json();
    const hist = body.history || [];
    if (hist.length && !state.seedRendered) {
      state.series = seedSeries(hist);
      state.chart.setOption(buildChartOptions());
      if (!state.sparkConns) initSparkCharts();
      state.seedRendered = true;
      render();
    }
  } catch {
    // live ws frames will fill the chart anyway
  }
  renderHealth(await fetchHealth(base));
}

async function fetchHealth(base) {
  try {
    const res = await fetch(`http://${base}/api/health`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function refreshConfigAndHealth() {
  const base = window.__API_BASE__ || location.host;
  try {
    const res = await fetch(`http://${base}/api/config`);
    if (res.ok) {
      const cfg = await res.json();
      state.config.rateLimitMaxRps = cfg.rate_limit_max_rps ?? 20;
      state.config.rateLimitBlockSeconds = cfg.rate_limit_block_seconds ?? 10;
      timeline.rateLimitMaxRps = state.config.rateLimitMaxRps; // keep explain() strings honest
      // rebuild the threshold line around the real config value
      const opts = buildChartOptions();
      opts.series = []; // don't clobber accumulated data; markLine rides on yAxis
      state.chart.setOption({ yAxis: opts.yAxis });
    }
  } catch {
    // defaults are fine; config sets threshold on next chart init
  }
}

// ---- control socket (Ticket 7) ----
function apiBase() {
  return window.__API_BASE__ || location.host;
}

async function resolveApiBase() {
  if (window.__API_BASE__) return;
  try {
    const host = location.host || "localhost:8000";
    const res = await fetch(`http://${host}/api/control/status`);
    if (res.ok) return;
  } catch { /* fall through to :8000 */ }
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
  return data?.reply || data?.detail?.reply || "no reply";
}

async function syncControlState() {
  let status = null;
  try {
    const { status: code, data } = await controlRequest("GET", "/api/control/status");
    status = code === 200 ? data : null;
  } catch { /* engine dark */ }
  const wasRunning = state.attackActive;
  const wasMitigation = state.mitigationOn;
  if (!status) {
    state.engineReachable = false;
    state.attackActive = false;
  } else {
    state.engineReachable = status.engine_reachable ?? true;
    state.attackActive = Boolean(status.attack_running);
    state.mitigationOn = Boolean(status.mitigation_on);
    state.algorithm = status.algorithm === "sliding_window" ? "sliding_window" : "token_bucket";
  }
  threatMap.setMitigation(state.mitigationOn); // shield ring follows the engine
  if (state.attackActive !== wasRunning) handleAttackWindowChange();
  if (state.mitigationOn !== wasMitigation) {
    pushEvent("mitigation", `rate-limit mitigation → ${state.mitigationOn ? "on" : "off"}`);
  }
  // reflect the engine's live algorithm / baseline onto the sidebar
  if (status) panel.setStatus(status);
  updateControlUi();
}

function updateControlUi() {
  const down = !state.engineReachable;
  els.attackBtn.disabled = down || state.attackActive;
  els.stopBtn.disabled = down || !state.attackActive;
  els.mitigationBtn.disabled = down;
  els.sidebarEmergency.disabled = down;
  els.sidebarBaseline.disabled = down;
  els.sidebarAlgorithm.disabled = down;
  els.sidebarBots.disabled = down;
  els.vipBan.disabled = down;
  els.vipUnban.disabled = down;

  if (state.mitigationOn) {
    els.mitigationBtn.textContent = "Mitigation: On";
    els.mitigationBtn.className = "btn-focus mono rounded-md border border-emerald-700/60 bg-emerald-950/40 px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-emerald-300 transition-colors hover:border-emerald-500 disabled:cursor-not-allowed disabled:opacity-40";
  } else {
    els.mitigationBtn.textContent = "Mitigation: Off";
    els.mitigationBtn.className = "btn-focus mono rounded-md border border-amber-700/60 bg-amber-950/40 px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-amber-300 transition-colors hover:border-amber-500 disabled:cursor-not-allowed disabled:opacity-40";
  }
}

function handleAttack(payload) {
  const now = Date.now();
  if (now - state.lastAttackAt < 5000) return; // debounce on top of backend cooldown
  state.lastAttackAt = now;
  toast("launching attack…");
  controlRequest("POST", "/api/control/attack", payload).then(({ status, data }) => {
    if (status === 200 && data?.ok) {
      state.attackActive = true;
      handleAttackWindowChange();
      toast("attack started");
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
    handleAttackWindowChange();
  } catch {
    state.engineReachable = false;
    toast("engine offline — start ddos_server");
    state.attackActive = false;
  }
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

async function handleBaseline({ enabled, bots }) {
  toast(`baseline → ${enabled ? "on" : "off"}…`);
  try {
    const { status, data } = await controlRequest("POST", "/api/control/baseline", { enabled, bots });
    if (status === 503) {
      state.engineReachable = false;
      els.sidebarBaseline.checked = !enabled; // revert the flip
    } else {
      toast(replyText(data) || (enabled ? "baseline started" : "baseline stopped"));
      pushEvent("attack", `baseline traffic ${enabled ? "on" : "off"} (${bots} bots)`);
    }
  } catch {
    state.engineReachable = false;
    els.sidebarBaseline.checked = !enabled;
    toast("engine offline — start ddos_server");
  }
  syncControlState();
}

async function handleAlgorithm(alg) {
  toast(`algorithm → ${alg}…`);
  try {
    const { status, data } = await controlRequest("POST", "/api/control/algorithm", { algorithm: alg });
    if (status === 503) {
      state.engineReachable = false;
      syncControlState(); // will reset the selector to the engine truth
    } else {
      toast(replyText(data) || `algorithm set to ${alg}`);
      pushEvent("mitigation", `rate-limit algorithm → ${alg}`);
    }
  } catch {
    state.engineReachable = false;
    toast("engine offline — start ddos_server");
  }
  syncControlState();
}

async function handleEmergency() {
  toast("emergency stop — killing attack & baseline…");
  try {
    const { status, data } = await controlRequest("POST", "/api/control/emergency-stop");
    if (status === 503) {
      state.engineReachable = false;
      toast("engine offline — start ddos_server");
    } else {
      toast(replyText(data) || "emergency stop issued");
      pushEvent("stop", "emergency stop — attack & baseline halted");
    }
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
    if (status === 200 && actionStr === "ban") pushEvent("ban", `manual ban issued for ${vip}`);
    if (status === 200 && actionStr === "unban") pushEvent("mitigation", `manual unban for ${vip}`);
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

// ---- sparkline init ----
function initSparkCharts() {
  state.sparkConns = echarts.init(els.sparkConns);
  state.sparkCpu = echarts.init(els.sparkCpu);
  state.sparkConns.setOption(sparkOptions("#64748b"));
  state.sparkCpu.setOption(sparkOptions("#7c8aa0"));
}

// ---- boot ----
state.chart = echarts.init(els.chart);
state.chart.setOption(buildChartOptions()); // structural options up-front
renderLogWith([]);
renderEvents();

// admin sidebar (Ticket 8): actions hand back into dashboard's network layer
const panel = initAdminPanel({
  rps: els.sidebarRps,
  rpsVal: els.sidebarRpsVal,
  bots: els.sidebarBots,
  botsVal: els.sidebarBotsVal,
  duration: els.sidebarDuration,
  baseline: els.sidebarBaseline,
  algorithm: els.sidebarAlgorithm,
  emergency: els.sidebarEmergency,
  launch: els.attackBtn,
  stop: els.stopBtn,
  mitigation: els.mitigationBtn,
}, {
  launch: (payload) => handleAttack(payload),
  stop: () => handleStop(),
  mitigation: () => handleMitigation(),
  baseline: (b) => handleBaseline(b),
  algorithm: (alg) => handleAlgorithm(alg),
  emergency: () => handleEmergency(),
  paramsChange: (params) => {
    state.bots = Number(params.bots) || 8;
    threatMap.setBotCount(state.bots);
    syncBotStrip();
  },
});

// timeline buffer (Ticket 11): captures per-packet decisions for t12/t13
const timeline = new TimelineBuffer({ rateLimitMaxRps: state.config?.rateLimitMaxRps ?? 2 });

// threat map (Ticket 12): PixiJS WebGL when available, else the t10 canvas 2d
// reduceMotion drops effects (streaks, shield spin, pulses) but keeps live data
const threatMap = initThreatRenderer({
  canvas: $("threat-map-canvas"),
  timeline,
  gsap: window.gsap || null,
  reduceMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  rateLimitMaxRps: state.config.rateLimitMaxRps,
});
// hover sync between the canvas bots and the strip tiles
threatMap.onBotHover((i, on) => {
  state.hoverBot = on ? i : null;
  threatMap.highlightBot(state.hoverBot);
  syncBotStrip();
  if (on) inspector.preview(i);
  else if (pinnedBot != null) inspector.preview(pinnedBot);
  else inspector.close();
});
// clicking a bot pins the inspector open; clicking it again unpins
threatMap.onBotClick((i) => {
  pinnedBot = pinnedBot === i ? null : i;
  if (pinnedBot == null) inspector.close();
  else inspector.preview(i);
});
syncBotStrip(); // seed the strip tiles before the first ws frame

// t13 scrubber + inspector over the t12 renderer facade
const scrubber = initScrubber({
  els,
  timeline,
  threatMap,
  gsap: window.gsap || null,
  reduceMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
});
const inspector = initNodeInspector({ els, timeline, threatMap });
// ✕ also releases the pin so hover-out can't reopen the card
els.inspectorClose.addEventListener("click", () => { pinnedBot = null; });

// tab shell: only the visible tab repaints; going back to the command center
// needs an explicit resize because echarts measured the panel while hidden
initTabs(document);
document.addEventListener("tabchange", (e) => {
  state.activeTab = e.detail.tab;
  threatMap.setVisible(state.activeTab === "threat-map"); // only visible tab paints (Ticket 9)
  scrubber.setVisible(state.activeTab === "threat-map");
  if (state.activeTab === "command-center") {
    state.chart && state.chart.resize();
    state.sparkConns && state.sparkConns.resize();
    state.sparkCpu && state.sparkCpu.resize();
    render(); // repaint immediately after becoming visible
  }
  if (state.activeTab === "threat-map") {
    threatMap.resize(); // canvas measured while the panel was hidden
  }
});
state.activeTab = "command-center";

async function init() {
  await resolveApiBase();
  connect();
  updateControlUi();
  syncControlState();
  els.vipBan.addEventListener("click", () => handleVip("ban"));
  els.vipUnban.addEventListener("click", () => handleVip("unban"));
  els.vipInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleVip("ban");
  });
  setInterval(updateFreshness, 500); // gauge ticks even between frames
  setInterval(() => { if (state.lastMessageAt) renderLogWith(lastBlocks); }, 1000); // countdowns tick every second
  startFrameLoop(); // glide the chart window at 60fps
}
init();

// keep charts sized if the window resizes
window.addEventListener("resize", () => {
  state.chart && state.chart.resize();
  state.sparkConns && state.sparkConns.resize();
  state.sparkCpu && state.sparkCpu.resize();
  threatMap.resize();
});