import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, type Page } from "playwright";
import { callTable, HOW_LIST_WORKS, reasonSentence, SEARCH_SCRIPT, SORT_SCRIPT, TIP_CSS, TIP_SCRIPT } from "../src/web/server.js";

type Reason = Parameters<typeof reasonSentence>[0];

// Browser check for the call list. Needs a Chrome build: set CHROME_PATH (same as e2e/run.js).
const executablePath = process.env["CHROME_PATH"];
const skip = executablePath ? false : "CHROME_PATH not set";

// Same cell order as callRow in server.ts: rank, account, chance, money, renewal, why.
const row = (name: string, chance: number, money: number): string => `<tr>
  <td class="hide-sm"><span class="rank">1</span></td>
  <td class="account" data-sort="${name}">${name}</td>
  <td class="num" data-sort="${chance}">${chance}%</td>
  <td class="num" data-sort="${money}">${money}</td>
  <td class="date hide-sm" data-sort="10">Nov</td>
  <td class="why-col">x</td></tr>`;

// Watch list holds the bigger money, so a sort that crossed groups would move Delta into the calls.
const calls = [row("Alpha", 20, 500), row("Bravo", 50, 100), row("Charlie", 10, 300)];
const watch = [row("Delta", 90, 9000), row("Echo", 5, 50)];

async function openPage(): Promise<{ page: Page; close: () => Promise<void> }> {
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><head><style>${TIP_CSS}</style></head><body><input id="account-search">${callTable(calls)}${callTable(watch)}${SORT_SCRIPT}${TIP_SCRIPT}${SEARCH_SCRIPT}</body></html>`);
  return { page, close: () => browser.close() };
}

const groupNames = (page: Page, group: number): Promise<string[]> =>
  page.locator("table.sortable").nth(group).locator("tbody td.account").allTextContents();

test("sorting one group never moves rows into another", { skip }, async () => {
  const { page, close } = await openPage();
  try {
    await page.locator("table.sortable").nth(0).locator("th", { hasText: "Money at risk" }).locator("button.sort-btn").click();
    assert.deepEqual(await groupNames(page, 0), ["Alpha", "Charlie", "Bravo"], "calls sort by money, highest first");

    await page.locator("table.sortable").nth(1).locator("th", { hasText: "Money at risk" }).locator("button.sort-btn").click();
    assert.deepEqual(await groupNames(page, 1), ["Delta", "Echo"], "watch list sorts on its own");
    assert.deepEqual(await groupNames(page, 0), ["Alpha", "Charlie", "Bravo"], "calls unchanged by the watch list sort");
  } finally {
    await close();
  }
});

test("search filters each group on its own and says so when a group has no match", { skip }, async () => {
  const { page, close } = await openPage();
  try {
    await page.fill("#account-search", "delta");
    const callRows = page.locator("table.sortable").nth(0).locator("tbody tr");
    const watchRows = page.locator("table.sortable").nth(1).locator("tbody tr");
    assert.equal(await callRows.nth(0).isVisible(), false, "Alpha hidden in calls");
    assert.equal(await watchRows.nth(0).isVisible(), true, "Delta shown in watch list");
    assert.equal(await watchRows.nth(1).isVisible(), false, "Echo hidden in watch list");
    assert.equal(await page.locator("[data-no-match]").nth(0).isVisible(), true, "calls says no match");
    assert.equal(await page.locator("[data-no-match]").nth(1).isVisible(), false, "watch list has a match");

    await page.fill("#account-search", "");
    assert.equal(await callRows.nth(0).isVisible(), true, "clearing the search shows all calls again");
    assert.equal(await page.locator("[data-no-match]").nth(0).isVisible(), false);
  } finally {
    await close();
  }
});

test("header tooltip: tap opens it, a second tap or Escape closes it, and it is linked to its button", { skip }, async () => {
  const { page, close } = await openPage();
  try {
    const tipText = page.locator("[role=tooltip]", { hasText: "about 5 in 100" }).first();
    const trigger = page.locator("button.tip-btn[aria-label='About Chance of leaving']").first();
    assert.equal(await tipText.isVisible(), false, "hidden at rest");
    assert.equal(await trigger.getAttribute("aria-describedby"), await tipText.getAttribute("id"), "button is described by its tooltip");
    // Move the mouse away after each click so only the tap state decides, as on a phone.
    await trigger.click();
    await page.mouse.move(0, 0);
    assert.equal(await tipText.isVisible(), true, "tap opens it");
    await trigger.click();
    await page.mouse.move(0, 0);
    assert.equal(await tipText.isVisible(), false, "second tap closes it");
    await trigger.click();
    await page.mouse.move(0, 0);
    await page.keyboard.press("Escape");
    assert.equal(await tipText.isVisible(), false, "Escape closes it");
  } finally {
    await close();
  }
});

test("how-it-works panel: the approved eight bullets, no jargon, no dashes, real numbers", () => {
  assert.deepEqual(
    HOW_LIST_WORKS.map(([label]) => label),
    ["The percentage", "Why it's here", "Money at risk", "No contract value", "This week's calls", "Watch list", "Not scored", "Recently contacted"],
  );
  const text = HOW_LIST_WORKS.map(([label, body]) => `${label} ${body}`).join(" ");
  for (const word of ["logistic", "model", "probab", "expected value", "feature", "training", "regression"]) {
    assert.ok(!text.toLowerCase().includes(word), `no "${word}" in the panel`);
  }
  assert.ok(!/[\u2013\u2014]/.test(text), "no en or em dashes");
  assert.ok(text.includes("The 15 accounts") && text.includes("last 14 days"), "numbers come from ranking.ts");
});

test("reason tooltips: plain sentence with real values, in the approved form", () => {
  const reason = (feature: string, label: string, value: number): Reason => ({ feature, label, value, weight: 1, contribution: 1, sources: { ids: [], count: 0 } });
  assert.equal(
    reasonSentence(reason("tickets_open", "Support tickets still open", 9), 3),
    "This account has 9 open support tickets, while a typical customer has 3.",
  );
  assert.equal(reasonSentence(reason("tickets_open", "Support tickets still open", 1), 0), "This account has 1 open support ticket, while a typical customer has 0.");
  assert.equal(reasonSentence(reason("tickets_open", "Support tickets still open", 9), undefined), "This account has 9 open support tickets.");
  assert.equal(reasonSentence(reason("log_contract_value", "Contract value ($)", 0), 11), "This account has no contract value in the CRM, so it shows $0 at risk.");
});

test("tooltips: each trigger points at its text, and the ids are unique on the page", () => {
  const html = callTable([row("Alpha", 20, 500)]) + callTable([row("Bravo", 50, 100)]);
  const ids = [...html.matchAll(/id="(tip-\d+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, "ids unique");
  for (const id of ids) assert.ok(html.includes(`aria-describedby="${id}"`), `${id} has a trigger`);
  assert.ok(html.includes("If it shows 5%, about 5 in 100 customers like this one left at renewal."), "header tooltip text");
});
