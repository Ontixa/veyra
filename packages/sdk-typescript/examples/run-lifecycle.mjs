import assert from "node:assert/strict";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { VeyraApiError, VeyraClient } from "./dist/src/index.js";
import { runLifecycle } from "./dist/examples/lifecycle.js";

/** Node-only trusted I/O; the proposal-producing function never receives it. */
export async function runController({
  apiUrl,
  tokenFile,
  workspace,
  approve,
  report = console.log,
}) {
  const root = await realpath(workspace);
  const token = (await readFile(tokenFile, "utf8")).trim();
  const client = new VeyraClient({ baseUrl: apiUrl, token });
  const localPath = (path) => {
    assert.ok(
      !path.includes("\\") &&
        path.split("/").every((part) => part && part !== "." && part !== ".."),
      "Expected a clean relative fixture path",
    );
    const target = resolve(root, path);
    assert.ok(
      target.startsWith(root + sep),
      "Fixture path escapes the selected workspace",
    );
    return target;
  };
  return runLifecycle({
    client,
    approve,
    report,
    readFile: async (path) => {
      const target = localPath(path);
      const handle = await open(target, "r");
      try {
        assert.ok(
          (await handle.stat()).isFile(),
          "Expected a regular fixture file",
        );
        return await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
    },
    assertAbsent: async (path) => {
      try {
        await lstat(localPath(path));
      } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
      }
      throw new Error("Expected the fixture file to be absent");
    },
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      "api-url": { type: "string", default: "http://127.0.0.1:7843/v1/" },
      "token-file": { type: "string" },
      workspace: { type: "string" },
      "demo-approve": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      "Usage: pnpm --filter @veyra/sdk example:lifecycle --token-file PATH --workspace PATH [--api-url URL] [--demo-approve]",
    );
    console.log(
      "Use a disposable daemon with the offline fixture planner. --demo-approve is test authorization, not human authentication.",
    );
    return;
  }
  assert.ok(
    values["token-file"] && values.workspace,
    "Provide --token-file and the daemon's exact --workspace directory",
  );
  const result = await runController({
    apiUrl: values["api-url"],
    tokenFile: values["token-file"],
    workspace: values.workspace,
    approve: async (request) => {
      console.log("Review the exact effect before granting approval:");
      console.log(
        JSON.stringify(
          {
            effectDigest: request.effect_digest,
            resource: request.resource,
            risk: request.risk,
            preview: request.preview,
          },
          null,
          2,
        ),
      );
      if (values["demo-approve"]) {
        console.log(
          "Explicit --demo-approve: granting this fixture only; no human identity proof",
        );
        return true;
      }
      if (!process.stdin.isTTY) {
        console.log(
          "No interactive terminal: approval declined (use --demo-approve only for disposable acceptance)",
        );
        return false;
      }
      const input = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        return (
          (
            await input.question(
              "Type the exact effect digest to approve, or Enter to decline: ",
            )
          ).trim() === request.effect_digest
        );
      } finally {
        input.close();
      }
    },
  });
  console.log(JSON.stringify(result, null, 2));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await main();
  } catch (error) {
    // Never print raw request/configuration objects, stacks, or bearer values.
    console.error(
      error instanceof VeyraApiError
        ? `Lifecycle failed: HTTP ${error.status} (${error.code}); inspect the retained daemon evidence`
        : "Lifecycle failed: check arguments, daemon state and retained evidence; no automatic retry or cleanup",
    );
    process.exitCode = 1;
  }
}
