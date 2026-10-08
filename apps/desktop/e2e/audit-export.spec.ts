import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const fixture = (sequence: number, type = "transaction.created") => ({
  id: `synthetic-event-${sequence}`,
  transaction_id: "synthetic-transaction",
  sequence,
  event_type: type,
  causal_parent: null,
  payload: { token: "[REDACTED]", description: "Synthetic λ evidence" },
  previous_hash: "b".repeat(64),
  hash: "c".repeat(64),
  recorded_at: "2026-10-08T09:00:00Z",
});

test("visible audit downloads retain exact rows, filter and partial-window context", async ({
  page,
  baseURL,
}, testInfo) => {
  const rows = [fixture(20, "transaction.committed"), fixture(19)];
  const requests: string[] = [];
  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    requests.push(`${route.request().method()} ${url.pathname}`);
    let body: unknown;
    if (url.pathname.endsWith("/health"))
      body = {
        status: "ok",
        api_version: "v1",
        protocol_version: "veyra.protocol/v1",
      };
    else if (url.pathname.endsWith("/transactions/page"))
      body = { items: [], next_cursor: null };
    else if (url.pathname.endsWith("/audit/events/page"))
      body = { items: rows, next_cursor: "synthetic-older-page" };
    else if (url.pathname.endsWith("/audit/verify"))
      body = {
        valid: true,
        events_checked: 20,
        first_invalid_sequence: null,
        message: "Synthetic journal verification",
      };
    else throw new Error(`Unexpected request ${url.pathname}`);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.addInitScript((apiUrl) => {
    localStorage.setItem("veyra.apiUrl", apiUrl);
    localStorage.setItem("veyra.token", `vyr_${"a".repeat(64)}`);
    localStorage.setItem("veyra.theme", "dark");
  }, new URL("/v1/", baseURL).toString());
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: /^Audit / }).click();
  const button = page.getByRole("button", { name: "Export visible JSON" });
  await expect(button).toBeEnabled();
  await page.getByRole("searchbox").fill("COMMITTED");
  await expect(page.getByText("1 visible of 2 loaded events")).toBeVisible();
  const count = requests.length;
  await button.focus();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.keyboard.press("Enter"),
  ]);
  expect(download.suggestedFilename()).toMatch(
    /^veyra-audit-view-[\dTZ-]+\.json$/,
  );
  const data = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(data.events).toEqual([rows[0]]);
  expect(data.filter.query).toBe("COMMITTED");
  expect(data.window).toMatchObject({
    loaded_event_count: 2,
    visible_event_count: 1,
    has_more_older_events: true,
  });
  expect(data.notice).toContain("not a complete audit archive");
  expect(requests).toHaveLength(count);
  expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("audit-export-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(button).toBeVisible();
  expect(
    await page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("audit-export-narrow.png"),
    fullPage: true,
  });
  await page.getByRole("searchbox").fill("missing");
  await expect(button).toBeDisabled();
  await page.getByRole("searchbox").fill("");
  const [again] = await Promise.all([
    page.waitForEvent("download"),
    button.click(),
  ]);
  expect(
    JSON.parse(await readFile((await again.path())!, "utf8")).events,
  ).toEqual(rows);
  await page.getByRole("button", { name: /^Transactions / }).click();
  await page.getByRole("button", { name: /^Audit / }).click();
  await expect(
    page.getByText("Download requested: 2 visible events."),
  ).toHaveCount(0);
});
