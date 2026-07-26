# Amazon Order Monitor (Chrome Extension)

Amazon's order emails no longer tell you *what* you ordered, *how much* it
cost, or *when* it arrives. This extension puts that information back in
your hands — from your own browser, on your own terms:

- **Watches your Amazon "Your Orders" page** on a jittered schedule (default
  every 45–75 min, quiet at night).
- **Detects changes**: new order, shipped, out for delivery, delivered,
  delayed, canceled, returned, arrival date moved.
- **Notifies you** with a desktop notification, and **emails you** a
  plain-text summary — sent from your own Gmail to yourself via a tiny
  Google Apps Script relay that *you* deploy in *your* account. No
  developer-operated servers, no OAuth clients, no new accounts (the relay
  and Gmail are Google services running under your existing account).
- **CSV export** of the orders page (the original feature) is still there in
  the popup.

Built for Manifest V3, installed unpacked ("Load unpacked"). Works on
`www.amazon.com` (English).

---

## How it works — the "keep a tab open" model

The extension deliberately does **not** fetch Amazon pages invisibly in the
background (bot-detection risk, brittle) and does **not** open browser tabs
on its own schedule (intrusive). Instead:

1. **You keep one Amazon "Your Orders" tab open** — pin it and forget it.
2. On each scheduled check, the extension **reloads that tab** (skipping the
   reload if you're actively looking at it — it retries a few minutes
   later). Reloading also revives the tab if Chrome's Memory Saver discarded
   it.
3. The content script scrapes the rendered page and hands structured data to
   the service worker, which **diffs it against the last known state**.
4. Changes become a notification + one batched email.

If no orders tab is open, you get **at most one notification per day**
("Open orders page" / "Snooze for today" buttons), and you can pause
monitoring entirely from the popup — no nagging spirals.

Safety properties worth knowing:

- An order *disappearing* from the page is **never** treated as a change —
  orders naturally scroll out of the page's time filter, and a broken
  scraper must never produce "everything was canceled!" emails.
- An **empty** scrape while signed in is treated as an anomaly (probably
  Amazon changed their HTML), not as truth: after 3 consecutive empties you
  get a "scraper may be broken" notification and nothing else.
- Getting signed out is detected and reported as its own state — never
  emailed as order data.
- **Paused means paused.** While monitoring is paused, nothing is processed
  — not even your own manual visits to the orders page update state,
  notify, or email. (The popup's CSV export still works; it doesn't touch
  monitoring state.)
- **The very first successful check reports every visible order as "new".**
  This is by design: it doubles as a baseline snapshot of your current
  orders, delivered as one batched notification/email. From the second
  check on, only actual changes are reported.

---

