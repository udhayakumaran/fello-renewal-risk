import type pg from "pg";
import type { CsvRow } from "../csv.js";
import type { RawData } from "../load.js";

/** Timestamps and dates come back as the same text the CSV files used, so feature code is unchanged. */
const ts = (col: string): string => `coalesce(to_char(${col}, 'YYYY-MM-DD HH24:MI'), '') as ${col.split(".").pop()}`;
const dt = (col: string): string => `coalesce(to_char(${col}, 'YYYY-MM-DD'), '') as ${col.split(".").pop()}`;
const txt = (col: string): string => `coalesce(${col}::text, '') as ${col.split(".").pop()}`;

/** Loads one org's source rows from Postgres, as the owner connection (pipeline only). */
export async function loadOrgRaw(client: pg.Client, org: string): Promise<RawData> {
  const q = async (sql: string): Promise<CsvRow[]> => (await client.query(sql, [org])).rows as CsvRow[];
  return {
    sf: await q(`select sf_id, org_id, company_name, ${txt("email_domain")}, ${txt("owner_csm_id")},
      ${txt("contract_value")}, ${dt("renewal_date")}, billing_cycle, ${dt("start_date")}
      from sf_accounts where org_id = $1 order by sf_id`),
    contacts: await q(`select contact_id, org_id, sf_id, ${txt("email")}, ${txt("role")}, is_active::text as is_active
      from sf_contacts where org_id = $1`),
    tickets: await q(`select ticket_id, org_id, org_name, ${txt("requester_email")}, ${ts("opened_at")}, ${ts("closed_at")},
      reopen_count::text, priority, ${ts("ingested_at")}
      from zd_tickets where org_id = $1`),
    events: await q(`select event_id, org_id, account_domain, user_id, event_type, ${ts("event_time")}, ${ts("ingested_at")}
      from product_events where org_id = $1`),
    invoices: await q(`select invoice_id, org_id, customer_ref, ${txt("billing_email")}, amount::text, ${dt("due_date")},
      status, attempt_count::text, ${ts("sent_at")}, ${ts("viewed_at")}, ${ts("paid_at")}
      from stripe_invoices where org_id = $1`),
    subs: await q(`select event_id, org_id, customer_ref, event_type, ${ts("event_time")}, ${ts("ingested_at")}
      from stripe_subscription_events where org_id = $1`),
    gmail: await q(`select message_id, org_id, ${txt("contact_id")}, counterpart_domain, direction, ${ts("sent_at")},
      ${ts("ingested_at")}, thread_id, ${txt("reply_latency_hours")}
      from gmail_messages where org_id = $1`),
  };
}

export async function orgIds(client: pg.Client): Promise<string[]> {
  const result = await client.query("select distinct org_id from sf_accounts order by org_id");
  return result.rows.map((r: { org_id: string }) => r.org_id);
}
