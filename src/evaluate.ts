/**
 * Trains the risk model on earlier snapshots, tests it on a later one, and compares it with a
 * simple rule. Time split: the test date is later than every training label window.
 *
 * Usage: npm run evaluate
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv } from "./csv.js";
import { buildSnapshot, FEATURE_NAMES, horizonFor, observedLeft } from "./features.js";
import { buildIdentity } from "./identity.js";
import { indexSources } from "./index-sources.js";
import { loadRaw } from "./load.js";
import { auc, fitLogistic, predict } from "./model.js";

const TRAIN_DATES = ["2025-03-15", "2025-06-15", "2025-09-15", "2025-12-15"];
const TEST_DATE = "2026-06-15";
const TOP_N = 15; // calls a CSM can make in a week
const BASELINE_INDEX = FEATURE_NAMES.indexOf("usage_drop");

/**
 * The weekly list ranks renewals coming up in the next 90 days. Scoring every customer would let
 * "renewal soon" alone predict the label, which would flatter the model.
 */
function renewingSoon(days: number): boolean {
  return days <= 90;
}

/** 95% range for AUC, by resampling the test customers. Wide ranges mean few leavers, not a bad model. */
function bootstrapRange(scores: number[], labels: boolean[], rounds = 500): [number, number] {
  let seed = 7;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const values: number[] = [];
  for (let r = 0; r < rounds; r++) {
    const s: number[] = [];
    const l: boolean[] = [];
    for (let i = 0; i < scores.length; i++) {
      const j = Math.floor(next() * scores.length);
      s.push(scores[j] ?? 0);
      l.push(labels[j] ?? false);
    }
    const a = auc(s, l);
    if (!Number.isNaN(a)) values.push(a);
  }
  values.sort((x, y) => x - y);
  return [values[Math.floor(values.length * 0.025)] ?? NaN, values[Math.floor(values.length * 0.975)] ?? NaN];
}

const root = fileURLToPath(new URL("../..", import.meta.url));
const raw = loadRaw(join(root, "data", "raw"));
const identity = buildIdentity(raw.sf);
const idx = indexSources(raw, identity);

console.log(`customers: ${identity.canonical.size} (duplicate CRM records removed: ${identity.dropped})`);
for (const [source, count] of Object.entries(idx.unmatched)) {
  console.log(`  unmatched ${source} rows (review queue): ${count}`);
}

// Training data: several past snapshots, each labelled with what was observed in the next 90 days.
const trainX: number[][] = [];
const trainY: boolean[] = [];
for (const asOf of TRAIN_DATES) {
  const snap = buildSnapshot(identity.canonical, idx, asOf);
  snap.ids.forEach((id, i) => {
    const x = snap.features[i] ?? [];
    if (!renewingSoon(snap.days[i] ?? Infinity)) return;
    trainX.push(x);
    trainY.push(observedLeft(idx, id, asOf, horizonFor(asOf), TEST_DATE));
  });
}
const model = fitLogistic(trainX, trainY);
console.log(`training rows: ${trainX.length}, leavers: ${trainY.filter(Boolean).length}`);

// Test data: a later date the model never saw.
const full = buildSnapshot(identity.canonical, idx, TEST_DATE);
const keep = full.days.map(renewingSoon);
const test = {
  ids: full.ids.filter((_, i) => keep[i]),
  features: full.features.filter((_, i) => keep[i]),
};
const horizon = horizonFor(TEST_DATE);
const testY = test.ids.map((id) => observedLeft(idx, id, TEST_DATE, horizon, horizon));
const modelScores = test.features.map((x) => predict(model, x));
const ruleScores = test.features.map((x) => x[BASELINE_INDEX] ?? 0);
const leavers = testY.filter(Boolean).length;

console.log(`\ntest date ${TEST_DATE}: ${test.ids.length} customers renewing in next 90 days, ${leavers} leavers (${((leavers / test.ids.length) * 100).toFixed(1)}%)`);
const [modelLo, modelHi] = bootstrapRange(modelScores, testY);
const [ruleLo, ruleHi] = bootstrapRange(ruleScores, testY);
console.log(`  AUC, logistic model:  ${auc(modelScores, testY).toFixed(3)} (95% range ${modelLo.toFixed(2)}–${modelHi.toFixed(2)})`);
console.log(`  AUC, rule (usage drop): ${auc(ruleScores, testY).toFixed(3)} (95% range ${ruleLo.toFixed(2)}–${ruleHi.toFixed(2)})`);

// What a CSM actually sees: the top N per CSM, and how many leavers land there.
function capturedInTopN(scores: number[]): number {
  const byOwner = new Map<string, { score: number; left: boolean }[]>();
  test.ids.forEach((id, i) => {
    const owner = identity.canonical.get(id)?.["owner_csm_id"] || "unassigned";
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), { score: scores[i] ?? 0, left: testY[i] ?? false }]);
  });
  let captured = 0;
  for (const rows of byOwner.values()) {
    rows.sort((a, b) => b.score - a.score);
    captured += rows.slice(0, TOP_N).filter((r) => r.left).length;
  }
  return captured;
}
const modelCaptured = capturedInTopN(modelScores);
const ruleCaptured = capturedInTopN(ruleScores);
console.log(`\nleavers in each CSM's top ${TOP_N} (of ${leavers}):`);
console.log(`  logistic model: ${modelCaptured}`);
console.log(`  rule:           ${ruleCaptured}`);

// Sanity check against the answer key. The pipeline never reads it; this is evaluation only.
const truth = parseCsv(readFileSync(join(root, "data", "truth", "ground_truth.csv"), "utf8"));
const truthLeft = new Map(truth.map((t) => [t["sf_id"] ?? "", (t["left_date"] ?? "") > TEST_DATE && (t["left_date"] ?? "") <= horizon]));
let disagree = 0;
test.ids.forEach((id, i) => {
  if (truthLeft.get(id) !== testY[i]) disagree++;
});
console.log(`\nobserved label vs answer key: disagree on ${disagree} of ${test.ids.length} customers`);
