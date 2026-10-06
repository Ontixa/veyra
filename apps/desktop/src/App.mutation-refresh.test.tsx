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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const cases = [
  {
    route: "preview",
    action: "Review effects",
    initial: "planned",
    during: "planned",
    final: "awaiting_approval",
  },
  {
    route: "run",
    action: "Execute transaction",
    initial: "approved",
    during: "executing",
    final: "committed",
  },
  {
    route: "rollback",
    action: "Roll back",
    initial: "committed",
    during: "compensating",
    final: "rolled_back",
  },
] as const satisfies {
  route: string;
  action: string;
  initial: Transaction["state"];
  during: Transaction["state"];
  final: Transaction["state"];
}[];

type Scenario = (typeof cases)[number];
function setup(scenario: Scenario) {
  const mutation = deferred<Response>();
  const oldRead = deferred<Response>();
  const freshRead = deferred<Response>();
  let serverState: Transaction["state"] = scenario.initial;
  let aReads = 0;
  let auditReads = 0;
  const requests: string[] = [];
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const path = new URL(
        input instanceof Request ? input.url : input.toString(),
      ).pathname;
      const method = init?.method ?? "GET";
      requests.push(`${method} ${path}`);
      if (method === "POST") {
        expect(path).toBe(`/v1/transactions/tx-a/${scenario.route}`);
        serverState = scenario.during;
        return mutation.promise;
      }
      if (path.endsWith("/health"))
        return Response.json({
          status: "ok",
          api_version: "v1",
          protocol_version: "veyra.protocol/v1",
        });
      if (path.endsWith("/transactions/page"))
        return Response.json({
          items: [
            transaction("tx-a", serverState),
            transaction("tx-b", "planned"),
          ],
          next_cursor: null,
        });
      if (path.endsWith("/audit/events/page"))
        return Response.json({ items: [], next_cursor: null });
      if (path.endsWith("/audit/verify")) {
        auditReads++;
        return Response.json({
          valid: true,
          events_checked: auditReads,
          first_invalid_sequence: null,
          message: "synthetic journal is valid",
        });
      }
      if (path.endsWith("/transactions/tx-b/bundle"))
        return Response.json(bundle("tx-b", "planned"));
      if (path.endsWith("/transactions/tx-a/bundle")) {
        aReads++;
        // As with the server's read_snapshot, serialize a consistent snapshot at request time.
        if (aReads === 2) return oldRead.promise;
        if (aReads === 3) return freshRead.promise;
        return Response.json(bundle("tx-a", serverState));
      }
      throw new Error(`Unexpected synthetic request ${method} ${path}`);
    });
  return {
    fetch,
    requests,
    reads: () => aReads,
    completeMutation: () => {
      serverState = scenario.final;
      mutation.resolve(
        Response.json({
          transaction: transaction("tx-a", scenario.final),
          receipts: [],
          verifications: [],
          recoveries: [],
          committed: scenario.final === "committed",
        }),
      );
    },
    failMutation: () =>
      mutation.resolve(
        Response.json(
          {
            error: {
              code: "transaction_conflict",
              message: "Mutation refused",
            },
          },
          { status: 409 },
        ),
      ),
    oldRead,
    freshRead,
  };
}

const failure = (message: string) =>
  Response.json({ error: { code: "unavailable", message } }, { status: 503 });

async function startMutation(
  scenario: Scenario,
  api: ReturnType<typeof setup>,
  returnToA = true,
) {
  fireEvent.click(await screen.findByRole("button", { name: scenario.action }));
  fireEvent.click(screen.getByRole("button", { name: /tx-b/i }));
  await screen.findByRole("heading", { name: "Inspect tx-b" });
  if (returnToA) {
    fireEvent.click(screen.getByRole("button", { name: /tx-a/i }));
    await waitFor(() => expect(api.reads()).toBe(2));
  }
}

function expectOneMutation(api: ReturnType<typeof setup>) {
  expect(
    api.requests.filter((request) => request.startsWith("POST ")),
  ).toHaveLength(1);
}

function expectState(container: HTMLElement, state: Transaction["state"]) {
  const label = state
    .replaceAll("_", " ")
    .replace(/^./, (char) => char.toUpperCase());
  expect(
    container.querySelector(".heading-meta .state-badge")?.textContent,
  ).toBe(label);
}

