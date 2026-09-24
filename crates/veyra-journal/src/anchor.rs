//! Operator-held authenticated audit anchors kept outside `SQLite`.
//!
//! [`Journal::verify_chain`] proves the journal is internally consistent against the
//! transactionally maintained local count/head anchor, but a privileged attacker who rewrites
//! the database and that local anchor together can construct a new self-consistent chain — the
//! one residual the local anchor cannot cover. An exported [`AuditAnchor`] closes that gap for
//! checkpoints the operator stores outside the journal directory: the HMAC-authenticated record
//! pins `(event_count, head_hash)` at export time, and [`Journal::verify_audit_anchor`] confirms
//! the chain still contains that exact head at the anchored sequence. A rewritten history
//! cannot reproduce the pinned hash; the remaining evasion is replacing the operator's stored
//! anchor file too, which is the documented trust boundary. The anchor is locally
//! authenticated evidence like a receipt — it is not remote attestation, a transparency log,
//! or non-repudiation.

use chrono::Utc;
use hmac::{KeyInit, Mac};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use veyra_protocol::{AuditEvent, canonical_json};

use crate::{
    CURRENT_SCHEMA_VERSION, GENESIS_HASH, HmacSha256, Journal, JournalError, audit_anchor,
    audit_event_from_row, decode_hex, encode_hex, event_hash, i64_from_u64, valid_sha256_hex,
};

/// Serialized schema marker for [`AuditAnchor`]; the only version this build produces or
/// accepts.
pub const AUDIT_ANCHOR_SCHEMA_VERSION: &str = "veyra.audit-anchor/v1";

/// An HMAC-authenticated checkpoint of the audit chain head, exported for storage outside the
/// journal directory.
///
/// `authentication` is HMAC-SHA-256 (hex) over the canonical serialization of the anchor with
/// the field cleared, keyed by the same local key that signs receipts. Every field except
/// `authentication` is covered, so a forged or field-tampered anchor never verifies.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AuditAnchor {
    /// Artifact schema version; always [`AUDIT_ANCHOR_SCHEMA_VERSION`].
    pub schema_version: String,
    /// RFC 3339 export timestamp. Informational and authenticated; a fresh anchor can claim
    /// any timestamp, so it orders operator copies rather than proving real time.
    pub created_at: String,
    /// Journal storage schema version that produced the anchor.
    pub journal_schema_version: u32,
    /// Number of audit events in the chain when the anchor was exported.
    pub event_count: u64,
    /// Hash of the event at `event_count`, or the all-zero genesis hash for an empty chain.
    pub head_hash: String,
    /// Public identifier of the local HMAC key that authenticated the anchor; anchors verify
    /// only against the journal whose `receipt.key` signed them.
    pub signer_key_id: String,
    /// Hex-encoded HMAC-SHA-256 authentication tag over the remaining fields.
    pub authentication: String,
}

/// Result of comparing an exported [`AuditAnchor`] against the live journal.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct AnchorVerification {
    /// Whether the anchor authenticated and the pinned head is still present in the chain.
    pub valid: bool,
    /// Event count the anchor pinned at export.
    pub anchor_event_count: u64,
    /// Head hash the anchor pinned at export.
    pub anchor_head_hash: String,
    /// Events currently recorded in the journal.
    pub current_event_count: u64,
    /// Safe human-readable outcome.
    pub message: String,
}

/// Compute the authentication tag an honest export would carry for `anchor`.
///
/// # Errors
///
/// Returns a canonical serialization error.
fn anchor_authentication(key: &[u8; 32], anchor: &AuditAnchor) -> Result<String, JournalError> {
    let mut unsigned = anchor.clone();
    unsigned.authentication.clear();
    let bytes = canonical_json(&unsigned).map_err(JournalError::Canonical)?;
    let mut mac = HmacSha256::new_from_slice(key)
        .map_err(|_| JournalError::Invariant("invalid receipt key length".into()))?;
    mac.update(&bytes);
    Ok(encode_hex(&mac.finalize().into_bytes()))
}

