// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Transaction, TransactionBundle } from "@veyra/sdk";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";

const now = "2026-10-06T06:00:00Z";
function transaction(id: string, state: Transaction["state"]): Transaction {
  return {
    schema_version: "veyra.protocol/v1",
    id,
    intent_id: `intent-${id}`,
    plan_id: `plan-${id}`,
    state,
    effect_ids: [],
    receipt_ids: [],
    revision: 1,
    created_at: now,
    updated_at: now,
    manual_recovery_reason: null,
  };
}
function bundle(id: string, state: Transaction["state"]): TransactionBundle {
  return {
    transaction: transaction(id, state),
    intent: {
      schema_version: "veyra.protocol/v1",
      id: `intent-${id}`,
      principal_id: "principal",
      summary: `Inspect ${id}`,
      requested_resources: [],
      context: {},
      created_at: now,
    },
    plan: {
      schema_version: "veyra.protocol/v1",
      id: `plan-${id}`,
      intent_id: `intent-${id}`,
      planner: "fixture",
      steps: [],
      created_at: now,
    },
    policy_decisions: [],
    approval_requests: [],
    approval_grants: [],
    executions: [],
    receipts: [],
    verifications: [],
    compensations: [],
    events: [],
    events_next_cursor: null,
  };
}
const failure = (message: string) =>
  Response.json({ error: { code: "unavailable", message } }, { status: 503 });
const scenarios = [
  {
    route: "preview",
    action: "Review effects",
    initial: "planned",
    final: "awaiting_approval",
  },
  {
    route: "run",
    action: "Execute transaction",
    initial: "approved",
    final: "committed",
  },
  {
    route: "rollback",
    action: "Roll back",
    initial: "committed",
    final: "rolled_back",
  },
  {
    route: "grant",
    action: "Approve exact effect",
    initial: "awaiting_approval",
    final: "approved",
  },
] as const;
type Scenario = (typeof scenarios)[number];
type Read = "list" | "audit-events" | "audit-verify" | "detail";
function setup(
  scenario: Scenario,
  failures: Read[] = [],
  pagination = false,
  initialAudit?: Promise<Response>,
) {
  const failed = new Set(failures);
  const held = new Map<Read, Promise<Response>>();
  let serverState: Transaction["state"] = scenario.initial;
  let changed = false;
  let reads = 0;
  let posts = 0;
  let post: (() => Promise<Response>) | undefined;
  const requests: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = new URL(
      input instanceof Request ? input.url : input.toString(),
    ).pathname;
    const method = init?.method ?? "GET";
    requests.push(`${method} ${path}`);
    if (method === "POST") {
      expect(path).toBe(
        scenario.route === "grant"
          ? "/v1/approvals/approval-a/grant"
          : `/v1/transactions/tx-a/${scenario.route}`,
      );
      posts++;
      if (post) return post();
      changed = true;
      serverState = scenario.final;
      return Response.json({ transaction: transaction("tx-a", serverState) });
    }
    if (path.endsWith("/health"))
      return Response.json({
        status: "ok",
        api_version: "v1",
        protocol_version: "veyra.protocol/v1",
      });
    const read = (kind: Read, value: unknown) => {
      if (changed && held.has(kind)) return held.get(kind)!;
      return changed && failed.has(kind)
        ? failure(`${kind} read failed`)
        : Response.json(value);
    };
    if (path.endsWith("/transactions/page"))
      return read("list", {
        items: [
          transaction("tx-a", serverState),
          transaction("tx-b", "planned"),
        ],
        next_cursor: pagination ? "older-transactions" : null,
      });
    if (path.endsWith("/audit/events/page"))
      return read("audit-events", {
        items: [],
        next_cursor: pagination ? "older-audit" : null,
      });
    if (path.endsWith("/audit/verify") && !changed && initialAudit)
      return initialAudit;
    if (path.endsWith("/audit/verify"))
      return read("audit-verify", {
        valid: true,
        events_checked: 0,
        first_invalid_sequence: null,
        message: "synthetic valid journal",
      });
    if (path.endsWith("/transactions/tx-b/bundle"))
      return Response.json(bundle("tx-b", "planned"));
    if (path.endsWith("/transactions/tx-a/bundle")) {
      reads++;
      const next = bundle("tx-a", serverState);
      if (scenario.route === "grant" && !changed)
        next.approval_requests = [
          {
            id: "approval-a",
            transaction_id: "tx-a",
            effect_id: "effect-a",
            effect_digest: "a".repeat(64),
            resource: {
              kind: "filesystem",
              workspace: "default",
              path: "demo/test.txt",
            },
            risk: "high",
            preview: { kind: "pending" },
            nonce: "synthetic-nonce",
            created_at: now,
            expires_at: "2026-10-07T00:00:00Z",
          },
        ];
      return read("detail", next);
    }
    throw new Error(`Unexpected ${method} ${path}`);
  });
  return {
    failed,
    held,
    requests,
    reads: () => reads,
    posts: () => posts,
    setPost: (next: () => Promise<Response>) => {
      post = next;
    },
    complete: (state: Transaction["state"] = scenario.final) => {
      changed = true;
      serverState = state;
      return Response.json({ transaction: transaction("tx-a", serverState) });
    },
  };
}
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("veyra.apiUrl", "http://127.0.0.1:7843/v1/");
  localStorage.setItem("veyra.token", `vyr_${"a".repeat(64)}`);
  localStorage.setItem(
    "veyra.demoApprovers",
    JSON.stringify({ "tx-a": "human" }),
  );
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockReturnValue({ matches: false }),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

