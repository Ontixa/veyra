import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const directory = resolve(import.meta.dirname, "../schema");
const fixtureDirectory = resolve(import.meta.dirname, "../fixtures");

test("all generated schemas are valid JSON with stable protocol markers", async () => {
  const files = (await readdir(directory)).filter((file) =>
    file.endsWith(".schema.json"),
  );
  assert.equal(files.length, 16);
  for (const file of files) {
    const document = JSON.parse(
      await readFile(resolve(directory, file), "utf8"),
    );
    assert.equal(document["x-veyra-protocol"], "veyra.protocol/v1");
    assert.match(document.$schema, /^https:\/\/json-schema\.org\//);
  }
});

test("committed compatibility fixtures retain their cross-record bindings", async () => {
  const principal = JSON.parse(
    await readFile(resolve(fixtureDirectory, "agent.principal.json"), "utf8"),
  );
  const intent = JSON.parse(
    await readFile(
      resolve(fixtureDirectory, "filesystem-create.intent.json"),
      "utf8",
    ),
  );
  assert.equal(intent.schema_version, "veyra.protocol/v1");
  assert.equal(intent.principal_id, principal.id);
  assert.deepEqual(intent.requested_resources, [
    { kind: "filesystem", workspace: "default", path: "demo" },
  ]);
  assert.equal(intent.context.path, "demo/hello.txt");
});

test("the VEP-0002 precondition_failed state is a stable serialized value", async () => {
  const transaction = JSON.parse(
    await readFile(
      resolve(fixtureDirectory, "precondition-failed.transaction.json"),
      "utf8",
    ),
  );
  assert.equal(transaction.schema_version, "veyra.protocol/v1");
  assert.equal(transaction.state, "precondition_failed");
  const schema = JSON.parse(
    await readFile(resolve(directory, "transaction.schema.json"), "utf8"),
  );
  const states = schema.$defs.TransactionState.oneOf.map(
    (variant) => variant.const,
  );
  assert.ok(
    states.includes("precondition_failed"),
    "generated TransactionState schema must include the VEP-0002 state",
  );
  assert.equal(states.length, 17);
});
