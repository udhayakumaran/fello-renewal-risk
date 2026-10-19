import { FEATURE_NAMES } from "./features.js";

/** How often past customers left when a clue was present, and when it was not. */
export interface Evidence {
  rule: string;
  present: { left: number; total: number };
  absent: { left: number; total: number };
}

/**
 * The level at which a clue counts as "there", in words a CSM uses. Clues without a natural level
 * (amounts, tenure) have no rule and show no evidence.
 */
const RULES: Partial<Record<(typeof FEATURE_NAMES)[number], { rule: string; test: (v: number) => boolean }>> = {
  tickets_open: { rule: "Any complaint still open", test: (v) => v >= 1 },
  tickets_opened_90d: { rule: "3 or more complaints in 90 days", test: (v) => v >= 3 },
  cancel_warning_120d: { rule: "Asked to cancel at renewal", test: (v) => v >= 1 },
  downgrade_120d: { rule: "Reduced their plan recently", test: (v) => v >= 1 },
  inactive_contact_share: { rule: "Some people there marked inactive", test: (v) => v > 0 },
  usage_drop: { rule: "Fewer product events than the 90 days before", test: (v) => v > 0 },
};

/** Counts leavers with and without each clue in the rows the model was trained on. */
export function buildEvidence(X: number[][], y: boolean[]): Record<string, Evidence> {
  const out: Record<string, Evidence> = {};
  FEATURE_NAMES.forEach((name, j) => {
    const r = RULES[name];
    if (!r) return;
    const e: Evidence = { rule: r.rule, present: { left: 0, total: 0 }, absent: { left: 0, total: 0 } };
    X.forEach((row, i) => {
      const side = r.test(row[j] ?? 0) ? e.present : e.absent;
      side.total++;
      if (y[i]) side.left++;
    });
    out[name] = e;
  });
  return out;
}

/** "56 in 100 left (22 of 39)", or a dash when nobody was in the group. */
export function describeRate(g: { left: number; total: number }): string {
  if (g.total === 0) return "no cases";
  const per100 = (g.left / g.total) * 100;
  return `${per100 < 10 ? per100.toFixed(1) : Math.round(per100)} in 100 left (${g.left.toLocaleString("en-US")} of ${g.total.toLocaleString("en-US")})`;
}