describe("mutation refresh versus pending transaction reads", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("veyra.apiUrl", "http://127.0.0.1:7843/v1/");
    localStorage.setItem("veyra.token", `vyr_${"a".repeat(64)}`);
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  for (const scenario of cases) {
    for (const staleOutcome of ["success", "error"] as const) {
      it.each(["before", "after"])(
        `${scenario.route}: ignores old ${staleOutcome} settling %s the fresh read`,
        async (order) => {
          const api = setup(scenario);
          const { container } = render(<App />);
          await startMutation(scenario, api);
          await act(async () => {
            api.completeMutation();
          });
          // A post-mutation read must start without waiting for the pre-mutation one.
          await waitFor(() => expect(api.reads()).toBe(3));
          const settleOld = async () => {
            await act(async () => {
              api.oldRead.resolve(
                staleOutcome === "success"
                  ? Response.json(bundle("tx-a", scenario.during))
                  : failure("Obsolete read failed"),
              );
            });
          };
          if (order === "before") {
            await settleOld();
            expect(screen.getByLabelText("Loading transaction")).toBeTruthy();
            expect(screen.queryByRole("alert")).toBeNull();
            expect(
              screen.queryByRole("heading", { name: "Inspect tx-a" }),
            ).toBeNull();
          }
          await act(async () => {
            api.freshRead.resolve(
              Response.json(bundle("tx-a", scenario.final)),
            );
          });
          await screen.findByRole("heading", { name: "Inspect tx-a" });
          if (order === "after") await settleOld();
          expectState(container, scenario.final);
          expect(screen.queryByRole("alert")).toBeNull();
          expect(screen.queryByLabelText("Loading transaction")).toBeNull();
          expect(
            screen.queryByRole("button", { name: "Retry transaction" }),
          ).toBeNull();
          if (scenario.final === "committed")
            expect(
              screen.getByRole("button", { name: "Roll back" }),
            ).toBeTruthy();
          if (scenario.final === "rolled_back")
            expect(
              screen.queryByRole("button", { name: "Roll back" }),
            ).toBeNull();
          expectOneMutation(api);
        },
      );
    }

    it(`${scenario.route}: preserves the newer selection if the operator stays on B`, async () => {
      const api = setup(scenario);
      render(<App />);
      await startMutation(scenario, api, false);
      await act(async () => {
        api.completeMutation();
      });
      await screen.findByText("2 events verified");
      await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
      expect(
        screen.getByRole("heading", { name: "Inspect tx-b" }),
      ).toBeTruthy();
      expect(api.reads()).toBe(1);
      expectOneMutation(api);
    });

    it(`${scenario.route}: requires read recovery after a mutation failure and ignores the old navigation read`, async () => {
      const api = setup(scenario);
      render(<App />);
      await startMutation(scenario, api);
      await act(async () => {
        api.failMutation();
      });
      await screen.findByText(/Action outcome not confirmed: Mutation refused/);
      await act(async () => {
        api.oldRead.resolve(Response.json(bundle("tx-a", scenario.initial)));
      });
      expect(
        screen.queryByRole("heading", { name: "Inspect tx-a" }),
      ).toBeNull();
      expect(
        screen.getByRole("heading", { name: "Could not load transaction" }),
      ).toBeTruthy();
      expect(
        screen.getByText(/Action outcome not confirmed: Mutation refused/),
      ).toBeTruthy();
      expect(api.reads()).toBe(2);
      expectOneMutation(api);
    });
  }

  it("preserves a fresh read failure against late old success and coalesces repeated retries", async () => {
    const scenario = cases[1];
    const api = setup(scenario);
    const { container } = render(<App />);
    await startMutation(scenario, api);
    await act(async () => {
      api.completeMutation();
    });
    await waitFor(() => expect(api.reads()).toBe(3));
    await act(async () => {
      api.freshRead.resolve(failure("Fresh read failed"));
    });
    await screen.findByRole("heading", { name: "Could not load transaction" });
    await act(async () => {
      api.oldRead.resolve(Response.json(bundle("tx-a", scenario.during)));
    });
    expect(screen.getByText("Fresh read failed")).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Retry transaction" });
    act(() => {
      fireEvent.click(retry);
      fireEvent.click(retry);
    });
    await screen.findByRole("heading", { name: "Inspect tx-a" });
    expectState(container, "committed");
    expect(api.reads()).toBe(4);
    expectOneMutation(api);
  });
});
