# Renewal Risk Call List

Each week, every CSM gets a ranked list of the renewals most likely to be lost in the next 90 days,
weighted by money at stake, with the reasons behind each score and a link from each reason to the
source records. The list is built nightly by a job that runs without anyone starting it.

Read `BRIEF.md` first for the problem and the disagreements with the request. This file covers what
was built, what was decided, what was skipped, and what breaks first.

Loom walkthrough: LINK_TBD

## Live demo

- App: https://fello-renewal-risk.vercel.app/ (sign-in asks for the demo access code, which is not in this repo). The same app is also at https://fello-renewal-risk-udhayakumarans-projects.vercel.app/.
- Database: Supabase project `fello-renewal-risk` (Singapore). The nightly run is a Vercel Cron job at 02:00 IST, protected by `CRON_SECRET`.
- Known gap: the database connection is encrypted but does not yet verify Supabase's certificate (`sslmode=no-verify`). Fix: verify against Supabase's root CA before relying on it outside a demo.

## Run it

Needs Node 24, Docker, and the Supabase CLI.

```bash
npm install
supabase start                 # local Postgres + Supabase auth on ports 54331-54339
cp .env.example .env           # set SESSION_SECRET (16+ characters)
npm run generate               # synthetic source data into data/raw (answer key in data/truth, never read by the pipeline)
supabase migration up --local  # database schema and tenant rules
npm run db:load                # load the source data (development reset: clears scoring tables too)
npm run nightly                # score and publish for every org (re-learns the points if the saved ones are 30+ days old)
PORT=3000 node --env-file=.env dist/src/web/server.js   # CSM app at http://localhost:3000
npm test                       # 30 checks (3 need CHROME_PATH), including tenant isolation, cookie expiry, traceability and the past-data evidence
npm run evaluate               # model vs simple rule, on a held-out date
npm run replay                 # day one vs a year later, replayed on the sample data
npm run deck                  # build docs/renewal-risk-deck.pptx
npm run e2e                   # 25 browser checks through the real app (Playwright; writes one test call record)
BASE_URL=https://... node e2e/run.js --read-only   # same checks against the live site, no writes (24 checks)
```

To run the nightly job itself on a schedule: `node --env-file=.env dist/src/pipeline/nightly.js --at 02:00`.
To show the failure path: `FORCE_FAIL=org_b npm run nightly`. That run is logged as failed and not published.

## What was built

| Part | What it does |
|---|---|
| Synthetic data | 5,000 customers in 4 orgs, three years of history. Five sources (Salesforce, Zendesk, product events, Stripe, Gmail metadata), about 201,000 event rows. Messy on purpose: out-of-order arrival, replayed events, duplicate CRM records, missing renewal dates, impossible dates, personal email addresses, customers with almost no activity. |
| Matching | Email domain first, then company name, and only when exactly one customer has that name. Unmatched records go to a review count, never dropped. |
| As-of features | 11 inputs per customer, computed only from records the system had received by the scoring date. A test proves a late-arriving event is ignored. |
| Model | Logistic regression written by hand (`src/model.ts`), so every reason is a weight times a value. Trained on past renewals only. |
| Labels | A customer counts as leaving if they cancel, or a renewal invoice is never paid or attempted, within 90 days. A failed card is not a departure. |
| Population | Only renewals in the next 90 days. Customers that can't be scored show as **unknown**, never as safe. |
| Nightly job | Scores every org, writes alerts and card reminders, then publishes. The points per clue are re-learned every 30 days (or with `RELEARN=1`) and reused on the other nights, so a score moves because the customer changed, not because the points did. Each org is all-or-nothing: a failure rolls back and the last good run stays published. The run log shows every attempt. |
| CSM app | Login (development stand-in), ranked list, top 15 as this week's calls, account page with every clue, the points it added or removed, how often past customers left with and without it, its source records, and a check that recomputes the score. Red / amber / green bands are set from the model's training base rate (red at twice the base rate, amber at the base rate). A "contacted" button takes an account off the call list for 14 days before the top 15 is cut, so a contact frees its slot. |
| Tenancy | Postgres row-level security on every table, keyed to the `org_id` claim. The web app sets that claim from its own HMAC-signed, expiring session cookie; the database does not verify a token on this path. Tested through the API and in the browser. |

## Decisions and why

1. **A fitted model, not a colour scale.** The brief asks for a model fit on the data. Hand weights are guesses. Logistic regression was chosen because each reason can be shown exactly, which matters more to a CSM than a few points of accuracy.
2. **No LLM anywhere in the scoring path.** The requirement is for a model trained on the data. Adding an LLM would add risk and make results harder to explain.
3. **Customer email is limited to one case.** The card-update reminder for a failed payment. Everything else creates an alert for the CSM. An "at-risk" email to a customer can cause the departure it is meant to prevent.
4. **Gmail is metadata only.** Who, when, direction, reply time. No message content is generated or stored. Reading customer email needs the business to confirm the legal basis first.
5. **Silent leavers are kept.** Half of the generated departures have no warning signs. Without them the model scored 0.95, which would have looked like a fake result. The model cannot catch these customers, and the README says so.
6. **The model does not use days-to-renewal.** It only sets the 90-day population. As a model input it had a counter-intuitive positive weight, most likely an artifact of billing cycles, and it is not something a CSM can act on.
7. **Labels count only never-attempted invoices as departures.** Failed cards are treated as support cases, as the brief says. Side effect: 21 of 1,640 test customers disagree with the answer key, because some real departures look like card failures. This is the ambiguity the brief describes, not something to hide.
8. **Tenant isolation is in the database, driven by the app.** RLS filters every table by the org claim. The app sets that claim from a verified session cookie, so the trust boundary is the app's cookie check. A bug that sets the wrong claim would widen access. Tests cover the wrong-org, forged, expired and tampered-cookie cases. The stronger fix is a database-verified token for the web app, listed as a next step.

