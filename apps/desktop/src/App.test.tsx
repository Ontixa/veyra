// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

const TOKEN = `vyr_${"a".repeat(64)}`;

describe("Veyra desktop control plane", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows an explicit local connection state without fake transaction data", async () => {
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "Connect to Veyra" }),
    ).toBeTruthy();
    expect(screen.getByLabelText("Administrative bearer token")).toBeTruthy();
  });

  it("loads the empty control plane through the authenticated real API shape", async () => {
    localStorage.setItem("veyra.apiUrl", "http://127.0.0.1:7843/v1/");
    localStorage.setItem("veyra.token", TOKEN);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const path = new URL(
          input instanceof Request ? input.url : input.toString(),
        ).pathname;
        const authorization = new Headers(init?.headers).get("authorization");
        expect(authorization).toBe(`Bearer ${TOKEN}`);
        if (path.endsWith("/health")) {
          return Response.json({
            status: "ok",
            api_version: "v1",
            protocol_version: "veyra.protocol/v1",
          });
        }
        if (
          path.endsWith("/transactions/page") ||
          path.endsWith("/audit/events/page")
        ) {
          return Response.json({ items: [], next_cursor: null });
        }
        if (path.endsWith("/audit/verify")) {
          return Response.json({
            valid: true,
            events_checked: 0,
            first_invalid_sequence: null,
            message: "journal is empty and valid",
          });
        }
        return Response.json(
          { error: { code: "not_found", message: "not found" } },
          { status: 404 },
        );
      });

    render(<App />);

    expect(
      await screen.findByText("Make the next side effect inspectable."),
    ).toBeTruthy();
    expect(await screen.findByText("0 events verified")).toBeTruthy();
    expect(fetch).toHaveBeenCalled();
  });

  it("surfaces failed journal integrity as an explicit alert", async () => {
    localStorage.setItem("veyra.apiUrl", "http://127.0.0.1:7843/v1/");
    localStorage.setItem("veyra.token", TOKEN);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(
        input instanceof Request ? input.url : input.toString(),
      ).pathname;
      if (path.endsWith("/health")) {
        return Response.json({
          status: "ok",
          api_version: "v1",
          protocol_version: "veyra.protocol/v1",
        });
      }
      if (
        path.endsWith("/transactions/page") ||
        path.endsWith("/audit/events/page")
      ) {
        return Response.json({ items: [], next_cursor: null });
      }
      if (path.endsWith("/audit/verify")) {
        return Response.json({
          valid: false,
          events_checked: 12,
          first_invalid_sequence: null,
          message: "transaction snapshot disagrees with audit evidence",
        });
      }
      return Response.json(
        { error: { code: "not_found", message: "not found" } },
        { status: 404 },
      );
    });

    render(<App />);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Journal integrity failed",
    );
  });

  it("stale bundle responses cannot overwrite a newer transaction selection", async () => {
    localStorage.setItem("veyra.apiUrl", "http://127.0.0.1:7843/v1/");
    localStorage.setItem("veyra.token", TOKEN);
    const now = "2026-08-23T00:00:00Z";
    const transaction = (id: string) => ({
      schema_version: "veyra.protocol/v1",
      id,
      intent_id: `intent-${id}`,
      plan_id: `plan-${id}`,
      state: "planned",
      effect_ids: [],
      receipt_ids: [],
      revision: 0,
      created_at: now,
      updated_at: now,
      manual_recovery_reason: null,
    });
    const bundle = (id: string, summary: string) => ({
      transaction: transaction(id),
      intent: {
        schema_version: "veyra.protocol/v1",
        id: `intent-${id}`,
        principal_id: "principal",
        summary,
        requested_resources: [],
        context: {},
        created_at: now,
      },
      plan: {
        schema_version: "veyra.protocol/v1",
        id: `plan-${id}`,
        intent_id: `intent-${id}`,
        planner: "test",
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
    let resolveFirst: ((response: Response) => void) | undefined;
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    let firstRequested = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(
        input instanceof Request ? input.url : input.toString(),
      ).pathname;
      if (path.endsWith("/health")) {
        return Response.json({
          status: "ok",
          api_version: "v1",
          protocol_version: "veyra.protocol/v1",
        });
      }
      if (path.endsWith("/transactions/page")) {
        return Response.json({
          items: [transaction("tx-a"), transaction("tx-b")],
          next_cursor: null,
        });
      }
      if (path.endsWith("/audit/events/page")) {
        return Response.json({ items: [], next_cursor: null });
      }
      if (path.endsWith("/audit/verify")) {
        return Response.json({
          valid: true,
          events_checked: 0,
          first_invalid_sequence: null,
          message: "journal is valid",
        });
      }
      if (path.endsWith("/transactions/tx-a/bundle")) {
        firstRequested = true;
        return firstResponse;
      }
      if (path.endsWith("/transactions/tx-b/bundle")) {
        return Response.json(bundle("tx-b", "Second transaction"));
      }
      return Response.json(
        { error: { code: "not_found", message: "not found" } },
        { status: 404 },
      );
    });

    render(<App />);
    await waitFor(() => expect(firstRequested).toBe(true));
    fireEvent.click(await screen.findByRole("button", { name: /tx-b/i }));
    expect(
      await screen.findByRole("heading", { name: "Second transaction" }),
    ).toBeTruthy();

    const lateResponse = Response.json(bundle("tx-a", "First transaction"));
    resolveFirst?.(lateResponse);
    await waitFor(() => expect(lateResponse.bodyUsed).toBe(true));
    await Promise.resolve();
    expect(
      screen.getByRole("heading", { name: "Second transaction" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "First transaction" }),
    ).toBeNull();
  });

  it("pages the bundle event timeline without losing earlier events", async () => {
    localStorage.setItem("veyra.apiUrl", "http://127.0.0.1:7843/v1/");
    localStorage.setItem("veyra.token", TOKEN);
    const now = "2026-08-23T00:00:00Z";
    const event = (sequence: number) => ({
      id: `event-${sequence}`,
      transaction_id: "tx-a",
      sequence,
      event_type: `transaction.step_${sequence}`,
      causal_parent: null,
      payload: {},
      previous_hash: `prev-${sequence}`,
      hash: `hash-${sequence}`,
      recorded_at: now,
    });
    const bundle = (events: unknown[], nextCursor: string | null) => ({
      transaction: {
        schema_version: "veyra.protocol/v1",
        id: "tx-a",
        intent_id: "intent-tx-a",
        plan_id: "plan-tx-a",
        state: "planned",
        effect_ids: [],
        receipt_ids: [],
        revision: 0,
        created_at: now,
        updated_at: now,
        manual_recovery_reason: null,
      },
      intent: {
        schema_version: "veyra.protocol/v1",
        id: "intent-tx-a",
        principal_id: "principal",
        summary: "Paged timeline transaction",
        requested_resources: [],
        context: {},
        created_at: now,
      },
      plan: {
        schema_version: "veyra.protocol/v1",
        id: "plan-tx-a",
        intent_id: "intent-tx-a",
        planner: "test",
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
      events,
      events_next_cursor: nextCursor,
    });
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = new URL(
          input instanceof Request ? input.url : input.toString(),
        );
        if (url.pathname.endsWith("/health")) {
          return Response.json({
            status: "ok",
            api_version: "v1",
            protocol_version: "veyra.protocol/v1",
          });
        }
        if (url.pathname.endsWith("/transactions/page")) {
          return Response.json({
            items: [
              {
                schema_version: "veyra.protocol/v1",
                id: "tx-a",
                intent_id: "intent-tx-a",
                plan_id: "plan-tx-a",
                state: "planned",
                effect_ids: [],
                receipt_ids: [],
                revision: 0,
                created_at: now,
                updated_at: now,
                manual_recovery_reason: null,
              },
            ],
            next_cursor: null,
          });
        }
        if (url.pathname.endsWith("/audit/events/page")) {
          return Response.json({ items: [], next_cursor: null });
        }
        if (url.pathname.endsWith("/audit/verify")) {
          return Response.json({
            valid: true,
            events_checked: 2,
            first_invalid_sequence: null,
            message: "journal is valid",
          });
        }
        if (url.pathname.endsWith("/transactions/tx-a/bundle")) {
          if (url.searchParams.get("cursor") === "1") {
            return Response.json(bundle([event(2)], null));
          }
          return Response.json(bundle([event(1)], "1"));
        }
        return Response.json(
          { error: { code: "not_found", message: "not found" } },
          { status: 404 },
        );
      });

    render(<App />);

    expect(
      await screen.findByRole("heading", {
        name: "Paged timeline transaction",
      }),
    ).toBeTruthy();
    const more = await screen.findByRole("button", {
      name: "Load later events",
    });
    fireEvent.click(more);

    await waitFor(() =>
      expect(screen.getByText("transaction / step_2")).toBeTruthy(),
    );
    expect(screen.getByText("transaction / step_1")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Load later events" }),
    ).toBeNull();
    expect(fetch).toHaveBeenCalled();
  });

  it("surfaces an asynchronous bootstrap connection failure", async () => {
    localStorage.setItem("veyra.apiUrl", "http://127.0.0.1:7843/v1/");
    localStorage.setItem("veyra.token", TOKEN);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("local daemon unavailable"),
    );

    render(<App />);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "local daemon unavailable",
    );
  });

  it.each(["before", "after"])(
    "keeps the explicit connection when saved health resolves %s it",
    async (order) => {
      const { savedHealth, explicitHealth, fetch } = setupConnectionRace();
      render(<App />);
      await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      submitExplicitConnection();
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));

      if (order === "before") {
        await act(async () =>
          savedHealth.resolve(Response.json({ status: "ok" })),
        );
        expect(
          screen.getByRole("button", { name: "Connecting…" }),
        ).toBeTruthy();
        expect(screen.queryByText("3 events verified")).toBeNull();
      }

      await act(async () =>
        explicitHealth.resolve(Response.json({ status: "ok" })),
      );
      expect(await screen.findByText("7 events verified")).toBeTruthy();

      if (order === "after") {
        await act(async () =>
          savedHealth.resolve(Response.json({ status: "ok" })),
        );
      }

      expect(screen.getByText("7 events verified")).toBeTruthy();
      expect(localStorage.getItem("veyra.apiUrl")).toBe(
        "http://127.0.0.1:7844/v1/",
      );
      expect(
        fetch.mock.calls.some(([input]) => {
          const url = requestUrl(input);
          return url.port === "7843" && !url.pathname.endsWith("/health");
        }),
      ).toBe(false);
    },
  );

  it.each(["success", "failure"])(
    "keeps a failed explicit connection retryable after a late saved %s",
    async (savedResult) => {
      const { savedHealth, explicitHealth, fetch } = setupConnectionRace();
      render(<App />);
      await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      submitExplicitConnection();
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      await act(async () =>
        explicitHealth.reject(new Error("selected daemon unavailable")),
      );
      expect((await screen.findByRole("alert")).textContent).toContain(
        "selected daemon unavailable",
      );

      await act(async () => {
        if (savedResult === "success")
          savedHealth.resolve(Response.json({ status: "ok" }));
        else savedHealth.reject(new Error("saved daemon unavailable"));
      });
      expect(screen.getByRole("alert").textContent).toContain(
        "selected daemon unavailable",
      );
      expect(
        screen.getByRole("button", { name: "Connect locally" }),
      ).toBeTruthy();
      expect(localStorage.getItem("veyra.apiUrl")).toBe(
        "http://127.0.0.1:7843/v1/",
      );

      fireEvent.click(screen.getByRole("button", { name: "Connect locally" }));
      expect(await screen.findByText("7 events verified")).toBeTruthy();
      expect(localStorage.getItem("veyra.apiUrl")).toBe(
        "http://127.0.0.1:7844/v1/",
      );
    },
  );
});

