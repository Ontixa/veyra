#![no_main]

//! Fuzzes the filesystem adapter's untrusted input boundary.
//!
//! Two records reach `veyra-executor` from outside the adapter's trust
//! boundary: the `Effect` proposal validated by `FilesystemAdapter::validate`
//! (path normalization, VEP-0002 condition scoping, capability-caveat and
//! secret-input rejection, risk and reversibility floors) and the durable
//! `StagedEffect`/`FsStage` JSON re-validated by `execute` before any staged
//! byte is committed. The staged half keeps a correctly bound patch staging
//! baseline so field-level corruption reaches the digest rechecks and the
//! atomic no-replace commit inside a confined temporary workspace. No
//! network, daemon, credentials, or persistent state is involved.

use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, OnceLock},
};

use libfuzzer_sys::fuzz_target;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use veyra_executor::{
    AdapterContext, DenySecretResolver, EffectAdapter, FilesystemAdapter, FilesystemConfig,
    StagedEffect,
};
use veyra_protocol::{
    CapabilityRequirement, CausalParent, Condition, Effect, EffectId, InputValue, IntentId,
    PROTOCOL_VERSION, PlanId, Preview, PrincipalId, ResourceScope, RetryPolicy, Reversibility,
    RiskLevel, StepId, TransactionId, public,
};

const WORKSPACE: &str = "fuzz";
const SOURCE: &str = "notes/target.txt";
const BEFORE: &[u8] = b"before bytes captured at staging\n";
const AFTER: &[u8] = b"after bytes approved at staging\n";
const MAXIMUM_FILE_BYTES: usize = 64 * 1024;
const MAXIMUM_DIFF_BYTES: usize = 16 * 1024;
const COLLISION: &[u8] = b"unrelated staged artifact";

/// One confined workspace shared by every input in the process. The adapter
/// and staging root live under a temporary directory; nothing persists or
/// leaves the host except ephemeral files removed with the process.
struct Fixture {
    _temp: TempDir,
    adapter: FilesystemAdapter,
    context: AdapterContext,
    effect: Effect,
    effect_baseline: Value,
    staged_baseline: Value,
    stage_baseline: Map<String, Value>,
    after_digest: String,
    source: PathBuf,
    prepared: PathBuf,
    displaced: PathBuf,
}

impl Fixture {
    /// Re-establish the approved staging state the oracle depends on.
    fn reset(&self) {
        let _ = std::fs::remove_file(&self.displaced);
        std::fs::write(&self.source, BEFORE).expect("fixture must restore the source file");
        std::fs::write(&self.prepared, AFTER).expect("fixture must restore the prepared bytes");
    }
}

/// Lowercase hex encoding identical to the adapter's internal `sha256`
/// helper, recomputed independently so digest evidence cannot drift.
fn hex_digest(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let digest = Sha256::digest(bytes);
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        encoded.push(char::from(HEX[usize::from(byte >> 4)]));
        encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    encoded
}

/// The filesystem adapter never awaits inside `execute`; drive its boxed
/// future to completion with a no-op waker so no async runtime is needed.
fn block_on<F: std::future::Future>(future: F) -> F::Output {
    struct Noop;
    impl std::task::Wake for Noop {
        fn wake(self: Arc<Self>) {}
    }
    let waker = std::task::Waker::from(Arc::new(Noop));
    let mut context = std::task::Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);
    loop {
        match future.as_mut().poll(&mut context) {
            std::task::Poll::Ready(output) => return output,
            std::task::Poll::Pending => std::thread::yield_now(),
        }
    }
}

/// Overlay fuzzed object members on a valid record so structured
/// deserialization reaches field-level validation instead of failing at the
/// envelope.
fn merged_over(baseline: &Map<String, Value>, patch: Value) -> Value {
    match patch {
        Value::Object(map) => {
            let mut merged = baseline.clone();
            for (key, value) in map {
                merged.insert(key, value);
            }
            Value::Object(merged)
        }
        other => other,
    }
}

