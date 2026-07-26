// Unit tests for the pure logic: scheduler quiet-hours/jitter, differ
// rules, boundary sanitizers, icon state machine, and the real content.js
// CSV path (loaded via vm with DOM/chrome stubs).
//
// Run from the repo root:  node tests/test.mjs   (Node 18+, no deps)
import vm from "node:vm";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  inQuietHours,
  quietHoursEndAfter,
  computeNextRun,
  parseHM,
  nextQuietBoundary
} from "../background/scheduler.js";
import { diffOrders } from "../background/differ.js";
import { resolveIconState } from "../background/icon.js";
import {
  sanitizeScrapeResult,
  sanitizeConfigPatch,
  safeDetailsUrl,
  safeOrdersPageUrl
} from "../background/sanitize.js";

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log("PASS " + name);
  else {
    failures++;
    console.log("FAIL " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail) : ""));
  }
}

// ================= scheduler =================

check("parseHM 23:00", parseHM("23:00") === 23 * 60);
check("parseHM 07:30", parseHM("07:30") === 7 * 60 + 30);
check("parseHM garbage", parseHM("25:99") === null && parseHM("") === null);

const qh = { start: "23:00", end: "07:30" };
const at = (h, m) => new Date(2026, 0, 15, h, m).getTime();
check("23:30 quiet", inQuietHours(at(23, 30), qh) === true);
check("03:00 quiet", inQuietHours(at(3, 0), qh) === true);
check("07:29 quiet", inQuietHours(at(7, 29), qh) === true);
check("07:31 not quiet", inQuietHours(at(7, 31), qh) === false);
check("12:00 not quiet", inQuietHours(at(12, 0), qh) === false);

const qhDay = { start: "13:00", end: "15:00" };
check("14:00 quiet (day range)", inQuietHours(at(14, 0), qhDay) === true);
check("12:59 not quiet (day range)", inQuietHours(at(12, 59), qhDay) === false);
check("15:00 not quiet (day range, end exclusive)", inQuietHours(at(15, 0), qhDay) === false);
check("start==end disabled", inQuietHours(at(3, 0), { start: "00:00", end: "00:00" }) === false);
check("malformed disabled", inQuietHours(at(3, 0), { start: "x", end: "07:30" }) === false);

const end1 = new Date(quietHoursEndAfter(at(23, 30), qh));
check("end after 23:30 is 07:30 next day", end1.getDate() === 16 && end1.getHours() === 7 && end1.getMinutes() === 30, end1.toString());
const end2 = new Date(quietHoursEndAfter(at(3, 0), qh));
check("end after 03:00 is 07:30 same day", end2.getDate() === 15 && end2.getHours() === 7 && end2.getMinutes() === 30, end2.toString());

const cfgBase = { intervalMinutes: 60, jitterPct: 25, quietHours: qh, debug: {} };
{
  let ok = true, lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 500; i++) {
    const mins = (computeNextRun(at(12, 0), cfgBase) - at(12, 0)) / 60000;
    lo = Math.min(lo, mins); hi = Math.max(hi, mins);
    if (mins < 44.9 || mins > 75.1) ok = false;
  }
  check("noon: next in 45-75 min", ok, { lo, hi });
}
{
  let ok = true;
  for (let i = 0; i < 500; i++) {
    const next = new Date(computeNextRun(at(22, 50), cfgBase));
    const mins = next.getHours() * 60 + next.getMinutes();
    if (!(mins >= 7 * 60 + 30 && mins <= 7 * 60 + 41) || next.getDate() !== 16) ok = false;
  }
  check("22:50: pushed to 07:30-07:40 next day", ok);
}
{
  const cfgDbg = { ...cfgBase, debug: { ignoreQuietHours: true } };
  let ok = true;
  for (let i = 0; i < 200; i++) {
    const mins = (computeNextRun(at(23, 30), cfgDbg) - at(23, 30)) / 60000;
    if (mins < 44.9 || mins > 75.1) ok = false;
  }
  check("ignoreQuietHours honored", ok);
}
check("0% jitter exact", computeNextRun(at(12, 0), { intervalMinutes: 60, jitterPct: 0, quietHours: qh, debug: {} }, () => 0.5) === at(13, 0));

// ================= differ =================

