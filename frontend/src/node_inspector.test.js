import { describe, it, expect, beforeEach } from "vitest";
import { initNodeInspector } from "./node_inspector.js";

function makeEls() {
  const wrapper = document.createElement("div");
  wrapper.style.width = "640px";
  wrapper.style.height = "340px";
  const card = document.createElement("div");
  card.className = "hidden";
  wrapper.appendChild(card);
  const value = (id) => {
    const el = document.createElement("dd");
    el.id = id;
    return el;
  };
  return {
    inspectorCard: card,
    inspectorClose: document.createElement("button"),
    inspectorVip: value("inspector-vip"),
    inspectorWorker: value("inspector-worker"),
    inspectorRps: value("inspector-rps"),
    inspectorSent: value("inspector-sent"),
    inspectorBlocked: value("inspector-blocked"),
    inspectorStatus: document.createElement("span"),
  };
}

function makeTimeline(frames) {
  return { frames: () => frames };
}

const engineFrame = {
  vip_stats: [
    { vip: "10.0.0.3", active_rps: 9, sent: 40, blocked: 3, worker_id: 1 },
  ],
  blocks: [{ vip: "10.0.0.3" }, { vip: "10.0.0.7" }],
};

describe("initNodeInspector", () => {
  let els;
  beforeEach(() => {
    els = makeEls();
  });

  function boot(frame = engineFrame, map = {}) {
    const inspector = initNodeInspector({
      els,
      timeline: makeTimeline([{ activePackets: [] }]),
      threatMap: map,
    });
    inspector.setFrame(frame);
    return inspector;
  }

  it("shows engine stats for the pinned bot", () => {
    boot().preview(2); // 10.0.0.3
    expect(els.inspectorCard.classList.contains("hidden")).toBe(false);
    expect(els.inspectorVip.textContent).toBe("10.0.0.3");
    expect(els.inspectorWorker.textContent).toBe("worker #1");
    expect(els.inspectorRps.textContent).toBe("9");
    expect(els.inspectorSent.textContent).toBe("40");
    expect(els.inspectorBlocked.textContent).toBe("3");
    expect(els.inspectorStatus.textContent).toBe("BLOCKED");
  });

  it("marks a clean bot OK", () => {
    boot().preview(0); // 10.0.0.1 not in blocks
    expect(els.inspectorStatus.textContent).toBe("OK");
  });

  it("falls back to derived counts when the engine snapshot is absent", () => {
    const inspector = initNodeInspector({
      els,
      timeline: makeTimeline([{
        activePackets: [
          { botId: 1, status: "ALLOWED" },
          { botId: 1, status: "DROPPED" },
        ],
      }]),
      threatMap: {},
    });
    inspector.setFrame({ vip_stats: [], blocks: [] });
    inspector.preview(0); // 10.0.0.1
    expect(els.inspectorRps.textContent).toBe("—");
    expect(els.inspectorWorker.textContent).toBe("—");
    expect(els.inspectorSent.textContent).toBe("2"); // both packets from bot 1
    expect(els.inspectorBlocked.textContent).toBe("1");
  });

  it("anchors near the bot when the renderer exposes its position", () => {
    boot(engineFrame, { botScreenPos: () => ({ x: 200, y: 100 }) }).preview(2);
    expect(els.inspectorCard.style.left).toBe("216px"); // x + 16
    expect(els.inspectorCard.style.right).toBe("auto");
  });

  it("falls back to the top-right anchor without a position", () => {
    boot(engineFrame, { botScreenPos: () => null }).preview(2);
    expect(els.inspectorCard.style.right).toBe("12px");
    expect(els.inspectorCard.style.left).toBe("auto");
  });

  it("hides with no data", () => {
    const inspector = initNodeInspector({ els, timeline: makeTimeline([]), threatMap: {} });
    inspector.preview(0);
    expect(els.inspectorCard.classList.contains("hidden")).toBe(true);
  });

  it("close hides the card", () => {
    const inspector = boot();
    inspector.preview(2);
    expect(inspector.isOpen()).toBe(true);
    els.inspectorClose.dispatchEvent(new Event("click"));
    expect(inspector.isOpen()).toBe(false);
    expect(els.inspectorCard.classList.contains("hidden")).toBe(true);
  });
});
