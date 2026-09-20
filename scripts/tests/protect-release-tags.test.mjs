// Transport-level tests for protect-release-tags.ps1 using a fake `gh`
// (fake-gh.mjs). They verify the safety contract end-to-end: a blocked
// preflight performs zero writes, the creation ruleset is created and
// read back before the old ruleset is touched, protection is never
// dropped mid-apply, and host drift refuses the write.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "..", "protect-release-tags.ps1");
const fakeGh = path.join(here, "fake-gh.mjs");

const shell = ["pwsh", "powershell"].find(
  (exe) =>
    spawnSync(exe, ["-NoProfile", "-Command", "exit 0"], { timeout: 20000 })
      .status === 0,
);
const skipReason = shell ? false : "no PowerShell host (pwsh/powershell)";

const ACTOR_ID = 145498528;

function protectTags(overrides = {}) {
  return {
    id: 11,
    name: "Protect release tags",
    target: "tag",
    enforcement: "active",
    conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
    rules: [
      { type: "creation" },
      { type: "deletion" },
      { type: "non_fast_forward" },
      { type: "update" },
    ],
    bypass_actors: [],
    ...overrides,
  };
}

function baseFixture(overrides = {}) {
  return {
    users: { "tang-vu": { id: ACTOR_ID } },
    rulesets: [protectTags()],
    orgRulesets: [],
    ...overrides,
  };
}

function runScript(fixture, { apply = false, mutate } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prt-"));
  const statePath = path.join(dir, "state.json");
  const logPath = path.join(dir, "log.txt");
  fs.writeFileSync(statePath, JSON.stringify(fixture));
  fs.writeFileSync(logPath, "");
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-Repo",
    "Ontixa/veyra",
    "-SnapshotDir",
    dir,
    "-GhExe",
    process.execPath,
    "-GhPrefixArgs",
    fakeGh,
  ];
  if (apply) {
    args.push("-Apply");
  }
  const result = spawnSync(shell, args, {
    env: {
      ...process.env,
      FAKE_GH_STATE: statePath,
      FAKE_GH_LOG: logPath,
      ...(mutate ? { FAKE_GH_MUTATE: mutate } : {}),
    },
    encoding: "utf8",
    timeout: 120000,
  });
  const calls = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  const writes = calls.filter((c) => /^(POST|PUT|PATCH|DELETE) /.test(c));
  const state = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return { result, calls, writes, state, output, dir };
}

test(
  "dry-run plans changes but performs zero writes",
  { skip: skipReason },
  () => {
    const { result, writes, output } = runScript(baseFixture());
    assert.equal(result.status, 0, output);
    assert.deepEqual(writes, []);
    assert.match(output, /DRY-RUN/);
    assert.match(output, /CREATE ruleset 'Protect release tag creation'/);
    assert.match(output, /UPDATE ruleset 'Protect release tags'/);
  },
);

test(
  "apply creates + verifies the creation ruleset before touching the old one",
  { skip: skipReason },
  () => {
    const { result, calls, state } = runScript(baseFixture(), {
      apply: true,
    });
    assert.equal(result.status, 0);

    const postIdx = calls.findIndex(
      (c) => c === "POST repos/Ontixa/veyra/rulesets",
    );
    const putIdx = calls.findIndex((c) =>
      c.startsWith("PUT repos/Ontixa/veyra/rulesets/"),
    );
    assert.ok(postIdx >= 0, "creation ruleset was never POSTed");
    assert.ok(putIdx > postIdx, "old ruleset was updated before creation");

    const final = state();
    const creation = final.rulesets.find(
      (r) => r.name === "Protect release tag creation",
    );
    assert.ok(creation, "creation ruleset missing after apply");
    const readbackIdx = calls.findIndex(
      (c) => c === `GET repos/Ontixa/veyra/rulesets/${creation.id}`,
    );
    assert.ok(
      readbackIdx > postIdx && readbackIdx < putIdx,
      "creation ruleset was not read back before the old ruleset write",
    );
    assert.deepEqual(
      creation.rules.map((r) => r.type),
      ["creation"],
    );
    assert.equal(creation.bypass_actors.length, 1);
    assert.equal(creation.bypass_actors[0].actor_type, "User");
    assert.equal(creation.bypass_actors[0].actor_id, ACTOR_ID);
    assert.equal(creation.bypass_actors[0].bypass_mode, "always");

    const protect = final.rulesets.find(
      (r) => r.name === "Protect release tags",
    );
    assert.deepEqual(
      protect.rules.map((r) => r.type).sort(),
      ["deletion", "non_fast_forward", "update"],
      "update/deletion/non_fast_forward protection must survive",
    );
    assert.deepEqual(protect.bypass_actors, []);
  },
);

test(
  "unreadable inherited tag ruleset blocks apply with zero writes",
  { skip: skipReason },
  () => {
    const fixture = baseFixture({
      orgRulesets: [
        {
          id: 77,
          name: "Org tag policy",
          target: "tag",
          source_type: "Organization",
          unreadable: true,
        },
      ],
    });
    const { result, writes, output } = runScript(fixture, { apply: true });
    assert.notEqual(result.status, 0, "blocked preflight must not succeed");
    assert.deepEqual(writes, []);
    assert.match(output, /BLOCKED/);
  },
);

test(
  "host drift between creation and the old-ruleset PUT refuses the write",
  { skip: skipReason },
  () => {
    const { result, calls, output } = runScript(baseFixture(), {
      apply: true,
      mutate: "drift-on-create",
    });
    assert.notEqual(result.status, 0, "drift must stop the apply");
    assert.match(output, /changed during apply/);
    assert.ok(
      calls.some((c) => c === "POST repos/Ontixa/veyra/rulesets"),
      "creation step should have run",
    );
    assert.ok(
      !calls.some((c) => c.startsWith("PUT repos/Ontixa/veyra/rulesets/")),
      "PUT must never run after drift is detected",
    );
  },
);

test(
  "ambiguous duplicate ruleset name blocks apply with zero writes",
  { skip: skipReason },
  () => {
    const fixture = baseFixture({
      rulesets: [protectTags(), protectTags({ id: 12 })],
    });
    const { result, writes, output } = runScript(fixture, { apply: true });
    assert.notEqual(result.status, 0);
    assert.deepEqual(writes, []);
    assert.match(output, /ambiguous/);
  },
);

test(
  "apply is a no-op when the host already matches the target design",
  { skip: skipReason },
  () => {
    const fixture = baseFixture({
      rulesets: [
        protectTags({
          rules: [
            { type: "deletion" },
            { type: "non_fast_forward" },
            { type: "update" },
          ],
        }),
        {
          id: 12,
          name: "Protect release tag creation",
          target: "tag",
          enforcement: "active",
          conditions: {
            ref_name: { include: ["refs/tags/v*"], exclude: [] },
          },
          rules: [{ type: "creation" }],
          bypass_actors: [
            { actor_type: "User", actor_id: ACTOR_ID, bypass_mode: "always" },
          ],
        },
      ],
    });
    const { result, writes, output } = runScript(fixture, { apply: true });
    assert.equal(result.status, 0, output);
    assert.deepEqual(writes, []);
    assert.match(output, /already correct/);
  },
);
