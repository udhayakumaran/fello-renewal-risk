/**
 * Builds the walkthrough deck: the problem, the result, how it works, how it behaves over time,
 * the proof, and the limits. Speaker notes hold the plain-language narration for the Loom.
 * Numbers come from the README, `npm run evaluate`, `npm run replay` and the account page's
 * "In past data" column; update them together.
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
const shots = join(root, "docs", "screenshots", "e2e");

const pptx = new PptxGenJS();
pptx.layout = "LAYOUT_WIDE"; // 13.33 x 7.5 in
pptx.title = "Renewal Risk Call List";

const FONT = "Calibri";
const C = {
  ink: "111827",
  muted: "6B7280",
  line: "E5E7EB",
  soft: "F4F5FB",
  accent: "3B4BD8",
  accentSoft: "E8EAFD",
  green: "15803D",
  white: "FFFFFF",
};
const X = 0.7; // left margin
const W = 11.93; // content width

type Slide = ReturnType<typeof pptx.addSlide>;

/** A content slide: section label, a one-line takeaway title, footer, slide number, speaker notes. */
function base(section: string, title: string, notes: string, demo = false): Slide {
  const s = pptx.addSlide();
  s.background = { color: C.white };
  s.addText(section.toUpperCase(), { x: X, y: 0.4, w: 8, h: 0.3, fontFace: FONT, fontSize: 12, bold: true, color: C.accent, charSpacing: 3 });
  s.addText(title, { x: X, y: 0.72, w: demo ? 9.6 : W, h: 0.95, fontFace: FONT, fontSize: 28, bold: true, color: C.ink, valign: "top" });
  if (demo) {
    s.addText("LIVE DEMO", { x: 10.83, y: 0.45, w: 1.8, h: 0.38, fontFace: FONT, fontSize: 12, bold: true, color: C.white, fill: { color: C.accent }, align: "center", valign: "middle" });
  }
  s.addText("Renewal Risk Call List · Fello take-home", { x: X, y: 7.02, w: 6, h: 0.3, fontFace: FONT, fontSize: 10, color: C.muted });
  s.slideNumber = { x: 11.9, y: 7.02, w: 0.73, h: 0.3, fontFace: FONT, fontSize: 10, color: C.muted, align: "right" };
  s.addNotes(notes);
  return s;
}

function card(s: Slide, x: number, y: number, w: number, h: number, fill: string = C.soft): void {
  s.addShape(pptx.ShapeType.roundRect, { x, y, w, h, fill: { color: fill }, line: { color: fill }, rectRadius: 0.12 });
}

/** A heading plus short lines inside a card. */
function cardText(s: Slide, x: number, y: number, w: number, h: number, heading: string, lines: string[], opts: { fill?: string; head?: string; size?: number } = {}): void {
  card(s, x, y, w, h, opts.fill ?? C.soft);
  s.addText(heading, { x: x + 0.25, y: y + 0.18, w: w - 0.5, h: 0.45, fontFace: FONT, fontSize: 17, bold: true, color: opts.head ?? C.ink, valign: "top" });
  s.addText(
    lines.map((t) => ({ text: t, options: { bullet: { indent: 14 }, breakLine: true, paraSpaceAfter: 7 } })),
    { x: x + 0.25, y: y + 0.7, w: w - 0.5, h: h - 0.85, fontFace: FONT, fontSize: opts.size ?? 14, color: C.ink, valign: "top" },
  );
}

/** A large number with a caption beneath it. */
function stat(s: Slide, x: number, y: number, w: number, big: string, caption: string, color: string = C.accent): void {
  s.addText(big, { x, y, w, h: 0.8, fontFace: FONT, fontSize: 38, bold: true, color, valign: "bottom" });
  s.addText(caption, { x, y: y + 0.82, w, h: 0.75, fontFace: FONT, fontSize: 13, color: C.muted, valign: "top" });
}

