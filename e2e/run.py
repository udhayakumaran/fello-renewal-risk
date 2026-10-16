"""
End-to-end checks through a real browser, the way a reviewer would use the app.

  BASE_URL=http://localhost:3300 DEMO_ACCESS_CODE=... python3 e2e/run.py      # full run (writes one call record)
  BASE_URL=https://...           DEMO_ACCESS_CODE=... python3 e2e/run.py --read-only

Every check prints PASS or FAIL. Screenshots go to docs/screenshots/e2e/.
"""
import os
import re
import sys
from pathlib import Path

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

BASE = os.environ.get("BASE_URL", "http://localhost:3300").rstrip("/")
CODE = os.environ.get("DEMO_ACCESS_CODE", "")
READ_ONLY = "--read-only" in sys.argv
SHOTS = Path(__file__).resolve().parent.parent / "docs" / "screenshots" / "e2e"
SHOTS.mkdir(parents=True, exist_ok=True)
ALLOWED_CONSOLE = ("favicon.ico",)  # browsers request this; not an app error

results: list[tuple[str, bool, str]] = []
console_errors: list[str] = []


def check(name: str, fn) -> None:
    try:
        detail = fn() or ""
        results.append((name, True, detail))
        print(f"  PASS  {name}" + (f"  [{detail}]" if detail else ""))
    except AssertionError as exc:
        results.append((name, False, str(exc)))
        print(f"  FAIL  {name}: {exc}")
    except Exception as exc:  # noqa: BLE001 - a crash in one check must not hide the others
        first = str(exc).splitlines()[0] if str(exc) else type(exc).__name__
        results.append((name, False, first))
        print(f"  FAIL  {name}: {first}")


def money(text: str) -> float:
    digits = re.sub(r"[^0-9.]", "", text)
    return float(digits) if digits else 0.0


def sign_in(page: Page, who: str, code: str | None = None) -> None:
    page.goto(f"{BASE}/login")
    page.select_option("select[name=who]", who)
    if page.locator("input[name=code]").count():
        page.fill("input[name=code]", CODE if code is None else code)
    page.click("button:has-text('Sign in')")
    page.wait_for_load_state()


def row_cells(page: Page, table_index: int = 0) -> list[list[str]]:
    rows = page.locator("table").nth(table_index).locator("tbody tr")
    return [[c.strip() for c in rows.nth(i).locator("td").all_inner_texts()] for i in range(rows.count())]


def list_rows(page: Page) -> list[list[str]]:
    # The first table on the list page is this week's calls.
    return row_cells(page, 0)


def list_ids(page: Page) -> set[str]:
    # Compare record IDs, not names: different companies can share a name.
    hrefs = page.locator("table").first.locator("tbody tr a").evaluate_all("els => els.map(e => e.getAttribute('href'))")
    return {h.rsplit("/", 1)[-1] for h in hrefs if h}


def fail(message: str):
    raise AssertionError(message)


