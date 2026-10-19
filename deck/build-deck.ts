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
// Demo sign-in shown on the live-demo slides. The access code is only printed when DEMO_ACCESS_CODE is set,
// and that build goes to docs/private/ (git-ignored), so the committed deck never holds the code.
const APP_URL = "https://fello-renewal-risk.vercel.app";
const DEMO_CODE = process.env["DEMO_ACCESS_CODE"];
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
    s.addText(
      [
        { text: "fello-renewal-risk.vercel.app", options: { bold: true, breakLine: true } },
        { text: "Sign in as: org_a · org_a-CSM3", options: { breakLine: true } },
        { text: DEMO_CODE ? `Access code: ${DEMO_CODE}` : "Access code: shared separately", options: {} },
      ],
      { x: 10.2, y: 0.9, w: 2.43, h: 0.75, fontFace: FONT, fontSize: 10, color: C.muted, align: "right", valign: "top" },
    );
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
    "Hi, I'm Udhaya. This is my take on the renewal risk exercise. In about nine minutes I'll show the problem, the product, one account from warning signs to a call, how the score works, and how I know it works. All the data is generated, so the results show the system works, not how it would do on real customers.",
  );
}

// 2. The problem as given
{
  const s = base(
    "1 · The problem given",
    "The problem as it was given to me",
    "Here is the problem as given. The VP of Customer Success asked for a dashboard that gives every account a red, yellow or green score, and sends automatic emails to accounts that turn red. The business facts we were told: each customer success manager, a CSM, looks after about 120 accounts, the warning signs sit in five separate tools, and two renewals were lost last quarter with the signs already in the data. The assignment itself adds five must-haves: generated data, around five thousand accounts and two hundred thousand events across the five tools; a model learned from that data; something that runs without a person; several customer companies kept apart; and everything traceable. A renewal is the moment a customer decides whether to keep paying.",
  );
  cardText(s, X, 1.95, 5.6, 3.5, "The request", ["A dashboard", "A red, yellow or green score for every account", "Automatic emails to accounts that turn red"], { head: C.muted, size: 17 });
  cardText(
    s,
    6.55,
    1.95,
    6.08,
    3.5,
    "What we were told",
    [
      "Each manager (CSM) looks after about 120 accounts",
      "Warning signs sit in five tools: Salesforce, Gmail, Zendesk, product events, Stripe",
      "Two renewals were lost last quarter, with the signs already in the data",
    ],
    { fill: C.accentSoft, head: C.accent, size: 16 },
  );
  strip(s, 5.75, "The assignment: generated data, a model learned from it, a nightly run, several companies kept apart, everything traceable.");
  s.addText("Renewal = the moment a customer decides whether to keep paying. CSM = customer success manager.", { x: X, y: 6.6, w: W, h: 0.3, fontFace: FONT, fontSize: 11, color: C.muted });
}

// 3. How I perceive it
{
  const s = base(
    "2 · How I perceive it",
    "The real need is a call list, not a dashboard",
    "This is how I read it. A manager cannot call 120 accounts, so today they guess who to call each Monday. A dashboard with colours does not fix that, because it still leaves the choice to them and hides how sure we are and how much money is at stake. What is needed is a short ranked list every Monday: who to call first, and why. I assume a manager can make about 15 calls a week, which is a number to confirm with the business. Success means three things: the right accounts are near the top, each reason can be checked against the real records, and the system runs without a person and says plainly what it does not know. One more point: two lost renewals cannot train or test a model. It needs the full renewal history, so the plan is to generate it.",
  );
  const cols: [string, string, string[], string][] = [
    ["TODAY", "A manager guesses", ["120 accounts, limited time", "Signals in five tools", "Nobody sees the whole picture"], C.soft],
    ["WHAT IS NEEDED", "A short ranked list, every Monday", ["Who to call first, and why", "I assume 15 calls a week: to confirm"], C.accentSoft],
    ["WHAT SUCCESS LOOKS LIKE", "Three things", ["The right accounts near the top", "Every reason checkable against real records", "Runs by itself, and says what it does not know"], C.soft],
  ];
  cols.forEach(([tag, h, lines, fill], i) => {
    const x = X + i * 4.05;
    card(s, x, 1.95, 3.83, 3.5, fill);
    s.addText(tag, { x: x + 0.25, y: 2.12, w: 3.3, h: 0.3, fontFace: FONT, fontSize: 12, bold: true, color: C.accent, charSpacing: 2 });
    s.addText(h, { x: x + 0.25, y: 2.45, w: 3.3, h: 0.7, fontFace: FONT, fontSize: 18, bold: true, color: C.ink, valign: "top" });
    s.addText(lines.map((l) => ({ text: l, options: { bullet: { indent: 14 }, breakLine: true, paraSpaceAfter: 8 } })), { x: x + 0.25, y: 3.2, w: 3.3, h: 2.1, fontFace: FONT, fontSize: 14, color: C.ink, valign: "top" });
  });
  strip(s, 5.75, "Two lost renewals cannot train or test a model. It needs the full renewal history, so I generate it.");
}

