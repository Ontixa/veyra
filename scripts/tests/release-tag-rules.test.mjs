import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateTagRulesets,
  PROTECT_TAGS_NAME,
  PROTECT_TAG_CREATION_NAME,
  RELEASE_TAG_PATTERN,
} from "../release-tag-rules.mjs";

const ACTOR_ID = 145498528; // tang-vu

function tagRuleset(overrides = {}) {
  return {
    name: PROTECT_TAGS_NAME,
    target: "tag",
    enforcement: "active",
    conditions: { ref_name: { include: [RELEASE_TAG_PATTERN], exclude: [] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      { type: "update" },
    ],
    bypass_actors: [],
    ...overrides,
  };
}

function creationRuleset(overrides = {}) {
  return {
    name: PROTECT_TAG_CREATION_NAME,
    target: "tag",
    enforcement: "active",
    conditions: { ref_name: { include: [RELEASE_TAG_PATTERN], exclude: [] } },
    rules: [{ type: "creation" }],
    bypass_actors: [
      { actor_type: "User", actor_id: ACTOR_ID, bypass_mode: "always" },
    ],
    ...overrides,
  };
}

const base = {
  rulesets: [tagRuleset(), creationRuleset()],
  releaseActorId: ACTOR_ID,
};

test("target design passes: split rulesets, owner bypass on creation only", () => {
  const { failures, unknowns } = evaluateTagRulesets(base);
  assert.deepEqual(failures, []);
  assert.deepEqual(unknowns, []);
});

test("wrong release account fails", () => {
  const rs = creationRuleset({
    bypass_actors: [
      { actor_type: "User", actor_id: 999, bypass_mode: "always" },
    ],
  });
  const { failures } = evaluateTagRulesets({
    ...base,
    rulesets: [tagRuleset(), rs],
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /only tang-vu/);
});

test("OrganizationAdmin bypass actor fails (never widen to org admins)", () => {
  const rs = creationRuleset({
    bypass_actors: [
      { actor_type: "OrganizationAdmin", actor_id: 1, bypass_mode: "always" },
    ],
  });
  const { failures } = evaluateTagRulesets({
    ...base,
    rulesets: [tagRuleset(), rs],
  });
  assert.ok(failures.length >= 1);
});

test("extra bypass actor on creation ruleset fails", () => {
  const rs = creationRuleset({
    bypass_actors: [
      { actor_type: "User", actor_id: ACTOR_ID, bypass_mode: "always" },
      { actor_type: "User", actor_id: 42, bypass_mode: "always" },
    ],
  });
  const { failures } = evaluateTagRulesets({
    ...base,
    rulesets: [tagRuleset(), rs],
  });
  assert.equal(failures.length, 1);
});

test("standing bypass on Protect release tags fails", () => {
  const pt = tagRuleset({
    bypass_actors: [
      { actor_type: "User", actor_id: ACTOR_ID, bypass_mode: "always" },
    ],
  });
  const { failures } = evaluateTagRulesets({
    ...base,
    rulesets: [pt, creationRuleset()],
  });
  assert.ok(failures.some((f) => /must not have standing bypass/.test(f)));
});

test("missing invariant rules on Protect release tags fail", () => {
  for (const missing of ["deletion", "non_fast_forward", "update"]) {
    const pt = tagRuleset({
      rules: tagRuleset().rules.filter((r) => r.type !== missing),
    });
    const { failures } = evaluateTagRulesets({
      ...base,
      rulesets: [pt, creationRuleset()],
    });
    assert.ok(
      failures.some((f) => f.includes(`missing rule: ${missing}`)),
      `expected failure for missing ${missing}`,
    );
  }
});

test("creation rule kept on Protect release tags fails", () => {
  const pt = tagRuleset({
    rules: [...tagRuleset().rules, { type: "creation" }],
  });
  const { failures } = evaluateTagRulesets({
    ...base,
    rulesets: [pt, creationRuleset()],
  });
  assert.ok(failures.some((f) => /must not keep the creation rule/.test(f)));
});

test("creation ruleset with extra rules fails", () => {
  const rs = creationRuleset({
    rules: [{ type: "creation" }, { type: "update" }],
  });
  const { failures } = evaluateTagRulesets({
    ...base,
    rulesets: [tagRuleset(), rs],
  });
  assert.ok(failures.some((f) => /only the creation rule/.test(f)));
});

test("wrong ref pattern fails", () => {
  const pt = tagRuleset({
    conditions: { ref_name: { include: ["refs/tags/*"], exclude: [] } },
  });
  const { failures } = evaluateTagRulesets({
    ...base,
    rulesets: [pt, creationRuleset()],
  });
  assert.ok(failures.some((f) => /must cover refs\/tags\/v\*/.test(f)));
});

test("disabled ruleset fails", () => {
  const pt = tagRuleset({ enforcement: "disabled" });
  const { failures } = evaluateTagRulesets({
    ...base,
    rulesets: [pt, creationRuleset()],
  });
  assert.ok(failures.some((f) => /must be active/.test(f)));
});

test("missing Protect release tag creation ruleset fails", () => {
  const { failures } = evaluateTagRulesets({
    rulesets: [tagRuleset()],
    releaseActorId: ACTOR_ID,
  });
  assert.ok(
    failures.some((f) =>
      f.includes(`missing ruleset "${PROTECT_TAG_CREATION_NAME}"`),
    ),
  );
});

test("unreadable bypass_actors is UNKNOWN, never an implied empty list", () => {
  const pt = tagRuleset({ bypass_actors: undefined });
  const rs = creationRuleset({ bypass_actors: null });
  const { failures, unknowns } = evaluateTagRulesets({
    rulesets: [pt, rs],
    releaseActorId: ACTOR_ID,
  });
  assert.equal(failures.length, 0);
  assert.equal(unknowns.length, 2);
  assert.ok(unknowns.every((u) => /NOT VERIFIED/.test(u)));
});

test("unresolvable release account is UNKNOWN", () => {
  const { failures, unknowns } = evaluateTagRulesets({
    rulesets: [tagRuleset(), creationRuleset()],
    releaseActorId: undefined,
  });
  assert.equal(failures.length, 0);
  assert.ok(unknowns.some((u) => /could not be resolved/.test(u)));
});

test("failed ruleset detail fetch is UNKNOWN, not 'missing'", () => {
  const { failures, unknowns } = evaluateTagRulesets({
    rulesets: [creationRuleset()],
    releaseActorId: ACTOR_ID,
    failedRulesetNames: [PROTECT_TAGS_NAME],
  });
  assert.ok(
    !failures.some((f) => f.includes(`missing ruleset "${PROTECT_TAGS_NAME}"`)),
  );
  assert.ok(unknowns.some((u) => u.includes(PROTECT_TAGS_NAME)));
});
