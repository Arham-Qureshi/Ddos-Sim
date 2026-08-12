import { RingBuffer, seedSeries, ingestFrame } from "./telemetry.js";

const STALE_MS = 2500; // mirror backend stale_threshold_s
const WS_TICK_MS = 500; // server pushes every 0.5s
const MAX_ATTACK_DELAY_BACKOFF = 8000;

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
  const seriesData = (buf) => buf.toArray().map((p) => [p.ts * 1000, p.value]);
  opts.series.forEach((s, i) => {
    s.data = seriesData(state.series[s.key]);
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
    clock.textContent = b.unblock_ts ?? "—";
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

// ---- launch attack stub (Ticket 7 wires real IPC here) ----
function handleAttack() {
  const now = Date.now();
  if (now - state.lastAttackAt < 5000) return; // 5s debounce
  state.lastAttackAt = now;
  els.attackBtn.disabled = true;
  toast("attack signaled — engine IPC lands in Ticket 7");
  setTimeout(() => {
    els.attackBtn.disabled = false;
  }, 5000);
}

// ---- boot ----
if (state.chart) {
  throw new Error("bootstrap ran twice");
}
state.chart = echarts.init(els.chart);
render();
renderLogWith([]);
connect();
els.attackBtn.addEventListener("click", handleAttack);

// keep chart sized if the window resizes
window.addEventListener("resize", () => state.chart && state.chart.resize());