// 4. Possible solutions
{
  const s = base(
    "3 · Possible solutions",
    "Five ways to solve it",
    "There are five realistic ways to solve this. A: the dashboard as asked. It is familiar, but a colour hides how sure we are and how much money is at stake. B: hand-set rules, like usage fell so add three points. Easy to explain, but the numbers are guesses, and in our data a fall in usage on its own barely separated leavers from stayers. C: a fitted points model that ranks accounts. The points come from past renewals and every reason can be checked, but it needs history and it understates strong clues. D: a model that cannot explain itself, like a chatbot. It could read messy text, but it cannot show its working and may answer differently each time. E: emailing customers automatically. It saves human time, but telling a customer we think they are leaving can cause the loss, and it needs business approval.",
  );
  addTbl(s,
    [
      [hd("Option"), hd("What it gives"), hd("The catch")],
      [bold("A  Dashboard with a colour score"), "Familiar, quick to build", "A colour hides how sure we are and how much money is at stake"],
      [bold("B  Hand-set rules"), "Easy to explain", "The numbers are guesses. In our data a fall in usage alone barely separated leavers (2.4 in 100) from stayers (2.3 in 100)"],
      [bold("C  Points model learned from past renewals"), "Points come from past renewals. Every reason can be checked", "Needs history. Ranks well but understates strong clues"],
      [bold("D  A model that cannot explain itself (like a chatbot)"), "Can read messy text", "Cannot show its working. May answer differently each time"],
      [bold("E  Email customers automatically"), "Saves human time", "\"We think you are leaving\" can cause the loss. Needs business approval"],
    ],
    { x: X, y: 1.85, w: W, colW: [3.5, 3.6, 4.83], fontSize: 14, margin: [0.11, 0.14, 0.11, 0.14], ...tableOpts },
  );
}

// 5. What I take and what I rule out
{
  const s = base(
    "4 · What I take, what I rule out",
    "What I take, and what I rule out",
    "Here is what I took and what I ruled out. I took option C: a points model learned from past renewals, because a manager can read it and check it. I rank accounts by chance of leaving times contract value, and the top fifteen per manager are the week's calls. The manager decides, the system alerts. It only uses what was known at the time, and it runs every night by itself. I ruled out the colour-only dashboard, hand-set guesses, a model that cannot explain itself, like a chatbot, and automatic customer emails. The one exception is a card-update reminder after a failed payment, which is recorded automatically, with nothing actually sent in this demo. I also ruled out guessing at similar company names, because a wrong match puts one customer's warning signs on another, and I left out days until renewal as a clue, because it already decides who is on the list. I kept a simple usage-drop rule as the thing the score has to beat.",
  );
  cardText(
    s,
    X,
    1.9,
    5.85,
    4.7,
    "What I take",
    [
      "A points model learned from past renewals: every reason can be read and checked",
      "Rank by chance of leaving × contract value; top 15 per manager",
      "The manager decides; the system alerts",
      "Use only what was known at the time",
      "A nightly run with no person involved",
      "A simple usage-drop rule as the thing to beat",
    ],
    { fill: C.accentSoft, head: C.accent, size: 14 },
  );
  cardText(
    s,
    6.78,
    1.9,
    5.85,
    4.7,
    "What I rule out",
    [
      "Colour-only scores: they hide how sure we are and the money at stake",
      "Hand-set guesses: no proof they work",
      "A model that cannot explain itself (like a chatbot): no working to show",
      "Automatic emails to customers (a card-update reminder is saved as a record; nothing is actually sent)",
      "Guessing at similar company names: a wrong match moves signals to another customer",
      "\"Days until renewal\" as a clue: it already decides who is on the list",
    ],
    { head: C.muted, size: 14 },
  );
}

