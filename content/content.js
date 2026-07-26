// content/content.js
// Amazon Order Monitor — content script for Amazon "Your Orders" pages.
//
// On every load (document_idle) it scrapes the order cards into structured
// objects and pushes an AOM_SCRAPE_RESULT message to the service worker.
// The service worker decides whether this was a scheduled check or a manual
// visit. It also answers AOM_GET_CSV from the popup (CSV built on demand;
// the clipboard is only ever touched by the popup on explicit user action).
//
// Message type strings must match background/constants.js (content scripts
// can't import modules, so they are duplicated by convention).

// ====== SELECTORS ==================================================
// Arrays of fallbacks: the first selector that matches wins. When Amazon
// changes their DOM, this table is the only place that should need edits.

const SELECTORS = {
  // Each order card container
  orderContainer: [".order-card.js-order-card"],

  // Header box (placed date, total, ship to, order id)
  orderHeader: [".a-box.order-header"],

  // Shipment status primary text (Arriving/Delivered/…)
  statusLine: [
    ".delivery-box .yohtmlc-shipment-status-primaryText .delivery-box__primary-text",
    ".yohtmlc-shipment-status-primaryText"
  ],

  // Item titles: product links inside yohtmlc-product-title
  itemTitle: [".yohtmlc-product-title a.a-link-normal"],

  // Markers that we got bounced to (or shown inline) a sign-in form
  signInMarkers: ["#ap_email", "form[name='signIn']", "#authportal-main-section"]
};

// ====== SMALL UTILITIES ============================================

function getText(el) {
  if (!el) return "";
  return el.textContent.trim();
}

function queryFirst(root, selectors) {
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function queryAll(root, selectors) {
  for (const sel of selectors) {
    const els = root.querySelectorAll(sel);
    if (els.length > 0) return Array.from(els);
  }
  return [];
}

// ====== DATE PARSING ===============================================

const MONTHS = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11
};

function parseOrderPlacedDateFromText(text) {
  if (!text) return null;
  const re = /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/;
  const m = text.match(re);
  if (!m) return null;

  const monthName = m[1].toLowerCase();
  const day = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);

  const monthIndex = MONTHS[monthName];
  if (monthIndex == null) return null;

  return new Date(year, monthIndex, day);
}

