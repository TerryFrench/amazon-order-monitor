// Toolbar icon + badge — implemented as a small state machine.
//
// ## Icon state machine
//
// States:
//   default — blue "AOM"            (icons/aom*.png)
//   quiet   — "AOM" + "Zzz"         (icons/aom-quiet*.png)
//   paused  — greyed out + pause bars (generated at runtime)
//
// Transitions (the user-facing behavior):
//   default -> quiet    quiet-hours window starts
//   quiet   -> default  quiet-hours window ends
//   default -> paused   user pauses
//   quiet   -> paused   user pauses
//   paused  -> quiet    user resumes while quiet hours are active
//   paused  -> default  user resumes outside quiet hours
//
// Implementation: rather than tracking transitions, the current state is
// DERIVED from stored config on every trigger — resolveIconState() with
// priority paused > quiet > default. Deriving instead of transitioning
// means the icon can never get stuck in a stale state. Triggers:
//   - service worker wake        (sw.js module eval -> syncFromState)
//   - pause / resume             (sw.js handlers -> syncFromState)
//   - config change              (quiet-hours edits -> syncFromState)
//   - ALARMS.ICON boundary alarm (fires at each quiet start/end edge,
//                                 re-armed by syncFromState)
//
// Icon/badge failures are cosmetic and must never break the pipeline —
// every entry point here swallows its own errors.

import { ALARMS } from "./constants.js";
import { inQuietHours, nextQuietBoundary } from "./scheduler.js";
import * as store from "./store.js";

const SIZES = [16, 48, 128];

// state -> PNG basename prefix (paused has no PNG set; it's generated)
const PATH_PREFIX = { default: "aom", quiet: "aom-quiet" };

// Pure resolver — the whole transition table reduces to this priority.
export function resolveIconState(config, nowMs = Date.now()) {
  if (config.paused) return "paused";
  const ignore = config.debug && config.debug.ignoreQuietHours;
  if (!ignore && inQuietHours(nowMs, config.quietHours)) return "quiet";
  return "default";
}

// Paths must be ABSOLUTE (chrome.runtime.getURL): relative paths in
// SW-initiated API calls resolve against background/, 404, and make
// setIcon reject silently — which once left the icon stuck on "paused".
function pathsFor(prefix) {
  const path = {};
  for (const s of SIZES) path[s] = chrome.runtime.getURL(`icons/${prefix}${s}.png`);
  return path;
}

async function iconImageData(prefix, size, pausedOverlay) {
  const resp = await fetch(chrome.runtime.getURL(`icons/${prefix}${size}.png`));
  const bitmap = await createImageBitmap(await resp.blob());
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, size, size);
  if (!pausedOverlay) return ctx.getImageData(0, 0, size, size);

  // Desaturate + dim manually (ctx.filter support in worker OffscreenCanvas
  // varies by version; the pixel loop always works).
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const grey = (0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]) * 0.55;
    d[i] = d[i + 1] = d[i + 2] = grey;
  }
  ctx.putImageData(img, 0, 0);

  // Bold pause bars: translucent dark backing + white bars.
  const bw = Math.max(2, Math.round(size * 0.16));
  const bh = Math.round(size * 0.56);
  const gap = Math.max(2, Math.round(size * 0.12));
  const pad = Math.max(1, Math.round(size * 0.03));
  const y = (size - bh) / 2;
  const x1 = size / 2 - gap / 2 - bw;
  const x2 = size / 2 + gap / 2;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(x1 - pad, y - pad, bw + 2 * pad, bh + 2 * pad);
  ctx.fillRect(x2 - pad, y - pad, bw + 2 * pad, bh + 2 * pad);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x1, y, bw, bh);
  ctx.fillRect(x2, y, bw, bh);

  return ctx.getImageData(0, 0, size, size);
}

async function applyIconState(state) {
  try {
    if (state !== "paused") {
      // Fast path: shipped PNGs. On any failure fall through to ImageData —
      // the same mechanism the paused branch uses, so states behave alike.
      try {
        await chrome.action.setIcon({ path: pathsFor(PATH_PREFIX[state] || "aom") });
        return;
      } catch (e) {
        console.warn("[AOM] setIcon(path) failed, using imageData:", e);
      }
    }
    const prefix = state === "quiet" ? "aom-quiet" : "aom";
    const imageData = {};
    for (const s of SIZES) {
      imageData[s] = await iconImageData(prefix, s, state === "paused");
    }
    await chrome.action.setIcon({ imageData });
  } catch (e) {
    console.warn("[AOM] setIcon failed:", e);
  }
}

// Keep a one-shot alarm on the next quiet-hours edge so the icon flips at
// the boundary even when no check runs (checks don't run DURING quiet
// hours, so without this the "quiet" state would appear/disappear late).
// alarms.create with the same name overwrites — idempotent.
async function ensureBoundaryAlarm(config) {
  try {
    const when = nextQuietBoundary(Date.now(), config.quietHours);
    if (when == null) {
      await chrome.alarms.clear(ALARMS.ICON);
      return;
    }
    // Small buffer past the edge so resolveIconState lands inside the new
    // window rather than exactly on the boundary minute.
    await chrome.alarms.create(ALARMS.ICON, { when: when + 5_000 });
  } catch (e) {
    console.warn("[AOM] icon boundary alarm failed:", e);
  }
}

// The single entry point for every trigger listed in the header.
export async function syncFromState() {
  try {
    const state = await store.load();
    await applyIconState(resolveIconState(state.config));
    await ensureBoundaryAlarm(state.config);
  } catch (e) {
    console.warn("[AOM] icon sync failed:", e);
  }
}

// ---- badge ---------------------------------------------------------
// "!" marks states where monitoring cannot actually monitor and the user
// has to act (open a tab / sign in). Failure states like timeouts don't
// badge — they self-heal or escalate to a notification.

const BADGE_OUTCOMES = new Set(["no_tab", "signed_out", "navigated_away", "tab_gone"]);

export async function updateBadge(outcome) {
  try {
    const needsAttention = BADGE_OUTCOMES.has(outcome);
    if (needsAttention) {
      await chrome.action.setBadgeBackgroundColor({ color: "#b02a37" });
      await chrome.action.setBadgeText({ text: "!" });
    } else {
      await chrome.action.setBadgeText({ text: "" });
    }
  } catch (e) {
    console.warn("[AOM] setBadge failed:", e);
  }
}
