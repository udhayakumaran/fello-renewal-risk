/**
 * Loads the generated CSV files into Postgres. Development use: each run clears the
 * source tables first, so the database always matches the files on disk.
 *
 * Usage: npm run db:load   (needs DATABASE_URL and a running local Supabase)
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadRaw, type RawData } from "../load.js";

const TABLES: { table: keyof RawData; name: string }[] = [
  { table: "sf", name: "sf_accounts" },
  { table: "contacts", name: "sf_contacts" },
  { table: "tickets", name: "zd_tickets" },
  { table: "events", name: "product_events" },
  { table: "invoices", name: "stripe_invoices" },
  { table: "subs", name: "stripe_subscription_events" },
  { table: "gmail", name: "gmail_messages" },
];

const BATCH = 500;

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");

  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const raw = loadRaw(join(root, "data", "raw"));
  const client = new pg.Client({ connectionString: url });
  await client.connect();

  try {
    await client.query("begin");
    // Development reset: scoring output is derived from the source rows, so it is cleared with them.
    await client.query("truncate runs, scores, published_runs, alerts, card_reminders, csm_actions, models restart identity cascade");
    for (const { table, name } of TABLES) {
      const rows = raw[table];
      const first = rows[0];
      if (!first) continue;
      const columns = Object.keys(first);
      // The first load of a table starts empty; a rerun replaces it.
      await client.query(`truncate ${name} restart identity`);
      for (let start = 0; start < rows.length; start += BATCH) {
        const batch = rows.slice(start, start + BATCH);
        const values: (string | null)[] = [];
        const placeholders = batch.map((row, r) => {
          const slots = columns.map((c, col) => {
            values.push(row[c] === "" || row[c] === undefined ? null : (row[c] as string));
            return `$${r * columns.length + col + 1}`;
          });
          return `(${slots.join(", ")})`;
        });
        await client.query(
          `insert into ${name} (${columns.join(", ")}) values ${placeholders.join(", ")}`,
          values,
        );
      }
      console.log(`${name}: ${rows.length} rows`);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
