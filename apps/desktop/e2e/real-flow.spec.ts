import { readFile } from "node:fs/promises";

import { expect, test, type Route } from "@playwright/test";

const tokenFile = process.env.VEYRA_E2E_TOKEN_FILE;

test("real local transaction is operable at desktop and narrow viewports", async ({
  page,
}, testInfo) => {
  test.skip(
    tokenFile === undefined,
    "set VEYRA_E2E_TOKEN_FILE to a running local instance token",
  );
  const token = (await readFile(tokenFile!, "utf8")).trim();
  await page.addInitScript(
    ({ apiUrl, localToken }) => {
      localStorage.setItem("veyra.apiUrl", apiUrl);
      localStorage.setItem("veyra.token", localToken);
      localStorage.setItem("veyra.theme", "dark");
    },
    {
      apiUrl: process.env.VEYRA_E2E_API_URL ?? "http://127.0.0.1:7843/v1/",
      localToken: token,
    },
  );

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "Make the next side effect inspectable.",
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Create transaction" }).click();
  await expect(
    page.getByRole("button", { name: "Review effects" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Review effects" }).click();
  await expect(
    page.getByRole("heading", { name: "Authorize this exact effect" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("approval-desktop.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 760, height: 900 });
  await expect(page.getByText("Exact resource scope")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("approval-narrow.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Grant approval" }).click();
  await expect(
    page.getByRole("button", { name: "Execute transaction" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Execute transaction" }).click();
  await expect(
    page.getByText("Committed", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText("Postconditions satisfied")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("committed-desktop.png"),
    fullPage: true,
  });

  // Interrupt only the bundle read; the transaction remains committed in the daemon.
  let bundleReads = 0;
  let recoveryMutations = 0;
  const countMutations = (request: import("@playwright/test").Request) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method()))
      recoveryMutations += 1;
  };
  page.on("request", countMutations);
  await page.route("**/transactions/*/bundle", async (route) => {
    bundleReads += 1;
    if (bundleReads === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "unavailable",
            message: "Temporary transaction read failure",
          },
        }),
      });
    } else {
      await route.continue();
    }
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Could not load transaction" }),
  ).toBeVisible();
  await expect(page.getByLabel("Loading transaction")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("read-error-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 760, height: 900 });
  await expect(
    page.getByRole("button", { name: "Retry transaction" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("read-error-narrow.png"),
    fullPage: true,
  });

  await page.getByRole("button", { name: /^Audit / }).click();
  await page.getByRole("button", { name: /^Transactions / }).click();
  const retry = page.getByRole("button", { name: "Retry transaction" });
  await expect(retry).toBeVisible();
  expect(bundleReads).toBe(1);
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Roll back" })).toBeVisible();
  await expect(page.getByText("Postconditions satisfied")).toBeVisible();
  await expect(retry).toHaveCount(0);
  expect(bundleReads).toBe(2);
  expect(recoveryMutations).toBe(0);
  await page.screenshot({
    path: testInfo.outputPath("read-recovered-narrow.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({
    path: testInfo.outputPath("read-recovered-desktop.png"),
    fullPage: true,
  });
  page.off("request", countMutations);

  await page.getByRole("button", { name: "Roll back" }).click();
  await expect(
    page.getByText("Rolled back", { exact: true }).first(),
  ).toBeVisible();
});

test("completed mutations refresh after navigating away and back during a pending read", async ({
  page,
}, testInfo) => {
  test.skip(
    tokenFile === undefined,
    "set VEYRA_E2E_TOKEN_FILE to a running local instance token",
  );
  const apiUrl = process.env.VEYRA_E2E_API_URL ?? "http://127.0.0.1:7843/v1/";
  const token = (await readFile(tokenFile!, "utf8")).trim();
  await page.addInitScript(
    ({ endpoint, localToken }) => {
      localStorage.setItem("veyra.apiUrl", endpoint);
      localStorage.setItem("veyra.token", localToken);
    },
    { endpoint: apiUrl, localToken: token },
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const seed = async () => {
    const url = new URL("demo/seed", apiUrl).href;
    const captured: { id?: string } = {};
    let posts = 0;
    const captureSeed = async (route: Route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      posts += 1;
      // APIResponse avoids Chromium's transient Network.getResponseBody lookup.
      const response = await route.fetch({ maxRetries: 0, maxRedirects: 0 });
      expect(response.status()).toBe(201);
      const result = await response.json();
      captured.id = result.submission.transaction.id as string;
      await route.fulfill({ response });
    };
    await page.route(url, captureSeed);
    try {
      await page.getByRole("button", { name: "Create transaction" }).click();
      await expect.poll(() => captured.id).toEqual(expect.any(String));
      const id = captured.id!;
      await expect(page.locator(".inspector-heading .eyebrow")).toContainText(
        `${id.slice(0, 8)}…${id.slice(-4)}`,
      );
      await expect(
        page.getByRole("button", { name: "Review effects" }),
      ).toBeEnabled();
      expect(posts).toBe(1);
      return id;
    } finally {
      await page.unroute(url, captureSeed);
    }
  };
  const otherId = await seed();
  const id = await seed();
  const shortId = (value: string) => `${value.slice(0, 8)}…${value.slice(-4)}`;
  const state = page.locator(".heading-meta .state-badge");

  const navigateDuringMutation = async (
    action: string,
    operation: string,
    expectedState: string,
  ) => {
    let releaseMutation!: () => void;
    let releaseRead!: () => void;
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let mutations = 0;
    let reads = 0;
    let snapshotReady = false;
    let oldReadDelivered!: () => void;
    const delivered = new Promise<void>((resolve) => {
      oldReadDelivered = resolve;
    });
    const mutationUrl = new URL(`transactions/${id}/${operation}`, apiUrl).href;
    const bundleUrl = new URL(`transactions/${id}/bundle`, apiUrl).href;
    await page.route(mutationUrl, async (route) => {
      mutations += 1;
      await mutationGate;
      await route.continue();
    });
    await page.route(bundleUrl, async (route) => {
      reads += 1;
      if (reads === 1) {
        // Capture the real daemon's old snapshot before allowing the mutation.
        const response = await route.fetch();
        snapshotReady = true;
        await readGate;
        await route.fulfill({ response });
        oldReadDelivered();
      } else {
        await route.continue();
      }
    });
    try {
      const control = page.getByRole("button", { name: action, exact: true });
      await control.focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => mutations).toBe(1);
      await page
        .getByRole("button")
        .filter({ has: page.getByText(shortId(otherId), { exact: true }) })
        .click();
      await expect(page.locator(".inspector-heading .eyebrow")).toContainText(
        shortId(otherId),
      );
      await page
        .getByRole("button")
        .filter({ has: page.getByText(shortId(id), { exact: true }) })
        .click();
      await expect.poll(() => snapshotReady).toBe(true);
      await expect(page.getByLabel("Loading transaction")).toBeVisible();
      releaseMutation();
      await expect.poll(() => reads).toBe(2);
      await expect(state).toHaveText(expectedState);
      await expect(page.getByRole("status")).toHaveCount(0);
      releaseRead();
      await delivered;
      await expect(state).toHaveText(expectedState);
      await expect(page.getByRole("alert")).toHaveCount(0);
      expect(mutations).toBe(1);
    } finally {
      releaseMutation();
      releaseRead();
      await page.unroute(mutationUrl);
      await page.unroute(bundleUrl);
    }
  };

  await navigateDuringMutation(
    "Review effects",
    "preview",
    "Awaiting approval",
  );
  await page.getByRole("button", { name: "Grant approval" }).click();
  await expect(
    page.getByRole("button", { name: "Execute transaction" }),
  ).toBeEnabled();
  await page.setViewportSize({ width: 760, height: 900 });
  await navigateDuringMutation("Execute transaction", "run", "Committed");
  await expect(page.getByRole("button", { name: "Roll back" })).toBeEnabled();
  await expect(page.getByText("Postconditions satisfied")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("navigation-committed-narrow.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await navigateDuringMutation("Roll back", "rollback", "Rolled back");
  await expect(page.getByRole("button", { name: "Roll back" })).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("navigation-rolled-back-desktop.png"),
    fullPage: true,
  });
});
