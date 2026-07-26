// Boundary validation (security review F-04/F-05/F-06).
// Everything crossing into the service worker's state is normalized here:
// scrape results pushed by the content script (ultimately derived from
// Amazon-rendered DOM, i.e. untrusted marketplace text), and config patches
// sent by the options page. Pure module — no chrome.* — unit-testable.

const MAX = {
  ORDERS: 100,
  ITEMS_PER_ORDER: 50,
  STR: 300,
  ITEM_STR: 500,
  URL: 1000
};

const CATEGORIES = new Set([
  "arriving",
  "out_for_delivery",
  "delivered",
  "delayed",
  "canceled",
  "returned",
  "unknown"
]);

const OUTCOMES = new Set(["ok", "signed_out", "error"]);

function str(v, max) {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function isoDateOrNull(v) {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

// Order-details links scraped from the DOM must be Amazon order pages —
// an absolute href like https://evil.example/gp/css/order-details would
// otherwise become a notification click target and land in emails (F-05).
export function safeDetailsUrl(v) {
  if (typeof v !== "string" || v.length > MAX.URL) return "";
  try {
    const u = new URL(v);
    if (
      u.protocol === "https:" &&
      u.hostname === "www.amazon.com" &&
      u.pathname.startsWith("/gp/css/order-details")
    ) {
      return u.href;
    }
  } catch (e) {
    // not a URL
  }
  return "";
}

// The configured orders-page URL (opened on notification clicks and by the
// popup) may be any amazon.com page, but nothing else.
export function safeOrdersPageUrl(v) {
  if (typeof v !== "string" || v.length > MAX.URL) return "";
  try {
    const u = new URL(v);
    if (u.protocol === "https:" && u.hostname === "www.amazon.com") return u.href;
  } catch (e) {
    // not a URL
  }
  return "";
}

function sanitizeOrder(o) {
  if (!o || typeof o !== "object") return null;
  const orderId = str(o.orderId, 40).trim();
  // Amazon order ids look like 113-8164167-7801845; accept a superset but
  // stay far away from arbitrary text.
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{4,39}$/.test(orderId)) return null;

  const items = Array.isArray(o.items)
    ? o.items
        .slice(0, MAX.ITEMS_PER_ORDER)
        .map((i) => str(i, MAX.ITEM_STR).trim())
        .filter(Boolean)
    : [];

  return {
    orderId,
    placedDate: isoDateOrNull(o.placedDate),
    placedDateRaw: str(o.placedDateRaw, 100),
    totalCents:
      Number.isInteger(o.totalCents) && o.totalCents >= 0 && o.totalCents <= 1e9
        ? o.totalCents
        : null,
    totalRaw: str(o.totalRaw, 40),
    statusRaw: str(o.statusRaw, MAX.STR),
    statusCategory: CATEGORIES.has(o.statusCategory) ? o.statusCategory : "unknown",
    arrivalDate: isoDateOrNull(o.arrivalDate),
    items,
    detailsUrl: safeDetailsUrl(o.detailsUrl)
  };
}

export function sanitizeScrapeResult(raw) {
  if (!raw || typeof raw !== "object") {
    return { outcome: "error", orders: [], error: "malformed result", scrapedAt: null };
  }
  const outcome = OUTCOMES.has(raw.outcome) ? raw.outcome : "error";
  const orders =
    outcome === "ok" && Array.isArray(raw.orders)
      ? raw.orders.slice(0, MAX.ORDERS).map(sanitizeOrder).filter(Boolean)
      : [];
  return {
    outcome,
    orders,
    error: outcome === "error" ? str(raw.error, 500) || "malformed result" : undefined,
    scrapedAt:
      typeof raw.scrapedAt === "string" && !isNaN(Date.parse(raw.scrapedAt))
        ? raw.scrapedAt
        : null
  };
}

// Config patches from the options page: whitelist of keys, typed, clamped.
// Note: `paused` is deliberately NOT accepted here — pause/resume go through
// their own messages because they also clear alarms and session state.
export function sanitizeConfigPatch(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;

  if (
    typeof raw.relayUrl === "string" &&
    (raw.relayUrl === "" ||
      /^https:\/\/script\.google\.com\/macros\/s\/[^\s?#]+\/exec$/.test(raw.relayUrl))
  ) {
    out.relayUrl = raw.relayUrl;
  }
  if (typeof raw.relaySecret === "string") out.relaySecret = raw.relaySecret.slice(0, 200);

  for (const k of ["emailEnabled", "notificationsEnabled", "notifyMinorChanges"]) {
    if (typeof raw[k] === "boolean") out[k] = raw[k];
  }

  if (Number.isFinite(raw.intervalMinutes)) {
    out.intervalMinutes = Math.min(1440, Math.max(1, Math.round(raw.intervalMinutes)));
  }
  if (Number.isFinite(raw.jitterPct)) {
    out.jitterPct = Math.min(90, Math.max(0, Math.round(raw.jitterPct)));
  }

  const hm = /^\d{1,2}:\d{2}$/;
  if (
    raw.quietHours &&
    typeof raw.quietHours === "object" &&
    hm.test(raw.quietHours.start) &&
    hm.test(raw.quietHours.end)
  ) {
    out.quietHours = { start: raw.quietHours.start, end: raw.quietHours.end };
  }

  const ordersUrl = safeOrdersPageUrl(raw.ordersUrl);
  if (ordersUrl) out.ordersUrl = ordersUrl;

  if (raw.debug && typeof raw.debug === "object") {
    out.debug = {};
    for (const k of ["simulateEmptyScrape", "ignoreQuietHours"]) {
      if (typeof raw.debug[k] === "boolean") out.debug[k] = raw.debug[k];
    }
  }
  return out;
}
