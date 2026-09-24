# Veyra fuzzing

These libFuzzer targets exercise security-sensitive input boundaries without network, persistent
state, credentials, or production data:

- `canonical_protocol` checks canonical JSON stability, digest encoding, and arbitrary JSON input;
- `resource_scope` checks component-aware filesystem and HTTP containment plus exact process and
  generic scopes;
- `filesystem_effect` checks the filesystem adapter's untrusted input surface: raw and
  nearly-valid `Effect` JSON against `FilesystemAdapter::validate` (normalized-relative-path
  containment, VEP-0002 precondition/postcondition scoping, capability-caveat and secret-input
  rejection, risk and reversibility floors), plus `StagedEffect`/`FsStage` JSON against `execute`
  inside a confined temporary workspace.

`filesystem_effect` was chosen because staged effects are the durable, attacker-influenced record
the adapter revalidates at the trust boundary before committing staged bytes: the `FsStage` payload
must deserialize under `deny_unknown_fields`, agree with the approved effect, preview, and
transaction-bound stage directory, and survive the prepared-byte digest recheck and the atomic
no-replace rename commit. The target merges fuzzed fields over a correctly bound staging baseline
so field-level corruption reaches those cross-checks, and it adversarially tampers with the staged
`prepared` file and collides with the `displaced` capture name to keep the TOCTOU and
no-clobber guarantees honest — the same containment surface the native no-replace rename work
touched, which this repository's agent contract requires be kept under a relevant fuzz target.

Install the same pinned tools used by CI, then run any target from the repository root:

```sh
rustup toolchain install nightly-2026-08-20 --profile minimal
cargo install cargo-fuzz --version 0.13.2 --locked
cargo +nightly-2026-08-20 fuzz run canonical_protocol -- -max_total_time=60 -max_len=4096 -rss_limit_mb=2048
cargo +nightly-2026-08-20 fuzz run resource_scope -- -max_total_time=60 -max_len=4096 -rss_limit_mb=2048
cargo +nightly-2026-08-20 fuzz run filesystem_effect -- -max_total_time=60 -max_len=4096 -rss_limit_mb=2048
```

Pull requests and `main` receive a bounded smoke run; the weekly schedule spends five minutes on
each target. Local corpora, coverage data, crash artifacts, and the ephemeral fixture workspaces
are intentionally ignored. If a crash may cross a Veyra trust boundary, preserve it privately and
follow [`SECURITY.md`](../SECURITY.md) before opening a public issue or pull request.
