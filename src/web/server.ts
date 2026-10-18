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
  n === null || n === undefined ? "–" : `$${Math.round(Number(n)).toLocaleString("en-US")}`;
const pct = (p: number | null | undefined): string => (p === null || p === undefined ? "–" : `${(Number(p) * 100).toFixed(1)}%`);

interface Reason {
  feature: string;
  label: string;
  value: number;
  weight: number;
  contribution: number;
  sources: { ids: string[]; count: number };
}

const BAND_LABEL: Record<Band, string> = { red: "Red", amber: "Amber", green: "Green" };

function riskPill(p: number | null, rate: number): string {
  if (p === null) return "<span class='muted'>–</span>";
  const band = bandOf(Number(p), rate);
  return `<span class="risk ${band}" title="${BAND_LABEL[band]} band">${pct(p)}</span>`;
}

function topReasons(reasons: Reason[], n: number): string {
  const positive = reasons.filter((r) => r.contribution > 0).slice(0, n);
  if (positive.length === 0) return "<span class='muted'>No warning signs</span>";
  return positive.map((r) => `<span class='chip'>${esc(r.label)}</span>`).join(" ");
}

function page(title: string, body: string, session: Session | null): string {
  const nav = session
    ? `<header class="top">
        <a class="brand" href="/">Renewal risk</a>
        <nav>
          <a href="/">This week</a>
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
.rank { display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; background: var(--chip); color: var(--chip-fg); font-size: 12px; font-weight: 600; }
.risk { display: inline-block; min-width: 64px; text-align: center; padding: 3px 9px; border-radius: 999px; font-weight: 600; font-variant-numeric: tabular-nums; }
.risk.red { background: var(--bad-soft); color: var(--bad); }
.risk.amber { background: var(--warn-soft); color: var(--warn); }
.risk.green { background: var(--ok-soft); color: var(--ok); }
.chip { display: inline-block; background: var(--chip); color: var(--chip-fg); border-radius: 999px; padding: 2px 9px; font-size: 12px; margin: 2px 4px 2px 0; white-space: nowrap; }
.why-inline { display: none; } .why-inline .chip { font-size: 11.5px; white-space: normal; max-width: 100%; text-align: left; }
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
  th, td { padding: 10px 6px; }
  td.num { white-space: nowrap; }
  th.num { white-space: normal; }
  td.account { width: 100%; }
  td.account a { overflow-wrap: anywhere; }
  .risk { min-width: 0; padding: 2px 7px; }
  table { font-size: 13px; }
}
</style></head><body>${nav}<main>${body}</main>
<p class="footnote">Scores are a model's estimate from synthetic test data, not a forecast about real customers.</p>
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
      const model = (await c.query("select training_leavers, training_rows from models where model_id = $1", [published.model_id])).rows[0];
      const rate = baseRate(Number(model?.training_leavers ?? 0), Number(model?.training_rows ?? 0));
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
      const callRow = (r: (typeof rows)[number], rank: number | null): string => `<tr>
          <td class="hide-sm"><span class="rank">${rank ?? "–"}</span></td>
          <td class="account"><a href="/account/${esc(r.sf_id)}">${esc(r.company_name)}</a><div class="why-inline">${topReasons(r.reasons, 2)}</div></td>
          <td class="num">${riskPill(r.probability, rate)}</td>
          <td class="num">${money(r.money_at_risk === null ? null : Number(r.money_at_risk))}</td>
          <td class="date hide-sm">${esc(r.renewal_date ?? "unknown")}<br><span class="muted small">${r.days_to_renewal} days</span></td>
          <td class="why-col">${topReasons(r.reasons, 3)}</td>
        </tr>`;
      const table = (list: string[]): string =>
        `<div class="table-wrap"><table><thead><tr><th class="hide-sm">#</th><th>Account</th><th class="num">Chance of leaving</th><th class="num">Money at risk</th><th class="hide-sm">Renewal</th><th class="why-col">Why</th></tr></thead><tbody>${list.join("")}</tbody></table></div>`;

      const callMoney = top.reduce((sum, r) => sum + Number(r.money_at_risk ?? 0), 0);
      // Two decimals, so a pill at the line is never shown as on the wrong side of it.
      const pctOf = (x: number): string => `${(x * 100).toFixed(2)}%`;
      return `${banner}
        <h1>Renewals to work this week</h1>
        <p class="lede small">Scored ${esc(published.as_of)} · model ${esc(published.model_id)} · <a href="/runs">run log</a></p>
        <div class="stats">
          <div class="card stat"><div class="label">Calls to make</div><div class="value">${top.length}</div><div class="hint">Top ${CALL_CAPACITY} by money at risk, not contacted in ${CONTACT_WINDOW_DAYS} days</div></div>
          <div class="card stat"><div class="label">Money at risk on those calls</div><div class="value">${money(callMoney)}</div><div class="hint">Chance of leaving × contract value</div></div>
          <div class="card stat"><div class="label">Renewals scored</div><div class="value">${scored.length}</div><div class="hint">Next 90 days</div></div>
          <div class="card stat"><div class="label">Not scored</div><div class="value">${unknown.length}</div><div class="hint">Shown as unknown, never as safe</div></div>
        </div>
        <p class="small"><span class="risk red">Red</span> at least ${pctOf(2 * rate)} chance (twice the typical ${pctOf(rate)}) · <span class="risk amber">Amber</span> at least ${pctOf(rate)} · <span class="risk green">Green</span> below that. Bands are set from the model's training data and move when it is retrained.</p>
        <div class="section-head"><h2>This week's calls</h2><span class="muted small">Highest money at risk first</span></div>
        ${top.length ? table(top.map((r, i) => callRow(r, i + 1))) : "<div class='card empty'>No calls left this week. Everyone here was contacted recently, or nothing renews in the next 90 days.</div>"}
        <div class="section-head"><h2>Watch list</h2><span class="muted small">Next in line, after this week's calls</span></div>
        ${watch.length ? table(watch.map((r, i) => callRow(r, CALL_CAPACITY + i + 1))) : "<div class='card empty'>Nothing else to watch.</div>"}
        <div class="section-head"><h2>Contacted in the last ${CONTACT_WINDOW_DAYS} days</h2><span class="muted small">Off the call list until the window passes</span></div>
        ${contacted.length ? table(contacted.map((r) => callRow(r, null))) : "<div class='card empty'>No recent contacts.</div>"}
        <div class="section-head"><h2>Not scored</h2><span class="muted small">Shown as unknown with the reason, never as safe</span></div>
        ${unknown.length ? `<div class="table-wrap"><table><thead><tr><th>Account</th><th>Renewal</th><th>Reason</th></tr></thead><tbody>${unknown
          .map((r) => `<tr><td class="account">${esc(r.company_name)}</td><td class="date">${esc(r.renewal_date ?? "unknown")} <span class="muted small">(${r.days_to_renewal} days)</span></td><td><span class="chip">${esc(r.unknown_reason)}</span></td></tr>`)
          .join("")}</tbody></table></div>` : "<div class='card empty'>Every renewal in the window is scored.</div>"}`;
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
      const contacted = (await c.query("select action_date from csm_actions where sf_id = $1 order by action_date desc limit 1", [sfId])).rows[0];

      const reasons = row.reasons as Reason[];
      const sumContributions = reasons.reduce((s, r) => s + Number(r.contribution), 0);
      const logit = Number(model?.bias ?? 0) + sumContributions;
      const recomputed = 1 / (1 + Math.exp(-logit));
      const reasonRows = reasons
        .map((r) => {
          const shown = r.sources.ids.map((id) => `<code>${esc(id)}</code>`).join(", ");
          const more = r.sources.count > r.sources.ids.length ? ` and ${r.sources.count - r.sources.ids.length} more` : "";
          return `<tr><td>${esc(r.label)}</td><td>${esc(r.value)}</td><td>${esc(r.weight)}</td><td>${esc(r.contribution)}</td>
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
        <p class="muted">Each reason is the model's weight for that signal times how far this account is from the average. Positive contributions push the risk up. The total is passed through a standard formula to give the chance above.</p>
        <div class="table-wrap"><table><thead><tr><th>Signal</th><th>This account</th><th>Weight</th><th>Effect</th><th>Source records</th></tr></thead><tbody>${reasonRows}</tbody></table></div>
        <div class="check">Check: bias ${esc(Number(model?.bias ?? 0).toFixed(4))} + sum of effects ${esc(sumContributions.toFixed(4))} → chance ${pct(recomputed)} (stored ${pct(row.probability)}).</div>
        <h2>Trace</h2>
        <p class="muted">Run <code>${esc(published.run_id)}</code> · data as of ${esc(published.as_of)} · model <code>${esc(published.model_id)}</code> · trained ${esc(model?.trained_at ?? "")}</p>
        <h2>Automatic messages</h2>
        ${reminders.length ? `<ul>${reminders.map((r: { invoice_id: string; sent_at: string }) => `<li>Card-update reminder sent ${esc(new Date(r.sent_at).toISOString().slice(0, 10))} for invoice ${esc(r.invoice_id)}</li>`).join("")}</ul>` : "<p class='muted'>None</p>"}
        <form method="post" action="/account/${esc(sfId)}/contacted"><button>I contacted this customer today</button></form>`;
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
      await c.query(
        "insert into csm_actions (org_id, sf_id, csm_id, action_date, action_type) values ((auth.jwt() ->> 'org_id'), $1, $2, current_date, 'call')",
        [sfId, session.csm],
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