function strip(s: Slide, y: number, text: string, h = 0.7): void {
  card(s, X, y, W, h, C.accentSoft);
  s.addText(text, { x: X + 0.25, y, w: W - 0.5, h, fontFace: FONT, fontSize: 15, bold: true, color: C.ink, valign: "middle" });
}

const hd = (t: string) => ({ text: t, options: { bold: true, color: C.muted, fill: { color: C.soft } } });
const bold = (t: string) => ({ text: t, options: { bold: true } });
const tableOpts = { fontFace: FONT, color: C.ink, border: { type: "solid" as const, color: C.line, pt: 1 }, valign: "middle" as const };

/** Table cells may be plain strings or { text, options }. */
function addTbl(s: Slide, rows: (string | { text: string; options?: object })[][], opts: object): void {
  s.addTable(rows.map((r) => r.map((c) => (typeof c === "string" ? { text: c } : c))) as never, opts as never);
}

// 1. Title
{
  const s = pptx.addSlide();
  s.background = { color: C.ink };
  s.addText("RENEWAL RISK CALL LIST", { x: 0.9, y: 1.7, w: 11, h: 0.4, fontFace: FONT, fontSize: 14, bold: true, color: "9AA3F5", charSpacing: 4 });
  s.addText("Who should we call this Monday, and why?", { x: 0.9, y: 2.2, w: 11.5, h: 1.6, fontFace: FONT, fontSize: 46, bold: true, color: C.white, valign: "top" });
  s.addText("Finding customers who may stop paying, before they do", { x: 0.9, y: 3.95, w: 11.5, h: 0.6, fontFace: FONT, fontSize: 22, color: "C9CBD6" });
  s.addText("Udhayakumar · Staff Engineer take-home · Fello GTM AI", { x: 0.9, y: 4.75, w: 11.5, h: 0.4, fontFace: FONT, fontSize: 15, color: "9AA3B8" });
  s.addText("All data here is generated. Results show the system works, not how it would do on real customers.", { x: 0.9, y: 6.6, w: 11.5, h: 0.4, fontFace: FONT, fontSize: 12, color: "9AA3B8" });
  s.addNotes(
    "Hi, I'm Udhaya. This is my take on the renewal risk exercise. In about nine minutes I'll show the problem, what I built, a live demo, how the score works, and how I know it works. All the data is generated, so the results show the system works, not how it would do on real customers.",
  );
}

// 2. The problem
{
  const s = base(
    "The problem",
    "The request was a dashboard. The real need is a call list.",
    "The VP asked for a dashboard with a red, yellow or green score, and automatic emails to accounts that turn red. I read the real problem differently. A customer success manager looks after about 120 accounts and cannot call them all. The warning signs sit in five separate tools, so nobody sees the whole picture. Two renewals were lost last quarter with the signs already in the data. So the goal is simple: every Monday, give each manager a short ranked list, who to call first and why. A renewal is the moment a customer decides whether to keep paying.",
  );
  cardText(s, X, 1.95, 4.6, 3.3, "What was asked", ["A red, yellow or green score for every account", "An automatic email to accounts that turn red"], { head: C.muted, size: 16 });
  cardText(
    s,
    5.55,
    1.95,
    7.08,
    3.3,
    "What is actually needed",
    [
      "Each manager (CSM) looks after about 120 accounts and cannot call them all. I assume 15 to 20 calls a week: a working assumption, not a given.",
      "Warning signs sit in five separate tools, so nobody sees the whole picture.",
      "Two renewals were lost last quarter, and the signs were already in the data.",
    ],
    { fill: C.accentSoft, head: C.accent, size: 15 },
  );
  strip(s, 5.55, "Goal: every Monday, each manager gets a short ranked list. Who to call first, and why.");
  s.addText("Renewal = the moment a customer decides whether to keep paying. CSM = customer success manager.", { x: X, y: 6.4, w: W, h: 0.3, fontFace: FONT, fontSize: 11, color: C.muted });
}

