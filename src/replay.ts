/**
 * Replays the sample data to show what a year of running changes. Two models learn only from what
 * was known on their own run date, then both are tested on the same later date:
 *   start:      run date 2025-06-15, about a year of history
 *   year later: run date 2026-06-15, a year more outcomes added
 *
 * Usage: npm run replay
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LABELS } from "./explain.js";
import { buildSnapshot, FEATURE_NAMES, horizonFor, observedLeft } from "./features.js";
import { buildIdentity } from "./identity.js";
import { indexSources } from "./index-sources.js";
import { loadRaw } from "./load.js";
import { auc, fitLogistic, predict } from "./model.js";

const CUTS = ["2024-06-15", "2024-09-15", "2024-12-15", "2025-03-15", "2025-06-15", "2025-09-15", "2025-12-15", "2026-03-15"];
const TEST_DATE = "2026-06-15";
const TOP_N = 15;

const root = fileURLToPath(new URL("../..", import.meta.url));
const raw = loadRaw(join(root, "data", "raw"));
const identity = buildIdentity(raw.sf);
const idx = indexSources(raw, identity);

/** Learns from every cut whose outcomes were fully known by runDate, using only what was known then. */
function learnAsOf(runDate: string) {
  const X: number[][] = [];
  const y: boolean[] = [];
  let cuts = 0;
  for (const cut of CUTS) {
    if (horizonFor(cut) > runDate) continue;
    cuts++;
    const snap = buildSnapshot(identity.canonical, idx, cut);
    snap.ids.forEach((id, i) => {
      if ((snap.days[i] ?? Infinity) > 90) return;
      X.push(snap.features[i] ?? []);
      y.push(observedLeft(idx, id, cut, horizonFor(cut), runDate));
    });
  }
  return { model: fitLogistic(X, y), X, y, rows: X.length, leavers: y.filter(Boolean).length, cuts };
}

const snap = buildSnapshot(identity.canonical, idx, TEST_DATE);
const horizon = horizonFor(TEST_DATE);
const keep = snap.days.map((d) => d <= 90);
const ids = snap.ids.filter((_, i) => keep[i]);
const features = snap.features.filter((_, i) => keep[i]);
const left = ids.map((id) => observedLeft(idx, id, TEST_DATE, horizon, horizon));

function topSets(scores: number[]): Set<string> {
  const byOwner = new Map<string, { id: string; score: number }[]>();
  ids.forEach((id, i) => {
    const owner = identity.canonical.get(id)?.["owner_csm_id"] || "unassigned";
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), { id, score: scores[i] ?? 0 }]);
  });
  const top = new Set<string>();
  for (const rows of byOwner.values()) for (const r of rows.sort((a, b) => b.score - a.score).slice(0, TOP_N)) top.add(r.id);
  return top;
}

const results = [
  { name: "start (run date 2025-06-15)", ...learnAsOf("2025-06-15") },
  { name: "a year later (run date 2026-06-15)", ...learnAsOf("2026-06-15") },
].map((m) => {
  const scores = features.map((x) => predict(m.model, x));
  const top = topSets(scores);
  return { ...m, scores, top, auc: auc(scores, left), captured: ids.filter((id, i) => top.has(id) && left[i]).length };
});

console.log(`test ${TEST_DATE}: ${ids.length} customers, ${left.filter(Boolean).length} leavers\n`);
for (const r of results) {
  console.log(`${r.name}: ${r.cuts} past dates, ${r.rows} cases, ${r.leavers} leavers (${((100 * r.leavers) / r.rows).toFixed(1)}%)`);
  console.log(`  AUC ${r.auc.toFixed(3)}, leavers in top ${TOP_N}: ${r.captured}`);
}
const [a, b] = results;
const shared = [...(a?.top ?? [])].filter((id) => b?.top.has(id)).length;
console.log(`\ntop-${TOP_N} lists in common: ${shared} of ${a?.top.size}`);
console.log("\npoints per clue (start -> a year later):");
FEATURE_NAMES.forEach((f, j) => {
  console.log(`  ${(LABELS[f] ?? f).padEnd(45)} ${(a?.model.weights[j] ?? 0).toFixed(3).padStart(7)} -> ${(b?.model.weights[j] ?? 0).toFixed(3).padStart(7)}`);
});

/** What actually happened: of past cases with a clue, the share that left, as each version saw it. */
console.log("\nshare of past customers with the clue who left (start -> a year later), and the points it adds:");
for (const [feature, test] of [
  ["tickets_open", (v: number) => v >= 1],
  ["tickets_opened_90d", (v: number) => v >= 3],
  ["cancel_warning_120d", (v: number) => v >= 1],
  ["downgrade_120d", (v: number) => v >= 1],
] as const) {
  const j = FEATURE_NAMES.indexOf(feature);
  const cells = results.map((r) => {
    let n = 0, l = 0;
    r.X.forEach((x, i) => { if (test(x[j] ?? 0)) { n++; if (r.y[i]) l++; } });
    const m = r.model;
    const value = feature === "tickets_opened_90d" ? 3 : 1;
    const points = ((m.weights[j] ?? 0) * (value - (m.mean[j] ?? 0))) / (m.scale[j] ?? 1);
    return `${((100 * l) / n).toFixed(1)}% (${l} of ${n}), ${points >= 0 ? "+" : ""}${points.toFixed(2)} points`;
  });
  console.log(`  ${(LABELS[feature] ?? feature).padEnd(42)} ${cells.join("  ->  ")}`);
}

/** A customer who is typical on every clue except one: the points that clue adds, and the resulting chance. */
console.log("\nif an otherwise typical customer also had:");
for (const [feature, value] of [["cancel_warning_120d", 1], ["tickets_opened_90d", 3], ["downgrade_120d", 1]] as const) {
  const j = FEATURE_NAMES.indexOf(feature);
  const row = results.map((r) => {
    const m = r.model;
    const points = ((m.weights[j] ?? 0) * (value - (m.mean[j] ?? 0))) / (m.scale[j] ?? 1);
    return `${(m.bias).toFixed(2)} + ${points.toFixed(2)} points -> ${(100 / (1 + Math.exp(-(m.bias + points)))).toFixed(1)}%`;
  });
  console.log(`  ${(LABELS[feature] ?? feature).padEnd(42)} ${row.join("  |  ")}`);
}
console.log(`\nstarting chance for a typical customer: ${(100 / (1 + Math.exp(-(a?.model.bias ?? 0)))).toFixed(1)}% -> ${(100 / (1 + Math.exp(-(b?.model.bias ?? 0)))).toFixed(1)}%`);