fn patch_effect(before_digest: &str, after_digest: &str) -> Effect {
    let resource = ResourceScope::Filesystem {
        workspace: WORKSPACE.into(),
        path: SOURCE.into(),
    };
    let mut inputs = BTreeMap::new();
    inputs.insert(
        "content".into(),
        public(String::from_utf8_lossy(AFTER).into_owned()),
    );
    Effect {
        schema_version: PROTOCOL_VERSION.into(),
        id: EffectId::new(),
        causal_parent: CausalParent {
            intent_id: IntentId::new(),
            plan_id: PlanId::new(),
            step_id: StepId::new(),
            effect_id: None,
        },
        principal_id: PrincipalId::new(),
        adapter: "filesystem".into(),
        operation: "patch".into(),
        inputs,
        resource: resource.clone(),
        preconditions: vec![],
        expected_postconditions: vec![],
        risk: RiskLevel::Medium,
        reversibility: Reversibility::Reversible,
        preview: Preview::Filesystem {
            operation: "patch".into(),
            path: SOURCE.into(),
            before_sha256: Some(before_digest.to_owned()),
            after_sha256: Some(after_digest.to_owned()),
            unified_diff: None,
        },
        idempotency_key: "filesystem-effect-fuzz".into(),
        timeout_ms: 1_000,
        retry: RetryPolicy {
            max_attempts: 1,
            backoff_ms: 0,
            retryable_errors: vec![],
        },
        required_capabilities: vec![CapabilityRequirement {
            adapter: "filesystem".into(),
            operation: "patch".into(),
            resource,
            constraints: BTreeMap::new(),
        }],
        inverse: None,
    }
}

fn fixture() -> &'static Fixture {
    static FIXTURE: OnceLock<Fixture> = OnceLock::new();
    FIXTURE.get_or_init(|| {
        let temp = TempDir::new().expect("fixture needs a temporary workspace");
        let root = temp.path().to_path_buf();
        std::fs::create_dir_all(root.join("notes")).expect("fixture needs a notes directory");
        let adapter = FilesystemAdapter::new(FilesystemConfig {
            workspace_name: WORKSPACE.into(),
            root: root.clone(),
            maximum_file_bytes: MAXIMUM_FILE_BYTES,
            maximum_diff_bytes: MAXIMUM_DIFF_BYTES,
        })
        .expect("filesystem adapter must open the fixture workspace");
        let context = AdapterContext {
            transaction_id: TransactionId::new(),
            secrets: Arc::new(DenySecretResolver),
        };
        let before_digest = hex_digest(BEFORE);
        let after_digest = hex_digest(AFTER);
        let effect = patch_effect(&before_digest, &after_digest);
        let effect_baseline = serde_json::to_value(&effect).expect("effect serializes");
        let stage_directory = format!(".veyra/staging/{}/{}", context.transaction_id, effect.id);
        let stage_baseline = Map::from_iter([
            ("operation".into(), json!("patch")),
            ("source".into(), json!(SOURCE)),
            ("destination".into(), Value::Null),
            ("before_digest".into(), json!(before_digest)),
            ("after_digest".into(), json!(after_digest)),
            ("stage_directory".into(), json!(stage_directory)),
        ]);
        let staged_baseline = json!({
            "adapter": "filesystem",
            "effect_id": effect.id,
            "effect_digest": effect.content_digest().expect("effect digests"),
            "data": Value::Object(stage_baseline.clone()),
            "staged_at": "2026-01-01T00:00:00Z",
        });
        let stage_directory = root.join(stage_directory);
        std::fs::create_dir_all(&stage_directory).expect("fixture needs a stage directory");
        let fixture = Fixture {
            _temp: temp,
            adapter,
            context,
            effect,
            effect_baseline,
            staged_baseline,
            stage_baseline,
            after_digest,
            source: root.join(SOURCE),
            prepared: stage_directory.join("prepared"),
            displaced: stage_directory.join("displaced"),
        };
        fixture.reset();
        fixture
    })
}