// 5. The overnight flow
{
  const s = base(
    "5 · The overall system",
    "Overnight, the system prepares every list by itself",
    "Here is the whole system on one page, left to right. Along the top, five tools feed it: sales records, support tickets, product use, payments and email. About two hundred thousand records, messy on purpose. Step one matches every record to one customer, by email domain and then company name. Records we cannot match are counted and kept, not thrown away. Step two summarises each customer into eleven simple facts, using only what was known on that date. Step three gives a chance of leaving, and multiplies it by the contract value. That chance comes from points learned from past renewals, and the points are re-learned once a month. Step four runs every night at 2am. Each company publishes a complete successful run, and if that company's run fails, its previous list stays available. Step five is the manager's list: the top fifteen, with reasons and the records behind them. When a manager calls, one click takes the customer off the list for two weeks and the next one moves up. The automatic part is limited: it scores, records alerts and card reminders, and publishes. Who to call, what to say, and any customer email stay with the manager. The database itself keeps each company's rows apart, and the company comes from a signed login.",
  );
  const w = 2.1;
  const gap = (W - 5 * w) / 4;
  const colX = (i: number): number => X + i * (w + gap);
  const arrow = (x1: number, y1: number, x2: number, y2: number): void => {
    s.addShape(pptx.ShapeType.line, {
      x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1),
      flipV: y2 < y1, line: { color: C.muted, width: 1.75, endArrowType: "triangle" },
    });
  };
  const box = (x: number, y: number, h: number, head: string, body: string, fill: string, headColor: string): void => {
    card(s, x, y, w, h, fill);
    s.addText(head, { x: x + 0.12, y: y + 0.08, w: w - 0.24, h: 0.35, fontFace: FONT, fontSize: 15, bold: true, color: headColor, valign: "top" });
    s.addText(body, { x: x + 0.12, y: y + 0.45, w: w - 0.24, h: h - 0.5, fontFace: FONT, fontSize: 12, color: headColor === C.white ? C.white : C.ink, valign: "top" });
  };
  s.addText("FIVE TOOLS (about 201,000 records)", { x: X, y: 1.62, w: 6, h: 0.28, fontFace: FONT, fontSize: 11, bold: true, color: C.muted, charSpacing: 2 });
  const tools: [string, string][] = [
    ["Salesforce", "Accounts, renewal dates, contacts"],
    ["Zendesk", "Support tickets"],
    ["Product", "Usage events"],
    ["Stripe", "Invoices, cancel requests"],
    ["Gmail", "Email metadata. Loaded, not scored"],
  ];
  tools.forEach(([h, d], i) => box(colX(i), 1.95, 1.0, h, d, C.soft, C.ink));
  tools.forEach((_, i) => arrow(colX(i) + w / 2, 2.95, colX(i) + w / 2, 3.3));
  s.addText("EVERY NIGHT, AUTOMATICALLY", { x: X, y: 3.3, w: 6, h: 0.28, fontFace: FONT, fontSize: 11, bold: true, color: C.muted, charSpacing: 2 });
  const steps: [string, string][] = [
    ["1  Match", "Link each record to one customer by email domain, then company name"],
    ["2  Summarise", "11 simple facts per customer, using only what was known on that date"],
    ["3  Score", "Chance of leaving, times what the customer pays"],
    ["4  Publish", "Complete runs only, at 2am. A failed run keeps the last list"],
    ["5  Call list", "Top 15 per manager, with reasons and the records behind them"],
  ];
  steps.forEach(([h, d], i) => box(colX(i), 3.62, 1.35, h, d, i === 4 ? C.accent : C.ink, C.white));
  steps.forEach(([, d], i) => {
    if (i === 4) return;
    arrow(colX(i) + w + 0.02, 4.3, colX(i + 1) - 0.02, 4.3);
    void d;
  });
  // The three side inputs and the feedback loop, each pointing at the step they affect.
  box(colX(0), 5.45, 1.0, "Unmatched", "Review queue. Never dropped", C.accentSoft, C.accent);
  arrow(colX(0) + w / 2, 4.97, colX(0) + w / 2, 5.45);
  box(colX(2) - 0.2, 5.45, 1.0, "Past renewals", "Points re-learned monthly", C.accentSoft, C.accent);
  arrow(colX(2) + w / 2, 5.45, colX(2) + w / 2, 4.97);
  box(colX(4), 5.45, 1.0, "After a call", "One click: off the list for 14 days", C.accentSoft, C.accent);
  arrow(colX(4) + w / 2, 5.45, colX(4) + w / 2, 4.97);
  s.addText("Runs by itself: steps 1 to 5, for each company. Stays with the CSM: who to call, what to say, any customer email. Each company's data is kept apart by the database itself, using a signed login.", { x: X, y: 6.52, w: W, h: 0.45, fontFace: FONT, fontSize: 11, color: C.muted, valign: "top" });
}

