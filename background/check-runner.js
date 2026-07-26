// The check pipeline. A "check" spans multiple SW wakes:
//   runCheck() -> reload tab -> (SW may die) -> content script pushes
//   AOM_SCRAPE_RESULT -> handleScrapeResult() -> diff -> notify/email -> re-arm.
// In-flight bookkeeping lives in chrome.storage.session (survives SW death,
// cleared on browser exit — exactly the right lifetime). The watchdog is an
// alarm, never setTimeout.

import { ALARMS, LIMITS, isOrdersUrl } from "./constants.js";
import { sanitizeScrapeResult } from "./sanitize.js";
import * as store from "./store.js";
import * as scheduler from "./scheduler.js";
import * as tabManager from "./tab-manager.js";
import * as notifier from "./notifier.js";
import * as mailer from "./mailer.js";
import { diffOrders } from "./differ.js";
import * as icon from "./icon.js";

async function setOutcome(outcome, extra) {
  await store.patch((s) => {
    s.meta.lastCheckAt = Date.now();
    s.meta.lastCheckOutcome = outcome;
  });
  await icon.updateBadge(outcome);
  await store.logEvent("check.outcome", { outcome, ...(extra || {}) });
}

// Reloading a tab the user is actively reading is the one disruptive thing
// we do — defer (up to 3 x 5 min) if the orders tab is focused and the user
// is at the keyboard. Manual "Check now" skips this.
async function shouldDefer(tab) {
  if (!tab.active) return false;
  try {
    const win = await chrome.windows.get(tab.windowId);
    if (!win.focused) return false;
  } catch (e) {
    return false;
  }
  return (await chrome.idle.queryState(60)) === "active";
}

export async function runCheck(reason /* "alarm" | "manual" | "defer" */) {
  const state = await store.load();
  const cfg = state.config;

  if (cfg.paused) {
    await store.logEvent("check.skip", { reason, why: "paused" });
    return;
  }

  // Refuse overlapping checks: a second reload while one is pending would
  // let a stale result satisfy the newer check (F-07). Bookkeeping older
  // than the watchdog window is stale debris and may be overwritten.
  const { aomPendingCheck: inFlight } = await chrome.storage.session.get("aomPendingCheck");
  if (inFlight && Date.now() - inFlight.startedAt < LIMITS.CHECK_TIMEOUT_MS) {
    await store.logEvent("check.skip", { reason, why: "check-in-flight" });
    return;
  }

  // Config may have changed since this alarm was armed — re-verify quiet
  // hours at fire time. Manual checks always run.
  if (
    reason !== "manual" &&
    !cfg.debug.ignoreQuietHours &&
    scheduler.inQuietHours(Date.now(), cfg.quietHours)
  ) {
    await store.logEvent("check.skip", { reason, why: "quiet-hours" });
    await scheduler.armNext("quiet-hours-skip");
    return;
  }

  const tab = await tabManager.findOrdersTab();
  if (!tab) {
    await setOutcome("no_tab");
    await notifier.maybeNag();
    await scheduler.armNext("no-tab");
    return;
  }

  if (reason !== "manual" && (await shouldDefer(tab))) {
    const { aomDeferCount = 0 } = await chrome.storage.session.get("aomDeferCount");
    if (aomDeferCount < LIMITS.MAX_DEFERS) {
      await chrome.storage.session.set({ aomDeferCount: aomDeferCount + 1 });
      await chrome.alarms.create(ALARMS.DEFER, { when: Date.now() + LIMITS.DEFER_MS });
      await store.logEvent("check.deferred", { count: aomDeferCount + 1 });
      return;
    }
    // Deferred too often — proceed anyway (a reload of the orders page the
    // user is looking at is annoying, not harmful).
  }
  await chrome.storage.session.remove("aomDeferCount");

  const checkId = crypto.randomUUID();
  await chrome.storage.session.set({
    aomPendingCheck: { checkId, tabId: tab.id, startedAt: Date.now(), reason }
  });
  await chrome.alarms.create(ALARMS.TIMEOUT, {
    when: Date.now() + LIMITS.CHECK_TIMEOUT_MS
  });
  await store.logEvent("check.reloading", { checkId, tabId: tab.id, reason });
  await tabManager.beginReload(tab.id);
  // The SW may die here; the content script's push (or the timeout alarm)
  // continues the pipeline.
}

export async function handleScrapeResult(rawResult, sender) {
  // Paused means fully inert (F-01): even unsolicited page-load scrapes are
  // ignored — no state updates, no notifications, no email retries. (The
  // popup's CSV export talks to the content script directly and is
  // unaffected.) Pause itself clears any pending check.
  const state = await store.load();
  if (state.config.paused) {
    await store.logEvent("check.skip", { why: "paused-scrape-ignored" });
    return;
  }

  // Normalize before anything else: schema, sizes, enums, URL origins (F-04).
  const result = sanitizeScrapeResult(rawResult);

  const { aomPendingCheck } = await chrome.storage.session.get("aomPendingCheck");

  // A result satisfies the pending check only if it comes from the pending
  // tab AND is at least as fresh as the check start — a slow page load that
  // finishes late must not clear the newer check's watchdog (F-07).
  const fresh =
    !aomPendingCheck ||
    (result.scrapedAt &&
      Date.parse(result.scrapedAt) >= aomPendingCheck.startedAt - 5_000);
  const solicited = !!(
    aomPendingCheck &&
    sender.tab &&
    sender.tab.id === aomPendingCheck.tabId &&
    fresh
  );

  if (solicited) {
    await chrome.alarms.clear(ALARMS.TIMEOUT);
    await chrome.storage.session.remove("aomPendingCheck");
  }

  const reason = solicited ? aomPendingCheck.reason : "unsolicited";
  const checkId = solicited ? aomPendingCheck.checkId : "manual-visit";
  try {
    await processScrapeResult(result, reason, checkId);
  } catch (e) {
    await store.logEvent("error", { where: "processScrapeResult", checkId, error: String(e) });
  } finally {
    // Whatever happened above, the schedule must never stall.
    if (solicited) {
      await scheduler.armNext("check-complete");
    }
  }
}

