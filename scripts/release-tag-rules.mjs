// Pure evaluation of the release-tag ruleset contract for Ontixa/veyra.
// Imported by check-github.mjs and by scripts/tests/*.test.mjs so the
// contract is testable without hitting the GitHub API.
//
// Target design (post-transfer, decided 2026-09):
//   "Protect release tag creation" - tag ruleset, active, include exactly
//     [refs/tags/v*] with an empty exclude list, only the `creation` rule,
//     exactly one bypass actor: User <release account> with bypass_mode
//     "always". Tag creation authority stays with tang-vu, not
//     OrganizationAdmin.
//   "Protect release tags" - tag ruleset, active, same exact ref scope,
//     rules {deletion, non_fast_forward, update}, NO creation rule,
//     NO standing bypass actors. Nobody rewrites or deletes a v* tag.
//
// The two rulesets above live at repository source. Higher-level rulesets
// (Organization or beyond) can also apply: an applicable parent that also
// governs release-tag creation, or a same-named ruleset at any source,
// breaks the single-control design and must fail, and a tag-targeted
// parent whose detail cannot be read is an UNKNOWN - never assumed safe.
//
// A field the API token cannot read (e.g. bypass_actors missing, or
// conditions.ref_name malformed) is an UNKNOWN, never an implied empty
// list or implied scope: the gate must report blocked, not pretend the
// invariant holds.

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

// Whether a ref_name include entry can match at least one refs/tags/v*
// ref. GitHub patterns are fnmatch-style; any glob overlapping v* counts
// because partial overlap still widens whatever the ruleset controls.
function includeOverlapsReleaseTags(entry) {
  if (entry === "~ALL") {
    return true;
  }
  if (typeof entry !== "string" || !entry.startsWith("refs/tags/")) {
    return false;
  }
  const glob = entry.slice("refs/tags/".length);
  return glob === "*" || glob.startsWith("v") || glob.startsWith("*");
}

// Whether an exclude entry removes the ENTIRE v* scope. Partial excludes
// leave overlap behind, so the ruleset stays applicable.
function excludeKillsAllReleaseTags(entry) {
  return (
    entry === "~ALL" || entry === "refs/tags/*" || entry === RELEASE_TAG_PATTERN
  );
}

