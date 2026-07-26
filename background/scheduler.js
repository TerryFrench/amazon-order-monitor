// Check scheduling: self-rescheduling one-shot alarms with jitter and
// quiet hours. The pure functions (parseHM, inQuietHours, quietHoursEndAfter,
// computeNextRun) take explicit inputs so they can be exercised from the SW
// console — see docs/DEBUG.md.

import { ALARMS } from "./constants.js";
import * as store from "./store.js";

// "HH:MM" -> minutes since local midnight, or null if malformed.
export function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// Quiet hours are a local-time-of-day range [start, end). start > end means
// the range wraps midnight (e.g. 23:00-07:30). start === end disables.
export function inQuietHours(ms, quietHours) {
  const start = parseHM(quietHours && quietHours.start);
  const end = parseHM(quietHours && quietHours.end);
  if (start == null || end == null || start === end) return false;
  const d = new Date(ms);
  const mins = d.getHours() * 60 + d.getMinutes();
  if (start < end) return mins >= start && mins < end;
  return mins >= start || mins < end; // wraps midnight
}

// Next moment at/after `ms` when quiet hours end (assumes ms is inside them).
export function quietHoursEndAfter(ms, quietHours) {
  const end = parseHM(quietHours.end);
  const d = new Date(ms);
  const endToday = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    Math.floor(end / 60),
    end % 60
  ).getTime();
  return endToday > ms ? endToday : endToday + 24 * 3_600_000;
}

// Next quiet-hours edge (start or end, whichever comes first) strictly
// after `nowMs`, in local wall-clock time; null when quiet hours are
// disabled/malformed. Used by the icon state machine's boundary alarm.
export function nextQuietBoundary(nowMs, quietHours) {
  const start = parseHM(quietHours && quietHours.start);
  const end = parseHM(quietHours && quietHours.end);
  if (start == null || end == null || start === end) return null;
  const nextOccurrence = (mins) => {
    const d = new Date(nowMs);
    const t = new Date(
      d.getFullYear(),
      d.getMonth(),
      d.getDate(),
      Math.floor(mins / 60),
      mins % 60
    ).getTime();
    return t > nowMs ? t : t + 24 * 3_600_000;
  };
  return Math.min(nextOccurrence(start), nextOccurrence(end));
}

// Base interval + jitter; if the candidate lands in quiet hours, push it to
// quiet-hours end + 0-10 min extra jitter (so all clients don't fire at once).
export function computeNextRun(nowMs, cfg, rand = Math.random) {
  const intervalMin = Math.max(1, Number(cfg.intervalMinutes) || 60);
  const jitterPct = Math.min(90, Math.max(0, Number(cfg.jitterPct) || 0));
  const base = intervalMin * 60_000;
  const jittered = base * (1 + (rand() * 2 - 1) * (jitterPct / 100));
  let candidate = nowMs + Math.max(30_000, jittered);
  if (!(cfg.debug && cfg.debug.ignoreQuietHours) && inQuietHours(candidate, cfg.quietHours)) {
    candidate = quietHoursEndAfter(candidate, cfg.quietHours) + rand() * 10 * 60_000;
  }
  return Math.round(candidate);
}

// Arm the next scheduled check (replaces any existing "aom-check" alarm —
// alarms.create with the same name is an overwrite, which makes this
// authoritative and idempotent).
export async function armNext(reason) {
  const state = await store.load();
  if (state.config.paused) {
    await store.logEvent("scheduler.skip-armed", { reason, paused: true });
    return null;
  }
  const when = computeNextRun(Date.now(), state.config);
  await chrome.alarms.create(ALARMS.CHECK, { when });
  await store.patch((s) => {
    s.meta.nextCheckAt = when;
  });
  await store.logEvent("scheduler.armed", { reason, at: new Date(when).toISOString() });
  return when;
}

// Arm a check soon (nag button, startup catch-up) — still one-shot.
export async function armSoon(delayMs, reason) {
  const when = Date.now() + delayMs;
  await chrome.alarms.create(ALARMS.CHECK, { when });
  await store.patch((s) => {
    s.meta.nextCheckAt = when;
  });
  await store.logEvent("scheduler.armed-soon", { reason, at: new Date(when).toISOString() });
  return when;
}

// Alarms are only reliably persistent on Chrome 150+; re-create on every
// startup/install. Also fires a near-term catch-up if we're overdue
// (e.g. Chrome was closed past the scheduled slot).
export async function ensureArmed(source) {
  const state = await store.load();
  if (state.config.paused) return;

  const existing = await chrome.alarms.get(ALARMS.CHECK);
  const intervalMs = Math.max(1, state.config.intervalMinutes) * 60_000;
  const overdue =
    !state.meta.lastCheckAt || Date.now() - state.meta.lastCheckAt > intervalMs;

  if (overdue) {
    // Give Chrome 1-3 min to finish restoring the session, then check.
    await armSoon(60_000 + Math.random() * 120_000, source + ":catch-up");
  } else if (!existing) {
    await armNext(source + ":rearm");
  } else {
    await store.logEvent("scheduler.alarm-ok", {
      source,
      at: new Date(existing.scheduledTime).toISOString()
    });
  }
}
