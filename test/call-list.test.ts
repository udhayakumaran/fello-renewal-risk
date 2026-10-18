import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, type Page } from "playwright";
import { callTable, HOW_LIST_WORKS, SEARCH_SCRIPT, SORT_SCRIPT } from "../src/web/server.js";

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
  await page.setContent(`<!doctype html><html><body><input id="account-search">${callTable(calls)}${callTable(watch)}${SORT_SCRIPT}${SEARCH_SCRIPT}</body></html>`);
  return { page, close: () => browser.close() };
}

const groupNames = (page: Page, group: number): Promise<string[]> =>
  page.locator("table.sortable").nth(group).locator("tbody td.account").allTextContents();

test("sorting one group never moves rows into another", { skip }, async () => {
  const { page, close } = await openPage();
  try {
    await page.locator("table.sortable").nth(0).locator("th", { hasText: "Money at risk" }).locator("button").click();
    assert.deepEqual(await groupNames(page, 0), ["Alpha", "Charlie", "Bravo"], "calls sort by money, highest first");

    await page.locator("table.sortable").nth(1).locator("th", { hasText: "Money at risk" }).locator("button").click();
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

test("how-it-works panel: 3 to 5 plain bullets, no jargon, no dashes, real numbers", () => {
  assert.ok(HOW_LIST_WORKS.length >= 3 && HOW_LIST_WORKS.length <= 5);
  const text = HOW_LIST_WORKS.map(([label, body]) => `${label} ${body}`).join(" ");
  for (const word of ["logistic", "model", "probab", "expected value", "feature", "training", "regression"]) {
    assert.ok(!text.toLowerCase().includes(word), `no "${word}" in the panel`);
  }
  assert.ok(!/[\u2013\u2014]/.test(text), "no en or em dashes");
  assert.ok(text.includes("15 accounts") && text.includes("14 days"), "numbers come from ranking.ts");
});
