/**
 * Synthetic, deliberately messy renewal data. Seeded: same seed, same output.
 *
 * Writes what the pipeline may read to data/raw/ and the answer key to data/truth/.
 * The pipeline must never open data/truth/. It exists for evaluation only.
 *
 * Known limits (stated in the README):
 * - Accounts that left before the history window are not generated (survivorship).
 * - Hidden drivers (championGone, budgetCut) are only partly visible, on purpose.
 *
 * Usage: npm run generate -- --accounts 5000 --seed 42
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Rng = () => number;
type Row = Record<string, string | number | boolean>;
type Cycle = "annual" | "monthly" | "multi_year";
type LeaveType = "none" | "renewal" | "mid_contract";

interface Account {
  customerId: string;
  sfId: string;
  orgId: string;
  company: string;
  domain: string;
  owner: string;
  start: Date;
  cycle: Cycle;
  term: number;
  value: number;
  health: number; // hidden: how healthy the customer really is
  championGone: boolean; // hidden: main supporter left their company
  budgetCut: boolean; // hidden: their budget was cut
  activity: number; // usage events per month at baseline
  leftDate: Date | null;
  leaveType: LeaveType;
  symptomatic: boolean; // hidden: leaves after visible warning signs. The other half leave silently.
  returnedOn: Date | null;
}

const DAY_MS = 86_400_000;
const END = new Date(Date.UTC(2026, 9, 15)); // "today"
const START = new Date(Date.UTC(2023, 9, 15)); // three years of history
const WINDOW_END = addDays(END, 90); // renewals up to 90 days ahead are simulated

const WORDS = [
  "Northwind", "Bluepeak", "Harbor", "Lumen", "Cedar", "Atlas", "Orbit", "Quarry",
  "Maple", "Ironclad", "Silverline", "Keystone", "Vantage", "Pioneer", "Summit",
  "Tidewater", "Granite", "Beacon", "Willow", "Redwood", "Falcon", "Meridian",
  "Crescent", "Juniper", "Sterling", "Evergreen", "Compass", "Copperline", "Ember",
  "Glacier", "Hollow", "Ironwood", "Jasper", "Kestrel", "Linden", "Monarch",
  "Nimbus", "Oakridge", "Prairie", "Quartz", "Riverbend",
];
const KINDS = [
  "Labs", "Health", "Logistics", "Foods", "Finance", "Media", "Works", "Analytics",
  "Retail", "Energy", "Systems", "Partners", "Holdings", "Dynamics", "Studio",
  "Supply", "Care", "Motors", "Travel", "Learning", "Capital", "Legal", "Realty",
  "Textiles", "Marine",
];
const FIRST = [
  "Asha", "Ben", "Chloe", "Dev", "Elena", "Farid", "Grace", "Hiro", "Isla", "Jonas",
  "Kavya", "Liam", "Mira", "Noah", "Olu", "Priya", "Quinn", "Rafael", "Sana", "Tom",
  "Uma", "Victor", "Wen", "Xavier", "Yara", "Zain", "Amara", "Bruno", "Ines", "Kenji",
];
const LAST = [
  "Shah", "Patel", "Okafor", "Novak", "Lindqvist", "Garcia", "Mendes", "Tanaka",
  "Brown", "Singh", "Kim", "Rossi", "Haddad", "Muller", "Dubois", "Ivanova", "Adeyemi",
  "Costa", "Larsen", "Nguyen", "Park", "Reyes", "Silva", "Weber", "Yilmaz", "Chen",
];
const PERSONAL = ["gmail.com", "outlook.com", "yahoo.com"];
const ROLES = ["Daily user", "Approver", "Billing", "Executive"];
const ORGS = ["org_a", "org_b", "org_c", "org_d"];
const EVENT_TYPES = ["login", "report_view", "export", "api_call", "invite_user", "dashboard_edit"];
const PRIORITIES = ["low", "normal", "high", "urgent"];
const TERMS: Record<Cycle, number> = { annual: 365, monthly: 30, multi_year: 1095 };
const BILLING_STEP: Record<Cycle, number> = { annual: 365, monthly: 30, multi_year: 365 };
const AMOUNT_FACTOR: Record<Cycle, number> = { annual: 1, monthly: 1 / 12, multi_year: 1 / 3 };
const RAW_FILES = [
  "sf_accounts",
  "sf_contacts",
  "zd_tickets",
  "product_events",
  "stripe_invoices",
  "stripe_subscription_events",
  "gmail_messages",
] as const;
const DATA_FILES_WITH_SHUFFLE = ["product_events", "zd_tickets", "stripe_invoices", "stripe_subscription_events", "gmail_messages"];

// ---------- seeded random numbers ----------

function mulberry32(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function choice<T>(rng: Rng, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error("choice() called with an empty list");
  return item;
}

function gauss(rng: Rng, mu: number, sigma: number): number {
  const u = 1 - rng();
  const v = rng();
  return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function poisson(rng: Rng, lambda: number): number {
  // Knuth's method, fine for the small rates used here.
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = rng();
  while (p > limit) {
    p *= rng();
    k++;
  }
  return k;
}

function expo(rng: Rng, mean: number): number {
  return -Math.log(1 - rng()) * mean;
}

function hex(rng: Rng, n: number): string {
  return Array.from({ length: n }, () => Math.floor(rng() * 16).toString(16)).join("");
}

function shuffle<T>(rng: Rng, items: T[]): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j] as T, items[i] as T];
  }
}

// ---------- dates ----------

function addDays(x: Date, days: number): Date {
  return new Date(x.getTime() + days * DAY_MS);
}

function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / DAY_MS);
}

function dateOnly(x: Date): string {
  return x.toISOString().slice(0, 10);
}

function stamp(x: Date): string {
  return x.toISOString().slice(0, 16).replace("T", " ");
}

function randomMoment(rng: Rng, lo: Date, hi: Date): Date {
  const day = addDays(lo, randInt(rng, 0, daysBetween(lo, hi)));
  return new Date(day.getTime() + randInt(rng, 0, 1439) * 60_000);
}

function lag(rng: Rng): number {
  // Days between something happening and us receiving it. Mostly fast, sometimes weeks.
  let days = expo(rng, 1);
  if (rng() < 0.05) days += 7 + rng() * 38;
  return days;
}

function ingestedAt(rng: Rng, when: Date): Date {
  return new Date(when.getTime() + lag(rng) * DAY_MS);
}

// ---------- messy text ----------

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function noisyName(rng: Rng, name: string): string {
  // The same company, written differently by another system.
  const roll = rng();
  if (roll < 0.4) return name;
  if (roll < 0.6) return `${name} Inc.`;
  if (roll < 0.7) return name.toUpperCase();
  if (roll < 0.8) return name.replace(/ /g, "");
  if (roll < 0.9) return name.split(" ")[0] ?? name;
  return name.replace("a", "e");
}

// ---------- churn model (hidden truth) ----------

function logistic(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function churnProbability(a: Account): number {
  const logit =
    -2.9 - 0.9 * a.health + 0.9 * Number(a.championGone) + 1.1 * Number(a.budgetCut);
  let p = logistic(logit);
  if (a.term === 30) p = 1 - (1 - p) ** (1 / 12); // annual odds turned into a monthly chance
  else if (a.term === 1095) p *= 0.5; // multi-year contracts are harder to leave
  return p;
}

function renewalDates(start: Date, term: number): Date[] {
  const dates: Date[] = [];
  for (let k = 1; ; k++) {
    const renewal = addDays(start, k * term);
    if (renewal > WINDOW_END) return dates;
    if (renewal >= START) dates.push(renewal);
  }
}

function nextRenewal(start: Date, term: number): Date {
  let k = 1;
  while (addDays(start, k * term) <= END) k++;
  return addDays(start, k * term);
}

// ---------- accounts ----------

function weightedCycle(rng: Rng): Cycle {
  const roll = rng();
  if (roll < 0.7) return "annual";
  if (roll < 0.9) return "monthly";
  return "multi_year";
}

function makeAccount(rng: Rng, index: number, usedDomains: Set<string>): Account | null {
  const name = `${choice(rng, WORDS)} ${choice(rng, KINDS)}`;
  let domain = `${slug(name)}.com`;
  while (usedDomains.has(domain)) domain = `${slug(name)}${randInt(rng, 2, 999)}.com`;
  usedDomains.add(domain);

  const start =
    rng() < 0.08
      ? addDays(END, -randInt(rng, 20, 180)) // newer customers
      : addDays(START, -randInt(rng, 0, 1400));
  const cycle = weightedCycle(rng);
  const org = choice(rng, ORGS);
  const account: Account = {
    customerId: `C${String(index).padStart(5, "0")}`,
    sfId: `SF${String(index).padStart(8, "0")}`,
    orgId: org,
    company: name,
    domain,
    owner: `${org}-CSM${randInt(rng, 1, 10)}`,
    start,
    cycle,
    term: TERMS[cycle],
    value: Math.round(Math.exp(gauss(rng, 9.5, 1.0)) / 100) * 100,
    health: gauss(rng, 0, 1),
    championGone: rng() < 0.1,
    budgetCut: rng() < 0.06,
    activity: Math.exp(gauss(rng, -0.7, 0.8)), // tuned so total events land near the 200,000 target
    leftDate: null,
    leaveType: "none",
    symptomatic: false,
    returnedOn: null,
  };

  for (const renewal of renewalDates(start, account.term)) {
    if (rng() < churnProbability(account)) {
      if (account.term > 30 && rng() < 0.15) {
        account.leaveType = "mid_contract";
        account.leftDate = addDays(renewal, -randInt(rng, 30, 150));
      } else {
        account.leaveType = "renewal";
        account.leftDate = renewal;
      }
      account.symptomatic = rng() < 0.5;
      break;
    }
  }
  if (account.leftDate && account.leftDate < START) return null; // left before the window
  if (account.leftDate && rng() < 0.1) {
    const back = addDays(account.leftDate, randInt(rng, 45, 120));
    if (back <= END) account.returnedOn = back;
  }
  return account;
}

interface ActiveMonth {
  lo: Date;
  hi: Date;
  daysToLeave: number | null;
}

/** Calendar months with activity: before leaving, and again after returning (if they came back). */
function activeMonths(a: Account): ActiveMonth[] {
  const loDay = a.start > START ? a.start : START;
  const spans: { from: Date; to: Date; leaving: boolean }[] = [];
  const firstEnd = a.leftDate && a.leftDate < END ? a.leftDate : END;
  if (loDay <= firstEnd) spans.push({ from: loDay, to: firstEnd, leaving: !!a.leftDate });
  if (a.returnedOn) spans.push({ from: a.returnedOn, to: END, leaving: false });

  const months: ActiveMonth[] = [];
  for (const span of spans) {
    let month = new Date(Date.UTC(span.from.getUTCFullYear(), span.from.getUTCMonth(), 1));
    while (month <= span.to) {
      const next = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));
      const lo = month > span.from ? month : span.from;
      const monthEnd = addDays(next, -1);
      const hi = monthEnd < span.to ? monthEnd : span.to;
      if (hi >= lo) {
        months.push({ lo, hi, daysToLeave: span.leaving && a.leftDate ? daysBetween(hi, a.leftDate) : null });
      }
      month = next;
    }
  }
  return months;
}

