/**
 * The nightly run. Trains the risk model on past renewals, scores each org's renewals in the next
 * 90 days, and publishes a run only when every step for that org succeeded. A failed run is kept
 * in the run log and never shown to a CSM.
 *
 * Usage:
 *   npm run nightly                       run once for today (or AS_OF=YYYY-MM-DD)
 *   npm run nightly -- --at 02:00         run every day at 02:00 (local time)
 *   FORCE_FAIL=<org_id> npm run nightly   simulate a failure for one org, to show the run log
 *   RELEARN=1 npm run nightly             re-learn the points now instead of reusing the saved ones
 */
import type pg from "pg";
import { ownerClient } from "../db.js";
import { buildEvidence, type Evidence } from "../evidence.js";
import { LABELS, sourceIdsFor } from "../explain.js";
import { buildSnapshot, FEATURE_NAMES, horizonFor, nextRenewal, observedLeft, unknownReason } from "../features.js";
import { buildIdentity, type Identity } from "../identity.js";
import { indexSources, type SourceIndex } from "../index-sources.js";
import { fitLogistic, type Model, predict } from "../model.js";
import { CONTACT_WINDOW_DAYS, splitCalls } from "../ranking.js";
import { insertMany } from "../db/batch.js";
import { loadOrgRaw, orgIds } from "./source-db.js";

const WINDOW_DAYS = 90;
const MODEL_MAX_AGE_DAYS = 30; // the points per clue are re-learned monthly; other nights reuse them
const CARD_REMINDER_DAYS = 14; // no second card reminder to the same customer inside this window
const TRAIN_CUTS = [
  "2024-06-15", "2024-09-15", "2024-12-15", "2025-03-15", "2025-06-15",
  "2025-09-15", "2025-12-15", "2026-03-15", "2026-06-15", "2026-07-15",
];

interface OrgData {
  orgId: string;
  identity: Identity;
  idx: SourceIndex;
}

interface Reason {
  feature: string;
  label: string;
  value: number;
  weight: number;
  contribution: number;
  sources: { ids: string[]; count: number };
  /** What happened to past customers with and without this clue. Absent for clues with no natural level. */
  evidence?: Evidence;
}

interface ScoredRow {
  sfId: string;
  owner: string;
  company: string;
  renewalDate: string | null;
  daysToRenewal: number;
  contractValue: number | null;
  probability: number | null;
  moneyAtRisk: number | null;
  unknownReason: string | null;
  reasons: Reason[];
}

const DAY_MS = 86_400_000;
const round = (n: number, places: number): number => Math.round(n * 10 ** places) / 10 ** places;
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
function renewingSoon(days: number): boolean {
  return days <= WINDOW_DAYS;
}

async function loadOrgs(client: pg.Client): Promise<OrgData[]> {
  const orgs: OrgData[] = [];
  for (const orgId of await orgIds(client)) {
    const raw = await loadOrgRaw(client, orgId);
    const identity = buildIdentity(raw.sf);
    orgs.push({ orgId, identity, idx: indexSources(raw, identity) });
  }
  return orgs;
}

/** Past renewals only: each cut's outcomes must be fully known by the run date. */
function trainingSet(orgs: OrgData[], asOf: string): { X: number[][]; y: boolean[] } {
  const X: number[][] = [];
  const y: boolean[] = [];
  for (const cut of TRAIN_CUTS) {
    if (horizonFor(cut) > asOf) continue;
    for (const org of orgs) {
      const snap = buildSnapshot(org.identity.canonical, org.idx, cut);
      snap.ids.forEach((id, i) => {
        const x = snap.features[i] ?? [];
        if (!renewingSoon(snap.days[i] ?? Infinity)) return;
        X.push(x);
        y.push(observedLeft(org.idx, id, cut, horizonFor(cut), asOf));
      });
    }
  }
  return { X, y };
}

function explain(model: Model, x: number[], sfId: string, org: OrgData, asOf: string, evidence: Record<string, Evidence>): Reason[] {
  return FEATURE_NAMES.map((feature, j) => {
    const weight = model.weights[j] ?? 0;
    const z = ((x[j] ?? 0) - (model.mean[j] ?? 0)) / (model.scale[j] ?? 1);
    return {
      feature,
      label: LABELS[feature] ?? feature,
      // The model uses log(contract value); show the dollar amount a CSM recognises.
      value: feature === "log_contract_value" ? Math.round(Math.exp(x[j] ?? 0)) : round(x[j] ?? 0, 2),
      weight: round(weight, 4),
      contribution: round(weight * z, 4),
      sources: sourceIdsFor(feature, sfId, org.idx, asOf),
      ...(evidence[feature] ? { evidence: evidence[feature] } : {}),
    };
  }).sort((a, b) => b.contribution - a.contribution);
}

