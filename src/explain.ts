import type { CsvRow } from "./csv.js";
import type { SourceIndex } from "./index-sources.js";

/** Plain-English label for each model input. Shown to CSMs instead of feature names. */
export const LABELS: Record<string, string> = {
  usage_now_90d: "Low product usage in the last 90 days",
  usage_prior_90d: "Low product usage in the 90 days before that",
  usage_drop: "Sharp drop in product usage",
  usage_log_ratio: "Usage trend falling",
  tickets_open: "Support tickets still open",
  tickets_opened_90d: "Many support tickets in the last 90 days",
  cancel_warning_120d: "Asked to cancel at renewal",
  downgrade_120d: "Plan or seats cut recently",
  tenure_days: "Days as a customer",
  log_contract_value: "Contract value ($)",
  inactive_contact_share: "Some contacts marked inactive",
};

const DAY_MS = 86_400_000;
const LIST_CAP = 10;

const day = (stamp: string): string => stamp.slice(0, 10);
/** Date strictly after from, up to and including to. */
const inRange = (stamp: string | undefined, from: string, to: string): boolean => day(stamp ?? "") > from && day(stamp ?? "") <= to;
const daysAgo = (asOf: string, n: number): string => new Date(Date.parse(asOf) - n * DAY_MS).toISOString().slice(0, 10);

/**
 * The source records behind one input, as of the same date the score used. Capped for display;
 * the count stored alongside is the true total.
 */
export function sourceIdsFor(feature: string, sfId: string, idx: SourceIndex, asOf: string): { ids: string[]; count: number } {
  const cap = (ids: string[]): { ids: string[]; count: number } => ({ ids: ids.slice(0, LIST_CAP), count: ids.length });
  const events = (idx.events.get(sfId) ?? []).filter((e) => day(e["event_time"] ?? "") <= asOf);
  const tickets = (idx.tickets.get(sfId) ?? []).filter((t) => day(t["opened_at"] ?? "") <= asOf);
  const subs = (idx.subs.get(sfId) ?? []).filter((s) => day(s["event_time"] ?? "") <= asOf);
  const contacts = idx.contacts.get(sfId) ?? [];
  switch (feature) {
    case "usage_now_90d":
      return cap(events.filter((e) => day(e["event_time"] ?? "") > daysAgo(asOf, 90)).map((e) => e["event_id"] ?? ""));
    case "usage_prior_90d":
      return cap(events.filter((e) => inRange(e["event_time"], daysAgo(asOf, 180), daysAgo(asOf, 90))).map((e) => e["event_id"] ?? ""));
    case "usage_drop":
    case "usage_log_ratio":
      return cap(events.filter((e) => inRange(e["event_time"], daysAgo(asOf, 180), asOf)).map((e) => e["event_id"] ?? ""));
    case "tickets_open":
      return cap(tickets.filter((t) => !t["closed_at"] || day(t["closed_at"]) > asOf).map((t) => t["ticket_id"] ?? ""));
    case "tickets_opened_90d":
      return cap(tickets.filter((t) => day(t["opened_at"] ?? "") > daysAgo(asOf, 90)).map((t) => t["ticket_id"] ?? ""));
    case "cancel_warning_120d":
      return cap(subs.filter((s) => s["event_type"] === "cancel_at_renewal" && day(s["event_time"] ?? "") > daysAgo(asOf, 120)).map((s) => s["event_id"] ?? ""));
    case "downgrade_120d":
      return cap(subs.filter((s) => s["event_type"] === "downgraded" && day(s["event_time"] ?? "") > daysAgo(asOf, 120)).map((s) => s["event_id"] ?? ""));
    case "inactive_contact_share":
      return cap(contacts.filter((c) => c["is_active"] === "false").map((c) => c["contact_id"] ?? ""));
    default:
      // Account-level inputs point at the Salesforce record itself.
      return { ids: [sfId], count: 1 };
  }
}