const NOW = "2026-07-25T12:00:00.000Z";
const mkOrder = (id, over = {}) => ({
  orderId: id,
  placedDate: "2026-07-18",
  placedDateRaw: "July 18, 2026",
  totalCents: 2288,
  totalRaw: "$22.88",
  statusRaw: "Arriving July 28",
  statusCategory: "arriving",
  arrivalDate: "2026-07-28",
  items: ["Widget A"],
  detailsUrl: "https://www.amazon.com/gp/css/order-details?orderID=" + id,
  ...over
});
const asRec = (o, over = {}) => ({ ...o, firstSeenAt: "2026-07-20T00:00:00.000Z", lastSeenAt: "2026-07-25T00:00:00.000Z", lastChangedAt: "2026-07-20T00:00:00.000Z", ...over });

{
  const { changes, nextOrders } = diffOrders({}, [mkOrder("A1")], NOW);
  check("new_order detected", changes.length === 1 && changes[0].kind === "new_order", changes);
  check("new order recorded", nextOrders.A1 && nextOrders.A1.firstSeenAt === NOW);
}
{
  const prev = { A1: asRec(mkOrder("A1")) };
  const { changes } = diffOrders(prev, [mkOrder("A1", { statusCategory: "delivered", statusRaw: "Delivered July 25" })], NOW);
  check("status_changed detected", changes.length === 1 && changes[0].kind === "status_changed" && changes[0].prev.statusCategory === "arriving", changes);
}
{
  const prev = { A1: asRec(mkOrder("A1")) };
  const { changes } = diffOrders(prev, [mkOrder("A1", { arrivalDate: "2026-07-31", statusRaw: "Now expected July 31" })], NOW);
  check("arrival_date_changed +3d", changes.length === 1 && changes[0].kind === "arrival_date_changed" && changes[0].delayDays === 3, changes);
}
{
  const prev = { A1: asRec(mkOrder("A1")) };
  const { changes } = diffOrders(prev, [mkOrder("A1", { statusRaw: "Arriving Tuesday, July 28" })], NOW);
  check("minor_text_changed", changes.length === 1 && changes[0].kind === "minor_text_changed", changes);
}
{
  const prev = { A1: asRec(mkOrder("A1")) };
  const { changes, nextOrders } = diffOrders(prev, [mkOrder("A1")], NOW);
  check("identical -> no changes", changes.length === 0, changes);
  check("lastSeenAt advanced", nextOrders.A1.lastSeenAt === NOW);
}
// THE safety rule: absence is never a change.
{
  const prev = { A1: asRec(mkOrder("A1")), B2: asRec(mkOrder("B2")) };
  const { changes, nextOrders } = diffOrders(prev, [mkOrder("A1")], NOW);
  check("absent order -> zero changes", changes.length === 0, changes);
  check("absent order retained", !!nextOrders.B2);
}
{
  const old = "2026-07-10T00:00:00.000Z";
  const prev = {
    D1: asRec(mkOrder("D1", { statusCategory: "delivered" }), { lastSeenAt: old }),
    K1: asRec(mkOrder("K1"), { lastSeenAt: old })
  };
  const { nextOrders } = diffOrders(prev, [mkOrder("X9")], NOW);
  check("terminal order pruned after 14d", !nextOrders.D1);
  check("active order kept at 15d", !!nextOrders.K1);
}
{
  const ancient = "2026-05-25T00:00:00.000Z";
  const prev = { K1: asRec(mkOrder("K1"), { lastSeenAt: ancient }) };
  const { nextOrders } = diffOrders(prev, [mkOrder("X9")], NOW);
  check("any order pruned after 60d", !nextOrders.K1);
}

// ================= sanitize: scrape results =================

check("safeDetailsUrl external rejected", safeDetailsUrl("https://evil.example/gp/css/order-details?x=1") === "");
check("safeDetailsUrl http rejected", safeDetailsUrl("http://www.amazon.com/gp/css/order-details?x=1") === "");
check("safeDetailsUrl wrong path rejected", safeDetailsUrl("https://www.amazon.com/dp/B000") === "");
check("safeDetailsUrl valid kept", safeDetailsUrl("https://www.amazon.com/gp/css/order-details?orderID=111") !== "");
check("safeDetailsUrl relative rejected", safeDetailsUrl("/gp/css/order-details?x=1") === "");
check("safeOrdersPageUrl amazon kept", safeOrdersPageUrl("https://www.amazon.com/your-orders/orders?timeFilter=last30") !== "");
check("safeOrdersPageUrl other host rejected", safeOrdersPageUrl("https://amazon.com.evil.example/") === "");

