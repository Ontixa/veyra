// Fake `gh api` transport for protect-release-tags.ps1 tests. State lives
// in the JSON file named by FAKE_GH_STATE; every call is appended as
// "METHOD PATH" to FAKE_GH_LOG so tests can assert call order and that no
// write happened.
//
// Fixture shape:
//   {
//     users: { "<login>": { "id": <number> } },
//     rulesets: [ <full repo-source ruleset objects> ],
//     orgRulesets: [ <org ruleset objects, "unreadable": true to 404> ]
//   }
//
// FAKE_GH_MUTATE="drift-on-create": when the POST that creates the
// creation ruleset succeeds, the fake also mutates "Protect release tags"
// so the script's mid-apply drift check must refuse the following PUT.

import fs from "node:fs";

const statePath = process.env.FAKE_GH_STATE;
const logPath = process.env.FAKE_GH_LOG;
const mutate = process.env.FAKE_GH_MUTATE ?? "";

const load = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = (s) => fs.writeFileSync(statePath, JSON.stringify(s, null, 2));
const log = (line) => fs.appendFileSync(logPath, line + "\n");
const fail = (msg) => {
  process.stderr.write(JSON.stringify({ message: msg }) + "\n");
  process.exit(1);
};

const argv = process.argv.slice(2);
let method = "GET";
let path = null;
let jq = null;
let input = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "api" || a === "--paginate") {
    continue;
  } else if (a === "-X" || a === "--method") {
    method = argv[++i];
  } else if (a === "-q" || a === "--jq") {
    jq = argv[++i];
  } else if (a === "-H" || a === "--header") {
    i++;
  } else if (a === "--input") {
    input = argv[++i];
  } else if (!a.startsWith("-") && path === null) {
    path = a;
  }
}
if (path === null) {
  fail("fake-gh: no path given");
}

log(`${method} ${path}`);
const url = new URL(`https://api.github.com/${path}`);
const seg = url.pathname.split("/").filter(Boolean);
const state = load();

function emit(payload) {
  if (jq === ".[]" && Array.isArray(payload)) {
    for (const item of payload) {
      process.stdout.write(JSON.stringify(item) + "\n");
    }
  } else {
    process.stdout.write(JSON.stringify(payload ?? null) + "\n");
  }
}

const notFound = () => fail("Not Found");

// GET users/<login>
if (method === "GET" && seg[0] === "users" && seg.length === 2) {
  const user = state.users?.[seg[1]];
  if (!user) notFound();
  emit(user);
  process.exit(0);
}

// /repos/<o>/<r>/rulesets...
if (seg[0] === "repos" && seg.length >= 4 && seg[3] === "rulesets") {
  const repoRulesets = state.rulesets ?? [];
  if (method === "GET" && seg.length === 4) {
    // list summaries; parents appear only when includes_parents=true
    const summaries = repoRulesets.map((r) => ({
      id: r.id,
      name: r.name,
      target: r.target,
      source_type: "Repository",
    }));
    if (url.searchParams.get("includes_parents") === "true") {
      for (const o of state.orgRulesets ?? []) {
        summaries.push({
          id: o.id,
          name: o.name,
          target: o.target,
          source_type: "Organization",
        });
      }
    }
    emit(summaries);
    process.exit(0);
  }
  const id = Number(seg[4]);
  if (method === "GET" && seg.length === 5) {
    const found = repoRulesets.find((r) => r.id === id);
    if (!found) notFound();
    emit(found);
    process.exit(0);
  }
  if (method === "POST" && seg.length === 4) {
    const body = JSON.parse(fs.readFileSync(input, "utf8"));
    const ids = [
      ...repoRulesets.map((r) => r.id),
      ...(state.orgRulesets ?? []).map((r) => r.id),
    ];
    body.id = (ids.length ? Math.max(...ids) : 0) + 1;
    repoRulesets.push(body);
    if (mutate === "drift-on-create") {
      const protect = repoRulesets.find(
        (r) => r.name === "Protect release tags",
      );
      if (protect) {
        protect.bypass_actors = [
          { actor_type: "User", actor_id: 999, bypass_mode: "always" },
        ];
      }
    }
    save(state);
    emit(body);
    process.exit(0);
  }
  if (method === "PUT" && seg.length === 5) {
    const body = JSON.parse(fs.readFileSync(input, "utf8"));
    const idx = repoRulesets.findIndex((r) => r.id === id);
    if (idx === -1) notFound();
    body.id = id;
    repoRulesets[idx] = body;
    save(state);
    emit(body);
    process.exit(0);
  }
}

// GET /orgs/<org>/rulesets/<id>
if (method === "GET" && seg[0] === "orgs" && seg[2] === "rulesets") {
  const id = Number(seg[3]);
  const found = (state.orgRulesets ?? []).find((r) => r.id === id);
  if (!found || found.unreadable) notFound();
  const { unreadable, ...detail } = found;
  emit(detail);
  process.exit(0);
}

fail(`fake-gh: unhandled ${method} ${path}`);
