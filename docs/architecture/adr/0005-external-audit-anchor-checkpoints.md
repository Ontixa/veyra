# ADR-0005: Operator-held authenticated audit anchor checkpoints

- Status: Accepted
- Date: 2026-09-26

## Context

Journal integrity is proven against a transactionally maintained local count/head anchor stored
inside the same `SQLite` database. `verify_chain` detects mutation, gaps, reordering, broken
links, tail deletion, and every audit-bound durable state in both directions — but all of that
evidence lives under the same write authority. A privileged attacker who rewrites the whole
database and the local anchor together constructs a new self-consistent chain that verifies
cleanly. The threat model records this as the top residual risk, and the roadmap asked for an
authenticated audit anchor outside `SQLite` (or an optional remote transparency sink).

## Decision

Operators can export a small authenticated checkpoint artifact, `veyra.audit-anchor/v1`, with
`veyra journal anchor export` (or `Journal::export_audit_anchor`) and keep it outside the data
directory — another host, a versioned backup, or a read-only medium.

- The anchor records `created_at`, the journal storage `journal_schema_version`, the pinned
  `event_count`, the `head_hash` of the event at that sequence (the all-zero genesis hash for
  an empty chain), and the `signer_key_id`. It is authenticated by HMAC-SHA-256 over the
  canonical serialization with the `authentication` field cleared, keyed by the same local
  `receipt.key` that signs receipts — the existing key-separation rationale applies: a
  database-only attacker cannot forge one.
- `veyra journal anchor check` (or `Journal::verify_audit_anchor`) verifies the artifact
  schema, the signer identity, and the HMAC in constant time, then confirms the chain still
  contains the exact pinned head at the anchored sequence. Every mismatch — unknown schema,
  foreign signer, malformed fields, bad tag, missing event, or a different hash — produces an
  invalid `AnchorVerification` rather than an ambiguous error. The CLI exits non-zero on an
  invalid anchor so monitoring can alarm on it.
- Legitimate appends after export do not invalidate an anchor: verification requires the
  pinned event at sequence `event_count` to still exist with its recorded hash, so an anchor
  is a durable prefix checkpoint, not a claim about the current tail.
- Anchor commands are offline like `veyra journal migrate`: they open an already-initialized
  data directory and fail closed when `veyra.sqlite3` or `receipt.key` is absent — a check
  must never mint a key the exported artifact would silently authenticate under. `--out`
  refuses to overwrite an existing file so recorded checkpoints are never clobbered.

## Consequences

- A whole-database rewrite now requires the attacker to also replace the operator's stored
  anchor copies; rewriting the database alone is detected at the next `anchor check`. The
  residual narrows from "no external anchor exists" to "the anchor file's own storage is the
  remaining trusted element."
- Anchors are locally authenticated evidence like receipts: the bearer key holder can mint
  new anchors, and nothing here is remote attestation, a transparency log, or
  non-repudiation. An optional remote sink remains a possible future extension but is not
  required for the detection property.
- The trust model's journal-tamper row and operational guidance describe the narrower
  residual: detection depends on holding exported anchors where the attacker cannot also
  rewrite them, and an anchor only ever proves "this head existed at export time."
- No storage contract change: anchors live outside the database, so `schema_version` stays
  `2` and no migration is needed. The artifact is a journal-level file like the migration
  report, not a `/v1` wire type, so the protocol schema set is unchanged.
