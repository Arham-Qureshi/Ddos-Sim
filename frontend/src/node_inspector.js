// node_inspector.js — floating per-bot detail card for the t13 threat map.
// Reads the engine vip_stats snapshot (with a derived fallback) plus the real
// block list; it never fabricates a BLOCKED status. Anchors near the bot on the
// canvas (top-right fallback when the renderer can't report a position). Hover
// previews, ✕ (or close()) dismisses.

import { clamp } from "./topology.js";
import { statsFromFrames } from "./threat_stats.js";

export function initNodeInspector({ els, timeline, threatMap } = {}) {
  let frame = null; // latest ws frame (carries vip_stats + blocks)
  let openIdx = null;

  function vipFor(i) {
    return `10.0.0.${i + 1}`;
  }

  function render(i) {
    if (!frame) return;
    openIdx = i;
    const vip = vipFor(i);
    const stat = (frame.vip_stats || []).find((s) => s.vip === vip);
    const derived = statsFromFrames(timeline.frames()).byBot.get(i + 1) || { sent: 0, blocked: 0 };
    const blocked = (frame.blocks || []).some((b) => b.vip === vip);

    els.inspectorVip.textContent = vip;
    els.inspectorWorker.textContent = stat && stat.worker_id != null ? `worker #${stat.worker_id}` : "—";
    els.inspectorRps.textContent = stat ? String(stat.active_rps) : "—";
    els.inspectorSent.textContent = stat ? String(stat.sent) : String(derived.sent);
    els.inspectorBlocked.textContent = stat ? String(stat.blocked) : String(derived.blocked);
    const chip = els.inspectorStatus;
    if (blocked) {
      chip.textContent = "BLOCKED";
      chip.className = "mono rounded bg-rose-900/40 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-rose-300";
    } else {
      chip.textContent = "OK";
      chip.className = "mono rounded bg-emerald-900/40 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-emerald-300";
    }
    els.inspectorCard.classList.remove("hidden");
    anchor(i);
  }

  // place the card next to the bot, clamped inside the canvas wrapper
  function anchor(i) {
    const pos = threatMap && threatMap.botScreenPos ? threatMap.botScreenPos(i) : null;
    const parent = els.inspectorCard.parentElement;
    const w = (parent && parent.clientWidth) || 640;
    const h = (parent && parent.clientHeight) || 340;
    if (pos) {
      els.inspectorCard.style.left = `${clamp(pos.x + 16, 8, Math.max(8, w - 224))}px`;
      els.inspectorCard.style.top = `${clamp(pos.y - 8, 8, Math.max(8, h - 60))}px`;
      els.inspectorCard.style.right = "auto";
    } else {
      els.inspectorCard.style.left = "auto";
      els.inspectorCard.style.right = "12px";
      els.inspectorCard.style.top = "12px";
    }
  }

  // refresh a pinned card when a new ws frame arrives
  function setFrame(f) {
    frame = f;
    if (openIdx != null) render(openIdx);
  }

  function preview(i) {
    render(i);
  }

  function close() {
    openIdx = null;
    els.inspectorCard.classList.add("hidden");
  }

  els.inspectorClose.addEventListener("click", close);

  return {
    setFrame,
    preview,
    close,
    isOpen: () => openIdx != null,
  };
}