function scoreOrg(org: OrgData, model: Model, asOf: string, evidence: Record<string, Evidence>): ScoredRow[] {
  const rows: ScoredRow[] = [];
  const snap = buildSnapshot(org.identity.canonical, org.idx, asOf);
  const scored = new Set<string>();

  snap.ids.forEach((id, i) => {
    const x = snap.features[i] ?? [];
    const days = snap.days[i] ?? Infinity;
    if (!renewingSoon(days)) return;
    const sf = org.identity.canonical.get(id);
    if (!sf) return;
    const probability = predict(model, x);
    const value = sf["contract_value"] ? Number(sf["contract_value"]) : null;
    scored.add(id);
    rows.push({
      sfId: id,
      owner: sf["owner_csm_id"] || "unassigned",
      company: sf["company_name"] ?? "",
      renewalDate: sf["renewal_date"] || null,
      daysToRenewal: Math.round(days),
      contractValue: value,
      probability: round(probability, 4),
      moneyAtRisk: value === null ? null : round(probability * value, 2),
      unknownReason: null,
      reasons: explain(model, x, id, org, asOf, evidence),
    });
  });

  // Renewing soon but not scored: shown as unknown, never as safe.
  for (const [id, sf] of org.identity.canonical) {
    if (scored.has(id) || !sf["start_date"] || !sf["billing_cycle"]) continue;
    const renewal = nextRenewal(sf["start_date"], sf["billing_cycle"], asOf);
    const days = daysBetween(asOf, renewal.slice(0, 10));
    if (days > WINDOW_DAYS) continue;
    const reason = !sf["renewal_date"] ? "no renewal date in CRM" : unknownReason(org.idx, id, asOf);
    if (!reason) continue;
    rows.push({
      sfId: id,
      owner: sf["owner_csm_id"] || "unassigned",
      company: sf["company_name"] ?? "",
      renewalDate: sf["renewal_date"] || null,
      daysToRenewal: days,
      contractValue: sf["contract_value"] ? Number(sf["contract_value"]) : null,
      probability: null,
      moneyAtRisk: null,
      unknownReason: reason,
      reasons: [],
    });
  }
  return rows;
}

async function saveModel(
  client: pg.Client,
  modelId: string,
  model: Model,
  rows: number,
  leavers: number,
  evidence: Record<string, Evidence>,
): Promise<void> {
  await client.query(
    `insert into models (model_id, feature_names, feature_mean, feature_scale, weights, bias, training_rows, training_leavers, evidence)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (model_id) do update set trained_at = now(), feature_names = excluded.feature_names,
       feature_mean = excluded.feature_mean, feature_scale = excluded.feature_scale,
       weights = excluded.weights, bias = excluded.bias,
       training_rows = excluded.training_rows, training_leavers = excluded.training_leavers,
       evidence = excluded.evidence`,
    [modelId, FEATURE_NAMES, model.mean, model.scale, model.weights, model.bias, rows, leavers, JSON.stringify(evidence)],
  );
}

interface SavedModel {
  modelId: string;
  /** The date it was learned as of, taken from its id. */
  learnedOn: string;
  model: Model;
  evidence: Record<string, Evidence>;
  rows: number;
  leavers: number;
}

/** True when there is no usable saved model, or the saved one is at least maxAgeDays old. */
export function needsRelearn(learnedOn: string | null, asOf: string, maxAgeDays = MODEL_MAX_AGE_DAYS): boolean {
  return learnedOn === null || daysBetween(learnedOn, asOf) >= maxAgeDays;
}

/**
 * The latest model learned on or before asOf. Skipped (so the job re-learns) when it has no
 * stored evidence or was built for a different list of clues.
 */
