import type { Identity } from "./identity.js";
import type { SourceIndex } from "./index-sources.js";

/**
 * Everything here is computed "as of" a date: only rows the system had received by the end of
 * that day are used. A score must never see information from its own future.
 */
export const FEATURE_NAMES = [
  "usage_now_90d",
  "usage_prior_90d",
  "usage_drop",
  "usage_log_ratio",
  "tickets_open",
  "tickets_opened_90d",
  "cancel_warning_120d",
  "downgrade_120d",
  "tenure_days",
  "log_contract_value",
  "inactive_contact_share",
] as const;

export interface Snapshot {
  asOf: string;
  ids: string[];
  features: number[][];
  /** Days from asOf to the next renewal, per customer. Used to pick the 90-day population, not as a model input. */
  days: number[];
}

const TERM_DAYS: Record<string, number> = { annual: 365, monthly: 30, multi_year: 1095 };
const DAY_MS = 86_400_000;

const day = (stamp: string): string => stamp.slice(0, 10);
const daysBetween = (from: string, to: string): number => (Date.parse(to) - Date.parse(from)) / DAY_MS;
const addDays = (d: string, n: number): string => new Date(Date.parse(d) + n * DAY_MS).toISOString().slice(0, 10);

/** Next renewal strictly after asOf, from start date and billing cycle (the contract schedule). */
export function nextRenewal(start: string, cycle: string, asOf: string): string {
  const term = TERM_DAYS[cycle] ?? 365;
  let renewal = addDays(start, term);
  while (day(renewal) <= asOf) renewal = addDays(renewal, term);
  return renewal;
}

function count<T>(rows: T[], keep: (row: T) => boolean): number {
  let n = 0;
  for (const row of rows) if (keep(row)) n++;
  return n;
}

/** Builds one row of features per customer, as of asOf. Customers who already left are excluded. */
export function buildSnapshot(canonical: Identity["canonical"], idx: SourceIndex, asOf: string): Snapshot {
  const tEnd = `${asOf} 23:59`;
  const ago = (n: number): string => addDays(asOf, -n);
  const ids: string[] = [];
  const features: number[][] = [];
  const days: number[] = [];

  for (const [id, sf] of canonical) {
    const start = sf["start_date"] ?? "";
    if (!start || start > asOf) continue;
    // No renewal date in the CRM: shown as unknown, never scored as safe.
    if (!sf["renewal_date"]) continue;
    if (unknownReason(idx, id, asOf)) continue;

    const events = (idx.events.get(id) ?? []).filter((e) => (e["ingested_at"] ?? "") <= tEnd);
    const usageNow = count(events, (e) => day(e["event_time"] ?? "") > ago(90) && day(e["event_time"] ?? "") <= asOf);
    const usagePrior = count(events, (e) => day(e["event_time"] ?? "") > ago(180) && day(e["event_time"] ?? "") <= ago(90));

    const tickets = (idx.tickets.get(id) ?? []).filter((t) => (t["ingested_at"] ?? "") <= tEnd && day(t["opened_at"] ?? "") <= asOf);
    const ticketsOpen = count(tickets, (t) => !t["closed_at"] || day(t["closed_at"]) > asOf);
    const ticketsRecent = count(tickets, (t) => day(t["opened_at"] ?? "") > ago(90));

    const subs = (idx.subs.get(id) ?? []).filter((s) => (s["ingested_at"] ?? "") <= tEnd && day(s["event_time"] ?? "") <= asOf);
    const cancelWarning = count(subs, (s) => s["event_type"] === "cancel_at_renewal" && day(s["event_time"] ?? "") > ago(120));
    const downgrades = count(subs, (s) => s["event_type"] === "downgraded" && day(s["event_time"] ?? "") > ago(120));

    const contacts = idx.contacts.get(id) ?? [];
    const inactive = count(contacts, (c) => c["is_active"] === "false"); // the generator writes lowercase booleans

    const renewal = nextRenewal(start, sf["billing_cycle"] ?? "annual", asOf);
    const value = Number(sf["contract_value"]);

    ids.push(id);
    days.push(Math.min(365, Math.max(0, daysBetween(asOf, day(renewal)))));
    features.push([
      usageNow,
      usagePrior,
      usagePrior - usageNow,
      Math.log((usageNow + 1) / (usagePrior + 1)),
      ticketsOpen,
      ticketsRecent,
      cancelWarning,
      downgrades,
      Math.max(0, daysBetween(start, asOf)),
      sf["contract_value"] ? Math.log(value) : 0,
      contacts.length ? inactive / contacts.length : 0,
    ]);
  }
  return { asOf, ids, features, days };
}

/** Why a customer cannot be scored as of asOf, or null. Never shown as safe. */
export function unknownReason(idx: SourceIndex, id: string, asOf: string): string | null {
  const cancelled = (idx.subs.get(id) ?? []).some((s) => s["event_type"] === "cancelled" && day(s["event_time"] ?? "") <= asOf);
  if (cancelled) return "already cancelled";
  // A failed card is a payment problem, not an unclear outcome: it is scored and gets the card reminder.
  // Only an invoice that was never attempted is ambiguous.
  const neverAttempted = (idx.invoices.get(id) ?? []).some((i) => day(i["sent_at"] ?? "") <= asOf && i["status"] === "open");
  if (neverAttempted) return "renewal invoice sent, never attempted, outcome unclear";
  return null;
}

/**
 * Observed outcome, not the answer key: a cancellation, or a renewal invoice never paid or attempted,
 * dated inside (asOf, asOf + 90]. Checked against the answer key in evaluate.ts.
 */
export function observedLeft(idx: SourceIndex, id: string, asOf: string, horizon: string, knownBy: string): boolean {
  const inWindow = (d: string): boolean => d > asOf && d <= horizon;
  // Only outcomes the system had received by knownBy count, so a label never uses future knowledge.
  const cancelled = (idx.subs.get(id) ?? []).some(
    (s) => s["event_type"] === "cancelled" && inWindow(day(s["event_time"] ?? "")) && (s["ingested_at"] ?? "") <= knownBy + " 23:59",
  );
  // Unpaid and never attempted (open or void). A failed card is a support case, not a departure.
  const unpaid = (idx.invoices.get(id) ?? []).some(
    (i) => (i["status"] === "open" || i["status"] === "void") && inWindow(day(i["sent_at"] ?? "")),
  );
  return cancelled || unpaid;
}

export function horizonFor(asOf: string): string {
  return addDays(asOf, 90);
}
