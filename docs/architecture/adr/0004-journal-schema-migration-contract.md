# ADR-0004: Versioned journal schema with an audit-bound forward-migration contract

- Status: Accepted
- Date: 2026-09-23

## Context

The protocol and the SQLite journal are versioned, but v0.1 never promised how an existing
installation moves to a later storage schema. `Journal::open` created or healed the current schema
unconditionally and then compared the recorded `schema_version`, which meant a legacy, foreign, or
partially initialized database could be silently adopted into the current format, and no ordered,
reviewable path existed for real upgrades. Without an explicit contract, a mixed-revision journal
risks losing audit evidence or changing semantics without operator intent.

## Decision

`metadata.schema_version` is the single durable authority for the journal storage contract. It is
written once during first initialization, inside the same transaction that creates the schema and
audit anchors, so a crash can leave no journal or a complete one but never a versioned-looking
database with a partially applied schema.

- `Journal::open` reads the version before creating anything and only opens the current version
  (`CURRENT_SCHEMA_VERSION`, currently `2`). An older supported version fails closed with
  `JournalError::MigrationRequired` and is never mutated; a malformed, missing, or newer version —
  including every downgrade attempt — fails closed with
  `JournalError::UnsupportedSchemaVersion`. Journal-shaped content without a version marker is
  treated as unversioned and fails closed rather than being adopted.
- `Journal::migrate` (CLI: `veyra journal migrate`, offline; the daemon must be stopped) is the
  only supported upgrade path. It verifies the complete audit chain and every audit-bound durable
  state first, records a consistent `VACUUM INTO` backup at a caller-chosen path that must not
  already exist, re-opens that backup to prove it preserved the source version and audit head,
  then applies the ordered pending steps from `MIGRATION_STEPS` inside one immediate transaction
  together with a `journal.schema_migrated` audit event and `schema_migrations` ledger rows bound
  to that event by sequence and hash. The full verification suite runs again inside the same
  transaction, so the version bump commits only when the migrated journal verifies completely.
- Every applied step strictly increases the version and the declared chain must be contiguous;
  step DDL deliberately lacks `IF NOT EXISTS` so an unexpected existing object fails the migration
  instead of being silently absorbed. `verify_chain` now also checks the migration ledger in both
  directions: every ledger row must reference a migration event by sequence and hash and repeat a
  step the event's payload declares, and every declared step must have a bound row. The event's
  recorded pre-migration head and count must equal its own `previous_hash` and `sequence - 1`.
- The v1→v2 step adds only the `schema_migrations` ledger; the v0.1 table shapes are unchanged, so
  a migrated journal preserves every audit event, binding marker, snapshot, nonce, staged effect,
  idempotency reservation, and receipt verbatim.

## Consequences

- A crash or failure at any point rolls the migration transaction back: the prior version remains
  intact and readable by its original release, and re-running migration is a clean retry rather
  than a resume of partial state. The recorded backup is never overwritten; a retry requires a
  fresh path or the operator may remove the old backup after confirming the source is intact.
- Recovery semantics are unchanged: migration records evidence but does not reclassify in-flight
  work, and `manual_recovery` states persist across the boundary.
- Downgrades are permanently unsupported. Operators restore the recorded backup or run the older
  release; no tool rewrites a newer journal for an older build.
- The migration is single-writer by contract: `veyra journal migrate` takes an immediate write
  transaction and fails closed if a daemon is still running.
- `verify_chain` remains the integrity oracle before and after migration; a tampered ledger,
  forged migration event, or deleted binding fails verification like any other audit evidence.
- Adding a schema version means appending one ordered step to `MIGRATION_STEPS`, bumping
  `CURRENT_SCHEMA_VERSION` and `DATABASE_SCHEMA_VERSION`, extending the legacy fixtures, and
  updating this contract; there is no speculative multi-step framework beyond the ordered chain.
