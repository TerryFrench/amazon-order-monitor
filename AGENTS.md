# AI Agent Guidelines for Amazon Order Monitor

This document guides AI coding assistants (and is useful reading for
humans) working on this repository. See also [CONTRIBUTING.md](CONTRIBUTING.md)
for the contribution process and PR conventions.

**Project shape in one paragraph:** a Manifest V3 Chrome extension with
**no build step and no dependencies** — plain JavaScript, loaded unpacked.
`background/` contains ES modules run by the service worker; `content/`,
`popup/`, and `options/` scripts run in their own contexts;
`apps-script/Code.gs` is written in the **Google Apps Script dialect of
JavaScript** (V8 runtime, but `var`-style conventions, no modules, no
`fetch` — Apps Script services like `MailApp`/`CacheService`/`LockService`
instead).

## Core Principles

1. **Safety First**
   - Never perform destructive operations without explicit confirmation
   - Always validate inputs and handle errors gracefully
   - Implement proper authentication and authorization checks
   - Never commit or expose sensitive data

2. **Clarity and Transparency**
   - Write clear, self-documenting code with appropriate comments
   - Document all decisions and trade-offs
   - Tag AI-generated contributions appropriately
   - Explain complex logic where the code cannot

3. **Consistency**
   - Follow the project's established patterns and conventions
   - Maintain consistent code style
   - Use consistent naming conventions throughout the codebase
   - Adhere to the project's architecture and design patterns

4. **Quality Over Speed**
   - Prioritize correctness and maintainability over quick delivery
   - Include tests for logic changes wherever the logic is pure
   - Ensure checks pass before submission
   - Perform self-review before requesting human review

## File Structure and Organization

```
amazon-order-monitor/
├── manifest.json          MV3 manifest — the extension version lives here
├── background/            service worker (ES modules)
│   ├── sw.js              entry point; ALL event listeners registered
│   │                      synchronously at top level (SW wake contract)
│   ├── constants.js       message types, alarm names, defaults, limits
│   ├── store.js           storage schema + load/patch + event ring buffer
│   ├── scheduler.js       jitter + quiet-hours math (pure, tested)
│   ├── tab-manager.js     find/reload the user's orders tab, nag logic
│   ├── check-runner.js    the check pipeline (spans multiple SW wakes)
│   ├── differ.js          change detection + pruning (pure, tested)
│   ├── sanitize.js        boundary validation (pure, tested)
│   ├── notifier.js        desktop notifications + click routing
│   ├── mailer.js          email building + relay POST + caps/retry
│   └── icon.js            toolbar icon state machine + badge (pure resolver)
├── content/content.js     the scraper — plain script (NOT a module),
│                          selectors centralized in the SELECTORS table
├── popup/                 status + controls + CSV export
├── options/               settings UI (talks to the SW via messages)
├── apps-script/Code.gs    the email relay users deploy (Apps Script dialect)
├── icons/                 aom*.png (active), aom-quiet*.png (quiet hours)
├── tests/test.mjs         Node test suite for the pure modules
└── docs/DEBUG.md          console recipes for manual verification
```

## File Naming Conventions

