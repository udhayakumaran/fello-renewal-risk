import pg from "pg";

// DATE columns come back as plain "YYYY-MM-DD" text, not JavaScript Dates, so they render as dates.
pg.types.setTypeParser(1082, (value: string) => value);

/** Pool for the web server. It connects as the owner and drops to the authenticated role per request. */
export function webPool(): pg.Pool {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
  return new pg.Pool({ connectionString: url, max: 10 });
}

/** Owner connection for the pipeline only. It bypasses row-level security, so it never serves web requests. */
export function ownerClient(): pg.Client {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
  return new pg.Client({ connectionString: url });
}

/** Runs one query as the signed-in user: the database filters every row by the verified org claim. */
export async function asUser<T>(
  client: pg.ClientBase,
  claims: Record<string, unknown>,
  run: () => Promise<T>,
): Promise<T> {
  await client.query("begin");
  try {
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const result = await run();
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}
