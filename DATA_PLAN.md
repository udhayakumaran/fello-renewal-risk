# Data Plan: Renewal Risk Call List

**Purpose:** Defines what data we store, how records link to one customer, and the rules for when each piece of data may be used. Written before any code, so it can be checked first.

**Plain-English summary:** Five raw data sources come in. Each record is linked to one customer. For each customer on each date, we build a summary using only what the system knew on that date. A fitted model scores that summary. Every score can be traced back to the records behind it.

## 1. Rules that apply everywhere

1. **Every table has `org_id`.** Each customer company (tenant) only sees its own rows. This is enforced in the database, not only in the app.
2. **Raw data is never edited or deleted.** Corrections are new rows. This lets us rebuild any past score exactly.
3. **Two timestamps on every event:**
   - `event_time`: when it happened (for example, the ticket was opened).
   - `ingested_at`: when our system received it.
   Late or out-of-order data is normal. Features use `ingested_at <= as_of_date`, so a score never uses information the system didn't have on that date.
4. **Unmatched records are kept.** They go to a review queue. They are never dropped.

## 2. Raw sources (as received, messy on purpose)

| Table | Source | Key columns | Notes |
|---|---|---|---|
| `sf_accounts` | Salesforce | `sf_id`, `company_name`, `email_domain`, `owner_csm_id`, `contract_value`, `renewal_date`, `billing_cycle` (monthly / annual / multi-year) | Can contain duplicate accounts and missing renewal dates |
| `sf_contacts` | Salesforce | `sf_contact_id`, `sf_id`, `email`, `role`, `is_active` | Role may be blank or out of date |
| `zd_tickets` | Zendesk | `ticket_id`, `org_ref`, `opened_at`, `closed_at`, `reopen_count`, `priority`, `ingested_at` | `closed_at` can be missing or earlier than `opened_at` (data error) |
| `product_events` | Product | `event_id`, `account_ref`, `user_id`, `event_type`, `event_time`, `ingested_at` | Largest table (most of the 200,000 events). Can arrive days late |
| `stripe_invoices` | Stripe | `invoice_id`, `customer_ref`, `amount`, `due_date`, `status` (paid / open / failed / void), `attempt_count`, `sent_at`, `viewed_at` | `viewed_at` only exists if the customer opened the invoice |
| `stripe_subscription_events` | Stripe | `event_id`, `customer_ref`, `event_type` (cancel_at_renewal / cancelled / downgraded / upgraded / reactivated), `event_time` | The clearest churn signals |
| `gmail_meta` | Gmail | not loaded in v1 | Parked. Metadata only if added later |

**Messiness we will generate:** duplicate rows, different ID formats per source, missing fields, timestamps arriving late, accounts with almost no events, accounts that exist in one source only, and a few impossible values (for example, close before open).

## 3. Linking records to one customer

**Table: `identity_map`**
- `org_id`, `source`, `source_ref`, `customer_id`, `match_method`, `confidence`, `matched_at`

**Matching order:**
1. Exact match on a known shared ID (none expected in v1, but handled if it appears).
2. Email domain match from Salesforce contacts.
3. Normalized company name match (lowercase, punctuation and suffixes like "Ltd" removed).
4. Anything else goes to `review_queue`, with the reason.

**Table: `review_queue`**
- `org_id`, `source`, `source_ref`, `reason`, `status` (open / resolved), `created_at`

**Measure we report:** match rate per source, and how many records are in the queue. A low match rate is a finding, not a silent failure.

## 4. Customer-level facts

**Table: `customers`**
- `customer_id`, `org_id`, `sf_id`, `company_name`, `owner_csm_id`, `contract_value`, `renewal_date`, `billing_cycle`, `data_quality_flags`

**Rule:** if `renewal_date` is missing, the customer is shown as **unknown**, never as safe. The reason is stored in `data_quality_flags`.

## 5. Renewal outcomes (training labels)

**Table: `renewal_outcomes`**
- `customer_id`, `renewal_date`, `outcome` (renewed / left), `left_on`, `returned_on` (nullable)

**Definition (agreed):**
- **Left** = the customer cancels before or at renewal, or cancels mid-contract.
- **Downgrade is not "left."** It is tracked as a separate warning signal.
- **Returned within a few months still counts as left.** The label is set at the first cancel.