/// Read the audit event stored at `sequence`, if the chain still contains it.
///
/// # Errors
///
/// Returns a database error, [`JournalError::Corrupt`] when the row is malformed, or
/// [`JournalError::Invariant`] when `sequence` exceeds the `SQLite` integer range.
fn audit_event_at_sequence(
    connection: &Connection,
    sequence: u64,
) -> Result<Option<AuditEvent>, JournalError> {
    let mut statement = connection
        .prepare(
            "SELECT id, transaction_id, sequence, event_type, causal_parent, payload_json, previous_hash, hash, recorded_at FROM audit_events WHERE sequence = ?1",
        )
        .map_err(JournalError::Database)?;
    let mut rows = statement
        .query(params![i64_from_u64(sequence)?])
        .map_err(JournalError::Database)?;
    match rows.next().map_err(JournalError::Database)? {
        Some(row) => Ok(Some(audit_event_from_row(row)?)),
        None => Ok(None),
    }
}

impl Journal {
    /// Export an HMAC-authenticated checkpoint of the current audit chain head.
    ///
    /// The returned [`AuditAnchor`] is a small JSON artifact meant to be written to a file or
    /// copied to storage outside the data directory — another host, a versioned backup, or a
    /// read-only medium. It authenticates with the same local key that signs receipts, so it
    /// proves the anchor was exported by this journal's key holder; it cannot prove that to
    /// anyone else.
    ///
    /// # Errors
    ///
    /// Returns a database, canonicalization, or integrity error when the local anchor is
    /// unreadable.
    pub fn export_audit_anchor(&self) -> Result<AuditAnchor, JournalError> {
        let (event_count, head_hash) = {
            let connection = self.lock()?;
            audit_anchor(&connection)?
        };
        let mut anchor = AuditAnchor {
            schema_version: AUDIT_ANCHOR_SCHEMA_VERSION.to_owned(),
            created_at: Utc::now().to_rfc3339(),
            journal_schema_version: CURRENT_SCHEMA_VERSION,
            event_count,
            head_hash,
            signer_key_id: self.receipt_key_id.to_string(),
            authentication: String::new(),
        };
        anchor.authentication = anchor_authentication(&self.receipt_key, &anchor)?;
        Ok(anchor)
    }

