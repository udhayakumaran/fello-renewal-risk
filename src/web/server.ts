/**
 * CSM web app. Every page reads through the database as the signed-in user, so isolation is
 * enforced by Postgres row-level security, not by filtering in this file.
 *
 * Login here is a development stand-in: pick an org and a CSM. A real deployment would use the
 * company's sign-in (Supabase Auth or SSO) and issue the same org claim.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import express from "express";
import type pg from "pg";
import { asUser, webPool } from "../db.js";

export interface Session {
  org: string;
  csm: string;
}

const COOKIE = "csm_session";
const CALL_CAPACITY = 15;

// ---------- signed session cookie ----------

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function makeCookie(session: Session, secret: string): string {
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
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
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<Session>;
    return typeof parsed.org === "string" && typeof parsed.csm === "string" ? { org: parsed.org, csm: parsed.csm } : null;
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

function topReasons(reasons: Reason[], n: number): string {
  const positive = reasons.filter((r) => r.contribution > 0).slice(0, n);
  if (positive.length === 0) return "<span class='muted'>No warning signs</span>";
  return positive.map((r) => `<span class='chip'>${esc(r.label)}</span>`).join(" ");
}

function page(title: string, body: string, session: Session | null): string {
  const nav = session
    ? `<nav><a href="/">My renewals</a> · <a href="/runs">Run log</a> · <span class="muted">${esc(session.csm)} (${esc(session.org)})</span>
       <form method="post" action="/logout" class="inline"><button>Sign out</button></form></nav>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root { --fg:#1c1c1e; --muted:#6b6b70; --line:#e4e4e7; --bg:#fff; --chip:#eef2ff; --warn:#fff7e6; }
@media (prefers-color-scheme: dark) { :root { --fg:#f2f2f3; --muted:#9a9aa0; --line:#34343a; --bg:#141416; --chip:#26293d; --warn:#2d2513; } }
body { font: 15px/1.45 system-ui, sans-serif; color: var(--fg); background: var(--bg); margin: 0; padding: 16px; }
nav { margin-bottom: 16px; font-size: 14px; }
h1 { font-size: 20px; margin: 8px 0; } h2 { font-size: 16px; margin: 24px 0 8px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; }
.chip { display: inline-block; background: var(--chip); border-radius: 999px; padding: 2px 8px; font-size: 12px; margin: 2px 2px 2px 0; }
.muted { color: var(--muted); } .banner { background: var(--warn); padding: 10px; border-radius: 6px; margin-bottom: 12px; }
.inline { display: inline; } button { font: inherit; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); cursor: pointer; }
a { color: inherit; } .scroll { overflow-x: auto; }
@media (max-width: 640px) { th:nth-child(4), td:nth-child(4) { display: none; } }
</style></head><body>${nav}${body}
<p class="muted" style="font-size:12px;margin-top:32px">Scores are a model's estimate from synthetic test data, not a forecast about real customers.</p>
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
        `<h1>Sign in (development)</h1><p class="muted">Stand-in for company sign-in. Pick a CSM to see their renewals.</p>
         <form method="post" action="/login"><select name="who">${options}</select>
         ${demoAccessCode ? '<input name="code" type="password" placeholder="Demo access code" required>' : ""} <button>Sign in</button></form>`,
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
    res.setHeader("Set-Cookie", `${COOKIE}=${encodeURIComponent(makeCookie({ org, csm }, secret))}; HttpOnly; SameSite=Strict; Path=/`);
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
      const alerts = new Map(
        (await c.query("select sf_id, status, suppressed_reason from alerts where run_id = $1 and owner_csm_id = $2", [published.run_id, session.csm]))
          .rows.map((a: { sf_id: string; status: string; suppressed_reason: string | null }) => [a.sf_id, a]),
      );

      const scored = rows.filter((r) => r.probability !== null);
      const unknown = rows.filter((r) => r.probability === null);
      const callRow = (r: (typeof rows)[number], rank: number): string => {
        const alert = alerts.get(r.sf_id);
        const handled = alert?.status === "suppressed" ? "<span class='chip'>Already contacted</span>" : "";
        return `<tr>
          <td>${rank}</td>
          <td><a href="/account/${esc(r.sf_id)}">${esc(r.company_name)}</a><br>${handled}</td>
          <td>${pct(r.probability)}</td>
          <td>${money(r.money_at_risk === null ? null : Number(r.money_at_risk))}</td>
          <td>${esc(r.renewal_date ?? "unknown")}<br><span class="muted">${r.days_to_renewal} days</span></td>
          <td>${topReasons(r.reasons, 3)}</td>
        </tr>`;
      };
      const table = (list: string[]): string =>
        `<div class="scroll"><table><thead><tr><th>#</th><th>Account</th><th>Chance of leaving (90 days)</th><th>Money at risk</th><th>Renewal</th><th>Why</th></tr></thead><tbody>${list.join("")}</tbody></table></div>`;

      const top = scored.slice(0, CALL_CAPACITY);
      const watch = scored.slice(CALL_CAPACITY);
      return `${banner}
        <h1>Renewals to work this week</h1>
        <p class="muted">Model ${esc(published.model_id)} · scored ${esc(published.as_of)} · run ${esc(published.run_id)}</p>
        <h2>This week's calls (top ${CALL_CAPACITY} by money at risk)</h2>
        ${top.length ? table(top.map((r, i) => callRow(r, i + 1))) : "<p class='muted'>No renewals in the next 90 days.</p>"}
        <h2>Watch list</h2>
        ${watch.length ? table(watch.map((r, i) => callRow(r, CALL_CAPACITY + i + 1))) : "<p class='muted'>Nothing else.</p>"}
        <h2>Not scored: shown as unknown, never as safe</h2>
        ${unknown.length ? `<div class="scroll"><table><thead><tr><th>Account</th><th>Renewal</th><th>Reason</th></tr></thead><tbody>${unknown
          .map((r) => `<tr><td>${esc(r.company_name)}</td><td>${esc(r.renewal_date ?? "unknown")} (${r.days_to_renewal} days)</td><td>${esc(r.unknown_reason)}</td></tr>`)
          .join("")}</tbody></table></div>` : "<p class='muted'>None.</p>"}`;
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

      return `<h1>${esc(row.company_name)}</h1>
        <p><strong>Chance of leaving in 90 days: ${pct(row.probability)}</strong> · Money at risk: ${money(Number(row.money_at_risk))} · Renewal ${esc(row.renewal_date ?? "unknown")} (${row.days_to_renewal} days)</p>
        ${contacted ? `<p class="muted">Last CSM contact: ${esc(contacted.action_date)}</p>` : ""}
        <h2>Why this score</h2>
        <p class="muted">Each reason is the model's weight for that signal times how far this account is from the average. Positive contributions push the risk up. The total is passed through a standard formula to give the chance above.</p>
        <div class="scroll"><table><thead><tr><th>Signal</th><th>This account</th><th>Weight</th><th>Effect</th><th>Source records</th></tr></thead><tbody>${reasonRows}</tbody></table></div>
        <p class="muted">Check: bias ${esc(Number(model?.bias ?? 0).toFixed(4))} + sum of effects ${esc(sumContributions.toFixed(4))} → chance ${pct(recomputed)} (stored ${pct(row.probability)}).</p>
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
        <p class="muted">Every nightly attempt is listed. Only succeeded runs are published to CSMs.</p>
        <div class="scroll"><table><thead><tr><th>Started</th><th>As of</th><th>Status</th><th>Scored</th><th>Unknown</th><th>Published</th><th>Error</th></tr></thead><tbody>
        ${runs.map((r: { started_at: Date; as_of: string; status: string; scored_count: number | null; unknown_count: number | null; published: boolean; error: string | null }) => `<tr>
          <td>${esc(new Date(r.started_at).toISOString().replace("T", " ").slice(0, 16))}</td><td>${esc(r.as_of)}</td><td>${esc(r.status)}</td>
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
  const app = buildApp(webPool(), secret);
  app.listen(port, () => console.log(`CSM app on http://localhost:${port}`));
}

if (process.argv[1]?.endsWith("server.js")) {
  start(Number(process.env["PORT"] ?? 3000));
}
