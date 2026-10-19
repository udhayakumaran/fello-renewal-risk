/**
 * CSM web app. Every page reads through the database as the signed-in user: the org and CSM come
 * from the session cookie, and Postgres row-level security filters every query by them. Isolation
 * is only as good as that cookie check, so it is kept strict: HMAC signature, expiry, and claims
 * set from the verified session only (see withSession and db.ts asUser).
 *
 * Trust boundary: this app verifies the cookie and then sets the database claims itself. That is
 * not the same as a token the database verifies. A bug in this file that sets the wrong claims
 * would widen access. The tests in test/ cover the cases that matter.
 *
 * Login here is a development stand-in: pick an org and a CSM. A real deployment would use the
 * company's sign-in (Supabase Auth or SSO) and issue the same org claim.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import express from "express";
import type pg from "pg";
import { asUser, webPool } from "../db.js";
import { describeRate, type Evidence } from "../evidence.js";
import { baseRate, bandOf, type Band, CONTACT_WINDOW_DAYS, CALL_CAPACITY, splitCalls } from "../ranking.js";

export interface Session {
  org: string;
  csm: string;
}

const COOKIE = "csm_session";
const SESSION_MS = 12 * 60 * 60 * 1000; // sign-in lasts half a working day

// ---------- signed session cookie ----------

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Signed cookie: base64url(JSON with org, csm and exp in ms) + "." + HMAC. ttlMs is for tests. */
export function makeCookie(session: Session, secret: string, ttlMs = SESSION_MS): string {
  const payload = Buffer.from(JSON.stringify({ ...session, exp: Date.now() + ttlMs })).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

/** Constant-time comparison for shared secrets. */
export function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function readCookie(value: string | undefined, secret: string): Session | null {
  if (!value) return null;
  const [payload, mac] = value.split(".");
  if (!payload || !mac) return null;
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<Session> & { exp?: number };
    const live = typeof parsed.exp === "number" && parsed.exp > Date.now();
    return live && typeof parsed.org === "string" && typeof parsed.csm === "string" ? { org: parsed.org, csm: parsed.csm } : null;
  } catch {
    return null;
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ---------- rendering helpers ----------

export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const money = (n: number | null | undefined): string =>
  n === null || n === undefined ? "n/a" : `$${Math.round(Number(n)).toLocaleString("en-US")}`;
const pct = (p: number | null | undefined): string => (p === null || p === undefined ? "n/a" : `${(Number(p) * 100).toFixed(1)}%`);

interface Reason {
  feature: string;
  label: string;
  value: number;
  weight: number;
  contribution: number;
  sources: { ids: string[]; count: number };
  evidence?: Evidence;
}

const BAND_LABEL: Record<Band, string> = { red: "Red", amber: "Amber", green: "Green" };
const BAND_TIP: Record<Band, string> = {
  red: "Red: Much more likely to leave than a typical customer, at least 2 times the usual rate.",
  amber: "Amber: More likely to leave than usual.",
  green: "Green: About normal or lower.",
};
const HEADER_HELP = {
  chance: "If it shows 5%, about 5 in 100 customers like this one left at renewal.",
  money: "A $10,000 contract with a 5% chance of leaving shows $500 at risk.",
  renewal: "When this contract is up for renewal.",
  why: "What looks different about this account compared with a typical customer.",
};

let tipSeq = 0;
/**
 * A tooltip on one trigger. Hover and keyboard focus show it in CSS, a tap toggles it (TIP_SCRIPT).
 * The trigger points at the text with aria-describedby, so screen readers announce it too.
 */
function tip(trigger: (id: string) => string, text: string): string {
  const id = `tip-${++tipSeq}`;
  return `<span class="tip">${trigger(id)}<span role="tooltip" id="${id}" class="tip-text">${esc(text)}</span></span>`;
}

function riskPill(p: number | null, rate: number): string {
  if (p === null) return "<span class='muted'>n/a</span>";
  const band = bandOf(Number(p), rate);
  return tip((id) => `<span class="risk ${band}" tabindex="0" aria-describedby="${id}">${pct(p)}</span>`, BAND_TIP[band]);
}

/** Info button for a column header. It sits after the sort button, so the sort script still finds the sort button first. */
const headTip = (label: string, text: string): string =>
  tip((id) => `<button type="button" class="tip-btn" aria-label="About ${esc(label)}" aria-describedby="${id}">?</button>`, text);

/** Typical value per model input: the training average the model centres each input on. */
export function typicalByFeature(names: string[], means: number[]): Map<string, number> {
  return new Map(names.map((name, j) => [name, means[j] ?? 0]));
}

const plain = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(1));
const signedPct = (fraction: number): string => {
  const p = Math.round(fraction * 100);
  return `${p > 0 ? "+" : ""}${p}%`;
};

/** Display units per feature. Model means for these are on a log or fraction scale, so they are converted here. */
const SHOWN: Record<string, (v: number) => string> = {
  log_contract_value: (v) => money(v),
  usage_log_ratio: (v) => signedPct(Math.exp(v) - 1),
  inactive_contact_share: (v) => `${Math.round(v * 100)}%`,
  tenure_days: (v) => `${Math.round(v)} days`,
};

/**
 * One reason chip: this account's value next to the typical one, e.g. "Support tickets still open: 9 vs typical 3".
 * Typical is the training average (models.feature_mean), not this month's portfolio.
 */
export function reasonDetail(r: Reason, typicalMean: number | undefined): string {
  const shown = SHOWN[r.feature] ?? plain;
  if (r.feature === "log_contract_value") {
    // A missing contract value is stored as log 0, which reads as $1. Say so instead.
    if (r.value <= 1) return "Contract value: not in CRM";
    const typical = typicalMean === undefined ? "" : ` vs typical ${shown(Math.exp(typicalMean))}`;
    return `Contract value: ${shown(r.value)}${typical}`;
  }
  if (typicalMean === undefined) return `${r.label}: ${shown(r.value)}`;
  return `${r.label}: ${shown(r.value)} vs typical ${shown(typicalMean)}`;
}

const plural = (n: number, word: string): string => `${n} ${n === 1 ? word : `${word}s`}`;

/**
 * Plain sentence for one reason chip, shown as its tooltip. Counts use the same template:
 * "This account has 9 open support tickets, while a typical customer has 3."
 */
export function reasonSentence(r: Reason, typicalMean: number | undefined): string {
  const against = (own: string, typical: string | undefined): string =>
    typicalMean === undefined || typical === undefined ? `${own}.` : `${own}, while a typical customer has ${typical}.`;
  const counted = (word: string, tail: string): string =>
    against(`This account has ${plural(Math.round(r.value), word)}${tail}`, typicalMean === undefined ? undefined : String(Math.round(typicalMean)));
  switch (r.feature) {
    case "usage_now_90d":
      return counted("product event", " in the last 90 days");
    case "usage_prior_90d":
      return counted("product event", " in the 90 days before that");
    case "tickets_open":
      return counted("open support ticket", "");
    case "tickets_opened_90d":
      return counted("support ticket", " opened in the last 90 days");
    case "cancel_warning_120d":
      return counted("cancel-at-renewal request", " in the last 120 days");
    case "downgrade_120d":
      return counted("downgrade", " in the last 120 days");
    case "usage_drop": {
      const change = (v: number): string => (v >= 0 ? `dropped by ${Math.round(v)}` : `rose by ${Math.round(-v)}`);
      return against(`This account's product events ${change(r.value)} over the last 180 days`, typicalMean === undefined ? undefined : change(typicalMean));
    }
    case "usage_log_ratio":
      return against(
        `This account's product events changed by ${signedPct(Math.exp(r.value) - 1)} from the 90 days before`,
        typicalMean === undefined ? undefined : `changed by ${signedPct(Math.exp(typicalMean) - 1)}`,
      );
    case "tenure_days":
      return against(`This account has been a customer for ${Math.round(r.value)} days`, typicalMean === undefined ? undefined : `been one for ${Math.round(typicalMean)} days`);
    case "inactive_contact_share":
      return against(
        `${Math.round(r.value * 100)}% of this account's contacts are marked inactive`,
        typicalMean === undefined ? undefined : `${Math.round(typicalMean * 100)}% of its contacts inactive`,
      );
    case "log_contract_value":
      if (r.value <= 1) return "This account has no contract value in the CRM, so it shows $0 at risk.";
      return against(`This account's contract is ${money(Math.exp(r.value))}`, typicalMean === undefined ? undefined : money(Math.exp(typicalMean)));
    default:
      return `${reasonDetail(r, typicalMean)}.`;
  }
}

function topReasons(reasons: Reason[], n: number, typical: Map<string, number>): string {
  const positive = reasons.filter((r) => r.contribution > 0).slice(0, n);
  if (positive.length === 0) return "<span class='muted'>No warning signs</span>";
  return positive
    .map((r) =>
      tip(
        (id) => `<span class="chip" tabindex="0" aria-describedby="${id}">${esc(reasonDetail(r, typical.get(r.feature)))}</span>`,
        reasonSentence(r, typical.get(r.feature)),
      ),
    )
    .join(" ");
}

/**
 * Click a sortable header: first click uses data-first, second flips it, third restores ranking order.
 * Rows are sorted from the ranking order each time, so equal values keep their rank (stable sort).
 * Missing values (data-sort empty) sort last in both directions.
 */
export const SORT_SCRIPT = `<script>
(() => {
  const ICON = { none: "↕", ascending: "▲", descending: "▼" };
  document.querySelectorAll("table.sortable").forEach((table) => {
    const body = table.tBodies[0];
    const ranking = Array.from(body.rows);
    table.querySelectorAll("th[data-first]").forEach((th) => {
      const button = th.querySelector("button");
      const icon = th.querySelector(".sort-icon");
      const numeric = th.dataset.type === "number";
      const index = th.cellIndex;
      button.addEventListener("click", () => {
        const first = th.dataset.first;
        const current = th.getAttribute("aria-sort");
        const next = current === "none" || current === null ? first : current === first ? (first === "ascending" ? "descending" : "ascending") : "none";
        table.querySelectorAll("th[aria-sort]").forEach((other) => {
          other.setAttribute("aria-sort", "none");
          other.querySelector(".sort-icon").textContent = ICON.none;
        });
        th.setAttribute("aria-sort", next);
        icon.textContent = ICON[next];
        const dir = next === "ascending" ? 1 : next === "descending" ? -1 : 0;
        const value = (row) => row.cells[index].dataset.sort ?? "";
        const rows = dir === 0 ? ranking : ranking.slice().sort((x, y) => {
          const a = value(x);
          const b = value(y);
          if (a === "" || b === "") return (a === "") - (b === "");
          return dir * (numeric ? Number(a) - Number(b) : a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }));
        });
        body.append(...rows);
      });
    });
  });
})();
</script>`;

/** Tooltip styles. Lives in a constant so the browser test page can include the same rules. */
export const TIP_CSS = `
.tip { position: relative; display: inline-block; max-width: 100%; }
.tip-btn { width: 18px; height: 18px; margin-left: 4px; padding: 0; vertical-align: middle; border: 1px solid var(--line); border-radius: 50%; background: var(--chip); color: var(--muted); font: 600 11px/1 system-ui, sans-serif; cursor: pointer; }
.tip-text { display: none; position: absolute; top: calc(100% + 6px); left: 0; z-index: 10; width: max-content; max-width: 260px; padding: 8px 10px; border-radius: 8px; background: #1f2430; color: #fff; font: 400 12.5px/1.4 Inter, system-ui, sans-serif; text-align: left; text-transform: none; letter-spacing: normal; white-space: normal; box-shadow: 0 4px 12px rgba(0,0,0,.2); }
.tip.open > .tip-text, .tip > [aria-describedby]:focus-visible ~ .tip-text { display: block; }
.tip.dismissed > .tip-text { display: none !important; }
@media (hover: hover) { .tip:hover > .tip-text { display: block; } }
.tip-btn:focus-visible, .chip:focus-visible, .risk:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
`;

/** Tap or click a tooltip trigger to open its tooltip (touch has no hover). Tapping elsewhere or pressing Escape closes it. */
export const TIP_SCRIPT = `<script>
(() => {
  document.addEventListener("click", (e) => {
    const trigger = e.target.closest(".tip > [aria-describedby]");
    document.querySelectorAll(".tip.open").forEach((t) => { if (t !== trigger?.parentElement) t.classList.remove("open"); });
    trigger?.parentElement.classList.toggle("open");
  });
  // Escape dismisses even while the trigger keeps keyboard focus. Moving focus to another trigger shows tooltips again.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") document.querySelectorAll(".tip").forEach((t) => { t.classList.remove("open"); t.classList.add("dismissed"); });
  });
  document.addEventListener("focusin", () => document.querySelectorAll(".tip.dismissed").forEach((t) => t.classList.remove("dismissed")));
})();
</script>`;

/**
 * Filters every call-list group by account name as you type. Each group filters its own rows, so
 * a match in Watch list never pulls a row into This week's calls. Hidden rows stay in the table,
 * so the column sort still works on the full group and the filter still applies after a sort.
 */
export const SEARCH_SCRIPT = `<script>
(() => {
  const input = document.getElementById("account-search");
  input.addEventListener("input", () => {
    const query = input.value.trim().toLowerCase();
    document.querySelectorAll("[data-group]").forEach((group) => {
      let shown = 0;
      Array.from(group.querySelector("tbody").rows).forEach((row) => {
        const match = row.querySelector("td.account").dataset.sort.toLowerCase().includes(query);
        row.hidden = !match;
        if (match) shown += 1;
      });
      group.querySelector("[data-no-match]").hidden = shown > 0;
    });
  });
})();
</script>`;

/** The "How this list works" bullets as [label, text]. Numbers come from ranking.ts so they stay true. */
export const HOW_LIST_WORKS: [string, string][] = [
  ["The percentage", "Think of 100 customers like this one, with similar usage, support tickets and contract. About this many of them left when their renewal came up."],
  ["Why it's here", "Each chip is something that looks different from a normal customer. Use them as talking points on your call."],
  ["Money at risk", "This is how much of the contract could be lost. It's a rough guide for who to call first, not a forecast."],
  ["No contract value", "If we don't have the contract value, the account shows $0 and may sit lower than it should, so check the CRM."],
  ["This week's calls", `The ${CALL_CAPACITY} accounts with the most money at risk. Call these first.`],
  ["Watch list", "Next in line. Not urgent this week, but worth a check-in if you have time."],
  ["Not scored", "We don't have enough data yet. That doesn't mean the account is safe."],
  ["Recently contacted", `If you spoke to an account in the last ${CONTACT_WINDOW_DAYS} days, it's left off this week's list so you can focus on others.`],
];

/** One call-list group. Search hides rows inside it and shows the note when none match. */
const groupWrap = (tableHtml: string): string =>
  `<div class="group" data-group>${tableHtml}<div class="card empty" data-no-match hidden>No accounts in this group match that search.</div></div>`;

const sortHead = (label: string, cls: string, type: "text" | "number", first: "ascending" | "descending", help?: string): string =>
  `<th class="${cls}" aria-sort="none" data-type="${type}" data-first="${first}"><button type="button" class="sort-btn">${label}<span class="sort-icon" aria-hidden="true">↕</span></button>${help ? headTip(label, help) : ""}</th>`;

/** A sortable call table. Its rows are the only rows its sort touches, so groups never swap rows. */
export function callTable(rows: string[]): string {
  return groupWrap(
    `<div class="table-wrap"><table class="sortable"><thead><tr><th class="hide-sm">#</th>${sortHead("Account", "", "text", "ascending")}${sortHead("Chance of leaving", "num", "number", "descending", HEADER_HELP.chance)}${sortHead("Money at risk", "num", "number", "descending", HEADER_HELP.money)}${sortHead("Renewal", "hide-sm", "number", "ascending", HEADER_HELP.renewal)}<th class="why-col">Why${headTip("Why", HEADER_HELP.why)}</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`,
  );
}

function page(title: string, body: string, session: Session | null): string {
  const nav = session
    ? `<header class="top">
        <a class="brand" href="/">Renewal risk</a>
        <nav>
          <a href="/">This week</a>
          <a href="/unmatched">Unmatched</a>
          <a href="/runs">Run log</a>
        </nav>
        <div class="who">
          <span class="avatar">${esc("C" + (session.csm.split("-").pop() ?? "").replace(/^CSM/, ""))}</span>
          <span><strong>${esc(session.csm)}</strong><small>${esc(session.org)}</small></span>
          <form method="post" action="/logout" class="inline"><button class="ghost">Sign out</button></form>
        </div>
      </header>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Renewal risk</title>
<style>
:root {
  --bg: #f6f7f9; --card: #ffffff; --fg: #15171c; --muted: #6b7079; --line: #e5e7eb;
  --accent: #3b4bd8; --accent-soft: #eef0ff; --chip: #f1f3f7; --chip-fg: #353a44;
  --ok: #0f7b4b; --ok-soft: #e7f6ee; --bad: #b42318; --bad-soft: #fdecea; --warn: #8a5a00; --warn-soft: #fff4dd;
  --shadow: 0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.08);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0f1115; --card: #171a21; --fg: #eceef2; --muted: #9aa1ad; --line: #272b35;
    --accent: #8d97ff; --accent-soft: #232844; --chip: #232731; --chip-fg: #d6d9e0;
    --ok: #5fd39a; --ok-soft: #173326; --bad: #ff8a80; --bad-soft: #3a1d1b; --warn: #f2c46d; --warn-soft: #3a2f16;
    --shadow: none;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14.5px/1.5 Inter, system-ui, -apple-system, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
main { max-width: 1120px; margin: 0 auto; padding: 24px 20px 48px; }
a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
h1 { font-size: 22px; line-height: 1.25; margin: 0 0 4px; letter-spacing: -.01em; }
h2 { font-size: 15px; margin: 28px 0 10px; letter-spacing: -.005em; }
p { margin: 0; }
.muted { color: var(--muted); } .small { font-size: 12.5px; }
.lede { color: var(--muted); margin-bottom: 18px; }

/* top bar */
.top { display: flex; align-items: center; gap: 18px; padding: 12px 20px; background: var(--card); border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 2; }
.brand { font-weight: 700; color: var(--fg); letter-spacing: -.01em; margin-right: 8px; }
.top nav { display: flex; gap: 14px; }
.top nav a { color: var(--muted); font-weight: 500; } .top nav a:hover { color: var(--fg); text-decoration: none; }
.who { margin-left: auto; display: flex; align-items: center; gap: 10px; }
.who > span:not(.avatar) { display: flex; flex-direction: column; line-height: 1.2; } .who small { color: var(--muted); font-size: 12px; }
.avatar { width: 32px; height: 32px; border-radius: 50%; background: var(--accent-soft); color: var(--accent); display: grid; place-items: center; font-weight: 700; font-size: 12px; }

/* cards and stats */
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; margin: 18px 0 6px; }
.stat { padding: 14px 16px; }
.stat .label { color: var(--muted); font-size: 12.5px; font-weight: 500; }
.stat .value { font-size: 24px; font-weight: 700; letter-spacing: -.01em; margin-top: 2px; font-variant-numeric: tabular-nums; }
.stat .hint { color: var(--muted); font-size: 12.5px; margin-top: 2px; }

/* tables */
.table-wrap { background: var(--card); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); overflow-x: auto; }
table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 14px; }
th, td { text-align: left; padding: 11px 14px; border-bottom: 1px solid var(--line); vertical-align: middle; }
tr:last-child td { border-bottom: 0; }
th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; background: var(--card); position: sticky; top: 0; }
tbody tr:hover td { background: var(--accent-soft); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td.date { white-space: nowrap; }
td.account a { font-weight: 600; color: var(--fg); } td.account a:hover { color: var(--accent); }
.sort-btn { font: inherit; text-transform: inherit; letter-spacing: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; }
.sort-btn:hover { color: var(--fg); filter: none; }
.sort-icon { font-size: 10px; opacity: .5; }
th[aria-sort]:not([aria-sort="none"]) .sort-icon { opacity: 1; color: var(--accent); }
th[aria-sort]:not([aria-sort="none"]) .sort-btn { color: var(--fg); }
.rank { display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; background: var(--chip); color: var(--chip-fg); font-size: 12px; font-weight: 600; }
.risk { display: inline-block; min-width: 64px; text-align: center; padding: 3px 9px; border-radius: 999px; font-weight: 600; font-variant-numeric: tabular-nums; }
.risk.red { background: var(--bad-soft); color: var(--bad); }
.risk.amber { background: var(--warn-soft); color: var(--warn); }
.risk.green { background: var(--ok-soft); color: var(--ok); }
.chip { display: inline-block; background: var(--chip); color: var(--chip-fg); border-radius: 999px; padding: 2px 9px; font-size: 12px; margin: 2px 4px 2px 0; white-space: nowrap; }
.why-inline { display: none; } .why-inline .chip { font-size: 11.5px; white-space: normal; max-width: 100%; text-align: left; }
.why-col .chip { white-space: normal; border-radius: 10px; line-height: 1.35; text-align: left; }
${TIP_CSS}
.how ul { margin: 8px 0 0; padding-left: 18px; } .how li { margin: 5px 0; } .how h2 { margin: 0; font-size: 16px; }
.how .small { margin: 10px 0 0; }
.chip.done { background: var(--ok-soft); color: var(--ok); }
.status { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; }
.status.succeeded { background: var(--ok-soft); color: var(--ok); }
.status.failed { background: var(--bad-soft); color: var(--bad); }
.status.running { background: var(--warn-soft); color: var(--warn); }

/* sections */
.section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin: 28px 0 10px; }
.section-head h2 { margin: 0; }
.banner { background: var(--warn-soft); color: var(--warn); padding: 10px 14px; border-radius: 10px; margin: 12px 0; }
.empty { padding: 28px; text-align: center; color: var(--muted); }
.callout { padding: 14px 16px; background: var(--accent-soft); border-radius: 10px; color: var(--fg); margin: 14px 0; }
.explain { color: var(--muted); font-size: 13px; margin: 0 0 10px; }
.search { margin: 0 0 10px; } .search input { width: 100%; max-width: 360px; }

/* buttons and forms */
button, .button { font: inherit; font-weight: 600; padding: 9px 16px; border-radius: 8px; border: 1px solid var(--accent); background: var(--accent); color: #fff; cursor: pointer; }
button:hover { filter: brightness(1.05); }
button.ghost { background: transparent; color: var(--muted); border-color: var(--line); padding: 6px 12px; font-weight: 500; }
button.ghost:hover { color: var(--fg); filter: none; }
input, select { font: inherit; padding: 9px 11px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--fg); min-width: 0; }
input:focus, select:focus, button:focus-visible, a:focus-visible { outline: 3px solid var(--accent-soft); outline-offset: 2px; border-color: var(--accent); }
label { display: block; font-size: 13px; color: var(--muted); font-weight: 500; }
label > select, label > input { display: block; width: 100%; margin-top: 6px; color: var(--fg); }

/* login */
.login { min-height: calc(100vh - 80px); display: grid; place-items: center; padding: 20px; }
.login-card { width: 100%; max-width: 420px; padding: 28px; }
.login-card h1 { margin-bottom: 6px; } .login-card form { display: grid; gap: 14px; margin-top: 18px; }
.login-card button { width: 100%; padding: 11px; }

/* account page */
.account-head { display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.check { font-size: 12.5px; color: var(--muted); background: var(--chip); padding: 10px 12px; border-radius: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: var(--chip); padding: 1px 5px; border-radius: 5px; word-break: break-all; }
.reason-label { font-weight: 600; }
.bar { height: 6px; background: var(--chip); border-radius: 999px; overflow: hidden; min-width: 60px; }
.bar > span { display: block; height: 100%; background: var(--accent); border-radius: 999px; }
.bar.neg > span { background: var(--ok); }
.footnote { margin-top: 36px; color: var(--muted); font-size: 12px; text-align: center; }

/* phones: keep chance, money and reasons on screen; rank and renewal date live on the account page */
@media (max-width: 640px) {
  .hide-sm { display: none; }
  .why-col { display: none; }
  .why-inline { display: block !important; margin-top: 6px; }
  .stats { grid-template-columns: 1fr 1fr; gap: 10px; }
  .stat { padding: 12px; }
  .stat .label { font-size: 12px; }
  main { padding: 16px 12px 40px; }
  .top { padding: 10px 12px; gap: 10px; flex-wrap: wrap; } .top nav { order: 3; width: 100%; }
  .who small { display: none; }
  .stat .value { font-size: 20px; }
  .search input { max-width: none; }
  th, td { padding: 10px 6px; }
  td.num { white-space: nowrap; }
  th.num { white-space: normal; }
  td.account { width: 100%; }
  td.account a { overflow-wrap: anywhere; }
  .risk { min-width: 0; padding: 2px 7px; }
  table { font-size: 13px; }
}
</style></head><body>${nav}<main>${body}</main>
<p class="footnote">Scores are an estimate from generated test data, not a forecast about real customers.</p>
</body></html>`;
}

// ---------- routes ----------

async function withSession<T>(pool: pg.Pool, session: Session, run: (client: pg.ClientBase) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    const claims = { role: "authenticated", sub: session.csm, org_id: session.org, csm_id: session.csm };
    return await asUser(client, claims, () => run(client));
  } finally {
    client.release();
  }
}

