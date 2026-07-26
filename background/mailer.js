// Email dispatch via the user's own Apps Script relay.
// Plain-text only (scraped item titles are untrusted strings — plain text
// makes header/HTML injection moot; the relay sanitizes again server-side).

import { LIMITS } from "./constants.js";
import * as store from "./store.js";
import * as notifier from "./notifier.js";

function localDayKey(d = new Date()) {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function truncate(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ---- content builders ---------------------------------------------

export function buildSubject(changes) {
  if (changes.length === 1) {
    const c = changes[0];
    const item = truncate((c.order.items && c.order.items[0]) || c.orderId, 60);
    return `[Amazon Orders] ${notifier.changeLabel(c)}: ${item}`;
  }
  const counts = new Map();
  for (const c of changes) {
    const label = notifier.changeLabel(c).toLowerCase();
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const summary = [...counts.entries()].map(([label, n]) => `${n} ${label}`).join(", ");
  return `[Amazon Orders] ${changes.length} updates: ${summary}`;
}

export function buildBody(changes, now = new Date()) {
  const lines = [];
  lines.push(
    `Amazon order updates — ${now.toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    })}`
  );
  lines.push("");

  for (const c of changes) {
    lines.push("────────────────────────────────────────");
    lines.push(`${notifier.changeLabel(c).toUpperCase()} — order ${c.orderId}`);
    if (c.prev && (c.kind === "status_changed" || c.kind === "arrival_date_changed")) {
      lines.push(`  Was: ${c.prev.statusRaw || c.prev.statusCategory || "?"}`);
      lines.push(`  Now: ${c.order.statusRaw || c.order.statusCategory || "?"}`);
    } else if (c.order.statusRaw) {
      lines.push(`  Status: ${c.order.statusRaw}`);
    }
    const facts = [];
    if (c.order.placedDateRaw) facts.push(`Placed ${c.order.placedDateRaw}`);
    if (c.order.totalRaw) facts.push(`Total ${c.order.totalRaw}`);
    if (facts.length) lines.push(`  ${facts.join(" · ")}`);
    if (c.order.items && c.order.items.length) {
      lines.push("  Items:");
      for (const item of c.order.items.slice(0, 10)) {
        lines.push(`    - ${truncate(item, 120)}`);
      }
      if (c.order.items.length > 10) {
        lines.push(`    …and ${c.order.items.length - 10} more`);
      }
    }
    if (c.order.detailsUrl) lines.push(`  ${c.order.detailsUrl}`);
    lines.push("");
  }

  lines.push("────────────────────────────────────────");
  lines.push("Sent by Amazon Order Monitor via your own Apps Script relay.");
  return lines.join("\n");
}

// ---- relay transport ----------------------------------------------

// POST as text/plain: keeps it a "simple request" (no CORS preflight — Apps
// Script can't answer OPTIONS). The 302 redirect to script.googleusercontent
// .com is followed automatically; that host permission must stay in the
// manifest. Abort well under 30s: a slow fetch would kill the whole SW.
export async function postToRelay(cfg, subject, body) {
  if (!cfg.relayUrl || !cfg.relaySecret) {
    return { ok: false, error: "relay not configured" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIMITS.RELAY_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(cfg.relayUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ secret: cfg.relaySecret, subject, body }),
      signal: controller.signal
    });
    const text = await resp.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      // Apps Script error/login HTML page — treat as failure below.
    }
    if (resp.ok && parsed && parsed.ok === true) {
      return { ok: true, remaining: parsed.remaining, version: parsed.version };
    }
    return {
      ok: false,
      error:
        (parsed && parsed.error) ||
        `HTTP ${resp.status}: ${text.slice(0, 120)}`
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// ---- dispatch with cap + retry buffer ------------------------------

async function recordSent() {
  const dayKey = localDayKey();
  await store.patch((s) => {
    if (s.meta.emailDayKey !== dayKey) {
      s.meta.emailDayKey = dayKey;
      s.meta.emailsSentToday = 0;
    }
    s.meta.emailsSentToday += 1;
    s.meta.lastEmailAt = Date.now();
  });
}

async function underDailyCap() {
  const state = await store.load();
  const dayKey = localDayKey();
  const count = state.meta.emailDayKey === dayKey ? state.meta.emailsSentToday : 0;
  return count < LIMITS.EMAILS_PER_DAY;
}

// Send one batched email for this check cycle's changes.
export async function maybeSendChangeEmail(changes, cfg) {
  if (!cfg.emailEnabled) return;
  if (!cfg.relayUrl || !cfg.relaySecret) return;
  if (!(await underDailyCap())) {
    await store.logEvent("mail.cap-hit", { cap: LIMITS.EMAILS_PER_DAY });
    return;
  }

  const subject = buildSubject(changes);
  const body = buildBody(changes);
  const res = await postToRelay(cfg, subject, body);

  if (res.ok) {
    await recordSent();
    await store.logEvent("mail.sent", { subject, remainingQuota: res.remaining });
  } else {
    await store.patch((s) => {
      s.meta.pendingEmail = { subject, body, createdAt: Date.now() };
    });
    await store.logEvent("mail.failed", { subject, error: res.error });
    await notifier.maybeNotifyEmailFailed();
  }
}

// Retry the stashed email once per check cycle; drop after 24h.
export async function retryPendingEmail(cfg) {
  const state = await store.load();
  const pending = state.meta.pendingEmail;
  if (!pending) return;

  if (Date.now() - pending.createdAt > LIMITS.PENDING_EMAIL_TTL_MS) {
    await store.patch((s) => {
      s.meta.pendingEmail = null;
    });
    await store.logEvent("mail.retry-dropped", { subject: pending.subject });
    return;
  }
  if (!cfg.emailEnabled || !(await underDailyCap())) return;

  const res = await postToRelay(cfg, pending.subject, pending.body);
  if (res.ok) {
    await store.patch((s) => {
      s.meta.pendingEmail = null;
    });
    await recordSent();
    await store.logEvent("mail.retry-sent", { subject: pending.subject });
  } else {
    await store.logEvent("mail.retry-failed", { error: res.error });
  }
}

export async function sendTestEmail() {
  const state = await store.load();
  // Test emails count toward the daily cap too (review F-03) — otherwise
  // the "20/day client-side" claim would be false.
  if (!(await underDailyCap())) {
    return { ok: false, error: `daily email cap reached (${LIMITS.EMAILS_PER_DAY}/day)` };
  }
  const res = await postToRelay(
    state.config,
    "[Amazon Orders] Test email",
    [
      "This is a test from Amazon Order Monitor.",
      "",
      "If you're reading it, your Apps Script relay is working:",
      "the extension will email you here whenever an order changes.",
      `Sent ${new Date().toLocaleString()}`
    ].join("\n")
  );
  if (res.ok) await recordSent();
  await store.logEvent("mail.test", res);
  return res;
}