- **Background modules:** kebab-case (`check-runner.js`, `tab-manager.js`)
- **Functions/variables:** `camelCase` (`runCheck`, `ordersUrl`)
- **Constants:** `UPPER_SNAKE_CASE`, defined in `constants.js` when shared
- **Message types:** `AOM_*` strings (`AOM_SCRAPE_RESULT`) — duplicated by
  convention in `content/content.js` (content scripts can't import modules);
  keep them in sync with `constants.js`
- **Alarm and notification ids:** `aom-*` (`aom-check`, `aom-icon-sync`)
- **Apps Script:** private helpers end in an underscore (`rateLimited_`),
  per Apps Script convention; `RELAY_VERSION` must match the header comment
- **Icons:** `aom{16,48,128}.png`, `aom-quiet{16,48,128}.png`

## Architectural invariants (do not break these)

These encode the project's hard-won lessons. Changing any of them needs an
issue discussion first, not just a PR.

1. **The service worker is a cold-start machine.** Every wake starts fresh:
   no module-level state you depend on, all persistence through
   `store.js` (`chrome.storage.local`), in-flight check bookkeeping in
   `chrome.storage.session`, and timeouts via **alarms — never
   `setTimeout`**. Event listeners must be registered synchronously at the
   top level of `sw.js` or Chrome won't wake the worker for them.
2. **The service worker is the sole storage writer.** Extension pages
   (popup/options) read and mutate state only via messages
   (`AOM_GET_CONFIG` / `AOM_UPDATE_CONFIG` etc.), never by writing
   `chrome.storage` directly — two realms writing whole-state objects race.
3. **Everything crossing into the SW is sanitized** in `sanitize.js`:
   schema, size caps, enums, URL origins. New inputs get new sanitizers.
4. **An order missing from a scrape is NEVER a change.** Orders scroll off
   the page's time filter naturally; a broken selector must be structurally
   unable to produce "everything was canceled" events. Related: an empty
   scrape is an anomaly (counted, then warned) — never diffed as truth.
5. **Notification and email delivery are isolated.** A failure in one must
   never prevent the other, and the schedule re-arm runs in a `finally`.
6. **The toolbar icon state is derived, never tracked** — `resolveIconState`
   (priority `paused > quiet > default`) re-evaluated on every trigger.
7. **Emails are plain text.** Item titles are untrusted marketplace text;
   CSV cells are formula-neutralized. Keep it that way.
8. **Quiet hours are local wall-clock time** everywhere.
9. **No remote code, no analytics, no third-party endpoints.** The only
   network destinations are amazon.com (scrape) and the user's own Apps
   Script deployment (email).

## Workflow Guidelines

### Before starting work

1. Read `README.md` (architecture + behavior contract), this file, and
   `docs/DEBUG.md` (how to exercise everything quickly)
2. Review related issues/PRs; understand the request completely
3. Check existing patterns — especially `constants.js` (shared vocabulary)
   and `store.js` (schema; bump `schemaVersion` + add a migration for any
   stored-shape change)

### During development

- There is **no build step**: edit files, reload the unpacked extension at
  `chrome://extensions`. Note that extension *pages* load fresh from disk
  when opened, but the *service worker* keeps running old code until the
  extension is reloaded — mixed-version confusion is real
- Keep changes small and focused; one concern per PR
- New pure logic goes in a pure module so it can be tested

### After implementation

1. Run the test suite: `node tests/test.mjs` (Node 18+, no deps)
2. Syntax-check changed files (`node --check` works for plain scripts;
   module files parse via the test imports)
3. Manually verify with the recipes in `docs/DEBUG.md` (simulated changes,
   quiet-hours math, empty-scrape guard, SW-death resilience)
4. Update `README.md`, `docs/DEBUG.md`, and `CHANGELOG.md` as applicable;
   bump versions per [CONTRIBUTING.md](CONTRIBUTING.md)
5. Fill out the PR template, tag AI assistance, request human review

## Do's ✅

- DO use `chrome.runtime.getURL()` for **any** resource path used from the
  service worker (notification `iconUrl`, `action.setIcon` paths, `fetch`
  of packaged files). Relative paths resolve against `background/`, 404,
  and fail *silently* — this exact bug shipped twice
- DO register SW event listeners synchronously at the top level
- DO use one-shot self-rescheduling alarms (never `periodInMinutes`, never
  `setTimeout`) and re-arm on `onStartup`/`onInstalled`
- DO add fallback selectors to the `SELECTORS` table in `content/content.js`
  rather than replacing existing ones — Amazon serves varying DOM
- DO log meaningful events via `store.logEvent` — the event ring buffer is
  the primary debugging tool users paste into bug reports
- DO wrap `fetch` calls with an `AbortController` timeout well under 30 s
  (a slow response kills the whole service worker)
- DO keep `RELAY_VERSION` and the `Code.gs` header comment in sync, and
  remember relay changes only go live after a new Apps Script deployment
  version
- DO add tests to `tests/test.mjs` for pure-logic changes
- DO ask for clarification when requirements are unclear

## Don'ts ❌

- DON'T commit credentials, deployment URLs, or secrets — the relay secret
  lives only in the user's extension storage and Script Properties
- DON'T add manifest permissions or host permissions without discussion
  (the warning-free permission set is a deliberate feature)
- DON'T use dynamic `import()` in the service worker — the HTML spec
  forbids it; use static imports and the `AOM` debug global instead
- DON'T make `content/content.js` an ES module — content scripts can't be
- DON'T write to the clipboard outside an explicit popup action
- DON'T write `chrome.storage` from extension pages (single-writer rule)
- DON'T interpret order absence as cancellation, or diff an empty scrape
- DON'T send scraped content as HTML email, or skip CSV formula
  neutralization
- DON'T use browser-only APIs in `Code.gs` — it's Apps Script: no `fetch`
  (use `UrlFetchApp`), no DOM, no modules, and all web-app responses are
  HTTP 200 with the real status in the JSON body
- DON'T merge without human review, and DON'T submit untested code

<!-- myco:managed:start -->
## Myco Managed Guidance

- When `capture.ignore_plan_dirs_in_git` is enabled, custom directories in `capture.plan_dirs` may be intentionally gitignored after capture into Myco.
- Do not force-add files from intentionally gitignored custom plan directories unless the user explicitly asks.
- When orienting in this codebase — finding a feature, locating files relevant to a change, or understanding an unfamiliar subsystem — use Myco first: call `myco tool call myco_cortex --json --input '{"op":"canopy_map"}'` as the CLI path, or `myco_cortex({"op":"canopy_map"})` via MCP when the host exposes Myco tools cleanly, before falling back to Glob/Grep.
<!-- myco:managed:end -->
