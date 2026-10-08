// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AuditEvent } from "@veyra/sdk";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import { auditViewExport } from "./audit-export";

const TOKEN = `vyr_${"a".repeat(64)}`;
const timestamp = "2026-10-08T09:00:00.000Z";
const event = (
  sequence: number,
  eventType = "transaction.created",
): AuditEvent => ({
  id: `event-${sequence}`,
  sequence,
  transaction_id: "transaction-full-id",
  event_type: eventType,
  causal_parent: sequence === 1 ? null : `event-${sequence - 1}`,
  payload: {
    nested: { token: "[REDACTED]", text: 'Unicode λ, newline\nquote"' },
    list: [true, null, 1],
  },
  previous_hash: "b".repeat(64),
  hash: "c".repeat(64),
  recorded_at: timestamp,
});
const events = [event(2, "transaction.committed"), event(1)];
const pageOf = (items = events, next_cursor: string | null = "older-page") =>
  Response.json({ items, next_cursor });
const failure = () =>
  Response.json(
    { error: { code: "unavailable", message: "Audit read unavailable" } },
    { status: 503 },
  );
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let blobs: Blob[];
let links: { filename: string; url: string }[];
let pageRead: (url: URL) => Promise<Response>;
let verifyRead: () => Promise<Response>;
let requests: string[];

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("veyra.apiUrl", "http://127.0.0.1:7843/v1/");
  localStorage.setItem("veyra.token", TOKEN);
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockReturnValue({ matches: false }),
  });
  blobs = [];
  links = [];
  requests = [];
  pageRead = async () => pageOf();
  verifyRead = async () =>
    Response.json({
      valid: true,
      events_checked: 2,
      first_invalid_sequence: null,
      message: "synthetic verification",
    });
  vi.stubGlobal("URL", URL);
  URL.createObjectURL = vi.fn((blob: Blob) => {
    blobs.push(blob);
    return `blob:synthetic-${blobs.length}`;
  });
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    links.push({ filename: this.download, url: this.href });
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    if (url.pathname.endsWith("/demo/seed"))
      return Response.json({
        human: { id: "human-fixture" },
        submission: { transaction: { id: "tx-new" } },
      });
    if (url.pathname.endsWith("/transactions/tx-new/bundle")) return failure();
    if (url.pathname.endsWith("/health"))
      return Response.json({
        status: "ok",
        api_version: "v1",
        protocol_version: "veyra.protocol/v1",
      });
    if (url.pathname.endsWith("/transactions/page"))
      return Response.json({ items: [], next_cursor: null });
    if (url.pathname.endsWith("/audit/events/page")) return pageRead(url);
    if (url.pathname.endsWith("/audit/verify")) return verifyRead();
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function openAudit() {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /^Audit / }));
  return screen.getByRole("button", {
    name: "Export visible JSON",
  }) as HTMLButtonElement;
}
async function exported(index = 0) {
  const content = await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(blobs[index]!);
  });
  expect(content).not.toContain(TOKEN);
  expect(content).not.toContain("127.0.0.1");
  return JSON.parse(content);
}

it("exports only matching displayed records with exact fields and honest loaded-window metadata", async () => {
  const button = await openAudit();
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "COMMITTED" },
  });
  const count = requests.length;
  fireEvent.click(button);
  const result = await exported();
  expect(result.events).toEqual([events[0]]);
  expect(screen.getByText("Download requested: 1 visible event.")).toBeTruthy();
  expect(result.filter).toEqual({
    query: "COMMITTED",
    matching: "case_insensitive_substring",
    fields: ["event_type", "transaction_id", "causal_parent"],
  });
  expect(result.window).toMatchObject({
    page_size: 200,
    loaded_event_count: 2,
    visible_event_count: 1,
    has_more_older_events: true,
    loaded_sequence_range: { first: 1, last: 2 },
    visible_sequence_range: { first: 2, last: 2 },
    order: "newest_first",
  });
  expect(Number.isNaN(Date.parse(result.window.last_loaded_at))).toBe(false);
  expect(result.schema_version).toBe("veyra.desktop-audit-view/v1");
  expect(result.notice).toContain(
    "not a complete audit archive, verified chain",
  );
  expect(result.notice).toContain("no additional client redaction");
  expect(result).not.toHaveProperty("verification");
  expect(requests).toHaveLength(count);
  expect(links[0]!.filename).toMatch(
    /^veyra-audit-view-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.json$/,
  );
  expect(blobs[0]!.type).toBe("application/json;charset=utf-8");
  expect(document.querySelector("a[download]")).toBeNull();
});

