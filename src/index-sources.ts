import type { CsvRow } from "./csv.js";
import { type Identity, domainOf, resolveByDomain, resolveByName } from "./identity.js";
import type { RawData } from "./load.js";

/** Every source row attached to one customer, plus match counts for the review report. */
export interface SourceIndex {
  events: Map<string, CsvRow[]>;
  tickets: Map<string, CsvRow[]>;
  invoices: Map<string, CsvRow[]>;
  subs: Map<string, CsvRow[]>;
  contacts: Map<string, CsvRow[]>;
  /** Rows that could not be linked to one customer. These go to the review queue, never dropped. */
  unmatched: Record<string, number>;
}

function add(map: Map<string, CsvRow[]>, id: string, row: CsvRow): void {
  map.set(id, [...(map.get(id) ?? []), row]);
}

export function indexSources(data: RawData, identity: Identity): SourceIndex {
  const index: SourceIndex = {
    events: new Map(),
    tickets: new Map(),
    invoices: new Map(),
    subs: new Map(),
    contacts: new Map(),
    unmatched: { events: 0, tickets: 0, invoices: 0, subs: 0, contacts: 0 },
  };

  for (const row of data.events) {
    const id = resolveByDomain(identity, row["account_domain"] ?? "");
    if (id) add(index.events, id, row);
    else index.unmatched["events"] = (index.unmatched["events"] ?? 0) + 1;
  }

  for (const row of data.tickets) {
    const id =
      resolveByDomain(identity, domainOf(row["requester_email"] ?? "")) ??
      resolveByName(identity, row["org_name"] ?? "");
    if (id) add(index.tickets, id, row);
    else index.unmatched["tickets"] = (index.unmatched["tickets"] ?? 0) + 1;
  }

  // Stripe rows link to a customer through the billing email. Stripe's own customer id is
  // remembered so subscription events (which only carry that id) can be linked too.
  const refToSf = new Map<string, string>();
  for (const row of data.invoices) {
    const id = resolveByDomain(identity, domainOf(row["billing_email"] ?? ""));
    if (id) {
      add(index.invoices, id, row);
      refToSf.set(row["customer_ref"] ?? "", id);
    } else {
      index.unmatched["invoices"] = (index.unmatched["invoices"] ?? 0) + 1;
    }
  }
  for (const row of data.subs) {
    const id = refToSf.get(row["customer_ref"] ?? "");
    if (id) add(index.subs, id, row);
    else index.unmatched["subs"] = (index.unmatched["subs"] ?? 0) + 1;
  }

  for (const row of data.contacts) {
    const id = resolveByDomain(identity, domainOf(row["email"] ?? ""));
    if (id) add(index.contacts, id, row);
    else index.unmatched["contacts"] = (index.unmatched["contacts"] ?? 0) + 1;
  }

  return index;
}