for (const scenario of scenarios) {
  for (const secondary of [
    ["list"],
    ["audit-events"],
    ["audit-verify"],
    ["list", "audit-events", "audit-verify"],
  ] as Read[][]) {
    for (const detailFails of [false, true]) {
      it(`${scenario.route}: refreshes detail independently of ${secondary.join("+")} failure, detail failure=${detailFails}`, async () => {
        const api = setup(scenario, [
          ...secondary,
          ...(detailFails ? ["detail" as const] : []),
        ]);
        const { container } = render(<App />);
        fireEvent.click(
          await screen.findByRole("button", { name: scenario.action }),
        );
        await waitFor(() => expect(api.reads()).toBe(2));
        await screen.findByText("View refresh incomplete");
        await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
        expect(api.reads()).toBe(2);
        expect(api.posts()).toBe(1);
        if (secondary.some((endpoint) => endpoint.startsWith("audit-"))) {
          expect(screen.getByText("Journal unverified")).toBeTruthy();
          expect(screen.queryByText("Checking journal")).toBeNull();
        }
        expect(screen.queryByText("Action stopped safely")).toBeNull();
        expect(
          screen.queryByRole("button", { name: scenario.action }),
        ).toBeNull();
        if (detailFails) {
          expect(
            screen.getByRole("heading", { name: "Could not load transaction" }),
          ).toBeTruthy();
          expect(screen.getByText(/action request completed/)).toBeTruthy();
        } else {
          expect(
            container
              .querySelector(".heading-meta .state-badge")
              ?.textContent?.toLowerCase(),
          ).toBe(scenario.final.replaceAll("_", " "));
        }
        api.failed.clear();
        const checkpoint = api.requests.length;
        const retry = screen.getByRole("button", { name: "Retry views" });
        act(() => {
          fireEvent.click(retry);
          fireEvent.click(retry);
        });
        await waitFor(() =>
          expect(screen.queryByLabelText("View refresh recovery")).toBeNull(),
        );
        expect(screen.getByText("0 events verified")).toBeTruthy();
        expect(screen.queryByText("Journal unverified")).toBeNull();
        expect(api.requests.slice(checkpoint)).toHaveLength(3);
        expect(
          api.requests
            .slice(checkpoint)
            .every((request) => request.startsWith("GET ")),
        ).toBe(true);
        if (detailFails) {
          fireEvent.click(
            screen.getByRole("button", { name: "Retry transaction" }),
          );
          await screen.findByRole("heading", { name: "Inspect tx-a" });
          expect(api.reads()).toBe(3);
        }
        expect(api.posts()).toBe(1);
      });
    }
  }
  it(`${scenario.route}: detail and next controls do not wait for a delayed secondary read`, async () => {
    const api = setup(scenario);
    const delayed = deferred();
    api.held.set("audit-verify", delayed.promise);
    const { container } = render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: scenario.action }),
    );
    await waitFor(() => expect(api.reads()).toBe(2));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(
      container
        .querySelector(".heading-meta .state-badge")
        ?.textContent?.toLowerCase(),
    ).toBe(scenario.final.replaceAll("_", " "));
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Refreshing views",
      }).disabled,
    ).toBe(true);
    expect(screen.getByText("Journal unverified")).toBeTruthy();
    expect(screen.queryByText("Checking journal")).toBeNull();
    if (scenario.route === "run")
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "Roll back" })
          .disabled,
      ).toBe(false);
    await act(async () =>
      delayed.resolve(failure("Delayed verification failed")),
    );
    await screen.findByRole("button", { name: "Retry views" });
    expect(api.posts()).toBe(1);
  });
}