// Signal strength before leaving. Tuned so the as-of test gives a usable but not perfect signal.
// Warning signs build for months before a renewal, not just weeks.
function usageFactor(daysToLeave: number | null): number {
  if (daysToLeave === null) return 1;
  if (daysToLeave <= 60) return 0.1;
  if (daysToLeave <= 180) return 0.35;
  return 1;
}

function ticketFactor(daysToLeave: number | null): number {
  if (daysToLeave === null) return 1;
  if (daysToLeave <= 60) return 3;
  if (daysToLeave <= 180) return 2;
  return 1;
}

// ---------- emitters: one customer's rows in each source ----------

interface Contact {
  contactId: string;
  email: string;
}

function emitContacts(rng: Rng, a: Account, tables: Tables): Contact[] {
  const people: Contact[] = [];
  const count = randInt(rng, 1, 3);
  for (let k = 0; k < count; k++) {
    const first = choice(rng, FIRST);
    const last = choice(rng, LAST);
    let role = k === 0 ? "Daily user" : choice(rng, ROLES);
    if (rng() < 0.15) role = ""; // missing role
    const active = !(k === 0 && a.championGone && rng() < 0.7);
    const email = `${first}.${last}@${a.domain}`.toLowerCase();
    const contactId = `SC${hex(rng, 8)}`;
    people.push({ contactId, email });
    tables.sf_contacts.push({
      contact_id: contactId,
      org_id: a.orgId,
      sf_id: a.sfId,
      email,
      role,
      is_active: active,
    });
  }
  return people;
}

