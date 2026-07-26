// Service worker entry point. Every listener is registered synchronously at
// the top level — Chrome only wakes a dead SW for events it has registered
// listener flags for; async registration silently drops events.

import { MSG, ALARMS } from "./constants.js";
import * as sanitize from "./sanitize.js";
import * as store from "./store.js";
import * as scheduler from "./scheduler.js";
import * as checkRunner from "./check-runner.js";
import * as notifier from "./notifier.js";
import * as mailer from "./mailer.js";
import * as tabManager from "./tab-manager.js";
import * as differ from "./differ.js";
import * as icon from "./icon.js";

const { sanitizeConfigPatch } = sanitize;

// Debug handles for the SW DevTools console. Dynamic import() is disallowed
// in service workers by the HTML spec, so the console can't load these
// modules itself — see docs/DEBUG.md for the recipes that use AOM.*.
globalThis.AOM = { store, scheduler, checkRunner, notifier, mailer, tabManager, differ, sanitize, icon };

// The SW restarts constantly — re-assert the paused/active icon on every
// wake (fire-and-forget; icon state is cosmetic).
icon.syncFromState();

// ---- alarms --------------------------------------------------------

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARMS.CHECK) {
    checkRunner.runCheck("alarm").catch(logError("runCheck"));
  } else if (alarm.name === ALARMS.DEFER) {
    checkRunner.runCheck("defer").catch(logError("runCheck-defer"));
  } else if (alarm.name === ALARMS.TIMEOUT) {
    checkRunner.handleTimeout().catch(logError("handleTimeout"));
  } else if (alarm.name === ALARMS.ICON) {
    // Quiet-hours boundary: re-resolve the icon state (also re-arms).
    icon.syncFromState();
  }
});

// ---- messages ------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse, (e) => {
    // Log AND respond — content-script pushes ignore the response, so an
    // unlogged failure here would be invisible.
    logError("onMessage:" + ((msg && msg.type) || "?"))(e);
    sendResponse({ ok: false, error: String(e) });
  });
  return true; // async sendResponse
});

async function handleMessage(msg, sender) {
  switch (msg && msg.type) {
    case MSG.SCRAPE_RESULT:
      await checkRunner.handleScrapeResult(msg, sender);
      return { ok: true };

    case MSG.GET_STATUS:
      return getStatus();

    case MSG.CHECK_NOW:
      await checkRunner.runCheck("manual");
      return { ok: true };

    case MSG.PAUSE:
      await pauseMonitoring();
      return { ok: true };

    case MSG.RESUME:
      await store.patch((s) => {
        s.config.paused = false;
      });
      await store.logEvent("monitoring.resumed", {});
      await icon.syncFromState(); // -> quiet or default, whichever applies now
      await scheduler.armNext("resume");
      return { ok: true };

    case MSG.OPEN_ORDERS_TAB: {
      const state = await store.load();
      await tabManager.openOrdersTab(state.config.ordersUrl);
      return { ok: true };
    }

    case MSG.SEND_TEST_EMAIL: {
      const res = await mailer.sendTestEmail();
      if (res.ok) {
        // A successful test proves the relay works — enable email-on-change.
        await store.patch((s) => {
          s.config.emailEnabled = true;
        });
      }
      return res;
    }

    case MSG.GET_CONFIG: {
      const state = await store.load();
      return { ok: true, config: state.config };
    }

    // The SW is the sole writer of extension state (review F-06): the
    // options page sends a patch instead of writing storage from its own
    // realm, which would race with concurrent SW updates.
    case MSG.UPDATE_CONFIG: {
      const patch = sanitizeConfigPatch(msg.config);
      await store.patch((s) => {
        const { quietHours, debug, ...flat } = patch;
        Object.assign(s.config, flat);
        if (quietHours) s.config.quietHours = quietHours;
        if (debug) Object.assign(s.config.debug, debug);
      });
      await store.logEvent("config.changed", { keys: Object.keys(patch) });
      await icon.syncFromState(); // quiet-hours edits can change the icon state
      await scheduler.armNext("config-changed");
      return { ok: true };
    }

    case MSG.GET_EVENT_LOG: {
      const state = await store.load();
      return { ok: true, eventLog: state.meta.eventLog };
    }

    default:
      return { ok: false, error: "unknown message type" };
  }
}

async function pauseMonitoring() {
  await store.patch((s) => {
    s.config.paused = true;
    s.meta.nextCheckAt = null;
  });
  await chrome.alarms.clear(ALARMS.CHECK);
  await chrome.alarms.clear(ALARMS.DEFER);
  await chrome.alarms.clear(ALARMS.TIMEOUT);
  await chrome.storage.session.remove(["aomPendingCheck", "aomDeferCount"]);
  await icon.syncFromState(); // -> paused
  await icon.updateBadge("paused"); // clears any stale "!" while paused
  await store.logEvent("monitoring.paused", {});
}

async function getStatus() {
  const state = await store.load();
  const alarm = await chrome.alarms.get(ALARMS.CHECK);
  return {
    ok: true,
    paused: state.config.paused,
    emailEnabled: state.config.emailEnabled,
    relayConfigured: !!(state.config.relayUrl && state.config.relaySecret),
    lastCheckAt: state.meta.lastCheckAt,
    lastCheckOutcome: state.meta.lastCheckOutcome,
    ordersCount: state.meta.ordersCount,
    lastEmailAt: state.meta.lastEmailAt,
    nextCheckAt: alarm ? alarm.scheduledTime : state.meta.nextCheckAt,
    ordersUrl: state.config.ordersUrl
  };
}

// ---- notifications -------------------------------------------------

chrome.notifications.onClicked.addListener((notifId) => {
  notifier.handleClick(notifId).catch(logError("notif-click"));
});

chrome.notifications.onButtonClicked.addListener((notifId, buttonIndex) => {
  notifier.handleButton(notifId, buttonIndex).catch(logError("notif-button"));
});

// ---- lifecycle -----------------------------------------------------

chrome.runtime.onInstalled.addListener((details) => {
  (async () => {
    await store.load(); // runs migration / seeds defaults
    await restrictStorageAccess();
    await store.logEvent("lifecycle.installed", { reason: details.reason });
    await scheduler.ensureArmed("onInstalled");
  })().catch(logError("onInstalled"));
});

// Defense in depth (review F-11): our content script never touches
// chrome.storage, so shut content scripts out of it entirely where the
// running Chrome supports setAccessLevel on storage.local.
async function restrictStorageAccess() {
  try {
    if (chrome.storage.local.setAccessLevel) {
      await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    }
  } catch (e) {
    // Unsupported on this Chrome version — acceptable, nothing depends on it.
  }
}

chrome.runtime.onStartup.addListener(() => {
  (async () => {
    await store.logEvent("lifecycle.startup", {});
    await scheduler.ensureArmed("onStartup");
  })().catch(logError("onStartup"));
});

function logError(where) {
  return (e) => {
    console.error(`[AOM] ${where} failed:`, e);
    store.logEvent("error", { where, error: String(e) }).catch(() => {});
  };
}