// 3. Disagreements
{
  const s = base(
    "The problem",
    "Three places I disagreed with the request",
    "I disagreed in three places. One: a colour hides how sure we are and how much money is at stake, so I rank by chance of leaving times contract value, and keep colours only as cut-offs. Two: emailing a customer that we think they are leaving can cause the loss we want to prevent, so the manager gets an alert and decides. The only automatic customer email is a reminder to update a card after a failed payment. Three: nothing should slip. I can promise no renewal is missed just because its clues were scattered, because every renewal in the next 90 days appears once, as a call, on the watch list, or as not scored with the reason. I cannot promise every risky customer is called or saved, because call time is limited.",
  );
  addTbl(s, 
    [
      [hd("Asked for"), hd("The problem"), hd("What I did instead")],
      [
        bold("Red / yellow / green score"),
        "A colour does not say how sure we are, or how much money is at stake",
        "Rank by chance of leaving × contract value. Colours are only cut-offs on that ranking",
      ],
      [
        bold("Email customers who turn red"),
        "\"We think you are leaving\" can cause the loss it is meant to prevent",
        "The manager gets an alert and decides. The only automatic email is a card-update reminder after a failed payment",
      ],
      [
        bold("\"Nothing should slip\""),
        "No system can guarantee every risky customer is called or saved",
        "No renewal is missed because clues were scattered: each one shows as a call, on the watch list, or \"not scored\" with the reason",
      ],
    ],
    { x: X, y: 2.0, w: W, colW: [2.9, 4.1, 4.93], fontSize: 16, margin: [0.14, 0.16, 0.14, 0.16], ...tableOpts },
  );
}

// 4. The result
{
  const s = base(
    "The result",
    "Every Monday: a short call list, with reasons",
    "This is what a manager opens on Monday. The top fifteen are this week's calls, sorted by money at risk, which is the chance of leaving times what the customer pays. Each row shows the chance and the reasons in plain words. A big customer with a small chance can sit above a small customer with a bigger chance, because losing them costs more. Customers we cannot score are shown as not scored, never as safe. After a call, one button removes the customer and the next one moves up. Switch to the live app here and open the top account.",
    true,
  );
  s.addImage({ path: join(shots, "06-desktop-list-final.png"), x: X, y: 1.9, w: 7.4, h: 4.39 });
  const items: [string, string][] = [
    ["Top 15 = this week's calls", "Sorted by money at risk: chance of leaving × what the customer pays."],
    ["Reasons in plain words", "Each row says why, so the call has a talking point."],
    ["Not scored is not safe", "Customers we cannot score are listed with the reason."],
    ["One button after a call", "The customer drops off and the next one moves up."],
  ];
  items.forEach(([h, d], i) => {
    const y = 1.95 + i * 1.1;
    s.addText(h, { x: 8.4, y, w: 4.2, h: 0.35, fontFace: FONT, fontSize: 15, bold: true, color: C.accent });
    s.addText(d, { x: 8.4, y: y + 0.36, w: 4.2, h: 0.65, fontFace: FONT, fontSize: 13, color: C.ink, valign: "top" });
  });
}