async function loadSavedModel(client: pg.Client, asOf: string): Promise<SavedModel | null> {
  const row = (
    await client.query(
      `select model_id, feature_names, feature_mean, feature_scale, weights, bias, training_rows, training_leavers, evidence
       from models where model_id like 'logit-%' and model_id <= $1 order by model_id desc limit 1`,
      [`logit-${asOf}`],
    )
  ).rows[0];
  if (!row || !row.evidence) return null;
  if (JSON.stringify(row.feature_names) !== JSON.stringify([...FEATURE_NAMES])) return null;
  return {
    modelId: row.model_id,
    learnedOn: String(row.model_id).slice("logit-".length),
    model: { mean: row.feature_mean.map(Number), scale: row.feature_scale.map(Number), weights: row.weights.map(Number), bias: Number(row.bias) },
    evidence: row.evidence,
    rows: Number(row.training_rows),
    leavers: Number(row.training_leavers),
  };
}

/** Stage 1 of publishing: one org's run. Writes are one transaction; a failure rolls them back. */
async function runOrg(
  client: pg.Client,
  org: OrgData,
  model: Model,
  modelId: string,
  asOf: string,
  forceFail: boolean,
  evidence: Record<string, Evidence>,
): Promise<{ status: "succeeded" | "failed"; scored: number; unknown: number; error?: string }> {
  const run = await client.query(
    "insert into runs (org_id, as_of, model_id, status) values ($1, $2, $3, 'running') returning run_id",
    [org.orgId, asOf, modelId],
  );
  const runId = run.rows[0]?.run_id as string;

  try {
    const rows = scoreOrg(org, model, asOf, evidence);
    const scored = rows.filter((r) => r.probability !== null).length;
    const unknown = rows.length - scored;

    await client.query("begin");
    await insertMany(
      client,
      "scores",
      ["org_id", "run_id", "sf_id", "owner_csm_id", "company_name", "renewal_date", "days_to_renewal",
        "contract_value", "probability", "money_at_risk", "unknown_reason", "reasons"],
      rows.map((r) => [org.orgId, runId, r.sfId, r.owner, r.company, r.renewalDate, r.daysToRenewal, r.contractValue,
        r.probability, r.moneyAtRisk, r.unknownReason, JSON.stringify(r.reasons)]),
    );

    await writeAlerts(client, org.orgId, runId, rows, asOf);
    await writeCardReminders(client, org, asOf);

    if (forceFail) throw new Error("FORCE_FAIL: simulated failure before publish");

    await client.query(
      "update runs set status = 'succeeded', finished_at = now(), scored_count = $2, unknown_count = $3 where run_id = $1",
      [runId, scored, unknown],
    );
    await client.query(
      `insert into published_runs (org_id, run_id) values ($1, $2)
       on conflict (org_id) do update set run_id = excluded.run_id, published_at = now()`,
      [org.orgId, runId],
    );
    await client.query("commit");
    return { status: "succeeded", scored, unknown };
  } catch (error) {
    await client.query("rollback");
    const message = error instanceof Error ? error.message : String(error);
    await client.query("update runs set status = 'failed', finished_at = now(), error = $2 where run_id = $1", [runId, message]);
    return { status: "failed", scored: 0, unknown: 0, error: message };
  }
}

/**
 * This week's calls per CSM. Accounts contacted in the last 14 days are left out before the top 15
 * is cut, so a recent contact never uses up a call slot. Same rule as the CSM page (ranking.ts).
 */
async function writeAlerts(client: pg.Client, orgId: string, runId: string, rows: ScoredRow[], asOf: string): Promise<void> {
  const contacted = new Set(
    (
      await client.query(
        "select sf_id from csm_actions where org_id = $1 and action_date > $2::date - $3::int",
        [orgId, asOf, CONTACT_WINDOW_DAYS],
      )
    ).rows.map((r: { sf_id: string }) => r.sf_id),
  );
  const byOwner = new Map<string, ScoredRow[]>();
  for (const r of rows) {
    byOwner.set(r.owner, [...(byOwner.get(r.owner) ?? []), r]);
  }
  const alertRows: unknown[][] = [];
  for (const list of byOwner.values()) {
    const { calls } = splitCalls(
      list.map((r) => ({ ...r, id: r.sfId, money: r.moneyAtRisk })),
      contacted,
    );
    for (const r of calls) alertRows.push([orgId, runId, r.sfId, r.owner, "csm_review", "open", null]);
  }
  await insertMany(client, "alerts", ["org_id", "run_id", "sf_id", "owner_csm_id", "alert_type", "status", "suppressed_reason"], alertRows);
}