// 3. The product
{
  const s = base(
    "5 · The overall system",
    "The CSM opens a ranked call list",
    "This is what a manager opens on Monday. The top fifteen are this week's calls, sorted by money at risk, which is the chance of leaving times what the customer pays. Number one is the account. Number two is the chance of leaving in the next 90 days. Number three is the money at risk. Number four is the reasons, in plain words, which give the call a talking point. Now an important point: priority is not the same as chance. Harbor Health has only a 2.6 percent chance, but 160 thousand dollars is at stake, so it ranks above Hollow Finance, which has a 4.9 percent chance on a 31 thousand dollar contract. The list ranks money exposed, not who is most likely to leave. It does not estimate how much a call would save. Customers we cannot score are shown as not scored, never as safe. Switch to the live app here, signed in as this manager.",
    true,
  );
  const imgW = 7.2;
  const k = imgW / 2000; // slide inches per displayed screenshot pixel (the screenshot is 2240 wide, laid out as 2000)
  s.addImage({ path: join(shots, "..", "deck", "call-list.png"), x: X, y: 1.85, w: imgW, h: imgW * (1080 / 2240) });
  const badge = (n: string, x: number, y: number): void => {
    s.addShape(pptx.ShapeType.ellipse, { x: x - 0.15, y: y - 0.15, w: 0.3, h: 0.3, fill: { color: C.accent }, line: { color: C.white, width: 1 } });
    s.addText(n, { x: x - 0.15, y: y - 0.15, w: 0.3, h: 0.3, fontFace: FONT, fontSize: 11, bold: true, color: C.white, align: "center", valign: "middle" });
  };
  const top = 1.85 + 215 * k;
  badge("1", X + 210 * k, top);
  badge("2", X + 525 * k, top);
  badge("3", X + 745 * k, top);
  badge("4", X + 1330 * k, top);
  const items: [string, string, string][] = [
    ["1", "Ranked by money at risk", "Highest first. The top 15 are this week's calls."],
    ["2", "Chance of leaving in 90 days", "From the score learned from past renewals."],
    ["3", "Money at risk", "Chance × contract value."],
    ["4", "Reasons in plain words", "Each one gives the call a talking point."],
  ];
  items.forEach(([n, h, d], i) => {
    const y = 1.85 + i * 0.92;
    s.addShape(pptx.ShapeType.ellipse, { x: 8.2, y: y + 0.03, w: 0.3, h: 0.3, fill: { color: C.accent }, line: { color: C.accent } });
    s.addText(n, { x: 8.2, y: y + 0.03, w: 0.3, h: 0.3, fontFace: FONT, fontSize: 11, bold: true, color: C.white, align: "center", valign: "middle" });
    s.addText(h, { x: 8.65, y, w: 3.95, h: 0.36, fontFace: FONT, fontSize: 15, bold: true, color: C.ink });
    s.addText(d, { x: 8.65, y: y + 0.38, w: 3.95, h: 0.45, fontFace: FONT, fontSize: 13, color: C.ink, valign: "top" });
  });
  card(s, X, 5.45, W, 1.3, C.accentSoft);
  s.addText(
    [
      { text: "Priority is not the same as chance. ", options: { bold: true, color: C.accent } },
      { text: "Harbor Health: 2.6% chance × $160,400 = $4,213 at risk, ranked first. Hollow Finance: 4.9% × $30,900 = $1,524, ranked second. The list ranks money exposed, not who is likeliest to leave. It does not estimate how much a call would save.", options: { color: C.ink } },
    ],
    { x: X + 0.25, y: 5.5, w: W - 0.5, h: 1.2, fontFace: FONT, fontSize: 14, valign: "middle" },
  );
}

// 4. One account's journey
{
  const s = base(
    "5 · The overall system",
    "One account: from warning signs to a call",
    "Take one real account from the demo, Meridian Marine. Step one: it is number one on this manager's list, a 7.3 percent chance and 7,307 dollars at risk. Step two: why. It opened two support tickets in 90 days, where a typical customer opens half of one, and one of its contacts is marked inactive. Step three: open the account and the reasons link to the actual records: two ticket IDs and one contact ID. Nothing is hidden, and a test rebuilds every stored score from its stored reasons. Step four: the manager calls and clicks one button, I contacted this customer today. The account leaves this week's list for 14 days and the next account moves up. Switch to the live app and walk through these four steps.",
    true,
  );
  const w = 6.9;
  s.addImage({ path: join(shots, "..", "deck", "account.png"), x: X, y: 1.85, w, h: w * (1380 / 2240) });
  const steps: [string, string][] = [
    ["1  It is number one on the list", "7.3% chance of leaving, $7,307 at risk, renewal in 9 days."],
    ["2  The reasons are specific", "2 support tickets in 90 days (a typical customer has 0.5), and 1 contact marked inactive."],
    ["3  Every reason links to records", "Ticket IDs zd9f398346b6 and zd231971d522, and contact SC86b7decf."],
    ["4  The call is logged", "One click: the account leaves this week's list for 14 days and the next one moves up."],
  ];
  steps.forEach(([h, d], i) => {
    const y = 1.85 + i * 1.07;
    s.addText(h, { x: 7.95, y, w: 4.7, h: 0.36, fontFace: FONT, fontSize: 15, bold: true, color: C.accent });
    s.addText(d, { x: 7.95, y: y + 0.38, w: 4.7, h: 0.65, fontFace: FONT, fontSize: 13, color: C.ink, valign: "top" });
  });
  strip(s, 6.3, "A person decides who to call and what to say. The system finds the accounts and shows the evidence.", 0.55);
}