// 5. How it is built
{
  const s = base(
    "How it works",
    "Six steps turn scattered data into that list",
    "Here is the build in six steps. One: collect data from five places, about two hundred thousand records, made messy on purpose, with late, repeated and missing records. Two: match each record to one customer by email domain, then company name. Records we cannot match are kept aside for review, not thrown away. Three: summarise into eleven simple facts per customer, using only what was known on that date. Four: score, a chance of leaving learned from past renewals. Five: run every night by itself, and publish only if the whole run worked. Six: the manager's screen. Underneath, each company's data is kept separate in the database itself.",
  );
  const steps: [string, string][] = [
    ["Collect", "Five tools: sales, support, product use, payments, email. About 201,000 records, messy on purpose"],
    ["Match", "Link each record to one customer by email domain, then company name. Unmatched records are kept for review"],
    ["Summarise", "11 simple facts per customer, using only what was known on that date"],
    ["Score", "A chance of leaving, learned from past renewals"],
    ["Run nightly", "Runs by itself at 2am. Results go live only if the whole run worked"],
    ["Show", "Ranked list, reasons, and the records behind each reason"],
  ];
  const w = 1.83;
  const gap = (W - 6 * w) / 5;
  steps.forEach(([h, d], i) => {
    const x = X + i * (w + gap);
    const fill = i === 5 ? C.accent : C.ink;
    s.addShape(pptx.ShapeType.ellipse, { x: x + 0.05, y: 2.0, w: 0.55, h: 0.55, fill: { color: fill }, line: { color: fill } });
    s.addText(String(i + 1), { x: x + 0.05, y: 2.0, w: 0.55, h: 0.55, fontFace: FONT, fontSize: 16, bold: true, color: C.white, align: "center", valign: "middle" });
    s.addText(h, { x, y: 2.7, w, h: 0.4, fontFace: FONT, fontSize: 18, bold: true, color: C.ink });
    s.addText(d, { x, y: 3.15, w, h: 1.9, fontFace: FONT, fontSize: 13, color: C.ink, valign: "top" });
  });
  strip(s, 5.45, "Underneath: each company's data is kept separate in the database, so one company can never see another's.");
}

// 6. One score worked out
{
  const s = base(
    "How it works",
    "One customer's score, worked out",
    "This is one real account from the demo. A typical customer starts at zero points, which is a 1.8 percent chance of leaving. Each clue then adds or removes points, depending on how this customer compares with a typical one. Here almost everything points to staying: no complaints in the last 90 days, a large contract, a long relationship. The points add up to minus 0.49, which moves the chance from 1.8 percent down to 1.1 percent. The same steps are used for every customer, and the account page shows every clue, its points, and the records behind it. Switch to the live app and open this account.",
    true,
  );
  const steps: [string, string][] = [
    ["1. Start at 0", "A typical customer has a 1.8% chance of leaving."],
    ["2. Add or remove points", "Each clue pushes the risk up or down, depending on how this customer compares with a typical one."],
    ["3. Turn the total into a chance", "−0.49 points moves 1.8% down to 1.1%."],
  ];
  steps.forEach(([h, d], i) => {
    const y = 1.95 + i * 1.45;
    s.addText(h, { x: X, y, w: 4.3, h: 0.4, fontFace: FONT, fontSize: 17, bold: true, color: C.accent });
    s.addText(d, { x: X, y: y + 0.42, w: 4.3, h: 0.9, fontFace: FONT, fontSize: 14, color: C.ink, valign: "top" });
  });
  s.addText("Points added or removed for Copperline Learning (negative = safer)", { x: 5.3, y: 1.9, w: 7.3, h: 0.35, fontFace: FONT, fontSize: 14, bold: true, color: C.ink });
  s.addChart(
    pptx.ChartType.bar,
    [
      {
        name: "Points",
        labels: ["No complaints in last 90 days", "Large contract", "Long-standing customer (6+ years)", "No contacts marked inactive", "No cancel request", "All other clues"],
        values: [-0.22, -0.14, -0.07, -0.03, -0.02, -0.01],
      },
    ],
    {
      x: 5.2, y: 2.25, w: 7.4, h: 3.2, barDir: "bar", chartColors: [C.green], catAxisOrientation: "maxMin" as "minMax",
      catAxisLabelFontFace: FONT, catAxisLabelFontSize: 12, catAxisLabelColor: C.ink, catAxisLabelPos: "high",
      valAxisHidden: true, valGridLine: { style: "none" }, showValue: true, dataLabelFormatCode: "0.00", dataLabelFontSize: 12, dataLabelFontFace: FONT, dataLabelColor: C.ink,
      valAxisMinVal: -0.3, valAxisMaxVal: 0, showLegend: false,
    },
  );
  strip(s, 5.75, "Total −0.49 points: 1.8% (typical) becomes 1.1% for this customer");
}

