# Trusted-controller lifecycle example

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
