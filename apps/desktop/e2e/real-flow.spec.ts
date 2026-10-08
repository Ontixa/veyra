import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { expect, test, type Request, type Route } from "@playwright/test";

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

test("confirmed execution and rollback survive secondary read failures without replay", async ({
  page,
}, testInfo) => {
  const tokenFile = process.env.VEYRA_E2E_TOKEN_FILE;
  test.skip(
    tokenFile === undefined,
    "set VEYRA_E2E_TOKEN_FILE to a running local instance token",
  );
  const apiUrl = process.env.VEYRA_E2E_API_URL ?? "http://127.0.0.1:7843/v1/";
  const token = (await readFile(tokenFile!, "utf8")).trim();
  // The CI daemon's workspace is beside its data directory. An external fixture
  // can explicitly select its workspace without changing that shared fixture.
  const workspace =
    process.env.VEYRA_E2E_WORKSPACE ??
    resolve(dirname(tokenFile!), "..", "workspace");
  await page.addInitScript(
    ({ endpoint, localToken }) => {
      localStorage.setItem("veyra.apiUrl", endpoint);
      localStorage.setItem("veyra.token", localToken);
    },
    { endpoint: apiUrl, localToken: token },
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const content = "Secondary read recovery fixture.\n";
  await page
    .getByLabel("Public content for a reversible workspace note")
    .fill(content);
  const seedUrl = new URL("demo/seed", apiUrl).href;
  const captured: { id?: string; path?: string } = {};
  let seedPosts = 0;
  const captureSeed = async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    seedPosts += 1;
    const response = await route.fetch({ maxRetries: 0, maxRedirects: 0 });
    expect(response.status()).toBe(201);
    const result = await response.json();
    captured.id = result.submission.transaction.id as string;
    captured.path = result.submission.intent.context.path as string;
    await route.fulfill({ response });
  };
  await page.route(seedUrl, captureSeed);
  await page.getByRole("button", { name: "Create transaction" }).click();
  await expect.poll(() => captured.id).toEqual(expect.any(String));
  await expect(page.locator(".inspector-heading .eyebrow")).toContainText(
    `${captured.id!.slice(0, 8)}…${captured.id!.slice(-4)}`,
  );
  await expect(
    page.getByRole("button", { name: "Review effects" }),
  ).toBeEnabled();
  await page.unroute(seedUrl, captureSeed);
  expect(seedPosts).toBe(1);
  expect(captured.path).toMatch(/^demo\/hello-[a-f0-9]+\.txt$/);
  const filePath = resolve(workspace, captured.path!);
  const bundleUrl = new URL(`transactions/${captured.id!}/bundle`, apiUrl).href;
  const inspectDaemon = async () => {
    const response = await page.request.get(bundleUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status()).toBe(200);
    return response.json();
  };
  await page.getByRole("button", { name: "Review effects" }).click();
  await page.getByRole("button", { name: "Grant approval" }).click();
  await expect(
    page.getByRole("button", { name: "Execute transaction" }),
  ).toBeEnabled();
  let mutations = 0;
  let bundleReads = 0;
  const count = (request: Request) => {
    if (request.url() === bundleUrl && request.method() === "GET")
      bundleReads += 1;
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method()))
      mutations += 1;
  };
  page.on("request", count);
  const state = page.locator(".heading-meta .state-badge");
  for (const operation of ["run", "rollback"] as const) {
    const isRun = operation === "run";
    const secondaryUrl = new URL(
      isRun ? "audit/verify" : "transactions/page",
      apiUrl,
    ).href;
    let secondaryReads = 0;
    const failOnce = async (route: Route) => {
      expect(route.request().method()).toBe("GET");
      secondaryReads += 1;
      if (secondaryReads === 1) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "unavailable",
              message: "Synthetic secondary read interruption",
            },
          }),
        });
      } else {
        await route.continue();
      }
    };
    await page.route(`${secondaryUrl}*`, failOnce);
    const readsBefore = bundleReads;
    await page
      .getByRole("button", {
        name: isRun ? "Execute transaction" : "Roll back",
        exact: true,
      })
      .click();
    await expect(state).toHaveText(isRun ? "Committed" : "Rolled back");
    await expect(page.getByText("View refresh incomplete")).toBeVisible();
    if (isRun) await expect(page.getByText("Journal unverified")).toBeVisible();
    expect(bundleReads).toBe(readsBefore + 1);
    await expect(page.getByText("Action stopped safely")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Execute transaction" }),
    ).toHaveCount(0);
    const beforeRecovery = await inspectDaemon();
    expect(beforeRecovery.transaction.state).toBe(
      isRun ? "committed" : "rolled_back",
    );
    if (isRun) {
      expect(await readFile(filePath, "utf8")).toBe(content);
      await expect(
        page.getByRole("button", { name: "Roll back" }),
      ).toBeEnabled();
    } else {
      await expect(readFile(filePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    await page.screenshot({
      path: testInfo.outputPath(`partial-${operation}-desktop.png`),
      fullPage: true,
    });
    await page.setViewportSize({ width: 760, height: 900 });
    const retry = page.getByRole("button", {
      name: "Retry views",
      exact: true,
    });
    await expect(retry).toBeEnabled();
    await page.screenshot({
      path: testInfo.outputPath(`partial-${operation}-narrow.png`),
      fullPage: true,
    });
    await retry.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("region", { name: "View refresh recovery" }),
    ).toHaveCount(0);
    await expect(page.locator(".integrity")).toContainText("events verified");
    expect(secondaryReads).toBe(2);
    expect(bundleReads).toBe(readsBefore + 1);
    expect(mutations).toBe(isRun ? 1 : 2);
    const afterRecovery = await inspectDaemon();
    expect(afterRecovery).toEqual(beforeRecovery);
    if (isRun) expect(await readFile(filePath, "utf8")).toBe(content);
    else
      await expect(readFile(filePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    await page.screenshot({
      path: testInfo.outputPath(`partial-${operation}-recovered-narrow.png`),
      fullPage: true,
    });
    await page.unroute(`${secondaryUrl}*`, failOnce);
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  page.off("request", count);
});

test("real daemon audit export matches the loaded API records without another request", async ({
  page,
}) => {
  const tokenFile = process.env.VEYRA_E2E_TOKEN_FILE;
  test.skip(
    tokenFile === undefined,
    "set VEYRA_E2E_TOKEN_FILE to a running synthetic local instance",
  );
  const token = (await readFile(tokenFile!, "utf8")).trim();
  const apiUrl = process.env.VEYRA_E2E_API_URL ?? "http://127.0.0.1:7843/v1/";
  // The existing real-flow suite seeds this isolated instance. This test only reads it.
  await page.addInitScript(
    ({ apiUrl, token }) => {
      localStorage.setItem("veyra.apiUrl", apiUrl);
      localStorage.setItem("veyra.token", token);
    },
    { apiUrl, token },
  );
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith(apiUrl)) requests.push(request.method());
  });
  const responsePromise = page.waitForResponse((response) =>
    response.url().includes("/audit/events/page?"),
  );
  await page.goto("/");
  const rows = (await (await responsePromise).json()).items;
  await page.getByRole("button", { name: /^Audit / }).click();
  const button = page.getByRole("button", { name: "Export visible JSON" });
  await expect(page.getByText("Chain verified")).toBeVisible();
  if (rows.length === 0) {
    await expect(button).toBeDisabled();
    expect(requests.every((method) => method === "GET")).toBe(true);
    return;
  }
  // Let the independent transaction-list/bundle reads finish before measuring export.
  await page.waitForLoadState("networkidle");
  const count = requests.length;
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    button.click(),
  ]);
  const content = await readFile((await download.path())!, "utf8");
  expect(JSON.parse(content).events).toEqual(rows);
  expect(content).not.toContain(token);
  expect(requests).toHaveLength(count);
  expect(requests.every((method) => method === "GET")).toBe(true);
});
