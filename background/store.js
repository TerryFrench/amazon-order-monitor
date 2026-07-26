// Storage schema + access. Single root object under chrome.storage.local
// key "aom". Every service worker wake is a cold start: always load fresh,
// never cache across events.

import { DEFAULT_CONFIG, LIMITS } from "./constants.js";

const KEY = "aom";
const SCHEMA_VERSION = 1;

function defaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    config: structuredClone(DEFAULT_CONFIG),
    // orderId -> Order (see content/content.js) + firstSeenAt/lastSeenAt/lastChangedAt
    orders: {},
    meta: {
      lastCheckAt: null,
      lastCheckOutcome: null, // ok|empty|no_tab|signed_out|scrape_timeout|navigated_away|tab_gone|error
      lastSuccessfulScrapeAt: null,
      lastProcessedAt: null, // any processed ok result (email-storm suppression)
      nextCheckAt: null,
      ordersCount: 0,
      lastEmailAt: null,
      emailDayKey: null, // local "YYYY-MM-DD" for the daily cap
      emailsSentToday: 0,
      lastEmailFailNotifAt: null,
      lastNagAt: null,
      nagSnoozedUntil: null,
      lastSignedOutNotifAt: null,
      consecutiveEmptyScrapes: 0,
      consecutiveFailures: 0,
      pendingEmail: null, // {subject, body, createdAt} retry buffer
      notifTargets: {}, // notificationId -> url (click routing)
      eventLog: [] // ring buffer {ts, tag, data}
    }
  };
}

// Merge stored config over defaults so new config keys added in future
// versions get sane values without an explicit migration.
function mergeConfig(stored) {
  const cfg = { ...structuredClone(DEFAULT_CONFIG), ...(stored || {}) };
  cfg.quietHours = { ...DEFAULT_CONFIG.quietHours, ...(stored?.quietHours || {}) };
  cfg.debug = { ...DEFAULT_CONFIG.debug, ...(stored?.debug || {}) };
  return cfg;
}

function migrate(raw) {
  if (!raw || typeof raw !== "object") return defaultState();
  // v1 is the first schema; future versions add cases here.
  const base = defaultState();
  return {
    schemaVersion: SCHEMA_VERSION,
    config: mergeConfig(raw.config),
    orders: raw.orders || {},
    meta: { ...base.meta, ...(raw.meta || {}) }
  };
}

export async function load() {
  const got = await chrome.storage.local.get(KEY);
  return migrate(got[KEY]);
}

async function save(state) {
  await chrome.storage.local.set({ [KEY]: state });
}

// Serialize read-modify-write cycles within this SW instance so concurrent
// handlers can't clobber each other. (There is only ever one SW instance.)
let patchQueue = Promise.resolve();

export function patch(mutator) {
  const run = async () => {
    const state = await load();
    const result = (await mutator(state)) || state;
    await save(result);
    return result;
  };
  const p = patchQueue.then(run, run);
  // Keep the queue alive even if a patch throws; callers still see the error.
  patchQueue = p.catch(() => {});
  return p;
}

export function logEvent(tag, data) {
  return patch((s) => {
    s.meta.eventLog.push({ ts: new Date().toISOString(), tag, data });
    if (s.meta.eventLog.length > LIMITS.EVENT_LOG_MAX) {
      s.meta.eventLog.splice(0, s.meta.eventLog.length - LIMITS.EVENT_LOG_MAX);
    }
  });
}