function parseArrivingOrDeliveredDate(line, orderDate) {
  if (!line) return null;

  let text = line.trim();
  let lower = text.toLowerCase();

  // 1. Normalize prefixes ("Arriving", "Delivered", "Now arriving", "Previously expected")
  const prefixPatterns = [
    /^arriving\s+/i,
    /^delivered\s+/i,
    /^now arriving\s+/i,
    /^now expected\s+/i,
    /^previously expected\s+/i,
    /^expected\s+/i
  ];

  for (const pat of prefixPatterns) {
    if (pat.test(text)) {
      text = text.replace(pat, "").trim();
      lower = text.toLowerCase();
      break;
    }
  }

  // ---- IMPORTANT: use *now* for today/tomorrow/yesterday and weekdays ----
  const now = new Date();
  const TODAY = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // 2. "today / tomorrow / yesterday"
  if (lower.includes("today")) {
    return TODAY;
  }
  if (lower.includes("tomorrow")) {
    const d = new Date(TODAY);
    d.setDate(d.getDate() + 1);
    return d;
  }
  if (lower.includes("yesterday")) {
    const d = new Date(TODAY);
    d.setDate(d.getDate() - 1);
    return d;
  }

  // 3. Date RANGE: return the LATER date
  //    Supports: "December 8 - December 15", "December 8-15", "December 8 - 15"
  const rangeRe = /^([A-Za-z]+)\s+(\d{1,2})\s*-\s*([A-Za-z]+)?\s*(\d{1,2})$/;
  let m = text.match(rangeRe);
  if (m) {
    const month1Name = m[1].toLowerCase();
    const day1 = parseInt(m[2], 10);

    // second month is optional
    const month2Name = m[3] ? m[3].toLowerCase() : month1Name;
    const day2 = parseInt(m[4], 10);

    const monthIdx1 = MONTHS[month1Name];
    const monthIdx2 = MONTHS[month2Name];

    if (monthIdx1 != null && monthIdx2 != null) {
      const baseForYear = orderDate || now;
      const year = baseForYear.getFullYear();

      let date1 = new Date(year, monthIdx1, day1);
      let date2 = new Date(year, monthIdx2, day2);

      // Handle December→January year crossing
      if (
        orderDate &&
        monthIdx2 === 0 && // January
        orderDate.getMonth() === 11 // order in December
      ) {
        date2 = new Date(year + 1, monthIdx2, day2);
      }

      // Return the LATER date of the two
      return date2 > date1 ? date2 : date1;
    }
  }

  // 4. Single month & day ("December 12")
  const reMonthDay = /^([A-Za-z]+)\s+(\d{1,2})$/;
  m = text.match(reMonthDay);
  if (m) {
    const monthName = m[1].toLowerCase();
    const day = parseInt(m[2], 10);
    const monthIdx = MONTHS[monthName];

    if (monthIdx != null) {
      const baseForYear = orderDate || now;
      const year = baseForYear.getFullYear();
      let dateObj = new Date(year, monthIdx, day);

      // handle December → January crossover
      if (
        orderDate &&
        dateObj < orderDate &&
        monthIdx === 0 && // January
        orderDate.getMonth() === 11 // December
      ) {
        dateObj = new Date(year + 1, monthIdx, day);
      }

      return dateObj;
    }
  }

  // 5. Weekday ("Friday", "Monday"), based on NOW
  const weekdayRe = /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i;
  const w = text.match(weekdayRe);
  if (w) {
    const weekdayName = w[1].toLowerCase();
    const weekdayMap = {
      sunday: 0,
      monday: 1,
      tuesday: 2,
      wednesday: 3,
      thursday: 4,
      friday: 5,
      saturday: 6
    };

    const targetDow = weekdayMap[weekdayName];
    const currentDow = TODAY.getDay();

    let daysAhead = (targetDow - currentDow) % 7;
    if (daysAhead <= 0) daysAhead += 7;

    const d = new Date(TODAY);
    d.setDate(d.getDate() + daysAhead);
    return d;
  }

  // Nothing matched
  return null;
}

// "YYYY-MM-DD" for storage/diffing; null-safe.
function toIsoDate(dateObj) {
  if (!dateObj || isNaN(dateObj.getTime())) return null;
  const mm = String(dateObj.getMonth() + 1).padStart(2, "0");
  const dd = String(dateObj.getDate()).padStart(2, "0");
  return `${dateObj.getFullYear()}-${mm}-${dd}`;
}

// "MM/DD/YYYY" for the CSV export (Google Sheets friendly).
function isoToSheetsDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

// ====== STATUS CATEGORIZATION ======================================

// Order matters: more specific / terminal states first.
const STATUS_RULES = [
  [/cancell?ed/i, "canceled"],
  [/\breturn/i, "returned"],
  [/out for delivery/i, "out_for_delivery"],
  [/\bdelivered\b/i, "delivered"],
  [/running late|delayed|previously expected|now expected/i, "delayed"],
  [/^(arriving|now arriving|expected|shipped|dispatched|on the way)/i, "arriving"]
];

function categorizeStatus(statusRaw) {
  const s = (statusRaw || "").trim();
  if (!s) return "unknown";
  for (const [re, category] of STATUS_RULES) {
    if (re.test(s)) return category;
  }
  return "unknown";
}

// ====== MONEY ======================================================

function dollarsToCents(amountStr) {
  if (!amountStr) return null;
  const s = amountStr.replace(/\$/g, "").replace(/,/g, "").trim();
  if (!s) return null;
  const num = Number(s);
  if (!isFinite(num)) return null;
  return Math.round(num * 100);
}

function centsToDollarStr(cents) {
  const dollars = Math.floor(cents / 100);
  const rem = Math.abs(cents % 100);
  return `$${dollars}.${String(rem).padStart(2, "0")}`;
}

function splitTotalAcrossItems(totalCents, nItems) {
  if (nItems <= 0) return [];
  const base = Math.floor(totalCents / nItems);
  const remainder = totalCents % nItems;
  const perItem = [];
  for (let i = 0; i < nItems; i++) {
    perItem.push(i < remainder ? base + 1 : base);
  }
  return perItem;
}