export function buildApp(pool: pg.Pool, secret: string, demoAccessCode: string | null = null): express.Express {
  const app = express();
  app.use(express.urlencoded({ extended: false }));

  const router = Router();
  const requireSession = (req: Request, res: Response, next: NextFunction): void => {
    const session = readCookie(parseCookies(req.headers.cookie)[COOKIE], secret);
    if (!session) {
      res.redirect("/login");
      return;
    }
    res.locals["session"] = session;
    next();
  };
  const sessionOf = (res: Response): Session => res.locals["session"] as Session;

  router.get("/login", async (_req, res) => {
    const people = await pool.query("select distinct org_id, owner_csm_id from sf_accounts where owner_csm_id <> '' order by 1, 2");
    const options = people.rows
      .map((r: { org_id: string; owner_csm_id: string }) => `<option value="${esc(r.org_id)}|${esc(r.owner_csm_id)}">${esc(r.org_id)} · ${esc(r.owner_csm_id)}</option>`)
      .join("");
    res.type("html").send(
      page(
        "Sign in",
        `<div class="login"><div class="card login-card"><h1>Sign in</h1><p class="lede small">Development stand-in for company sign-in. Pick a CSM to see their renewals.</p>
         <form method="post" action="/login">
         <label>CSM<select name="who">${options}</select></label>
         ${demoAccessCode ? '<label>Demo access code<input name="code" type="password" required></label>' : ""}<button>Sign in</button></form></div></div>`,
        null,
      ),
    );
  });

  router.post("/login", (req, res) => {
    const body = req.body as { who?: string; code?: string };
    const [org, csm] = String(body.who ?? "").split("|");
    if (!org || !csm) {
      res.redirect("/login");
      return;
    }
    if (demoAccessCode !== null && !sameSecret(String(body.code ?? ""), demoAccessCode)) {
      res.redirect("/login");
      return;
    }
    res.setHeader("Set-Cookie", `${COOKIE}=${encodeURIComponent(makeCookie({ org, csm }, secret))}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
    res.redirect("/");
  });

  router.post("/logout", (_req, res) => {
    res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    res.redirect("/login");
  });

  router.get("/", requireSession, async (_req, res) => {
    const session = sessionOf(res);
    const html = await withSession(pool, session, async (c) => {
      const published = (await c.query("select p.run_id, r.as_of, r.model_id from published_runs p join runs r using (run_id)")).rows[0];
      const latest = (await c.query("select status, as_of, error, started_at from runs order by started_at desc limit 1")).rows[0];
      const banner =
        latest && latest.status !== "succeeded"
          ? `<div class="banner">The latest run ${esc(latest.status)} (${esc(latest.as_of)}). Showing the last published run instead.</div>`
          : "";
      if (!published) return `${banner}<h1>No published run yet</h1>`;

      const rows = (
        await c.query(
          `select * from scores where run_id = $1 and owner_csm_id = $2
           order by (probability is null), money_at_risk desc nulls last, sf_id`,
          [published.run_id, session.csm],
        )
      ).rows as { sf_id: string; company_name: string; probability: number | null; money_at_risk: string | null; renewal_date: string | null; days_to_renewal: number; unknown_reason: string | null; reasons: Reason[] }[];
      const model = (await c.query("select training_leavers, training_rows, feature_names, feature_mean from models where model_id = $1", [published.model_id])).rows[0];
      const rate = baseRate(Number(model?.training_leavers ?? 0), Number(model?.training_rows ?? 0));
      const typical = typicalByFeature(model?.feature_names ?? [], (model?.feature_mean ?? []).map(Number));
      const contactedIds = new Set(
        (await c.query("select distinct sf_id from csm_actions where action_date > current_date - $1::int", [CONTACT_WINDOW_DAYS]))
          .rows.map((r: { sf_id: string }) => r.sf_id),
      );

      const unknown = rows.filter((r) => r.probability === null);
      const { calls: top, watch, contacted } = splitCalls(
        rows.map((r) => ({ ...r, id: r.sf_id, money: r.money_at_risk === null ? null : Number(r.money_at_risk) })),
        contactedIds,
      );
      const scored = rows.filter((r) => r.probability !== null);
      // data-sort holds the raw value the client-side sort reads; empty means no value (sorts last).
      const callRow = (r: (typeof rows)[number], rank: number | null): string => `<tr>
          <td class="hide-sm"><span class="rank">${rank ?? "n/a"}</span></td>
          <td class="account" data-sort="${esc(r.company_name)}"><a href="/account/${esc(r.sf_id)}">${esc(r.company_name)}</a><div class="why-inline">${topReasons(r.reasons, 2, typical)}</div></td>
          <td class="num" data-sort="${r.probability ?? ""}">${riskPill(r.probability, rate)}</td>
          <td class="num" data-sort="${r.money_at_risk ?? ""}">${money(r.money_at_risk === null ? null : Number(r.money_at_risk))}</td>
          <td class="date hide-sm" data-sort="${r.days_to_renewal}">${esc(r.renewal_date ?? "unknown")}<br><span class="muted small">${r.days_to_renewal} days</span></td>
          <td class="why-col">${topReasons(r.reasons, 3, typical)}</td>
        </tr>`;

      const callMoney = top.reduce((sum, r) => sum + Number(r.money_at_risk ?? 0), 0);
      const example = scored[0];
      // Two decimals, so a pill at the line is never shown as on the wrong side of it.
      const pctOf = (x: number): string => `${(x * 100).toFixed(2)}%`;
      return `${banner}
        <h1>Renewals to work this week</h1>
        <p class="lede small">Scored ${esc(published.as_of)} · scoring version ${esc(published.model_id)} · <a href="/runs">run log</a></p>
        <section class="callout how">
          <h2>How this list works</h2>
          <ul>
            ${HOW_LIST_WORKS.map(([label, text]) => `<li><strong>${esc(label)}:</strong> ${esc(text)}</li>`).join("\n            ")}
          </ul>
          ${example ? `<p class="small">Full math for any account is on its page, for example <a href="/account/${esc(example.sf_id)}">${esc(example.company_name)}</a>.</p>` : ""}
        </section>
        <div class="stats">
          <div class="card stat"><div class="label">Calls to make</div><div class="value">${top.length}</div><div class="hint">Top ${CALL_CAPACITY} by money at risk, not contacted in ${CONTACT_WINDOW_DAYS} days</div></div>
          <div class="card stat"><div class="label">Money at risk on those calls</div><div class="value">${money(callMoney)}</div><div class="hint">Chance of leaving × contract value</div></div>
          <div class="card stat"><div class="label">Renewals scored</div><div class="value">${scored.length}</div><div class="hint">Next 90 days</div></div>
          <div class="card stat"><div class="label">Not scored</div><div class="value">${unknown.length}</div><div class="hint">Shown as unknown, never as safe</div></div>
        </div>
        <p class="small"><span class="risk red">Red</span> at least ${pctOf(2 * rate)} chance (twice the typical ${pctOf(rate)}) · <span class="risk amber">Amber</span> at least ${pctOf(rate)} · <span class="risk green">Green</span> below that. Bands are set from how often past customers left, and move when the scoring is re-learned.</p>
        ${rows.length ? `<div class="search"><input id="account-search" type="search" placeholder="Search accounts" aria-label="Search accounts by name" autocomplete="off"></div>` : ""}
        <div class="section-head"><h2>This week's calls</h2><span class="muted small">Highest money at risk first</span></div>
        ${top.length ? callTable(top.map((r, i) => callRow(r, i + 1))) : "<div class='card empty'>No calls left this week. Everyone here was contacted recently, or nothing renews in the next 90 days.</div>"}
        <div class="section-head"><h2>Watch list</h2><span class="muted small">Next in line, after this week's calls</span></div>
        ${watch.length ? callTable(watch.map((r, i) => callRow(r, CALL_CAPACITY + i + 1))) : "<div class='card empty'>Nothing else to watch.</div>"}
        <div class="section-head"><h2>Contacted in the last ${CONTACT_WINDOW_DAYS} days</h2><span class="muted small">Off the call list until the window passes</span></div>
        ${contacted.length ? callTable(contacted.map((r) => callRow(r, null))) : "<div class='card empty'>No recent contacts.</div>"}
        <div class="section-head"><h2>Not scored</h2><span class="muted small">Shown as unknown with the reason, never as safe</span></div>
        ${unknown.length ? groupWrap(`<div class="table-wrap"><table><thead><tr><th>Account</th><th>Renewal</th><th>Reason</th></tr></thead><tbody>${unknown
          .map((r) => `<tr><td class="account" data-sort="${esc(r.company_name)}">${esc(r.company_name)}</td><td class="date">${esc(r.renewal_date ?? "unknown")} <span class="muted small">(${r.days_to_renewal} days)</span></td><td><span class="chip">${esc(r.unknown_reason)}</span></td></tr>`)
          .join("")}</tbody></table></div>`) : "<div class='card empty'>Every renewal in the window is scored.</div>"}
        ${SORT_SCRIPT}${TIP_SCRIPT}${rows.length ? SEARCH_SCRIPT : ""}`;
    });
    res.type("html").send(page("My renewals", html, session));
  });

  router.get("/account/:sfId", requireSession, async (req, res) => {
    const session = sessionOf(res);
    const sfId = String(req.params["sfId"]);
    const html = await withSession(pool, session, async (c) => {
      const published = (await c.query("select p.run_id, r.as_of, r.model_id from published_runs p join runs r using (run_id)")).rows[0];
      if (!published) return null;
      const row = (
        await c.query("select * from scores where run_id = $1 and sf_id = $2 and owner_csm_id = $3", [published.run_id, sfId, session.csm])
      ).rows[0];
      if (!row) return null;
      const model = (await c.query("select * from models where model_id = $1", [published.model_id])).rows[0];
      const accountRate = baseRate(Number(model?.training_leavers ?? 0), Number(model?.training_rows ?? 0));
      const reminders = (await c.query("select invoice_id, sent_at from card_reminders where sf_id = $1 order by sent_at desc limit 5", [sfId])).rows;
      const contacted = (
        await c.query(
          `select action_date::text as action_date, (action_date > current_date - $2::int) as recent, (action_date + $2::int)::text as back_on
           from csm_actions where sf_id = $1 order by action_date desc limit 1`,
          [sfId, CONTACT_WINDOW_DAYS],
        )
      ).rows[0];

      const reasons = row.reasons as Reason[];
      const sumContributions = reasons.reduce((s, r) => s + Number(r.contribution), 0);
      const logit = Number(model?.bias ?? 0) + sumContributions;
      const recomputed = 1 / (1 + Math.exp(-logit));
      const reasonRows = reasons
        .map((r) => {
          const shown = r.sources.ids.map((id) => `<code>${esc(id)}</code>`).join(", ");
          const more = r.sources.count > r.sources.ids.length ? ` and ${r.sources.count - r.sources.ids.length} more` : "";
          const rounded = Number(Number(r.contribution).toFixed(2)); // avoids "-0.00"
          const points = `${rounded > 0 ? "+" : ""}${rounded.toFixed(2)}`;
          const past = r.evidence
            ? `<strong>${esc(r.evidence.rule)}</strong><br>With it: ${esc(describeRate(r.evidence.present))}<br>Without it: ${esc(describeRate(r.evidence.absent))}`
            : "<span class='muted'>no simple level</span>";
          return `<tr><td>${esc(r.label)}</td><td>${esc(r.value)}</td><td>${esc(points)}</td><td class="small">${past}</td>
            <td>${r.sources.count ? `${r.sources.count} record(s): ${shown}${more}` : "<span class='muted'>none</span>"}</td></tr>`;
        })
        .join("");

      return `<p class="small"><a href="/">← This week’s calls</a></p>
        <div class="account-head"><h1>${esc(row.company_name)}</h1>${contacted ? `<span class="chip done">Last contact ${esc(contacted.action_date)}</span>` : ""}</div>
        <div class="stats">
          <div class="card stat"><div class="label">Chance of leaving in 90 days</div><div class="value">${pct(row.probability)}</div><div class="hint"><span class="risk ${bandOf(Number(row.probability), accountRate)}">${BAND_LABEL[bandOf(Number(row.probability), accountRate)]} band</span></div></div>
          <div class="card stat"><div class="label">Money at risk</div><div class="value">${money(Number(row.money_at_risk))}</div></div>
          <div class="card stat"><div class="label">Renewal</div><div class="value">${esc(row.renewal_date ?? "unknown")}</div><div class="hint">${row.days_to_renewal} days away</div></div>
        </div>
        <h2>Why this score</h2>
        <p class="muted">A typical customer starts at 0 points, which is a ${pct(1 / (1 + Math.exp(-Number(model?.bias ?? 0))))} chance of leaving. Each clue adds or removes points, depending on how this account compares with a typical one. Points above 0 push the risk up. The total gives the chance above. "In past data" shows how often earlier customers left with and without the clue.</p>
        <div class="table-wrap"><table><thead><tr><th>Clue</th><th>This account</th><th>Points</th><th>In past data</th><th>Source records</th></tr></thead><tbody>${reasonRows}</tbody></table></div>
        <div class="check">Check: a typical customer starts at ${pct(1 / (1 + Math.exp(-Number(model?.bias ?? 0))))}. This account's points add up to ${esc(sumContributions.toFixed(2))}, which gives ${pct(recomputed)} (stored ${pct(row.probability)}).</div>
        <h2>Trace</h2>
        <p class="muted">Run <code>${esc(published.run_id)}</code> · data as of ${esc(published.as_of)} · scoring version <code>${esc(published.model_id)}</code> · trained ${esc(model?.trained_at ?? "")}</p>
        <h2>Automatic messages</h2>
        ${reminders.length ? `<ul>${reminders.map((r: { invoice_id: string; sent_at: string }) => `<li>Card-update reminder sent ${esc(new Date(r.sent_at).toISOString().slice(0, 10))} for invoice ${esc(r.invoice_id)}</li>`).join("")}</ul>` : "<p class='muted'>None</p>"}
        ${
          contacted?.recent
            ? `<p class="muted">Contacted on ${esc(contacted.action_date)}. This account is off this week's calls until ${esc(contacted.back_on)}.</p>`
            : `<form method="post" action="/account/${esc(sfId)}/contacted"><button>I contacted this customer today</button></form>`
        }`;
    });
    if (html === null) {
      res.status(404).type("html").send(page("Not found", "<h1>Not found</h1><p class='muted'>This account is not in your current published list.</p>", sessionOf(res)));
      return;
    }
    res.type("html").send(page("Account", html, sessionOf(res)));
  });

  router.post("/account/:sfId/contacted", requireSession, async (req, res) => {
    const session = sessionOf(res);
    const sfId = String(req.params["sfId"]);
    await withSession(pool, session, async (c) => {
      const owned = (await c.query("select 1 from sf_accounts where sf_id = $1 and owner_csm_id = $2", [sfId, session.csm])).rowCount;
      if (!owned) return;
      // A second click inside the window changes nothing, so one call is never recorded twice.
      await c.query(
        `insert into csm_actions (org_id, sf_id, csm_id, action_date, action_type)
         select (auth.jwt() ->> 'org_id'), $1::text, $2::text, current_date, 'call'
         where not exists (select 1 from csm_actions where sf_id = $1::text and action_date > current_date - $3::int)`,
        [sfId, session.csm, CONTACT_WINDOW_DAYS],
      );
    });
    res.redirect(`/account/${encodeURIComponent(sfId)}`);
  });

  router.get("/runs", requireSession, async (_req, res) => {
    const session = sessionOf(res);
    const html = await withSession(pool, session, async (c) => {
      const runs = (
        await c.query(
          `select r.run_id, r.as_of, r.status, r.started_at, r.finished_at, r.scored_count, r.unknown_count, r.error,
                  (p.run_id is not null) as published
           from runs r left join published_runs p on p.run_id = r.run_id
           order by r.started_at desc limit 50`,
        )
      ).rows;
      return `<h1>Run log</h1>
        <p class="lede small">Every nightly attempt. Only succeeded runs are shown to CSMs.</p>
        <div class="table-wrap"><table><thead><tr><th>Started</th><th>As of</th><th>Status</th><th>Scored</th><th>Unknown</th><th>Live now</th><th>Error</th></tr></thead><tbody>
        ${runs.map((r: { started_at: Date; as_of: string; status: string; scored_count: number | null; unknown_count: number | null; published: boolean; error: string | null }) => `<tr>
          <td>${esc(new Date(r.started_at).toISOString().replace("T", " ").slice(0, 16))}</td><td>${esc(r.as_of)}</td><td><span class="status ${esc(r.status)}">${esc(r.status)}</span></td>
          <td>${esc(r.scored_count ?? "")}</td><td>${esc(r.unknown_count ?? "")}</td><td>${r.published ? "yes" : "no"}</td><td>${esc(r.error ?? "")}</td></tr>`).join("")}
        </tbody></table></div>`;
    });
    res.type("html").send(page("Run log", html, session));
  });

  router.get("/unmatched", requireSession, async (_req, res) => {
    const session = sessionOf(res);
    const html = await withSession(pool, session, async (c) => {
      const counts = (await c.query("select source, count(*)::int as n, max(seen_on)::text as seen_on from unmatched_records group by source order by source")).rows as { source: string; n: number; seen_on: string }[];
      const sample = (await c.query(
        `select source, record_id, hint from (
           select source, record_id, hint, row_number() over (partition by source order by id) as rn from unmatched_records
         ) t where rn <= 25 order by source, rn`,
      )).rows as { source: string; record_id: string; hint: string }[];
      const label: Record<string, string> = { events: "Product events", tickets: "Zendesk tickets", invoices: "Stripe invoices", subs: "Stripe subscription events", contacts: "Salesforce contacts" };
      const total = counts.reduce((sum, r) => sum + r.n, 0);
      return `<h1>Unmatched records</h1>
        <p class="lede small">Records we could not link to exactly one customer. They are kept, not scored, and rebuilt every night, so a record leaves this list once it matches. Fix: add the missing email domain or company name in the CRM. ${total} in total. First 25 per source shown.</p>
        ${counts.length === 0 ? "<p class=\"muted\">Nothing unmatched.</p>" : counts.map((r) => `<h2>${esc(label[r.source] ?? r.source)} <small class="muted">${esc(r.n)} unmatched</small></h2>
        <div class="table-wrap"><table><thead><tr><th>Record</th><th>We tried to match on</th></tr></thead><tbody>
        ${sample.filter((s) => s.source === r.source).map((s) => `<tr><td>${esc(s.record_id)}</td><td>${esc(s.hint || "(blank)")}</td></tr>`).join("")}
        </tbody></table></div>`).join("")}`;
    });
    res.type("html").send(page("Unmatched records", html, session));
  });

  app.use(router);
  app.use((_req, res) => {
    res.status(404).type("html").send(page("Not found", "<h1>Not found</h1>", null));
  });
  return app;
}

export function start(port: number): void {
  const secret = process.env["SESSION_SECRET"];
  if (!secret || secret.length < 16) throw new Error("SESSION_SECRET must be set (16+ characters)");
  const app = buildApp(webPool(), secret, process.env["DEMO_ACCESS_CODE"] ?? null);
  app.listen(port, () => console.log(`CSM app on http://localhost:${port}`));
}

if (process.argv[1]?.endsWith("server.js")) {
  start(Number(process.env["PORT"] ?? 3000));
}
