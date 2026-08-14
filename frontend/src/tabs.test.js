import { describe, it, expect, beforeEach } from "vitest";
import { initTabs } from "../src/tabs.js";

function mount() {
  document.body.innerHTML = `
    <div id="bar">
      <button data-tab="threat-map" aria-selected="false">Threat Map</button>
      <button data-tab="command-center" aria-selected="true">Command Center</button>
    </div>
    <section data-tab-panel="threat-map" class="hidden"></section>
    <section data-tab-panel="command-center"></section>
  `;
  return initTabs(document);
}

describe("initTabs", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("toggles panels with the hidden class", () => {
    const { buttons } = mount();
    buttons[0].click();
    expect(document.querySelector('[data-tab-panel="threat-map"]').classList.contains("hidden")).toBe(false);
    expect(document.querySelector('[data-tab-panel="command-center"]').classList.contains("hidden")).toBe(true);
  });

  it("moves the active class and aria-selected to the clicked tab", () => {
    const { buttons } = mount();
    buttons[0].click();
    expect(buttons[0].classList.contains("active")).toBe(true);
    expect(buttons[0].getAttribute("aria-selected")).toBe("true");
    expect(buttons[1].classList.contains("active")).toBe(false);
    expect(buttons[1].getAttribute("aria-selected")).toBe("false");
  });

  it("dispatches a tabchange event carrying the tab name", () => {
    const { buttons } = mount();
    let seen = null;
    document.addEventListener("tabchange", (e) => { seen = e.detail.tab; });
    buttons[0].click();
    expect(seen).toBe("threat-map");
  });

  it("activate(name) switches programmatically", () => {
    const { activate, buttons } = mount();
    activate("command-center");
    expect(buttons[1].classList.contains("active")).toBe(true);
    expect(document.querySelector('[data-tab-panel="command-center"]').classList.contains("hidden")).toBe(false);
  });
});
