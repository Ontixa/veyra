//! Versioned journal schema-migration contract.
//!
//! `metadata.schema_version` is the durable storage version authority. [`Journal::open`] creates
//! fresh databases at [`CURRENT_SCHEMA_VERSION`] and refuses every older supported version with
//! [`JournalError::MigrationRequired`]; unknown, malformed, or newer versions fail closed with
//! [`JournalError::UnsupportedSchemaVersion`]. [`Journal::migrate`] is the explicit,
//! operator-invoked forward path documented in `docs/architecture/adr/`:
//!
//! 1. the complete audit chain and every audit-bound durable state (transaction snapshots,
//!    capabilities, approval consumptions, immutable objects, staged effects, idempotency rows,
//!    and receipt authentication) is verified before any write;
//! 2. a consistent `VACUUM INTO` backup is recorded and re-opened for verification;
//! 3. every pending ordered step runs inside one immediate transaction together with a
//!    `journal.schema_migrated` audit event and `schema_migrations` ledger rows bound to that
//!    event by sequence and hash;
//! 4. the post-migration state is verified again inside the same transaction, so commit happens
//!    only when the migrated journal verifies completely.
//!
//! Interruption at any point therefore rolls the transaction back and leaves the prior version
//! intact and readable; re-running migration is a clean retry rather than a resume of partial
//! state. Downgrades are unsupported and fail closed.

use std::{
    fs,
    path::{Path, PathBuf},
};

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use veyra_protocol::AuditEvent;

use crate::{
    Journal, JournalError, append_event_in_transaction, audit_anchor, configure_connection,
    i64_from_u64, load_or_create_key, receipt_key_id, verify_approval_consumptions,
    verify_capability_snapshots, verify_events_streaming, verify_idempotency_receipts_with,
    verify_idempotency_snapshots, verify_object_snapshots, verify_staged_effects,
    verify_transaction_snapshots,
};

/// Journal storage schema version produced by this build.
///
/// The value is stored as decimal text under `metadata.schema_version`. Bump it only together
/// with a contiguous `MIGRATION_STEPS` chain from every supported prior version.
pub const CURRENT_SCHEMA_VERSION: u32 = 2;

/// Oldest journal storage schema version this build can migrate forward.
///
/// Versions below this are unknown legacy states and fail closed as unsupported.
pub const MINIMUM_SUPPORTED_SCHEMA_VERSION: u32 = 1;

/// Audit event type recorded once per applied migration batch.
const SCHEMA_MIGRATION_EVENT: &str = "journal.schema_migrated";

/// Journal-owned tables consulted when deciding whether a database already holds content.
const JOURNAL_TABLES: &[&str] = &[
    "metadata",
    "audit_events",
    "objects",
    "transactions",
    "capabilities",
    "consumed_approval_nonces",
    "idempotency",
    "staged_effects",
    "schema_migrations",
];

/// One ordered forward-migration step.
pub(crate) struct MigrationStep {
    /// Schema version the step upgrades from.
    pub(crate) from_version: u32,
    /// Schema version the step produces.
    pub(crate) to_version: u32,
    /// Human-readable step name recorded in the ledger and audit event.
    pub(crate) name: &'static str,
    /// DDL applied inside the atomic migration transaction.
    ///
    /// Deliberately lacks `IF NOT EXISTS`: an unexpected existing object must fail the migration
    /// closed instead of being silently adopted into the new version.
    pub(crate) statements: &'static str,
}

/// Ordered forward-migration chain. Every step must strictly increase the version and the chain
/// must be contiguous; this is enforced by tests and by [`pending_steps`].
pub(crate) const MIGRATION_STEPS: &[MigrationStep] = &[MigrationStep {
    from_version: 1,
    to_version: 2,
    name: "create the audit-bound schema migration ledger",
    statements: "
CREATE TABLE schema_migrations (
    from_version INTEGER NOT NULL CHECK(from_version > 0),
    to_version INTEGER NOT NULL CHECK(to_version > from_version),
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    audit_event_sequence INTEGER NOT NULL CHECK(audit_event_sequence > 0),
    audit_event_hash TEXT NOT NULL
) STRICT;
",
}];

