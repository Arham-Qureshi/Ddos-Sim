import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  clamp,
  buildAttackPayload,
  baselineCmd,
  algorithmCmd,
  initAdminPanel,
  RPS_MAX,
  BOTS_MAX,
  DURATION_MAX,
} from "./admin_panel.js";

describe("clamp", () => {
  it("caps above max and floors below min", () => {
    expect(clamp(250, 10, 200)).toBe(200);
    expect(clamp(2, 10, 200)).toBe(10);
    expect(clamp(50, 10, 200)).toBe(50);
  });
});

describe("buildAttackPayload", () => {
  it("maps sidebar values to the attack request", () => {
    expect(buildAttackPayload({ rps: 200, bots: 8, duration: 10 }))
      .toEqual({ rps: 200, threads: 8, duration: 10 });
  });

  it("clamps the client-side caps (200 rps / 32 bots / 60s)", () => {
    expect(buildAttackPayload({ rps: 999, bots: 99, duration: 999 }))
      .toEqual({ rps: RPS_MAX, threads: BOTS_MAX, duration: DURATION_MAX });
  });

  it("floors below the sidebar minimums", () => {
    expect(buildAttackPayload({ rps: 1, bots: 0, duration: 1 }))
      .toEqual({ rps: 10, threads: 1, duration: 5 });
  });
});

describe("baselineCmd", () => {
  it("emits off for disabled", () => {
    expect(baselineCmd({ enabled: false, bots: 8 })).toBe("CMD_SET_BASELINE off");
  });

  it("emits on with the bot count", () => {
    expect(baselineCmd({ enabled: true, bots: 6 })).toBe("CMD_SET_BASELINE on 6");
  });

  it("clamps the bot count to the sidebar range", () => {
    expect(baselineCmd({ enabled: true, bots: 99 })).toBe(`CMD_SET_BASELINE on ${BOTS_MAX}`);
  });
});

describe("algorithmCmd", () => {
  it("maps both supported algorithms", () => {
    expect(algorithmCmd("token_bucket")).toBe("CMD_SET_ALGORITHM token_bucket");
    expect(algorithmCmd("sliding_window")).toBe("CMD_SET_ALGORITHM sliding_window");
  });

  it("refuses anything else", () => {
    expect(() => algorithmCmd("leap_year")).toThrow();
  });
});

function mount() {
  document.body.innerHTML = `
    <input id="attack-rps" type="range" min="10" max="200" value="200" />
    <span id="attack-rps-val"></span>
    <input id="bot-count" type="range" min="1" max="32" value="8" />
    <span id="bot-count-val"></span>
    <input id="attack-duration" type="number" min="5" max="60" value="10" />
    <input id="baseline-toggle" type="checkbox" />
    <select id="algorithm-select">
      <option value="token_bucket">Token Bucket</option>
      <option value="sliding_window">Sliding Window</option>
    </select>
    <button id="emergency-stop"></button>
    <button id="launch-attack"></button>
    <button id="stop-attack"></button>
    <button id="mitigation-toggle"></button>
  `;
  const byId = (id) => document.getElementById(id);
  return {
    els: {
      rps: byId("attack-rps"),
      rpsVal: byId("attack-rps-val"),
      bots: byId("bot-count"),
      botsVal: byId("bot-count-val"),
      duration: byId("attack-duration"),
      baseline: byId("baseline-toggle"),
      algorithm: byId("algorithm-select"),
      emergency: byId("emergency-stop"),
      launch: byId("launch-attack"),
      stop: byId("stop-attack"),
      mitigation: byId("mitigation-toggle"),
    },
    actions: {
      launch: vi.fn(),
      stop: vi.fn(),
      mitigation: vi.fn(),
      baseline: vi.fn(),
      algorithm: vi.fn(),
      emergency: vi.fn(),
    },
  };
}

describe("initAdminPanel", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("launch dispatches the clamped payload", () => {
    const { els, actions } = mount();
    initAdminPanel(els, actions);
    els.launch.click();
    expect(actions.launch).toHaveBeenCalledWith(
      { rps: 200, threads: 8, duration: 10 });
  });

  it("baseline toggle dispatches baseline action", () => {
    const { els, actions } = mount();
    initAdminPanel(els, actions);
    els.baseline.checked = true;
    els.baseline.dispatchEvent(new Event("change"));
    expect(actions.baseline).toHaveBeenCalledWith({ enabled: true, bots: 8 });
  });

  it("algorithm change dispatches the chosen value", () => {
    const { els, actions } = mount();
    initAdminPanel(els, actions);
    els.algorithm.value = "sliding_window";
    els.algorithm.dispatchEvent(new Event("change"));
    expect(actions.algorithm).toHaveBeenCalledWith("sliding_window");
  });

  it("emergency stop dispatches emergency action", () => {
    const { els, actions } = mount();
    initAdminPanel(els, actions);
    els.emergency.click();
    expect(actions.emergency).toHaveBeenCalled();
  });

  it("setStatus syncs baseline + algorithm back onto the panel", () => {
    const { els, actions } = mount();
    const panel = initAdminPanel(els, actions);
    panel.setStatus({ baseline_running: true, baseline_bots: 12, algorithm: "sliding_window" });
    expect(els.baseline.checked).toBe(true);
    expect(els.algorithm.value).toBe("sliding_window");
    expect(els.bots.value).toBe("12");
    expect(els.botsVal.textContent).toBe("12");
  });

  it("slider input invokes the paramsChange action with updated params", () => {
    const { els, actions } = mount();
    actions.paramsChange = vi.fn();
    initAdminPanel(els, actions);
    els.bots.value = "12";
    els.bots.dispatchEvent(new Event("input"));
    expect(actions.paramsChange).toHaveBeenCalledWith(expect.objectContaining({ bots: 12 }));
  });
});