function emitSalesforceAccount(rng: Rng, a: Account, tables: Tables): void {
  const next = nextRenewal(a.start, a.term);
  const row: Row = {
    sf_id: a.sfId,
    org_id: a.orgId,
    company_name: a.company,
    email_domain: rng() > 0.02 ? a.domain : "",
    owner_csm_id: rng() > 0.02 ? a.owner : "",
    contract_value: rng() > 0.01 ? a.value : "",
    renewal_date: rng() > 0.03 ? dateOnly(next) : "",
    billing_cycle: a.cycle,
    start_date: dateOnly(a.start),
  };
  tables.sf_accounts.push(row);
  if (rng() < 0.015) {
    // Duplicate CRM record with a stale renewal date.
    tables.sf_accounts.push({
      ...row,
      sf_id: `${a.sfId}-D`,
      renewal_date: dateOnly(addDays(next, -a.term)),
    });
  }
}

function emitUsage(rng: Rng, a: Account, tables: Tables): void {
  for (const m of activeMonths(a)) {
    const lambda = a.activity * Math.exp(0.35 * a.health) * usageFactor(a.symptomatic ? m.daysToLeave : null);
    const count = poisson(rng, lambda);
    for (let n = 0; n < count; n++) {
      const when = randomMoment(rng, m.lo, m.hi);
      let domain = a.domain;
      if (rng() < 0.01) domain = domain.replace(".com", ".co"); // typo: will not match
      const row: Row = {
        event_id: `ev${hex(rng, 10)}`,
        org_id: a.orgId,
        account_domain: domain,
        user_id: `u${randInt(rng, 1, 30)}`,
        event_type: choice(rng, EVENT_TYPES),
        event_time: stamp(when),
        ingested_at: stamp(ingestedAt(rng, when)),
      };
      tables.product_events.push(row);
      if (rng() < 0.02) {
        // Replayed copy, arrives later with the same event_id.
        tables.product_events.push({ ...row, ingested_at: stamp(addDays(ingestedAt(rng, when), randInt(rng, 1, 3))) });
      }
    }
  }
}

