# Changelog

All notable changes are documented here. The project follows Semantic Versioning and Keep a
Changelog conventions.

## [Unreleased]

### Added

- Defined the v0.2 journal storage-migration contract: `metadata.schema_version` is the durable
  schema authority written atomically with first initialization, `Journal::open` refuses an older
  supported version without mutating it (`JournalError::MigrationRequired`), and missing,
  malformed, or newer versions — including downgrade attempts — fail closed
  (`JournalError::UnsupportedSchemaVersion`). The new offline `veyra journal migrate` command (and
  `Journal::migrate`) verifies the complete audit chain and every audit-bound durable state,
  records a `VACUUM INTO` backup that is never overwritten, applies the ordered forward steps
  inside one atomic transaction together with a `journal.schema_migrated` audit event bound to the
  new `schema_migrations` ledger, and re-verifies before committing. `verify_chain` now checks the
  migration ledger in both directions. See `docs/architecture/adr/0004-journal-schema-migration-contract.md`.
- Bounded the per-transaction bundle event timeline: `GET /v1/transactions/{id}/bundle` accepts
  `limit`/`cursor` and returns the ascending causal `events` page plus `events_next_cursor`
  (default 1,000, maximum 5,000). The TypeScript SDK accepts page options on
  `getTransactionBundle`, `veyra tx inspect` exposes `--limit`/`--cursor`, and the desktop inspector
  resumes the timeline with a "Load later events" control instead of silently truncating.
- Added a first-class MCP interception example (`packages/sdk-typescript/examples/`):
  a minimal newline-delimited JSON-RPC stdio surface implementing `initialize`,
  `ping`, `tools/list`, and `tools/call`, where the side-effecting tool is routed
  through Veyra intents, preflight, capability checks, and exact operator
  approval. The surface exposes no approval or capability tool.
- Added an agent-to-agent receipt exchange example: a producer emits an
  A2A-shaped task result carrying a receipt claim, and the consumer reconciles
  the untrusted claim against the authoritative journal (receipt binding,
  committed state, passing postconditions, valid audit chain) while rejecting
  forged and unknown claims. This demonstrates evidence reconciliation, not
  remote attestation.
- Added a TypeScript trusted-controller example and real-daemon acceptance covering
  capability denial, execution rejection before exact approval, verified filesystem
  creation, receipt binding, rollback, audit and operator decline. No protocol or SDK
  API changes are required.

- Added five binary-scoped SPDX 2.3 SBOMs generated from dependency metadata embedded in the exact
  Linux/Windows CLI and daemon binaries plus the desktop executable extracted from the NSIS
  installer, with subject-digest validation, checksums, and build attestations.
- Added scheduled and release-triggered clean-consumer verification of public immutable tags,
  manifests, checksums, attestations, SBOM-to-archive bindings, reversible demos, and authenticated
  daemon startup on Linux and Windows.
- Added a read-only package-publication rehearsal, deterministic multi-crate publish order, and an
  evidence-based maintainer runbook for registry bootstrap and later OIDC trusted publishing.

### Fixed

- Made release recovery rebuild an existing immutable annotated tag from protected `main`, and
  replaced the default-branch-only Dependency Graph SBOM export with a full-SHA-pinned Syft scan of
  the exact release checkout.

## [0.1.0] - 2026-08-24

### Added

- Complete `veyra.protocol/v1` domain model, generated JSON Schemas, canonical content digests, and
  strict secret-reference encoding.
- Explicit transaction state machine and deny-by-default capability/approval policy.
- SQLite WAL journal with hash-chain verification, authenticated receipts, idempotency reservations,
  redacted exports, and conservative crash recovery.
- Staged reversible filesystem adapter, allowlisted HTTP adapter, and disabled-by-default argv-only
  process adapter.
- Model-independent planner trait, deterministic fixture planner, and optional OpenAI
  Responses-compatible planner.
- Authenticated loopback API, machine-readable CLI, typed TypeScript SDK, and real React/Tauri control
  plane.
