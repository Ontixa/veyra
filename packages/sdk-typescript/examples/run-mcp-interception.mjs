import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { VeyraClient } from "./dist/src/index.js";

const SERVER_ENTRY = fileURLToPath(
  new URL("./mcp-stdio-server.mjs", import.meta.url),
);
const REQUEST_DEADLINE_MS = 30_000;

/**
 * Trusted-controller driver for the MCP interception example.
 *
 * Two roles share one process but not one authority:
 *
 * - the MCP client half speaks newline-delimited JSON-RPC to the spawned
 *   `mcp-stdio-server.mjs` child, exactly like an MCP-aware agent host would;
 * - the operator half uses the authenticated SDK directly to issue the scoped
 *   capability and grant the exact approval. Approval is not an MCP tool.
 */

/** Minimal MCP client over a child's stdio: one outstanding request at a time. */
class McpStdioClient {
  #child;
  #buffer = "";
  #pending = new Map();
  #stderr = [];

  constructor(child) {
    this.#child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#onData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.#stderr.push(chunk);
      if (this.#stderr.join("").length > 64 * 1024)
        this.#stderr = ["<bounded>"];
    });
  }

  #onData(chunk) {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.trim() === "") continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.#rejectAll(new Error("server emitted non-JSON output"));
        return;
      }
      const entry = this.#pending.get(message.id);
      if (entry) {
        this.#pending.delete(message.id);
        entry(message);
      }
    }
  }

  #rejectAll(error) {
    for (const entry of this.#pending.values()) entry(error);
    this.#pending.clear();
  }

  request(method, params) {
    const id = crypto.randomUUID();
    const line = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((accept, reject) => {
      const deadline = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`MCP request ${method} timed out`));
      }, REQUEST_DEADLINE_MS);
      this.#pending.set(id, (message) => {
        clearTimeout(deadline);
        if (message instanceof Error) reject(message);
        else accept(message);
      });
      this.#child.stdin.write(line + "\n");
    });
  }

  /** Fire-and-forget notification: no response is expected or tracked. */
  notify(method, params) {
    this.#child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n",
    );
  }

  async result(method, params) {
    const message = await this.request(method, params);
    assert.ok(
      !("error" in message),
      `MCP ${method} failed: ${JSON.stringify(message.error)}`,
    );
    return message.result;
  }

  async callTool(name, args) {
    const result = await this.result("tools/call", {
      name,
      arguments: args,
    });
    const data = result.structuredContent ?? JSON.parse(result.content[0].text);
    return { isError: result.isError === true, data };
  }

  close() {
    this.#child.kill();
  }
}

function spawnMcpServer({
  apiUrl,
  tokenFile,
  agentPrincipalId,
  workspaceName,
}) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      VEYRA_API_URL: apiUrl,
      VEYRA_TOKEN_FILE: tokenFile,
      VEYRA_AGENT_PRINCIPAL: agentPrincipalId,
      VEYRA_WORKSPACE_NAME: workspaceName,
    },
  });
  return child;
}

