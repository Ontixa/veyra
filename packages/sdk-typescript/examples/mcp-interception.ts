import { VeyraApiError, VeyraClient } from "../src/index.js";
import type {
  Intent,
  JsonValue,
  PreviewOutcome,
  RunOutcome,
  TransactionBundle,
} from "../src/index.js";

/**
 * Minimal MCP-shaped tool surface intercepted by Veyra.
 *
 * This module implements the narrow stdio transport subset a tool-only MCP
 * server needs—newline-delimited JSON-RPC 2.0 `initialize`, `ping`,
 * `tools/list`, and `tools/call`—and routes the one side-effecting tool
 * through the real authenticated Veyra API. It is an interception example,
 * not a complete MCP implementation: resources, prompts, subscriptions,
 * cancellation, progress, batching, and capability-dependent features are
 * intentionally absent.
 *
 * Trust placement: this code runs inside the trusted controller boundary and
 * holds the daemon bearer. The MCP-facing agent sees only tool descriptors
 * and tool results. There is deliberately no approve, issue-capability, or
 * rollback tool: content-addressed approval and capability issuance stay with
 * the operator on the existing authenticated API. The kernel, not this file,
 * is the authority—every argument check here only shapes honest errors; deny
 * decisions come from Veyra policy.
 */

const JSON_RPC = "2.0";
const SERVER_NAME = "veyra-mcp-interception-example";
const SERVER_VERSION = "0.1.0";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];

/** Single-line JSON-RPC message bound, comfortably above the content limit. */
export const MAXIMUM_MESSAGE_LENGTH = 300_000;
const MAXIMUM_PATH_LENGTH = 1_024;
const MAXIMUM_CONTENT_BYTES = 256 * 1024;
const MAXIMUM_ID_LENGTH = 128;
const MAXIMUM_SUMMARY_LENGTH = 200;

const PARSE_ERROR = -32_700;
const INVALID_REQUEST = -32_600;
const METHOD_NOT_FOUND = -32_601;
const INVALID_PARAMS = -32_602;
const INTERNAL_ERROR = -32_603;

type JsonRpcId = string | number | null;

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface McpInterceptionOptions {
  /** Authenticated client for the local daemon; the bearer never reaches tool output. */
  client: VeyraClient;
  /** Registered agent principal this surface proposes as. */
  agentPrincipalId: string;
  /** Workspace capability name configured on the daemon (`--workspace-name`). */
  workspace: string;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonValue;
}

const TOOL_DESCRIPTORS: ToolDescriptor[] = [
  {
    name: "create_workspace_file",
    description:
      "Propose creating a file inside the Veyra-confined workspace. The call " +
      "is intercepted: it becomes an intent, is preflighted without mutation, " +
      "and waits for operator approval bound to the exact effect digest.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Clean relative workspace path (forward slashes, no traversal).",
        },
        content: {
          type: "string",
          description: "UTF-8 file content, at most 256 KiB encoded.",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "run_transaction",
    description:
      "Execute a transaction after the operator granted its exact approval. " +
      "Calls before approval are rejected by the kernel, not by this surface.",
    inputSchema: {
      type: "object",
      properties: {
        transaction_id: {
          type: "string",
          description: "Transaction identifier returned by a proposal tool.",
        },
      },
      required: ["transaction_id"],
      additionalProperties: false,
    },
  },
  {
    name: "inspect_transaction",
    description:
      "Read the authoritative journal state for one transaction: state, " +
      "decisions, approvals, executions, receipts, and verification.",
    inputSchema: {
      type: "object",
      properties: {
        transaction_id: {
          type: "string",
          description: "Transaction identifier returned by a proposal tool.",
        },
      },
      required: ["transaction_id"],
      additionalProperties: false,
    },
  },
];

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code < 32 || code === 127)) return true;
  }
  return false;
}

/** Clean relative path check mirroring the kernel's component rules. */
function cleanRelativePath(path: unknown): path is string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > MAXIMUM_PATH_LENGTH ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes(":") ||
    hasControlCharacter(path)
  ) {
    return false;
  }
  return path
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..");
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAXIMUM_ID_LENGTH &&
    /^[A-Za-z0-9_-]+$/u.test(value)
  );
}

function response(id: JsonRpcId, result: unknown): string {
  return JSON.stringify({ jsonrpc: JSON_RPC, id, result });
}

function failure(id: JsonRpcId, code: number, message: string): string {
  return JSON.stringify({
    jsonrpc: JSON_RPC,
    id,
    error: { code, message },
  });
}

function toolResult(data: JsonValue, isError: boolean): JsonValue {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
    isError,
  };
}

/** One intercepted tool surface bound to one agent principal and workspace. */
export class VeyraMcpInterception {
  readonly #options: McpInterceptionOptions;
  #initialized = false;