function emitTickets(rng: Rng, a: Account, people: Contact[], tables: Tables): void {
  for (const m of activeMonths(a)) {
    const lambda = 0.17 * Math.exp(-0.5 * a.health) * ticketFactor(a.symptomatic ? m.daysToLeave : null);
    const count = poisson(rng, lambda);
    for (let n = 0; n < count; n++) {
      const opened = randomMoment(rng, m.lo, m.hi);
      // Only tickets from the last 30 days can still be open. Older ones were closed days later.
      const recent = opened > addDays(END, -30);
      let closed: Date | null = addDays(opened, expo(rng, 4));
      if (recent && rng() < 0.3) closed = null;
      else if (closed > END) closed = recent ? null : END;
      if (rng() < 0.003) closed = addDays(opened, -1); // impossible value in the source
      // Zendesk always records a requester: mostly company contacts, sometimes a personal address.
      const email =
        rng() < 0.95
          ? choice(rng, people).email
          : `${choice(rng, FIRST).toLowerCase()}@${choice(rng, PERSONAL)}`;
      tables.zd_tickets.push({
        ticket_id: `zd${hex(rng, 10)}`,
        org_id: a.orgId,
        org_name: noisyName(rng, a.company),
        requester_email: email,
        opened_at: stamp(opened),
        closed_at: closed ? stamp(closed) : "",
        reopen_count: poisson(rng, 0.3),
        priority: choice(rng, PRIORITIES),
        ingested_at: stamp(ingestedAt(rng, opened)),
      });
    }
  }
}

