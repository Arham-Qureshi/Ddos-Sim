// tabs.js — tiny tab switcher. one [data-tab] button per [data-tab-panel]
// section; toggles .hidden / .active and fires a tabchange CustomEvent so
// chart owners can resize/gate work without coupling to the DOM structure.
const TAB_SELECTOR = "[data-tab]";
const PANEL_SELECTOR = "[data-tab-panel]";

export function initTabs(container = document) {
  const buttons = [...container.querySelectorAll(TAB_SELECTOR)];
  const panels = [...container.querySelectorAll(PANEL_SELECTOR)];

  function activate(name) {
    buttons.forEach((btn) => {
      const on = btn.dataset.tab === name;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", String(on));
    });
    panels.forEach((panel) => {
      panel.classList.toggle("hidden", panel.dataset.tabPanel !== name);
    });
    container.dispatchEvent(new CustomEvent("tabchange", { detail: { tab: name } }));
  }

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => activate(btn.dataset.tab));
  });

  return { activate, buttons, panels };
}
