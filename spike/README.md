# AOM Spike — capability experiments

Throwaway extension that proves the four mechanisms the real **Amazon Order
Monitor** depends on, against neutral targets (example.com, your own Apps
Script) — never Amazon. Run these once, record the results, then ignore this
folder (it stays in the repo as documentation of *why* the main extension is
built the way it is).

## Install

1. `chrome://extensions` → Developer mode ON → **Load unpacked** → select this
   `spike/` folder.
2. Pin the "AOM Spike" icon.

## Experiment A — jittered self-rescheduling alarms

Proves: one-shot alarms with jitter survive service-worker death and browser
restarts (with the `onStartup` re-arm), without duplicate fires.

1. Popup → **Start loop**. Leave it running ≥ 10 minutes.
2. Kill the service worker mid-interval: `chrome://serviceworker-internals`
   → find the spike → **Stop** (or just wait — it dies after ~30 s idle anyway).
3. Fully quit Chrome (all windows, check the tray) mid-interval, wait a minute,
   reopen Chrome, wait 2 minutes.
4. Popup → **Dump log**.

| Pass criteria | Look for in log |
|---|---|
| Ticks continue across SW death | `A.tick` entries keep coming; `lifecycle.sw-loaded` between ticks proves the SW died and was rewoken |
| Restart recovery | after reopening Chrome: `lifecycle.onStartup` followed by `A.rearm-needed` or `A.rearm-not-needed`, then ticks resume |
| Jitter respected | `sinceLastTickMs` values spread within ~42000–78000 |
| No duplicate arming | no pairs of `A.tick` closer than ~40 s; `A.arm-skipped` entries are OK (that's the guard working) |

## Experiment B — find tab by URL + reload + content-script push (no "tabs" permission)

Proves: `tabs.query({url})` sees tabs via host permissions alone; a reload
revives even a discarded tab; `autoDiscardable: false` works; the round trip
tab-reload → content-script → SW message arrives.

1. Open https://example.com in a normal tab (don't focus it afterwards).
2. Popup → **Run tab check** → **Dump log**: expect `B.query` with `count: 1`
   and the real URL under `urlsVisible` (NOT "(url NOT visible)"), then
   `B.reloaded`, then `B.ping` with `solicited: true` and a small `latencyMs`.
3. Discard test: go to `chrome://discards`, discard the example.com tab
   (it should show "discarded" state), then **Run tab check** again.
   Expect the same successful sequence — reload revives it.

| Pass criteria |
|---|
| `B.query` count ≥ 1 and URL visible without `"tabs"` in the manifest |
| `B.autoDiscardable-false` with `ok: true` |
| `B.ping` `solicited: true`, latency < 10000 ms, including from discarded state |

If the URL shows "(url NOT visible)" or the query returns 0 with the tab open,
the host-permission-only path failed on this Chrome version → the main
extension must add `"tabs"` to permissions (one-line change, accepts the
"read browsing history" warning).

## Experiment C — notification with buttons

Proves: notifications with 2 buttons render on Windows 11 and click events
reach a freshly-woken service worker.

1. Popup → **Show notification**. Wait ~40 s **without** touching it
   (lets the SW die, so the click tests the wake-up path).
2. Click **Action A** in the notification (on Windows it may be in the
   notification center / bell icon if the toast timed out).
3. **Dump log**: expect `C.shown` then `C.buttonClicked` with `buttonIndex: 0`.
4. Repeat and click the notification body → `C.bodyClicked`.

If nothing appears on screen at all: check Windows Settings → System →
Notifications (Chrome must be allowed; Do Not Disturb / Focus Assist off).

## Experiment D — Apps Script relay POST from the SW

Proves: the SW can POST to your own Apps Script web app with no CORS
preflight, the 302 redirect to `script.googleusercontent.com` is followed
(this is why that host permission exists), the response is readable, wrong
secrets are rejected, and the email actually arrives.

1. Deploy the relay: follow the comment at the top of
   [apps-script/Code.gs](apps-script/Code.gs).
2. Popup → paste the `/exec` URL + the same secret you put in Script
   Properties → **Save** → **Send test**.
3. Expect in the shown response: `status: 200`, `finalUrl` starting with
   `https://script.googleusercontent.com/`, `redirected: true`,
   `parsed: {ok: true, remaining: ...}` — and the email in your inbox within
   ~1 minute.
4. **Send with WRONG secret** → `parsed: {ok: false, error: "unauthorized"}`
   and **no** email.
5. (Optional, documents the host-permission requirement) Edit
   `manifest.json`, remove the `script.googleusercontent.com` entry, reload
   the extension, **Send test** again → expect a fetch error / opaque failure.
   Put the permission back.

## Recording results

Paste the dumped log (or just the pass/fail table) into an issue or commit
message. The go/adjust gates:

- **B fails** → add `"tabs"` permission to the main extension.
- **D redirect fails even with both host permissions** → switch the relay
  response handling to fire-and-forget (send email, ignore response body).
- **A restart recovery fails** → shorten the main extension's catch-up delay
  and lean on `onStartup` + overdue detection (already planned) — checks would
  then resume on first SW wake instead of on a surviving alarm.