- Bounded keyset pagination for transactions, audit history/export, and recovery, plus
  snapshot-consistent transaction bundles and progressive desktop loading.
- Deterministic end-to-end demo, custom adapter example, adversarial test suite, and 64-scenario eval
  harness.
- Architecture, protocol, security, contributor, governance, and release documentation.
- Structured bug, feature, and support intake; an explicit support policy; a maintainer release
  runbook; and a repository-host hardening checklist.
- A canonical human/AI maintainer contract with an OSS change matrix, plus a deterministic OSS gate
  for community files, package discovery metadata, archive licenses, and workflow pinning.
- Self-contained public Rust and JavaScript package metadata and archives, including READMEs,
  Apache-2.0 license text, registry discovery fields, and npm provenance configuration.

### Changed

- Updated Prettier within major version 3 and the default Node 24 LTS patch, added a Node 22
  compatibility gate, and made Node type definitions track the minimum supported runtime major so
  automated type-only upgrades cannot silently widen the runtime API surface.

### Security

- Proposal-level authority is checked before adapters can observe targets, then reevaluated over the
  exact preflighted preview. Approval grants bind that digest; execution atomically consumes
  capability uses, an optional nonce, and corresponding audit evidence per effect. Aggregate
  capability budgets cannot be overbooked within a multi-effect plan.
- Filesystem containment uses clean relative paths, component-wise no-follow capability handles,
  exact captured/prepared-file digest checks, atomic no-replace commits, collision-safe staging, and
  non-clobbering rollback. Diffs remain valid UTF-8 and within their exact byte limit.
- Process preview/staging binds the executable byte digest; mutating filesystem and HTTP operations,
  process execution, and custom adapters enforce honest minimum risk levels. Output overflow and
  timeout both abort capture tasks and terminate/reap the child process.
- Data and workspace directories require disjoint canonical roots; newly created Unix API tokens use
  owner-only permissions.
- Planner, adapter, CLI, and SDK inputs/outputs are byte/depth bounded; HTTP DNS results and
  duplicate/request/response headers are bounded; reflected HTTP and process-output secrets are
  redacted without amplification. Client error text is token-redacted, control-safe, and bounded;
  CLI path IDs are typed and joined URLs cannot escape the configured `/v1/` origin.
- Plan validation requires prior causal parents and bounded, adapter-unique idempotency keys;
  V0.1 rejects unevaluated preconditions, credential-shaped public input, unknown adapter fields,
  unsupported postconditions, and filesystem observations outside the exact resource. Recovery uses
  all available durable stages and reports missing evidence as partial compensation.
- The journal maintains a transactional local count/head anchor so deleting the current audit tail
  is detected as well as mutation, gaps, and broken links. Transaction snapshots, immutable objects,
  capability facts, approval replay rows, stages, and idempotency state are audit-bound and verified
  in both directions; generic events cannot use reserved binding fields, and malformed stored
  JSON/timestamps produce an explicit invalid verification.
- Receipt signing rejects malformed or oversized bodies, and idempotency completion requires the
  authenticated receipt to repeat the exact reserved effect digest.
- The desktop prevents stale bundle responses from overwriting a newer selection and renders failed
  journal verification as a persistent integrity alert instead of a loading state.
- Dependency review rejects newly introduced high-severity advisories, CodeQL scans JavaScript and
  TypeScript with extended security queries, OpenSSF Scorecard publishes supply-chain findings, and
  every third-party Action is immutable-SHA pinned. Tagged release jobs verify checksums, attest
  binary provenance at the actual build boundary, and assemble a draft before publishing a new
  immutable GitHub Release with explicit least-privilege permissions.
- Pinned `cargo-fuzz`/libFuzzer harnesses continuously exercise canonical protocol handling and
  component-aware resource containment on pull requests, `main`, and a longer weekly schedule.
- CodeQL Action components are pinned to one verified upstream release commit and grouped as a
  single Dependabot update so partial version changes cannot break analysis initialization.

[Unreleased]: https://github.com/Ontixa/veyra/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Ontixa/veyra/releases/tag/v0.1.0