// 7. One score worked out
{
  const s = base(
    "5 · The overall system",
    "How Meridian Marine's score adds up",
    "Here is how the same account's score adds up. A typical customer is the starting point: zero points, which is a 1.8 percent chance of leaving. That 1.8 percent is an estimate of the chance, not a promise. Each clue then adds or removes points, depending on how this customer compares with a typical one. Two support tickets add 0.68, one inactive contact adds 0.66, four small usage clues add 0.29 together, and a long relationship and a large contract take off 0.16. The total is about plus 1.45 points, which moves the chance from 1.8 percent up to 7.3 percent. The same steps are used for every customer, and the account page shows every clue, its points, and the records behind it. If asked, the method is a standard one, called logistic regression.",
    true,
  );
  const steps: [string, string][] = [
    ["1. Start from a typical customer", "A typical customer is 0 points: a 1.8% estimated chance of leaving."],
    ["2. Add or remove points", "Each clue pushes the estimate up or down, depending on how this customer compares with a typical one."],
    ["3. Turn the total into a chance", "About +1.45 points moves 1.8% up to 7.3%."],
  ];
  steps.forEach(([h, d], i) => {
    const y = 1.95 + i * 1.45;
    s.addText(h, { x: X, y, w: 4.3, h: 0.4, fontFace: FONT, fontSize: 17, bold: true, color: C.accent });
    s.addText(d, { x: X, y: y + 0.42, w: 4.3, h: 0.9, fontFace: FONT, fontSize: 14, color: C.ink, valign: "top" });
  });
  s.addText("Points added or removed for Meridian Marine (negative = safer)", { x: 5.3, y: 1.9, w: 7.3, h: 0.35, fontFace: FONT, fontSize: 14, bold: true, color: C.ink });
  s.addChart(
    pptx.ChartType.bar,
    [
      {
        name: "Points",
        labels: ["2 support tickets (typical 0.5)", "1 contact marked inactive", "Usage clues (4 small ones)", "Long relationship, large contract", "All other clues"],
        values: [0.68, 0.66, 0.29, -0.16, -0.03],
      },
    ],
    {
      x: 5.2, y: 2.25, w: 7.4, h: 3.2, barDir: "bar", chartColors: [C.accent], invertedColors: [C.green], catAxisOrientation: "maxMin" as "minMax",
      catAxisLabelFontFace: FONT, catAxisLabelFontSize: 12, catAxisLabelColor: C.ink, catAxisLabelPos: "low",
      valAxisHidden: true, valGridLine: { style: "none" }, showValue: true, dataLabelFormatCode: "+0.00;-0.00", dataLabelFontSize: 12, dataLabelFontFace: FONT, dataLabelColor: C.ink,
      valAxisMinVal: -0.3, valAxisMaxVal: 0.9, showLegend: false,
    },
  );
  strip(s, 5.75, "Total about +1.45 points: a 1.8% starting point becomes a 7.3% estimate for this customer");
}

// 8. Evidence
{
  const s = base(
    "5 · The overall system",
    "A clue earns points by how many past customers with it left",
    "Why does a clue add points? Because of what past customers did. Of about sixteen thousand past cases, 2.3 percent left overall. Where a customer had asked to cancel, 50 in 100 left, against 2 in 100 without. With three or more complaints in 90 days, 13 in 100 left. With a plan cut, 17 in 100. A complaint still open and inactive contacts matter a little. A fall in product usage on its own did not separate leavers from stayers. These are patterns seen in the generated history. The points are fitted with all the clues together, so they are not exactly these percentages, but a bigger gap usually means more points. The account page shows these numbers for every clue.",
  );
  const labels = ["Asked to cancel at renewal", "Reduced their plan recently", "3+ complaints in 90 days", "Complaint still open", "Some contacts marked inactive", "Product usage fell"];
  s.addChart(
    pptx.ChartType.bar,
    [
      { name: "Had the clue", labels, values: [50.0, 17.1, 13.2, 4.6, 3.8, 2.4] },
      { name: "Did not have it", labels, values: [2.1, 2.2, 2.0, 2.3, 2.2, 2.3] },
    ],
    {
      x: X - 0.1, y: 2.35, w: 7.9, h: 4.15, barDir: "bar", chartColors: [C.accent, "C7CBD6"], catAxisOrientation: "maxMin" as "minMax", barGapWidthPct: 45,
      catAxisLabelFontFace: FONT, catAxisLabelFontSize: 12, catAxisLabelColor: C.ink, valAxisHidden: true, valGridLine: { style: "none" },
      showValue: true, dataLabelFormatCode: "0.0", dataLabelFontSize: 11, dataLabelFontFace: FONT, dataLabelColor: C.ink, showLegend: true, legendPos: "b", legendFontFace: FONT, legendFontSize: 12,
    },
  );
  strip(s, 1.75, "Read it like this: of every 100 past customers who asked to cancel, 50 left. Of every 100 who did not, only 2.", 0.5);
  s.addText("Out of every 100 past customers, how many left", { x: X, y: 6.55, w: 7.5, h: 0.3, fontFace: FONT, fontSize: 11, color: C.muted });
  const tiers: [string, string, string, string][] = [
    ["Bigger gap, more points", "Cancel request: 50 vs 2", "The clue separates leavers from stayers, so it adds a lot.", C.accentSoft],
    ["Small gap, few points", "Complaint still open: 4.6 vs 2.3", "A weak hint, so it adds a little.", C.soft],
    ["No gap, almost no points", "Usage fell: 2.4 vs 2.3", "Looks scary, but did not predict leaving here. So it adds almost nothing.", C.soft],
  ];
  tiers.forEach(([h, ex, d, fill], i) => {
    const y = 2.4 + i * 1.38;
    card(s, 8.95, y, 3.68, 1.26, fill);
    s.addText(h, { x: 9.12, y: y + 0.08, w: 3.4, h: 0.32, fontFace: FONT, fontSize: 14, bold: true, color: C.accent });
    s.addText(ex, { x: 9.12, y: y + 0.4, w: 3.4, h: 0.28, fontFace: FONT, fontSize: 12, bold: true, color: C.ink });
    s.addText(d, { x: 9.12, y: y + 0.68, w: 3.4, h: 0.55, fontFace: FONT, fontSize: 11, color: C.ink, valign: "top" });
  });
  s.addText("16,415 past cases, 2.3% left. Points are fitted with all clues together.", { x: 8.95, y: 6.55, w: 3.68, h: 0.4, fontFace: FONT, fontSize: 10, color: C.muted, valign: "top" });
}

