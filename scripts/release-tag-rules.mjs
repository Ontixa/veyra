// Pure evaluation of the release-tag ruleset contract for Ontixa/veyra.
// Imported by check-github.mjs and by scripts/tests/*.test.mjs so the
// contract is testable without hitting the GitHub API.
//
// Target design (post-transfer, decided 2026-09):
//   "Protect release tag creation" - tag ruleset, active, refs/tags/v*,
//     only the `creation` rule, exactly one bypass actor: User <release
//     account> with bypass_mode "always". Tag creation authority stays
//     with tang-vu, not OrganizationAdmin.
//   "Protect release tags" - tag ruleset, active, refs/tags/v*,
//     rules {deletion, non_fast_forward, update}, NO creation rule,
//     NO standing bypass actors. Nobody rewrites or deletes a v* tag.
//
// A field the API token cannot read (e.g. bypass_actors missing) is an
// UNKNOWN, never an implied empty list: the gate must report blocked,
// not pretend the invariant holds.

export const RELEASE_TAG_PATTERN = "refs/tags/v*";
export const PROTECT_TAGS_NAME = "Protect release tags";
export const PROTECT_TAG_CREATION_NAME = "Protect release tag creation";

const PROTECT_TAGS_RULES = ["deletion", "non_fast_forward", "update"];

export function ruleByType(ruleset, type) {
  return ruleset?.rules?.find((rule) => rule.type === type);
}

function ruleTypes(ruleset) {
  return Array.isArray(ruleset?.rules)
    ? ruleset.rules.map((rule) => rule.type)
    : [];
}

function sameMembers(actual, expected) {
  return (
    actual.length === expected.length &&
    [...actual].sort().every((v, i) => v === [...expected].sort()[i])
  );
}

function checkTagBase(ruleset, name, failures) {
  if (ruleset.target !== "tag") {
    failures.push(`${name} must target tags`);
  }
  if (ruleset.enforcement !== "active") {
    failures.push(`${name} must be active`);
  }
  if (
    !Array.isArray(ruleset.conditions?.ref_name?.include) ||
    !ruleset.conditions.ref_name.include.includes(RELEASE_TAG_PATTERN)
  ) {
    failures.push(`${name} must cover ${RELEASE_TAG_PATTERN}`);
  }
}

function evaluateBypassActors(ruleset, name, evaluate, failures, unknowns) {
  if (!Array.isArray(ruleset.bypass_actors)) {
    unknowns.push(
      `cannot read bypass_actors of ${name} (insufficient API permission or field absent) - NOT VERIFIED`,
    );
    return;
  }
  evaluate(ruleset.bypass_actors);
}

/**
 * Evaluate the two release-tag rulesets against the target design.
 *
 * @param {object[]} rulesets - full ruleset objects already fetched.
 * @param {number|undefined} releaseActorId - numeric GitHub user ID of the
 *   release account (resolved via `users/<login>` by the caller). Undefined
 *   means the account could not be resolved -> UNKNOWN, not a pass.
 * @param {string[]} failedRulesetNames - names whose detail fetch failed.
 * @returns {{failures: string[], unknowns: string[]}}
 */
export function evaluateTagRulesets({
  rulesets = [],
  releaseActorId,
  releaseActorLogin = "tang-vu",
  failedRulesetNames = [],
}) {
  const failures = [];
  const unknowns = [];

  const protectTags = rulesets.find((r) => r.name === PROTECT_TAGS_NAME);
  const tagCreation = rulesets.find(
    (r) => r.name === PROTECT_TAG_CREATION_NAME,
  );

  if (failedRulesetNames.includes(PROTECT_TAGS_NAME)) {
    unknowns.push(
      `could not load ruleset "${PROTECT_TAGS_NAME}" detail - NOT VERIFIED`,
    );
  } else if (!protectTags) {
    failures.push(`missing ruleset "${PROTECT_TAGS_NAME}"`);
  } else {
    checkTagBase(protectTags, PROTECT_TAGS_NAME, failures);
    const types = ruleTypes(protectTags);
    if (ruleByType(protectTags, "creation")) {
      failures.push(
        `${PROTECT_TAGS_NAME} must not keep the creation rule (moved to "${PROTECT_TAG_CREATION_NAME}")`,
      );
    }
    for (const ruleType of PROTECT_TAGS_RULES) {
      if (!types.includes(ruleType)) {
        failures.push(`${PROTECT_TAGS_NAME} is missing rule: ${ruleType}`);
      }
    }
    const unexpected = types.filter(
      (t) => !PROTECT_TAGS_RULES.includes(t) && t !== "creation",
    );
    if (unexpected.length > 0) {
      failures.push(
        `${PROTECT_TAGS_NAME} has unexpected rule(s): ${unexpected.join(", ")}`,
      );
    }
    evaluateBypassActors(
      protectTags,
      PROTECT_TAGS_NAME,
      (actors) => {
        if (actors.length !== 0) {
          failures.push(
            `${PROTECT_TAGS_NAME} must not have standing bypass actors (found ${actors.length})`,
          );
        }
      },
      failures,
      unknowns,
    );
  }

  if (failedRulesetNames.includes(PROTECT_TAG_CREATION_NAME)) {
    unknowns.push(
      `could not load ruleset "${PROTECT_TAG_CREATION_NAME}" detail - NOT VERIFIED`,
    );
  } else if (!tagCreation) {
    failures.push(`missing ruleset "${PROTECT_TAG_CREATION_NAME}"`);
  } else {
    checkTagBase(tagCreation, PROTECT_TAG_CREATION_NAME, failures);
    if (!sameMembers(ruleTypes(tagCreation), ["creation"])) {
      failures.push(
        `${PROTECT_TAG_CREATION_NAME} must contain only the creation rule`,
      );
    }
    evaluateBypassActors(
      tagCreation,
      PROTECT_TAG_CREATION_NAME,
      (actors) => {
        if (releaseActorId === undefined) {
          unknowns.push(
            `release account "${releaseActorLogin}" could not be resolved to a numeric user ID - NOT VERIFIED`,
          );
          return;
        }
        const ok =
          actors.length === 1 &&
          actors[0].actor_type === "User" &&
          actors[0].actor_id === releaseActorId &&
          actors[0].bypass_mode === "always";
        if (!ok) {
          failures.push(
            `only ${releaseActorLogin} (User ${releaseActorId}, bypass always) may create protected release tags`,
          );
        }
      },
      failures,
      unknowns,
    );
  }

  return { failures, unknowns };
}
