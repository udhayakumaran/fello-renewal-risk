# Solution Brief: Renewal Risk Call List (Fello take-home)

**In one sentence:** Each week, give every CSM a ranked list of the renewals most likely to be lost in the next 90 days, weighted by money at stake, with the reasons and the source records behind each reason.

*Written before any code and lightly updated after the build. Things I assumed, because the request does not say, are marked "assumed".*

## 1. The actual problem

Each CSM owns about 120 accounts and cannot call them all (assumed: 15 to 20 calls a week). The signals sit in five tools, so nobody sees the full picture, and each Monday the CSM guesses who to call. Two renewals were lost last quarter with the signals already in the data. The need is not a dashboard. It is: **every week, pick the accounts that most need a call, and say why.**

## 2. What I would build, and what first

A weekly ranked call list per CSM. Each account shows the chance of leaving in 90 days, contract value, renewal date, plain-language reasons, and the source records behind each reason. The chance comes from a model fitted on past renewals, not hand-set weights. Accounts with too little data show as **not scored**, never as safe. A nightly job scores everyone and publishes only if the whole run succeeds.

First slice, covering all five must-haves: generated messy data for the five sources; matching records to one customer; a per-date summary using only what was known on that date; one model tested on a later date against a simple rule; one list page with traceable reasons; a nightly run with a log. Left out first: automatic email beyond the card reminder, UI polish, real connectors.

Stack: TypeScript, Postgres (Supabase) with row-level security, Express.

## 3. Where I disagree with the request

1. **Red / yellow / green score.** A colour hides how sure we are and how much money is at stake. I rank by chance of leaving × contract value and use colours only as cut-offs on that ranking.
2. **"The system should email them."** The wording is ambiguous (customers or CSMs). A "we think you're leaving" email to a customer can cause the loss it is meant to prevent, so the CSM gets an alert and decides. The only automatic customer email is a card-update reminder after a failed payment.
3. **"Nothing slips."** I can promise no renewal is missed because its signals were scattered: every renewal in the next 90 days appears once, as a call, on the watch list, or as not scored with the reason. I cannot promise every at-risk customer is called or saved. Call time is limited, and some customers leave with no warning signs.
4. **Two lost renewals as the proof.** Two cases cannot train or test a model. It needs the full renewal history.

## 4. What I need from the business

| Question | I assume | If wrong |
|---|---|---|
| Renewal dates, value, owner | Present in Salesforce, mostly accurate | Accounts without a renewal date show as not scored |
| Shared customer ID across tools | None: match by email domain, then company name | Unmatched records are counted and reported |
| What "leaving" means | Cancelling, or a renewal bill never paid or attempted. A failed card is a support case | Labels and results change |
| Calls per CSM per week | 15 to 20 | The top-N cut changes |
| Who approves automation and the reminder wording | VP of Customer Success; billing or CS, plus legal if required | Automation stays off |
| Outcomes of past outreach | Not recorded | The model ranks risk but cannot show a call helped |

## 5. How we will know it works

- On a later date than the training data, the model puts more leavers into each CSM's top 15 than a simple usage-drop rule, with ranges shown because few customers leave.
- Every reason on screen links to stored source records, and a test rebuilds each stored score from its reasons.
- Rerunning on the same data gives the same scores.
- One company's users cannot see another company's data (tested).
- The README states that the data is generated, so results show the system works, not how it would do on real customers.
