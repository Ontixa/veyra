# SDK examples

Three runnable examples exercise the real local API through the existing v1 SDK
without changing the public API or adding dependencies:

- `lifecycle.ts` + `run-lifecycle.mjs` — trusted-controller lifecycle
- `mcp-interception.ts` + `mcp-stdio-server.mjs` + `run-mcp-interception.mjs` —
  MCP tool-call interception
- `a2a-receipts.ts` + `run-a2a-receipts.mjs` — agent-to-agent receipt exchange

All three run in the **trusted controller** boundary: they load the daemon
bearer from a file, and every proposal still faces the kernel's deny-by-default
capability check and content-addressed approval. None of them is a sandbox, a
model integration, or a new trust boundary.

## Trusted-controller lifecycle example

Run the TypeScript controller against the real local API: deny an unauthorized
proposal, reject execution before approval, approve one exact filesystem create,
verify its content and receipt binding, then verify rollback and the audit trail.
No model, paid provider, MCP integration, or new dependency is involved.

The example uses the existing v1 SDK and protocol without changing either public
API. `lifecycle.ts` is the typed flow; `run-lifecycle.mjs` supplies Node filesystem
observations, token-file loading, and operator input. Both run in the **trusted
controller**. `deniedProposal` receives only a principal ID and workspace name:
it returns intent data and receives no client, bearer, or approval authority.
This separation demonstrates data flow; importing untrusted executable code into
the controller would not isolate it.

## Run from this repository

Use Git, the repository's Rust toolchain, Node 22+ and pinned pnpm. From the root:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @veyra/sdk example:build
cargo run --locked -p veyra-server -- --data-directory demo-state/sdk-data --workspace demo-state/sdk-workspace
```

The daemon creates its token file. Keep this terminal open. Do not enable a model
planner: this example asserts the deterministic fixture's single create effect.
Use a disposable daemon and disjoint data/workspace roots, with no valuable files.
If Windows lacks the MSVC linker, use the installed GNU toolchain as documented
in the [contributor guide](../../../CONTRIBUTING.md).

In a second terminal, also from the repository root:

```sh
corepack pnpm --filter @veyra/sdk example:lifecycle --token-file ../../demo-state/sdk-data/api-token --workspace ../../demo-state/sdk-workspace
```

`pnpm --filter` runs in `packages/sdk-typescript`, hence the `../../` paths.
Absolute paths are also accepted. `--api-url` defaults to
`http://127.0.0.1:7843/v1/`. The workspace argument must point at the daemon's exact
local workspace so the controller can independently inspect file bytes.

Read the displayed resource, diff, risk and digest. Type the complete effect digest
to grant approval; Enter declines. Without an interactive terminal the example
declines. A declined transaction remains `awaiting_approval`, with no grant or
execution. An interrupted or failed run leaves evidence for inspection and does
not automatically retry, cancel, or roll back uncertain work.

For disposable automated demonstrations, append `--demo-approve`. This explicit
flag grants the displayed fixture approval without prompting. It is **not** proof
of human identity. The bearer can nominate any registered human principal and is
an administrative root credential: never give it to a model, paste it into a
command argument, log it, or check the token file into Git.

Expected successful milestones:

```text
Unauthorized proposal denied; no effect executed
Execution rejected before approval; workspace unchanged
Approved effect committed; postconditions, file bytes and receipt binding verified
Filesystem create rolled back; audit valid (... events)
```

The final JSON includes the transaction, denied transaction, receipt and effect
digest IDs for inspection. The database retains the complete bundles and audit
evidence. The example asserts `committed`, passing postconditions, an exact receipt
digest binding, rejected repeated execution, `rolled_back`, restored compensation,
file absence, and a valid nonempty audit. Receipt MAC checking is performed by the
kernel during verification and audit; the SDK does not possess the receipt key and
does not independently authenticate the server.

## Real-API acceptance

Build the daemon and example, then point the acceptance test at that executable:

```sh
cargo build --locked -p veyra-server
corepack pnpm --filter @veyra/sdk example:build
```

PowerShell, from the root:

```powershell
$env:VEYRA_EXAMPLE_SERVER = (Resolve-Path target/debug/veyra-server.exe).Path
corepack pnpm --filter @veyra/sdk example:test
```

Bash, from the root:

```sh
VEYRA_EXAMPLE_SERVER="$PWD/target/debug/veyra-server" corepack pnpm --filter @veyra/sdk example:test
```

