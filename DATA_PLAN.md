# Data Plan: Renewal Risk Call List

**Purpose:** What data we store, how records link to one customer, and the rules for when each piece of data may be used. Written before the code and updated to match what was built. Where something is computed in code each run rather than stored, it says so.

**Plain-English summary:** Five raw sources come in. Each record is linked to one customer. For each customer on each date, we build a summary using only what the system knew on that date. A fitted model scores that summary. Every score can be traced back to the records behind it.

## 1. Rules that apply everywhere

1. **Every table has `org_id`.** Each customer company (tenant) only sees its own rows. This is enforced in the database, not only in the app.
2. **Raw data is never edited or deleted.** This lets us rebuild any past score exactly.
3. **Two timestamps on events:** `event_time` (when it happened) and `ingested_at` (when our system received it). Late and out-of-order data is normal. Features use only rows with `ingested_at` on or before the scoring date, so a score never uses information the system did not have then.
4. **Unmatched records are kept.** They stay in the raw tables and go to a review queue (`unmatched_records`, rebuilt every night, shown on the Unmatched page and counted by `npm run evaluate`). They are never dropped, but they are not attached to any customer.

## 2. Raw sources (as received, messy on purpose)

| Table | Source | Key columns | Notes |
|---|---|---|---|
| `sf_accounts` | Salesforce | `sf_id`, `company_name`, `email_domain`, `owner_csm_id`, `contract_value`, `renewal_date`, `billing_cycle` | Duplicate accounts and missing renewal dates |
| `sf_contacts` | Salesforce | `sf_contact_id`, `sf_id`, `email`, `role`, `is_active` | Role may be blank or out of date |
| `zd_tickets` | Zendesk | `ticket_id`, `org_ref`, `opened_at`, `closed_at`, `reopen_count`, `priority`, `ingested_at` | `closed_at` missing, or earlier than `opened_at` |
| `product_events` | Product | `event_id`, `account_ref`, `user_id`, `event_type`, `event_time`, `ingested_at` | Largest table. Can arrive days late, and be replayed |
| `stripe_invoices` | Stripe | `invoice_id`, `customer_ref`, `amount`, `due_date`, `status`, `attempt_count`, `sent_at`, `viewed_at` | `viewed_at` only if the customer opened it |
| `stripe_subscription_events` | Stripe | `event_id`, `customer_ref`, `event_type` (cancel_at_renewal, cancelled, downgraded, upgraded, reactivated), `event_time` | The clearest churn signals |
| `gmail_messages` | Gmail | `message_id`, `contact_id`, `counterpart_domain`, `direction`, `sent_at`, `reply_latency_hours` | Metadata only, no message content. Generated and loaded, but **not used in the score**. Using it needs the business to confirm the legal basis |

**Messiness generated:** duplicate rows, different ID formats per source, missing fields, late and replayed events, accounts with almost no events, records that exist in one source only, personal email addresses, and a few impossible values (for example, close before open).

## 3. Linking records to one customer (computed in code, not stored)

Matching order: (1) exact match on a shared ID, if one appears; (2) email domain from Salesforce contacts; (3) normalised company name, only when exactly one customer has that name. Anything else is counted as unmatched for that source. A low match rate is a finding, not a silent failure.

Duplicate CRM records are collapsed to one customer, keeping the latest renewal date.

## 4. Customer-level facts

Built from `sf_accounts` each run. If the CRM `renewal_date` is missing, the customer is shown as **not scored** with the reason, never as safe.

## 5. Renewal outcomes (training labels, computed in code)

**Observed outcome (what training and evaluation use):** left = a cancellation, or a renewal invoice never paid or attempted, dated within the 90 days after the scoring date and received by the time the model is trained. This is what a real team could observe. A failed card is treated as a support case, not a departure. A downgrade is a warning signal, not "left".

The generator's answer key (`data/truth`) is used only to check the label, never by the pipeline. In the current test, the label disagrees with it for 21 of 1,640 customers, because some real departures look like card failures.

**Training rows:** one row per customer per past scoring date, only where the next renewal is within 90 days. A customer whose renewal is further away is not yet a negative example.

**Silent leavers:** about half of generated leavers show no warning signs. We expect this in real life too, and the model cannot catch them.

## 6. What the model sees (computed in code, not stored)

**11 inputs per customer, per scoring date:**
- **Usage:** product events in the last 90 days, in the 90 days before that, the drop between them, and the log ratio.
- **Support:** tickets still open on the date, tickets opened in the last 90 days.
- **Subscription:** cancel-at-renewal warnings and downgrades in the last 120 days.
- **Account:** time as a customer, log of contract value.
- **Contacts:** share of contacts marked inactive.

**Population:** only customers with a renewal in the next 90 days are scored (the renewal date comes from the contract schedule, not the CRM field). Days until renewal is not an input: it only sets the population, because scoring everyone would let "renewal soon" alone predict the label.

**Not scored (shown as not scored, with the reason):** no renewal date in the CRM; already cancelled on or before the date; or a renewal invoice was sent but never attempted, so the outcome is unclear. A failed card is not one of these: that customer is scored and gets the card reminder.

## 7. Stored output

| Table | Holds |
|---|---|
| `models` | One row per learned model, `logit-<date>`: the points per clue, the typical value of each input, how many cases it learned from, and what past customers did with and without each clue. Re-learned every 30 days, reused in between |
| `runs` | Every nightly attempt per org: status (running, succeeded, failed), error, scored and not-scored counts |
| `scores` | One row per customer per run: chance of leaving, money at risk, not-scored reason, and the reasons (clue, value, points, source record IDs) |
| `unmatched_records` | The review queue: source records not linked to exactly one customer, with what we tried to match on. Rebuilt each night, so a record leaves once it matches |
| `published_runs` | Which run each org's CSMs see. Only a succeeded run is published, so a failed run is logged and never shown |

**Determinism:** training starts from zero with a fixed number of steps and no randomness, so the same data and model version always give the same score. A test rebuilds every stored score from its stored reasons.

## 8. Actions and outreach

| Table | Holds |
|---|---|
| `alerts` | `csm_review` and `card_failed` alerts, with status (open, handled, suppressed) and a reason |
| `card_reminders` | Card-update reminders. The send step is a stub: it writes a row, it does not send email |
| `opt_outs` | Customers who must not get customer email |
| `csm_actions` | Calls the CSM logged. Kept from day one so a later version can measure whether calls help |

**Suppression rules, in order:** (1) opted-out customer: no customer email, alert only; (2) a CSM contacted the customer in the last 14 days: the alert is held back; (3) a card reminder in the last 14 days: no second reminder.

## 9. Open items this plan depends on

| Item | Assumption | Check when |
|---|---|---|
| Opt-out setting | Exists somewhere; modelled as `opt_outs` | Before any customer email is sent |
| Contact roles | Present but may be stale | Once real data is seen |
| Gmail | Loaded, not scored | When the legal basis is confirmed |
| Renewal dates | Mostly present | Measured in the generated data |
| Past call history | About three years, with gaps | Measured in the generated data |

## 10. What this plan does not cover

- Connections to real Salesforce, Zendesk, Stripe or Gmail (we use generated files).
- Authentication beyond a demo login.
- Per-customer-type models.
- Real email sending.