/// One applied migration step inside a [`MigrationReport`].
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct AppliedMigrationStep {
    /// Schema version before the step.
    pub from_version: u32,
    /// Schema version after the step.
    pub to_version: u32,
    /// Step name recorded in the `schema_migrations` ledger and the audit event.
    pub name: String,
}

/// Evidence returned by a completed [`Journal::migrate`] call.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct MigrationReport {
    /// Schema version found before migration; equals `to_version` when already current.
    pub from_version: u32,
    /// Schema version after migration; always [`CURRENT_SCHEMA_VERSION`].
    pub to_version: u32,
    /// Ordered applied steps; empty when the journal was already current.
    pub applied_steps: Vec<AppliedMigrationStep>,
    /// Sequence of the `journal.schema_migrated` audit event; absent when no step ran.
    pub migration_event_sequence: Option<u64>,
    /// Consistent pre-migration snapshot written by `VACUUM INTO` before any mutation and
    /// re-opened to prove it preserved the source version and audit head.
    pub backup_path: PathBuf,
    /// Audit chain length before migration.
    pub pre_migration_audit_count: u64,
    /// Audit chain head before migration.
    pub pre_migration_audit_head: String,
    /// Audit chain length after migration.
    pub audit_event_count: u64,
    /// Audit chain head after migration.
    pub audit_head_hash: String,
    /// Whether the full post-migration verification passed; always true on success.
    pub verified: bool,
}

/// Durable storage state detected before any schema write.
pub(crate) enum SchemaState {
    /// No journal table or durable row exists; safe to initialize at the current version.
    Fresh,
    /// `metadata.schema_version` is present with this raw value.
    Versioned(String),
    /// Journal-shaped content exists without a readable version marker.
    Unversioned,
}

/// Detect the durable schema state without writing anything.
///
/// Initialization writes the schema, version marker, and anchors in one transaction, so no
/// released journal path produces a `metadata` table without `schema_version`: that state is a
/// partial-initialization remnant or a foreign database, its provenance is ambiguous, and it
/// fails closed instead of being silently adopted by `CREATE TABLE IF NOT EXISTS` healing.
///
/// # Errors
///
/// Returns [`JournalError::Database`] if `SQLite` metadata cannot be read.
pub(crate) fn schema_state(connection: &Connection) -> Result<SchemaState, JournalError> {
    if table_exists(connection, "metadata")? {
        let version: Option<String> = connection
            .query_row(
                "SELECT value FROM metadata WHERE key = 'schema_version'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(JournalError::Database)?;
        return match version {
            Some(value) => Ok(SchemaState::Versioned(value)),
            None => Ok(SchemaState::Unversioned),
        };
    }
    if journal_has_content(connection)? {
        return Ok(SchemaState::Unversioned);
    }
    Ok(SchemaState::Fresh)
}

/// Support classification for a detected `schema_version`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum VersionSupport {
    /// The version equals [`CURRENT_SCHEMA_VERSION`] and opens directly.
    Current,
    /// An older version with a complete ordered migration path to current.
    Migratable,
    /// Malformed, unknown, older than supported, or newer (downgrade attempt) versions.
    Unsupported,
}

/// Classify a parsed `schema_version` against the declared migration chain.
pub(crate) fn version_support(version: u32) -> VersionSupport {
    if version == CURRENT_SCHEMA_VERSION {
        return VersionSupport::Current;
    }
    if (MINIMUM_SUPPORTED_SCHEMA_VERSION..CURRENT_SCHEMA_VERSION).contains(&version)
        && pending_steps(version).is_ok()
    {
        return VersionSupport::Migratable;
    }
    VersionSupport::Unsupported
}