    /// Verify a previously exported [`AuditAnchor`] against the live journal.
    ///
    /// Verification succeeds only when the anchor carries the expected schema version,
    /// authenticates under this journal's receipt key, and the chain still contains the exact
    /// pinned head at the anchored sequence. A journal that was truncated, rewritten, or
    /// replaced after export therefore fails even when its internal verification passes —
    /// this is the check that detects a whole-database rewrite the local anchor cannot see.
    /// Later legitimate appends do not invalidate an older anchor: the pinned event only has
    /// to remain present with its recorded hash.
    ///
    /// An anchor authenticates only against the journal whose `receipt.key` signed it.
    /// Anchor mismatches are reported as a successful [`AnchorVerification`] with
    /// `valid: false`; only storage and internal failures are returned as errors.
    ///
    /// # Errors
    ///
    /// Returns a database, serialization, or integrity error when the journal cannot be
    /// evaluated.
    pub fn verify_audit_anchor(
        &self,
        anchor: &AuditAnchor,
    ) -> Result<AnchorVerification, JournalError> {
        let connection = self.lock()?;
        let (current_event_count, _) = audit_anchor(&connection)?;
        let report = |valid: bool, message: &str| AnchorVerification {
            valid,
            anchor_event_count: anchor.event_count,
            anchor_head_hash: anchor.head_hash.clone(),
            current_event_count,
            message: message.to_owned(),
        };
        if anchor.schema_version != AUDIT_ANCHOR_SCHEMA_VERSION {
            return Ok(report(
                false,
                "audit anchor uses an unsupported schema version",
            ));
        }
        if anchor.signer_key_id != *self.receipt_key_id {
            return Ok(report(
                false,
                "audit anchor was authenticated by a different journal key",
            ));
        }
        if !valid_sha256_hex(&anchor.head_hash) || !valid_sha256_hex(&anchor.authentication) {
            return Ok(report(false, "audit anchor fields are malformed"));
        }
        if chrono::DateTime::parse_from_rfc3339(&anchor.created_at).is_err() {
            return Ok(report(false, "audit anchor timestamp is malformed"));
        }
        let expected =
            decode_hex(&anchor_authentication(&self.receipt_key, anchor)?).unwrap_or_default();
        let provided = decode_hex(&anchor.authentication).unwrap_or_default();
        if provided.ct_eq(&expected).unwrap_u8() != 1 {
            return Ok(report(false, "audit anchor authentication does not verify"));
        }
        if anchor.event_count == 0 {
            return Ok(if anchor.head_hash == GENESIS_HASH {
                report(
                    true,
                    "audit anchor matches the empty journal's genesis head",
                )
            } else {
                report(
                    false,
                    "audit anchor pins a non-genesis head for an empty chain",
                )
            });
        }
        if i64::try_from(anchor.event_count).is_err() {
            return Ok(report(
                false,
                "audit anchor event count exceeds the supported range",
            ));
        }
        let Some(event) = audit_event_at_sequence(&connection, anchor.event_count)? else {
            return Ok(report(
                false,
                "the anchored audit event is no longer present; the journal was truncated or rewritten after export",
            ));
        };
        let recomputed = event_hash(
            event.id,
            event.transaction_id,
            event.sequence,
            &event.event_type,
            event.causal_parent.as_deref(),
            &event.payload,
            &event.previous_hash,
            event.recorded_at,
        )?;
        if recomputed != anchor.head_hash {
            return Ok(report(
                false,
                "the anchored audit head does not match the journal; history was rewritten after export",
            ));
        }
        Ok(report(
            true,
            "audit anchor matches the recorded journal head",
        ))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn journal() -> Journal {
        Journal::in_memory([7; 32]).unwrap()
    }

    /// Re-sign a mutated anchor so semantic checks — not just the MAC — are exercised.
    fn sign_with(key: &[u8; 32], anchor: &AuditAnchor) -> AuditAnchor {
        let mut signed = anchor.clone();
        signed.authentication = anchor_authentication(key, &signed).unwrap();
        signed
    }

    #[test]
    fn exported_anchor_verifies_while_later_appends_stay_valid() {
        let journal = journal();
        journal
            .append_event(None, "first", None, json!({"n": 1}))
            .unwrap();
        journal
            .append_event(None, "second", None, json!({"n": 2}))
            .unwrap();
        let anchor = journal.export_audit_anchor().unwrap();
        assert_eq!(anchor.event_count, 2);
        assert_eq!(anchor.schema_version, AUDIT_ANCHOR_SCHEMA_VERSION);
        assert_eq!(anchor.journal_schema_version, CURRENT_SCHEMA_VERSION);
        let verification = journal.verify_audit_anchor(&anchor).unwrap();
        assert!(verification.valid);
        assert_eq!(verification.current_event_count, 2);

        journal
            .append_event(None, "third", None, json!({"n": 3}))
            .unwrap();
        let verification = journal.verify_audit_anchor(&anchor).unwrap();
        assert!(verification.valid);
        assert_eq!(verification.current_event_count, 3);
        assert_eq!(verification.anchor_event_count, 2);
    }

    #[test]
    fn genesis_anchor_pins_the_empty_chain_head() {
        let journal = journal();
        let anchor = journal.export_audit_anchor().unwrap();
        assert_eq!(anchor.event_count, 0);
        assert_eq!(anchor.head_hash, GENESIS_HASH);
        assert!(journal.verify_audit_anchor(&anchor).unwrap().valid);

        // A correctly authenticated anchor that pins a non-genesis head for an empty chain is
        // still rejected semantically.
        let mut wrong = anchor.clone();
        wrong.head_hash = "ab".repeat(32);
        let wrong = sign_with(&[7; 32], &wrong);
        assert!(!journal.verify_audit_anchor(&wrong).unwrap().valid);
    }

    #[test]
    fn exported_anchor_detects_rewritten_journal_history() {
        let original = journal();
        original
            .append_event(None, "first", None, json!({"n": 1}))
            .unwrap();
        original
            .append_event(None, "second", None, json!({"n": 2}))
            .unwrap();
        let anchor = original.export_audit_anchor().unwrap();

        // A privileged attacker rewrote the whole database into a new self-consistent chain
        // under the same key: every event now carries different content, so the pinned head
        // can never be reproduced even though the chain verifies internally.
        let rewritten = journal();
        rewritten
            .append_event(None, "first", None, json!({"n": 1}))
            .unwrap();
        rewritten
            .append_event(None, "forged", None, json!({"n": 2}))
            .unwrap();
        assert!(rewritten.verify_chain().unwrap().valid);
        let verification = rewritten.verify_audit_anchor(&anchor).unwrap();
        assert!(!verification.valid);
        assert_eq!(verification.current_event_count, 2);

        // A longer forged chain still cannot place the pinned head at sequence 2.
        rewritten
            .append_event(None, "third", None, json!({"n": 3}))
            .unwrap();
        assert!(!rewritten.verify_audit_anchor(&anchor).unwrap().valid);

        // A truncated journal no longer contains the anchored event at all.
        let truncated = journal();
        truncated
            .append_event(None, "only", None, json!({}))
            .unwrap();
        assert!(!truncated.verify_audit_anchor(&anchor).unwrap().valid);
    }

    #[test]
    fn forged_or_foreign_audit_anchors_are_rejected() {
        let journal = journal();
        journal
            .append_event(None, "first", None, json!({}))
            .unwrap();
        let anchor = journal.export_audit_anchor().unwrap();

        // A bit-flipped authentication tag never verifies.
        let mut tampered = anchor.clone();
        let replacement = if tampered.authentication.starts_with('0') {
            '1'
        } else {
            '0'
        };
        tampered.authentication = format!("{replacement}{}", &tampered.authentication[1..]);
        assert!(!journal.verify_audit_anchor(&tampered).unwrap().valid);

        // An anchor claiming another signer fails before content checks.
        let mut foreign = anchor.clone();
        foreign.signer_key_id = "local-hmac-sha256:0000000000000000".into();
        assert!(!journal.verify_audit_anchor(&foreign).unwrap().valid);

        // Unknown artifact versions fail closed.
        let mut unknown = anchor.clone();
        unknown.schema_version = "veyra.audit-anchor/v0".into();
        assert!(!journal.verify_audit_anchor(&unknown).unwrap().valid);

        // An anchor genuinely produced by a different journal key never authenticates here.
        let other = Journal::in_memory([9; 32]).unwrap();
        let foreign_anchor = other.export_audit_anchor().unwrap();
        assert!(!journal.verify_audit_anchor(&foreign_anchor).unwrap().valid);

        // Malformed fields fail before the MAC comparison.
        let mut malformed = anchor.clone();
        malformed.authentication = "not-hex".into();
        assert!(!journal.verify_audit_anchor(&malformed).unwrap().valid);
        let mut malformed = anchor.clone();
        malformed.created_at = "not-a-timestamp".into();
        assert!(!journal.verify_audit_anchor(&malformed).unwrap().valid);

        // A field change signed by the same key authenticates but fails the head check, so a
        // key holder can mint new anchors yet cannot make an old claim match new history.
        let mut moved = anchor.clone();
        moved.event_count = 9_999;
        let moved = sign_with(&[7; 32], &moved);
        assert!(!journal.verify_audit_anchor(&moved).unwrap().valid);
    }

    #[test]
    fn anchor_json_round_trips_and_rejects_unknown_fields() {
        let journal = journal();
        let anchor = journal.export_audit_anchor().unwrap();
        let serialized = serde_json::to_string(&anchor).unwrap();
        let parsed: AuditAnchor = serde_json::from_str(&serialized).unwrap();
        assert_eq!(parsed, anchor);

        let with_extra = format!("{},\"extra\":true}}", serialized.trim_end_matches('}'));
        assert!(serde_json::from_str::<AuditAnchor>(&with_extra).is_err());
    }
}
