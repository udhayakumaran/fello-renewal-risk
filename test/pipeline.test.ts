import assert from "node:assert/strict";
import { test } from "node:test";
import type { CsvRow } from "../src/csv.js";
import { buildSnapshot, FEATURE_NAMES } from "../src/features.js";
import { buildIdentity } from "../src/identity.js";
import { indexSources } from "../src/index-sources.js";
import type { RawData } from "../src/load.js";
import { auc, fitLogistic, predict } from "../src/model.js";

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