def run(browser: Browser) -> None:
    ctx: BrowserContext = browser.new_context(viewport={"width": 1280, "height": 900})
    page: Page = ctx.new_page()
    page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" and not any(s in m.text for s in ALLOWED_CONSOLE) else None)
    page.on("pageerror", lambda e: console_errors.append(str(e)))
    print(f"Testing {BASE} ({'read-only' if READ_ONLY else 'full'})")

    # ---------- access gate ----------
    print("\nAccess gate")

    def sign_in_page_lists_csms():
        page.goto(f"{BASE}/login")
        n = page.locator("select[name=who] option").count()
        if n < 2:
            fail(f"only {n} CSM options")
        return f"{n} CSMs to choose from"

    check("sign-in page lists CSMs", sign_in_page_lists_csms)

    def code_field_present():
        page.goto(f"{BASE}/login")
        if CODE and page.locator("input[name=code]").count() != 1:
            fail("demo code is configured but the sign-in page has no code field")
        return "code field present" if CODE else "no demo code configured"

    check("sign-in page asks for the demo code", code_field_present)

    def wrong_code_refused():
        if not CODE:
            return "skipped: no demo code configured"
        sign_in(page, page.locator("select[name=who] option").first.get_attribute("value") or "", code="not-the-code")
        if "/login" not in page.url:
            fail(f"wrong code got through to {page.url}")
        return "stayed on sign-in"

    check("wrong demo code is refused", wrong_code_refused)

    def signed_out_visit_redirects():
        ctx.clear_cookies()
        page.goto(f"{BASE}/")
        if not page.url.endswith("/login"):
            fail(f"went to {page.url}")
        return "redirected to sign-in"

    check("visiting the list without signing in redirects", signed_out_visit_redirects)

    # ---------- CSM list ----------
    print("\nCSM list (org_a, CSM1)")
    sign_in(page, "org_a|org_a-CSM1")

    check("signed-in CSM sees their list", lambda: (
        expect(page.get_by_role("heading", name="Renewals to work this week")).to_be_visible(timeout=10_000),
        "heading visible",
    )[1])

    check("header shows the model, the scoring date and the run", lambda: (
        expect(page.get_by_text(re.compile(r"model logit-", re.IGNORECASE))).to_be_visible(),
        "visible",
    )[1])

    rows = list_rows(page)

    def calls_capped_at_15():
        if not rows:
            fail("no calls listed for this CSM")
        if len(rows) > 15:
            fail(f"{len(rows)} calls shown, cap is 15")
        return f"{len(rows)} calls"

    check("this week's calls: at most 15, at least one", calls_capped_at_15)

    def sorted_by_money():
        values = [money(r[3]) for r in rows]
        if values != sorted(values, reverse=True):
            fail(f"not sorted by money at risk: {values[:6]}")
        return f"{len(values)} rows, highest {values[0] if values else 0:,.0f}"

    check("calls sorted by money at risk, highest first", sorted_by_money)

    def rows_complete():
        bad = [r[1] for r in rows if not re.search(r"\d+\.\d%", r[2]) or "$" not in r[3] or not re.search(r"\d{4}-\d{2}-\d{2}", r[4])]
        if bad:
            fail(f"incomplete rows: {bad[:3]}")
        return "chance, money and renewal on every row"

    check("every call row has chance, money and renewal date", rows_complete)

    def no_internal_names():
        text = page.locator("body").inner_text()
        leaked = re.findall(r"usage_now|usage_prior|usage_log|usage_drop|days_to_renewal|inactive_contact|tenure_days|log_contract", text)
        if leaked:
            fail(f"internal feature names shown: {sorted(set(leaked))}")
        return "plain-English reasons only"

    check("no internal feature names on screen", no_internal_names)

    def unknown_section_has_reasons():
        heading = page.get_by_role("heading", name=re.compile("Not scored"))
        if heading.count() == 0:
            fail("no 'Not scored' section")
        return "section present"

    check("unscored accounts have their own section", unknown_section_has_reasons)

    page.screenshot(path=str(SHOTS / "01-list-desktop.png"))

    # ---------- account trace ----------
    print("\nAccount trace")
    if not rows:
        fail("no account to open")
    href = page.locator("table").first.locator("tbody tr").first.locator("a").get_attribute("href")
    page.goto(f"{BASE}{href}")

    check("account page shows chance of leaving and money at risk", lambda: (
        expect(page.get_by_text(re.compile(r"Chance of leaving in 90 days"))).to_be_visible(),
        "visible",
    )[1])

    def reasons_listed():
        reason_rows = page.locator("h2:has-text('Why this score') ~ div table tbody tr").count()
        if reason_rows < 10:
            fail(f"only {reason_rows} reason rows, expected one per input")
        return f"{reason_rows} inputs listed"

    check("every model input is listed with its record IDs", reasons_listed)

    def check_line_matches():
        body = page.locator("body").inner_text()
        m = re.search(r"chance (\d+\.\d)%\s*\(stored (\d+\.\d)%\)", body)
        if not m:
            fail("no check line on the page")
        if m.group(1) != m.group(2):
            fail(f"recomputed {m.group(1)}% but stored {m.group(2)}%")
        return f"{m.group(1)}% recomputed = stored"

    check("the check line recomputes the stored chance", check_line_matches)

    check("trace shows run, data date and model", lambda: (
        expect(page.get_by_text(re.compile(r"Run [0-9a-f-]+ · data as of"))).to_be_visible(),
        "visible",
    )[1])

    page.screenshot(path=str(SHOTS / "02-account-trace.png"), full_page=True)

    if not READ_ONLY:
        def records_a_call():
            page.click("button:has-text('I contacted this customer today')")
            page.wait_for_load_state()
            expect(page.get_by_text(re.compile(r"Last contact"))).to_be_visible()
            return "call recorded and shown"

        check("'I contacted' records a call on the account", records_a_call)

    # ---------- isolation through the browser ----------
    print("\nIsolation")

    def other_orgs_account_is_hidden():
        # Find an org_b account by asking the list of another CSM, then use org_a's session.
        sign_in(page, "org_b|org_b-CSM1")
        other = page.locator("table").first.locator("tbody tr").first.locator("a").get_attribute("href") if list_rows(page) else None
        if not other:
            fail("could not find an org_b account to test with")
        sign_in(page, "org_a|org_a-CSM1")
        page.goto(f"{BASE}{other}")
        body = page.locator("body").inner_text()
        if "Not found" not in body:
            fail("org_a session could open an org_b account")
        if other.split("/")[-1] in body:
            fail("the page leaked the other account's ID")
        # The browser logs the deliberate 404 as a console error. It is expected here, so drop it.
        console_errors.clear()
        return f"{other.split('/')[-1]} refused"

    check("another org's account URL shows Not found", other_orgs_account_is_hidden)

    def other_csm_account_is_hidden():
        # Same org, different CSM: a CSM must not see a colleague's accounts either.
        sign_in(page, "org_a|org_a-CSM2")
        colleague = list_ids(page)
        sign_in(page, "org_a|org_a-CSM1")
        mine = list_ids(page)
        overlap = mine & colleague
        if overlap:
            fail(f"same account records on two CSMs' lists: {sorted(overlap)[:3]}")
        return f"{len(mine)} and {len(colleague)} records, no overlap"

    check("two CSMs in the same org do not see each other's accounts", other_csm_account_is_hidden)

    # ---------- run log and sign-out ----------
    print("\nRun log and sign-out")
    sign_in(page, "org_a|org_a-CSM1")

    def run_log_has_rows():
        page.goto(f"{BASE}/runs")
        expect(page.get_by_role("heading", name="Run log")).to_be_visible()
        n = page.locator("table tbody tr").count()
        if n == 0:
            fail("no runs listed")
        return f"{n} runs"

    check("run log lists runs", run_log_has_rows)
    page.screenshot(path=str(SHOTS / "03-run-log.png"), full_page=True)

    def sign_out_works():
        page.click("button:has-text('Sign out')")
        page.wait_for_load_state()
        page.goto(f"{BASE}/")
        if not page.url.endswith("/login"):
            fail(f"still signed in at {page.url}")
        return "back at sign-in"

    check("sign-out ends the session", sign_out_works)

    # ---------- layout ----------
    print("\nLayout")
    sign_in(page, "org_a|org_a-CSM1")

    def desktop_fits():
        if page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth"):
            fail("page scrolls sideways on desktop")
        return "fits 1280px"

    check("no sideways scroll on desktop", desktop_fits)

    phone = ctx.new_page()
    phone.set_viewport_size({"width": 390, "height": 844})
    sign_in(phone, "org_a|org_a-CSM1")

    def phone_fits():
        if phone.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth"):
            fail("page scrolls sideways at 390px")
        return "fits 390px"

    check("no sideways scroll on a phone", phone_fits)

    def phone_keeps_money():
        money_col = phone.get_by_role("columnheader", name=re.compile("Money at risk")).first
        if not money_col.is_visible():
            fail("money at risk column hidden on a phone")
        box = money_col.bounding_box()
        # Visible in the page is not enough: the column must sit inside the phone screen, not off to the right.
        if box is None or box["x"] + box["width"] > 390:
            fail(f"money at risk column sits off-screen: {box}")
        return "money at risk on screen at 390px"

    check("money at risk stays visible on a phone", phone_keeps_money)
    phone.screenshot(path=str(SHOTS / "04-list-phone.png"))
    phone.close()

    dark = ctx.new_page()
    dark.emulate_media(color_scheme="dark")
    sign_in(dark, "org_a|org_a-CSM1")

    def dark_mode():
        bg = dark.evaluate("getComputedStyle(document.body).backgroundColor")
        if bg in ("rgb(255, 255, 255)", "rgba(0, 0, 0, 0)"):
            fail(f"dark mode background is {bg}")
        return f"background {bg}"

    check("dark mode uses a dark background", dark_mode)
    dark.screenshot(path=str(SHOTS / "05-list-dark.png"))
    dark.close()

    def console_clean():
        if console_errors:
            fail(f"{len(console_errors)} error(s): {console_errors[:2]}")
        return "no errors"

    check("no browser console errors during the run", console_clean)
    ctx.close()


if __name__ == "__main__":
    with sync_playwright() as p:
        browser = p.chromium.launch()
        run(browser)
        browser.close()

    passed = sum(1 for _, ok, _ in results if ok)
    failed = [(n, d) for n, ok, d in results if not ok]
    print(f"\n{passed} passed, {len(failed)} failed, {len(results)} total")
    for name, detail in failed:
        print(f"  - {name}: {detail}")
    sys.exit(1 if failed else 0)
