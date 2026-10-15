import type { CsvRow } from "./csv.js";

// Free email providers say nothing about which company someone works for.
export const PERSONAL_DOMAINS = new Set(["gmail.com", "outlook.com", "yahoo.com"]);

export interface Identity {
  /** Salesforce id -> the one record we trust for that customer. */
  canonical: Map<string, CsvRow>;
  /** Company email domain -> Salesforce id. */
  byDomain: Map<string, string>;
  /** Normalised company name -> Salesforce ids that share it. More than one means ambiguous. */
  byName: Map<string, string[]>;
  /** Duplicate CRM records removed. */
  dropped: number;
}

/** "Northwind Labs Inc." and "NORTHWINDLABS" both become "northwindlabs". */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(inc|ltd|llc|co)\b\.?/g, "")
    .replace(/[^a-z0-9]/g, "");
}

export function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

export function buildIdentity(sfRows: CsvRow[]): Identity {
  const rowsByDomain = new Map<string, CsvRow[]>();
  const noDomain: CsvRow[] = [];
  for (const row of sfRows) {
    const domain = row["email_domain"] ?? "";
    if (!domain) {
      noDomain.push(row);
      continue;
    }
    rowsByDomain.set(domain, [...(rowsByDomain.get(domain) ?? []), row]);
  }

  const canonical = new Map<string, CsvRow>();
  const byDomain = new Map<string, string>();
  const byName = new Map<string, string[]>();
  let dropped = 0;

  const keep = (row: CsvRow): void => {
    const id = row["sf_id"] ?? "";
    canonical.set(id, row);
    const name = normalizeName(row["company_name"] ?? "");
    byName.set(name, [...(byName.get(name) ?? []), id]);
  };

  for (const [domain, rows] of rowsByDomain) {
    // Duplicate CRM records: keep the one with the latest renewal date, drop the stale copies.
    const best = rows.reduce((a, b) => ((b["renewal_date"] ?? "") > (a["renewal_date"] ?? "") ? b : a));
    dropped += rows.length - 1;
    byDomain.set(domain, best["sf_id"] ?? "");
    keep(best);
  }
  for (const row of noDomain) keep(row);

  return { canonical, byDomain, byName, dropped };
}

export function resolveByDomain(identity: Identity, domain: string): string | null {
  if (!domain || PERSONAL_DOMAINS.has(domain)) return null;
  return identity.byDomain.get(domain) ?? null;
}

/** Only links a name when exactly one customer has it. Otherwise the record goes to review. */
export function resolveByName(identity: Identity, name: string): string | null {
  const hits = identity.byName.get(normalizeName(name)) ?? [];
  return hits.length === 1 ? (hits[0] ?? null) : null;
}
