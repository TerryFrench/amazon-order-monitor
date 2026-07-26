// Finding and reloading the user-kept-open orders tab.
// Decision (settled with the user): the extension never opens tabs on its
// own schedule — the user keeps an orders tab open; if it's missing we nag
// (rate-limited, snoozable) via notifier.maybeNag().

import { ORDER_TAB_PATTERNS } from "./constants.js";

// Works without the "tabs" permission thanks to amazon host permissions
// (spike experiment B). Prefer the active tab if several match, else the
// oldest (lowest id) for stability.
export async function findOrdersTab() {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: ORDER_TAB_PATTERNS });
  } catch (e) {
    return null;
  }
  if (!tabs || tabs.length === 0) return null;
  const active = tabs.find((t) => t.active);
  if (active) return active;
  return tabs.reduce((a, b) => (a.id <= b.id ? a : b));
}

// Reload the tab so the content script re-scrapes fresh HTML. Reload also
// revives a Memory-Saver-discarded or frozen tab. autoDiscardable=false
// reduces the chance of discard between checks (best effort).
export async function beginReload(tabId) {
  try {
    await chrome.tabs.update(tabId, { autoDiscardable: false });
  } catch (e) {
    // Non-fatal; reload is what matters.
  }
  await chrome.tabs.reload(tabId);
}

// Focus the existing orders tab, or open a new one (explicit user action
// from the popup / nag button only).
export async function openOrdersTab(ordersUrl) {
  const tab = await findOrdersTab();
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    try {
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch (e) {
      // window may be gone; fall through
    }
    return tab;
  }
  return chrome.tabs.create({ url: ordersUrl, active: true });
}
