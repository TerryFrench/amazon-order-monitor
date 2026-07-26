# Contributing

Thank you for your interest in contributing to the Amazon Order Monitor
project! This document provides guidelines and instructions for
contributing to this project, whether you're a human developer or an AI
coding assistant.

## Code of Conduct

This project adheres to a code of conduct that promotes a welcoming and
inclusive environment. All contributors are expected to:

* Be respectful and considerate in all interactions
* Accept constructive criticism gracefully
* Focus on what is best for the project and community
* Show empathy towards other community members

## Reporting bugs

Please report bugs as [GitHub issues](https://github.com/TerryFrench/amazon-order-monitor/issues)
using the bug-report template. **Always include:**

1. **Reproduction steps** — numbered, from a clean state if possible.
2. **The event log** — this is the single most useful thing you can
   provide. To get it: extension **Options** page → scroll to the
   **Debug** section (click to expand) → **Show event log** → copy and
   paste it into the issue. Feel free to redact order IDs and item names —
   the event *shapes* and timestamps are what matter.
3. Your extension version (`chrome://extensions`), Chrome version
   (`chrome://version`), and OS.

## Feature requests

Feature requests are welcome — also as GitHub issues, using the
feature-request template so they're labeled `enhancement`. Describe the
problem you're trying to solve, not only the solution you have in mind.

## Where help is wanted

* **Better icons!** If you can improve the toolbar/notification icon set
  (`icons/`), open a PR — or, if you're not comfortable with pull
  requests, open an issue and attach your images there; we'll take it
  from that.
* Other Amazon marketplaces (`.fr`, `.de`, `.co.uk`, …): the date parsing
  and DOM selectors are centralized but English/amazon.com-only today.
* See open issues labeled `enhancement` or `help wanted`.

## Forks

This is MIT-licensed — fork away. We ask one courtesy: **if you fork or
build on this project, please keep a visible link back to the original
repository** (https://github.com/TerryFrench/amazon-order-monitor) in your
README, so improvements and bug reports can find their way home.

## Development setup

No build step, no dependencies:

1. Clone, then `chrome://extensions` → Developer mode → **Load unpacked**
   → the repo folder.
2. Tests: `node tests/test.mjs` (Node 18+). They cover the pure modules
   (scheduler, differ, sanitizers, icon state machine) and the content
   script's CSV path.
3. Manual verification recipes (simulated order changes, quiet-hours math,
   failure injection): [docs/DEBUG.md](docs/DEBUG.md).
4. Architecture rules and conventions: [AGENTS.md](AGENTS.md) — written
   for AI assistants, equally binding for humans.

## Versioning

* The extension version lives in `manifest.json` (`"version"`). Bump the
  **patch** number for bug fixes, the **minor** number for user-visible
  features. Documentation-only changes don't need a bump.
* Add a matching entry to `CHANGELOG.md` under `[Unreleased]` or the new
  version heading.
* Changes to `apps-script/Code.gs` must also bump `RELAY_VERSION` (and the
  `Version` line in its header comment) — and note in the PR that users
  must redeploy ("Manage deployments → New version") for relay changes to
  take effect.
* **If you're unsure about any of this, skip the bump and say so in the
  PR description** — maintainers will version it on merge.

## Pull Request Description Template

(Also auto-filled from `.github/PULL_REQUEST_TEMPLATE.md` when you open a PR.)

```
## Description

Brief description of what this PR does.

## Type of Change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update

## Testing

Describe the tests you ran and how to reproduce them.

## Checklist

- [ ] My code follows the style guidelines of this project
- [ ] I have performed a self-review of my own code
- [ ] I have commented my code, particularly in hard-to-understand areas
- [ ] I have made corresponding changes to the documentation
- [ ] My changes generate no new warnings
- [ ] When possible, I have added tests that prove my fix is effective or that my feature works
- [ ] New and existing unit tests pass locally with my changes (`node tests/test.mjs`)
- [ ] I have bumped the version + CHANGELOG, or noted in the description that maintainers should
- [ ] Any dependent changes have been merged and published
```

## AI-Assisted Contributions

### Transparency Requirements

When AI coding assistants contribute to this project:

1. **Tag Contributions**: Add a note in the PR description indicating AI
   assistance:

```
## AI Assistance

This PR was created with assistance from [AI Tool Name].
```

2. **Human Review**: All AI-generated code must be reviewed by a human
   developer
3. **Testing**: AI-generated code must include tests where the logic is
   testable (see `tests/test.mjs`)
4. **Documentation**: AI-generated code must be well-documented

### AI-Specific Guidelines

* AI assistants should follow the guidelines in [AGENTS.md](AGENTS.md)
* Never commit sensitive data (credentials, relay URLs, secrets, etc.)
* Configuration belongs in the options page / `chrome.storage` — never
  hardcoded
* Follow the principle of least privilege for permissions (the extension's
  warning-free permission set is a deliberate feature)
* Include clear explanations for complex logic

## Questions?

If you have questions about contributing:

1. Check existing documentation in the repository
2. Search for similar issues or pull requests
3. Open a new issue with the `question` label
4. Reach out to maintainers