**Training rows:** one row per (customer, as-of date) where the renewal date falls within the next 90 days. A customer whose renewal is further away is not a negative example yet.

**Observed outcome (what training and evaluation use):** left = a cancellation, or a renewal invoice still unpaid, dated within the 90 days after the as-of date. This is what a real team could observe. The answer key is only used to check it (6 disagreements in 1,609 customers in the current test).

**Silent leavers:** some customers leave with no warning signs. We expect this in real life too, and the model cannot catch them. Their share is a stated assumption (half of leavers in the generator).

## 6. Feature snapshots (what the model sees)

**Table: `feature_snapshots`**
- `snapshot_id`, `org_id`, `customer_id`, `as_of_date`, `features` (JSON), `computed_at`

**Feature list (first version, 13 features):**
- **Usage:** events in the last 90 days, events in the 90 days before that, the drop between them, and the log ratio. Compared with that customer's own past, not other customers.
- **Support:** open tickets as of the date, tickets opened in the last 90 days.
- **Subscription:** cancel-at-renewal warning and downgrades in the last 120 days.
- **Account:** days to renewal (from the contract schedule, not the CRM field), renewal-date missing flag, tenure, log contract value.
- **Contacts:** share of contacts marked inactive (a noisy proxy for a champion leaving).

**Population:** only customers with a renewal in the next 90 days are scored. This is the list the CSM works from. Scoring everyone would let "renewal soon" alone predict the label.

**Excluded from scoring (shown as unknown):** customers with a cancellation on or before the as-of date, or a renewal invoice sent on or before it that is still unpaid. Their state is unclear, so they are not scored as safe.

**Dropped:** an unpaid-invoice feature. It was always zero, because accounts with unpaid invoices are excluded before scoring.

**Rule:** a feature is computed only from records with `ingested_at <= as_of_date` (invoices use `sent_at`, since they have no ingestion time).

## 7. Scores and traceability

**Table: `scores`**
- `score_id`, `org_id`, `customer_id`, `as_of_date`, `run_id`, `model_version`, `probability`, `reasons` (JSON: each reason, its value, its weight, and its source record IDs), `snapshot_id`

**Model version:** a stored file with its training date, data range, and a fixed random seed. The same snapshot and model version always produce the same score.

**Table: `runs`**
- `run_id`, `org_id`, `started_at`, `finished_at`, `status` (running / succeeded / failed), `error`, `row_counts` (JSON)

**Publish rule:** the list the CSM sees points to the last successful run only. A failed run is logged and never shown. Stored in `published_runs` (`org_id`, `run_id`, `published_at`).

## 8. Actions and outreach

**Table: `alerts`**
- `alert_id`, `org_id`, `customer_id`, `run_id`, `alert_type` (csm_review / payment_issue), `status` (open / handled / suppressed), `suppressed_reason`

**Table: `card_reminders`**
- `org_id`, `customer_id`, `invoice_id`, `sent_at`

**Table: `opt_outs`**
- `org_id`, `customer_id`, `set_at`, `source`

**Suppression rules (in order):**
1. Customer has opted out of messages → no customer email. Alert only.
2. A CSM contacted the customer in the last 14 days → alert is marked "already handled." It is still shown, but grayed out.
3. A card reminder was sent in the last 14 days → no second reminder.

**Table: `csm_actions`**
- `org_id`, `customer_id`, `csm_id`, `action_date`, `action_type`
Stored from day one, so a later version can measure whether calls help.

## 9. Open items this plan depends on

| Item | Assumption in this plan | Check when |
|---|---|---|
| Opt-out setting | Exists somewhere; we model it as `opt_outs` | Before any customer email is sent |
| Contact roles | Present but may be stale; used only for the alert text in v1 | Once real data is seen |
| Gmail | Not loaded | v2 |
| Renewal dates | Mostly present | Measured in the generated data (percent missing) |
| Past call history | About 3 years, as stated in the request, with gaps. Most recent year weighted most in evaluation | Measured in the generated data (percent missing per year) |

## 10. What this plan does not cover

- Connections to real Salesforce, Zendesk, or Stripe (we use generated files).
- Authentication beyond a demo login.
- Per-customer-type models.
- Anything about Gmail.