function emitBilling(rng: Rng, a: Account, people: Contact[], tables: Tables): void {
  const customerRef = `cus_${Array.from({ length: 14 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(rng() * 36)]).join("")}`;
  const roll = rng();
  let billingEmail: string;
  if (roll < 0.6) billingEmail = `billing@${a.domain}`;
  else if (roll < 0.95) billingEmail = choice(rng, people).email;
  else billingEmail = `${choice(rng, FIRST).toLowerCase()}${choice(rng, LAST).toLowerCase()}@${choice(rng, PERSONAL)}`;

  const left = a.leftDate;
  const step = BILLING_STEP[a.cycle];
  // Downgrades are decided first, so invoices after them can show the lower amount.
  let downgradeAt: Date | null = null;
  if (left) {
    const lo = addDays(left, -120) > START ? addDays(left, -120) : START;
    const hi = addDays(left, -1) < END ? addDays(left, -1) : END;
    if (a.symptomatic && hi >= lo && rng() < 0.25) downgradeAt = randomMoment(rng, lo, hi);
  } else {
    const lo = a.start > START ? a.start : START;
    const pDown = a.health < -1 ? 0.15 : 0.05;
    if (lo <= END && rng() < pDown) downgradeAt = randomMoment(rng, lo, END);
  }

  for (let k = 0; ; k++) {
    const d = addDays(a.start, k * step);
    if (d > END) break;
    if (d < START) continue;
    // Nothing is billed while a customer is away. The churn invoice itself is still issued.
    const away = !!left && d > left && (!a.returnedOn || d < a.returnedOn);
    if (away) continue;
    if (left && a.leaveType === "mid_contract" && d.getTime() === left.getTime()) continue;

    const churnInvoice = !!left && d.getTime() === left.getTime() && a.leaveType === "renewal";
    let status = "paid";
    let attempts = 1;
    let paidAt: Date | null = addDays(d, randInt(rng, 0, 25));
    let viewed: Date | null = rng() < 0.9 ? addDays(d, randInt(rng, 0, 10)) : null;
    if (churnInvoice) {
      const pick = rng();
      paidAt = null;
      if (pick < 0.5) {
        // Never attempted: the ambiguous case.
        status = "open";
        attempts = 0;
        if (rng() >= 0.3) viewed = null;
      } else if (pick < 0.85) {
        // Attempted and failed: a card problem, not intent.
        status = "failed";
        attempts = randInt(rng, 1, 3);
      } else {
        status = "void";
      }
    } else if (d > addDays(END, -30) && rng() < 0.05) {
      // Ordinary card failure for a customer who stays: the card-update reminder case, not a departure.
      status = "failed";
      attempts = 1;
      paidAt = null;
    } else if (rng() < 0.06) {
      // Card declined, paid on retry: common among customers who stay.
      attempts = randInt(rng, 2, 3);
      paidAt = addDays(d, randInt(rng, 1, 10));
    } else if (rng() < 0.05) {
      paidAt = addDays(d, randInt(rng, 31, 60)); // late payer: paid after the 30-day due date
    }

    tables.stripe_invoices.push({
      invoice_id: `in_${hex(rng, 10)}`,
      org_id: a.orgId,
      customer_ref: customerRef,
      billing_email: billingEmail,
      amount: Math.round(a.value * AMOUNT_FACTOR[a.cycle] * (downgradeAt && d >= downgradeAt ? 0.7 : 1) * 100) / 100,
      due_date: dateOnly(addDays(d, 30)),
      status,
      attempt_count: attempts,
      sent_at: stamp(addDays(d, -randInt(rng, 0, 7))),
      viewed_at: viewed ? stamp(viewed) : "",
      paid_at: paidAt ? stamp(paidAt) : "",
    });
  }

  const subEvent = (eventType: string, when: Date): void => {
    const at = new Date(when.getTime() + 12 * 3_600_000); // noon
    tables.stripe_subscription_events.push({
      event_id: `se${hex(rng, 10)}`,
      org_id: a.orgId,
      customer_ref: customerRef,
      event_type: eventType,
      event_time: stamp(at),
      ingested_at: stamp(ingestedAt(rng, at)),
    });
  };

  if (left && a.leaveType === "renewal" && a.symptomatic && rng() < 0.6) {
    // A warning before the renewal.
    const when = addDays(left, -randInt(rng, 20, 60));
    if (when >= START && when <= END) subEvent("cancel_at_renewal", when);
  }
  if (left && a.leaveType === "mid_contract" && left <= END) subEvent("cancelled", left);
  if (downgradeAt) subEvent("downgraded", downgradeAt);
  if (a.returnedOn) subEvent("reactivated", a.returnedOn);
}

