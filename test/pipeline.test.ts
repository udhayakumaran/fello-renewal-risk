import assert from "node:assert/strict";
import { test } from "node:test";
import type { CsvRow } from "../src/csv.js";
import { buildEvidence, describeRate } from "../src/evidence.js";
import { buildSnapshot, FEATURE_NAMES } from "../src/features.js";
import { needsRelearn } from "../src/pipeline/nightly.js";
import { buildIdentity } from "../src/identity.js";
import { indexSources } from "../src/index-sources.js";
import type { RawData } from "../src/load.js";
import { auc, fitLogistic, predict } from "../src/model.js";
import { baseRate, bandOf, splitCalls } from "../src/ranking.js";
import { makeCookie, readCookie, reasonDetail, typicalByFeature } from "../src/web/server.js";

const sfRow = (overrides: Partial<CsvRow>): CsvRow => ({
  sf_id: "SF1",
  org_id: "org_a",
  company_name: "Harbor Labs",
  email_domain: "harborlabs.com",
  owner_csm_id: "org_a-CSM1",
  contract_value: "12000",
  renewal_date: "2026-11-01",
  billing_cycle: "annual",
  start_date: "2024-01-10",
  ...overrides,
});

const emptyRaw = (sf: CsvRow[]): RawData => ({ sf, contacts: [], tickets: [], events: [], invoices: [], subs: [], gmail: [] });

test("as-of rule: an event received after the snapshot date is not used", () => {
  const raw = emptyRaw([sfRow({})]);
  raw.events = [
    // Happened on the snapshot day but only received two days later: must be ignored.
    { event_id: "e1", org_id: "org_a", account_domain: "harborlabs.com", user_id: "u1", event_type: "login", event_time: "2026-06-15 10:00", ingested_at: "2026-06-17 09:00" },
    // Received on time: counts.
    { event_id: "e2", org_id: "org_a", account_domain: "harborlabs.com", user_id: "u1", event_type: "login", event_time: "2026-06-14 10:00", ingested_at: "2026-06-14 11:00" },
  ];
  const identity = buildIdentity(raw.sf);
  const snap = buildSnapshot(identity.canonical, indexSources(raw, identity), "2026-06-15");

  const usageNow = FEATURE_NAMES.indexOf("usage_now_90d");
  assert.equal(snap.features[0]?.[usageNow], 1);
});

test("duplicate CRM records: the latest renewal date is kept", () => {
  const identity = buildIdentity([
    sfRow({ sf_id: "SF1", renewal_date: "2026-11-01" }),
    sfRow({ sf_id: "SF1-D", renewal_date: "2025-11-01" }),
  ]);
  assert.equal(identity.dropped, 1);
  assert.equal(identity.byDomain.get("harborlabs.com"), "SF1");
});

test("logistic model: ranks a separable case perfectly and gives sensible probabilities", () => {
  const X = [[0], [1], [2], [8], [9], [10]];
  const y = [false, false, false, true, true, true];
  const model = fitLogistic(X, y);
  const scores = X.map((x) => predict(model, x));
  assert.equal(auc(scores, y), 1);
  assert.ok((scores[0] ?? 1) < 0.5, "low value should be below 50%");
  assert.ok((scores[5] ?? 0) > 0.5, "high value should be above 50%");
});

const cand = (id: string, money: number | null, probability: number | null = 0.05) => ({ id, money, probability });

test("calls: a contacted account leaves the list before the cut, so its slot goes to the next one", () => {
  const rows = [cand("A", 900), cand("B", 800), cand("C", 700), cand("D", 600)];
  const { calls, watch, contacted } = splitCalls(rows, new Set(["A"]), 2);
  assert.deepEqual(calls.map((r) => r.id), ["B", "C"]);
  assert.deepEqual(watch.map((r) => r.id), ["D"]);
  assert.deepEqual(contacted.map((r) => r.id), ["A"]);
});

test("calls: highest money first, unscored rows never appear, nulls sort last", () => {
  const rows = [cand("X", null), cand("Y", 100), cand("Z", 300, null), cand("W", 200)];
  const { calls, watch } = splitCalls(rows, new Set(), 15);
  assert.deepEqual(calls.map((r) => r.id), ["W", "Y", "X"]);
  assert.equal(watch.length, 0);
});

