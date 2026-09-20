import { spawnSync } from "node:child_process";
import { evaluateTagRulesets } from "./release-tag-rules.mjs";

const canonicalRepository = "Ontixa/veyra";
const repository = process.env.VEYRA_GITHUB_REPOSITORY ?? canonicalRepository;
const releaseActorLogin = process.env.VEYRA_RELEASE_TAG_ACTOR ?? "tang-vu";
const apiVersion = "2026-03-10";
const failures = [];
const unknowns = [];
let checks = 0;

function check(condition, message) {
  checks += 1;
  if (!condition) {
    failures.push(message);
  }
}

function request(path, { json = true } = {}) {
  const result = spawnSync(
    "gh",
    [
      "api",
      path,
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      `X-GitHub-Api-Version: ${apiVersion}`,
    ],
    { encoding: "utf8" },
  );

  const detail = (
    result.stderr ||
    result.error?.message ||
    "unknown GitHub CLI error"
  ).trim();
  check(
    result.status === 0,
    `GitHub API request failed for ${path}: ${detail}`,
  );
  if (result.status !== 0) {
    return undefined;
  }
  if (!json) {
    return true;
  }

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    check(
      false,
      `GitHub API returned invalid JSON for ${path}: ${error.message}`,
    );
    return undefined;
  }
}

function sameMembers(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    [...actual]
      .sort()
      .every((value, index) => value === [...expected].sort()[index])
  );
}

function ruleByType(ruleset, type) {
  return ruleset?.rules?.find((rule) => rule.type === type);
}

const repo = request(`repos/${repository}`);
check(repo?.full_name === repository, `expected repository ${repository}`);
check(repo?.visibility === "public", "repository must remain public");
check(
  repo?.description === "Reversible execution for AI agents.",
  "repository description has drifted",
);
check(repo?.has_issues === true, "Issues must remain enabled");
check(
  repo?.has_discussions === false,
  "Discussions must stay disabled until maintainers can moderate them",
);
for (const topic of [
  "ai-agents",
  "audit-log",
  "capability-security",
  "reversible-execution",
  "rust",
]) {
  check(repo?.topics?.includes(topic), `repository topic is missing: ${topic}`);
}
check(
  repo?.security_and_analysis?.dependabot_security_updates?.status ===
    "enabled",
  "Dependabot security updates must be enabled",
);
check(
  repo?.security_and_analysis?.secret_scanning?.status === "enabled",
  "secret scanning must be enabled",
);
check(
  repo?.security_and_analysis?.secret_scanning_push_protection?.status ===
    "enabled",
  "secret scanning push protection must be enabled",
);

const community = request(`repos/${repository}/community/profile`);
check(
  community?.health_percentage === 100,
  "GitHub community profile must remain at 100%",
);

const privateReporting = request(
  `repos/${repository}/private-vulnerability-reporting`,
);
check(
  privateReporting?.enabled === true,
  "private vulnerability reporting must be enabled",
);
request(`repos/${repository}/vulnerability-alerts`, { json: false });

const securityUpdates = request(`repos/${repository}/automated-security-fixes`);
check(
  securityUpdates?.enabled === true && securityUpdates?.paused === false,
  "Dependabot security updates must be enabled and active",
);

const actionsPolicy = request(`repos/${repository}/actions/permissions`);
check(actionsPolicy?.enabled === true, "GitHub Actions must be enabled");
check(
  actionsPolicy?.allowed_actions === "selected",
  "GitHub Actions must use the selected-actions policy",
);
check(
  actionsPolicy?.sha_pinning_required === true,
  "GitHub must enforce full-SHA Action pinning",
);

const selectedActions = request(
  `repos/${repository}/actions/permissions/selected-actions`,
);
check(
  selectedActions?.github_owned_allowed === true,
  "GitHub-owned Actions must remain allowed",
);
check(
  selectedActions?.verified_allowed === false,
  "all verified Marketplace Actions must not be broadly allowed",
);
check(
  sameMembers(selectedActions?.patterns_allowed, [
    "anchore/sbom-action@*",
    "ossf/scorecard-action@*",
    "pnpm/action-setup@*",
  ]),
  "third-party Action allowlist must contain only Anchore SBOM, pnpm, and OpenSSF Scorecard",
);

const workflowPolicy = request(
  `repos/${repository}/actions/permissions/workflow`,
);
check(
  workflowPolicy?.default_workflow_permissions === "read",
  "default workflow token permissions must remain read-only",
);
check(
  workflowPolicy?.can_approve_pull_request_reviews === false,
  "workflows must not approve pull requests",
);

