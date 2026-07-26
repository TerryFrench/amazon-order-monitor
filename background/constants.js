// Shared constants for the service worker modules.
// NOTE: message type strings are duplicated in content/content.js (content
// scripts can't import modules) — keep them in sync.

export const MSG = {
  SCRAPE_RESULT: "AOM_SCRAPE_RESULT", // content -> SW
  GET_CSV: "AOM_GET_CSV", // popup -> content (never reaches the SW)
  GET_STATUS: "AOM_GET_STATUS", // popup -> SW
  CHECK_NOW: "AOM_CHECK_NOW", // popup -> SW
  PAUSE: "AOM_PAUSE", // popup/options -> SW
  RESUME: "AOM_RESUME", // popup/options -> SW
  OPEN_ORDERS_TAB: "AOM_OPEN_ORDERS_TAB", // popup -> SW
  SEND_TEST_EMAIL: "AOM_SEND_TEST_EMAIL", // options -> SW
  GET_CONFIG: "AOM_GET_CONFIG", // options -> SW
  UPDATE_CONFIG: "AOM_UPDATE_CONFIG", // options -> SW (the SW is the sole state writer)
  GET_EVENT_LOG: "AOM_GET_EVENT_LOG" // options -> SW (debug)
};

export const ALARMS = {
  CHECK: "aom-check", // one-shot, self-rescheduling with jitter
  TIMEOUT: "aom-check-timeout", // pending check watchdog (never setTimeout!)
  DEFER: "aom-defer", // retry after user-active deferral
  ICON: "aom-icon-sync" // fires at each quiet-hours boundary to flip the icon
};

export const NOTIF = {
  CHANGES_PREFIX: "aom-changes:", // + checkId
  NAG: "aom-nag",
  SIGNED_OUT: "aom-signed-out",
  SCRAPER_BROKEN: "aom-scraper-broken",
  EMAIL_FAILED: "aom-email-failed"
};

// Match patterns for tabs.query — work without the "tabs" permission because
// we hold host permissions for amazon.com (spike experiment B).
export const ORDER_TAB_PATTERNS = [
  "https://www.amazon.com/your-orders*",
  "https://www.amazon.com/gp/css/order-history*"
];

export function isOrdersUrl(url) {
  return (
    typeof url === "string" &&
    (url.startsWith("https://www.amazon.com/your-orders") ||
      url.startsWith("https://www.amazon.com/gp/css/order-history"))
  );
}

export const DEFAULT_CONFIG = {
  relayUrl: "",
  relaySecret: "",
  emailEnabled: false, // flipped on by a successful test email in options
  notificationsEnabled: true,
  notifyMinorChanges: false, // statusRaw text change with same category
  intervalMinutes: 60,
  jitterPct: 25, // ±25% => 45-75 min effective
  quietHours: { start: "23:00", end: "07:30" }, // local time; start===end disables
  paused: false,
  ordersUrl: "https://www.amazon.com/your-orders/orders?timeFilter=last30",
  debug: {
    simulateEmptyScrape: false,
    ignoreQuietHours: false
  }
};

export const LIMITS = {
  CHECK_TIMEOUT_MS: 60_000,
  DEFER_MS: 5 * 60_000,
  MAX_DEFERS: 3,
  MIN_INTERVAL_MINUTES: 1, // options UI enforces 15; 1 allows debug soak tests
  EMPTY_SCRAPES_BEFORE_WARN: 3,
  FAILURES_BEFORE_WARN: 3,
  EMAILS_PER_DAY: 20, // well under the 100/day MailApp quota
  UNSOLICITED_EMAIL_SUPPRESS_MS: 5 * 60_000,
  NAG_MIN_INTERVAL_MS: 24 * 3_600_000,
  SIGNED_OUT_NOTIF_MIN_INTERVAL_MS: 12 * 3_600_000,
  EMAIL_FAIL_NOTIF_MIN_INTERVAL_MS: 6 * 3_600_000,
  PENDING_EMAIL_TTL_MS: 24 * 3_600_000,
  PRUNE_TERMINAL_MS: 14 * 24 * 3_600_000, // delivered/canceled/returned
  PRUNE_ANY_MS: 60 * 24 * 3_600_000,
  RELAY_FETCH_TIMEOUT_MS: 25_000, // stay under the 30s SW fetch kill
  EVENT_LOG_MAX: 200,
  NOTIF_TARGETS_MAX: 10
};