// 11. Nightly log and unmatched queue
{
  const s = base(
    "5 · The overall system",
    "Every night is logged, and what we cannot match is kept",
    "Two more screens from the same app. On the left, the run log: every nightly attempt with its status and how many accounts were scored or unknown. Only a succeeded run is shown to managers, and the column on the right says which one is live now. A failed run is logged, never published, and the company keeps its previous list. On the right, the unmatched queue: source records we could not link to exactly one customer. They are kept, not scored, and listed with what we tried to match on, so someone can fix the missing domain or company name in the CRM. The queue is rebuilt every night, so a record leaves once it matches. These screenshots are from my local copy of the data.",
  );
  const w = 5.85;
  s.addImage({ path: join(shots, "..", "deck", "run-log.png"), x: X, y: 1.95, w, h: w * (840 / 2240) });
  s.addImage({ path: join(shots, "..", "deck", "unmatched.png"), x: 6.78, y: 1.95, w: 5.0, h: 5.0 * (1040 / 2240) });
  s.addText("Run log: every attempt, and which run is live", { x: X, y: 4.45, w, h: 0.35, fontFace: FONT, fontSize: 15, bold: true, color: C.accent });
  s.addText("Only a succeeded run is published. A failed run is logged and the company keeps its previous list.", { x: X, y: 4.85, w, h: 0.8, fontFace: FONT, fontSize: 13, color: C.ink, valign: "top" });
  s.addText("Unmatched queue: records we could not link", { x: 6.78, y: 4.45, w, h: 0.35, fontFace: FONT, fontSize: 15, bold: true, color: C.accent });
  s.addText("Kept and not scored, with what we tried to match on. Rebuilt every night.", { x: 6.78, y: 4.85, w, h: 0.8, fontFace: FONT, fontSize: 13, color: C.ink, valign: "top" });
  strip(s, 5.9, "Unknown stays unknown: nothing is silently dropped, and nothing unscored is shown as safe.", 0.7);
}

// 10. Safeguards
{
  const s = base(
    "5 · The overall system",
    "The safeguards are tested, and I say what they cannot do",
    "These are the failure cases that matter, each as a problem, what the system does, and the evidence. Late records: a record that arrives after the scoring date is ignored, so a score never uses information from its own future, and a test proves it. Accounts we cannot score or match: they are shown as not scored with the reason, and unmatched records go to a review queue. A wrong match or missing source data can still hide a signal, so this reduces the problem and does not remove it. A failed run: it is logged and never published, and that company keeps its previous list, which I tested by breaking a run on purpose. Company separation: the database itself blocks other companies' rows, with the company taken from a signed login that the app checks. The tests try the wrong company, and forged, expired and edited logins. Traceability: every reason links to its records, and a test rebuilds each stored score from its stored reasons. What I can promise: every renewal in the next 90 days is a call, on the watch list, or not scored with the reason. What I cannot promise: that every at-risk customer is called or saved.",
  );
  addTbl(s,
    [
      [hd("Problem"), hd("What the system does"), hd("Evidence")],
      [bold("Records arrive late"), "A record received after the scoring date is ignored, so a score never uses its own future", "Test: late record is not used"],
      [bold("Cannot score or match"), "Shown as \"not scored\" with the reason, never as safe. Unmatched records go to a review queue. A wrong match or missing source data can still hide a signal", "Unmatched page; counts per source"],
      [bold("A run fails"), "Logged, never published. That company keeps its previous list", "Test: run broken on purpose"],
      [bold("Another company's data"), "The database itself blocks other companies' rows. The company comes from a signed login, checked by the app", "Tests: wrong company, forged, expired, edited logins"],
      [bold("\"Why this score?\""), "Every reason links to its source records", "Test rebuilds each stored score from its reasons"],
    ],
    { x: X, y: 1.8, w: W, colW: [2.4, 6.2, 3.33], fontSize: 14, margin: [0.09, 0.12, 0.09, 0.12], ...tableOpts },
  );
  strip(s, 6.15, "Promised: every renewal is a call, on the watch list, or \"not scored\" with the reason. Not promised: that every at-risk customer is called or saved.", 0.7);
}

