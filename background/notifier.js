// Desktop notifications + click/button routing. One notification per check
// cycle; click targets are persisted in meta.notifTargets so routing works
// in a freshly-woken service worker.

import { NOTIF, LIMITS } from "./constants.js";
import * as store from "./store.js";
import * as scheduler from "./scheduler.js";

// Must be absolute: a relative iconUrl resolves against the service
// worker's own directory (background/), 404s, and makes notifications.create
// reject — which is how a bad icon path once silently killed an email send.
const ICON = chrome.runtime.getURL("icons/aom128.png");

const CATEGORY_LABELS = {
  arriving: "On the way",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  delayed: "Delayed",
  canceled: "Canceled",
  returned: "Returned",
  unknown: "Updated"
};

export function changeLabel(change) {
  switch (change.kind) {
    case "new_order":
      return "New order";
    case "status_changed":
      return CATEGORY_LABELS[change.order.statusCategory] || "Updated";
    case "arrival_date_changed":
      return change.delayDays > 0
        ? `Delayed by ${change.delayDays} day${change.delayDays === 1 ? "" : "s"}`
        : "Arriving earlier";
    case "minor_text_changed":
      return "Status text updated";
    default:
      return "Updated";
  }
}

function firstItem(order) {
  const item = (order.items && order.items[0]) || "(items unknown)";
  return item.length > 60 ? item.slice(0, 57) + "…" : item;
}

async function rememberTarget(notifId, url) {
  await store.patch((s) => {
    s.meta.notifTargets[notifId] = url;
    const ids = Object.keys(s.meta.notifTargets);
    if (ids.length > LIMITS.NOTIF_TARGETS_MAX) {
      for (const id of ids.slice(0, ids.length - LIMITS.NOTIF_TARGETS_MAX)) {
        delete s.meta.notifTargets[id];
      }
    }
  });
}

// ---- change notifications -----------------------------------------

export async function notifyChanges(changes, cfg, checkId) {
  if (!cfg.notificationsEnabled) return;
  const visible = changes.filter(
    (c) => c.kind !== "minor_text_changed" || cfg.notifyMinorChanges
  );
  if (visible.length === 0) return;

  const notifId = NOTIF.CHANGES_PREFIX + checkId;
  let title;
  let message;
  let targetUrl;

  if (visible.length === 1) {
    const c = visible[0];
    title = `${changeLabel(c)} — ${firstItem(c.order)}`;
    message = c.order.totalRaw
      ? `${c.order.statusRaw || ""} · ${c.order.totalRaw}`.replace(/^ · /, "")
      : c.order.statusRaw || "";
    targetUrl = c.order.detailsUrl || cfg.ordersUrl;
  } else {
    title = `${visible.length} Amazon order updates`;
    message = visible
      .slice(0, 4)
      .map((c) => `${changeLabel(c)}: ${firstItem(c.order)}`)
      .join("\n");
    if (visible.length > 4) message += `\n…and ${visible.length - 4} more`;
    targetUrl = cfg.ordersUrl;
  }

  await rememberTarget(notifId, targetUrl);
  await chrome.notifications.create(notifId, {
    type: "basic",
    iconUrl: ICON,
    title,
    message
  });
}

// ---- housekeeping notifications (all rate-limited by caller state) --

export async function maybeNotifySignedOut(cfg) {
  const state = await store.load();
  const last = state.meta.lastSignedOutNotifAt || 0;
  if (Date.now() - last < LIMITS.SIGNED_OUT_NOTIF_MIN_INTERVAL_MS) return;
  await store.patch((s) => {
    s.meta.lastSignedOutNotifAt = Date.now();
  });
  await rememberTarget(NOTIF.SIGNED_OUT, cfg.ordersUrl);
  await chrome.notifications.create(NOTIF.SIGNED_OUT, {
    type: "basic",
    iconUrl: ICON,
    title: "Signed out of Amazon",
    message:
      "Order monitoring can't see your orders until you sign in again. Click to open the orders page."
  });
}

export async function notifyScraperBroken(cfg) {
  await rememberTarget(NOTIF.SCRAPER_BROKEN, cfg.ordersUrl);
  await chrome.notifications.create(NOTIF.SCRAPER_BROKEN, {
    type: "basic",
    iconUrl: ICON,
    title: "Amazon Order Monitor: page scrape came back empty",
    message:
      "The orders page produced no orders several checks in a row. Amazon may have changed their page layout. Click to inspect."
  });
}

export async function maybeNotifyEmailFailed() {
  const state = await store.load();
  const last = state.meta.lastEmailFailNotifAt || 0;
  if (Date.now() - last < LIMITS.EMAIL_FAIL_NOTIF_MIN_INTERVAL_MS) return;
  await store.patch((s) => {
    s.meta.lastEmailFailNotifAt = Date.now();
  });
  await chrome.notifications.create(NOTIF.EMAIL_FAILED, {
    type: "basic",
    iconUrl: ICON,
    title: "Order update email failed",
    message:
      "Desktop notifications still work. Check the relay URL/secret in the extension options (click to open)."
  });
}

export async function notifyScrapeTrouble(outcome) {
  await chrome.notifications.create("aom-trouble", {
    type: "basic",
    iconUrl: ICON,
    title: "Amazon Order Monitor: checks are failing",
    message: `Several checks in a row failed (${outcome}). The orders tab may be stuck — try reloading it manually.`
  });
}

// ---- nag ("no orders tab open") -----------------------------------

export async function maybeNag() {
  const state = await store.load();
  const { meta, config } = state;
  const now = Date.now();
  if (meta.nagSnoozedUntil && now < meta.nagSnoozedUntil) return;
  if (meta.lastNagAt && now - meta.lastNagAt < LIMITS.NAG_MIN_INTERVAL_MS) return;

  await store.patch((s) => {
    s.meta.lastNagAt = now;
  });
  await rememberTarget(NOTIF.NAG, config.ordersUrl);
  await chrome.notifications.create(NOTIF.NAG, {
    type: "basic",
    iconUrl: ICON,
    title: "Amazon Order Monitor needs an orders tab",
    message:
      "Keep an Amazon \"Your Orders\" tab open (pin it!) so orders can be checked. Or pause monitoring from the extension popup.",
    buttons: [{ title: "Open orders page" }, { title: "Snooze for today" }]
  });
}

// ---- event routing (wired in sw.js) --------------------------------

export async function handleClick(notifId) {
  await chrome.notifications.clear(notifId);
  const state = await store.load();
  const url = state.meta.notifTargets[notifId];
  if (notifId === NOTIF.EMAIL_FAILED) {
    await chrome.runtime.openOptionsPage();
    return;
  }
  if (url) {
    await chrome.tabs.create({ url, active: true });
  }
}

export async function handleButton(notifId, buttonIndex) {
  await chrome.notifications.clear(notifId);
  if (notifId !== NOTIF.NAG) return;

  if (buttonIndex === 0) {
    // Open orders page and check shortly after it has loaded.
    const state = await store.load();
    await chrome.tabs.create({ url: state.config.ordersUrl, active: true });
    await scheduler.armSoon(2 * 60_000, "nag-open");
  } else if (buttonIndex === 1) {
    // Snooze until next local midnight.
    const midnight = new Date();
    midnight.setHours(24, 0, 0, 0);
    await store.patch((s) => {
      s.meta.nagSnoozedUntil = midnight.getTime();
    });
    await store.logEvent("nag.snoozed", { until: midnight.toISOString() });
  }
}
