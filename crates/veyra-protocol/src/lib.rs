//! Authoritative, versioned domain and wire types shared by every Veyra client.

mod canonical;
mod ids;
mod model;
mod redaction;

pub use canonical::{CanonicalError, canonical_digest, canonical_json};
pub use ids::*;
pub use model::*;
pub use redaction::*;

/// Current protocol identifier. Breaking wire changes require a new value.
pub const PROTOCOL_VERSION: &str = "veyra.protocol/v1";

/// Precondition-evaluation contract identifier.
///
/// VEP-0002 defines the bounded, deterministic precondition surface: which `Condition` kinds are
/// meaningful in `Effect::preconditions`, where evaluation happens in the transaction lifecycle,
/// and what honest failure produces. Unknown or unsupported conditions always fail closed; a
/// later contract revision that widens the evaluated surface must use a new identifier.
pub const PRECONDITION_CONTRACT_VERSION: &str = "veyra.preconditions/v1";
