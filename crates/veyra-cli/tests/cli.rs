//! Black-box CLI behavior over the real embedded local API.

use predicates::prelude::*;

#[test]
fn demo_exercises_commit_audit_and_rollback_without_credentials() {
    assert_cmd::cargo::cargo_bin_cmd!("veyra")
        .args(["demo", "--json"])
        .assert()
        .success()
        .stdout(predicate::str::contains("\"committed\":true"))
        .stdout(predicate::str::contains("\"audit_valid\":true"))
        .stdout(predicate::str::contains(
            "\"rollback_state\":\"rolled_back\"",
        ))
        .stdout(predicate::str::contains("\"workspace_file_removed\":true"));
}

#[test]
fn malformed_command_has_a_nonzero_exit_code() {
    assert_cmd::cargo::cargo_bin_cmd!("veyra")
        .arg("not-a-command")
        .assert()
        .failure()
        .stderr(predicate::str::contains("unrecognized subcommand"));
}

#[test]
fn journal_migrate_verifies_and_backs_up_an_initialized_data_directory() {
    let temporary = tempfile::TempDir::new().unwrap();
    let data = temporary.path().join("data");
    let workspace = temporary.path().join("workspace");
    assert_cmd::cargo::cargo_bin_cmd!("veyra")
        .args(["init", "--json", "--data-directory"])
        .arg(&data)
        .arg("--workspace")
        .arg(&workspace)
        .assert()
        .success();

    let backup = temporary.path().join("backup.sqlite3");
    assert_cmd::cargo::cargo_bin_cmd!("veyra")
        .args(["journal", "migrate", "--json", "--data-directory"])
        .arg(&data)
        .arg("--backup")
        .arg(&backup)
        .assert()
        .success()
        .stdout(predicate::str::contains("\"applied_steps\":[]"))
        .stdout(predicate::str::contains("\"verified\":true"));
    assert!(backup.is_file());

    // The recorded backup is never overwritten; an explicit second path still verifies.
    assert_cmd::cargo::cargo_bin_cmd!("veyra")
        .args(["journal", "migrate", "--json", "--data-directory"])
        .arg(&data)
        .arg("--backup")
        .arg(&backup)
        .assert()
        .failure();
}

#[test]
fn journal_migrate_fails_closed_when_no_database_exists() {
    let temporary = tempfile::TempDir::new().unwrap();
    assert_cmd::cargo::cargo_bin_cmd!("veyra")
        .args(["journal", "migrate", "--json", "--data-directory"])
        .arg(temporary.path().join("missing"))
        .assert()
        .failure()
        .stderr(predicate::str::contains("nothing to migrate"));
}

/// Exercise the demo once so its data directory holds a real, non-empty journal, then return
/// the data directory path for offline journal commands.
fn populated_data_directory(root: &std::path::Path) -> std::path::PathBuf {
    assert_cmd::cargo::cargo_bin_cmd!("veyra")
        .args(["demo", "--json", "--directory"])
        .arg(root)
        .assert()
        .success();
    root.join("data")
}

#[test]
fn journal_anchor_export_and_check_round_trip() {
    let temporary = tempfile::TempDir::new().unwrap();
    let data = populated_data_directory(&temporary.path().join("demo"));
    let anchor_file = temporary.path().join("anchor.json");

    assert_cmd::cargo::cargo_bin_cmd!("veyra")
        .args(["journal", "anchor", "export", "--json", "--data-directory"])
        .arg(&data)
        .arg("--out")
        .arg(&anchor_file)
        .assert()
        .success()
        .stdout(predicate::str::contains("\"event_count\""));
    assert!(anchor_file.is_file());
    let anchor: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&anchor_file).unwrap()).unwrap();
    assert_eq!(anchor["schema_version"], "veyra.audit-anchor/v1");
    assert!(anchor["event_count"].as_u64().unwrap() > 0);
    assert_eq!(anchor["head_hash"].as_str().unwrap().len(), 64);

    assert_cmd::cargo::cargo_bin_cmd!("veyra")
        .args(["journal", "anchor", "check", "--json", "--data-directory"])
        .arg(&data)
        .arg("--file")
        .arg(&anchor_file)
        .assert()
        .success()
        .stdout(predicate::str::contains("\"valid\":true"));
}

#[test]
fn journal_anchor_check_rejects_a_tampered_or_foreign_anchor() {
    let temporary = tempfile::TempDir::new().unwrap();
    let data = populated_data_directory(&temporary.path().join("demo"));
    let anchor_file = temporary.path().join("anchor.json");
    assert_cmd::cargo::cargo_bin_cmd!("veyra")
        .args(["journal", "anchor", "export", "--json", "--data-directory"])
        .arg(&data)
        .arg("--out")
        .arg(&anchor_file)
        .assert()
        .success();

    // A tampered authentication tag is rejected with a non-zero exit.
    let mut anchor: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&anchor_file).unwrap()).unwrap();
    let tag = anchor["authentication"].as_str().unwrap();
    let flipped = if tag.starts_with('0') { '1' } else { '0' };
    anchor["authentication"] = serde_json::Value::String(format!("{flipped}{}", &tag[1..]));
    std::fs::write(&anchor_file, serde_json::to_vec(&anchor).unwrap()).unwrap();
    assert_cmd::cargo::cargo_bin_cmd!("veyra")
        .args(["journal", "anchor", "check", "--json", "--data-directory"])
        .arg(&data)
        .arg("--file")
        .arg(&anchor_file)
        .assert()
        .failure()
        .stderr(predicate::str::contains("audit anchor verification failed"));

    // An anchor exported by a different journal never authenticates here.
    let foreign_data = populated_data_directory(&temporary.path().join("foreign"));
    assert_cmd::cargo::cargo_bin_cmd!("veyra")
        .args(["journal", "anchor", "export", "--json", "--data-directory"])
        .arg(&foreign_data)
        .arg("--out")
        .arg(&anchor_file)
        .assert()
        .failure()
        .stderr(predicate::str::contains("refusing to overwrite"));
    std::fs::remove_file(&anchor_file).unwrap();
    assert_cmd::cargo::cargo_bin_cmd!("veyra")
        .args(["journal", "anchor", "export", "--json", "--data-directory"])
        .arg(&foreign_data)
        .arg("--out")
        .arg(&anchor_file)
        .assert()
        .success();
    assert_cmd::cargo::cargo_bin_cmd!("veyra")
        .args(["journal", "anchor", "check", "--json", "--data-directory"])
        .arg(&data)
        .arg("--file")
        .arg(&anchor_file)
        .assert()
        .failure()
        .stderr(predicate::str::contains("audit anchor verification failed"));
}

#[test]
fn journal_anchor_commands_fail_closed_without_initialized_state() {
    let temporary = tempfile::TempDir::new().unwrap();
    let missing = temporary.path().join("missing");
    assert_cmd::cargo::cargo_bin_cmd!("veyra")
        .args(["journal", "anchor", "export", "--json", "--data-directory"])
        .arg(&missing)
        .assert()
        .failure()
        .stderr(predicate::str::contains("no initialized journal"));
    assert_cmd::cargo::cargo_bin_cmd!("veyra")
        .args(["journal", "anchor", "check", "--json", "--data-directory"])
        .arg(&missing)
        .arg("--file")
        .arg(temporary.path().join("anchor.json"))
        .assert()
        .failure()
        .stderr(predicate::str::contains("no initialized journal"));
    // A check must not silently create the missing journal it was asked to inspect.
    assert!(!missing.join("veyra.sqlite3").exists());
    assert!(!missing.join("receipt.key").exists());
}