export async function runMcpInterception({
  apiUrl,
  tokenFile,
  workspace,
  workspaceName = "default",
  approve,
  report = console.log,
}) {
  const root = await realpath(workspace);
  const token = (await readFile(tokenFile, "utf8")).trim();
  const client = new VeyraClient({ baseUrl: apiUrl, token });
  const localPath = (path) => {
    assert.ok(
      !path.includes("\\") &&
        path.split("/").every((part) => part && part !== "." && part !== ".."),
      "Expected a clean relative fixture path",
    );
    const target = resolve(root, path);
    assert.ok(
      target.startsWith(root + sep),
      "Fixture path escapes the selected workspace",
    );
    return target;
  };
  const assertAbsent = async (path) => {
    try {
      await lstat(localPath(path));
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    throw new Error("Expected the fixture path to be absent");
  };

  // Operator side: create the delegated prefix inside the disposable
  // workspace (the confined adapter opens every parent component), register
  // the human and the agent principal the MCP surface proposes as, then
  // delegate a single-use create capability scoped to the mcp/ prefix. This
  // is the authority boundary: the MCP server and its client can propose,
  // but only this grant authorizes.
  await mkdir(localPath("mcp"), { recursive: true });
  const human = await client.registerPrincipal({
    id: crypto.randomUUID(),
    display_name: "MCP example operator",
    kind: "human",
  });
  const agent = await client.registerPrincipal({
    id: crypto.randomUUID(),
    display_name: "MCP tool agent",
    kind: "agent",
  });
  const now = Date.now();
  await client.issueCapability(human.id, {
    id: crypto.randomUUID(),
    principal_id: agent.id,
    intent_id: null,
    transaction_id: null,
    adapter: "filesystem",
    operations: ["create"],
    resources: [{ kind: "filesystem", workspace: workspaceName, path: "mcp" }],
    constraints: { max_timeout_ms: "5000", max_risk: "medium" },
    not_before: new Date(now - 1_000).toISOString(),
    expires_at: new Date(now + 10 * 60_000).toISOString(),
    nonce: `mcp-example-${crypto.randomUUID()}`,
    max_uses: 1,
    issued_at: new Date(now).toISOString(),
  });
  report("Operator issued a one-use filesystem create capability under mcp/");

  const child = spawnMcpServer({
    apiUrl,
    tokenFile,
    agentPrincipalId: agent.id,
    workspaceName,
  });
  const exited = new Promise((accept) => {
    child.once("exit", accept);
    child.once("error", accept);
  });
  const mcp = new McpStdioClient(child);
  try {
    const initialize = await mcp.result("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mcp-interception-driver", version: "0.1.0" },
    });
    assert.equal(initialize.serverInfo.name, "veyra-mcp-interception-example");
    mcp.notify("notifications/initialized");
    const tools = await mcp.result("tools/list");
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ["create_workspace_file", "inspect_transaction", "run_transaction"],
      "Tool surface differs from the declared interception set",
    );
    assert.ok(
      !tools.tools.some((tool) => /approv|capabilit|revoke/i.test(tool.name)),
      "The MCP surface must not expose authority tools",
    );
    report("MCP handshake complete; tool surface lists no approval authority");

    const suffix = crypto.randomUUID().slice(0, 8);
    const path = `mcp/report-${suffix}.txt`;
    const content = "Intercepted by Veyra before the filesystem saw it.\n";
    const proposed = await mcp.callTool("create_workspace_file", {
      path,
      content,
    });
    assert.equal(proposed.isError, false);
    assert.equal(proposed.data.status, "awaiting_approval");
    const transactionId = proposed.data.transactionId;
    assert.ok(proposed.data.approvalRequestId && proposed.data.effectDigest);
    await assertAbsent(path);
    report("Tool call intercepted; transaction awaits exact approval");

    // The agent may ask the kernel to execute, but the kernel—not the MCP
    // surface—rejects the call because no grant exists yet.
    const premature = await mcp.callTool("run_transaction", {
      transaction_id: transactionId,
    });
    assert.equal(premature.isError, true);
    assert.equal(premature.data.status, "run_rejected");
    assert.equal(premature.data.code, "transaction_conflict");
    await assertAbsent(path);
    report("Kernel rejected execution before approval; workspace unchanged");

    // Operator review uses the authoritative bundle, not the relayed fields.
    const bundle = await client.getTransactionBundle(transactionId);
    assert.equal(bundle.transaction.state, "awaiting_approval");
    assert.equal(bundle.approval_requests.length, 1);
    const request = bundle.approval_requests[0];
    assert.equal(request.id, proposed.data.approvalRequestId);
    assert.equal(request.effect_digest, proposed.data.effectDigest);
    if (!(await approve(request))) {
      report(
        "Operator declined; transaction remains awaiting approval with no effect",
      );
      await assertAbsent(path);
      return { status: "declined", transactionId };
    }
    const approval = await client.grantApproval(request.id, human.id);
    assert.equal(approval.transaction.state, "approved");
    report("Operator granted the exact content-addressed approval");

    const run = await mcp.callTool("run_transaction", {
      transaction_id: transactionId,
    });
    assert.equal(run.isError, false);
    assert.equal(run.data.status, "committed");
    assert.equal(run.data.receipts.length, 1);
    assert.equal(run.data.receipts[0].effectDigest, request.effect_digest);
    assert.equal(run.data.verificationsPassed, true);
    const handle = await open(localPath(path), "r");
    try {
      assert.ok((await handle.stat()).isFile());
      assert.equal(await handle.readFile("utf8"), content);
    } finally {
      await handle.close();
    }
    report("Approved effect committed; receipt and postconditions verified");

    const inspected = await mcp.callTool("inspect_transaction", {
      transaction_id: transactionId,
    });
    assert.equal(inspected.data.state, "committed");
    assert.equal(inspected.data.receipts.length, 1);

    // A clean path outside the capability prefix is denied by Veyra policy,
    // not by the tool schema: the agent reached the real authority boundary.
    const deniedPath = `outside-${suffix}.txt`;
    const denied = await mcp.callTool("create_workspace_file", {
      path: deniedPath,
      content: "This proposal exceeds the delegated prefix.\n",
    });
    assert.equal(denied.isError, false);
    assert.equal(denied.data.status, "denied");
    await assertAbsent(deniedPath);
    report("Out-of-scope tool call denied by kernel policy; nothing executed");

    const audit = await client.verifyAudit();
    assert.ok(audit.valid && audit.events_checked > 0);
    report(`Audit chain valid (${audit.events_checked} events)`);
    return {
      status: "committed",
      transactionId,
      deniedTransactionId: denied.data.transactionId,
      receiptId: run.data.receipts[0].id,
      effectDigest: request.effect_digest,
      auditEvents: audit.events_checked,
    };
  } finally {
    mcp.close();
    await exited;
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      "api-url": { type: "string", default: "http://127.0.0.1:7843/v1/" },
      "token-file": { type: "string" },
      workspace: { type: "string" },
      "workspace-name": { type: "string", default: "default" },
      "demo-approve": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      "Usage: pnpm --filter @veyra/sdk example:mcp --token-file PATH --workspace PATH [--api-url URL] [--workspace-name NAME] [--demo-approve]",
    );
    console.log(
      "Intercepts a minimal MCP stdio tool surface through Veyra. --demo-approve is test authorization, not human authentication.",
    );
    return;
  }
  assert.ok(
    values["token-file"] && values.workspace,
    "Provide --token-file and the daemon's exact --workspace directory",
  );
  const result = await runMcpInterception({
    apiUrl: values["api-url"],
    tokenFile: values["token-file"],
    workspace: values.workspace,
    workspaceName: values["workspace-name"],
    approve: async (request) => {
      console.log("Review the exact intercepted effect before approving:");
      console.log(
        JSON.stringify(
          {
            effectDigest: request.effect_digest,
            resource: request.resource,
            risk: request.risk,
            preview: request.preview,
          },
          null,
          2,
        ),
      );
      if (values["demo-approve"]) {
        console.log(
          "Explicit --demo-approve: granting this fixture only; no human identity proof",
        );
        return true;
      }
      if (!process.stdin.isTTY) {
        console.log(
          "No interactive terminal: approval declined (use --demo-approve only for disposable acceptance)",
        );
        return false;
      }
      const input = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        return (
          (
            await input.question(
              "Type the exact effect digest to approve, or Enter to decline: ",
            )
          ).trim() === request.effect_digest
        );
      } finally {
        input.close();
      }
    },
  });
  console.log(JSON.stringify(result, null, 2));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await main();
  } catch (error) {
    console.error(
      error && error.name === "VeyraApiError"
        ? `MCP interception failed: HTTP ${error.status} (${error.code}); inspect the retained daemon evidence`
        : "MCP interception failed: check arguments, daemon state and retained evidence; no automatic retry or cleanup",
    );
    process.exitCode = 1;
  }
}
