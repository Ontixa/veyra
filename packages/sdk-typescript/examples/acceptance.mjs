import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { VeyraClient } from "./dist/src/index.js";
import { runController } from "./run-lifecycle.mjs";
import { runMcpInterception } from "./run-mcp-interception.mjs";
import { runA2aExchange } from "./run-a2a-receipts.mjs";

const MCP_SERVER_ENTRY = fileURLToPath(
  new URL("./mcp-stdio-server.mjs", import.meta.url),
);

/** Start a disposable daemon on an ephemeral loopback port. */
async function startDaemon(executable, fixture) {
  const data = join(fixture, "data");
  const workspace = join(fixture, "workspace");
  const server = spawn(
    resolve(executable),
    [
      "--bind",
      "127.0.0.1:0",
      "--data-directory",
      data,
      "--workspace",
      workspace,
    ],
    { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
  );
  const exited = new Promise((accept) => {
    server.once("exit", accept);
    server.once("error", accept);
  });
  let startup = "";
  const apiUrl = await new Promise((accept, reject) => {
    const deadline = setTimeout(
      () => reject(new Error("Daemon startup timed out")),
      30_000,
    );
    server.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    server.once("exit", () => {
      clearTimeout(deadline);
      reject(new Error("Daemon exited before readiness"));
    });
    server.stderr.on("data", (chunk) => {
      startup = (startup + chunk.toString()).slice(-8192);
      const address =
        /Veyra API listening at (http:\/\/127\.0\.0\.1:\d+\/v1)/u.exec(
          startup,
        )?.[1];
      if (address) {
        clearTimeout(deadline);
        accept(address + "/");
      }
    });
  });
  return { server, exited, apiUrl, data, workspace };
}

async function runCli({ apiUrl, tokenFile, workspace, token, demoApprove }) {
  const arguments_ = [
    fileURLToPath(new URL("./run-lifecycle.mjs", import.meta.url)),
    "--api-url",
    apiUrl,
    "--token-file",
    tokenFile,
    "--workspace",
    workspace,
  ];
  if (demoApprove) arguments_.push("--demo-approve");
  const output = await new Promise((accept, reject) => {
    const child = spawn(process.execPath, arguments_, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const streams = { stdout: [], stderr: [] };
    let bytes = 0;
    let failure;
    const fail = (message) => {
      failure ??= new Error(message);
      child.kill();
    };
    const deadline = setTimeout(
      () => fail("CLI exceeded its 30-second bound"),
      30_000,
    );
    for (const name of ["stdout", "stderr"]) {
      child[name].on("data", (chunk) => {
        if (failure) return;
        bytes += chunk.length;
        if (bytes > 64 * 1024) {
          fail("CLI exceeded its 64 KiB output bound");
          return;
        }
        streams[name].push(chunk);
      });
      child[name].on("error", () => fail("CLI output stream failed"));
    }
    child.once("error", () => {
      failure ??= new Error("CLI failed to start");
    });
    child.once("close", (code) => {
      clearTimeout(deadline);
      if (failure) reject(failure);
      else
        accept({
          code,
          stdout: Buffer.concat(streams.stdout).toString("utf8"),
          stderr: Buffer.concat(streams.stderr).toString("utf8"),
        });
    });
  });
  assert.ok(
    !output.stdout.includes(token) && !output.stderr.includes(token),
    "CLI output must not expose bearer credentials",
  );
  assert.equal(output.code, 0, "CLI failed; inspect retained daemon evidence");
  const start = output.stdout.lastIndexOf("\n{");
  assert.ok(start >= 0, "CLI did not emit its final lifecycle result");
  let result;
  try {
    result = JSON.parse(output.stdout.slice(start + 1).trim());
  } catch {
    throw new Error("CLI did not emit valid lifecycle JSON");
  }
  assert.ok(
    result && typeof result.transactionId === "string",
    "CLI result did not contain a transaction ID",
  );
  return result;
}

async function assertFixtureAbsent(bundle, workspace) {
  const effects = bundle.plan.steps.flatMap((step) => step.effects);
  assert.equal(effects.length, 1);
  const resource = effects[0].resource;
  assert.equal(resource.kind, "filesystem");
  assert.ok(
    !resource.path.includes("\\") &&
      resource.path
        .split("/")
        .every((part) => part && part !== "." && part !== ".."),
    "Expected a clean fixture path",
  );
  const target = resolve(workspace, resource.path);
  assert.ok(
    target.startsWith(resolve(workspace) + sep),
    "Fixture path must stay in its workspace",
  );
  await assert.rejects(lstat(target), (error) => error.code === "ENOENT");
}

test(
  "real daemon: controller lifecycle and actual non-TTY CLI decline/approval",
  { timeout: 120_000 },
  async () => {
    const executable = process.env.VEYRA_EXAMPLE_SERVER;
    assert.ok(
      executable,
      "Set VEYRA_EXAMPLE_SERVER to the built veyra-server executable",
    );
    const fixture = await mkdtemp(join(tmpdir(), "veyra-sdk-lifecycle-"));
    const data = join(fixture, "data");
    const workspace = join(fixture, "workspace");
    console.log(`Retained lifecycle evidence: ${fixture}`);
    const server = spawn(
      resolve(executable),
      [
        "--bind",
        "127.0.0.1:0",
        "--data-directory",
        data,
        "--workspace",
        workspace,
      ],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
    );
    const exited = new Promise((accept) => {
      server.once("exit", accept);
      server.once("error", accept);
    });
    let startup = "";
    try {
      const apiUrl = await new Promise((accept, reject) => {
        const deadline = setTimeout(
          () => reject(new Error("Daemon startup timed out")),
          30_000,
        );
        server.once("error", (error) => {
          clearTimeout(deadline);
          reject(error);
        });
        server.once("exit", () => {
          clearTimeout(deadline);
          reject(new Error("Daemon exited before readiness"));
        });
        server.stderr.on("data", (chunk) => {
          startup = (startup + chunk.toString()).slice(-8192);
          const address =
            /Veyra API listening at (http:\/\/127\.0\.0\.1:\d+\/v1)/u.exec(
              startup,
            )?.[1];
          if (address) {
            clearTimeout(deadline);
            accept(address + "/");
          }
        });
      });
      const tokenFile = join(data, "api-token");
      let approvals = 0;
      const completed = await runController({
        apiUrl,
        tokenFile,
        workspace,
        approve: async (request) => {
          approvals++;
          assert.ok(request.effect_digest);
          return true;
        },
      });
      assert.equal(completed.status, "rolled_back");
      assert.equal(approvals, 1);
      const declined = await runController({
        apiUrl,
        tokenFile,
        workspace,
        approve: async () => false,
      });
      assert.equal(declined.status, "declined");
      const token = (await readFile(tokenFile, "utf8")).trim();
      assert.ok(token.length > 0, "Daemon token file must not be empty");
      const client = new VeyraClient({
        baseUrl: apiUrl,
        token,
      });
      const bundle = await client.getTransactionBundle(declined.transactionId);
      assert.equal(bundle.transaction.state, "awaiting_approval");
      assert.equal(bundle.approval_grants.length, 0);
      assert.equal(bundle.executions.length, 0);
      assert.equal(bundle.receipts.length, 0);
      assert.equal((await client.verifyAudit()).valid, true);

      const cliOptions = { apiUrl, tokenFile, workspace, token };
      const cliDeclined = await runCli({ ...cliOptions, demoApprove: false });
      assert.equal(cliDeclined.status, "declined");
      const declinedBundle = await client.getTransactionBundle(
        cliDeclined.transactionId,
      );
      assert.equal(declinedBundle.transaction.state, "awaiting_approval");
      assert.equal(declinedBundle.approval_grants.length, 0);
      assert.equal(declinedBundle.executions.length, 0);
      assert.equal(declinedBundle.receipts.length, 0);
      await assertFixtureAbsent(declinedBundle, workspace);
      console.log(
        "Actual non-TTY CLI declined without grant, execution or receipt",
      );

      const cliApproved = await runCli({ ...cliOptions, demoApprove: true });
      assert.equal(cliApproved.status, "rolled_back");
      const approvedBundle = await client.getTransactionBundle(
        cliApproved.transactionId,
      );
      assert.equal(approvedBundle.transaction.state, "rolled_back");
      assert.equal(approvedBundle.approval_grants.length, 1);
      assert.equal(approvedBundle.executions.length, 1);
      assert.equal(approvedBundle.receipts.length, 1);
      assert.equal(approvedBundle.compensations.length, 1);
      await assertFixtureAbsent(approvedBundle, workspace);
      assert.equal((await client.verifyAudit()).valid, true);
      console.log(
        "Actual --demo-approve CLI rolled back one approved effect; bearer absent from captured output",
      );
    } finally {
      if (server.exitCode === null) server.kill();
      await exited;
    }
  },
);

/** Run an example CLI as a bounded child and return its output and exit code. */
async function runExampleCli({ script, args, token }) {
  const output = await new Promise((accept, reject) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL(script, import.meta.url)), ...args],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    const streams = { stdout: [], stderr: [] };
    let bytes = 0;
    let failure;
    const fail = (message) => {
      failure ??= new Error(message);
      child.kill();
    };
    const deadline = setTimeout(
      () => fail("example CLI exceeded its 60-second bound"),
      60_000,
    );
    for (const name of ["stdout", "stderr"]) {
      child[name].on("data", (chunk) => {
        if (failure) return;
        bytes += chunk.length;
        if (bytes > 256 * 1024) {
          fail("example CLI exceeded its 256 KiB output bound");
          return;
        }
        streams[name].push(chunk);
      });
      child[name].on("error", () => fail("example CLI output stream failed"));
    }
    child.once("error", () => {
      failure ??= new Error("example CLI failed to start");
    });
    child.once("close", (code) => {
      clearTimeout(deadline);
      if (failure) reject(failure);
      else
        accept({
          code,
          stdout: Buffer.concat(streams.stdout).toString("utf8"),
          stderr: Buffer.concat(streams.stderr).toString("utf8"),
        });
    });
  });
  assert.ok(
    !output.stdout.includes(token) && !output.stderr.includes(token),
    "Example output must not expose bearer credentials",
  );
  return output;
}