fn declared_paths(effect: &Effect) -> Vec<&str> {
    match &effect.resource {
        ResourceScope::Filesystem { workspace, path } => {
            assert_eq!(workspace, WORKSPACE, "validated another workspace");
            vec![path.as_str()]
        }
        ResourceScope::FilesystemSet { workspace, paths } => {
            assert_eq!(workspace, WORKSPACE, "validated another workspace");
            paths.iter().map(String::as_str).collect()
        }
        _ => panic!("validated a non-filesystem resource"),
    }
}

/// Independent oracle for the adapter's normalized-relative-path contract:
/// every path that survives validation must satisfy the containment shape.
fn assert_portable_relative(path: &str) {
    assert!(!path.is_empty(), "validated an empty path");
    assert!(!path.contains('\\'), "validated a backslash path");
    assert!(!path.contains(':'), "validated a drive-qualified path");
    assert!(!path.contains('\0'), "validated a NUL-bearing path");
    assert!(!path.starts_with('/'), "validated an absolute path");
    assert!(
        path.split('/')
            .next()
            .is_none_or(|head| !head.eq_ignore_ascii_case(".veyra")),
        "validated a path inside the reserved internal directory"
    );
    assert!(
        !path.split('/').any(|segment| matches!(segment, "." | "..")),
        "validated a path with dot segments"
    );
}

/// Every invariant a filesystem effect must satisfy once `validate` accepts
/// it, re-derived independently so a weakened check becomes a crash.
fn assert_validated(effect: &Effect) {
    assert_eq!(effect.adapter, "filesystem", "validated a foreign adapter");
    assert!(
        matches!(
            effect.operation.as_str(),
            "read" | "create" | "patch" | "move" | "delete"
        ),
        "validated an unsupported operation"
    );
    assert_eq!(
        effect.reversibility,
        Reversibility::Reversible,
        "validated a dishonest reversibility claim"
    );
    assert!(
        effect.operation == "read" || effect.risk >= RiskLevel::Medium,
        "validated a mutating effect below the risk floor"
    );
    let paths = declared_paths(effect);
    let expected = if effect.operation == "move" { 2 } else { 1 };
    assert_eq!(paths.len(), expected, "validated the wrong path count");
    if effect.operation == "move" {
        assert_ne!(paths[0], paths[1], "validated a self move");
    }
    for path in paths {
        assert_portable_relative(path);
    }
    let wants_content = matches!(effect.operation.as_str(), "create" | "patch");
    assert_eq!(
        effect.inputs.len(),
        usize::from(wants_content),
        "validated missing or unsupported inputs"
    );
    for input in effect.inputs.values() {
        assert!(
            matches!(input, InputValue::Public { .. }),
            "validated a secret input"
        );
    }
    if wants_content {
        let Some(InputValue::Public { value }) = effect.inputs.get("content") else {
            panic!("validated a non-public content input");
        };
        let content = value.as_str().expect("content input must be a string");
        assert!(
            content.len() <= MAXIMUM_FILE_BYTES,
            "validated oversized content"
        );
    }
    for condition in &effect.preconditions {
        assert!(
            matches!(
                condition,
                Condition::FileExists { .. } | Condition::FileSha256 { .. }
            ),
            "validated a precondition outside the VEP-0002 contract"
        );
    }
    for condition in &effect.expected_postconditions {
        assert!(
            matches!(
                condition,
                Condition::FileExists { .. }
                    | Condition::FileSha256 { .. }
                    | Condition::OutputSha256 { .. }
            ),
            "validated an unsupported postcondition"
        );
    }
    for requirement in &effect.required_capabilities {
        for name in requirement.constraints.keys() {
            assert!(
                matches!(
                    name.as_str(),
                    "max_timeout_ms" | "max_risk" | "allow_irreversible"
                ),
                "validated an unenforceable capability constraint"
            );
        }
    }
}

