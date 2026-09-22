import { VeyraApiError, VeyraClient } from "../src/index.js";
import type { JsonValue, Receipt } from "../src/index.js";

/**
 * Agent-to-agent receipt exchange on top of the existing authenticated API.
 *
 * A producer agent finishes a Veyra transaction and hands a task-result
 * envelope to a consumer agent. The envelope is untrusted input: the consumer
 * reconciles every claimed field against the authoritative journal through
 * its own authenticated client instead of trusting the message.
 *
 * Honest limits, matching the threat model: Veyra receipts are locally
 * MAC-authenticated by the kernel that issued them. The receipt key never
 * leaves the daemon, so a consumer cannot verify the MAC itself—it verifies
 * that the authoritative journal contains exactly the claimed receipt, that
 * the transaction committed with passing postconditions, and that the audit
 * chain is valid. This is evidence reconciliation, not remote attestation or
 * non-repudiation. In this single-daemon example both roles share the same
 * administrative bearer; per-client credentials are a documented roadmap item.
 */

const RECEIPT_ARTIFACT = "veyra-execution-receipt";
const PROTOCOL = "veyra.protocol/v1";
const MAXIMUM_FIELD_LENGTH = 512;

/** Receipt fields a producer claims inside the task-result artifact. */
export interface ReceiptClaim {
  transaction_id: string;
  receipt_id: string;
  effect_id: string;
  effect_digest: string;
  result_digest: string;
  outcome: string;
}

/** A2A-shaped task result carrying one receipt claim as a data part. */
export interface A2aTaskResult {
  task: {
    id: string;
    status: { state: "completed"; timestamp: string };
    artifacts: [
      {
        name: typeof RECEIPT_ARTIFACT;
        parts: [{ kind: "data"; data: ReceiptClaim }];
      },
    ];
    metadata: {
      producer_principal_id: string;
      "veyra.protocol": string;
    };
  };
}

export interface ReceiptVerification {
  accepted: boolean;
  reasons: string[];
  transaction_id: string | null;
  receipt_id: string | null;
}

/**
 * Build the untrusted message a producer emits after its transaction commits.
 * The claim carries only identifiers and digests; the consumer must reconcile
 * it against the journal rather than trusting these bytes.
 */