// 9. Results
{
  const s = base(
    "5 · The overall system",
    "The score found 18 of 29 leavers in the call lists; a simple rule found 12",
    "How do I know it works? I trained on earlier renewals and tested on a later date the system had never seen, against a simple rule: pick the customers whose usage dropped. In each manager's top fifteen, the score catches 18 of the 29 customers who left, against 12 for the rule. That is the number to remember. A second measure, ranking quality, is 0.71 against 0.60, where 0.5 is a coin toss. The honest caveats: only 29 customers left in the test, so a difference of a few is suggestive, not proof, and the ranges are wide. The data is generated, so this shows the system works, not how it would do on real customers. Earlier versions scored higher, 0.83, before I fixed how leaving is defined, and I reported the more defensible number.",
  );
  s.addText("Leavers caught in each manager's top 15 (out of 29)", { x: X, y: 1.9, w: 6, h: 0.35, fontFace: FONT, fontSize: 14, bold: true, color: C.ink });
  s.addChart(
    pptx.ChartType.bar,
    [{ name: "Leavers caught", labels: ["Our score", "Simple rule (usage dropped)"], values: [18, 12] }],
    {
      x: X - 0.1, y: 2.3, w: 6.2, h: 3.4, barDir: "col", chartColors: [C.accent, "C7CBD6"], barGapWidthPct: 60,
      catAxisLabelFontFace: FONT, catAxisLabelFontSize: 13, catAxisLabelColor: C.ink, valAxisHidden: true, valGridLine: { style: "none" }, valAxisMinVal: 0, valAxisMaxVal: 29,
      showValue: true, dataLabelFontSize: 20, dataLabelFontFace: FONT, dataLabelColor: C.ink, showLegend: false,
    },
  );
  stat(s, 7.4, 1.9, 2.8, "18 of 29", "leavers in each manager's top 15: our score");
  stat(s, 10.2, 1.9, 2.4, "12 of 29", "the simple usage-drop rule", C.muted);
  s.addText(
    [
      { text: "Tested on a later date the system never saw (15 June 2026).", options: { bullet: { indent: 14 }, breakLine: true, paraSpaceAfter: 6 } },
      { text: "Only 29 customers left, so a gap of a few is suggestive, not proof.", options: { bullet: { indent: 14 }, breakLine: true, paraSpaceAfter: 6 } },
      { text: "Ranking quality score: 0.71 vs 0.60 (0.5 is a coin toss). Likely ranges 0.65 to 0.85 and 0.51 to 0.69.", options: { bullet: { indent: 14 }, breakLine: true, paraSpaceAfter: 6 } },
      { text: "Earlier 0.83 was before I fixed what \"leaving\" means. I report 0.71.", options: { bullet: { indent: 14 }, breakLine: true, paraSpaceAfter: 6 } },
    ],
    { x: 7.4, y: 3.75, w: 5.2, h: 2.3, fontFace: FONT, fontSize: 13, color: C.ink, valign: "top" },
  );
  strip(s, 6.15, "The data is generated: this shows the system works, not how it would do on real customers.", 0.6);
}

// 13. Left out
{
  const s = base(
    "6 · What is left out, and why",
    "What I left out, and why",
    "To close, what I left out and why. Real connections to the tools and a real company sign-in: generated files and a demo login are enough to show the system works. Real email sending: the reminder is saved as a record and nothing is actually sent, because wording and who switches it on need approval. Gmail in the score: it is loaded and stored, and I tested it once as two clues, replies and unanswered emails, on the generated data. There was no measurable gain, so it is not scored, and using it needs the legal basis confirmed. Whether a call actually saves a customer: no outcomes are recorded yet, so I keep the call log from day one to measure it later. How close the percentage is to reality: the score ranks well but understates strong clues, so a typical customer with a cancel request gets 21 to 29 percent when about half actually left. And scale: at ten times the size, the nightly job re-reads everything and two runs could overlap, so I would process only what changed and allow one run at a time. The live demo link is on the slide. Thanks for watching.",
  );
  addTbl(s,
    [
      [hd("Left out"), hd("Why"), hd("What comes next")],
      [bold("Real connections and sign-in"), "Generated files and a demo login show the system works", "Connections to the real tools and a real company sign-in"],
      [bold("Real email sending"), "The reminder is saved as a record; nothing is actually sent. Wording and who switches it on need approval", "Business and legal approval, then a real send"],
      [bold("Gmail in the score"), "Loaded, not scored. Tested once on generated data: no measurable gain. The legal basis is unconfirmed", "Revisit with real mailbox volume and approval"],
      [bold("Whether a call saves a customer"), "No outcomes are recorded yet", "The call log is kept from day one, so this can be measured"],
      [bold("How close the percentage is to reality"), "It ranks well but understates strong clues: cancel request about 21 to 29% predicted, about 50% actual", "Check predicted against actual by band"],
      [bold("Ten times the size"), "The nightly job re-reads everything; two runs could overlap", "Process only what changed; one run at a time"],
    ],
    { x: X, y: 1.75, w: W, colW: [2.9, 5.2, 3.83], fontSize: 12, margin: [0.07, 0.12, 0.07, 0.12], ...tableOpts },
  );
  s.addText(`Live demo: ${APP_URL}/    Sign in as: org_a · org_a-CSM3${DEMO_CODE ? `    Access code: ${DEMO_CODE}` : ""}`, { x: X, y: 6.5, w: W, h: 0.4, fontFace: FONT, fontSize: 14, bold: true, color: C.ink });
}