it("keeps stale mutation controls hidden while detail is delayed and secondary views fail", async () => {
  const api = setup(scenarios[1], ["list"]);
  const delayed = deferred();
  api.held.set("detail", delayed.promise);
  render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Execute transaction" }),
  );
  await screen.findByText("View refresh incomplete");
  expect(screen.getByLabelText("Loading transaction")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Execute transaction" }),
  ).toBeNull();
  await act(async () =>
    delayed.resolve(Response.json(bundle("tx-a", "committed"))),
  );
  await screen.findByRole("button", { name: "Roll back" });
  expect(api.posts()).toBe(1);
});

it("keeps read-only recovery after repeated secondary failures without looping", async () => {
  const api = setup(scenarios[1], ["list"]);
  render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Execute transaction" }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Retry views" }));
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Retry views" })
        .disabled,
    ).toBe(false),
  );
  const count = api.requests.length;
  await act(async () => {
    await Promise.resolve();
  });
  expect(api.requests).toHaveLength(count);
  expect(api.posts()).toBe(1);
});

for (const outcome of ["network", "invalid-json", "server-error"] as const) {
  it(`does not claim completion or retain stale controls after ${outcome} POST outcome`, async () => {
    const api = setup(scenarios[1]);
    api.setPost(async () => {
      api.complete();
      if (outcome === "network") throw new TypeError("Connection lost");
      return outcome === "invalid-json"
        ? new Response("invalid", { status: 200 })
        : failure("Server error");
    });
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Execute transaction" }),
    );
    await screen.findByText(/Action outcome not confirmed:/);
    expect(
      screen.queryByRole("button", { name: "Execute transaction" }),
    ).toBeNull();
    expect(screen.queryByLabelText("View refresh recovery")).toBeNull();
    expect(screen.queryByText(/action request completed/)).toBeNull();
    expect(api.reads()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry transaction" }));
    await screen.findByRole("button", { name: "Roll back" });
    expect(api.posts()).toBe(1);
  });
}

it("does not launch refresh traffic after unmounting during a mutation", async () => {
  const api = setup(scenarios[1]);
  const delayed = deferred();
  api.setPost(() => delayed.promise);
  const { unmount } = render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Execute transaction" }),
  );
  unmount();
  const count = api.requests.length;
  await act(async () => delayed.resolve(api.complete()));
  expect(api.requests).toHaveLength(count);
});

