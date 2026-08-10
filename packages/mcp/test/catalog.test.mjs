import assert from "node:assert/strict";
import test from "node:test";
import { toolAvailable } from "../catalog.mjs";

test("managed catalog hides host-local AI and persistence tools", () => {
  for (const name of [
    "run_task",
    "publish_computer",
    "save_computer",
    "screenshot",
    "create_volume",
  ]) {
    assert.equal(toolAvailable("cloud", name), false);
    assert.equal(toolAvailable("local", name), true);
    assert.equal(toolAvailable("self-hosted", name), true);
  }
  for (const name of ["launch_computer", "run_command", "preview_url"]) {
    assert.equal(toolAvailable("cloud", name), true);
  }
});