/**
 * Gmail, metadata only: who, when, which way, and how long a reply took. No message content is
 * generated or stored. Using even metadata needs the business to confirm the legal basis first.
 */
function emitGmail(rng: Rng, a: Account, people: Contact[], tables: Tables): void {
  for (const m of activeMonths(a)) {
    const atRisk = a.symptomatic && m.daysToLeave !== null && m.daysToLeave <= 180;
    // A champion who has left, or gone quiet before a leave, stops replying from their address.
    const quiet = a.championGone && m.daysToLeave !== null && m.daysToLeave <= 180;
    const replyers = quiet && people.length > 1 ? people.slice(1) : people;

    for (let n = 0; n < poisson(rng, 0.03); n++) {
      const sent = randomMoment(rng, m.lo, m.hi);
      const threadId = `th${hex(rng, 10)}`;
      tables.gmail_messages.push({
        message_id: `gm${hex(rng, 10)}`,
        org_id: a.orgId,
        contact_id: choice(rng, people).contactId,
        counterpart_domain: a.domain,
        direction: "outbound",
        sent_at: stamp(sent),
        ingested_at: stamp(ingestedAt(rng, sent)),
        thread_id: threadId,
        reply_latency_hours: "",
      });
      if (rng() < (atRisk ? 0.3 : 0.7)) {
        const latency = expo(rng, 30) * (atRisk ? 3 : 1);
        const replied = new Date(sent.getTime() + latency * 3_600_000);
        if (replied.getTime() <= END.getTime() + DAY_MS) {
          tables.gmail_messages.push({
            message_id: `gm${hex(rng, 10)}`,
            org_id: a.orgId,
            contact_id: choice(rng, replyers).contactId,
            counterpart_domain: a.domain,
            direction: "inbound",
            sent_at: stamp(replied),
            ingested_at: stamp(ingestedAt(rng, replied)),
            thread_id: threadId,
            reply_latency_hours: Math.round(latency * 10) / 10,
          });
        }
      }
    }

    // Unprompted messages from the customer: questions, complaints, renewal talk.
    for (let n = 0; n < poisson(rng, atRisk ? 0.01 : 0.015); n++) {
      const sent = randomMoment(rng, m.lo, m.hi);
      tables.gmail_messages.push({
        message_id: `gm${hex(rng, 10)}`,
        org_id: a.orgId,
        contact_id: choice(rng, replyers).contactId,
        counterpart_domain: a.domain,
        direction: "inbound",
        sent_at: stamp(sent),
        ingested_at: stamp(ingestedAt(rng, sent)),
        thread_id: `th${hex(rng, 10)}`,
        reply_latency_hours: "",
      });
    }
  }
}

// ---------- truth, output, checks ----------

type Tables = Record<(typeof RAW_FILES)[number], Row[]>;

