import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { VeyraApiError, VeyraClient } from "./dist/src/index.js";
import {
  buildReceiptTaskResult,
  decodeTaskResult,
  encodeTaskResult,
  verifyReceiptTaskResult,
} from "./dist/examples/a2a-receipts.js";

/**
 * Runnable agent-to-agent receipt exchange against the real daemon.
 *
 * The producer agent proposes and executes one filesystem create through the
 * normal Veyra boundary (capability + exact approval), then hands an
 * A2A-shaped task-result envelope to the consumer. The consumer treats the
 * envelope as untrusted and reconciles every claimed field against the
 * authoritative journal before accepting the work as done.
 */

export async function runA2aExchange({
  apiUrl,
  tokenFile,
  workspace,
  workspaceName = "default",
  messageFile,
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

  // The confined adapter opens every parent component, so the operator
  // creates the delegated a2a/ prefix inside the disposable workspace first.
  await mkdir(localPath("a2a"), { recursive: true });
  const human = await client.registerPrincipal({
    id: crypto.randomUUID(),
    display_name: "A2A example operator",
    kind: "human",
  });
  const producer = await client.registerPrincipal({
    id: crypto.randomUUID(),
    display_name: "A2A producer agent",
    kind: "agent",
  });
  await client.registerPrincipal({
    id: crypto.randomUUID(),
    display_name: "A2A consumer agent",
    kind: "agent",
  });
  const now = Date.now();
  await client.issueCapability(human.id, {
    id: crypto.randomUUID(),
    principal_id: producer.id,
    intent_id: null,
    transaction_id: null,
    adapter: "filesystem",
    operations: ["create"],
    resources: [{ kind: "filesystem", workspace: workspaceName, path: "a2a" }],
    constraints: { max_timeout_ms: "5000", max_risk: "medium" },
    not_before: new Date(now - 1_000).toISOString(),
    expires_at: new Date(now + 10 * 60_000).toISOString(),
    nonce: `a2a-example-${crypto.randomUUID()}`,
    max_uses: 1,
    issued_at: new Date(now).toISOString(),
  });
  report("Operator issued a one-use create capability under a2a/");

  // Producer phase: propose through the unchanged v1 API. The fixture
  // planner maps the declared context to one filesystem create effect.
  const path = `a2a/deliverable-${crypto.randomUUID().slice(0, 8)}.txt`;
  const content = "Producer output committed under Veyra authority.\n";
  const submission = await client.submitIntent({
    schema_version: "veyra.protocol/v1",
    id: crypto.randomUUID(),
    principal_id: producer.id,
    summary: `Producer agent delivers ${path}`,
    requested_resources: [
      { kind: "filesystem", workspace: workspaceName, path },
    ],
    context: { workspace: workspaceName, operation: "create", path, content },
    created_at: new Date().toISOString(),
  });
  const transactionId = submission.transaction.id;
  const preview = await client.previewTransaction(transactionId);
  assert.equal(preview.transaction.state, "awaiting_approval");
  assert.equal(preview.approval_requests.length, 1);
  const request = preview.approval_requests[0];
  await assertAbsent(path);
  report("Producer intent preflighted; operator approval required");

  if (!(await approve(request))) {
    report("Operator declined; producer has no receipt to exchange");
    await assertAbsent(path);
    return { status: "declined", transactionId };
  }
  await client.grantApproval(request.id, human.id);
  const run = await client.runTransaction(transactionId);
  assert.ok(run.committed && run.receipts.length === 1);
  const receipt = run.receipts[0];
  assert.equal(receipt.effect_digest, request.effect_digest);
  report("Producer committed the effect; receipt issued by the kernel");

  // The wire: an A2A-shaped task result with a receipt claim. Serialization
  // is deliberate—the consumer must not share the producer's objects.
  const message = buildReceiptTaskResult({
    taskId: crypto.randomUUID(),
    producerPrincipalId: producer.id,
    receipt,
  });
  const wire = encodeTaskResult(message);
  if (messageFile) await writeFile(messageFile, wire + "\n", "utf8");
  const received = decodeTaskResult(wire);

  // Consumer phase: reconcile the untrusted claim against the journal.
  const forged = JSON.parse(wire);
  forged.task.artifacts[0].parts[0].data.effect_digest = "0".repeat(64);
  const forgedCheck = await verifyReceiptTaskResult(client, forged);
  assert.equal(forgedCheck.accepted, false);
  assert.ok(
    forgedCheck.reasons.some((reason) =>
      reason.includes("differ from the journal"),
    ),
    "Forged digest was not detected",
  );
  const unknownCheck = await verifyReceiptTaskResult(client, {
    task: {
      id: crypto.randomUUID(),
      status: { state: "completed", timestamp: new Date().toISOString() },
      artifacts: [
        {
          name: "veyra-execution-receipt",
          parts: [
            {
              kind: "data",
              data: {
                transaction_id: crypto.randomUUID(),
                receipt_id: crypto.randomUUID(),
                effect_id: crypto.randomUUID(),
                effect_digest: "0".repeat(64),
                result_digest: "0".repeat(64),
                outcome: "created",
              },
            },
          ],
        },
      ],
      metadata: { producer_principal_id: producer.id },
    },
  });
  assert.equal(unknownCheck.accepted, false);
  report("Consumer rejected forged and unknown receipt claims");

  const check = await verifyReceiptTaskResult(client, received);
  assert.ok(check.accepted, `Receipt claim rejected: ${check.reasons}`);
  const handle = await open(localPath(path), "r");
  try {
    assert.ok((await handle.stat()).isFile());
    assert.equal(await handle.readFile("utf8"), content);
  } finally {
    await handle.close();
  }
  const audit = await client.verifyAudit();
  assert.ok(audit.valid && audit.events_checked > 0);
  report("Consumer accepted the receipt after journal reconciliation");
  return {
    status: "accepted",
    transactionId,
    receiptId: receipt.id,
    effectDigest: receipt.effect_digest,
    auditEvents: audit.events_checked,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      "api-url": { type: "string", default: "http://127.0.0.1:7843/v1/" },
      "token-file": { type: "string" },
      workspace: { type: "string" },
      "workspace-name": { type: "string", default: "default" },
      "message-file": { type: "string" },
      "demo-approve": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      "Usage: pnpm --filter @veyra/sdk example:a2a --token-file PATH --workspace PATH [--api-url URL] [--message-file PATH] [--demo-approve]",
    );
    console.log(
      "Exchanges a Veyra receipt inside an A2A-shaped task result and reconciles it against the journal.",
    );
    return;
  }
  assert.ok(
    values["token-file"] && values.workspace,
    "Provide --token-file and the daemon's exact --workspace directory",
  );
  const result = await runA2aExchange({
    apiUrl: values["api-url"],
    tokenFile: values["token-file"],
    workspace: values.workspace,
    workspaceName: values["workspace-name"],
    messageFile: values["message-file"],
    approve: async (request) => {
      console.log("Review the exact producer effect before approving:");
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
      error instanceof VeyraApiError
        ? `A2A exchange failed: HTTP ${error.status} (${error.code}); inspect the retained daemon evidence`
        : "A2A exchange failed: check arguments, daemon state and retained evidence; no automatic retry or cleanup",
    );
    process.exitCode = 1;
  }
}
