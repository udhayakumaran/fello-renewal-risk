/**
 * Builds the walkthrough deck: what was built, what was decided, what is still open.
 * Numbers come from the README and the last evaluation run; update both together.
 *
 * Usage: npm run deck   (writes docs/renewal-risk-deck.pptx)
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// pptxgenjs ships CommonJS; load it with require so the class resolves the same way at runtime.
type PptxClass = typeof import("pptxgenjs").default;
const loaded = createRequire(import.meta.url)("pptxgenjs") as PptxClass | { default: PptxClass };
const PptxGenJS: PptxClass = "default" in loaded ? loaded.default : loaded;

const root = fileURLToPath(new URL("../..", import.meta.url)); // compiled to dist/deck/
const shots = join(root, "docs", "screenshots");

const pptx = new PptxGenJS();
pptx.layout = "LAYOUT_WIDE"; // 13.33 x 7.5 in
pptx.title = "Renewal Risk Call List";

const INK = "1C1C1E";
const MUTED = "6B6B70";
const ACCENT = "3B4BD8";

function slide(title: string, bullets: string[], opts: { note?: string } = {}): void {
  const s = pptx.addSlide();
  s.background = { color: "FFFFFF" };
  s.addText(title, { x: 0.6, y: 0.4, w: 12.1, h: 0.9, fontFace: "Calibri", fontSize: 30, bold: true, color: INK });
  s.addText(
    bullets.map((b) => ({ text: b, options: { bullet: { indent: 18 }, paraSpaceAfter: 10 } })),
    { x: 0.6, y: 1.5, w: 12.1, h: 5.2, fontFace: "Calibri", fontSize: 19, color: INK, valign: "top" },
  );
  if (opts.note) {
    s.addText(opts.note, { x: 0.6, y: 6.85, w: 12.1, h: 0.4, fontFace: "Calibri", fontSize: 11, color: MUTED });
  }
}

// 1. Title
{
  const s = pptx.addSlide();
  s.background = { color: INK };
  s.addText("Renewal Risk Call List", { x: 0.8, y: 2.2, w: 11.7, h: 1.2, fontFace: "Calibri", fontSize: 44, bold: true, color: "FFFFFF" });
  s.addText("Who to call this Monday, and why", { x: 0.8, y: 3.4, w: 11.7, h: 0.7, fontFace: "Calibri", fontSize: 24, color: "C9CBD6" });
  s.addText("Synthetic data only. Results describe the pipeline, not real customers.", { x: 0.8, y: 6.4, w: 11.7, h: 0.5, fontFace: "Calibri", fontSize: 14, color: "9A9AA6" });
}

// 2. The real problem
slide("The real problem is limited call time, not a missing dashboard", [
  "Each CSM owns about 120 accounts and can make 15 to 20 calls a week.",
  "Signals live in five systems, so nobody sees a customer's full picture.",
  "Two renewals were lost last quarter, and the signals were already in the data.",
  "Goal: each week, rank the renewals most likely to be lost, weighted by money, with the reasons.",
]);

// 3. Where we disagreed
slide("Where we disagreed with the request, and why", [
  "A red / yellow / green score hides how sure we are and what is at stake. We rank by risk × money instead.",
  "Auto-emailing customers who look at risk can cause the loss it is meant to prevent. Alerts go to the CSM.",
  "The one automatic customer message: a card-update reminder when a payment fails.",
  "\"Nothing slips\" can't be promised with limited capacity. We make the limited time count, and show unknowns as unknown.",
  "Two lost renewals can't train or test a model. We use three years of history.",
]);

// 4. What we built
slide("What we built", [
  "Synthetic data for five sources, about 201,000 event rows, messy on purpose (late, duplicated, unlinked, missing).",
  "Matching to one customer by email domain, then company name. Unmatched records are kept, not dropped.",
  "Features only from what the system had received on the scoring date, so the model can't see the future.",
  "A logistic regression fit on past renewals, written by hand so every reason can be checked.",
  "A nightly job that publishes only when a whole org's run succeeds. A failed run is logged, never shown.",
  "A CSM app with tenant isolation. The app's signed session cookie is the trust boundary; Postgres row-level security filters every query as defense in depth.",
]);

// 5. What a CSM sees
{
  const s = pptx.addSlide();
  s.background = { color: "FFFFFF" };
  s.addText("What a CSM opens on Monday", { x: 0.6, y: 0.4, w: 12.1, h: 0.9, fontFace: "Calibri", fontSize: 30, bold: true, color: INK });
  s.addImage({ path: join(shots, "csm-list-top.png"), x: 0.6, y: 1.4, w: 8.4, h: 5.3 });
  s.addText(
    [
      { text: "Top 15 are this week's calls.", options: { bullet: { indent: 16 }, paraSpaceAfter: 10 } },
      { text: "Each row shows the chance of leaving, money at risk, and the main reasons.", options: { bullet: { indent: 16 }, paraSpaceAfter: 10 } },
      { text: "Accounts we can't score are listed as unknown, never safe.", options: { bullet: { indent: 16 }, paraSpaceAfter: 10 } },
    ],
    { x: 9.2, y: 1.6, w: 3.6, h: 4.8, fontFace: "Calibri", fontSize: 16, color: INK, valign: "top" },
  );
}

// 6. Trace
{
  const s = pptx.addSlide();
  s.background = { color: "FFFFFF" };
  s.addText("Every number traces back to a record", { x: 0.6, y: 0.4, w: 12.1, h: 0.9, fontFace: "Calibri", fontSize: 30, bold: true, color: INK });
  s.addImage({ path: join(shots, "csm-trace-top.png"), x: 0.6, y: 1.4, w: 7.4, h: 5.25 });
  s.addText(
    [
      { text: "Each reason: the model's weight × how far this account is from the average.", options: { bullet: { indent: 16 }, paraSpaceAfter: 10 } },
      { text: "The record IDs behind each reason are listed.", options: { bullet: { indent: 16 }, paraSpaceAfter: 10 } },
      { text: "A check recomputes every published score from its stored reasons.", options: { bullet: { indent: 16 }, paraSpaceAfter: 10 } },
      { text: "The run, model version, and data date are shown.", options: { bullet: { indent: 16 }, paraSpaceAfter: 10 } },
    ],
    { x: 8.3, y: 1.6, w: 4.6, h: 4.8, fontFace: "Calibri", fontSize: 16, color: INK, valign: "top" },
  );
}

// 7. Model results
{
  const s = pptx.addSlide();
  s.background = { color: "FFFFFF" };
  s.addText("The model beats the simple rule, with wide ranges", { x: 0.6, y: 0.4, w: 12.1, h: 0.9, fontFace: "Calibri", fontSize: 30, bold: true, color: INK });
  const header = [
    { text: "Measure", options: { bold: true, color: MUTED } },
    { text: "Model", options: { bold: true, color: MUTED } },
    { text: "Simple rule (usage drop)", options: { bold: true, color: MUTED } },
  ];
  const rows = [
    ["AUC: 1.0 perfect, 0.5 coin flip (95% range)", "0.71 (0.65 to 0.85)", "0.60 (0.51 to 0.69)"],
    ["Leavers in each CSM's top 15 (of 29)", "18", "12"],
  ];
  s.addTable([header, ...rows.map((r) => r.map((c) => ({ text: c })))], {
    x: 0.6, y: 1.6, w: 12.1, colW: [6.1, 3, 3], fontFace: "Calibri", fontSize: 18, color: INK, border: { type: "solid", color: "E4E4E7", pt: 1 },
  });
  s.addText(
    [
      { text: "Only 29 leavers in the test window, so ranges are wide.", options: { bullet: { indent: 16 }, paraSpaceAfter: 8 } },
      { text: "Earlier 0.83 was before we stopped counting failed cards as departures and removed days-to-renewal as an input.", options: { bullet: { indent: 16 }, paraSpaceAfter: 8 } },
      { text: "Data is generated, so this shows the pipeline works, not performance on real customers.", options: { bullet: { indent: 16 }, paraSpaceAfter: 8 } },
    ],
    { x: 0.6, y: 4.2, w: 12.1, h: 2.5, fontFace: "Calibri", fontSize: 17, color: INK, valign: "top" },
  );
}

// 8. Safety
slide("What the system does on its own, and what it never does", [
  "Runs nightly on a Vercel Cron schedule (02:00 IST), without anyone starting it.",
  "Publishes an org only when all its steps succeed. A forced failure left the last good run in place.",
  "Customer email: only the card-update reminder. Never a churn or check-in email.",
  "Opted-out customers get no reminder. Accounts a CSM contacted in the last 14 days get their alert marked suppressed.",
  "Tenant isolation: a session for one org can't read another org's rows. Tested through the API and the database.",
]);

// 9. Open items
slide("What the business still has to confirm", [
  "Legal basis to read Gmail metadata (we store no message content; Gmail is not used in scoring).",
  "Who approves turning on automatic messages, and who approves the reminder wording.",
  "What counts as leaving. We count cancellations and never-attempted renewal invoices; failed cards are support cases.",
  "Where opt-outs are recorded, and whether Salesforce owners are current.",
  "Whether a call actually saves a customer. We log calls, but we have no experiment yet.",
]);

// 10. 10x and next
slide("What breaks first at 10x, and the next steps", [
  "1. The nightly job rescans everything in memory. Needs incremental features and a queue per org.",
  "2. The nightly run has no lock. Overlapping runs can send duplicate card reminders. Needs an advisory lock per org.",
  "3. Row-level checks on a large event table need partitioning by org and month.",
  "4. Alerts from old runs pile up. Close them when a newer run publishes.",
  "Live demo: https://fello-renewal-risk.vercel.app/",
  "Loom walkthrough: LINK_TBD",
]);

const out = join(root, "docs");
mkdirSync(out, { recursive: true });
const file = join(out, "renewal-risk-deck.pptx");
await pptx.writeFile({ fileName: file });
console.log(`wrote ${file}`);