  constructor(options: McpInterceptionOptions) {
    this.#options = options;
  }

  /**
   * Handle one newline-delimited JSON-RPC message.
   *
   * Returns the response line to write back, or `undefined` for notifications,
   * which never produce a response. The input length and shape are bounded
   * before parsing so a malformed peer cannot trigger API calls.
   */
  async handleMessage(line: string): Promise<string | undefined> {
    if (line.length > MAXIMUM_MESSAGE_LENGTH) {
      return failure(null, PARSE_ERROR, "message exceeds the length bound");
    }
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return failure(null, PARSE_ERROR, "invalid JSON");
    }
    if (!isObject(message)) {
      // Batch arrays and primitives are not part of this surface.
      return failure(null, INVALID_REQUEST, "expected a JSON-RPC object");
    }
    const request = message as JsonRpcMessage;
    if (
      request.jsonrpc !== JSON_RPC ||
      typeof request.method !== "string" ||
      request.method.length === 0
    ) {
      return failure(
        null,
        INVALID_REQUEST,
        "expected a JSON-RPC 2.0 message with a method",
      );
    }
    const id = request.id;
    if (id === undefined) {
      // Notifications receive no response; unknown ones are ignored.
      return undefined;
    }
    if (id !== null && typeof id !== "string" && typeof id !== "number") {
      return failure(
        null,
        INVALID_REQUEST,
        "request id must be a string or number",
      );
    }
    return this.#dispatch(id, request.method, request.params);
  }

  async #dispatch(
    id: JsonRpcId,
    method: string,
    params: unknown,
  ): Promise<string> {
    if (method === "initialize") return this.#initialize(id, params);
    if (method === "ping") return response(id, {});
    if (!this.#initialized) {
      return failure(
        id,
        INVALID_REQUEST,
        "initialize must precede tool traffic",
      );
    }
    try {
      if (method === "tools/list") {
        return response(id, { tools: TOOL_DESCRIPTORS });
      }
      if (method === "tools/call") {
        return response(id, await this.#callTool(params));
      }
      return failure(id, METHOD_NOT_FOUND, "unknown method");
    } catch (error) {
      const message =
        error instanceof VeyraApiError
          ? `daemon rejected the request (${error.code})`
          : "interception failed; inspect daemon evidence";
      return failure(id, INTERNAL_ERROR, message);
    }
  }

  #initialize(id: JsonRpcId, params: unknown): string {
    if (!isObject(params) || typeof params.protocolVersion !== "string") {
      return failure(
        id,
        INVALID_PARAMS,
        "initialize requires params.protocolVersion",
      );
    }
    const requested = params.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : DEFAULT_PROTOCOL_VERSION;
    this.#initialized = true;
    return response(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions:
        "Side-effecting tools are intercepted by Veyra: proposals produce " +
        "transactions that require operator approval bound to the exact " +
        "effect digest. This surface cannot grant approvals or capabilities.",
    });
  }

  async #callTool(params: unknown): Promise<JsonValue> {
    if (!isObject(params) || typeof params.name !== "string") {
      return toolResult(
        { status: "invalid_params", detail: "tools/call requires a name" },
        true,
      );
    }
    const args = params.arguments === undefined ? {} : params.arguments;
    if (!isObject(args)) {
      return toolResult(
        { status: "invalid_params", detail: "arguments must be an object" },
        true,
      );
    }
    if (params.name === "create_workspace_file") {
      return this.#createWorkspaceFile(args);
    }
    if (params.name === "run_transaction") {
      return this.#runTransaction(args);
    }
    if (params.name === "inspect_transaction") {
      return this.#inspectTransaction(args);
    }
    return toolResult(
      { status: "unknown_tool", tool: params.name.slice(0, MAXIMUM_ID_LENGTH) },
      true,
    );
  }

  async #createWorkspaceFile(
    args: Record<string, unknown>,
  ): Promise<JsonValue> {
    if (!cleanRelativePath(args.path)) {
      return toolResult(
        {
          status: "invalid_params",
          detail:
            "path must be a clean relative workspace path without traversal",
        },
        true,
      );
    }
    if (typeof args.content !== "string") {
      return toolResult(
        { status: "invalid_params", detail: "content must be a string" },
        true,
      );
    }
    if (new TextEncoder().encode(args.content).length > MAXIMUM_CONTENT_BYTES) {
      return toolResult(
        { status: "invalid_params", detail: "content exceeds 256 KiB" },
        true,
      );
    }
    const path = args.path;
    const content = args.content;
    const { client, agentPrincipalId, workspace } = this.#options;
    const intent: Intent = {
      schema_version: "veyra.protocol/v1",
      id: crypto.randomUUID(),
      principal_id: agentPrincipalId,
      summary: `Intercepted MCP create_workspace_file for ${path}`.slice(
        0,
        MAXIMUM_SUMMARY_LENGTH,
      ),
      // The envelope is exactly the file path, so the plan cannot expand it.
      requested_resources: [{ kind: "filesystem", workspace, path }],
      context: { workspace, operation: "create", path, content },
      created_at: new Date().toISOString(),
    };
    let preview: PreviewOutcome;
    try {
      const submission = await client.submitIntent(intent);
      preview = await client.previewTransaction(submission.transaction.id);
    } catch (error) {
      return toolResult(apiFailure("proposal_rejected", error), true);
    }
    const transactionId = preview.transaction.id;
    const effects = preview.plan.steps.flatMap((step) => step.effects);
    const reasons = preview.decisions.flatMap((decision) => decision.reasons);
    if (preview.transaction.state === "denied") {
      return toolResult(
        {
          status: "denied",
          transactionId,
          reasons,
          detail:
            "Veyra policy denied the proposal; no approval was requested and " +
            "no capability use was consumed.",
        },
        false,
      );
    }
    if (preview.approval_requests.length !== 1 || effects.length !== 1) {
      return toolResult(
        {
          status: preview.transaction.state,
          transactionId,
          reasons,
          detail: "unexpected policy outcome; inspect the transaction bundle",
        },
        true,
      );
    }
    const request = preview.approval_requests[0]!;
    const effect = effects[0]!;
    return toolResult(
      {
        status: "awaiting_approval",
        transactionId,
        approvalRequestId: request.id,
        effectId: effect.id,
        effectDigest: request.effect_digest,
        risk: request.risk,
        resource: request.resource,
        preview: request.preview as JsonValue,
        detail:
          "Execution waits for an operator grant bound to effectDigest. " +
          "This tool surface cannot approve; call run_transaction after the " +
          "operator grants the request on the authenticated API.",
      },
      false,
    );
  }

  async #runTransaction(args: Record<string, unknown>): Promise<JsonValue> {
    if (!validIdentifier(args.transaction_id)) {
      return toolResult(
        {
          status: "invalid_params",
          detail: "transaction_id must be a bounded identifier string",
        },
        true,
      );
    }
    let outcome: RunOutcome;
    try {
      outcome = await this.#options.client.runTransaction(args.transaction_id);
    } catch (error) {
      return toolResult(apiFailure("run_rejected", error), true);
    }
    const verificationsPassed =
      outcome.verifications.length > 0 &&
      outcome.verifications.every(
        (verification) =>
          verification.passed &&
          verification.checks.every((check) => check.passed),
      );
    return toolResult(
      {
        status: outcome.committed ? "committed" : outcome.transaction.state,
        transactionId: outcome.transaction.id,
        receipts: outcome.receipts.map((receipt) => ({
          id: receipt.id,
          effectId: receipt.effect_id,
          effectDigest: receipt.effect_digest,
          resultDigest: receipt.result_digest,
          outcome: receipt.outcome,
        })),
        verificationsPassed,
        detail: outcome.committed
          ? "effect executed through the approved capability and verified"
          : "execution did not commit; inspect the transaction bundle",
      },
      !outcome.committed,
    );
  }

  async #inspectTransaction(args: Record<string, unknown>): Promise<JsonValue> {
    if (!validIdentifier(args.transaction_id)) {
      return toolResult(
        {
          status: "invalid_params",
          detail: "transaction_id must be a bounded identifier string",
        },
        true,
      );
    }
    let bundle: TransactionBundle;
    try {
      bundle = await this.#options.client.getTransactionBundle(
        args.transaction_id,
      );
    } catch (error) {
      return toolResult(apiFailure("inspect_rejected", error), true);
    }
    return toolResult(
      {
        status: "ok",
        transactionId: bundle.transaction.id,
        state: bundle.transaction.state,
        decisions: bundle.policy_decisions.map((decision) => ({
          outcome: decision.outcome,
          reasons: decision.reasons,
        })),
        approvalRequests: bundle.approval_requests.length,
        approvalGrants: bundle.approval_grants.length,
        executions: bundle.executions.length,
        receipts: bundle.receipts.map((receipt) => ({
          id: receipt.id,
          effectId: receipt.effect_id,
          effectDigest: receipt.effect_digest,
        })),
        verificationsPassed:
          bundle.verifications.length > 0 &&
          bundle.verifications.every((verification) => verification.passed),
      },
      false,
    );
  }
}

function apiFailure(status: string, error: unknown): JsonValue {
  if (error instanceof VeyraApiError) {
    // VeyraApiError text is already token-redacted, control-safe, and bounded.
    return {
      status,
      code: error.code,
      httpStatus: error.status,
      detail: error.message,
    };
  }
  return {
    status,
    detail: "unexpected client failure; inspect daemon evidence",
  };
}
