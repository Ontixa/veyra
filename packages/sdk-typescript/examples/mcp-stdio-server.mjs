import { readFile } from "node:fs/promises";

import { VeyraClient } from "./dist/src/index.js";
import {
  MAXIMUM_MESSAGE_LENGTH,
  VeyraMcpInterception,
} from "./dist/examples/mcp-interception.js";

/**
 * Newline-delimited JSON-RPC stdio transport for the interception example.
 *
 * An MCP client launches this file as the server command. Configuration comes
 * from the environment so no secret ever enters argv or the protocol stream:
 *
 *   VEYRA_API_URL          authenticated API root (default http://127.0.0.1:7843/v1/)
 *   VEYRA_TOKEN_FILE       daemon token file (required; the value is never logged)
 *   VEYRA_AGENT_PRINCIPAL  registered agent principal ID this surface proposes as
 *   VEYRA_WORKSPACE_NAME   daemon workspace name (default "default")
 *
 * stdout carries only JSON-RPC responses; diagnostics go to stderr.
 */

const apiUrl = process.env.VEYRA_API_URL ?? "http://127.0.0.1:7843/v1/";
const tokenFile = process.env.VEYRA_TOKEN_FILE;
const agentPrincipalId = process.env.VEYRA_AGENT_PRINCIPAL;
const workspace = process.env.VEYRA_WORKSPACE_NAME ?? "default";

if (!tokenFile || !agentPrincipalId) {
  console.error(
    "veyra-mcp: VEYRA_TOKEN_FILE and VEYRA_AGENT_PRINCIPAL are required",
  );
  process.exit(1);
}

const token = (await readFile(tokenFile, "utf8")).trim();
const interception = new VeyraMcpInterception({
  client: new VeyraClient({ baseUrl: apiUrl, token }),
  agentPrincipalId,
  workspace,
});

process.stdout.setDefaultEncoding("utf8");
let pending = "";
let oversized = false;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  void drain();
});

// Sequential drain: one message at a time keeps responses ordered and avoids
// unbounded concurrent API work triggered by a fast peer.
let draining = false;
async function drain() {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) {
        if (pending.length > MAXIMUM_MESSAGE_LENGTH) {
          oversized = true;
          pending = "";
        }
        return;
      }
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (oversized || line.length > MAXIMUM_MESSAGE_LENGTH) {
        oversized = false;
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32700,
              message: "message exceeds the length bound",
            },
          }) + "\n",
        );
        continue;
      }
      if (line.trim() === "") continue;
      const answer = await interception.handleMessage(line);
      if (answer !== undefined) process.stdout.write(answer + "\n");
    }
  } finally {
    draining = false;
  }
}

process.stdin.on("error", () => process.exit(1));
process.stderr.write(
  "veyra-mcp interception example listening on stdio (tool surface only; approvals stay with the operator)\n",
);