## Results (synthetic data only)

Held-out date 2026-06-15. Trained only on earlier renewals.

| | Model | Simple rule (usage drop) |
|---|---|---|
| AUC (1.0 perfect, 0.5 coin flip), 95% range | 0.71 (0.65 to 0.85) | 0.60 (0.51 to 0.69) |
| Leavers caught in each CSM's top 15 (of 29) | 18 | 12 |

Read these numbers with care:
- The test set has only 29 leavers, so the ranges are wide.
- The data is generated. These numbers show that the pipeline works and the model beats the simple rule on this data. They do not predict performance on real customers.
- Earlier versions of the same model scored higher (0.83). That was before the label was corrected to stop counting failed cards as departures, and before days-to-renewal was removed as an input. I chose the more defensible version over the better number.

## Assumptions to confirm with the business

| Assumption | If wrong |
|---|---|
| Gmail metadata may be used, under a legal basis the business confirms | Drop Gmail from the pipeline; scoring still works |
| The VP of Customer Success approves turning on automatic messages | Automatic messages stay off |
| Billing or customer success approves the card-reminder wording, with legal review if required | The reminder is not sent |
| "Leaving" = cancellation, or an unpaid, never-attempted renewal invoice | Labels and metrics change |
| Opt-outs are recorded somewhere we can read | Reminders would go to everyone with a failed card |
| Renewal dates are mostly present; missing ones are shown as unknown | More unknowns, fewer scored customers |
| Salesforce owners are correct | Lists go to the wrong CSM |

## What is deliberately not built

- **Real sign-in.** The login page picks a CSM. A real deployment would use the company's identity provider and issue the same org claim.
- **Real email sending.** Card reminders are written to a table. The send step is a stub so the decision is visible and testable.
- **Real connectors.** Data is generated files loaded into Postgres. Live Salesforce, Zendesk, Stripe, and Gmail feeds would replace the loader.
- **Outcome measurement for calls.** Calls are logged (`csm_actions`), but there is no experiment, so we cannot yet say whether a call saves a customer.
- **Per-org models, gradient boosting, real-time scoring, mobile app.** Not needed to answer the brief.
- **CSRF tokens.** The session cookie is `SameSite=Strict` and actions are POST-only, which covers this app; a production app would add tokens.
- **Audit of who viewed which account.**

## What breaks first at 10x

Roughly in the order it would bite:

1. **The nightly job rescans everything.** Each org's data is loaded and rebuilt in memory and every customer is re-scored. At 10x (50,000 customers, about 2 million events) this takes minutes, then hits memory. Fix: incremental features keyed by the last ingested id, and a queue per org.
2. **Training loads all orgs at once.** Fix: train on a sample or on a dedicated job, and version each model.
3. **Matching by company name is O(customers) per lookup.** At scale, blocking by domain and by normalised name prefix is needed; the current code is correct but slow.
4. **Row-level security on large tables.** Policies are evaluated per row. At 10x the event table needs partitioning by org and month, and an index that matches the policy.
5. **Nightly run: Vercel Cron, no lock, 60-second limit.** `vercel.json` calls `/api/cron/nightly` once a day at 20:30 UTC (02:00 IST), and that function is capped at 60 seconds. Overlapping runs are not prevented: a manual call during the scheduled run starts a second one. Both write their own run rows, the later publish wins, and both can insert a card reminder for the same customer because `card_reminders` has no unique key. If the 60-second limit is hit, orgs that already published keep their new run, the org in progress rolls back and its run row stays `running`, and Vercel records a timeout. Fix: a Postgres advisory lock per run, a unique key on `card_reminders`, and a queue with one job per org once a run no longer fits in 60 seconds.
6. **Alerts accumulate.** Alerts from old runs are not closed. The page filters by the published run, but the table grows. Fix: close alerts when a run is superseded.
7. **The model is trained on synthetic patterns.** The first real data will shift the weights. The points are re-learned every 30 days, but nothing yet checks that a new version is at least as good as the old one before it goes live. Fix: compare each new version with the last on a held-out date before publishing, and monitor the score distribution and the top-15 hit rate each week.

## Honest limits

- The results come from data I generated. The model learns the patterns I chose to put in the generator, so the numbers show the pipeline works, not that it will work on your customers.
- Some of the signal depends on design choices I made (for example, the 90-day window and the 14-day suppression period). They are reasonable defaults, not measured values.
- Labels count some real departures as card failures. The model cannot separate them.

## Files

- `BRIEF.md`: the solution brief.
- `DATA_PLAN.md`: data definitions and the tenant rules.
- `gen/generate.ts`: synthetic data generator, with checks.
- `src/`: matching, features, model, evaluation, nightly job, explanations, web app.
- `supabase/migrations/`: schema, row-level security, and the scoring tables.
- `test/`: 30 checks across the pipeline, the database rules, and the web app.
- `docs/screenshots/`: what a CSM sees.
- `docs/renewal-risk-deck.pptx`: the walkthrough deck (built by `npm run deck`).

## Dependency audit

Runtime dependencies: 0 known vulnerabilities. One high-severity advisory (`image-size`, a denial of service on malformed image files) comes in through `pptxgenjs`, the deck builder. It is used only on this machine to build the deck from our own screenshots, not by the running app, so it is left as is.