// ====== DOM SCRAPING ===============================================

function extractHeaderInfo(orderNode) {
  const header = queryFirst(orderNode, SELECTORS.orderHeader);
  if (!header) {
    return {
      orderPlacedText: "",
      orderTotalText: "",
      orderIdText: "",
      orderDetailsUrl: ""
    };
  }

  const liNodes = header.querySelectorAll("li.order-header__header-list-item");
  let orderPlacedText = "";
  let orderTotalText = "";
  let orderIdText = "";

  liNodes.forEach((li) => {
    const labelSpan = li.querySelector(".a-row .a-color-secondary.a-text-caps");
    if (!labelSpan) return;

    const label = labelSpan.textContent.trim().toLowerCase();

    let valueText = "";
    const rows = li.querySelectorAll(".a-row");
    if (rows.length >= 2) {
      const valSpan = rows[1].querySelector("span");
      if (valSpan) {
        valueText = valSpan.textContent.trim();
      }
    }

    if (label.includes("order placed")) {
      orderPlacedText = valueText;
    } else if (label === "total" || label.includes("total")) {
      orderTotalText = valueText;
    } else if (label.startsWith("order #") || label === "order #") {
      if (!orderIdText && valueText) {
        orderIdText = valueText;
      }
    }
  });

  if (!orderIdText) {
    const idContainer = header.querySelector(".yohtmlc-order-id");
    if (idContainer) {
      const spans = idContainer.querySelectorAll("span");
      if (spans.length >= 2) {
        orderIdText = spans[1].textContent.trim();
      } else {
        orderIdText = idContainer.textContent.trim();
      }
    }
  }

  // The resolved link must be an Amazon order-details page. Without the
  // origin check, an absolute href like
  // https://evil.example/gp/css/order-details would match the selector and
  // end up as a notification click target and in emails.
  let orderDetailsUrl = "";
  const detailsLink = header.querySelector(
    ".yohtmlc-order-level-connections a.a-link-normal[href*='/gp/css/order-details']"
  );
  if (detailsLink) {
    const href = detailsLink.getAttribute("href") || "";
    try {
      const u = new URL(href, window.location.origin);
      if (
        u.protocol === "https:" &&
        u.hostname === "www.amazon.com" &&
        u.pathname.startsWith("/gp/css/order-details")
      ) {
        orderDetailsUrl = u.href;
      }
    } catch (e) {
      // unparsable href — leave empty; consumers fall back to the orders page
    }
  }

  return {
    orderPlacedText,
    orderTotalText,
    orderIdText,
    orderDetailsUrl
  };
}

function extractRawOrder(orderNode) {
  const headerInfo = extractHeaderInfo(orderNode);

  const statusEl = queryFirst(orderNode, SELECTORS.statusLine);
  const statusText = getText(statusEl);

  const itemEls = queryAll(orderNode, SELECTORS.itemTitle);
  const itemTitles = itemEls.map(getText).filter(Boolean);

  // Amazon often lists item titles twice in a row; dedupe consecutive.
  const dedupedItems = [];
  let last = null;
  for (const title of itemTitles) {
    if (title !== last) {
      dedupedItems.push(title);
      last = title;
    }
  }

  return {
    orderPlacedText: headerInfo.orderPlacedText,
    orderTotalText: headerInfo.orderTotalText,
    orderIdText: headerInfo.orderIdText,
    orderDetailsUrl: headerInfo.orderDetailsUrl,
    statusText,
    items: dedupedItems
  };
}

function scrapePageRawOrders() {
  const orderNodes = queryAll(document, SELECTORS.orderContainer);
  return orderNodes.map(extractRawOrder);
}

// ====== STRUCTURED ORDERS ==========================================