async function processScrapeResult(result, reason, checkId) {
  const state = await store.load();
  const cfg = state.config;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  if (result.outcome === "signed_out") {
    await setOutcome("signed_out", { checkId });
    await notifier.maybeNotifySignedOut(cfg);
    return;
  }

  if (result.outcome === "error") {
    const failures = state.meta.consecutiveFailures + 1;
    await store.patch((s) => {
      s.meta.consecutiveFailures = failures;
    });
    await setOutcome("error", { checkId, error: result.error, failures });
    if (failures === LIMITS.FAILURES_BEFORE_WARN) {
      await notifier.notifyScrapeTrouble("scrape error");
    }
    return;
  }

  let orders = result.orders || [];
  if (cfg.debug.simulateEmptyScrape) orders = [];

  // Anomaly guard: an empty page while signed in is far more likely to be a
  // broken selector (or a half-loaded page) than a user with zero orders.
  // Never diff against it — a broken scrape must not look like mass deletion.
  if (orders.length === 0) {
    const empties = state.meta.consecutiveEmptyScrapes + 1;
    await store.patch((s) => {
      s.meta.consecutiveEmptyScrapes = empties;
    });
    await setOutcome("empty", { checkId, consecutiveEmptyScrapes: empties });
    if (empties === LIMITS.EMPTY_SCRAPES_BEFORE_WARN) {
      await notifier.notifyScraperBroken(cfg);
    }
    return;
  }

  const { changes, nextOrders } = diffOrders(state.orders, orders, nowIso);

  // Email-storm suppression: while the user is actively browsing the orders
  // page (unsolicited results in quick succession), keep state fresh but
  // don't email — they're looking right at it.
  const suppressEmail =
    reason === "unsolicited" &&
    state.meta.lastProcessedAt &&
    now - state.meta.lastProcessedAt < LIMITS.UNSOLICITED_EMAIL_SUPPRESS_MS;

  await store.patch((s) => {
    s.orders = nextOrders;
    s.meta.consecutiveEmptyScrapes = 0;
    s.meta.consecutiveFailures = 0;
    s.meta.lastProcessedAt = now;
    s.meta.lastSuccessfulScrapeAt = now;
    s.meta.ordersCount = orders.length;
    s.meta.lastCheckAt = now;
    s.meta.lastCheckOutcome = "ok";
  });
  await icon.updateBadge("ok"); // clear any "!" from earlier bad outcomes
  await store.logEvent("check.ok", {
    checkId,
    reason,
    orders: orders.length,
    changes: changes.map((c) => ({ kind: c.kind, id: c.orderId }))
  });

  // Notification and email delivery are independent: a failure in one must
  // never cost us the other (a broken notification once ate a change email).
  if (changes.length > 0) {
    try {
      await notifier.notifyChanges(changes, cfg, checkId);
    } catch (e) {
      await store.logEvent("error", { where: "notifyChanges", checkId, error: String(e) });
    }
    const emailable = changes.filter((c) => c.kind !== "minor_text_changed");
    if (emailable.length > 0 && !suppressEmail) {
      try {
        await mailer.maybeSendChangeEmail(emailable, cfg);
      } catch (e) {
        await store.logEvent("error", { where: "sendChangeEmail", checkId, error: String(e) });
      }
    }
  }

  try {
    await mailer.retryPendingEmail(cfg);
  } catch (e) {
    await store.logEvent("error", { where: "retryPendingEmail", error: String(e) });
  }
}

// Watchdog: the reload never produced a scrape result. Distinguish why.
export async function handleTimeout() {
  const { aomPendingCheck } = await chrome.storage.session.get("aomPendingCheck");
  if (!aomPendingCheck) return; // result arrived after all
  await chrome.storage.session.remove("aomPendingCheck");

  let outcome = "scrape_timeout";
  try {
    const tab = await chrome.tabs.get(aomPendingCheck.tabId);
    const url = tab.url || "";
    if (/https:\/\/www\.amazon\.com\/ap\//.test(url)) {
      outcome = "signed_out"; // bounced to the sign-in flow
    } else if (!isOrdersUrl(url)) {
      outcome = "navigated_away";
    }
  } catch (e) {
    outcome = "tab_gone";
  }

  const state = await store.load();
  await setOutcome(outcome, { checkId: aomPendingCheck.checkId });

  if (outcome === "signed_out") {
    await notifier.maybeNotifySignedOut(state.config);
  } else if (outcome === "navigated_away" || outcome === "tab_gone") {
    await notifier.maybeNag();
  } else {
    const failures = state.meta.consecutiveFailures + 1;
    await store.patch((s) => {
      s.meta.consecutiveFailures = failures;
    });
    if (failures === LIMITS.FAILURES_BEFORE_WARN) {
      await notifier.notifyScrapeTrouble("timeout");
    }
  }

  await scheduler.armNext("timeout");
}
