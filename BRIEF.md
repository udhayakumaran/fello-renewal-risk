# Solution Brief: Renewal Risk Call List (Fello take-home)

**In one sentence:** Each week, give every CSM a ranked list of the accounts most likely to leave in the next 90 days, weighted by money at stake, with the reasons and the source records behind each reason, so limited call time goes where it matters.

**Status:** Draft for review. The assumptions in section 5 are my working choices, and the author has accepted them. Written before any code.

## 1. The actual problem

Each CSM owns about 120 accounts and has time for roughly 15–20 calls a week. Customer signals are spread across Salesforce, Zendesk, product events, Stripe and Gmail, so nobody sees the full picture for an account. Each Monday the CSM guesses who to call. The VP says two renewals were lost last quarter where the signals were already in the data.

The real problem is not "we need a dashboard." It is: **every week, pick the few accounts that most need a call, and give the CSM the reasons, so the call time goes where it matters.** Two sub-problems:
1. Combine the signals into one view per account, as of a given date.
2. Rank accounts by chance of leaving in the next 90 days, weighted by money at stake.

## 2. What I would build

A weekly ranked call list for each CSM:
- Each account shows: chance of leaving in the next 90 days, contract value, renewal date, the top reasons in plain words, and the source records behind each reason.
- The chance comes from a model trained on past renewals (which accounts stayed, which left), not from hand-set weights.
- Accounts with too little data show as **unknown**, never as safe.
- One automatic customer email only: a card-update reminder when a payment fails. Everything else creates an alert for the CSM.
- A scheduled nightly run builds the new list and publishes it only if the whole run succeeds.

**Stack:** TypeScript (strict mode) on Node.js. Postgres through local Supabase, with row-level security for customer separation. Express with server-rendered HTML. The risk model is logistic regression written by hand, so every reason shown can be traced to a weight. Tests use Node's built-in test runner.

## 3. What I would build first

A thin slice that covers every non-negotiable, not a wide product:
1. Synthetic data across the five sources, deliberately messy (late events, duplicate records, mismatched IDs, accounts with almost no history).
2. Matching records to one customer. Unmatched records go to a review queue, not the bin.
3. Signal summary per account as of a date, using only what the system knew on that date.
4. One model, tested on a later time period than it was trained on, compared with a simple rule-based baseline.
5. One ranked list page with reasons, and a trace from each reason back to the source records.
6. Scheduled nightly run, with a log of every run, including a failed one.

Left out of the first slice: Gmail, automated emails beyond the card reminder, UI polish, real connectors.

## 4. Where I disagree with the request, and why

1. **Red / yellow / green health score.** Colors hide how sure we are and what the money is. I would rank by risk and money instead, and show colors only as a cut-off on that ranking. Hand-set weights are guesses; we have past renewals to learn from.
2. **Email the customer when they go red.** A "we think you're leaving" email can cause the churn it is meant to prevent. A wrong email damages trust, and the relationship belongs to the CSM. The request's wording is ambiguous: the forwarded text says the system should email the accounts, while the note from the reviewer says it should email the CSMs. I read both:
   - *Email the CSM:* this is the default. The alert goes to the CSM, who decides what to do.
   - *Email the customer:* only the card-update reminder is automatic, since it is a payment notice with no judgment in it. Any other customer email needs a person to approve the wording first.
3. **"Nothing slips."** That can't be promised. Capacity is limited. Ranking makes the limited time go further. Unknown accounts must be visible, not assumed fine.
4. **Two lost renewals as the proof.** Two cases can't train or test anything. The model needs the full renewal history.

## 5. What I would need from the business (and what I assume)

| Open question | Assumption I build on | If the assumption is wrong |
|---|---|---|
| Renewal dates, contract value, owner | Present in Salesforce, mostly accurate | Accounts without a renewal date show as unknown |
| Shared customer ID across systems | None. Match by email domain, then company name | Unmatched records go to a review queue |
| Notes and call history | About 3 years, as stated in the request, with gaps | Gaps reported per year; model trained on complete periods |
| Gmail access | Not used in v1 | Becomes a v2 question |
| "Leaving" definition | Full cancel, including mid-contract. Returning within a few months still counts as leaving | Changes the training labels and the metrics |
| Who approves turning on automation | VP of Customer Success | Automation stays off by default |
| Who approves email wording | Billing or customer success, plus legal if required | Card reminder waits for approval |
| Past outreach outcomes | Not recorded in a usable form | Model can rank who is at risk, but cannot show a call helped |

## 6. How we'll know it works

- **Ranking beats the simple rule.** On a later time period than the training data, the model must put more of the accounts that actually left into each CSM's top 15–20 than a simple rule-based baseline does.
- **Numbers are shown with ranges.** With about 10% of accounts leaving, small groups give noisy results, so confidence ranges are shown, not single numbers.
- **Every number traces back.** A test checks that each reason on screen links to the stored source records.
- **Reruns match.** Running the pipeline again on the same data gives the same scores.
- **Customers stay separate.** A test checks that one customer's data cannot be seen by another customer's users.
- **Limits are stated.** The README says these results show the pipeline works. They do not prove the model will work on real customers.

## 7. Risks I am carrying

- **The model learns my synthetic data.** Accuracy numbers show the pipeline works, not that it will work on real customers.
- **Calls are not random.** Past outreach was probably aimed at risky accounts, so comparisons are biased.
- **Stripe "unpaid" is ambiguous.** It could be a failed card, a slow invoice, or real intent to leave. The alert shows which case applies.
- **Small numbers.** Per-group results will be noisy; confidence ranges are shown for this reason.