This test starts a real daemon on an ephemeral loopback port in a unique OS-temp
directory. It exercises success and operator decline, including the denial and
preapproval negative paths. It stops its own daemon and prints the retained
fixture path; it does not delete evidence or contact a model provider.

Acceptance retains programmatic approval/decline checks and also launches the
actual Node CLI against the same daemon. With stdin ignored, its default path
must decline without grants, executions or receipts; `--demo-approve` must grant
exactly once, complete verified rollback, leave the file absent and keep the audit
valid. Captured stdout/stderr must not contain the bearer. Each CLI child has a
30-second deadline and a combined 64 KiB output bound, within the existing
120-second test limit; the bearer is read from a file, never passed in argv.
The automated acceptance suite does not drive an interactive TTY. Separate manual
Windows PTY acceptance exercised Enter decline, wrong-digest decline and exact
digest approval against a real disposable daemon, with independent API and
filesystem checks; see the repository [verification record](../../../PROGRESS.md).

A second acceptance test starts its own disposable daemon and covers the MCP
interception and A2A receipt examples: the full spawn-and-drive flow over real
stdio, kernel denial and operator-decline paths, protocol-level probes (malformed
input, pre-`initialize` traffic, unknown authority-shaped tool names, path
traversal), forged and unknown receipt-claim rejection, and the actual example
CLIs under `--demo-approve`. MCP/A2A example children have a 60-second deadline
and a 256 KiB output bound.

Stop the manual daemon before cleanup. Inspect the printed transaction IDs, then
remove only your chosen disposable `demo-state` subdirectories or the exact
printed temporary fixture when its evidence is no longer needed. The example
never removes directories automatically. Filesystem rollback removes the created
file; staging and audit artifacts are intentionally retained.

## Limits

This covers one supported filesystem create, not arbitrary tool interception or
universal reversibility. A concurrent edit or unsupported filesystem may prevent
restoration; a state such as `partially_compensated` or `manual_recovery` fails the
example and requires inspection. The trusted controller and OS account can still
access the daemon credential. The journal is locally authenticated, not remote
attestation. See the [threat model](../../../docs/security/threat-model.md).

## MCP interception example

`mcp-stdio-server.mjs` is a minimal MCP-shaped tool server over newline-delimited
JSON-RPC stdio: it implements only `initialize`, `ping`, `tools/list`, and
`tools/call`. An MCP client launches it as the server command; every side-effecting
tool call is intercepted—converted into an intent, preflighted without mutation,
and gated by the kernel's capability and approval policy before any bytes change.

Build the examples, start a disposable daemon as above, then drive the flow:

```sh
corepack pnpm --filter @veyra/sdk example:mcp --token-file ../../demo-state/sdk-data/api-token --workspace ../../demo-state/sdk-workspace
```

The driver plays two roles with different authority. As the operator it registers
principals and issues a one-use `create` capability scoped to the `mcp/` prefix.
As the MCP client it spawns the server and calls `create_workspace_file`, then
`run_transaction`. The kernel rejects execution until the operator grants the
exact digest; a second call outside `mcp/` is denied by policy, not by the tool.
There is deliberately no approval or capability tool—authority stays on the
authenticated API. The server reads `VEYRA_API_URL`, `VEYRA_TOKEN_FILE`,
`VEYRA_AGENT_PRINCIPAL`, and `VEYRA_WORKSPACE_NAME` from its environment, so no
credential travels in argv or the protocol stream.

This is an interception pattern, not a complete MCP server: resources, prompts,
subscriptions, cancellation, and batching are unimplemented, and the stdio
subprocess runs inside the controller's trust boundary.

## A2A receipt exchange example

`run-a2a-receipts.mjs` runs a producer/consumer handoff. The producer commits one
approved filesystem create, then emits an A2A-shaped task result whose artifact
carries a receipt claim (transaction, receipt, effect, and digests). The consumer
treats the envelope as untrusted input: it fetches the authoritative transaction
bundle, requires the claimed receipt to match the journal record exactly,
requires committed state with passing postcondition verification, and requires a
valid audit chain. Forged and unknown claims are rejected before the real one is
accepted.

```sh
corepack pnpm --filter @veyra/sdk example:a2a --token-file ../../demo-state/sdk-data/api-token --workspace ../../demo-state/sdk-workspace
```

Append `--message-file PATH` to persist the exchanged envelope for inspection.
Veyra receipts are MAC-authenticated locally by the issuing kernel; the consumer
cannot verify that MAC itself—it reconciles the claim against the authoritative
journal. That is evidence verification, not remote attestation, and the envelope
format is illustrative rather than a certified A2A profile.
