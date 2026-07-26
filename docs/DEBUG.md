# Debugging & fast verification

Everything here runs in minutes instead of waiting for real order changes.

## Opening the service worker console

`chrome://extensions` → Amazon Order Monitor → **service worker** link
("Inspect views"). All snippets below run in that console.

The service worker exposes its modules as a global **`AOM`** object
(dynamic `import()` is disallowed inside service workers by the HTML spec,
so the console can't load modules itself):

```js
AOM
// { store, scheduler, checkRunner, notifier, mailer, tabManager, differ, sanitize }
```

If `AOM` is undefined, your DevTools window is usually attached to a
**dead worker instance** (the SW died and restarted while DevTools was
open, or DevTools predates an extension reload). Close the DevTools window
and click the "service worker" link again — then `typeof AOM` should be
`"object"`.

No-modules fallback (works even without `AOM`): read state with
`(await chrome.storage.local.get("aom")).aom`, and doctor it directly, e.g.

```js
const { aom } = await chrome.storage.local.get("aom");
const o = Object.values(aom.orders).find(o => o.statusCategory === "delivered")
      || Object.values(aom.orders)[0];
o.statusCategory = "arriving";
o.statusRaw = "Arriving Friday";
await chrome.storage.local.set({ aom });
// then popup -> Check now
```

(Direct storage writes are for debugging only — normal code goes through
the service worker as the sole writer.)

## Fast clock

Options → Debug (open the section) → set interval to 1 minute, check
**Ignore quiet hours**, Save. "Check now" in the popup bypasses quiet hours
and the user-active deferral (but not the overlap guard: while a check is
in flight, a second "Check now" is ignored for up to 60 s).

## Inspect state / event log

```js
(await AOM.store.load()).meta            // outcomes, counters, next check
(await AOM.store.load()).orders          // tracked orders keyed by orderId
(await AOM.store.load()).meta.eventLog   // ring buffer (also: Options → Debug → Show event log)
```

## Force a check from the console

```js
await AOM.checkRunner.runCheck("manual")   // same as the popup's Check now
```

## Simulate each change kind

Run a snippet, then popup → **Check now** (with the orders tab open); the
next scrape diffs against the doctored state.

**status_changed** (make a delivered order look "arriving" again → expect a
"Delivered" notification + email on the next check):

```js
await AOM.store.patch(s => {
  const o = Object.values(s.orders).find(o => o.statusCategory === "delivered")
        || Object.values(s.orders)[0];
  o.statusCategory = "arriving";
  o.statusRaw = "Arriving Friday";
});
```

**arrival_date_changed** (move stored arrival 3 days earlier → expect
"Delayed by 3 days"):

```js
await AOM.store.patch(s => {
  const o = Object.values(s.orders).find(o => o.arrivalDate);
  const d = new Date(o.arrivalDate);
  d.setDate(d.getDate() - 3);
  o.arrivalDate = d.toISOString().slice(0, 10);
});
```

**new_order** (forget an order → expect "New order"):

```js
await AOM.store.patch(s => { delete s.orders[Object.keys(s.orders)[0]]; });
```

**minor_text_changed** (enable "minor changes" in Options first):

```js
await AOM.store.patch(s => {
  const o = Object.values(s.orders)[0];
  o.statusRaw = o.statusRaw + " (doctored)";
});
```

## Quiet-hours math (pure functions, no side effects)

```js
const sch = AOM.scheduler;
const qh = { start: "23:00", end: "07:30" };
const at = (h, m) => new Date(2026, 0, 15, h, m).getTime();
[[23,30],[3,0],[7,29],[7,31],[12,0]]
  .map(([h,m]) => `${h}:${String(m).padStart(2,"0")} -> ${sch.inQuietHours(at(h,m), qh)}`);
// expect: 23:30 true, 3:00 true, 7:29 true, 7:31 false, 12:00 false

// A run scheduled from 22:50 with a 60-min interval must land after 07:30:
new Date(sch.computeNextRun(at(22,50),
  { intervalMinutes: 60, jitterPct: 25, quietHours: qh, debug: {} }));

// Disabled range (start === end) never blocks:
sch.inQuietHours(at(3,0), { start: "00:00", end: "00:00" })   // false
```

## Empty-scrape anomaly guard

Options → Debug → check **Simulate empty scrape**, Save. Run 3 checks
("Check now" 3×, waiting ~1 min between them for the overlap guard).
Expect: outcomes `empty` ×3, **no** change notifications, **no** email, and
exactly one "page scrape came back empty" notification on the 3rd. Uncheck
afterwards; the next good scrape resets the counter.

## Signed-out detection

Sign out of amazon.com, then **Check now**. Expect outcome `signed_out`, a
(12h-rate-limited) "Signed out of Amazon" notification, no diffing, no
email. Sign back in; the next check recovers.

## Service-worker-death resilience

1. Start a check ("Check now"), then immediately kill the worker:
   `chrome://serviceworker-internals` → find the extension → Stop.
2. The content script's push (or the 60s timeout alarm) must still resolve
   the check — look for `check.ok` / `check.outcome` in the event log.
3. Quit Chrome fully, reopen: expect `lifecycle.startup` then a catch-up
   check within ~1-3 min if one was overdue.

## Overnight soak

Debug interval 1 min, ignore quiet hours, leave the orders tab open
overnight. Next morning, dump the event log and check: unbroken cadence of
`check.*` entries, no duplicate alarms (no `check.start` pairs seconds
apart), reload-revivals after Memory Saver discards logged as normal
successful checks.

## Icon state machine

The resolver is pure — test transitions without waiting for real times:

```js
const cfg = (await AOM.store.load()).config;
AOM.icon.resolveIconState(cfg)                          // current state
AOM.icon.resolveIconState({ ...cfg, paused: true })     // "paused"
AOM.icon.resolveIconState(cfg, new Date(2026, 6, 25, 23, 0).getTime())  // inside window -> "quiet"
AOM.scheduler.nextQuietBoundary(Date.now(), cfg.quietHours)  // next icon flip (ms)
await AOM.icon.syncFromState()                          // force re-apply now
```

Live test: Options → set quiet start 2 minutes from now → Save. The icon
should flip to "Zzz" within ~2 min (boundary alarm has a 5 s buffer and
Chrome may add up to 30 s). Pause during quiet → grey/bars; Resume →
back to "Zzz"; set quiet hours back → blue "AOM".

## Relay debugging

Test from the SW console without touching stored state:

```js
await AOM.mailer.sendTestEmail();   // uses saved config; returns {ok, version, ...}
```

Executions also appear in the Apps Script editor under "Executions"
(left sidebar) with any server-side errors.
