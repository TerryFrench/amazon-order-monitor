// Diff engine. Pure: takes previous order records + freshly scraped orders,
// returns change events and the next records map. Never touches chrome.* —
// callable from the SW console with synthetic data.
//
// Safety rules (non-negotiable, see README):
// - An order MISSING from a scrape is NEVER a change. Orders scroll off the
//   page's time filter naturally; a broken selector must be structurally
//   unable to produce "everything was canceled" events.
// - The empty-scrape anomaly guard lives in check-runner.js: this function
//   is simply never called with an empty scrape.

import { LIMITS } from "./constants.js";

const TERMINAL_CATEGORIES = new Set(["delivered", "canceled", "returned"]);

function prevSnapshot(rec) {
  return {
    statusCategory: rec.statusCategory,
    statusRaw: rec.statusRaw,
    arrivalDate: rec.arrivalDate
  };
}

function daysBetween(isoA, isoB) {
  const a = Date.parse(isoA);
  const b = Date.parse(isoB);
  if (isNaN(a) || isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

// Change kinds:
//   new_order            id not seen before
//   status_changed       statusCategory transition (the main signal)
//   arrival_date_changed same category, arrival date moved (delayDays > 0 = later)
//   minor_text_changed   same category+date, statusRaw text differs
//                        (consumers decide whether to surface it)
export function diffOrders(prevOrders, scrapedOrders, nowIso) {
  const changes = [];
  const nextOrders = { ...prevOrders };

  for (const order of scrapedOrders) {
    if (!order.orderId) continue;
    const prev = prevOrders[order.orderId];

    if (!prev) {
      changes.push({ kind: "new_order", orderId: order.orderId, order });
      nextOrders[order.orderId] = {
        ...order,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        lastChangedAt: nowIso
      };
      continue;
    }

    const rec = { ...prev, ...order, lastSeenAt: nowIso };

    if (prev.statusCategory !== order.statusCategory) {
      changes.push({
        kind: "status_changed",
        orderId: order.orderId,
        order,
        prev: prevSnapshot(prev)
      });
      rec.lastChangedAt = nowIso;
    } else if (
      prev.arrivalDate &&
      order.arrivalDate &&
      prev.arrivalDate !== order.arrivalDate
    ) {
      changes.push({
        kind: "arrival_date_changed",
        orderId: order.orderId,
        order,
        prev: prevSnapshot(prev),
        delayDays: daysBetween(prev.arrivalDate, order.arrivalDate)
      });
      rec.lastChangedAt = nowIso;
    } else if (prev.statusRaw !== order.statusRaw) {
      changes.push({
        kind: "minor_text_changed",
        orderId: order.orderId,
        order,
        prev: prevSnapshot(prev)
      });
      rec.lastChangedAt = nowIso;
    }

    nextOrders[order.orderId] = rec;
  }

  pruneOrders(nextOrders, nowIso);
  return { changes, nextOrders };
}

// Drop terminal orders unseen for 14 days, anything unseen for 60 days.
function pruneOrders(orders, nowIso) {
  const now = Date.parse(nowIso);
  for (const [id, rec] of Object.entries(orders)) {
    const lastSeen = Date.parse(rec.lastSeenAt || rec.firstSeenAt || nowIso);
    const age = now - lastSeen;
    const terminal = TERMINAL_CATEGORIES.has(rec.statusCategory);
    if ((terminal && age > LIMITS.PRUNE_TERMINAL_MS) || age > LIMITS.PRUNE_ANY_MS) {
      delete orders[id];
    }
  }
}