// Exact ref-scope contract for the two target rulesets: include must be
// exactly [RELEASE_TAG_PATTERN] and exclude exactly empty. A missing or
// malformed conditions.ref_name is UNKNOWN, not a fail-by-absence.
function checkTagScope(ruleset, name, failures, unknowns) {
  if (ruleset.target !== "tag") {
    failures.push(`${name} must target tags`);
  }
  if (ruleset.enforcement !== "active") {
    failures.push(`${name} must be active`);
  }
  const ref = ruleset.conditions?.ref_name;
  if (!ref || !Array.isArray(ref.include) || !Array.isArray(ref.exclude)) {
    unknowns.push(
      `cannot evaluate ref scope of ${name} (missing or malformed conditions.ref_name) - NOT VERIFIED`,
    );
    return;
  }
  if (!sameMembers(ref.include, [RELEASE_TAG_PATTERN])) {
    failures.push(
      `${name} must cover ${RELEASE_TAG_PATTERN} exactly as include scope (found ${JSON.stringify(ref.include)})`,
    );
  }
  if (ref.exclude.length !== 0) {
    failures.push(
      `${name} must have an empty exclude scope (found ${JSON.stringify(ref.exclude)})`,
    );
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

// A higher-level ruleset that can apply to release tags. Applicable means
// active, tag-targeted, include overlaps v*, and no exclude wipes out the
// whole v* scope.
function evaluateInherited(entry, failures, unknowns) {
  const label = `inherited ruleset "${entry.name ?? `#${entry.id}`}" (${entry.source_type ?? "unknown source"})`;
  const target = entry.detail?.target ?? entry.target;
  if (target !== "tag") {
    if (target === undefined) {
      unknowns.push(
        `${label} target is unknown and its detail could not be read - coverage NOT VERIFIED`,
      );
    }
    return;
  }
  const detail = entry.detail;
  if (!detail) {
    unknowns.push(
      `${label} targets tags but its detail could not be read - coverage NOT VERIFIED`,
    );
    return;
  }
  if (detail.enforcement !== "active") {
    return;
  }
  const ref = detail.conditions?.ref_name;
  if (!ref || !Array.isArray(ref.include) || !Array.isArray(ref.exclude)) {
    unknowns.push(
      `${label} tag ruleset has unreadable ref scope - coverage NOT VERIFIED`,
    );
    return;
  }
  if (
    !ref.include.some(includeOverlapsReleaseTags) ||
    ref.exclude.some(excludeKillsAllReleaseTags)
  ) {
    return;
  }
  if (!Array.isArray(detail.rules)) {
    unknowns.push(
      `${label} applies to ${RELEASE_TAG_PATTERN} but its rules could not be read - NOT VERIFIED`,
    );
    return;
  }
  if (ruleByType(detail, "creation")) {
    failures.push(
      `${label} also governs release-tag creation - creation control must live only in "${PROTECT_TAG_CREATION_NAME}"`,
    );
  }
}

/**
 * Evaluate the two release-tag rulesets against the target design.
 *
 * @param {object[]} rulesets - repository-source ruleset objects already
 *   fetched with full detail.
 * @param {object[]} inherited - higher-level ruleset entries
 *   ({id, name, target, source_type, detail|undefined}); `detail` is the
 *   fetched ruleset or undefined when unreadable.
 * @param {number|undefined} releaseActorId - numeric GitHub user ID of the
 *   release account (resolved via `users/<login>` by the caller). Undefined
 *   means the account could not be resolved -> UNKNOWN, not a pass.
 * @param {string[]} failedRulesetNames - names whose detail fetch failed.
 * @returns {{failures: string[], unknowns: string[]}}
 */
export function evaluateTagRulesets({
  rulesets = [],
  inherited = [],
  releaseActorId,
  releaseActorLogin = "tang-vu",
  failedRulesetNames = [],
}) {
  const failures = [];
  const unknowns = [];

  const protectTagsAll = rulesets.filter((r) => r?.name === PROTECT_TAGS_NAME);
  const tagCreationAll = rulesets.filter(
    (r) => r?.name === PROTECT_TAG_CREATION_NAME,
  );

  // Same-named rulesets at any source make the correct one ambiguous -
  // block instead of picking the first match.
  const ambiguous = new Set();
  for (const [name, list] of [
    [PROTECT_TAGS_NAME, protectTagsAll],
    [PROTECT_TAG_CREATION_NAME, tagCreationAll],
  ]) {
    const total =
      list.length + inherited.filter((r) => r?.name === name).length;
    if (total > 1) {
      ambiguous.add(name);
      failures.push(
        `ambiguous: ${total} rulesets named "${name}" - cannot verify which governs release tags`,
      );
    }
  }

  for (const entry of inherited) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    evaluateInherited(entry, failures, unknowns);
  }

  if (ambiguous.has(PROTECT_TAGS_NAME)) {
    // verdict would be arbitrary - nothing further to evaluate
  } else if (failedRulesetNames.includes(PROTECT_TAGS_NAME)) {
    unknowns.push(
      `could not load ruleset "${PROTECT_TAGS_NAME}" detail - NOT VERIFIED`,
    );
  } else if (protectTagsAll.length === 0) {
    failures.push(`missing ruleset "${PROTECT_TAGS_NAME}"`);
  } else {
    const protectTags = protectTagsAll[0];
    checkTagScope(protectTags, PROTECT_TAGS_NAME, failures, unknowns);
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

  if (ambiguous.has(PROTECT_TAG_CREATION_NAME)) {
    // same - no arbitrary verdict
  } else if (failedRulesetNames.includes(PROTECT_TAG_CREATION_NAME)) {
    unknowns.push(
      `could not load ruleset "${PROTECT_TAG_CREATION_NAME}" detail - NOT VERIFIED`,
    );
  } else if (tagCreationAll.length === 0) {
    failures.push(`missing ruleset "${PROTECT_TAG_CREATION_NAME}"`);
  } else {
    const tagCreation = tagCreationAll[0];
    checkTagScope(tagCreation, PROTECT_TAG_CREATION_NAME, failures, unknowns);
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