function deferredResponse() {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function requestUrl(input: Parameters<typeof globalThis.fetch>[0]) {
  return new URL(input instanceof Request ? input.url : input.toString());
}

function setupConnectionRace() {
  localStorage.setItem("veyra.apiUrl", "http://127.0.0.1:7843/v1/");
  localStorage.setItem("veyra.token", TOKEN);
  const savedHealth = deferredResponse();
  const explicitHealth = deferredResponse();
  let explicitAttempts = 0;
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/health")) {
        if (url.port === "7843") return savedHealth.promise;
        if (explicitAttempts++ === 0) return explicitHealth.promise;
        return Response.json({ status: "ok" });
      }
      if (url.pathname.endsWith("/audit/verify")) {
        return Response.json({
          valid: true,
          events_checked: url.port === "7843" ? 3 : 7,
          first_invalid_sequence: null,
          message: "journal is valid",
        });
      }
      if (
        url.pathname.endsWith("/transactions/page") ||
        url.pathname.endsWith("/audit/events/page")
      ) {
        return Response.json({ items: [], next_cursor: null });
      }
      throw new Error(`unexpected request: ${url.pathname}`);
    });
  return { savedHealth, explicitHealth, fetch };
}

function submitExplicitConnection() {
  fireEvent.change(screen.getByLabelText("API URL"), {
    target: { value: "http://127.0.0.1:7844/v1/" },
  });
  fireEvent.change(screen.getByLabelText("Administrative bearer token"), {
    target: { value: TOKEN },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect locally" }));
}