it("keeps each repeated download tied to the current query and releases every URL", async () => {
  const button = await openAudit();
  await waitFor(() => expect(button.disabled).toBe(false));
  vi.useFakeTimers();
  fireEvent.click(button);
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "created" },
  });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(links).toHaveLength(3);
  expect(new Set(links.map((link) => link.url)).size).toBe(3);
  act(() => vi.advanceTimersByTime(1000));
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3);
  vi.useRealTimers();
  expect((await exported()).events).toEqual(events);
  expect((await exported(1)).events).toEqual([events[1]]);
  expect((await exported(2)).filter.query).toBe("created");
});

it.each([{ items: [] }, { items: events }])(
  "disables empty or unmatched views and restores export when the filter clears",
  async ({ items }) => {
    pageRead = async () => pageOf(items, null);
    const button = await openAudit();
    await screen.findByText("Chain verified");
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "no-matching-event" },
    });
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(blobs).toHaveLength(0);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    expect(button.disabled).toBe(items.length === 0);
  },
);

it("waits for the full read, then exports an integrity-failed view without claiming verification", async () => {
  const pending = deferred<Response>();
  verifyRead = () => pending.promise;
  const button = await openAudit();
  expect(button.disabled).toBe(true);
  await act(async () =>
    pending.resolve(
      Response.json({
        valid: false,
        events_checked: 2,
        first_invalid_sequence: 2,
        message: "synthetic integrity failure",
      }),
    ),
  );
  expect(button.disabled).toBe(false);
  expect(screen.getByText("Integrity failure")).toBeTruthy();
  fireEvent.click(button);
  const result = await exported();
  expect(result.events).toEqual(events);
  expect(result).not.toHaveProperty("verification");
});

it.each(["events", "verification"])(
  "blocks a failed %s read and coalesces read-only recovery",
  async (kind) => {
    if (kind === "events") pageRead = async () => failure();
    else verifyRead = async () => failure();
    const button = await openAudit();
    const retry = await screen.findByRole("button", { name: "Retry audit" });
    expect(button.disabled).toBe(true);
    const pending = deferred<Response>();
    pageRead = () => pending.promise;
    verifyRead = async () =>
      Response.json({
        valid: true,
        events_checked: 2,
        first_invalid_sequence: null,
        message: "recovered",
      });
    const prior = requests.length;
    act(() => {
      fireEvent.click(retry);
      fireEvent.click(retry);
    });
    await waitFor(() => expect(requests.length - prior).toBe(2));
    expect(button.disabled).toBe(true);
    await act(async () => pending.resolve(pageOf()));
    expect(button.disabled).toBe(false);
    expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
  },
);

it("exports the current filter after a held older page, and preserves the loaded window on pagination failure", async () => {
  const button = await openAudit();
  await waitFor(() => expect(button.disabled).toBe(false));
  const pending = deferred<Response>();
  pageRead = () => pending.promise;
  const older = screen.getByRole("button", { name: "Load older evidence" });
  const count = requests.length;
  act(() => {
    fireEvent.click(older);
    fireEvent.click(older);
  });
  expect(button.disabled).toBe(true);
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "created" },
  });
  await waitFor(() => expect(requests).toHaveLength(count + 1));
  await act(async () =>
    pending.resolve(pageOf([events[1]!, event(0)], "last-page")),
  );
  fireEvent.click(button);
  const result = await exported();
  expect(result.events).toEqual([events[1], event(0)]);
  expect(result.window.loaded_event_count).toBe(3);
  expect(result.window.has_more_older_events).toBe(true);
  pageRead = async () => failure();
  fireEvent.click(older);
  await screen.findByRole("button", { name: "Retry audit" });
  expect(button.disabled).toBe(true);
  expect(screen.getByText("2 visible of 3 loaded events")).toBeTruthy();
  const retryPage = deferred<Response>();
  pageRead = () => retryPage.promise;
  const beforeRetry = requests.length;
  fireEvent.click(screen.getByRole("button", { name: "Retry audit" }));
  expect((older as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(older);
  await waitFor(() => expect(requests).toHaveLength(beforeRetry + 2));
  await act(async () => retryPage.resolve(pageOf(events, null)));
  fireEvent.click(button);
  expect((await exported(1)).window.loaded_event_count).toBe(2);
});

it("reports a failed download and permits retry without an API request", async () => {
  const button = await openAudit();
  await waitFor(() => expect(button.disabled).toBe(false));
  vi.mocked(URL.createObjectURL).mockImplementationOnce(() => {
    throw new Error("synthetic download failure");
  });
  const count = requests.length;
  fireEvent.click(button);
  expect(
    screen.getByText("Could not start the download. Try exporting again."),
  ).toBeTruthy();
  fireEvent.click(button);
  expect((await exported()).events).toEqual(events);
  expect(requests).toHaveLength(count);
});

