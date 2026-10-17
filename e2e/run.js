/**
 * End-to-end checks through a real browser, the way a reviewer would use the app.
 *
 *   BASE_URL=http://localhost:3300 DEMO_ACCESS_CODE=... node e2e/run.js      # full run (writes one call record)
 *   BASE_URL=https://...           DEMO_ACCESS_CODE=... node e2e/run.js --read-only
 *
 * Every check prints PASS or FAIL. Screenshots go to docs/screenshots/e2e/.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const BASE = (process.env["BASE_URL"] ?? "http://localhost:3300").replace(/\/+$/, "");
const CODE = process.env["DEMO_ACCESS_CODE"] ?? "";
const READ_ONLY = process.argv.includes("--read-only");
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "screenshots", "e2e");
mkdirSync(SHOTS, { recursive: true });
const ALLOWED_CONSOLE = ["favicon.ico"]; // browsers request this; not an app error
const VISIBLE_TIMEOUT = 10_000;

const results = []; // { name, ok, detail }
const consoleErrors = [];

class CheckFailed extends Error {}
const fail = (message) => {
  throw new CheckFailed(message);
};

async function check(name, fn) {
  try {
    const detail = (await fn()) ?? "";
    results.push({ name, ok: true, detail });
    console.log(`  PASS  ${name}${detail ? `  [${detail}]` : ""}`);
  } catch (error) {
    // A crash in one check must not hide the others, so every error is recorded and the run goes on.
    const message = error instanceof CheckFailed ? error.message : (String(error.message ?? error).split("\n")[0] || error.name);
    results.push({ name, ok: false, detail: message });
    console.log(`  FAIL  ${name}: ${message}`);
  }
}

const money = (text) => {
  const digits = text.replace(/[^0-9.]/g, "");
  return digits ? Number(digits) : 0;
};

/** Waits for the element to be visible; throws on timeout, which fails the check. */
async function expectVisible(locator, timeout = VISIBLE_TIMEOUT) {
  await locator.waitFor({ state: "visible", timeout });
}

async function signIn(page, who, code) {
  await page.goto(`${BASE}/login`);
  await page.selectOption("select[name=who]", who);
  if ((await page.locator("input[name=code]").count()) > 0) {
    await page.fill("input[name=code]", code ?? CODE);
  }
  await page.click("button:has-text('Sign in')");
  await page.waitForLoadState();
}

/** Text of every cell in every body row of the nth table on the page. */
function rowCells(page, tableIndex = 0) {
  return page
    .locator("table")
    .nth(tableIndex)
    .locator("tbody tr")
    .evaluateAll((rows) => rows.map((tr) => [...tr.querySelectorAll("td")].map((td) => td.innerText.trim())));
}

const listRows = (page) => rowCells(page, 0);

/** Record IDs from the first table's links. Compare IDs, not names: different companies can share a name. */
async function listIds(page) {
  const hrefs = await page
    .locator("table")
    .first()
    .locator("tbody tr a")
    .evaluateAll((els) => els.map((e) => e.getAttribute("href")));
  return new Set(hrefs.filter(Boolean).map((h) => h.split("/").pop()));
}

const noSideScroll = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

