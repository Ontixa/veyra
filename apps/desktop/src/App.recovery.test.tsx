// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import userEvent from "@testing-library/user-event";
import type { Transaction, TransactionBundle } from "@veyra/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

const now = "2026-10-05T00:00:00Z";
const transaction = (
  id: string,
  state: Transaction["state"] = "committed",
): Transaction => ({
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
});
const bundle = (
  id: string,
  state: Transaction["state"] = "committed",
): TransactionBundle => ({
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
});
const failure = (message = "Temporary transaction read failure") =>
  Response.json({ error: { code: "unavailable", message } }, { status: 503 });
const deferred = () => {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

function mockApi(
  read: (id: string) => Response | Promise<Response>,
  options: {
    ids?: string[];
    auditError?: boolean;
    transactions?: () => Response | Promise<Response>;
    mutation?: (path: string) => Response;
  } = {},
) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const path = new URL(
        input instanceof Request ? input.url : input.toString(),
      ).pathname;
      if (init?.method === "POST") {
        if (options.mutation) return options.mutation(path);
        throw new Error(`Unexpected mutation: ${path}`);
      }
      if (path.endsWith("/health"))
        return Response.json({
          status: "ok",
          api_version: "v1",
          protocol_version: "veyra.protocol/v1",
        });
      if (path.endsWith("/transactions/page"))
        return (
          options.transactions?.() ??
          Response.json({
            items: (options.ids ?? ["tx-a"]).map((id) => transaction(id)),
            next_cursor: null,
          })
        );
      if (path.endsWith("/audit/events/page"))
        return Response.json({ items: [], next_cursor: null });
      if (path.endsWith("/audit/verify"))
        return options.auditError
          ? failure("Temporary audit read failure")
          : Response.json({
              valid: true,
              events_checked: 0,
              first_invalid_sequence: null,
              message: "journal is valid",
            });
      const id = /\/transactions\/(.*)\/bundle$/.exec(path)?.[1];
      if (id !== undefined) return read(id);
      throw new Error(`Unexpected read: ${path}`);
    });
}

function expectReadsOnly(fetch: ReturnType<typeof mockApi>) {
  expect(
    fetch.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET"),
  ).toBe(true);
}

async function expectRecovery(message = "Temporary transaction read failure") {
  expect(
    await screen.findByRole("heading", { name: "Could not load transaction" }),
  ).toBeTruthy();
  expect(screen.getByText(message)).toBeTruthy();
  expect(screen.queryByLabelText("Loading transaction")).toBeNull();
  return screen.getByRole<HTMLButtonElement>("button", {
    name: "Retry transaction",
  });
}