it.each(["success", "failure"])(
  "ignores an initial audit read's late %s after a fresh audit window",
  async (outcome) => {
    const pending = deferred<Response>();
    let reads = 0;
    pageRead = () =>
      ++reads === 1
        ? pending.promise
        : Promise.resolve(pageOf([event(30)], null));
    const button = await openAudit();
    expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Create transaction" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Audit / }).textContent).toBe(
        "Audit 1",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Audit / }));
    await act(async () =>
      pending.resolve(
        outcome === "success" ? pageOf([event(0)], null) : failure(),
      ),
    );
    const current = screen.getByRole("button", {
      name: "Export visible JSON",
    }) as HTMLButtonElement;
    expect(current.disabled).toBe(false);
    fireEvent.click(current);
    const result = await exported();
    expect(result.events).toEqual([event(30)]);
    expect(result.window).toMatchObject({
      loaded_event_count: 1,
      has_more_older_events: false,
      loaded_sequence_range: { first: 30, last: 30 },
    });
    expect(screen.queryByRole("button", { name: "Retry audit" })).toBeNull();
  },
);

it("makes filenames independent of filter text and preserves empty window bounds", () => {
  const result = auditViewExport(
    {
      events: [],
      loadedEvents: [],
      query: "../../private:\nλ",
      hasMore: false,
      loadedAt: timestamp,
    },
    new Date(timestamp),
  );
  expect(result.filename).toBe(
    "veyra-audit-view-2026-10-08T09-00-00-000Z.json",
  );
  expect(JSON.parse(result.content).window).toMatchObject({
    loaded_sequence_range: null,
    visible_sequence_range: null,
    has_more_older_events: false,
  });
});

it("cleans up a URL and anchor when dispatching the download fails", async () => {
  const button = await openAudit();
  await waitFor(() => expect(button.disabled).toBe(false));
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementationOnce(() => {
    throw new Error("synthetic dispatch failure");
  });
  vi.useFakeTimers();
  fireEvent.click(button);
  expect(
    screen.getByText("Could not start the download. Try exporting again."),
  ).toBeTruthy();
  expect(document.querySelector("a[download]")).toBeNull();
  act(() => vi.advanceTimersByTime(1000));
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:synthetic-1");
});

it.each(["success", "failure"])(
  "a newer failed audit can retry while an obsolete retry awaits late %s",
  async (outcome) => {
    pageRead = async () => failure();
    await openAudit();
    const retry = await screen.findByRole("button", { name: "Retry audit" });
    const obsolete = deferred<Response>();
    let reads = 0;
    pageRead = async () => (++reads === 1 ? obsolete.promise : failure());
    fireEvent.click(retry);
    fireEvent.click(screen.getByRole("button", { name: "Create transaction" }));
    await waitFor(() => expect(reads).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: /^Audit / }));
    const currentRetry = await screen.findByRole("button", {
      name: "Retry audit",
    });
    const current = deferred<Response>();
    pageRead = async () => {
      reads += 1;
      return current.promise;
    };
    act(() => {
      fireEvent.click(currentRetry);
      fireEvent.click(currentRetry);
    });
    await waitFor(() => expect(reads).toBe(3));
    const button = screen.getByRole<HTMLButtonElement>("button", {
      name: "Export visible JSON",
    });
    await act(async () =>
      obsolete.resolve(outcome === "success" ? pageOf([event(0)]) : failure()),
    );
    expect(button.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Retry audit" })).toBeNull();
    await act(async () => current.resolve(pageOf([event(30)], null)));
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect((await exported()).events).toEqual([event(30)]);
  },
);

it("a failed replacement window cannot be recovered by paging its retained old cursor", async () => {
  const button = await openAudit();
  await waitFor(() => expect(button.disabled).toBe(false));
  pageRead = async () => failure();
  fireEvent.click(screen.getByRole("button", { name: "Create transaction" }));
  await screen.findByRole("heading", { name: "Could not load transaction" });
  fireEvent.click(screen.getByRole("button", { name: /^Audit / }));
  const retry = await screen.findByRole("button", { name: "Retry audit" });
  const older = screen.getByRole<HTMLButtonElement>("button", {
    name: "Load older evidence",
  });
  expect(older.disabled).toBe(true);
  const before = requests.length;
  fireEvent.click(older);
  expect(requests).toHaveLength(before);
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "Export visible JSON",
    }).disabled,
  ).toBe(true);
  expect(screen.getByText("2 visible of 2 loaded events")).toBeTruthy();
  pageRead = async (url) => {
    expect(url.searchParams.has("cursor")).toBe(false);
    return pageOf([event(30)], null);
  };
  fireEvent.click(retry);
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Export visible JSON",
      }).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Export visible JSON" }));
  const result = await exported();
  expect(result.events).toEqual([event(30)]);
  expect(result.window).toMatchObject({
    loaded_event_count: 1,
    has_more_older_events: false,
  });
});