/// Gate a detected `schema_version` for [`Journal::open`]: only the current version opens.
///
/// # Errors
///
/// Returns [`JournalError::MigrationRequired`] for an older version with a complete ordered
/// migration path, and [`JournalError::UnsupportedSchemaVersion`] for malformed, unknown, or
/// newer versions (including downgrade attempts).
pub(crate) fn ensure_openable_version(value: &str) -> Result<(), JournalError> {
    let version = parse_schema_version(value)?;
    match version_support(version) {
        VersionSupport::Current => Ok(()),
        VersionSupport::Migratable => Err(JournalError::MigrationRequired {
            found: value.to_owned(),
            current: CURRENT_SCHEMA_VERSION.to_string(),
        }),
        VersionSupport::Unsupported => Err(JournalError::UnsupportedSchemaVersion {
            found: value.to_owned(),
            current: CURRENT_SCHEMA_VERSION.to_string(),
        }),
    }
}

/// Parse a `metadata.schema_version` value; anything that is not a `u32` fails closed.
///
/// # Errors
///
/// Returns [`JournalError::UnsupportedSchemaVersion`] for malformed values.
fn parse_schema_version(value: &str) -> Result<u32, JournalError> {
    value
        .parse::<u32>()
        .map_err(|_| JournalError::UnsupportedSchemaVersion {
            found: value.to_owned(),
            current: CURRENT_SCHEMA_VERSION.to_string(),
        })
}

/// Resolve the ordered pending steps from `from` to [`CURRENT_SCHEMA_VERSION`].
///
/// # Errors
///
/// Returns [`JournalError::UnsupportedSchemaVersion`] for versions newer than current, and
/// [`JournalError::Invariant`] when the declared chain is non-contiguous, non-increasing, or
/// does not land exactly on the current version. The declared chain is static, so a failure here
/// is a defect rather than operator error.
pub(crate) fn pending_steps(from: u32) -> Result<Vec<&'static MigrationStep>, JournalError> {
    if from > CURRENT_SCHEMA_VERSION {
        return Err(JournalError::UnsupportedSchemaVersion {
            found: from.to_string(),
            current: CURRENT_SCHEMA_VERSION.to_string(),
        });
    }
    let mut steps = Vec::new();
    let mut at = from;
    while at < CURRENT_SCHEMA_VERSION {
        let Some(step) = MIGRATION_STEPS.iter().find(|step| step.from_version == at) else {
            return Err(JournalError::Invariant(format!(
                "no ordered journal migration path from version {from} to {CURRENT_SCHEMA_VERSION}"
            )));
        };
        if step.to_version <= at {
            return Err(JournalError::Invariant(
                "journal migration chain is not strictly increasing".into(),
            ));
        }
        at = step.to_version;
        steps.push(step);
    }
    if at != CURRENT_SCHEMA_VERSION {
        return Err(JournalError::Invariant(
            "journal migration chain overshot the current version".into(),
        ));
    }
    Ok(steps)
}

/// Verify the `schema_migrations` ledger against `journal.schema_migrated` audit events in both
/// directions.
///
/// Every ledger row must reference a migration event by sequence and hash and must repeat a step
/// declared by that event's payload; every step declared by a migration event must have a bound
/// ledger row. The event's recorded pre-migration head and count must equal its own
/// `previous_hash` and `sequence - 1`, so a rewritten, reordered, or fabricated ledger is
/// detected. A journal without the ledger table is valid only when no migration events exist.
///
/// # Errors
///
/// Returns [`JournalError::Corrupt`] for broken bindings or malformed rows/payloads, or a
/// database error.
pub(crate) fn verify_schema_migrations(connection: &Connection) -> Result<(), JournalError> {
    let events = migration_events(connection)?;
    if !table_exists(connection, "schema_migrations")? {
        return if events.is_empty() {
            Ok(())
        } else {
            Err(JournalError::Corrupt {
                sequence: events.first().map(|event| event.sequence),
                reason: "schema migration events exist without the schema_migrations ledger".into(),
            })
        };
    }
    let mut bound_steps: Vec<(u64, (u32, u32, String))> = Vec::new();
    for row in migration_ledger(connection)? {
        let Some(event) = events
            .iter()
            .find(|event| event.sequence == row.audit_event_sequence)
        else {
            return Err(JournalError::Corrupt {
                sequence: None,
                reason: "schema migration ledger references a missing migration event".into(),
            });
        };
        if event.hash != row.audit_event_hash {
            return Err(JournalError::Corrupt {
                sequence: Some(row.audit_event_sequence),
                reason: "schema migration ledger is bound to the wrong event hash".into(),
            });
        }
        let declared = (row.from_version, row.to_version, row.name.clone());
        if !event.steps.contains(&declared) {
            return Err(JournalError::Corrupt {
                sequence: Some(row.audit_event_sequence),
                reason: "schema migration ledger disagrees with its audit event".into(),
            });
        }
        bound_steps.push((row.audit_event_sequence, declared));
    }
    for event in &events {
        let bound = bound_steps
            .iter()
            .filter(|(sequence, _)| *sequence == event.sequence)
            .map(|(_, step)| step.clone())
            .collect::<Vec<_>>();
        let complete = event.steps.iter().all(|declared| bound.contains(declared));
        if !complete || bound.len() != event.steps.len() {
            return Err(JournalError::Corrupt {
                sequence: Some(event.sequence),
                reason: "schema migration audit event is not bound to its ledger rows".into(),
            });
        }
    }
    Ok(())
}

