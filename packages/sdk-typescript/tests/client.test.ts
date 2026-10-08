import { describe, expect, it, vi } from "vitest";

import { VeyraApiError, VeyraClient } from "../src/index.js";

const TOKEN = `vyr_${"a".repeat(64)}`;

describe("VeyraClient", () => {
  it("binds auth to a loopback v1 request and encodes IDs", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ id: "tx" }));
    const client = new VeyraClient({
      baseUrl: "http://127.0.0.1:7843/v1",
      token: TOKEN,
      fetch,
    });

    await client.getTransaction("id/with/slashes");

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url.toString()).toBe(
      "http://127.0.0.1:7843/v1/transactions/id%2Fwith%2Fslashes",
    );
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(init?.redirect).toBe("error");
    expect(init?.credentials).toBe("omit");
  });

  it.each([
    {
      inputCode: "insufficient_authority",
      expectedCode: "insufficient_authority",
    },
    { inputCode: 403, expectedCode: "api_error" },
  ])(
    "returns safe typed API errors for code $inputCode",
    async ({ inputCode, expectedCode }) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        Response.json(
          {
            error: {
              code: inputCode,
              message: `capability missing ${TOKEN}\n\u001b[31m${"🙂".repeat(1_100)}`,
            },
          },
          { status: 403 },
        ),
      );
      const client = new VeyraClient({
        baseUrl: "http://localhost:7843/v1/",
        token: TOKEN,
        fetch,
      });

      const error = await client
        .runTransaction("tx")
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(VeyraApiError);
      if (!(error instanceof VeyraApiError))
        throw new Error("expected API error");
      expect(error).toMatchObject({
        status: 403,
        code: expectedCode,
      });
      expect(error.message).toContain("[REDACTED]");
      expect(error.message).not.toContain(TOKEN);
      expect(error.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
      expect(Array.from(error.message)).toHaveLength(1_024);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it.each<{
    label: string;
    body: unknown;
    code?: string;
    message?: string;
  }>([
    { label: "null envelope", body: null },
    { label: "string envelope", body: "unavailable" },
    { label: "number envelope", body: 500 },
    { label: "boolean envelope", body: false },
    { label: "array envelope", body: [{ error: { code: "ignored" } }] },
    { label: "missing error", body: {} },
    { label: "null error", body: { error: null } },
    { label: "string error", body: { error: "unavailable" } },
    { label: "number error", body: { error: 500 } },
    { label: "boolean error", body: { error: false } },
    { label: "array error", body: { error: ["unavailable"] } },
    { label: "missing fields", body: { error: {} } },
    { label: "null code", body: { error: { code: null } } },
    { label: "numeric code", body: { error: { code: 500 } } },
    { label: "boolean code", body: { error: { code: true } } },
    { label: "array code", body: { error: { code: ["internal_error"] } } },
    { label: "object code", body: { error: { code: {} } } },
    {
      label: "invalid string code",
      body: { error: { code: "Internal-Error" } },
    },
    { label: "empty code", body: { error: { code: "" } } },
    { label: "oversized code", body: { error: { code: "a".repeat(65) } } },
    {
      label: "null message",
      body: { error: { code: "internal_error", message: null } },
      code: "internal_error",
    },
    {
      label: "numeric message",
      body: { error: { code: "internal_error", message: 500 } },
      code: "internal_error",
    },
    {
      label: "boolean message",
      body: { error: { code: "internal_error", message: false } },
      code: "internal_error",
    },
    {
      label: "array message",
      body: { error: { code: "internal_error", message: ["unavailable"] } },
      code: "internal_error",
    },
    {
      label: "object message",
      body: {
        error: { code: "internal_error", message: { detail: "unavailable" } },
      },
      code: "internal_error",
    },
    {
      label: "missing message",
      body: { error: { code: "internal_error" } },
      code: "internal_error",
    },
    {
      label: "valid message with invalid code",
      body: {
        error: { code: 500, message: "Daemon could not finish the read" },
      },
      message: "Daemon could not finish the read",
    },
    {
      label: "valid fields",
      body: {
        error: {
          code: "internal_error",
          message: "Daemon could not finish the read",
        },
      },
      code: "internal_error",
      message: "Daemon could not finish the read",
    },
    {
      label: "valid boundary code and empty message",
      body: { error: { code: "a".repeat(64), message: "" } },
      code: "a".repeat(64),
      message: "",
    },
  ])("preserves HTTP errors for $label", async ({ body, code, message }) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json(body, { status: 500 }));
    const client = new VeyraClient({
      baseUrl: "http://127.0.0.1:7843/v1/",
      token: TOKEN,
      fetch,
    });

    const error = await client.health().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(VeyraApiError);
    expect(error).toMatchObject({
      status: 500,
      code: code ?? "api_error",
      message: message ?? "Veyra API request failed",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("preserves a non-JSON HTTP failure with fallback diagnostics", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("Service unavailable", { status: 503 }));
    const client = new VeyraClient({
      baseUrl: "http://127.0.0.1:7843/v1/",
      token: TOKEN,
      fetch,
    });

    const error = await client.health().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(VeyraApiError);
    expect(error).toMatchObject({
      status: 503,
      code: "api_error",
      message: "Veyra API request failed",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects non-loopback authority endpoints", () => {
    expect(
      () =>
        new VeyraClient({ baseUrl: "https://example.com/v1/", token: TOKEN }),
    ).toThrow(/loopback/);
    expect(
      () =>
        new VeyraClient({
          baseUrl: "http://operator:secret@127.0.0.1:7843/v1/",
          token: TOKEN,
        }),
    ).toThrow(/without credentials/);
  });

  it("bounds response bodies before JSON decoding", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ value: "too large" }));
    const client = new VeyraClient({
      baseUrl: "http://127.0.0.1:7843/v1/",
      token: TOKEN,
      fetch,
      maximumResponseBytes: 4,
    });

    await expect(client.health()).rejects.toThrow(/response exceeds/);
  });

  it("sends an empty demo body without introducing unknown fields", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({}));
    const client = new VeyraClient({
      baseUrl: "http://[::1]:7843/v1/",
      token: TOKEN,
      fetch,
    });

    await client.seedDemo();

    const [, init] = fetch.mock.calls[0]!;
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe("{}");
  });

  it("encodes opaque keyset pagination without exposing authority in the URL", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () =>
        Response.json({ items: [], next_cursor: null }),
      );
    const client = new VeyraClient({
      baseUrl: "http://127.0.0.1:7843/v1/",
      token: TOKEN,
      fetch,
    });

    await client.listTransactionPage({ limit: 25, cursor: "opaque+/=" });
    await client.auditEventPage({
      limit: 50,
      cursor: "42",
      transactionId: "transaction/id",
    });
    await client.recoveryActionPage({ limit: 10, cursor: "recovery-cursor" });
    await client.getTransactionBundle("tx/bundle", {
      limit: 500,
      cursor: "7",
    });

    expect(fetch.mock.calls[0]![0].toString()).toBe(
      "http://127.0.0.1:7843/v1/transactions/page?limit=25&cursor=opaque%2B%2F%3D",
    );
    expect(fetch.mock.calls[1]![0].toString()).toBe(
      "http://127.0.0.1:7843/v1/audit/events/page?limit=50&cursor=42&transaction_id=transaction%2Fid",
    );
    expect(fetch.mock.calls[2]![0].toString()).toBe(
      "http://127.0.0.1:7843/v1/recovery/page?limit=10&cursor=recovery-cursor",
    );
    expect(fetch.mock.calls[3]![0].toString()).toBe(
      "http://127.0.0.1:7843/v1/transactions/tx%2Fbundle/bundle?limit=500&cursor=7",
    );
    expect(fetch.mock.calls[0]![0].toString()).not.toContain(TOKEN);
  });

  it("rejects unsafe pagination values before making a request", () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new VeyraClient({
      baseUrl: "http://127.0.0.1:7843/v1/",
      token: TOKEN,
      fetch,
    });

    expect(() => client.listTransactionPage({ limit: 0 })).toThrow(
      "positive integer",
    );
    expect(() => client.auditEventPage({ cursor: "bad\ncursor" })).toThrow(
      "cursor is malformed",
    );
    expect(() =>
      client.getTransactionBundle("tx", { cursor: "bad\ncursor" }),
    ).toThrow("cursor is malformed");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed administrative bearer material", () => {
    expect(
      () =>
        new VeyraClient({
          baseUrl: "http://127.0.0.1:7843/v1/",
          token: "short",
        }),
    ).toThrow(/malformed/);
  });
});