fuzz_target!(|data: &[u8]| {
    let fixture = fixture();

    // Effect proposals: raw JSON and JSON merged over a valid baseline must
    // never panic validation, and an accepted effect must keep every adapter
    // contract invariant.
    for candidate in [
        serde_json::from_slice::<Effect>(data).ok(),
        serde_json::from_slice::<Value>(data)
            .ok()
            .and_then(|value| match &fixture.effect_baseline {
                Value::Object(baseline) => {
                    serde_json::from_value::<Effect>(merged_over(baseline, value)).ok()
                }
                _ => None,
            }),
    ]
    .into_iter()
    .flatten()
    {
        let first = fixture.adapter.validate(&candidate);
        let second = fixture.adapter.validate(&candidate);
        assert_eq!(
            first.is_ok(),
            second.is_ok(),
            "filesystem validation must be deterministic"
        );
        if first.is_ok() {
            assert_validated(&candidate);
        }
    }

    // Whole staged-effect envelopes are durable, attacker-influenced
    // evidence; mismatched bindings must be rejected before any filesystem
    // observation or mutation.
    if let Ok(staged) = serde_json::from_slice::<StagedEffect>(data) {
        let _ = block_on(
            fixture
                .adapter
                .execute(&fixture.effect, &staged, &fixture.context),
        );
        fixture.reset();
    }

    // The FsStage payload merged over a correctly bound baseline reaches the
    // cross-checks and, when every checked field still matches, the staged
    // commit path itself. Input bits additionally tamper with the prepared
    // bytes and collide with the capture destination so the digest recheck
    // and the no-replace rename are exercised adversarially.
    let Ok(value) = serde_json::from_slice::<Value>(data) else {
        return;
    };
    let merged = merged_over(&fixture.stage_baseline, value);
    let should_commit = merged == fixture.staged_baseline["data"];
    let mut envelope = fixture.staged_baseline.clone();
    envelope["data"] = merged;
    let Ok(staged) = serde_json::from_value::<StagedEffect>(envelope) else {
        return;
    };
    // The flag byte derives from input length, not content: every JSON
    // object starts with `{`, which would pin the tamper and collision bits
    // and make the full commit path unreachable.
    let flags = data.len() as u8;
    if flags & 1 != 0 {
        std::fs::write(&fixture.prepared, data).expect("tamper with prepared bytes");
    }
    if flags & 2 != 0 {
        std::fs::write(&fixture.displaced, COLLISION).expect("create a capture collision");
    }
    let result = block_on(
        fixture
            .adapter
            .execute(&fixture.effect, &staged, &fixture.context),
    );
    if !should_commit {
        assert!(
            result.is_err(),
            "staging evidence disagreed with the approved effect but executed"
        );
        assert_eq!(
            std::fs::read(&fixture.source)
                .expect("read source")
                .as_slice(),
            BEFORE,
            "rejected staging evidence still mutated the source"
        );
    } else if flags & 1 != 0 && data != AFTER {
        assert!(
            result.is_err(),
            "tampered prepared bytes passed the digest recheck"
        );
        assert_eq!(
            std::fs::read(&fixture.source)
                .expect("read source")
                .as_slice(),
            BEFORE,
            "a rejected commit still replaced the source"
        );
    } else if flags & 2 != 0 {
        assert!(
            result.is_err(),
            "the no-replace commit clobbered an existing capture"
        );
        assert_eq!(
            std::fs::read(&fixture.displaced)
                .expect("read collision")
                .as_slice(),
            COLLISION,
            "the pre-existing capture was overwritten"
        );
        assert_eq!(
            std::fs::read(&fixture.source)
                .expect("read source")
                .as_slice(),
            BEFORE,
            "a rejected commit still replaced the source"
        );
    } else {
        let result = result.expect("a faithfully staged patch must commit");
        assert_eq!(result.outcome, "patched");
        assert_eq!(
            result.post_state_digest.as_deref(),
            Some(fixture.after_digest.as_str()),
        );
        assert_eq!(
            std::fs::read(&fixture.source)
                .expect("read source")
                .as_slice(),
            AFTER,
            "a reported commit did not install the approved bytes"
        );
    }
    fixture.reset();
});