// 7. Evidence
{
  const s = base(
    "How it works",
    "Each clue earns points from what past customers did",
    "Why does a clue add points? Because of what past customers did. Of about sixteen thousand past cases, 2.3 percent left overall. Where a customer had asked to cancel, 50 in 100 left, against 2 in 100 without. With three or more complaints in 90 days, 13 in 100 left. With a plan cut, 17 in 100. A complaint still open and inactive contacts matter a little. A fall in product usage on its own did not separate leavers from stayers. The points are fitted with all the clues together, so they are not exactly these percentages, but the bigger the gap, the more points a clue gets. The account page shows these numbers for every clue.",
  );
  const labels = ["Asked to cancel at renewal", "Reduced their plan recently", "3+ complaints in 90 days", "Complaint still open", "Some contacts marked inactive", "Product usage fell"];
  s.addChart(
    pptx.ChartType.bar,
    [
      { name: "Customers with the clue", labels, values: [50.0, 17.1, 13.2, 4.6, 3.8, 2.4] },
      { name: "Customers without it", labels, values: [2.1, 2.2, 2.0, 2.3, 2.2, 2.3] },
    ],
    {
      x: X - 0.1, y: 1.8, w: 8.2, h: 4.6, barDir: "bar", chartColors: [C.accent, "C7CBD6"], catAxisOrientation: "maxMin" as "minMax", barGapWidthPct: 45,
      catAxisLabelFontFace: FONT, catAxisLabelFontSize: 12, catAxisLabelColor: C.ink, valAxisHidden: true, valGridLine: { style: "none" },
      showValue: true, dataLabelFormatCode: "0.0", dataLabelFontSize: 11, dataLabelFontFace: FONT, dataLabelColor: C.ink, showLegend: true, legendPos: "b", legendFontFace: FONT, legendFontSize: 12,
    },
  );
  s.addText("Out of every 100 past customers, how many left", { x: X, y: 6.5, w: 8, h: 0.3, fontFace: FONT, fontSize: 11, color: C.muted });
  stat(s, 9.2, 1.95, 3.4, "50 vs 2", "in 100 left: customers who asked to cancel, against those who did not");
  stat(s, 9.2, 3.65, 3.4, "2.4 vs 2.3", "in 100 left: a fall in usage on its own did not separate leavers from stayers", C.muted);
  s.addText("16,415 past cases (a customer can appear on more than one date); 2.3% left overall. Points are fitted with all clues together, so they are not exactly these percentages.", { x: 9.2, y: 5.4, w: 3.4, h: 1.2, fontFace: FONT, fontSize: 11, color: C.muted, valign: "top" });
}

// 8. Over time: monthly and nightly
{
  const s = base(
    "Over time",
    "Scored every night, re-learned every month",
    "Here is how it behaves over time. On day one there is no waiting: the system learns straight away from all the history that is loaded, then scores every customer. Every night it scores again using the saved points, so a score changes because the customer changed, not because the formula did. Every 30 days it re-learns the points from the outcomes seen since. I chose monthly because a month adds too few new outcomes to change the points meaningfully, and re-learning every night would mostly add noise.",
  );
  const cols: [string, string, string][] = [
    ["Day one", "Learn once, from all history", "The system learns straight away from every past renewal that is loaded. There is no waiting period."],
    ["Every night", "Score every customer", "Same saved points for everyone. A score moves because the customer changed, not because the formula did."],
    ["Every 30 days", "Re-learn the points", "Learn again from outcomes seen since. A month adds few new cases, so doing it nightly would mostly add noise."],
  ];
  cols.forEach(([tag, h, d], i) => {
    const x = X + i * 4.05;
    card(s, x, 1.95, 3.83, 3.3, i === 2 ? C.accentSoft : C.soft);
    s.addText(tag.toUpperCase(), { x: x + 0.25, y: 2.15, w: 3.3, h: 0.3, fontFace: FONT, fontSize: 12, bold: true, color: C.accent, charSpacing: 2 });
    s.addText(h, { x: x + 0.25, y: 2.5, w: 3.3, h: 0.9, fontFace: FONT, fontSize: 19, bold: true, color: C.ink, valign: "top" });
    s.addText(d, { x: x + 0.25, y: 3.45, w: 3.3, h: 1.7, fontFace: FONT, fontSize: 14, color: C.ink, valign: "top" });
  });
  strip(s, 5.6, "The steps never change. Only the points per clue are re-learned, and each score records which version produced it.");
}