/**
 * The only automatic customer message: a card-update reminder when a payment failed recently.
 * Skipped for opted-out customers and for customers already reminded in the last 14 days.
 */
async function writeCardReminders(client: pg.Client, org: OrgData, asOf: string): Promise<void> {
  const optedOut = new Set(
    (await client.query("select sf_id from opt_outs where org_id = $1", [org.orgId])).rows.map((r: { sf_id: string }) => r.sf_id),
  );
  const recent = new Set(
    (
      await client.query(
        "select sf_id from card_reminders where org_id = $1 and sent_at > ($2::date - $3::int)",
        [org.orgId, asOf, CARD_REMINDER_DAYS],
      )
    ).rows.map((r: { sf_id: string }) => r.sf_id),
  );
  for (const [sfId, invoices] of org.idx.invoices) {
    if (optedOut.has(sfId) || recent.has(sfId)) continue;
    const failed = invoices.find((i) => {
      const sent = (i["sent_at"] ?? "").slice(0, 10);
      return i["status"] === "failed" && sent > daysAgo(asOf, CARD_REMINDER_DAYS) && sent <= asOf;
    });
    if (!failed) continue;
    await client.query(
      "insert into card_reminders (org_id, sf_id, invoice_id, channel) values ($1, $2, $3, 'log')",
      [org.orgId, sfId, failed["invoice_id"]],
    );
    recent.add(sfId);
  }
}

function daysAgo(asOf: string, n: number): string {
  return new Date(Date.parse(asOf) - n * DAY_MS).toISOString().slice(0, 10);
}

export async function runNightly(asOf: string): Promise<{ failures: number }> {
  const client = ownerClient();
  await client.connect();
  const forced = process.env["FORCE_FAIL"];
  const startedAt = new Date();
  console.log(`nightly run as of ${asOf} started ${startedAt.toISOString()}`);
  let failures = 0;
  try {
    const orgs = await loadOrgs(client);
    const saved = process.env["RELEARN"] ? null : await loadSavedModel(client, asOf);
    let model: Model;
    let evidence: Record<string, Evidence>;
    let modelId: string;
    if (saved && !needsRelearn(saved.learnedOn, asOf)) {
      ({ model, evidence, modelId } = saved);
      console.log(`model ${modelId}: reused (learned ${daysBetween(saved.learnedOn, asOf)} days ago, re-learned every ${MODEL_MAX_AGE_DAYS} days)`);
    } else {
      const { X, y } = trainingSet(orgs, asOf);
      model = fitLogistic(X, y);
      evidence = buildEvidence(X, y);
      modelId = `logit-${asOf}`;
      await saveModel(client, modelId, model, X.length, y.filter(Boolean).length, evidence);
      console.log(`model ${modelId}: re-learned from ${X.length} renewals, ${y.filter(Boolean).length} leavers`);
    }

    for (const org of orgs) {
      const result = await runOrg(client, org, model, modelId, asOf, forced === org.orgId, evidence);
      if (result.status === "succeeded") {
        console.log(`  ${org.orgId}: published (${result.scored} scored, ${result.unknown} unknown)`);
      } else {
        failures++;
        console.log(`  ${org.orgId}: FAILED, not published. ${result.error}`);
      }
    }
  } finally {
    await client.end();
  }
  return { failures };
}

function msUntil(time: string): number {
  const [hh, mm] = time.split(":").map(Number);
  const next = new Date();
  next.setHours(hh ?? 0, mm ?? 0, 0, 0);
  if (next <= new Date()) next.setDate(next.getDate() + 1);
  return next.getTime() - Date.now();
}

async function main(): Promise<void> {
  const at = process.argv.indexOf("--at");
  const todayUtc = new Date().toISOString().slice(0, 10);
  if (at === -1) {
    const { failures } = await runNightly(process.env["AS_OF"] ?? todayUtc);
    process.exitCode = failures > 0 ? 1 : 0;
    return;
  }
  const time = process.argv[at + 1] ?? "02:00";
  console.log(`scheduled: every day at ${time} (local time)`);
  const tick = (): void => {
    setTimeout(async () => {
      try {
        await runNightly(process.env["AS_OF"] ?? new Date().toISOString().slice(0, 10));
      } catch (error) {
        console.error("nightly run crashed:", error);
      }
      tick();
    }, msUntil(time));
  };
  tick();
}

// Run only when executed directly, not when imported by tests.
if (process.argv[1]?.endsWith("nightly.js")) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
