import type pg from "pg";

/**
 * Inserts many rows in multi-row statements. One round trip per chunk instead of one per row,
 * which matters when the database is not on the same machine.
 */
export async function insertMany(
  client: pg.ClientBase,
  table: string,
  columns: string[],
  rows: unknown[][],
  chunk = 300,
): Promise<void> {
  for (let start = 0; start < rows.length; start += chunk) {
    const batch = rows.slice(start, start + chunk);
    const values: unknown[] = [];
    const tuples = batch.map((row) => {
      const slots = row.map((value) => {
        values.push(value);
        return `$${values.length}`;
      });
      return `(${slots.join(", ")})`;
    });
    await client.query(`insert into ${table} (${columns.join(", ")}) values ${tuples.join(", ")}`, values);
  }
}
