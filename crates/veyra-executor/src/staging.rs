//! Shared contract for policy-driven retention of durable staging artifacts.
//!
//! Adapters that keep durable recovery artifacts expose them to the trusted kernel through
//! [`EffectAdapter::collect_staging`](crate::EffectAdapter::collect_staging). The kernel alone
//! decides which transactions are eligible: adapters receive a journal-authenticated map and
//! must fail closed on every entry that is absent, malformed, unreadable, or ambiguous.

use std::collections::BTreeMap;

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use veyra_protocol::{TransactionId, TransactionState};

use crate::AdapterError;

/// Maximum entries enumerated from one staging root in a single sweep.
pub const MAXIMUM_SWEEP_ENTRIES: usize = 65_536;
/// Maximum anomalies carried in one sweep report.
pub const MAXIMUM_REPORTED_ANOMALIES: usize = 64;
/// Maximum directory depth below one transaction's staging root.
pub const MAXIMUM_STAGE_TREE_DEPTH: usize = 16;
/// Maximum filesystem entries inside one transaction's staging tree.
pub const MAXIMUM_STAGE_TREE_ENTRIES: usize = 4_096;

/// Retention rules for durable staging artifacts bound to final transactions.
///
/// A transaction's staging tree is collectible only when the journal shows it in one of
/// `collect_states` for at least `minimum_terminal_age`. The kernel additionally requires
/// every collected state to be a true sink of the transaction state graph — a state that can
/// still reach `compensating` keeps its recovery artifacts forever, which is why `committed`,
/// `failed`, and `manual_recovery` can never be collected.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StagingRetentionPolicy {
    /// Minimum time the transaction must already have spent in a collectible final state.
    pub minimum_terminal_age: Duration,
    /// Final transaction states whose durable staging may be reclaimed.
    pub collect_states: Vec<TransactionState>,
    /// Maximum transaction staging trees reclaimed in one sweep.
    pub maximum_sweep_transactions: usize,
    /// Maximum total staged bytes reclaimed in one sweep.
    pub maximum_sweep_bytes: u64,
    /// Report what would be reclaimed without deleting anything.
    pub dry_run: bool,
}

impl StagingRetentionPolicy {
    /// Conservative defaults: seven days of retention for states that can never recover.
    ///
    /// `partially_compensated` is excluded by default because its staging artifacts are the
    /// last copy of manual-recovery evidence; operators must opt in explicitly.
    pub fn conservative() -> Self {
        Self {
            minimum_terminal_age: Duration::days(7),
            collect_states: vec![
                TransactionState::Denied,
                TransactionState::RolledBack,
                TransactionState::Cancelled,
            ],
            maximum_sweep_transactions: 128,
            maximum_sweep_bytes: 1024 * 1024 * 1024,
            dry_run: false,
        }
    }

    /// Check structural bounds shared by every adapter.
    ///
    /// The kernel separately validates that every `collect_states` entry is a final state.
    ///
    /// # Errors
    ///
    /// Returns [`AdapterError::Policy`] when a bound is zero, the age is negative, the state
    /// set is empty, or the set contains duplicates.
    pub fn validate(&self) -> Result<(), AdapterError> {
        if self.collect_states.is_empty()
            || self.minimum_terminal_age < Duration::zero()
            || self.maximum_sweep_transactions == 0
            || self.maximum_sweep_bytes == 0
        {
            return Err(AdapterError::Policy(
                "staging retention requires a non-empty state set, non-negative age, and nonzero sweep limits".into(),
            ));
        }
        let mut unique = self.collect_states.clone();
        unique.sort_by_key(|state| *state as u8);
        unique.dedup();
        if unique.len() != self.collect_states.len() {
            return Err(AdapterError::Policy(
                "staging retention collect_states must not contain duplicates".into(),
            ));
        }
        Ok(())
    }
}

impl Default for StagingRetentionPolicy {
    fn default() -> Self {
        Self::conservative()
    }
}

/// Journal-authenticated eligibility of one transaction's staging tree.
///
/// Adapters must treat this as the only authoritative claim that a transaction's artifacts
/// are collectible; anything not present in the eligibility map is retained.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StagingEligibility {
    /// Final transaction state that makes the artifacts collectible.
    pub state: TransactionState,
    /// Journal-authenticated instant the transaction entered that state.
    pub terminal_since: DateTime<Utc>,
}

/// Journal-authenticated eligibility map shared with every adapter.
pub type StagingEligibilityMap = BTreeMap<TransactionId, StagingEligibility>;

/// One reclaimed (or, under `dry_run`, reclaimable) transaction staging tree.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StagingCollection {
    /// Transaction whose staging tree was reclaimed.
    pub transaction_id: TransactionId,
    /// Total bytes reclaimed.
    pub bytes: u64,
    /// Filesystem entries reclaimed, including the tree root itself.
    pub entries: u64,
}

/// Why an examined staging entry was retained fail-closed.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StagingAnomalyKind {
    /// Entry name is not a canonical transaction identifier.
    UnrecognizedName,
    /// Entry is not an ordinary staging directory, or became one mid-sweep.
    UnexpectedKind,
    /// The staging root could not be fully enumerated.
    EnumerationFailed,
    /// The staging tree could not be opened or measured safely.
    MeasurementFailed,
    /// Recursive removal failed; the tree may be partially reclaimed.
    RemovalFailed,
}

/// One fail-closed retention decision for a suspicious staging entry.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StagingAnomaly {
    /// Bounded entry name relative to the staging root (`<root>` for enumeration failures).
    pub entry: String,
    /// Machine-readable reason the entry was retained.
    pub kind: StagingAnomalyKind,
}

/// Per-adapter result of one bounded retention sweep.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StagingSweepReport {
    /// Adapter that performed the sweep.
    pub adapter: String,
    /// Staging-root entries examined, bounded by [`MAXIMUM_SWEEP_ENTRIES`].
    pub examined: u64,
    /// Examined entries still present after the sweep (ineligible, deferred, or anomalous).
    pub retained: u64,
    /// Reclaimed transaction trees; under `dry_run` these are planned, not removed.
    pub collections: Vec<StagingCollection>,
    /// Bounded fail-closed retention detail for suspicious entries.
    pub anomalies: Vec<StagingAnomaly>,
    /// Bytes reclaimed, or planned for reclaim under `dry_run`.
    pub bytes_reclaimed: u64,
    /// At least one eligible candidate was deferred because a sweep bound was reached.
    pub truncated: bool,
    /// Nothing was deleted; collections describe what a real sweep would reclaim.
    pub dry_run: bool,
}

impl StagingSweepReport {
    /// Empty report for adapters that keep no durable staging or an absent staging root.
    pub fn empty(adapter: &str, dry_run: bool) -> Self {
        Self {
            adapter: adapter.to_owned(),
            examined: 0,
            retained: 0,
            collections: Vec::new(),
            anomalies: Vec::new(),
            bytes_reclaimed: 0,
            truncated: false,
            dry_run,
        }
    }

    /// Record one anomaly, dropping detail beyond [`MAXIMUM_REPORTED_ANOMALIES`].
    pub fn record_anomaly(&mut self, entry: impl Into<String>, kind: StagingAnomalyKind) {
        let mut entry = entry.into();
        if entry.chars().count() > 128 {
            entry = entry.chars().take(128).collect();
        }
        if self.anomalies.len() < MAXIMUM_REPORTED_ANOMALIES {
            self.anomalies.push(StagingAnomaly { entry, kind });
        }
    }
}