{
  const evil = {
    outcome: "ok",
    scrapedAt: "2026-07-25T12:00:00.000Z",
    orders: [
      { orderId: "113-8164167-7801845", statusCategory: "delivered", items: ["ok item"], detailsUrl: "https://evil.example/gp/css/order-details", totalCents: 100 },
      { orderId: "bad id !!", items: [] },
      { orderId: "111-1111111-1111111", statusCategory: "not-a-category", items: [123, "x".repeat(9999)], detailsUrl: "https://www.amazon.com/gp/css/order-details?orderID=111", placedDate: "07/25/2026", arrivalDate: "2026-07-30", totalCents: 3.5 }
    ]
  };
  const r = sanitizeScrapeResult(evil);
  check("valid order kept, external URL stripped", r.orders.length === 2 && r.orders[0].detailsUrl === "", r.orders.map((o) => o.orderId));
  check("garbage orderId dropped", !r.orders.some((o) => /bad/.test(o.orderId)));
  const o3 = r.orders[1];
  check("bad category -> unknown", o3.statusCategory === "unknown");
  check("non-string item dropped, long item truncated", o3.items.length === 1 && o3.items[0].length === 500, o3.items.map((i) => i.length));
  check("bad placedDate -> null, good arrivalDate kept", o3.placedDate === null && o3.arrivalDate === "2026-07-30");
  check("non-integer totalCents -> null", o3.totalCents === null);
  check("amazon detailsUrl kept", o3.detailsUrl.startsWith("https://www.amazon.com/gp/css/order-details"));
}
{
  const many = { outcome: "ok", scrapedAt: NOW, orders: Array.from({ length: 150 }, (_, i) => ({ orderId: `111-0000000-${String(1000000 + i)}`, items: ["x"] })) };
  check("orders capped at 100", sanitizeScrapeResult(many).orders.length === 100);
  check("bad outcome -> error", sanitizeScrapeResult({ outcome: "weird", orders: [] }).outcome === "error");
  check("null result -> error", sanitizeScrapeResult(null).outcome === "error");
  check("bad scrapedAt -> null", sanitizeScrapeResult({ outcome: "ok", orders: [], scrapedAt: "not a date" }).scrapedAt === null);
}

// ================= sanitize: config patches =================

{
  const p = sanitizeConfigPatch({
    relayUrl: "https://script.google.com/macros/s/ABC123/exec",
    relaySecret: "s".repeat(300),
    emailEnabled: true,
    notificationsEnabled: "yes",
    intervalMinutes: 0.4,
    jitterPct: -5,
    quietHours: { start: "7:30", end: "23:00" },
    ordersUrl: "https://www.amazon.com/your-orders",
    paused: true,
    debug: { simulateEmptyScrape: true, extraKey: 1 },
    evilKey: "x"
  });
  check("valid relayUrl kept", p.relayUrl === "https://script.google.com/macros/s/ABC123/exec");
  check("secret truncated to 200", p.relaySecret.length === 200);
  check("boolean kept, non-boolean dropped", p.emailEnabled === true && !("notificationsEnabled" in p));
  check("interval clamped up to 1", p.intervalMinutes === 1);
  check("jitter clamped to 0", p.jitterPct === 0);
  check("quietHours h:mm accepted", p.quietHours && p.quietHours.start === "7:30");
  check("ordersUrl kept", !!p.ordersUrl);
  check("paused NOT accepted via config patch", !("paused" in p));
  check("debug whitelisted", p.debug.simulateEmptyScrape === true && !("extraKey" in p.debug));
  check("unknown keys dropped", !("evilKey" in p));
}
{
  const p = sanitizeConfigPatch({
    relayUrl: "https://evil.example/macros/s/x/exec",
    intervalMinutes: 99999,
    quietHours: { start: "7", end: "23:00" },
    ordersUrl: "http://www.amazon.com/your-orders"
  });
  check("bad relayUrl dropped", !("relayUrl" in p));
  check("interval clamped down to 1440", p.intervalMinutes === 1440);
  check("malformed quietHours dropped", !("quietHours" in p));
  check("non-https ordersUrl dropped", !("ordersUrl" in p));
  check("empty patch from garbage", Object.keys(sanitizeConfigPatch("junk")).length === 0);
}

// ================= icon state machine =================