// Backup divider
{
  const s = pptx.addSlide();
  s.background = { color: C.ink };
  s.addText("BACKUP", { x: 0.9, y: 2.3, w: 11, h: 0.4, fontFace: FONT, fontSize: 14, bold: true, color: "9AA3F5", charSpacing: 4 });
  s.addText("Answers to likely questions", { x: 0.9, y: 2.8, w: 11.5, h: 1.0, fontFace: FONT, fontSize: 40, bold: true, color: C.white });
  s.addText("Why each step is built that way · nightly and monthly · a year later · the five requirements · judgement calls · what breaks at 10×", { x: 0.9, y: 4.0, w: 11.5, h: 0.9, fontFace: FONT, fontSize: 18, color: "C9CBD6", valign: "top" });
  s.addNotes("These slides are backup. I only open them if a question needs them.");
}

// B3. Nightly and monthly
{
  const s = base(
    "Backup · over time",
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

// B4. A year later
{
  const s = base(
    "Backup · over time",
    "A year later: the points move, the ranking holds",
    "I cannot observe a real future year, so I replayed the sample data. One copy of the system learns only from what was known on 15 June 2025, the other from what was known on 15 June 2026, and both are tested on the same later date. Take one factor: asked to cancel at renewal. On day one, 44 in 100 past customers with that factor left, and it added 2.49 points. A year later, 51 in 100 left, and it adds 3.02 points. Where the share barely moved, such as plan cuts, the points barely moved. How the number arises: the points come from a number the system learned, 0.184 for this factor on day one, multiplied by how unusual the factor is, which is about 13.5 times the usual variation because only 0.5 percent of cases had it. The points understate strong clues: a typical customer with this factor gets 21 to 29 percent, while 44 to 51 in 100 actually left. Overall, the top fifteen lists share 85 percent of their names, and ranking quality is 0.75 against 0.73, which this small test cannot show to be a meaningful difference, with only 29 leavers. More history did not improve ranking here. This generated data has no change over time built in, while real customers do change, which is why the points are re-learned monthly.",
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
  stat(s, 8.9, 3.5, 3.7, "0.75 → 0.73", "ranking quality: too few leavers (29) to call this a real change", C.muted);
  s.addText("More history did not improve ranking here. This generated data has no change over time built in; real customers do change, which is why the points are re-learned monthly. Replayed, not observed: each version learned only from what was known on 15 June 2025 or 2026, then both were tested on 15 June 2026 (npm run replay).", {
    x: X, y: 5.55, w: W, h: 1.2, fontFace: FONT, fontSize: 12, color: C.muted, valign: "top",
  });
}

// B5. Requirements
{
  const s = base(
    "Backup · the proof",
    "The five requirements, and how each is met",
    "The assignment set five non-negotiables. One, generate the data: five thousand customers across four companies, about two hundred thousand records from five places, messy on purpose. Two, a score fitted on the data: learned from past renewals and tested on later ones against a simple rule. Three, something that runs by itself: a nightly job, with a run log, and a run I broke on purpose was recorded and never shown to managers. Four, multiple companies: the database itself blocks other companies' rows, with the company taken from a signed login, and tests with the wrong company, a forged, expired and edited login all fail. Five, everything traceable: every reason shows its points and the records behind it, and a test rebuilds every stored score from its stored reasons.",
  );
  addTbl(s, 
    [
      [hd("Requirement"), hd("What I did"), hd("How you can check")],
      [bold("Generate the data"), "5,000 customers, 4 companies, ~201,000 records from 5 tools. Late, repeated, duplicated and missing records on purpose", "The generator checks itself. The true answers are kept apart and never used by the score"],
      [bold("A score fitted on the data"), "Learned from past renewals, tested on later ones, compared with a simple rule", "Top 15 catches 18 of 29 leavers vs 12 for the rule"],
      [bold("Runs by itself"), "A nightly job: score, raise alerts, publish. Points re-learned monthly", "Run log shows every attempt. A run I broke on purpose was recorded and never shown"],
      [bold("Multiple companies"), "The database itself blocks other companies' rows. The company comes from a signed login that expires", "Tests: wrong company, forged, expired and edited logins all fail"],
      [bold("Everything traceable"), "Every reason shows its points and the records behind it", "A test rebuilds every stored score from its stored reasons"],
    ],
    { x: X, y: 1.9, w: W, colW: [2.5, 5.2, 4.23], fontSize: 13, margin: [0.09, 0.12, 0.09, 0.12], ...tableOpts },
  );
}

// B6. Judgement calls
{
  const s = base(
    "Backup · the proof",
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

const out = DEMO_CODE ? join(root, "docs", "private") : join(root, "docs");
mkdirSync(out, { recursive: true });
const file = join(out, DEMO_CODE ? "renewal-risk-deck-with-login.pptx" : "renewal-risk-deck.pptx");
await pptx.writeFile({ fileName: file });
console.log(`wrote ${file}`);