export function buildReceiptTaskResult(input: {
  taskId: string;
  producerPrincipalId: string;
  receipt: Receipt;
}): A2aTaskResult {
  const { receipt } = input;
  return {
    task: {
      id: input.taskId,
      status: { state: "completed", timestamp: new Date().toISOString() },
      artifacts: [
        {
          name: RECEIPT_ARTIFACT,
          parts: [
            {
              kind: "data",
              data: {
                transaction_id: receipt.transaction_id,
                receipt_id: receipt.id,
                effect_id: receipt.effect_id,
                effect_digest: receipt.effect_digest,
                result_digest: receipt.result_digest,
                outcome: receipt.outcome,
              },
            },
          ],
        },
      ],
      metadata: {
        producer_principal_id: input.producerPrincipalId,
        "veyra.protocol": PROTOCOL,
      },
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedField(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAXIMUM_FIELD_LENGTH
  );
}

/** Extract the receipt claim from an untrusted envelope, or list why not. */
export function extractReceiptClaim(
  message: unknown,
): { claim: ReceiptClaim; producer: string } | { reasons: string[] } {
  const reasons: string[] = [];
  if (!isObject(message) || !isObject(message.task)) {
    return { reasons: ["message is not a task-result envelope"] };
  }
  const task = message.task;
  const metadata = isObject(task.metadata) ? task.metadata : {};
  const producer = boundedField(metadata.producer_principal_id)
    ? metadata.producer_principal_id
    : "";
  const artifacts = Array.isArray(task.artifacts) ? task.artifacts : [];
  const artifact = artifacts.find(
    (entry) => isObject(entry) && entry.name === RECEIPT_ARTIFACT,
  );
  if (!boundedField(task.id) || producer === "") {
    reasons.push("task id or producer principal is missing");
  }
  if (
    !isObject(artifact) ||
    !Array.isArray(artifact.parts) ||
    artifact.parts.length === 0
  ) {
    reasons.push("receipt artifact is missing");
    return { reasons };
  }
  const part = artifact.parts[0];
  const data = isObject(part) && part.kind === "data" ? part.data : undefined;
  if (!isObject(data)) {
    reasons.push("receipt artifact has no data part");
    return { reasons };
  }
  const claim: Record<string, unknown> = data;
  const fields = [
    "transaction_id",
    "receipt_id",
    "effect_id",
    "effect_digest",
    "result_digest",
    "outcome",
  ] as const;
  for (const field of fields) {
    if (!boundedField(claim[field])) reasons.push(`claim ${field} is missing`);
  }
  if (reasons.length > 0) return { reasons };
  return {
    claim: {
      transaction_id: claim.transaction_id as string,
      receipt_id: claim.receipt_id as string,
      effect_id: claim.effect_id as string,
      effect_digest: claim.effect_digest as string,
      result_digest: claim.result_digest as string,
      outcome: claim.outcome as string,
    },
    producer,
  };
}

/**
 * Reconcile an untrusted task-result envelope with the authoritative journal.
 *
 * Accepts only when the claimed transaction exists, contains exactly the
 * claimed receipt bound to the claimed effect and digests, committed with
 * passing postcondition verification, and the daemon's audit chain verifies.
 */
export async function verifyReceiptTaskResult(
  client: VeyraClient,
  message: unknown,
): Promise<ReceiptVerification> {
  const extracted = extractReceiptClaim(message);
  if ("reasons" in extracted) {
    return {
      accepted: false,
      reasons: extracted.reasons,
      transaction_id: null,
      receipt_id: null,
    };
  }
  const { claim } = extracted;
  const base = {
    transaction_id: claim.transaction_id,
    receipt_id: claim.receipt_id,
  };
  const reasons: string[] = [];

  let bundle;
  try {
    bundle = await client.getTransactionBundle(claim.transaction_id);
  } catch (error) {
    const detail =
      error instanceof VeyraApiError
        ? `daemon rejected the lookup (${error.code})`
        : "transaction lookup failed";
    return { accepted: false, reasons: [detail], ...base };
  }

  const receipt = bundle.receipts.find(
    (candidate) => candidate.id === claim.receipt_id,
  );
  if (receipt === undefined) {
    reasons.push("claimed receipt is absent from the authoritative journal");
  } else {
    if (
      receipt.transaction_id !== claim.transaction_id ||
      receipt.effect_id !== claim.effect_id ||
      receipt.effect_digest !== claim.effect_digest ||
      receipt.result_digest !== claim.result_digest ||
      receipt.outcome !== claim.outcome
    ) {
      reasons.push("claimed receipt fields differ from the journal record");
    }
    if (receipt.authentication.length === 0) {
      reasons.push("journal receipt lacks kernel authentication");
    }
  }
  if (bundle.transaction.state !== "committed") {
    reasons.push(
      `claimed transaction is ${bundle.transaction.state}, not committed`,
    );
  }
  const verifications = bundle.verifications.filter(
    (verification) => verification.effect_id === claim.effect_id,
  );
  if (
    verifications.length === 0 ||
    verifications.some(
      (verification) =>
        !verification.passed ||
        verification.checks.some((check) => !check.passed),
    )
  ) {
    reasons.push("claimed effect lacks passing postcondition verification");
  }
  const audit = await client.verifyAudit();
  if (!audit.valid) reasons.push("daemon audit chain is invalid");

  return { accepted: reasons.length === 0, reasons, ...base };
}

/** Serialize the envelope for the wire; the consumer reparses, never shares objects. */
export function encodeTaskResult(message: A2aTaskResult): string {
  return JSON.stringify(message);
}

/** Bounded, shape-agnostic reparse of a received envelope. */
export function decodeTaskResult(text: string): JsonValue {
  if (text.length > 256 * 1024) {
    throw new Error("task result exceeds the 256 KiB bound");
  }
  return JSON.parse(text) as JsonValue;
}