function truthRow(a: Account): Row {
  const left = a.leftDate;
  return {
    customer_id: a.customerId,
    org_id: a.orgId,
    sf_id: a.sfId,
    health: Math.round(a.health * 1000) / 1000,
    champion_gone: a.championGone,
    budget_cut: a.budgetCut,
    cycle: a.cycle,
    leave_type: a.leaveType,
    symptomatic: a.symptomatic,
    left_date: left ? dateOnly(left) : "",
    left_by_end: !!left && left <= END,
    returned_on: a.returnedOn ? dateOnly(a.returnedOn) : "",
    next_renewal: dateOnly(nextRenewal(a.start, a.term)),
  };
}

function toCsv(rows: Row[]): string {
  const first = rows[0];
  if (!first) throw new Error("cannot write an empty table");
  const columns = Object.keys(first);
  const escape = (v: string | number | boolean): string => {
    const text = String(v);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((c) => escape(row[c] ?? "")).join(","));
  return `${lines.join("\n")}\n`;
}

function parseCsv(text: string): Record<string, string>[] {
  const [headerLine, ...lines] = text.trim().split("\n");
  const headers = (headerLine ?? "").split(",");
  return lines.map((line) => {
    const values = line.split(",");
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ""]));
  });
}

function auc(scores: number[], labels: boolean[]): { auc: number; positives: number } {
  // Probability a random leaver scores higher than a random stayer.
  const pos = scores.filter((_, i) => labels[i]);
  const neg = scores.filter((_, i) => !labels[i]);
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return { auc: wins / (pos.length * neg.length), positives: pos.length };
}

/** As-of test: what the pipeline could know on T, predicting leaving in the next 90 days. */
function asOfSignalCheck(rawDir: string, truthDir: string): void {
  const asOf = "2026-06-15 00:00"; // data received by this time only
  const asOfDate = "2026-06-15";
  const horizon = "2026-09-13";
  const truth = parseCsv(readFileSync(join(truthDir, "ground_truth.csv"), "utf8"));
  const sfRows = parseCsv(readFileSync(join(rawDir, "sf_accounts.csv"), "utf8"));
  const domainToSf = new Map(sfRows.filter((r) => r["email_domain"]).map((r) => [r["email_domain"] as string, r["sf_id"] as string]));
  const usageNow = new Map<string, number>();
  const usagePrior = new Map<string, number>();
  for (const e of parseCsv(readFileSync(join(rawDir, "product_events.csv"), "utf8"))) {
    if (e["ingested_at"] !== undefined && e["ingested_at"] > asOf) continue;
    const sfId = domainToSf.get(e["account_domain"] ?? "");
    if (!sfId) continue;
    const t = e["event_time"] ?? "";
    if (t > asOf) continue;
    const dayAge = daysBetween(new Date(t.slice(0, 10)), new Date(asOfDate));
    if (dayAge >= 0 && dayAge < 90) usageNow.set(sfId, (usageNow.get(sfId) ?? 0) + 1);
    else if (dayAge >= 90 && dayAge < 180) usagePrior.set(sfId, (usagePrior.get(sfId) ?? 0) + 1);
  }

  const scores: number[] = [];
  const labels: boolean[] = [];
  for (const t of truth) {
    const left = t["left_date"] ?? "";
    if (left !== "" && left <= asOfDate) continue; // already gone: not in this population
    labels.push(left !== "" && left > asOfDate && left <= horizon);
    const now = usageNow.get(t["sf_id"] ?? "") ?? 0;
    const prior = usagePrior.get(t["sf_id"] ?? "") ?? 0;
    scores.push(prior - now); // larger drop = riskier
  }
  const result = auc(scores, labels);
  const rate = result.positives / labels.length;
  console.log(
    `  as-of usage-drop AUC: ${result.auc.toFixed(3)} (leavers in next 90 days: ${result.positives}, ${(rate * 100).toFixed(1)}%)`,
  );
}

