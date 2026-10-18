/**
 * Call-list selection and risk bands. Pure functions, so the rules are tested without a database
 * and the nightly alerts and the CSM page use the same logic.
 */

export const CALL_CAPACITY = 15; // calls one CSM can make in a week
export const CONTACT_WINDOW_DAYS = 14; // a contact this recent takes the account off the call list

export interface Candidate {
  id: string;
  probability: number | null;
  money: number | null;
}

export interface CallSplit<T> {
  calls: T[];
  watch: T[];
  contacted: T[];
}

const byMoneyThenId = <T extends Candidate>(a: T, b: T): number => (b.money ?? 0) - (a.money ?? 0) || a.id.localeCompare(b.id);

/**
 * Splits one CSM's scored renewals. Accounts contacted recently are removed before the cut, so a
 * call made today frees its slot for the next account. Unscored rows appear in no list.
 */
export function splitCalls<T extends Candidate>(rows: T[], contacted: ReadonlySet<string>, capacity = CALL_CAPACITY): CallSplit<T> {
  const scored = rows.filter((r) => r.probability !== null);
  const fresh = scored.filter((r) => !contacted.has(r.id)).sort(byMoneyThenId);
  return {
    calls: fresh.slice(0, capacity),
    watch: fresh.slice(capacity),
    contacted: scored.filter((r) => contacted.has(r.id)).sort(byMoneyThenId),
  };
}

export type Band = "red" | "amber" | "green";

/** Training base rate: the share of renewals in the model's window that ended in leaving. */
export function baseRate(trainingLeavers: number, trainingRows: number): number {
  return trainingRows > 0 ? trainingLeavers / trainingRows : 0;
}

/**
 * Bands are relative to the base rate, so they mean "how far above a typical renewal". Red is at
 * least twice the base rate, amber at least the base rate, green below that. They move when the
 * model is retrained, and the page states the thresholds it used.
 */
export function bandOf(probability: number, rate: number): Band {
  if (probability >= 2 * rate) return "red";
  if (probability >= rate) return "amber";
  return "green";
}
