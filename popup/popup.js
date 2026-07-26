// Popup: monitoring status + controls, and the original CSV export.

import { MSG } from "../background/constants.js";

const $ = (id) => document.getElementById(id);
const msgEl = $("msg");

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

// ---- status --------------------------------------------------------

const OUTCOME_LABELS = {
  ok: "OK",
  empty: "Page had no orders",
  no_tab: "No orders tab open",
  signed_out: "Signed out of Amazon",
  scrape_timeout: "Check timed out",
  navigated_away: "Orders tab navigated away",
  tab_gone: "Orders tab was closed",
  error: "Scrape error"
};

function fmtTime(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

function fmtEta(ms) {
  if (!ms) return "—";
  const mins = Math.round((ms - Date.now()) / 60_000);
  if (mins <= 0) return "imminent";
  if (mins < 60) return `in ~${mins} min (${fmtTime(ms)})`;
  return fmtTime(ms);
}

let paused = false;

async function refreshStatus() {
  const s = await sendMessage({ type: MSG.GET_STATUS });
  const badge = $("stateBadge");
  if (!s.ok) {
    $("statusBox").textContent = "Could not reach the service worker: " + (s.error || "");
    badge.textContent = "?";
    badge.className = "badge off";
    return;
  }
  paused = s.paused;
  badge.textContent = paused ? "Paused" : "Active";
  badge.className = "badge " + (paused ? "off" : "on");
  $("pauseResumeBtn").textContent = paused ? "Resume" : "Pause";

  const outcome =
    s.lastCheckOutcome === "ok"
      ? `OK — ${s.ordersCount} order${s.ordersCount === 1 ? "" : "s"}`
      : OUTCOME_LABELS[s.lastCheckOutcome] || "No checks yet";

  const emailLine = s.emailEnabled
    ? `on (last: ${fmtTime(s.lastEmailAt)})`
    : s.relayConfigured
      ? "off (relay configured — enable in Options)"
      : "not configured (see Options)";

  $("statusBox").innerHTML = `
    <b>Last check:</b> ${fmtTime(s.lastCheckAt)} — ${escapeHtml(outcome)}<br />
    <b>Next check:</b> ${paused ? "paused" : escapeHtml(fmtEta(s.nextCheckAt))}<br />
    <b>Email:</b> ${escapeHtml(emailLine)}
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}

// ---- controls ------------------------------------------------------

$("checkNowBtn").addEventListener("click", async () => {
  msgEl.textContent = "Checking… (reloads the orders tab)";
  const res = await sendMessage({ type: MSG.CHECK_NOW });
  msgEl.textContent = res.ok
    ? "Check started. Results appear as a notification if something changed."
    : "Failed: " + (res.error || "unknown");
  setTimeout(refreshStatus, 1500);
});

$("openOrdersBtn").addEventListener("click", async () => {
  await sendMessage({ type: MSG.OPEN_ORDERS_TAB });
  window.close();
});

$("pauseResumeBtn").addEventListener("click", async () => {
  const res = await sendMessage({ type: paused ? MSG.RESUME : MSG.PAUSE });
  if (res.ok) await refreshStatus();
  else msgEl.textContent = "Failed: " + (res.error || "unknown");
});

$("optionsLink").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// ---- CSV export (original feature, unchanged mechanics) ------------

const csvStatusEl = $("csvStatus");
const csvContainerEl = $("csvContainer");
const csvTextEl = $("csvText");
let cachedCsv = "";

function getActiveTab(callback) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (chrome.runtime.lastError) {
      callback(null);
      return;
    }
    callback(tabs && tabs[0] ? tabs[0] : null);
  });
}

function requestCsvFromContentScript(cb) {
  getActiveTab((tab) => {
    if (!tab) {
      cb({ csv: "", error: "No active tab" });
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: MSG.GET_CSV }, (response) => {
      if (chrome.runtime.lastError) {
        cb({ csv: "", error: "Not an Amazon orders page" });
        return;
      }
      cb(response || { csv: "" });
    });
  });
}

function ensureCsvLoaded(onReady) {
  if (cachedCsv) {
    onReady(cachedCsv);
    return;
  }
  csvStatusEl.textContent = "Scraping orders on this page…";
  requestCsvFromContentScript((res) => {
    if (res.error) {
      csvStatusEl.textContent = "Error: " + res.error;
      return;
    }
    if (!res.csv) {
      csvStatusEl.textContent =
        "No CSV data found. Make sure the active tab is an Amazon \"Your Orders\" page.";
      return;
    }
    cachedCsv = res.csv;
    csvStatusEl.textContent = "CSV ready.";
    onReady(cachedCsv);
  });
}

$("copyCsvBtn").addEventListener("click", () => {
  ensureCsvLoaded((csv) => {
    navigator.clipboard.writeText(csv).then(
      () => {
        csvStatusEl.textContent = "CSV copied to clipboard.";
      },
      () => {
        csvContainerEl.style.display = "block";
        csvTextEl.value = csv;
        csvTextEl.select();
        csvStatusEl.textContent = "Clipboard blocked — text selected, press Ctrl+C.";
      }
    );
  });
});

$("showCsvBtn").addEventListener("click", () => {
  ensureCsvLoaded((csv) => {
    csvContainerEl.style.display = "block";
    csvTextEl.value = csv;
    csvStatusEl.textContent = "CSV displayed below.";
  });
});

refreshStatus();
