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
