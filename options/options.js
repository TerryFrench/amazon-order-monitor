// Options page. All state reads/writes go through the service worker
// (AOM_GET_CONFIG / AOM_UPDATE_CONFIG) — the SW is the sole storage writer,
// so a save here can never race a concurrent scrape/email update (F-06).

import { MSG } from "../background/constants.js";

const $ = (id) => document.getElementById(id);
const statusEl = $("status");

function showStatus(text, ok) {
  statusEl.textContent = text;
  statusEl.className = ok ? "ok" : "err";
}

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(resp || { ok: false, error: "no response" });
    });
  });
}

// ---- load ----------------------------------------------------------

let paused = false;

async function loadForm() {
  const res = await sendMessage({ type: MSG.GET_CONFIG });
  if (!res.ok) {
    showStatus("Could not load settings: " + (res.error || "unknown"), false);
    return;
  }
  const cfg = res.config;
  $("relayUrl").value = cfg.relayUrl;
  $("relaySecret").value = cfg.relaySecret;
  $("emailEnabled").checked = cfg.emailEnabled;
  $("notificationsEnabled").checked = cfg.notificationsEnabled;
  $("notifyMinorChanges").checked = cfg.notifyMinorChanges;
  $("intervalMinutes").value = cfg.intervalMinutes;
  $("jitterPct").value = cfg.jitterPct;
  $("quietStart").value = cfg.quietHours.start;
  $("quietEnd").value = cfg.quietHours.end;
  $("ordersUrl").value = cfg.ordersUrl;
  $("ignoreQuietHours").checked = cfg.debug.ignoreQuietHours;
  $("simulateEmptyScrape").checked = cfg.debug.simulateEmptyScrape;
  paused = cfg.paused;
  $("pauseResume").textContent = paused ? "Resume monitoring" : "Pause monitoring";
}

// ---- save ----------------------------------------------------------

function validate() {
  const relayUrl = $("relayUrl").value.trim();
  if (relayUrl && !/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(relayUrl)) {
    return "Relay URL must look like https://script.google.com/macros/s/…/exec";
  }
  const ordersUrl = $("ordersUrl").value.trim();
  if (ordersUrl && !/^https:\/\/www\.amazon\.com\//.test(ordersUrl)) {
    return "Orders URL must be a https://www.amazon.com/ page.";
  }
  const interval = Number($("intervalMinutes").value);
  if (!(interval >= 1 && interval <= 1440)) {
    return "Interval must be between 1 and 1440 minutes.";
  }
  if (interval < 15 && !$("ignoreQuietHours").closest("details").open) {
    return "Intervals below 15 minutes are for debugging — open the Debug section to confirm.";
  }
  return null;
}

async function saveForm() {
  const problem = validate();
  if (problem) {
    showStatus(problem, false);
    return false;
  }
  const config = {
    relayUrl: $("relayUrl").value.trim(),
    relaySecret: $("relaySecret").value.trim(),
    emailEnabled: $("emailEnabled").checked,
    notificationsEnabled: $("notificationsEnabled").checked,
    notifyMinorChanges: $("notifyMinorChanges").checked,
    intervalMinutes: Number($("intervalMinutes").value),
    jitterPct: Number($("jitterPct").value),
    quietHours: { start: $("quietStart").value, end: $("quietEnd").value },
    ordersUrl: $("ordersUrl").value.trim(),
    debug: {
      ignoreQuietHours: $("ignoreQuietHours").checked,
      simulateEmptyScrape: $("simulateEmptyScrape").checked
    }
  };
  const res = await sendMessage({ type: MSG.UPDATE_CONFIG, config });
  if (!res.ok) {
    showStatus("Save failed: " + (res.error || "unknown"), false);
    return false;
  }
  return true;
}

$("save").addEventListener("click", async () => {
  if (await saveForm()) showStatus("Saved. Next check rescheduled.", true);
});

// ---- secret generation ---------------------------------------------

$("genSecret").addEventListener("click", () => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const secret = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  $("relaySecret").value = secret;
  $("relaySecret").type = "text"; // show once so it can be copied into Apps Script
  showStatus(
    "Secret generated (shown once). Copy it into the Apps Script Script Properties as SHARED_SECRET, then Save here.",
    true
  );
});

// ---- test email ----------------------------------------------------

$("testEmail").addEventListener("click", async () => {
  showStatus("Saving settings and sending test email…", true);
  if (!(await saveForm())) return;
  const res = await sendMessage({ type: MSG.SEND_TEST_EMAIL });
  if (res.ok) {
    // The SW enables emailEnabled on success; reflect it here.
    $("emailEnabled").checked = true;
    const extras = [];
    if (res.version) extras.push(`relay v${res.version}`);
    if (res.remaining != null) extras.push(`quota remaining today: ${res.remaining}`);
    showStatus(
      "Test email sent — check your inbox. Email-on-change is now enabled." +
        (extras.length ? ` (${extras.join(", ")})` : ""),
      true
    );
  } else {
    showStatus("Test email failed: " + (res.error || "unknown error"), false);
  }
});

// ---- pause/resume --------------------------------------------------

$("pauseResume").addEventListener("click", async () => {
  const res = await sendMessage({ type: paused ? MSG.RESUME : MSG.PAUSE });
  if (res.ok) {
    paused = !paused;
    $("pauseResume").textContent = paused ? "Resume monitoring" : "Pause monitoring";
    showStatus(paused ? "Monitoring paused." : "Monitoring resumed.", true);
  } else {
    showStatus("Failed: " + (res.error || "unknown"), false);
  }
});

// ---- debug: event log ----------------------------------------------

$("showLog").addEventListener("click", async () => {
  const res = await sendMessage({ type: MSG.GET_EVENT_LOG });
  const el = $("eventLog");
  el.style.display = "block";
  el.textContent = (res.eventLog || [])
    .map((e) => `${e.ts}  ${e.tag}  ${JSON.stringify(e.data)}`)
    .join("\n") || "(event log empty)";
});

// Allow debug intervals below 15 when the Debug section is open.
document.querySelector("details").addEventListener("toggle", (ev) => {
  $("intervalMinutes").min = ev.target.open ? 1 : 15;
});

loadForm();