test("bands: red at twice the base rate, amber at the base rate, green below", () => {
  const rate = baseRate(379, 16415); // the training base rate the local model reports
  assert.ok(Math.abs(rate - 0.0231) < 0.0001);
  assert.equal(bandOf(2 * rate, rate), "red");
  assert.equal(bandOf(rate, rate), "amber");
  assert.equal(bandOf(rate * 0.99, rate), "green");
  assert.equal(baseRate(0, 0), 0);
});

test("session cookie: a valid one is read back; an expired or tampered one is refused", () => {
  const secret = "test-secret-for-cookie-checks-000";
  const live = makeCookie({ org: "org_a", csm: "org_a-CSM1" }, secret);
  assert.deepEqual(readCookie(live, secret), { org: "org_a", csm: "org_a-CSM1" });
  const expired = makeCookie({ org: "org_a", csm: "org_a-CSM1" }, secret, -1000);
  assert.equal(readCookie(expired, secret), null);
  const [payload, mac] = live.split(".");
  const widened = Buffer.from(JSON.stringify({ org: "org_b", csm: "org_b-CSM1", exp: Date.now() + 60_000 })).toString("base64url");
  assert.equal(readCookie(`${widened}.${mac}`, secret), null, "changing the payload breaks the signature");
  assert.ok(payload);
});

test("reason chips show this account's value next to the typical one", () => {
  const reason = (feature: string, label: string, value: number) => ({
    feature, label, value, weight: 1, contribution: 1, sources: { ids: [], count: 0 },
  });
  const typical = typicalByFeature(["tickets_open", "usage_log_ratio", "log_contract_value", "inactive_contact_share"], [3, 0, Math.log(9500), 0.25]);

  assert.equal(reasonDetail(reason("tickets_open", "Support tickets still open", 9), typical.get("tickets_open")), "Support tickets still open: 9 vs typical 3");
  assert.equal(reasonDetail(reason("tickets_open", "Support tickets still open", 2.5), 2.4), "Support tickets still open: 2.5 vs typical 2.4");
  assert.equal(reasonDetail(reason("usage_log_ratio", "Usage trend falling", Math.log(0.7)), typical.get("usage_log_ratio")), "Usage trend falling: -30% vs typical 0%");
  assert.equal(reasonDetail(reason("log_contract_value", "Contract value ($)", 12000), typical.get("log_contract_value")), "Contract value: $12,000 vs typical $9,500");
  assert.equal(reasonDetail(reason("inactive_contact_share", "Some contacts marked inactive", 0.5), typical.get("inactive_contact_share")), "Some contacts marked inactive: 50% vs typical 25%");
  assert.equal(reasonDetail(reason("tickets_open", "Support tickets still open", 9), undefined), "Support tickets still open: 9");
  assert.equal(reasonDetail(reason("log_contract_value", "Contract value ($)", 1), typical.get("log_contract_value")), "Contract value: not in CRM");
});

test("evidence: counts leavers with and without a clue, and skips clues with no simple level", () => {
  const at = (name: (typeof FEATURE_NAMES)[number]): number => FEATURE_NAMES.indexOf(name);
  const row = (cancel: number): number[] => FEATURE_NAMES.map((n) => (n === "cancel_warning_120d" ? cancel : 0));
  // 4 customers asked to cancel (3 left), 6 did not (1 left).
  const X = [row(1), row(1), row(1), row(1), row(0), row(0), row(0), row(0), row(0), row(0)];
  const y = [true, true, true, false, true, false, false, false, false, false];
  const e = buildEvidence(X, y);
  assert.deepEqual(e["cancel_warning_120d"]?.present, { left: 3, total: 4 });
  assert.deepEqual(e["cancel_warning_120d"]?.absent, { left: 1, total: 6 });
  assert.equal(e["log_contract_value"], undefined);
  assert.equal(at("cancel_warning_120d") >= 0, true);
  assert.equal(describeRate({ left: 22, total: 39 }), "56 in 100 left (22 of 39)");
  assert.equal(describeRate({ left: 66, total: 4240 }), "1.6 in 100 left (66 of 4,240)");
  assert.equal(describeRate({ left: 0, total: 0 }), "no cases");
});

test("re-learning: monthly, and immediately when there is no saved model", () => {
  assert.equal(needsRelearn(null, "2026-10-19"), true);
  assert.equal(needsRelearn("2026-10-19", "2026-10-19"), false);
  assert.equal(needsRelearn("2026-09-20", "2026-10-19"), false); // 29 days
  assert.equal(needsRelearn("2026-09-19", "2026-10-19"), true); // 30 days
});