## Install
The [wiki](https://github.com/TerryFrench/amazon-order-monitor/wiki) has a video about the install.
1. Clone or download this repository (zip).
2. Open `chrome://extensions`, enable **Developer mode** (top right).
3. **Load unpacked** → select the repository folder (the one containing
   `manifest.json`).
4. Open [amazon.com → Your Orders](https://www.amazon.com/your-orders/orders?timeFilter=last30)
   and **pin the tab**.
5. Click the extension icon: the popup shows monitoring status and a
   **Check now** button.

That's enough for **desktop notifications**. For **email**, do the one-time
relay setup below.

## Email setup (one time, ~5 minutes)

The extension never sees your Google password and needs no Google Cloud
project. You deploy a ~50-line Apps Script web app in your own account; the
extension POSTs change summaries to it; the script emails you.

1. Open the extension **Options** → **Generate secret**. Leave that page open.
2. Go to [script.new](https://script.new) (logged into the Google account
   that should receive the emails).
3. Replace the default code with the contents of
   [apps-script/Code.gs](apps-script/Code.gs). Save.
   Then click the project name at the top left ("Untitled project") and
   rename it to something you'll recognize later, e.g. **Amazon Emails** —
   this is the name you'll see in the authorization prompt and at
   [script.google.com](https://script.google.com).
4. **Project Settings** (gear icon) → **Script Properties** → add:
   - Property: `SHARED_SECRET`
   - Value: the secret you generated in step 1.

   Click **Save script properties**. If an error dialog appears the first
   time, close it and click **Save script properties** again — it works on
   the second try (a known Apps Script quirk).
5. **Deploy → New deployment** → type **Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
6. Authorize when prompted (the grant is "send email as you" — that is the
   entire job of this script).
7. Copy the **Web app URL** (ends in `/exec`) into the extension Options →
   **Send test email**. When the test arrives, email-on-change switches on
   automatically.

**Updating the relay later** (when this repo ships a new `Code.gs`): go to
[script.google.com](https://script.google.com/) and open the project you
created during setup from the **My projects** list (e.g. **Amazon Emails**,
or whatever you named it). Paste the new code over the old, save, then
**Deploy → Manage deployments → ✏️
(edit) → Version: "New version" → Deploy**. This keeps the same `/exec` URL
— do *not* use "New deployment", which mints a different URL. Deployment
numbers are Apps Script's own versioning; the `RELAY_VERSION` constant in
the code is echoed in responses, and the Options page shows it after a
successful test email so you can confirm which relay code is live.

Why "Anyone"? The URL is unguessable and every request must also carry your
secret. An attacker who somehow got both could only email *you* (the
recipient is hardcoded server-side), capped at 20 per clock hour — annoying
(it burns quota and could drown a real alert among noise), but nothing to
steal. If you ever suspect exposure, rotate both: new deployment, new
secret.

## Options

| Setting | Default | Notes |
|---|---|---|
| Check interval | 60 min | Effective 45–75 min with default jitter |
| Jitter | ±25% | Spreads checks so they don't look/behave like a metronome |
| Quiet hours | 23:00–07:30 | Local time; no checks in this window. Same start/end disables |
| Email on change | off | Auto-enabled by a successful test email |
| Desktop notifications | on | One notification per check, batched |
| Minor text changes | off | Notify when the status wording changes without a real state change |

Emails are capped at 20/day client-side (test emails count too) and at 20
per clock hour by the relay, enforced atomically under a script lock. The
hard ceiling is Google's own MailApp quota (currently ~100 recipients/day
for consumer accounts — Google's number, subject to change). One email per
check cycle batches all changed orders.

## Troubleshooting

- **Extension disabled with "Turn on developer mode to use this extension"
  even though developer mode IS on** → known Chrome quirk with unpacked
  extensions (seen on Chrome 150): on some startups Chrome misreads the
  developer-mode flag and disables the extension. Fix: on
  `chrome://extensions`, toggle Developer mode **off and back on**, then
  re-enable the extension. Note the failure mode is silent — if your order
  emails stop and the popup won't open, check the extensions page first.
- **No notifications at all** → Windows Settings → System → Notifications:
  Chrome must be allowed; Do Not Disturb off.
- **"No orders tab open"** → keep a pinned tab on the orders page; the
  popup's "Open orders page" button opens/focuses it.
- **"Signed out of Amazon"** → sign back in on the orders tab; monitoring
  recovers on the next check.
- **Test email fails** → re-check the `/exec` URL (a *deployment* URL, not
  the editor URL), and that the Script Property `SHARED_SECRET` exactly
  matches the secret in Options. Apps Script editor → **Executions** shows
  server-side errors.
- **"Page scrape came back empty"** → Amazon probably changed their HTML.
  Selectors live in one table at the top of
  [content/content.js](content/content.js) — PRs welcome.
- Deeper debugging: [docs/DEBUG.md](docs/DEBUG.md).

## Privacy & security

- Order data lives in your browser (`chrome.storage.local`); once email is
  enabled, change summaries also pass through your Apps Script deployment
  and persist in your Gmail — both inside your own Google account.
- The only order content that leaves your machine is the plain-text change
  summary; the POST also carries your shared secret to authenticate. Both
  go only to **your own** Apps Script deployment over HTTPS.
- No analytics, no developer-controlled endpoints, no remote code.
- The shared secret is stored in plain text in extension storage and in your
  script's properties. Its threat model is "strangers who found the relay
  URL", not "someone with full access to your Chrome profile" (who could
  read your Amazon session anyway).
- Permissions kept minimal: `alarms`, `storage`, `idle`, `notifications`
  plus host access to `www.amazon.com` and the two `script.google*.com`
  hosts. Notably there is **no** `tabs` permission ("read your browsing
  history") — the orders tab is found via host permissions alone.

**Why the relay is deployed with "Who has access: Anyone"** (for readers who
paused at that setting): "Only myself" doesn't mean "only my extension" — it
means the HTTP caller must authenticate with your Google account, and the
extension's POST is deliberately anonymous (attaching Google credentials
would require exactly the OAuth-client/Cloud-project setup this design
avoids). "Anyone" drops Google-level auth and replaces it with two bearer values:
the unguessable deployment URL and your shared secret, checked in `doPost`
(keep both private; rotate both if exposed).
The script's source and its Script Properties (where the secret lives) are
visible only to the owning account — callers see nothing but the JSON
response. And even an attacker holding both URL *and* secret could not send
mail "from you" to others: the recipient is hardcoded to the script owner's
own address. The residual risks are availability ones — self-spam that
burns quota or buries a real alert, and (with the URL alone) wasted Apps
Script executions — bounded by the hourly cap and fixed by rotating the
deployment and secret.

## Limitations

- `www.amazon.com` / English pages only (date parsing and DOM selectors are
  locale-specific). The parsing is centralized, so other marketplaces are a
  contribution away.
- Only the orders visible on the monitored page (default: last 30 days,
  first page) are tracked.
- Chrome must be running for checks to happen; missed windows are caught up
  shortly after Chrome restarts.
- Amazon can change their DOM at any time; the anomaly guard makes the
  common failure — an empty scrape — loud rather than silent-wrong. A
  partial scrape (page changed but some orders still parse) can go
  unnoticed until you compare against the real page.

## Toolbar icon states

The toolbar icon tells you at a glance whether monitoring is actually
running:

- **Blue "AOM"** — active, checks on schedule.
- **"AOM" + "Zzz"** — quiet hours: monitoring is on, but checks are
  sleeping until the window ends.
- **Greyed out with pause bars** — monitoring is paused (generated at
  runtime from the active icon via OffscreenCanvas; no extra PNG set to
  maintain).
- **Red "!" badge** — monitoring wants attention: no orders tab is open,
  or you're signed out of Amazon. Cleared automatically on the next
  successful check.

The three states form a small state machine (documented in
`background/icon.js`) with priority **paused > quiet > default**, re-derived
from stored settings on every trigger: service-worker wake, pause/resume,
settings changes, and a dedicated alarm that fires at each quiet-hours
boundary so the icon flips on time even while checks are sleeping. Deriving
the state instead of tracking transitions means the icon can never get
stuck — resuming during quiet hours lands on "Zzz", resuming outside lands
on the blue "AOM", automatically.

## Repository layout

```
manifest.json        MV3 manifest (module service worker) — extension version lives here
background/          service worker: scheduler, tab manager, differ, notifier, mailer, icon
content/content.js   the scraper (selectors table at the top)
popup/               status + controls + CSV export
options/             settings, test email, debug tools
apps-script/Code.gs  the email relay you deploy in your Google account
tests/test.mjs       unit tests for the pure modules — run: node tests/test.mjs
docs/DEBUG.md        fast verification recipes
AGENTS.md            architecture rules & conventions (for AI assistants and humans)
CONTRIBUTING.md      how to report bugs, request features, and send PRs
CHANGELOG.md         release history
```

## Contributing & community

- **Found a bug?** [Open an issue](https://github.com/TerryFrench/amazon-order-monitor/issues)
  — and please always include your **reproduction steps** and the
  **event log** (Options page → Debug section → **Show event log** →
  copy/paste; redact order details if you wish). The bug-report template
  walks you through it.
- **Feature ideas** also go to the issues, using the feature-request
  template (labeled `enhancement`).
- **Help wanted — icons:** if you can design better toolbar/notification
  icons, open a PR — or just attach your images to an issue if you're not
  comfortable with pull requests.
- **Forking?** Please keep a visible link back to
  [this repository](https://github.com/TerryFrench/amazon-order-monitor)
  in your fork's README so improvements can find their way home.
- Tests: `node tests/test.mjs` (Node 18+, no dependencies). Guidelines:
  [CONTRIBUTING.md](CONTRIBUTING.md) · architecture rules:
  [AGENTS.md](AGENTS.md) · history: [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