function toStructuredOrders(rawOrders) {
  const orders = [];
  const seenOrderIds = new Set();

  for (const raw of rawOrders) {
    const orderId = raw.orderIdText || "";
    if (!orderId) continue; // untrackable without an id
    if (seenOrderIds.has(orderId)) continue;
    seenOrderIds.add(orderId);

    const placedDateObj = parseOrderPlacedDateFromText(raw.orderPlacedText);
    const arrivalDateObj = parseArrivingOrDeliveredDate(raw.statusText, placedDateObj);

    orders.push({
      orderId,
      placedDate: toIsoDate(placedDateObj),
      placedDateRaw: raw.orderPlacedText,
      totalCents: dollarsToCents(raw.orderTotalText),
      totalRaw: raw.orderTotalText,
      statusRaw: raw.statusText,
      statusCategory: categorizeStatus(raw.statusText),
      arrivalDate: toIsoDate(arrivalDateObj),
      items: raw.items,
      detailsUrl: raw.orderDetailsUrl
    });
  }

  return orders;
}

function detectSignedOut() {
  return queryFirst(document, SELECTORS.signInMarkers) !== null;
}

function collectScrapeResult() {
  const base = {
    type: "AOM_SCRAPE_RESULT",
    url: location.href,
    scrapedAt: new Date().toISOString()
  };
  try {
    if (detectSignedOut()) {
      return { ...base, outcome: "signed_out", orders: [] };
    }
    const orders = toStructuredOrders(scrapePageRawOrders());
    // Zero orders with no sign-in markers is still "ok" — the service
    // worker's anomaly guard decides whether an empty page is believable.
    return { ...base, outcome: "ok", orders };
  } catch (err) {
    return { ...base, outcome: "error", orders: [], error: String((err && err.stack) || err) };
  }
}

// ====== CSV (popup convenience only — one row per item) ============

// Spreadsheet formula injection guard: item titles are untrusted
// marketplace text, and a cell starting with = + - @ (possibly hidden
// behind whitespace or control characters) executes as a formula when the
// CSV is pasted into Sheets/Excel. Prefix such cells with a single quote,
// which spreadsheets interpret as "treat as literal text".
function neutralizeFormula(s) {
  return /^[\s\x00-\x1f\x7f]*[=+\-@]/.test(s) ? "'" + s : s;
}

function csvEscapeField(value) {
  const s = neutralizeFormula(String(value ?? ""));
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function buildCsvFromOrders(orders) {
  const header = [
    "Order Placed Date",
    "Order Total",
    "Arriving Date",
    "Item Index",
    "Item Name"
  ];
  const lines = [header.map(csvEscapeField).join(",")];

  for (const order of orders) {
    if (!order.items || order.items.length === 0 || order.totalCents == null) continue;

    // Split the order total across items so each row has a per-item price
    // (integer cents, remainder to the first items — sums exactly).
    const perItemCents = splitTotalAcrossItems(order.totalCents, order.items.length);

    for (let i = 0; i < order.items.length; i++) {
      lines.push(
        [
          isoToSheetsDate(order.placedDate),
          centsToDollarStr(perItemCents[i]),
          isoToSheetsDate(order.arrivalDate),
          i + 1,
          order.items[i]
        ]
          .map(csvEscapeField)
          .join(",")
      );
    }
  }

  return lines.length > 1 ? lines.join("\n") : "";
}

// ====== MESSAGE HANDLER (popup CSV requests) =======================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "AOM_GET_CSV") {
    try {
      const result = collectScrapeResult();
      if (result.outcome !== "ok") {
        sendResponse({ csv: "", error: result.outcome });
        return;
      }
      sendResponse({ csv: buildCsvFromOrders(result.orders) });
    } catch (err) {
      sendResponse({ csv: "", error: String(err) });
    }
    // sendResponse called synchronously; no need to return true.
  }
});

// ====== INIT: push scrape result to the service worker =============

(function init() {
  if (window.__AOM_SCRAPER_RAN__) return;
  window.__AOM_SCRAPER_RAN__ = true;

  const push = () => {
    chrome.runtime.sendMessage(
      collectScrapeResult(),
      () => void chrome.runtime.lastError // SW always answers; swallow edge-case noise
    );
  };

  if (document.readyState === "complete" || document.readyState === "interactive") {
    push();
  } else {
    document.addEventListener("DOMContentLoaded", push, { once: true });
  }
})();