/// Read and validate every `journal.schema_migrated` audit event.
fn migration_events(connection: &Connection) -> Result<Vec<MigrationEventRow>, JournalError> {
    let mut statement = connection
        .prepare(
            "SELECT sequence, hash, previous_hash, payload_json FROM audit_events WHERE event_type = ?1 ORDER BY sequence",
        )
        .map_err(JournalError::Database)?;
    let mut rows = statement
        .query(params![SCHEMA_MIGRATION_EVENT])
        .map_err(JournalError::Database)?;
    let mut events = Vec::new();
    while let Some(row) = rows.next().map_err(JournalError::Database)? {
        let raw_sequence: i64 = row.get(0).map_err(JournalError::Database)?;
        let sequence = u64::try_from(raw_sequence).map_err(|_| JournalError::Corrupt {
            sequence: None,
            reason: "schema migration event has a negative sequence".into(),
        })?;
        let payload_json: String = row.get(3).map_err(JournalError::Database)?;
        let payload: Value =
            serde_json::from_str(&payload_json).map_err(|_| JournalError::Corrupt {
                sequence: Some(sequence),
                reason: "schema migration event has malformed JSON".into(),
            })?;
        let previous_hash: String = row.get(2).map_err(JournalError::Database)?;
        events.push(MigrationEventRow {
            sequence,
            hash: row.get(1).map_err(JournalError::Database)?,
            steps: migration_event_steps(sequence, &previous_hash, &payload)?,
        });
    }
    Ok(events)
}

/// Read and shape-validate every `schema_migrations` ledger row.
fn migration_ledger(connection: &Connection) -> Result<Vec<LedgerStep>, JournalError> {
    let mut statement = connection
        .prepare(
            "SELECT from_version, to_version, name, applied_at, audit_event_sequence, audit_event_hash FROM schema_migrations ORDER BY audit_event_sequence, from_version",
        )
        .map_err(JournalError::Database)?;
    let mut rows = statement.query([]).map_err(JournalError::Database)?;
    let mut ledger = Vec::new();
    while let Some(row) = rows.next().map_err(JournalError::Database)? {
        let raw_from: i64 = row.get(0).map_err(JournalError::Database)?;
        let raw_to: i64 = row.get(1).map_err(JournalError::Database)?;
        let applied_at: String = row.get(3).map_err(JournalError::Database)?;
        let raw_event_sequence: i64 = row.get(4).map_err(JournalError::Database)?;
        let versions = (u32::try_from(raw_from).ok(), u32::try_from(raw_to).ok());
        let (from_version, to_version) = match versions {
            (Some(from_version), Some(to_version)) if to_version > from_version => {
                (from_version, to_version)
            }
            _ => {
                return Err(JournalError::Corrupt {
                    sequence: None,
                    reason: "schema migration ledger has an invalid version range".into(),
                });
            }
        };
        chrono::DateTime::parse_from_rfc3339(&applied_at).map_err(|_| JournalError::Corrupt {
            sequence: None,
            reason: "schema migration ledger has a malformed applied_at".into(),
        })?;
        ledger.push(LedgerStep {
            from_version,
            to_version,
            name: row.get(2).map_err(JournalError::Database)?,
            audit_event_sequence: u64::try_from(raw_event_sequence).map_err(|_| {
                JournalError::Corrupt {
                    sequence: None,
                    reason: "schema migration ledger has a negative audit event sequence".into(),
                }
            })?,
            audit_event_hash: row.get(5).map_err(JournalError::Database)?,
        });
    }
    Ok(ledger)
}