describe("selected transaction read recovery", () => {
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

  it("recovers a failed read with a keyboard-operated GET and restores rollback", async () => {
    const read = vi
      .fn()
      .mockReturnValueOnce(failure())
      .mockReturnValueOnce(Response.json(bundle("tx-a")));
    const fetch = mockApi(read);
    render(<App />);
    const retry = await expectRecovery();
    expect(screen.queryByRole("button", { name: "Roll back" })).toBeNull();
    retry.focus();
    await userEvent.setup().keyboard("{Enter}");
    expect(
      await screen.findByRole("heading", { name: "Inspect tx-a" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Roll back" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
    expectReadsOnly(fetch);
  });

  it("keeps retry available after repeated failures without an automatic loop", async () => {
    const read = vi
      .fn()
      .mockReturnValueOnce(failure())
      .mockReturnValueOnce(failure("Still unavailable"))
      .mockReturnValueOnce(Response.json(bundle("tx-a")));
    const fetch = mockApi(read);
    render(<App />);
    fireEvent.click(await expectRecovery());
    const retry = await expectRecovery("Still unavailable");
    expect(retry.disabled).toBe(false);
    await act(async () => {
      await Promise.resolve();
    });
    expect(read).toHaveBeenCalledTimes(2);
    fireEvent.click(retry);
    expect(
      await screen.findByRole("heading", { name: "Inspect tx-a" }),
    ).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(3);
    expectReadsOnly(fetch);
  });

  it("coalesces same-tick retry clicks and disables the pending retry", async () => {
    const response = deferred();
    const read = vi
      .fn()
      .mockReturnValueOnce(failure())
      .mockReturnValueOnce(response.promise);
    const fetch = mockApi(read);
    render(<App />);
    const retry = await expectRecovery();
    act(() => {
      fireEvent.click(retry);
      fireEvent.click(retry);
    });
    expect(retry.disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain(
      "Retrying transaction",
    );
    fireEvent.click(retry);
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => {
      response.resolve(Response.json(bundle("tx-a")));
    });
    expect(
      await screen.findByRole("heading", { name: "Inspect tx-a" }),
    ).toBeTruthy();
    expectReadsOnly(fetch);
  });

  it.each(["success", "failure"])(
    "ignores stale retry %s after selecting another transaction",
    async (outcome) => {
      const response = deferred();
      let aReads = 0;
      const fetch = mockApi(
        (id) =>
          id === "tx-b"
            ? Response.json(bundle(id))
            : ++aReads === 1
              ? failure()
              : response.promise,
        { ids: ["tx-a", "tx-b"] },
      );
      render(<App />);
      fireEvent.click(await expectRecovery());
      fireEvent.click(screen.getByRole("button", { name: /tx-b/i }));
      expect(
        await screen.findByRole("heading", { name: "Inspect tx-b" }),
      ).toBeTruthy();
      await act(async () => {
        response.resolve(
          outcome === "success"
            ? Response.json(bundle("tx-a"))
            : failure("Stale failure"),
        );
      });
      expect(
        screen.getByRole("heading", { name: "Inspect tx-b" }),
      ).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Retry transaction" }),
      ).toBeNull();
      expectReadsOnly(fetch);
    },
  );

  it("does not confuse an older read with a new selection of the same transaction", async () => {
    const response = deferred();
    let aReads = 0;
    const fetch = mockApi(
      (id) =>
        id === "tx-a" && ++aReads === 1
          ? response.promise
          : Response.json(bundle(id)),
      { ids: ["tx-a", "tx-b"] },
    );
    render(<App />);
    await waitFor(() => expect(aReads).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: /tx-b/i }));
    expect(
      await screen.findByRole("heading", { name: "Inspect tx-b" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /tx-a/i }));
    expect(
      await screen.findByRole("heading", { name: "Inspect tx-a" }),
    ).toBeTruthy();
    await act(async () => {
      response.resolve(failure("Older tx-a failure"));
    });
    expect(screen.getByRole("heading", { name: "Inspect tx-a" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(aReads).toBe(2);
    expectReadsOnly(fetch);
  });

  it("preserves recovery after global error dismissal, same-row clicks, and Audit navigation", async () => {
    const read = vi
      .fn()
      .mockReturnValueOnce(failure())
      .mockReturnValueOnce(Response.json(bundle("tx-a")));
    const fetch = mockApi(read, { auditError: true });
    render(<App />);
    await expectRecovery();
    fireEvent.click(
      await screen.findByRole("button", { name: "Dismiss error" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /tx-a/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Audit / }));
    fireEvent.click(screen.getByRole("button", { name: /^Transactions / }));
    const retry = await expectRecovery();
    expect(read).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Temporary audit read failure")).toBeNull();
    fireEvent.click(retry);
    expect(
      await screen.findByRole("heading", { name: "Inspect tx-a" }),
    ).toBeTruthy();
    expectReadsOnly(fetch);
  });

  it("retries only the detail GET after a successful rollback's refresh fails", async () => {
    const read = vi
      .fn()
      .mockReturnValueOnce(Response.json(bundle("tx-a")))
      .mockReturnValueOnce(failure())
      .mockReturnValueOnce(Response.json(bundle("tx-a", "rolled_back")));
    const mutation = vi.fn((path: string) => {
      expect(path).toBe("/v1/transactions/tx-a/rollback");
      return Response.json({});
    });
    const fetch = mockApi(read, { mutation });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Roll back" }));
    fireEvent.click(await expectRecovery());
    expect(
      await screen.findByRole("heading", { name: "Inspect tx-a" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Roll back" })).toBeNull();
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(
      fetch.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("ignores a stale post-create detail load after the operator changes selection", async () => {
    const refresh = deferred();
    let lists = 0;
    const read = vi.fn((id: string) => Response.json(bundle(id)));
    const mutation = vi.fn((path: string) => {
      expect(path).toBe("/v1/demo/seed");
      return Response.json({
        submission: { transaction: transaction("tx-new") },
        human: { id: "human" },
      });
    });
    const fetch = mockApi(read, {
      mutation,
      transactions: () =>
        ++lists === 1
          ? Response.json({
              items: [transaction("tx-a"), transaction("tx-b")],
              next_cursor: null,
            })
          : refresh.promise,
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Inspect tx-a" });
    fireEvent.click(screen.getByRole("button", { name: "Create transaction" }));
    await screen.findByRole("heading", { name: "Inspect tx-new" });
    fireEvent.click(screen.getByRole("button", { name: /tx-b/i }));
    await screen.findByRole("heading", { name: "Inspect tx-b" });
    await act(async () => {
      refresh.resolve(
        Response.json({
          items: [
            transaction("tx-new"),
            transaction("tx-a"),
            transaction("tx-b"),
          ],
          next_cursor: null,
        }),
      );
    });
    expect(screen.getByRole("heading", { name: "Inspect tx-b" })).toBeTruthy();
    expect(screen.queryByLabelText("Loading transaction")).toBeNull();
    expect(read.mock.calls.filter(([id]) => id === "tx-new")).toHaveLength(1);
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(
      fetch.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
  });

  it("recovers under the production StrictMode lifecycle without duplicate retry reads", async () => {
    const read = vi
      .fn()
      .mockReturnValueOnce(failure())
      .mockReturnValueOnce(Response.json(bundle("tx-a")));
    const fetch = mockApi(read);
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    fireEvent.click(await expectRecovery());
    expect(
      await screen.findByRole("heading", { name: "Inspect tx-a" }),
    ).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(2);
    expectReadsOnly(fetch);
  });
});
