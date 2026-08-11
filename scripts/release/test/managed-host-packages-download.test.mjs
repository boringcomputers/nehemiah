import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

test("snapshot downloads retry truncated and 5xx failures without residue", () => {
  const result = spawnSync(
    "python3",
    [path.join(testDirectory, "download-retry-harness.py")],
    { encoding: "utf8" },
  );
  assert.equal(
    result.status,
    0,
    `download retry harness failed:\n${result.stdout}${result.stderr}`,
  );
  assert.match(result.stdout, /download retry contract holds/);
});