it("requires a fresh read after a 409 that followed a manual-recovery transition", async () => {
  const api = setup(scenarios[1]);
  api.setPost(async () => {
    api.complete("manual_recovery");
    return Response.json(
      {
        error: {
          code: "transaction_conflict",
          message: "Manual recovery required",
        },
      },
      { status: 409 },
    );
  });
  const { container } = render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Execute transaction" }),
  );
  await screen.findByText(/Action outcome not confirmed:/);
  expect(
    screen.queryByRole("button", { name: "Execute transaction" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry transaction" }));
  await screen.findByRole("heading", { name: "Inspect tx-a" });
  expect(
    container.querySelector(".heading-meta .state-badge")?.textContent,
  ).toBe("Manual recovery");
  expect(
    screen.queryByRole("button", { name: "Execute transaction" }),
  ).toBeNull();
  expect(api.posts()).toBe(1);
});

for (const scenario of scenarios) {
  for (const returnToA of [false, true]) {
    it(`${scenario.route}: preserves navigation with secondary failure, return to A=${returnToA}`, async () => {
      const api = setup(scenario, ["list", "audit-verify"]);
      const post = deferred();
      api.setPost(() => post.promise);
      const { container } = render(<App />);
      fireEvent.click(
        await screen.findByRole("button", { name: scenario.action }),
      );
      fireEvent.click(screen.getByRole("button", { name: /tx-b/i }));
      await screen.findByRole("heading", { name: "Inspect tx-b" });
      if (returnToA) {
        fireEvent.click(screen.getByRole("button", { name: /tx-a/i }));
        await screen.findByRole("heading", { name: "Inspect tx-a" });
      }
      await act(async () => post.resolve(api.complete()));
      await screen.findByText("View refresh incomplete");
      if (returnToA) {
        expect(
          container
            .querySelector(".heading-meta .state-badge")
            ?.textContent?.toLowerCase(),
        ).toBe(scenario.final.replaceAll("_", " "));
        expect(api.reads()).toBe(3);
      } else {
        expect(
          screen.getByRole("heading", { name: "Inspect tx-b" }),
        ).toBeTruthy();
        expect(api.reads()).toBe(1);
        fireEvent.click(screen.getByRole("button", { name: /tx-a/i }));
        await screen.findByRole("heading", { name: "Inspect tx-a" });
        expect(
          container
            .querySelector(".heading-meta .state-badge")
            ?.textContent?.toLowerCase(),
        ).toBe(scenario.final.replaceAll("_", " "));
      }
      expect(api.posts()).toBe(1);
    });
  }
}

it("waits for current collections before allowing list or audit pagination", async () => {
  const api = setup(scenarios[1], [], true);
  const delayed = deferred();
  api.held.set("audit-verify", delayed.promise);
  render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Execute transaction" }),
  );
  await screen.findByRole("button", { name: "Roll back" });
  await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  const older = screen.getByRole<HTMLButtonElement>("button", {
    name: "Load older transactions",
  });
  expect(older.disabled).toBe(true);
  const count = api.requests.length;
  fireEvent.click(older);
  fireEvent.click(screen.getByRole("button", { name: /^Audit / }));
  const olderAudit = screen.getByRole<HTMLButtonElement>("button", {
    name: "Load older evidence",
  });
  expect(olderAudit.disabled).toBe(true);
  fireEvent.click(olderAudit);
  expect(api.requests).toHaveLength(count);
  await act(async () => delayed.resolve(failure("Audit unavailable")));
  await screen.findByRole("button", { name: "Retry views" });
  expect(olderAudit.disabled).toBe(true);
  api.held.clear();
  fireEvent.click(screen.getByRole("button", { name: "Retry views" }));
  await waitFor(() => expect(olderAudit.disabled).toBe(false));
  fireEvent.click(olderAudit);
  await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: /^Transactions / }));
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "Load older transactions",
    }).disabled,
  ).toBe(false);
  expect(api.posts()).toBe(1);
});

it("ignores an initial audit failure after a newer mutation refresh succeeded", async () => {
  const initial = deferred();
  const api = setup(scenarios[1], [], false, initial.promise);
  render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Execute transaction" }),
  );
  await screen.findByRole("button", { name: "Roll back" });
  await waitFor(() =>
    expect(screen.queryByLabelText("View refresh recovery")).toBeNull(),
  );
  await act(async () =>
    initial.resolve(failure("Obsolete initial audit error")),
  );
  expect(screen.queryByText("Obsolete initial audit error")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(api.posts()).toBe(1);
});