{
  const qhU = { start: "20:20", end: "06:25" };
  const atD = (day, h, m) => new Date(2026, 6, day, h, m).getTime(); // July

  const b1 = nextQuietBoundary(atD(25, 12, 0), qhU);
  check("boundary from noon -> today 20:20", b1 === atD(25, 20, 20), new Date(b1).toString());
  const b2 = nextQuietBoundary(atD(25, 21, 0), qhU);
  check("boundary from inside quiet -> tomorrow 06:25", b2 === atD(26, 6, 25), new Date(b2).toString());
  const b3 = nextQuietBoundary(atD(26, 5, 0), qhU);
  check("boundary from early morning -> today 06:25", b3 === atD(26, 6, 25), new Date(b3).toString());
  const b4 = nextQuietBoundary(atD(26, 6, 25), qhU);
  check("boundary exactly on end edge -> today 20:20", b4 === atD(26, 20, 20), new Date(b4).toString());
  check("boundary disabled -> null", nextQuietBoundary(atD(25, 12, 0), { start: "07:00", end: "07:00" }) === null);
  check("boundary malformed -> null", nextQuietBoundary(atD(25, 12, 0), { start: "x", end: "06:25" }) === null);

  // resolveIconState: priority paused > quiet > default
  const cfg = (over = {}) => ({ paused: false, quietHours: qhU, debug: {}, ...over });
  check("state: default outside quiet", resolveIconState(cfg(), atD(25, 12, 0)) === "default");
  check("state: quiet inside window", resolveIconState(cfg(), atD(25, 22, 0)) === "quiet");
  check("state: quiet in early-morning wrap", resolveIconState(cfg(), atD(26, 3, 0)) === "quiet");
  check("state: paused wins over quiet", resolveIconState(cfg({ paused: true }), atD(25, 22, 0)) === "paused");
  check("state: paused wins outside quiet too", resolveIconState(cfg({ paused: true }), atD(25, 12, 0)) === "paused");
  check("state: ignoreQuietHours debug -> default", resolveIconState(cfg({ debug: { ignoreQuietHours: true } }), atD(25, 22, 0)) === "default");

  // The transition table, expressed as resolver calls:
  check("resume during quiet -> quiet", resolveIconState(cfg(), atD(25, 23, 0)) === "quiet");
  check("resume outside quiet -> default", resolveIconState(cfg(), atD(26, 9, 0)) === "default");
}

// ================= content.js CSV via vm =================

const contentCode = fs.readFileSync(
  fileURLToPath(new URL("../content/content.js", import.meta.url)),
  "utf8"
);
const sandbox = {
  chrome: { runtime: { onMessage: { addListener() {} }, sendMessage() {}, lastError: undefined } },
  window: {},
  document: { readyState: "loading", addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] },
  location: { href: "https://www.amazon.com/your-orders/orders" },
  console
};
vm.createContext(sandbox);
vm.runInContext(contentCode, sandbox);
const esc = (v) => vm.runInContext(`csvEscapeField(${JSON.stringify(v)})`, sandbox);
const cat = (v) => vm.runInContext(`categorizeStatus(${JSON.stringify(v)})`, sandbox);

check("csv: =formula neutralized", esc("=1+1") === "'=1+1");
// contains a comma -> neutralized AND quoted
check("csv: +formula neutralized", esc("+SUM(1,1)") === "\"'+SUM(1,1)\"");
check("csv: @formula neutralized", esc("@SUM(A1)") === "'@SUM(A1)");
check("csv: -formula neutralized", esc("-2+3") === "'-2+3");
check("csv: tab-hidden formula neutralized", esc("\t=cmd|'/c calc'!A0") === "'\t=cmd|'/c calc'!A0");
check("csv: control-char-hidden formula neutralized", esc("=x") === "'=x");
check("csv: normal title untouched", esc("YoLink On/Off Fob Programmable") === "YoLink On/Off Fob Programmable");
check("csv: dollar amount untouched", esc("$22.88") === "$22.88");
check("csv: quoting still applied", esc('say "hi", ok') === '"say ""hi"", ok"');
{
  const csv = vm.runInContext(
    `buildCsvFromOrders([{orderId:"A",placedDate:"2026-07-01",totalCents:200,items:["=1+1","normal item"],arrivalDate:null}])`,
    sandbox
  );
  check("csv: end-to-end row neutralized", csv.includes(",1,'=1+1") && csv.includes(",2,normal item"), csv);
}
check("categorize: arriving", cat("Arriving December 7") === "arriving");
check("categorize: delivered", cat("Delivered November 22") === "delivered");
check("categorize: out for delivery", cat("Out for delivery") === "out_for_delivery");
check("categorize: delayed", cat("Now expected July 30") === "delayed");
check("categorize: canceled", cat("Canceled") === "canceled");
check("categorize: returned", cat("Return complete") === "returned");
check("categorize: unknown", cat("Something novel") === "unknown");

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
