import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";
import { ownerClient } from "../src/db.js";
import { makeCookie, buildApp, readCookie } from "../src/web/server.js";
import { webPool } from "../src/db.js";
import { runNightly } from "../src/pipeline/nightly.js";

/**
 * Integration tests against the local stack: web isolation, forged sessions, score traceability,
 * and the failed-run rule. Skipped when the database settings are missing.
 */
const url = process.env["DATABASE_URL"];
const secret = process.env["SESSION_SECRET"] ?? "";
const skip = url && secret.length >= 16 ? false : "DATABASE_URL or SESSION_SECRET not set";

let base = "";
let server: { close: () => void } | null = null;
let owner: pg.Client;

const cookieFor = (org: string, csm: string): string => `csm_session=${encodeURIComponent(makeCookie({ org, csm }, secret))}`;

async function get(path: string, cookie?: string): Promise<{ status: number; location: string | null; body: string }> {
  const response = await fetch(base + path, {
    redirect: "manual",
    headers: cookie ? { cookie } : {},
  });
  return { status: response.status, location: response.headers.get("location"), body: await response.text() };
}

before(async () => {
  if (skip) return;
  owner = ownerClient();
  await owner.connect();
  const app = buildApp(webPool(), secret);
  const listening = app.listen(0);
  await new Promise<void>((resolve) => listening.once("listening", () => resolve()));
  const { port } = listening.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  server = listening;
});

after(async () => {
  if (skip) return;
  server?.close();
  await owner.end();
});

test("no cookie: redirected to sign-in", { skip }, async () => {
  const response = await get("/");
  assert.equal(response.status, 302);
  assert.equal(response.location, "/login");
});

test("a forged cookie is refused", { skip }, async () => {
  const forged = makeCookie({ org: "org_a", csm: "org_a-CSM1" }, "a-different-secret-entirely-000");
  assert.equal(readCookie(forged, secret), null);
  const response = await get("/", `csm_session=${encodeURIComponent(forged)}`);
  assert.equal(response.status, 302);
});

test("a CSM sees only their own accounts, and only from their own org", { skip }, async () => {
  const response = await get("/", cookieFor("org_a", "org_a-CSM1"));
  assert.equal(response.status, 200);
  const ids = [...new Set([...response.body.matchAll(/\/account\/(SF\d+)/g)].map((m) => m[1] ?? ""))];
  assert.ok(ids.length > 0, "list should show accounts");
  const rows = (await owner.query("select org_id, owner_csm_id from sf_accounts where sf_id = any($1)", [ids])).rows;
  for (const r of rows) {
    assert.equal(r.org_id, "org_a");
    assert.equal(r.owner_csm_id, "org_a-CSM1");
  }
});

test("a session from org_a cannot open an org_b account", { skip }, async () => {
  const other = await owner.query("select sf_id from sf_accounts where org_id = 'org_b' and owner_csm_id = 'org_b-CSM1' limit 1");
  const sfId = other.rows[0]?.sf_id as string;
  const response = await get(`/account/${sfId}`, cookieFor("org_a", "org_a-CSM1"));
  assert.equal(response.status, 404);
  assert.ok(!response.body.includes(sfId), "the page must not reveal the account");
});

test("claims come from the signed cookie: org_a with an org_b CSM sees no org_b account", { skip }, async () => {
  // A validly signed cookie whose org and CSM disagree. The org claim decides what the database returns.
  const cookie = `csm_session=${encodeURIComponent(makeCookie({ org: "org_a", csm: "org_b-CSM1" }, secret))}`;
  const other = await owner.query("select sf_id from sf_accounts where org_id = 'org_b' and owner_csm_id = 'org_b-CSM1' limit 1");
  const sfId = other.rows[0]?.sf_id as string;
  const response = await get(`/account/${sfId}`, cookie);
  assert.equal(response.status, 404);
  const list = await get("/", cookie);
  assert.ok(!list.body.includes(sfId), "org_b records must not appear for an org_a session");
});

test("an expired session cookie is refused over HTTP", { skip }, async () => {
  const expired = `csm_session=${encodeURIComponent(makeCookie({ org: "org_a", csm: "org_a-CSM1" }, secret, -1000))}`;
  const response = await get("/", expired);
  assert.equal(response.status, 302);
  assert.equal(response.location, "/login");
});

test("every stored score can be recomputed from its stored reasons", { skip }, async () => {
  const published = (await owner.query("select p.run_id, r.model_id from published_runs p join runs r using (run_id) where p.org_id = 'org_a'")).rows[0];
  const model = (await owner.query("select bias from models where model_id = $1", [published.model_id])).rows[0];
  const scores = (await owner.query("select probability, reasons from scores where run_id = $1 and probability is not null", [published.run_id])).rows;
  assert.ok(scores.length > 0);
  for (const s of scores) {
    const logit = Number(model.bias) + (s.reasons as { contribution: number }[]).reduce((sum, r) => sum + r.contribution, 0);
    const recomputed = 1 / (1 + Math.exp(-logit));
    assert.ok(Math.abs(recomputed - Number(s.probability)) < 1e-3, `score ${s.probability} vs recomputed ${recomputed}`);
  }
});

