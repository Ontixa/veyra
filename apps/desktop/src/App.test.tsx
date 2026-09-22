// @vitest-environment jsdom

import {
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
});