/** Collect newline-delimited JSON-RPC responses from a spawned MCP server. */
function mcpProbe(child) {
  const state = { text: "", messages: [], waiters: [] };
  const deliver = (message) => {
    const index = state.waiters.findIndex((waiter) => waiter.id === message.id);
    if (index >= 0) {
      const [waiter] = state.waiters.splice(index, 1);
      clearTimeout(waiter.deadline);
      waiter.accept(message);
    } else {
      state.messages.push(message);
    }
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    state.text += chunk;
    for (;;) {
      const newline = state.text.indexOf("\n");
      if (newline < 0) return;
      const line = state.text.slice(0, newline);
      state.text = state.text.slice(newline + 1);
      if (line.trim() === "") continue;
      deliver(JSON.parse(line));
    }
  });
  return (id) =>
    new Promise((accept, reject) => {
      const existing = state.messages.findIndex((message) => message.id === id);
      if (existing >= 0) {
        accept(state.messages.splice(existing, 1)[0]);
        return;
      }
      const deadline = setTimeout(
        () => reject(new Error("MCP probe timed out")),
        30_000,
      );
      state.waiters.push({ id, accept, deadline });
    });
}

test(
  "real daemon: MCP interception and A2A receipt exchange",
  { timeout: 120_000 },
  async () => {
    const executable = process.env.VEYRA_EXAMPLE_SERVER;
    assert.ok(
      executable,
      "Set VEYRA_EXAMPLE_SERVER to the built veyra-server executable",
    );
    const fixture = await mkdtemp(join(tmpdir(), "veyra-sdk-mcp-a2a-"));
    console.log(`Retained MCP/A2A evidence: ${fixture}`);
    const { server, exited, apiUrl, data, workspace } = await startDaemon(
      executable,
      fixture,
    );
    const tokenFile = join(data, "api-token");
    try {
      const token = (await readFile(tokenFile, "utf8")).trim();
      const client = new VeyraClient({ baseUrl: apiUrl, token });

      // Programmatic drive: full interception flow through the real
      // spawned stdio server, including kernel denial and decline paths.
      const committed = await runMcpInterception({
        apiUrl,
        tokenFile,
        workspace,
        approve: async () => true,
        report: () => {},
      });
      assert.equal(committed.status, "committed");
      const committedBundle = await client.getTransactionBundle(
        committed.transactionId,
      );
      assert.equal(committedBundle.transaction.state, "committed");
      assert.equal(committedBundle.approval_grants.length, 1);
      assert.equal(committedBundle.executions.length, 1);
      assert.equal(committedBundle.receipts.length, 1);
      assert.equal(
        committedBundle.receipts[0].effect_digest,
        committed.effectDigest,
      );
      assert.equal(
        (await client.getTransactionBundle(committed.deniedTransactionId))
          .transaction.state,
        "denied",
      );

      const declined = await runMcpInterception({
        apiUrl,
        tokenFile,
        workspace,
        approve: async () => false,
        report: () => {},
      });
      assert.equal(declined.status, "declined");
      const declinedBundle = await client.getTransactionBundle(
        declined.transactionId,
      );
      assert.equal(declinedBundle.transaction.state, "awaiting_approval");
      assert.equal(declinedBundle.approval_grants.length, 0);
      assert.equal(declinedBundle.executions.length, 0);
      assert.equal(declinedBundle.receipts.length, 0);
      console.log("In-process MCP interception passed success and decline");

      // Protocol-level probes against the spawned stdio surface: malformed
      // input, pre-initialize traffic, and an authority-looking tool name.
      const agent = await client.registerPrincipal({
        id: crypto.randomUUID(),
        display_name: "MCP probe agent",
        kind: "agent",
      });
      const mcpChild = spawn(process.execPath, [MCP_SERVER_ENTRY], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: {
          ...process.env,
          VEYRA_API_URL: apiUrl,
          VEYRA_TOKEN_FILE: tokenFile,
          VEYRA_AGENT_PRINCIPAL: agent.id,
          VEYRA_WORKSPACE_NAME: "default",
        },
      });
      const mcpExited = new Promise((accept) => {
        mcpChild.once("exit", accept);
        mcpChild.once("error", accept);
      });
      try {
        const next = mcpProbe(mcpChild);
        mcpChild.stdin.write("this is not json\n");
        const parse = await next(null);
        assert.equal(parse.error.code, -32700);
        mcpChild.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "pre-init",
            method: "tools/call",
            params: { name: "run_transaction", arguments: {} },
          }) + "\n",
        );
        const early = await next("pre-init");
        assert.equal(early.error.code, -32600);
        mcpChild.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "init",
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "probe", version: "0" },
            },
          }) + "\n",
        );
        const init = await next("init");
        assert.equal(
          init.result.serverInfo.name,
          "veyra-mcp-interception-example",
        );
        mcpChild.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "bogus",
            method: "tools/call",
            params: { name: "grant_approval", arguments: {} },
          }) + "\n",
        );
        const bogus = await next("bogus");
        assert.equal(bogus.result.isError, true);
        assert.equal(bogus.result.structuredContent.status, "unknown_tool");
        mcpChild.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "escape",
            method: "tools/call",
            params: {
              name: "create_workspace_file",
              arguments: { path: "../outside.txt", content: "x" },
            },
          }) + "\n",
        );
        const escape = await next("escape");
        assert.equal(escape.result.isError, true);
        assert.equal(escape.result.structuredContent.status, "invalid_params");
        console.log(
          "MCP surface rejected malformed input, pre-init traffic, unknown and traversal calls",
        );
      } finally {
        mcpChild.kill();
        await mcpExited;
      }

      // A2A exchange: producer commits, consumer reconciles the claim.
      const a2a = await runA2aExchange({
        apiUrl,
        tokenFile,
        workspace,
        approve: async () => true,
        report: () => {},
      });
      assert.equal(a2a.status, "accepted");
      const a2aBundle = await client.getTransactionBundle(a2a.transactionId);
      assert.equal(a2aBundle.transaction.state, "committed");
      assert.equal(a2aBundle.receipts.length, 1);
      assert.equal(a2aBundle.receipts[0].id, a2a.receiptId);
      assert.equal((await client.verifyAudit()).valid, true);
      console.log("In-process A2A receipt exchange reconciled and accepted");

      // Actual CLI children exercise argument parsing and stdio spawning.
      const mcpCli = await runExampleCli({
        script: "./run-mcp-interception.mjs",
        args: [
          "--api-url",
          apiUrl,
          "--token-file",
          tokenFile,
          "--workspace",
          workspace,
          "--demo-approve",
        ],
        token,
      });
      assert.equal(mcpCli.code, 0, "MCP example CLI failed");
      assert.ok(mcpCli.stdout.includes('"status": "committed"'));
      const a2aCli = await runExampleCli({
        script: "./run-a2a-receipts.mjs",
        args: [
          "--api-url",
          apiUrl,
          "--token-file",
          tokenFile,
          "--workspace",
          workspace,
          "--demo-approve",
        ],
        token,
      });
      assert.equal(a2aCli.code, 0, "A2A example CLI failed");
      assert.ok(a2aCli.stdout.includes('"status": "accepted"'));
      assert.equal((await client.verifyAudit()).valid, true);
      console.log(
        "Actual --demo-approve MCP and A2A example CLIs passed; bearer absent from captured output",
      );
    } finally {
      if (server.exitCode === null) server.kill();
      await exited;
    }
  },
);