function runChecks(tables: Tables, truth: Row[], rawDir: string, truthDir: string): void {
  const leftByEnd = truth.filter((t) => t["left_by_end"] === true).length;
  const rate = leftByEnd / truth.length;
  const missingRenewal = tables.sf_accounts.filter((r) => r["renewal_date"] === "").length / tables.sf_accounts.length;
  const badTickets = tables.zd_tickets.filter((r) => r["closed_at"] !== "" && String(r["closed_at"]) < String(r["opened_at"])).length;
  const replays = tables.product_events.length - new Set(tables.product_events.map((r) => r["event_id"])).size;

  const assertTrue = (ok: boolean, message: string): void => {
    if (!ok) throw new Error(`check failed: ${message}`);
  };
  assertTrue(tables.product_events.length >= 80_000 && tables.product_events.length <= 250_000, `product events ${tables.product_events.length}`);
  assertTrue(rate >= 0.05 && rate <= 0.25, `leave rate ${rate.toFixed(3)}`);
  assertTrue(missingRenewal >= 0.01 && missingRenewal <= 0.06, `missing renewal share ${missingRenewal.toFixed(3)}`);
  assertTrue(badTickets > 0, "no impossible ticket dates generated");
  assertTrue(replays > 0, "no replayed events generated");

  for (const name of RAW_FILES) {
    const header = readFileSync(join(rawDir, `${name}.csv`), "utf8").split("\n")[0] ?? "";
    for (const leak of ["health", "champion_gone", "budget_cut", "left_by_end", "leave_type"]) {
      assertTrue(!header.split(",").includes(leak), `truth field "${leak}" leaked into ${name}.csv`);
    }
  }

  console.log("checks passed");
  console.log(`  leave rate (left by today): ${(rate * 100).toFixed(1)}% (${leftByEnd} of ${truth.length})`);
  console.log(`  left after today (future renewals): ${truth.filter((t) => t["left_date"] !== "" && t["left_by_end"] !== true).length}`);
  console.log(`  missing renewal dates: ${(missingRenewal * 100).toFixed(1)}%`);
  console.log(`  impossible ticket dates: ${badTickets}`);
  console.log(`  replayed product events: ${replays}`);
  asOfSignalCheck(rawDir, truthDir);
}

// ---------- main ----------

function argValue(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  const raw = i >= 0 ? process.argv[i + 1] : undefined;
  return raw === undefined ? fallback : Number(raw);
}

function main(): void {
  const accountsWanted = argValue("--accounts", 5000);
  const seed = argValue("--seed", 42);
  const rng = mulberry32(seed);

  // Compiled file lives in dist/gen/, so the project root is two levels up.
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const rawDir = join(root, "data", "raw");
  const truthDir = join(root, "data", "truth");

  const tables: Tables = {
    sf_accounts: [],
    sf_contacts: [],
    zd_tickets: [],
    product_events: [],
    stripe_invoices: [],
    stripe_subscription_events: [],
    gmail_messages: [],
  };
  const truth: Row[] = [];
  const usedDomains = new Set<string>();
  let index = 0;
  let skipped = 0;

  while (truth.length < accountsWanted) {
    const account = makeAccount(rng, index++, usedDomains);
    if (!account) {
      skipped++;
      continue;
    }
    const people = emitContacts(rng, account, tables);
    emitSalesforceAccount(rng, account, tables);
    emitUsage(rng, account, tables);
    emitTickets(rng, account, people, tables);
    emitBilling(rng, account, people, tables);
    emitGmail(rng, account, people, tables);
    truth.push(truthRow(account));
  }

  for (const name of DATA_FILES_WITH_SHUFFLE) shuffle(rng, tables[name as keyof Tables]); // out of order

  mkdirSync(rawDir, { recursive: true });
  mkdirSync(truthDir, { recursive: true });
  for (const name of RAW_FILES) writeFileSync(join(rawDir, `${name}.csv`), toCsv(tables[name]));
  writeFileSync(join(truthDir, "ground_truth.csv"), toCsv(truth));

  console.log(`accounts: ${truth.length} (skipped ${skipped} that left before ${dateOnly(START)})`);
  for (const name of RAW_FILES) console.log(`  ${name}: ${tables[name].length} rows`);
  if (process.argv.includes("--check")) runChecks(tables, truth, rawDir, truthDir);
}

main();
