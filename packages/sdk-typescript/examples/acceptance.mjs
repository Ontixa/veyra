import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { VeyraClient } from "./dist/src/index.js";
import { runController } from "./run-lifecycle.mjs";

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