async function run(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" && !ALLOWED_CONSOLE.some((s) => m.text().includes(s))) consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(e.message));
  console.log(`Testing ${BASE} (${READ_ONLY ? "read-only" : "full"})`);

  // ---------- access gate ----------
  console.log("\nAccess gate");

  await check("sign-in page lists CSMs", async () => {
    await page.goto(`${BASE}/login`);
    const n = await page.locator("select[name=who] option").count();
    if (n < 2) fail(`only ${n} CSM options`);
    return `${n} CSMs to choose from`;
  });

  await check("sign-in page asks for the demo code", async () => {
    await page.goto(`${BASE}/login`);
    const fields = await page.locator("input[name=code]").count();
    if (CODE && fields !== 1) fail("demo code is configured but the sign-in page has no code field");
    return CODE ? "code field present" : "no demo code configured";
  });

  await check("wrong demo code is refused", async () => {
    if (!CODE) return "skipped: no demo code configured";
    const first = await page.locator("select[name=who] option").first().getAttribute("value");
    await signIn(page, first ?? "", "not-the-code");
    if (!page.url().includes("/login")) fail(`wrong code got through to ${page.url()}`);
    return "stayed on sign-in";
  });

  await check("visiting the list without signing in redirects", async () => {
    await ctx.clearCookies();
    await page.goto(`${BASE}/`);
    if (!page.url().endsWith("/login")) fail(`went to ${page.url()}`);
    return "redirected to sign-in";
  });

  // ---------- CSM list ----------
  console.log("\nCSM list (org_a, CSM1)");
  await signIn(page, "org_a|org_a-CSM1");

  await check("signed-in CSM sees their list", async () => {
    await expectVisible(page.getByRole("heading", { name: "Renewals to work this week" }));
    return "heading visible";
  });

  await check("header shows the model, the scoring date and the run", async () => {
    await expectVisible(page.getByText(/model logit-/i));
    return "visible";
  });

  const rows = await listRows(page);

  await check("this week's calls: at most 15, at least one", async () => {
    if (rows.length === 0) fail("no calls listed for this CSM");
    if (rows.length > 15) fail(`${rows.length} calls shown, cap is 15`);
    return `${rows.length} calls`;
  });

  await check("calls sorted by money at risk, highest first", async () => {
    const values = rows.map((r) => money(r[3]));
    const sorted = [...values].sort((a, b) => b - a);
    if (values.some((v, i) => v !== sorted[i])) fail(`not sorted by money at risk: ${values.slice(0, 6)}`);
    return `${values.length} rows, highest ${(values[0] ?? 0).toLocaleString("en-US")}`;
  });

  await check("every call row has chance, money and renewal date", async () => {
    const bad = rows.filter((r) => !/\d+\.\d%/.test(r[2]) || !r[3].includes("$") || !/\d{4}-\d{2}-\d{2}/.test(r[4]));
    if (bad.length) fail(`incomplete rows: ${bad.slice(0, 3).map((r) => r[1])}`);
    return "chance, money and renewal on every row";
  });

  await check("no internal feature names on screen", async () => {
    const text = await page.locator("body").innerText();
    const leaked = text.match(/usage_now|usage_prior|usage_log|usage_drop|days_to_renewal|inactive_contact|tenure_days|log_contract/g);
    if (leaked) fail(`internal feature names shown: ${[...new Set(leaked)].sort()}`);
    return "plain-English reasons only";
  });

  await check("unscored accounts have their own section", async () => {
    if ((await page.getByRole("heading", { name: /Not scored/ }).count()) === 0) fail("no 'Not scored' section");
    return "section present";
  });

  await page.screenshot({ path: join(SHOTS, "01-list-desktop.png") });

  // ---------- account trace ----------
  console.log("\nAccount trace");
  if (rows.length === 0) fail("no account to open");
  const href = await page.locator("table").first().locator("tbody tr").first().locator("a").getAttribute("href");
  await page.goto(`${BASE}${href}`);

  await check("account page shows chance of leaving and money at risk", async () => {
    await expectVisible(page.getByText(/Chance of leaving in 90 days/));
    return "visible";
  });

  await check("every model input is listed with its record IDs", async () => {
    const count = await page.locator("h2:has-text('Why this score') ~ div table tbody tr").count();
    if (count < 10) fail(`only ${count} reason rows, expected one per input`);
    return `${count} inputs listed`;
  });

  await check("the check line recomputes the stored chance", async () => {
    const body = await page.locator("body").innerText();
    const m = body.match(/chance (\d+\.\d)%\s*\(stored (\d+\.\d)%\)/);
    if (!m) fail("no check line on the page");
    if (m[1] !== m[2]) fail(`recomputed ${m[1]}% but stored ${m[2]}%`);
    return `${m[1]}% recomputed = stored`;
  });

  await check("trace shows run, data date and model", async () => {
    await expectVisible(page.getByText(/Run [0-9a-f-]+ · data as of/));
    return "visible";
  });

  await page.screenshot({ path: join(SHOTS, "02-account-trace.png"), fullPage: true });

  if (!READ_ONLY) {
    await check("'I contacted' records a call on the account", async () => {
      await page.click("button:has-text('I contacted this customer today')");
      await page.waitForLoadState();
      await expectVisible(page.getByText(/Last contact/));
      return "call recorded and shown";
    });
  }

  // ---------- isolation through the browser ----------
  console.log("\nIsolation");

  await check("another org's account URL shows Not found", async () => {
    // Find an org_b account from org_b's own list, then try to open it as org_a.
    await signIn(page, "org_b|org_b-CSM1");
    const other = (await listRows(page)).length
      ? await page.locator("table").first().locator("tbody tr").first().locator("a").getAttribute("href")
      : null;
    if (!other) fail("could not find an org_b account to test with");
    await signIn(page, "org_a|org_a-CSM1");
    await page.goto(`${BASE}${other}`);
    const body = await page.locator("body").innerText();
    if (!body.includes("Not found")) fail("org_a session could open an org_b account");
    const id = other.split("/").pop();
    if (body.includes(id)) fail("the page leaked the other account's ID");
    // The browser logs the deliberate 404 as a console error. It is expected here, so drop it.
    consoleErrors.length = 0;
    return `${id} refused`;
  });

  await check("two CSMs in the same org do not see each other's accounts", async () => {
    await signIn(page, "org_a|org_a-CSM2");
    const colleague = await listIds(page);
    await signIn(page, "org_a|org_a-CSM1");
    const mine = await listIds(page);
    const overlap = [...mine].filter((id) => colleague.has(id));
    if (overlap.length) fail(`same account records on two CSMs' lists: ${overlap.slice(0, 3).sort()}`);
    return `${mine.size} and ${colleague.size} records, no overlap`;
  });

  // ---------- run log and sign-out ----------
  console.log("\nRun log and sign-out");
  await signIn(page, "org_a|org_a-CSM1");

  await check("run log lists runs", async () => {
    await page.goto(`${BASE}/runs`);
    await expectVisible(page.getByRole("heading", { name: "Run log" }));
    const n = await page.locator("table tbody tr").count();
    if (n === 0) fail("no runs listed");
    return `${n} runs`;
  });
  await page.screenshot({ path: join(SHOTS, "03-run-log.png"), fullPage: true });

  await check("sign-out ends the session", async () => {
    await page.click("button:has-text('Sign out')");
    await page.waitForLoadState();
    await page.goto(`${BASE}/`);
    if (!page.url().endsWith("/login")) fail(`still signed in at ${page.url()}`);
    return "back at sign-in";
  });

  // ---------- layout ----------
  console.log("\nLayout");
  await signIn(page, "org_a|org_a-CSM1");

  await check("no sideways scroll on desktop", async () => {
    if (await noSideScroll(page)) fail("page scrolls sideways on desktop");
    return "fits 1280px";
  });

  const phone = await ctx.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await signIn(phone, "org_a|org_a-CSM1");

  await check("no sideways scroll on a phone", async () => {
    if (await noSideScroll(phone)) fail("page scrolls sideways at 390px");
    return "fits 390px";
  });

  await check("money at risk stays visible on a phone", async () => {
    const col = phone.getByRole("columnheader", { name: /Money at risk/ }).first();
    if (!(await col.isVisible())) fail("money at risk column hidden on a phone");
    const box = await col.boundingBox();
    // Visible in the page is not enough: the column must sit inside the phone screen, not off to the right.
    if (!box || box.x + box.width > 390) fail(`money at risk column sits off-screen: ${JSON.stringify(box)}`);
    return "money at risk on screen at 390px";
  });
  await phone.screenshot({ path: join(SHOTS, "04-list-phone.png") });
  await phone.close();

  const dark = await ctx.newPage();
  await dark.emulateMedia({ colorScheme: "dark" });
  await signIn(dark, "org_a|org_a-CSM1");

  await check("dark mode uses a dark background", async () => {
    const bg = await dark.evaluate(() => getComputedStyle(document.body).backgroundColor);
    if (bg === "rgb(255, 255, 255)" || bg === "rgba(0, 0, 0, 0)") fail(`dark mode background is ${bg}`);
    return `background ${bg}`;
  });
  await dark.screenshot({ path: join(SHOTS, "05-list-dark.png") });
  await dark.close();

  await check("no browser console errors during the run", async () => {
    if (consoleErrors.length) fail(`${consoleErrors.length} error(s): ${consoleErrors.slice(0, 2).join(" | ")}`);
    return "no errors";
  });
  await ctx.close();
}

async function main() {
  // CHROME_PATH lets a machine without the bundled Playwright browser use an installed Chrome.
  const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || undefined });
  try {
    await run(browser);
  } finally {
    await browser.close();
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${passed} passed, ${failed.length} failed, ${results.length} total`);
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
