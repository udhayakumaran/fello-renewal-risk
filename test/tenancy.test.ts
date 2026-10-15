import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";

/**
 * Proves tenant isolation at the database, through the Supabase API that verifies tokens.
 * Fixture rows are inserted and removed by the owner account; every check below runs as the app.
 * Skipped unless the local Supabase settings are in .env.
 */
const env = process.env;
const url = env["DATABASE_URL"];
const apiUrl = env["SUPABASE_URL"];
const anonKey = env["SUPABASE_ANON_KEY"];
const jwtSecret = env["SUPABASE_JWT_SECRET"];
const skip = url && apiUrl && anonKey && jwtSecret ? false : "local Supabase settings not set";
const owner = new pg.Client({ connectionString: url });

const base64url = (input: Buffer | string): string => Buffer.from(input).toString("base64url");

/** Signs a token the way Supabase Auth does (HS256). Pass a different secret to forge one. */
function signToken(claims: Record<string, unknown>, secret: string): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600, ...claims }));
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

const userToken = (org: string): string => signToken({ sub: `user-${org}`, org_id: org }, jwtSecret ?? "");

async function listTestRows(token: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${apiUrl}/rest/v1/sf_accounts?select=org_id,sf_id&sf_id=like.TENANT-TEST-*`, {
    headers: { apikey: anonKey ?? "", authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  if (skip) return;
  await owner.connect();
  await owner.query(
    `insert into sf_accounts (org_id, sf_id, company_name, billing_cycle)
     values ('org_a', 'TENANT-TEST-A', 'Tenant A Co', 'annual'),
            ('org_b', 'TENANT-TEST-B', 'Tenant B Co', 'annual')`,
  );
});

after(async () => {
  if (skip) return;
  await owner.query("delete from sf_accounts where sf_id like 'TENANT-TEST-%'");
  await owner.end();
});

test("a token for org_a sees only org_a rows", { skip }, async () => {
  const { status, body } = await listTestRows(userToken("org_a"));
  assert.equal(status, 200);
  assert.deepEqual(body, [{ org_id: "org_a", sf_id: "TENANT-TEST-A" }]);
});

test("a token for org_b sees only org_b rows", { skip }, async () => {
  const { body } = await listTestRows(userToken("org_b"));
  assert.deepEqual(body, [{ org_id: "org_b", sf_id: "TENANT-TEST-B" }]);
});

test("the anonymous key without a user token sees nothing", { skip }, async () => {
  const { status, body } = await listTestRows(anonKey ?? "");
  assert.ok(status >= 400 || (Array.isArray(body) && body.length === 0), `unexpected ${status}: ${JSON.stringify(body)}`);
});

test("a token signed with the wrong secret is rejected", { skip }, async () => {
  const forged = signToken({ sub: "attacker", org_id: "org_b" }, "not-the-real-secret-at-all-000000000");
  const { status } = await listTestRows(forged);
  assert.equal(status, 401);
});

test("a token for org_a cannot write a row for org_b", { skip }, async () => {
  const response = await fetch(`${apiUrl}/rest/v1/sf_accounts`, {
    method: "POST",
    headers: {
      apikey: anonKey ?? "",
      authorization: `Bearer ${userToken("org_a")}`,
      "content-type": "application/json",
      prefer: "return=minimal",
    },
    body: JSON.stringify({ org_id: "org_b", sf_id: "TENANT-TEST-LEAK", company_name: "Leak", billing_cycle: "annual" }),
  });
  assert.ok(response.status >= 400, `write should be refused, got ${response.status}`);
  assert.match(await response.text(), /row-level security/);
});

test("a direct connection with a session setting sees nothing (the old mechanism no longer grants access)", { skip }, async () => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("set local role renewal_app");
    await client.query("select set_config('app.org_id', 'org_a', true)");
    const result = await client.query("select count(*)::int as n from sf_accounts where sf_id like 'TENANT-TEST-%'");
    await client.query("rollback");
    assert.equal(result.rows[0]?.n, 0);
  } finally {
    await client.end();
  }
});
