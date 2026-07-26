# Changelog

All notable changes to this project are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions
follow the extension's `manifest.json` version (patch = fixes, minor =
user-visible features); the Apps Script relay has its own `RELAY_VERSION`,
noted here when it changes.

## [Unreleased]

### Added
- Community/project files: `CONTRIBUTING.md`, `AGENTS.md`, issue and PR
  templates, this changelog.
- In-repo test suite: `node tests/test.mjs` (scheduler, differ, sanitizers,
  icon state machine, content-script CSV path).

### Removed
- The `spike/` capability experiments. Everything they existed to prove
  (jittered alarms across SW death/restart, tab query without the `tabs`
  permission, notification buttons on Windows, the Apps Script relay
  round-trip) has been verified in the shipped extension. They remain in
  git history.

## [1.0.3] — 2026-07-25

Initial public release. Relay version 1.0.1.

- Monitors the user's own open Amazon "Your Orders" tab on a jittered
  schedule (default 45–75 min) with configurable local-time quiet hours.
- Change detection (new order / status transitions / arrival-date moves)
  with structural safety guards: order absence is never a change; empty
  scrapes are anomalies, never diffed.
- Desktop notifications and batched plain-text emails via a self-deployed
  Google Apps Script relay (no OAuth, no third-party servers).
- State-aware toolbar icon (active / quiet-hours "Zzz" / paused) driven by
  a derived state machine, plus a red "!" badge when monitoring needs
  attention (no orders tab, signed out).
- CSV export of the current orders page (formula-injection-neutralized).
- Security hardening from an external review: true pause semantics,
  boundary sanitization, URL allowlists, single-writer storage, atomic
  relay rate limiting.
- Debug tooling: event ring buffer, SW-console recipes (`docs/DEBUG.md`).

Versions before 1.0.3 predate the public repository and are not tracked.
