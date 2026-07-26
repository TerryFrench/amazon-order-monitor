// AOM Spike service worker.
// Four experiments (A-D), each logging observations to a ring buffer in
// chrome.storage.local so results survive service worker deaths.
// See README.md for the protocol and pass criteria.

const TICK_ALARM = "spike-tick";
const LOG_MAX = 400;

// ---- ring-buffer event log ----------------------------------------
// Serialized through a promise chain: concurrent handlers in one SW
// instance would otherwise clobber each other's read-modify-write.

let logQueue = Promise.resolve();

function log(tag, data) {
  logQueue = logQueue.then(async () => {
    const { spikeLog = [] } = await chrome.storage.local.get("spikeLog");
    spikeLog.push({ ts: new Date().toISOString(), tag, data });
    if (spikeLog.length > LOG_MAX) spikeLog.splice(0, spikeLog.length - LOG_MAX);
    await chrome.storage.local.set({ spikeLog });
  }).catch((e) => console.error("[spike] log failed", e));
  return logQueue;
}

// ---- Experiment A: self-rescheduling jittered one-shot alarms ------

const BASE_MS = 60_000;
const JITTER = 0.3; // ±30% => 42-78s

async function armTick(reason) {
  // Guard against double-arming: only create if absent.
  const existing = await chrome.alarms.get(TICK_ALARM);
  if (existing) {
    await log("A.arm-skipped", { reason, scheduledFor: existing.scheduledTime });
    return;
  }
  const delay = BASE_MS * (1 + (Math.random() * 2 - 1) * JITTER);
  const when = Date.now() + delay;
  await chrome.alarms.create(TICK_ALARM, { when });
  await chrome.storage.local.set({ spikeExpectedTick: when });
  await log("A.armed", { reason, delayMs: Math.round(delay), when });
}

async function onTick() {
  const now = Date.now();
  const { spikeExpectedTick, spikeLastTick } = await chrome.storage.local.get([
    "spikeExpectedTick",
    "spikeLastTick"
  ]);
  await chrome.storage.local.set({ spikeLastTick: now });
  await log("A.tick", {
    driftMs: spikeExpectedTick ? now - spikeExpectedTick : null,
    sinceLastTickMs: spikeLastTick ? now - spikeLastTick : null
  });
  const { spikeRunningA } = await chrome.storage.local.get("spikeRunningA");
  if (spikeRunningA) await armTick("tick");
}

async function ensureTickArmed(source) {
  const { spikeRunningA } = await chrome.storage.local.get("spikeRunningA");
  if (!spikeRunningA) return;
  const existing = await chrome.alarms.get(TICK_ALARM);
  if (!existing) {
    await log("A.rearm-needed", { source });
    await armTick(source);
  } else {
    await log("A.rearm-not-needed", { source, scheduledFor: existing.scheduledTime });
  }
}

// ---- Experiment B: tab query + reload + content-script ping --------

async function runTabCheck() {
  const t0 = Date.now();
  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: "https://example.com/*" });
  } catch (e) {
    await log("B.query-error", { error: String(e) });
    return { ok: false, error: "query failed: " + String(e) };
  }
  await log("B.query", {
    count: tabs.length,
    urlsVisible: tabs.map((t) => t.url ?? "(url NOT visible)"),
    discarded: tabs.map((t) => t.discarded),
    frozen: tabs.map((t) => t.frozen ?? "(no frozen prop)")
  });
  if (tabs.length === 0) {
    return { ok: false, error: "No https://example.com tab open. Open one first." };
  }
  const tab = tabs[0];
  try {
    await chrome.tabs.update(tab.id, { autoDiscardable: false });
    await log("B.autoDiscardable-false", { tabId: tab.id, ok: true });
  } catch (e) {
    await log("B.autoDiscardable-false", { tabId: tab.id, ok: false, error: String(e) });
  }
  await chrome.storage.session.set({ spikePendingPing: { tabId: tab.id, t0 } });
  await chrome.tabs.reload(tab.id);
  await log("B.reloaded", { tabId: tab.id });
  return { ok: true, note: "Reloaded tab " + tab.id + "; waiting for ping (check log)." };
}

