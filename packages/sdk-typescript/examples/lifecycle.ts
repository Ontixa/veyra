import { VeyraApiError, VeyraClient } from "../src/index.js";
import type { ApprovalRequest, Intent } from "../src/index.js";

export const CONTENT = "Hello from the trusted Veyra controller.\n";

export interface LifecycleOptions {
  client: VeyraClient;
  /** Trusted operator interaction, never a model's yes/no response. */
  approve: (request: ApprovalRequest) => Promise<boolean>;
  /** Independent local observations supplied by the trusted Node controller. */
  readFile: (relativePath: string) => Promise<string>;
  assertAbsent: (relativePath: string) => Promise<void>;
  report: (message: string) => void;
}

function require(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

/** Proposal data only: this function receives no client, bearer or authority. */
export function deniedProposal(principalId: string, workspace: string): Intent {
  const id = crypto.randomUUID();
  return {
    schema_version: "veyra.protocol/v1",
    id,
    principal_id: principalId,
    summary: "Propose a create outside the seeded capability",
    requested_resources: [{ kind: "filesystem", workspace, path: "demo" }],
    context: {
      workspace,
      operation: "create",
      path: `demo/denied-${id}.txt`,
      content: "This proposal has no capability.\n",
    },
    created_at: new Date().toISOString(),
  };
}

async function assertRunRejected(
  client: VeyraClient,
  id: string,
): Promise<void> {
  try {
    await client.runTransaction(id);
  } catch (error) {
    require(error instanceof VeyraApiError &&
      error.status === 409 &&
      error.code ===
        "transaction_conflict", "Expected the API's typed state-conflict rejection");
    return;
  }
  throw new Error("Execution unexpectedly succeeded from a non-approved state");
}

/** Uses the unchanged v1 API. This controller is trusted; it is not a sandbox. */
export async function runLifecycle(options: LifecycleOptions) {
  const { client, report } = options;
  const seed = await client.seedDemo(CONTENT);
  const resource = seed.capability.resources[0];
  require(resource?.kind === "filesystem", "Expected a filesystem fixture");
  const path = resource.path;
  const transactionId = seed.submission.transaction.id;
  report(`Seeded transaction ${transactionId}`);
  await options.assertAbsent(path);

  const proposal = deniedProposal(seed.agent.id, resource.workspace);
  const deniedPath = proposal.context.path;
  require(typeof deniedPath === "string", "Expected a proposal path");
  await options.assertAbsent(deniedPath);
  const denied = await client.submitIntent(proposal);
  const denial = await client.previewTransaction(denied.transaction.id);
  require(denial.transaction.state ===
    "denied", "Unauthorized proposal was not denied");
  require(denial.decisions.some(
    (decision) => decision.outcome === "deny",
  ), "Missing denial evidence");
  require(denial.approval_requests.length ===
    0, "Denied proposal requested approval");
  await assertRunRejected(client, denied.transaction.id);
  require((await client.getTransactionBundle(denied.transaction.id)).executions
    .length === 0, "Denied proposal executed an effect");
  await options.assertAbsent(deniedPath);
  report("Unauthorized proposal denied; no effect executed");

  const preview = await client.previewTransaction(transactionId);
  require(preview.transaction.state ===
    "awaiting_approval", "Expected exact approval challenge");
  require(preview.approval_requests.length ===
    1, "Expected one approval request");
  const request = preview.approval_requests[0]!;
  const effects = preview.plan.steps.flatMap((step) => step.effects);
  require(effects.length === 1, "Expected one fixture effect");
  const effect = effects[0]!;
  require(effect.adapter === "filesystem" &&
    effect.operation === "create", "Expected filesystem create");
  require(request.transaction_id === transactionId &&
    request.effect_id ===
      effect.id, "Approval is not bound to the fixture effect");
  require(request.resource.kind === "filesystem" &&
    request.resource.path ===
      path, "Approval resource differs from the capability");
  require(preview.decisions.some(
    (decision) =>
      decision.effect_id === effect.id &&
      decision.effect_digest === request.effect_digest &&
      decision.outcome === "require_approval",
  ), "Approval digest differs from policy evidence");
  await assertRunRejected(client, transactionId);
  await options.assertAbsent(path);
  const before = await client.getTransactionBundle(transactionId);
  require(before.transaction.state === "awaiting_approval" &&
    before.executions.length === 0 &&
    before.receipts.length === 0, "Preapproval run left execution evidence");
  report("Execution rejected before approval; workspace unchanged");

  if (!(await options.approve(request))) {
    report(
      "Operator declined; transaction remains awaiting approval with no effect",
    );
    await options.assertAbsent(path);
    return { status: "declined" as const, transactionId };
  }
  const approval = await client.grantApproval(request.id, seed.human.id);
  require(approval.all_effects_approved &&
    approval.transaction.state === "approved", "Approval failed");
  require(approval.grant.effect_digest === request.effect_digest &&
    approval.grant.request_id === request.id &&
    approval.grant.transaction_id === transactionId &&
    approval.grant.nonce === request.nonce &&
    approval.grant.approver_id ===
      seed.human.id, "Grant binding differs from the request");

  const run = await client.runTransaction(transactionId);
  require(run.committed &&
    run.transaction.state === "committed", "Execution did not commit");
  require(run.receipts.length === 1 &&
    run.verifications.length === 1, "Incomplete execution evidence");
  const receipt = run.receipts[0]!;
  require(receipt.effect_digest === request.effect_digest &&
    receipt.effect_id === effect.id &&
    receipt.transaction_id ===
      transactionId, "Receipt is not bound to the approved effect");
  const verification = run.verifications[0]!;
  require(verification.passed &&
    verification.checks.length > 0 &&
    verification.checks.every(
      (check) => check.passed,
    ), "Postcondition verification failed");
  require(verification.effect_id === effect.id &&
    verification.transaction_id === transactionId &&
    verification.checks.some(
      (check) =>
        check.condition.kind === "file_sha256" && check.condition.path === path,
    ), "Missing fixture SHA-256 verification");
  require((await options.readFile(path)) ===
    CONTENT, "Independent filesystem bytes differ");
  // A committed transaction cannot be run again through the v1 endpoint.
  await assertRunRejected(client, transactionId);
  const committed = await client.getTransactionBundle(transactionId);
  require(committed.executions.length === 1 &&
    committed.receipts.length === 1, "Repeated run duplicated an execution");
  report(
    "Approved effect committed; postconditions, file bytes and receipt binding verified",
  );

  const rollback = await client.rollbackTransaction(transactionId);
  require(rollback.transaction.state === "rolled_back" &&
    rollback.recoveries.length === 1 &&
    rollback.recoveries.every(
      (recovery) => recovery.restored,
    ), `Restoration was not verified: ${rollback.transaction.state}; inspect the retained transaction`);
  await options.assertAbsent(path);
  await options.assertAbsent(deniedPath);
  const bundle = await client.getTransactionBundle(transactionId);
  require(bundle.transaction.state === "rolled_back" &&
    bundle.compensations.length === 1, "Rollback evidence is incomplete");
  const audit = await client.verifyAudit();
  require(audit.valid && audit.events_checked > 0, "Audit verification failed");
  report(
    `Filesystem create rolled back; audit valid (${audit.events_checked} events)`,
  );
  return {
    status: "rolled_back" as const,
    transactionId,
    deniedTransactionId: denied.transaction.id,
    receiptId: receipt.id,
    effectDigest: request.effect_digest,
    auditEvents: audit.events_checked,
  };
}