/// One parsed `journal.schema_migrated` audit event used by [`verify_schema_migrations`].
struct MigrationEventRow {
    sequence: u64,
    hash: String,
    steps: Vec<(u32, u32, String)>,
}

/// One shape-validated `schema_migrations` ledger row.
struct LedgerStep {
    from_version: u32,
    to_version: u32,
    name: String,
    audit_event_sequence: u64,
    audit_event_hash: String,
}

/// Validate a `journal.schema_migrated` payload and return its declared steps.
///
/// The payload's recorded pre-migration audit count and head must equal the event's own
/// `sequence - 1` and `previous_hash`, so a forged, reordered, or replayed migration claim is
/// detected.
fn migration_event_steps(
    sequence: u64,
    previous_hash: &str,
    payload: &Value,
) -> Result<Vec<(u32, u32, String)>, JournalError> {
    let malformed = |reason: &str| JournalError::Corrupt {
        sequence: Some(sequence),
        reason: format!("schema migration event payload is malformed: {reason}"),
    };
    if payload.get("schema_migration") != Some(&Value::Bool(true)) {
        return Err(malformed("missing schema_migration marker"));
    }
    let from_version = payload
        .get("from_version")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| malformed("invalid from_version"))?;
    let to_version = payload
        .get("to_version")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| malformed("invalid to_version"))?;
    let pre_count = payload
        .get("pre_migration_audit_count")
        .and_then(Value::as_u64)
        .ok_or_else(|| malformed("invalid pre_migration_audit_count"))?;
    let pre_head = payload
        .get("pre_migration_audit_head")
        .and_then(Value::as_str)
        .ok_or_else(|| malformed("invalid pre_migration_audit_head"))?;
    let steps = payload
        .get("steps")
        .and_then(Value::as_array)
        .ok_or_else(|| malformed("invalid steps"))?;
    let mut declared = Vec::with_capacity(steps.len());
    let mut at = from_version;
    for step in steps {
        let step_from = step
            .get("from_version")
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
            .ok_or_else(|| malformed("invalid step from_version"))?;
        let step_to = step
            .get("to_version")
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
            .ok_or_else(|| malformed("invalid step to_version"))?;
        let step_name = step
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| malformed("invalid step name"))?;
        if step_from != at || step_to <= step_from {
            return Err(malformed("steps are not a contiguous increasing chain"));
        }
        at = step_to;
        declared.push((step_from, step_to, step_name.to_owned()));
    }
    if declared.is_empty() || at != to_version {
        return Err(malformed("steps do not reach the event's to_version"));
    }
    if pre_count != sequence.saturating_sub(1) {
        return Err(malformed(
            "pre_migration_audit_count disagrees with the event sequence",
        ));
    }
    if pre_head != previous_hash {
        return Err(malformed(
            "pre_migration_audit_head disagrees with the event's previous_hash",
        ));
    }
    Ok(declared)
}

/// Run the complete verification suite used by [`Journal::verify_chain`] as a hard error.
///
/// The suite checks the event chain, every audit-bound durable state, receipt authentication,
/// and the schema-migration ledger in both directions.
///
/// # Errors
///
/// Returns [`JournalError::Corrupt`] when any evidence is invalid, or a database error.
pub(crate) fn require_valid_journal(
    connection: &Connection,
    receipt_key: &[u8; 32],
    receipt_key_id: &str,
    context: &'static str,
) -> Result<(), JournalError> {
    let verification = verify_events_streaming(connection)?;
    if !verification.valid {
        return Err(JournalError::Corrupt {
            sequence: verification.first_invalid_sequence,
            reason: format!("{context} failed: {}", verification.message),
        });
    }
    verify_transaction_snapshots(connection)?;
    verify_capability_snapshots(connection)?;
    verify_approval_consumptions(connection)?;
    verify_object_snapshots(connection)?;
    verify_staged_effects(connection)?;
    verify_idempotency_snapshots(connection)?;
    verify_idempotency_receipts_with(connection, receipt_key, receipt_key_id)?;
    verify_schema_migrations(connection)?;
    Ok(())
}