async function onPing(msg, sender) {
  const { spikePendingPing } = await chrome.storage.session.get("spikePendingPing");
  const solicited = spikePendingPing && sender.tab && sender.tab.id === spikePendingPing.tabId;
  if (solicited) await chrome.storage.session.remove("spikePendingPing");
  await log("B.ping", {
    solicited: !!solicited,
    latencyMs: solicited ? Date.now() - spikePendingPing.t0 : null,
    fromTab: sender.tab ? sender.tab.id : null,
    title: msg.title
  });
}

// ---- Experiment C: notification with buttons -----------------------

async function showNotification() {
  await chrome.notifications.clear("spike-notif");
  await chrome.notifications.create("spike-notif", {
    type: "basic",
    iconUrl: "icon128.png",
    title: "Spike: button test",
    message: "Click a button (or the body). The event must reach a freshly-woken service worker.",
    buttons: [{ title: "Action A" }, { title: "Action B" }]
  });
  await log("C.shown", {});
  return { ok: true, note: "Notification created. Click a button, then dump the log." };
}

// ---- Experiment D: Apps Script relay POST --------------------------

async function runRelayTest(cfg, useWrongSecret) {
  if (!cfg || !cfg.url || !cfg.secret) {
    return { ok: false, error: "Set relay URL and secret in the popup first." };
  }
  const payload = {
    secret: useWrongSecret ? "definitely-wrong-secret" : cfg.secret,
    subject: "[AOM spike] relay test " + new Date().toISOString(),
    body: "Hello from the spike service worker. If you can read this, experiment D passes."
  };
  const t0 = Date.now();
  try {
    const resp = await fetch(cfg.url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload)
    });
    const text = await resp.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (_) { /* HTML error page etc. */ }
    const entry = {
      wrongSecret: !!useWrongSecret,
      status: resp.status,
      finalUrl: resp.url, // should be script.googleusercontent.com after the 302
      redirected: resp.redirected,
      ms: Date.now() - t0,
      parsed,
      rawPrefix: parsed ? undefined : text.slice(0, 200)
    };
    await log("D.response", entry);
    return { ok: true, note: JSON.stringify(entry, null, 2) };
  } catch (e) {
    await log("D.fetch-error", { wrongSecret: !!useWrongSecret, error: String(e) });
    return { ok: false, error: String(e) };
  }
}

// ---- top-level event wiring (all synchronous registrations) --------

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM) onTick();
});

chrome.runtime.onInstalled.addListener(() => {
  log("lifecycle.onInstalled", {});
  ensureTickArmed("onInstalled");
});

chrome.runtime.onStartup.addListener(() => {
  log("lifecycle.onStartup", {});
  ensureTickArmed("onStartup");
});

chrome.notifications.onButtonClicked.addListener((id, idx) => {
  log("C.buttonClicked", { id, buttonIndex: idx });
});

chrome.notifications.onClicked.addListener((id) => {
  log("C.bodyClicked", { id });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case "SPIKE_PING":
        await onPing(msg, sender);
        return { ok: true };
      case "SPIKE_START_A":
        await chrome.storage.local.set({ spikeRunningA: true });
        await armTick("start");
        return { ok: true, note: "Alarm loop started (~60s ±30%)." };
      case "SPIKE_STOP_A":
        await chrome.storage.local.set({ spikeRunningA: false });
        await chrome.alarms.clear(TICK_ALARM);
        await log("A.stopped", {});
        return { ok: true, note: "Alarm loop stopped." };
      case "SPIKE_RUN_B":
        return runTabCheck();
      case "SPIKE_RUN_C":
        return showNotification();
      case "SPIKE_RUN_D":
        return runRelayTest(msg.cfg, msg.wrongSecret);
      case "SPIKE_IDLE":
        return { ok: true, note: "idle state: " + (await chrome.idle.queryState(60)) };
      default:
        return { ok: false, error: "unknown message" };
    }
  })().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
  return true; // async sendResponse
});

log("lifecycle.sw-loaded", {});
