import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type CsvRow, parseCsv } from "./csv.js";

/** Raw source files, exactly as received. The pipeline never reads data/truth/. */
export interface RawData {
  sf: CsvRow[];
  contacts: CsvRow[];
  tickets: CsvRow[];
  events: CsvRow[];
  invoices: CsvRow[];
  subs: CsvRow[];
  gmail: CsvRow[];
}

export function loadRaw(dir: string): RawData {
  const read = (name: string): CsvRow[] => parseCsv(readFileSync(join(dir, `${name}.csv`), "utf8"));
  return {
    sf: read("sf_accounts"),
    contacts: read("sf_contacts"),
    tickets: read("zd_tickets"),
    events: read("product_events"),
    invoices: read("stripe_invoices"),
    subs: read("stripe_subscription_events"),
    gmail: read("gmail_messages"),
  };
}