/// Whether a journal table exists in `sqlite_master`.
fn table_exists(connection: &Connection, name: &str) -> Result<bool, JournalError> {
    connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            params![name],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count > 0)
        .map_err(JournalError::Database)
}

/// Whether any journal table holds at least one row.
fn journal_has_content(connection: &Connection) -> Result<bool, JournalError> {
    for table in JOURNAL_TABLES {
        if table_exists(connection, table)? {
            let count: i64 = connection
                .query_row(&format!("SELECT COUNT(*) FROM \"{table}\""), [], |row| {
                    row.get(0)
                })
                .map_err(JournalError::Database)?;
            if count > 0 {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Restore missing audit anchors for an empty journal only.
///
/// Every journal written by a released v0.1 binary already carries the `audit_event_count` and
/// `audit_head_hash` metadata anchors; a crash during the very first initialization can leave a
/// versioned database without them. Deriving anchors is provably safe only when the chain is
/// empty — a non-empty journal with missing anchors cannot distinguish a first-init crash from
/// anchor deletion, so it fails closed instead of re-anchoring possibly truncated evidence.
///
/// # Errors
///
/// Returns [`JournalError::Corrupt`] when anchors are partially present or absent on a non-empty
/// chain, or a database error.
fn ensure_migration_anchors(connection: &Connection) -> Result<(), JournalError> {
    let count: Option<String> = connection
        .query_row(
            "SELECT value FROM metadata WHERE key = 'audit_event_count'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(JournalError::Database)?;
    let head: Option<String> = connection
        .query_row(
            "SELECT value FROM metadata WHERE key = 'audit_head_hash'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(JournalError::Database)?;
    match (count, head) {
        (Some(_), Some(_)) => Ok(()),
        (None, None) => {
            let events: i64 = connection
                .query_row("SELECT COUNT(*) FROM audit_events", [], |row| row.get(0))
                .map_err(JournalError::Database)?;
            if events != 0 {
                return Err(JournalError::Corrupt {
                    sequence: None,
                    reason:
                        "audit anchors are missing from a non-empty journal; provenance cannot be established"
                            .into(),
                });
            }
            connection
                .execute(
                    "INSERT OR IGNORE INTO metadata(key, value) VALUES ('audit_event_count', '0')",
                    [],
                )
                .map_err(JournalError::Database)?;
            connection
                .execute(
                    "INSERT OR IGNORE INTO metadata(key, value) VALUES ('audit_head_hash', ?1)",
                    params![crate::GENESIS_HASH],
                )
                .map_err(JournalError::Database)?;
            Ok(())
        }
        _ => Err(JournalError::Corrupt {
            sequence: None,
            reason: "audit anchors are partially missing".into(),
        }),
    }
}

/// Write a consistent snapshot of the journal to `backup_path` via `VACUUM INTO`.
///
/// `VACUUM INTO` refuses to overwrite an existing file and cannot run inside a transaction, so it
/// executes on the open connection in autocommit before the migration transaction begins.
fn backup_database(connection: &Connection, backup_path: &Path) -> Result<(), JournalError> {
    let target = backup_path.to_str().ok_or_else(|| {
        JournalError::Invariant("migration backup path is not valid UTF-8".into())
    })?;
    connection
        .execute("VACUUM INTO ?1", params![target])
        .map_err(JournalError::Database)?;
    Ok(())
}

/// Re-open a written backup and prove it preserved the source version and audit anchor.
fn verify_backup_snapshot(
    backup_path: &Path,
    expected_version: u32,
    expected_count: u64,
    expected_head: &str,
) -> Result<(), JournalError> {
    let connection = Connection::open(backup_path).map_err(JournalError::Database)?;
    match schema_state(&connection)? {
        SchemaState::Versioned(value) if value == expected_version.to_string() => {}
        _ => {
            return Err(JournalError::Invariant(
                "migration backup does not preserve the source schema version".into(),
            ));
        }
    }
    let (count, head) = audit_anchor(&connection)?;
    if count != expected_count || head != expected_head {
        return Err(JournalError::Invariant(
            "migration backup does not preserve the source audit head".into(),
        ));
    }
    Ok(())
}

impl Journal {
    /// Migrate a durable journal at `database_path` to [`CURRENT_SCHEMA_VERSION`].
    ///
    /// This is the explicit, operator-invoked migration path: [`Journal::open`] never rewrites an
    /// older journal in place and instead fails with [`JournalError::MigrationRequired`]. Stop the
    /// daemon before migrating — the migration takes an immediate write transaction and fails
    /// closed under a live writer.
    ///
    /// The migration verifies the complete audit chain and every audit-bound durable state before
    /// writing, records a consistent `VACUUM INTO` backup at `backup_path` (which must not already
    /// exist), applies every pending ordered step inside one immediate transaction together with a
    /// `journal.schema_migrated` audit event and bound `schema_migrations` ledger rows, verifies
    /// the migrated journal inside the same transaction, and commits only when verification
    /// passes. A crash or failure at any point leaves the prior version intact and readable.
    ///
    /// Already-current journals are verified and backed up without applying steps. Malformed,
    /// unknown, or newer versions — including downgrade attempts — fail closed without writing.
    ///
    /// # Errors
    ///
    /// Returns [`JournalError::Invariant`] for unusable paths or a missing journal,
    /// [`JournalError::UnsupportedSchemaVersion`] for malformed/unknown/newer versions,
    /// [`JournalError::Corrupt`] when pre- or post-migration verification fails, or a database or
    /// I/O error.
    pub fn migrate(
        database_path: impl AsRef<Path>,
        key_path: impl AsRef<Path>,
        backup_path: impl AsRef<Path>,
    ) -> Result<MigrationReport, JournalError> {
        let database_path = database_path.as_ref();
        let backup_path = backup_path.as_ref();
        checked_migrate_paths(database_path, backup_path)?;
        let mut connection = Connection::open(database_path).map_err(JournalError::Database)?;
        configure_connection(&connection, true)?;
        let (found, steps) = planned_migration_steps(&connection)?;
        let key = load_or_create_key(key_path.as_ref())?;
        let key_id = receipt_key_id(&key);
        ensure_migration_anchors(&connection)?;
        require_valid_journal(&connection, &key, &key_id, "pre-migration verification")?;
        let (pre_count, pre_head) = audit_anchor(&connection)?;
        backup_database(&connection, backup_path)?;
        verify_backup_snapshot(backup_path, found, pre_count, &pre_head)?;
        let event = if steps.is_empty() {
            None
        } else {
            Some(apply_migration(
                &mut connection,
                found,
                &steps,
                pre_count,
                &pre_head,
                &key,
                &key_id,
            )?)
        };
        let (post_count, post_head) = audit_anchor(&connection)?;
        Ok(MigrationReport {
            from_version: found,
            to_version: CURRENT_SCHEMA_VERSION,
            applied_steps: steps
                .iter()
                .map(|step| AppliedMigrationStep {
                    from_version: step.from_version,
                    to_version: step.to_version,
                    name: step.name.to_owned(),
                })
                .collect(),
            migration_event_sequence: event.map(|event| event.sequence),
            backup_path: backup_path.to_path_buf(),
            pre_migration_audit_count: pre_count,
            pre_migration_audit_head: pre_head,
            audit_event_count: post_count,
            audit_head_hash: post_head,
            verified: true,
        })
    }
}

/// Validate migration paths before the journal is touched.
///
/// # Errors
///
/// Returns [`JournalError::Invariant`] when the database is absent, the backup equals the
/// database, or the backup already exists (a recorded backup is never overwritten), or
/// [`JournalError::Io`] when the backup directory cannot be created.
fn checked_migrate_paths(database_path: &Path, backup_path: &Path) -> Result<(), JournalError> {
    if !database_path.is_file() {
        return Err(JournalError::Invariant(format!(
            "no journal database exists at {}; nothing to migrate",
            database_path.display()
        )));
    }
    if database_path == backup_path {
        return Err(JournalError::Invariant(
            "migration backup path must differ from the journal database".into(),
        ));
    }
    if backup_path.exists() {
        return Err(JournalError::Invariant(
            "migration backup path already exists; refusing to overwrite".into(),
        ));
    }
    if let Some(parent) = backup_path.parent() {
        fs::create_dir_all(parent).map_err(|source| JournalError::Io {
            operation: "create migration backup directory",
            path: parent.to_path_buf(),
            source,
        })?;
    }
    Ok(())
}

/// Resolve the declared version and ordered pending steps, failing closed on unsupported states.
fn planned_migration_steps(
    connection: &Connection,
) -> Result<(u32, Vec<&'static MigrationStep>), JournalError> {
    let (found, raw_version) = match schema_state(connection)? {
        SchemaState::Fresh => {
            return Err(JournalError::Invariant(
                "database is not an initialized journal; nothing to migrate".into(),
            ));
        }
        SchemaState::Unversioned => {
            return Err(JournalError::UnsupportedSchemaVersion {
                found: "<missing>".to_owned(),
                current: CURRENT_SCHEMA_VERSION.to_string(),
            });
        }
        SchemaState::Versioned(value) => (parse_schema_version(&value)?, value),
    };
    let steps = match version_support(found) {
        VersionSupport::Current => Vec::new(),
        VersionSupport::Migratable => pending_steps(found)?,
        VersionSupport::Unsupported => {
            return Err(JournalError::UnsupportedSchemaVersion {
                found: raw_version,
                current: CURRENT_SCHEMA_VERSION.to_string(),
            });
        }
    };
    Ok((found, steps))
}

/// Apply pending steps plus the audit-bound migration record inside one immediate transaction.
///
/// The version bump, step DDL, `journal.schema_migrated` audit event, ledger rows, and the
/// complete post-migration verification either commit together or roll back together.
fn apply_migration(
    connection: &mut Connection,
    found: u32,
    steps: &[&MigrationStep],
    pre_count: u64,
    pre_head: &str,
    key: &[u8; 32],
    key_id: &str,
) -> Result<AuditEvent, JournalError> {
    let sql = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(JournalError::Database)?;
    for step in steps {
        sql.execute_batch(step.statements)
            .map_err(JournalError::Database)?;
    }
    let event = append_event_in_transaction(
        &sql,
        None,
        SCHEMA_MIGRATION_EVENT,
        None,
        json!({
            "schema_migration": true,
            "from_version": found,
            "to_version": CURRENT_SCHEMA_VERSION,
            "steps": steps
                .iter()
                .map(|step| json!({
                    "from_version": step.from_version,
                    "to_version": step.to_version,
                    "name": step.name,
                }))
                .collect::<Vec<_>>(),
            "pre_migration_audit_count": pre_count,
            "pre_migration_audit_head": pre_head,
        }),
    )?;
    let applied_at = Utc::now().to_rfc3339();
    for step in steps {
        sql.execute(
            "INSERT INTO schema_migrations(from_version, to_version, name, applied_at, audit_event_sequence, audit_event_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                step.from_version,
                step.to_version,
                step.name,
                applied_at,
                i64_from_u64(event.sequence)?,
                event.hash,
            ],
        )
        .map_err(JournalError::Database)?;
    }
    let updated = sql
        .execute(
            "UPDATE metadata SET value = ?1 WHERE key = 'schema_version' AND value = ?2",
            params![CURRENT_SCHEMA_VERSION.to_string(), found.to_string()],
        )
        .map_err(JournalError::Database)?;
    if updated != 1 {
        return Err(JournalError::Invariant(
            "journal schema version changed during migration".into(),
        ));
    }
    require_valid_journal(&sql, key, key_id, "post-migration verification")?;
    sql.commit().map_err(JournalError::Database)?;
    Ok(event)
}