const immutableReleases = request(`repos/${repository}/immutable-releases`);
check(
  immutableReleases?.enabled === true,
  "future GitHub Releases must be immutable",
);

const summaries = request(
  `repos/${repository}/rulesets?includes_parents=false`,
);
const rulesets = [];
const failedRulesetNames = [];
if (Array.isArray(summaries)) {
  for (const summary of summaries) {
    const detail = request(`repos/${repository}/rulesets/${summary.id}`);
    if (detail) {
      rulesets.push(detail);
    } else {
      failedRulesetNames.push(summary.name);
    }
  }
}

const mainRuleset = rulesets.find((ruleset) => ruleset.name === "Protect main");
check(mainRuleset?.target === "branch", "Protect main must target branches");
check(mainRuleset?.enforcement === "active", "Protect main must be active");
check(
  mainRuleset?.conditions?.ref_name?.include?.includes("~DEFAULT_BRANCH"),
  "Protect main must include the default branch",
);
check(
  Array.isArray(mainRuleset?.bypass_actors) &&
    mainRuleset.bypass_actors.length === 0,
  "Protect main must not have a standing bypass actor",
);
for (const ruleType of [
  "deletion",
  "non_fast_forward",
  "required_linear_history",
  "pull_request",
  "required_status_checks",
]) {
  check(
    Boolean(ruleByType(mainRuleset, ruleType)),
    `Protect main is missing rule: ${ruleType}`,
  );
}

const pullRequestRule = ruleByType(mainRuleset, "pull_request")?.parameters;
check(
  pullRequestRule?.required_approving_review_count === 0,
  "solo-maintainer pull requests must not require an unavailable reviewer",
);
check(
  pullRequestRule?.required_review_thread_resolution === true,
  "pull-request conversations must be resolved",
);
check(
  pullRequestRule?.dismiss_stale_reviews_on_push === true,
  "stale pull-request approvals must be dismissed",
);
check(
  pullRequestRule?.require_last_push_approval === false,
  "the sole maintainer cannot require another author for the last push",
);
check(
  sameMembers(pullRequestRule?.allowed_merge_methods, ["rebase", "squash"]),
  "only rebase and squash merges may update main",
);

const statusRule = ruleByType(
  mainRuleset,
  "required_status_checks",
)?.parameters;
check(
  statusRule?.strict_required_status_checks_policy === true,
  "required checks must run against the latest main revision",
);
check(
  statusRule?.do_not_enforce_on_create === true,
  "required checks must not prevent initial ref creation",
);
const requiredContexts = (statusRule?.required_status_checks ?? []).map(
  (status) => status.context,
);
const expectedRequiredContexts = [
  "Analyze JavaScript and TypeScript",
  "Full gate (Linux)",
  "Fuzz security boundaries",
  "JavaScript gate (Node 22)",
  "Review dependency changes",
  "Rust gate (Windows MSVC)",
];
for (const context of expectedRequiredContexts) {
  check(
    requiredContexts.includes(context),
    `required check is missing: ${context}`,
  );
}
check(
  sameMembers(requiredContexts, expectedRequiredContexts),
  "Protect main must not retain stale or unreviewed required checks",
);

// Release-tag protection is split by design under organization ownership:
// "Protect release tag creation" holds the single User bypass actor for the
// release account (resolved to a numeric ID, never repo.owner.id which is the
// org), while "Protect release tags" guards update/deletion with no bypass.
const releaseActor = request(`users/${releaseActorLogin}`);
const tagResult = evaluateTagRulesets({
  rulesets,
  releaseActorId: releaseActor?.id,
  releaseActorLogin,
  failedRulesetNames,
});
failures.push(...tagResult.failures);
unknowns.push(...tagResult.unknowns);

check(repo?.allow_merge_commit === false, "merge commits must be disabled");
check(repo?.allow_squash_merge === true, "squash merging must be enabled");
check(repo?.allow_rebase_merge === true, "rebase merging must be enabled");
check(
  repo?.delete_branch_on_merge === true,
  "merged pull-request branches must be deleted automatically",
);

if (unknowns.length > 0) {
  console.error(
    `OSS host gate could not verify ${unknowns.length} item(s) (BLOCKED):`,
  );
  for (const unknown of unknowns) {
    console.error(`- ${unknown}`);
  }
}
if (failures.length > 0) {
  console.error(`OSS host gate failed with ${failures.length} problem(s):`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}
if (unknowns.length > 0) {
  process.exit(1);
}

console.log(
  `OSS host gate passed: ${checks} assertions against ${repository} with no remote writes.`,
);