// 9. Over time: a year later
{
  const s = base(
    "Over time",
    "A year later: the points move, the ranking holds",
    "I cannot observe a real future year, so I replayed the sample data. One copy of the system learns only from what was known on 15 June 2025, the other from what was known on 15 June 2026, and both are tested on the same later date. Take one factor: asked to cancel at renewal. On day one, 44 in 100 past customers with that factor left, and it added 2.49 points. A year later, 51 in 100 left, and it adds 3.02 points. Where the share barely moved, such as plan cuts, the points barely moved. Overall, the top fifteen lists share 85 percent of their names, and ranking quality is 0.75 against 0.73, which is not a real difference with only 29 leavers. More history did not improve ranking here. This generated data has no change over time built in, while real customers do change, which is why the points are re-learned monthly.",
  );
  addTbl(s, 
    [
      [hd("Factor, past customers who had it"), hd("Day one"), hd("A year later")],
      [bold("Asked to cancel at renewal"), "44 in 100 left (16 of 36)\nAdds +2.49 points", "51 in 100 left (38 of 75)\nAdds +3.02 points"],
      [bold("3 or more complaints in 90 days"), "13 in 100 left (22 of 169)\nAdds +1.09 points", "14 in 100 left (46 of 331)\nAdds +1.14 points"],
      [bold("Reduced their plan recently"), "16 in 100 left (9 of 56)\nAdds +0.97 points", "16 in 100 left (18 of 111)\nAdds +0.95 points"],
      [bold("Complaint still open"), "4.1 in 100 left (5 of 123)\nAdds −0.26 points", "4.8 in 100 left (11 of 229)\nAdds +0.04 points"],
    ],
    { x: X, y: 1.95, w: 7.7, colW: [2.9, 2.4, 2.4], fontSize: 12, margin: [0.07, 0.1, 0.07, 0.1], ...tableOpts },
  );
  stat(s, 8.9, 1.9, 3.7, "85%", "of top-15 names stay the same (522 of 615)");
  stat(s, 8.9, 3.5, 3.7, "0.75 → 0.73", "ranking quality: not a real difference with only 29 leavers", C.muted);
  s.addText("More history did not improve ranking here. This generated data has no change over time built in; real customers do change, which is why the points are re-learned monthly. Replayed, not observed: each version learned only from what was known on 15 June 2025 or 2026, then both were tested on 15 June 2026 (npm run replay).", {
    x: X, y: 5.55, w: W, h: 1.2, fontFace: FONT, fontSize: 12, color: C.muted, valign: "top",
  });
}