test("a failed run is logged and never published", { skip }, async () => {
  const before = (await owner.query("select run_id from published_runs where org_id = 'org_c'")).rows[0]?.run_id;
  const previous = process.env["FORCE_FAIL"];
  process.env["FORCE_FAIL"] = "org_c";
  try {
    const { failures } = await runNightly(process.env["AS_OF"] ?? new Date().toISOString().slice(0, 10));
    assert.equal(failures, 1);
  } finally {
    if (previous === undefined) delete process.env["FORCE_FAIL"];
    else process.env["FORCE_FAIL"] = previous;
  }
  const after = (await owner.query("select run_id from published_runs where org_id = 'org_c'")).rows[0]?.run_id;
  assert.equal(after, before, "published pointer must not move to a failed run");
  const failed = (await owner.query("select status, error from runs where org_id = 'org_c' order by started_at desc limit 1")).rows[0];
  assert.equal(failed?.status, "failed");
  assert.match(String(failed?.error), /FORCE_FAIL/);
});

test("the account page shows what happened to past customers, in plain words", { skip }, async () => {
  const published = (await owner.query("select p.run_id from published_runs p where p.org_id = 'org_a'")).rows[0];
  const row = (await owner.query("select sf_id, owner_csm_id from scores where run_id = $1 and probability is not null limit 1", [published.run_id])).rows[0];
  const response = await get(`/account/${row.sf_id}`, cookieFor("org_a", row.owner_csm_id));
  assert.equal(response.status, 200);
  assert.match(response.body, /In past data/);
  assert.match(response.body, /With it: .* in 100 left \(\d+ of \d+\)/);
  assert.doesNotMatch(response.body, /bias|Weight/);
});

test("a second run on the same day reuses the saved points instead of re-learning", { skip }, async () => {
  const asOf = process.env["AS_OF"] ?? new Date().toISOString().slice(0, 10);
  const before = (await owner.query("select model_id, trained_at from models where model_id = $1", [`logit-${asOf}`])).rows[0];
  assert.ok(before, "the earlier nightly run saved a model");
  await runNightly(asOf);
  const after = (await owner.query("select model_id, trained_at from models where model_id = $1", [`logit-${asOf}`])).rows[0];
  assert.equal(String(after.trained_at), String(before.trained_at), "model must not be re-learned the same day");
});

test("after \"I contacted this customer\" the button is replaced by a note, and a second click records nothing", { skip }, async () => {
  const published = (await owner.query("select run_id from published_runs where org_id = 'org_a'")).rows[0];
  const row = (await owner.query("select sf_id, owner_csm_id from scores where run_id = $1 and probability is not null limit 1", [published.run_id])).rows[0];
  const cookie = cookieFor("org_a", row.owner_csm_id);
  const post = (): Promise<Response> => fetch(`${base}/account/${row.sf_id}/contacted`, { method: "POST", redirect: "manual", headers: { cookie } });
  const count = async (): Promise<number> => Number((await owner.query("select count(*) from csm_actions where sf_id = $1", [row.sf_id])).rows[0].count);
  await owner.query("delete from csm_actions where sf_id = $1", [row.sf_id]);
  try {
    assert.match((await get(`/account/${row.sf_id}`, cookie)).body, /I contacted this customer today/);
    await post();
    await post();
    assert.equal(await count(), 1, "a second click must not add a second record");
    const after = (await get(`/account/${row.sf_id}`, cookie)).body;
    assert.doesNotMatch(after, /I contacted this customer today/);
    assert.match(after, /Contacted on \d{4}-\d{2}-\d{2}\. This account is off this week's calls until/);
  } finally {
    await owner.query("delete from csm_actions where sf_id = $1", [row.sf_id]);
  }
});

test("unmatched records are queued per org and shown on their own page", { skip }, async () => {
  const mine = Number((await owner.query("select count(*) from unmatched_records where org_id = 'org_a'")).rows[0].count);
  const others = Number((await owner.query("select count(*) from unmatched_records where org_id <> 'org_a'")).rows[0].count);
  assert.ok(mine > 0, "the nightly run queued org_a's unmatched records");
  assert.ok(others > 0, "other orgs have their own queue");
  const csm = (await owner.query("select owner_csm_id from sf_accounts where org_id = 'org_a' and owner_csm_id <> '' limit 1")).rows[0].owner_csm_id;
  const response = await get("/unmatched", cookieFor("org_a", csm));
  assert.equal(response.status, 200);
  assert.match(response.body, /Unmatched records/);
  assert.match(response.body, new RegExp(`${mine} in total`), "the page counts only this org's rows");
});