// 10. Does it work
{
  const s = base(
    "The proof",
    "It beats a simple rule, but the evidence is small",
    "How do I know it works? I trained on earlier renewals and tested on a later date the system had never seen, against a simple rule: pick the customers whose usage dropped. In each manager's top fifteen, the score catches 18 of the 29 leavers, against 12 for the rule. Ranking quality is 0.71 against 0.60, where 0.5 is a coin toss. The honest caveats: only 29 customers left in the test, so the ranges are wide. The data is generated, so this shows the system works, not how it would do on real customers. Earlier versions scored higher, 0.83, before I fixed how leaving is defined, and I reported the more defensible number.",
  );
  s.addText("Leavers caught in each manager's top 15 (out of 29)", { x: X, y: 1.9, w: 6, h: 0.35, fontFace: FONT, fontSize: 14, bold: true, color: C.ink });
  s.addChart(
    pptx.ChartType.bar,
    [{ name: "Leavers caught", labels: ["Our score", "Simple rule (usage dropped)"], values: [18, 12] }],
    {
      x: X - 0.1, y: 2.3, w: 6.2, h: 3.4, barDir: "col", chartColors: [C.accent, "C7CBD6"], barGapWidthPct: 60,
      catAxisLabelFontFace: FONT, catAxisLabelFontSize: 13, catAxisLabelColor: C.ink, valAxisHidden: true, valGridLine: { style: "none" }, valAxisMinVal: 0, valAxisMaxVal: 29,
      showValue: true, dataLabelFontSize: 18, dataLabelFontFace: FONT, dataLabelColor: C.ink, showLegend: false,
    },
  );
  stat(s, 7.4, 1.95, 2.6, "0.71", "our score's ranking quality (likely range 0.65 to 0.85)");
  stat(s, 10.1, 1.95, 2.5, "0.60", "simple rule (likely range 0.51 to 0.69)", C.muted);
  s.addText(
    [
      { text: "0.5 is a coin toss, 1.0 is perfect.", options: { bullet: { indent: 14 }, breakLine: true, paraSpaceAfter: 6 } },
      { text: "Only 29 customers left in the test, so the ranges are wide.", options: { bullet: { indent: 14 }, breakLine: true, paraSpaceAfter: 6 } },
      { text: "Tested on a date the system never saw (15 June 2026).", options: { bullet: { indent: 14 }, breakLine: true, paraSpaceAfter: 6 } },
      { text: "Earlier 0.83 was before I fixed what \"leaving\" means. I report 0.71.", options: { bullet: { indent: 14 }, breakLine: true, paraSpaceAfter: 6 } },
    ],
    { x: 7.4, y: 3.7, w: 5.2, h: 2.4, fontFace: FONT, fontSize: 14, color: C.ink, valign: "top" },
  );
  strip(s, 6.15, "The data is generated: this shows the system works, not how it would do on real customers.", 0.6);
}

// 11. Requirements
{
  const s = base(
    "The proof",
    "The five requirements, and how each is met",
    "The assignment set five non-negotiables. One, generate the data: five thousand customers across four companies, about two hundred thousand records from five places, messy on purpose. Two, a score fitted on the data: learned from past renewals and tested on later ones against a simple rule. Three, something that runs by itself: a nightly job, with a run log, and a run I broke on purpose was recorded and never shown to managers. Four, multiple companies: the database itself keeps each company's data separate, and tests with the wrong company, a forged, expired and edited login all fail. Five, everything traceable: every reason shows its points and the records behind it, and a test rebuilds every stored score from its stored reasons.",
  );
  addTbl(s, 
    [
      [hd("Requirement"), hd("What I did"), hd("How you can check")],
      [bold("Generate the data"), "5,000 customers, 4 companies, ~201,000 records from 5 tools. Late, repeated, duplicated and missing records on purpose", "The generator checks itself. The true answers are kept apart and never used by the score"],
      [bold("A score fitted on the data"), "Learned from past renewals, tested on later ones, compared with a simple rule", "Top 15 catches 18 of 29 leavers vs 12 for the rule"],
      [bold("Runs by itself"), "A nightly job: score, raise alerts, publish. Points re-learned monthly", "Run log shows every attempt. A run I broke on purpose was recorded and never shown"],
      [bold("Multiple companies"), "The database itself keeps each company's data apart, using a signed login that expires", "Tests: wrong company, forged, expired and edited logins all fail"],
      [bold("Everything traceable"), "Every reason shows its points and the records behind it", "A test rebuilds every stored score from its stored reasons"],
    ],
    { x: X, y: 1.9, w: W, colW: [2.5, 5.2, 4.23], fontSize: 13, margin: [0.09, 0.12, 0.09, 0.12], ...tableOpts },
  );
}

// 12. Judgement calls
{
  const s = base(
    "The proof",
    "Judgement calls and edge cases I handled",
    "A few calls I made on purpose. Only use what was known at the time: a record that arrived after the scoring date is ignored, so the score never uses information from the future, and a test proves it. A failed card is not leaving: cards fail for many reasons, so only a renewal bill never paid or attempted counts. That costs 21 of 1,640 test customers being labelled differently from the true answer, and I say so. I kept customers who leave without warning: half the generated leavers gave no sign, removing them would have given 0.95, which looks great and is fake. I dropped days until renewal as a clue because it already decides who is on the list and a manager cannot act on it. And there is no chatbot-style AI in the score, because a chatbot can give a different answer each time and cannot show its working.",
  );
  addTbl(s, 
    [
      [hd("Judgement call"), hd("Why")],
      [bold("Use only what was known at the time"), "A record that arrived after the scoring date is ignored, so the score never uses information from the future. Tested."],
      [bold("A failed card is not \"leaving\""), "Cards fail for many reasons. Only a renewal bill never paid or attempted counts. Cost: 21 of 1,640 test customers are labelled differently from the true answer."],
      [bold("Keep customers who leave without warning"), "Half the generated leavers gave no sign. Removing them gave a flattering 0.95 that is not real. The score cannot catch them, and the README says so."],
      [bold("Drop \"days until renewal\""), "It already decides who is on the list, behaved oddly as a clue, and a manager cannot act on it."],
      [bold("No chatbot-style AI in the score"), "It can give a different answer each time and cannot show its working. The task asked for a score fitted on the data."],
    ],
    { x: X, y: 1.9, w: W, colW: [3.9, 8.03], fontSize: 13, margin: [0.1, 0.14, 0.1, 0.14], ...tableOpts },
  );
}

// 13. Limits and next steps
{
  const s = base(
    "Limits",
    "Limits, approvals, and what breaks at 10×",
    "To close, the limits. Left out on purpose: real company login, real email sending, live connections to the real tools, and measuring whether a call actually saves a customer. Needs approval from the business: legal permission to read email details, who switches on automatic messages, the reminder wording, what counts as leaving, and where do-not-email choices are stored. What breaks first at ten times the size: the nightly job re-reads everything, two runs could overlap and send the same card reminder twice, large event tables slow the checks that keep companies separate, and old alerts pile up. The fixes are in the README. The live demo is linked here, and the Loom link goes with my submission. Thanks for watching.",
  );
  cardText(s, X, 1.9, 3.83, 4.15, "Left out on purpose", ["Real company sign-in", "Real email sending", "Live connections to the real tools", "Measuring whether a call saves a customer"], { size: 14 });
  cardText(s, X + 4.05, 1.9, 3.83, 4.15, "Needs approval", ["Legal OK to read email details (never message text)", "Who switches on automatic messages, and the reminder wording", "What counts as leaving", "Where \"do not email\" choices are stored"], { size: 14 });
  cardText(s, X + 8.1, 1.9, 3.83, 4.15, "Breaks first at 10×", ["The nightly job re-reads all data. Fix: process only what changed", "Two runs could overlap and double-send a reminder. Fix: one run at a time", "Big tables slow the company-separation checks. Fix: split by company and month", "Old alerts pile up. Fix: close them when new results go live"], { fill: C.accentSoft, head: C.accent, size: 13 });
  s.addText("Live demo: https://fello-renewal-risk.vercel.app/     Loom walkthrough: LINK_TBD", { x: X, y: 6.3, w: W, h: 0.4, fontFace: FONT, fontSize: 14, bold: true, color: C.ink });
}

const out = join(root, "docs");
mkdirSync(out, { recursive: true });
const file = join(out, "renewal-risk-deck.pptx");
await pptx.writeFile({ fileName: file });
console.log(`wrote ${file}`);
