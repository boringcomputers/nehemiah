#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  selectAuthorizedCIRun,
  validateAuthorizedCIJobs,
} from "./ci-policy.mjs";
import { invariant, parseArguments } from "./lib.mjs";

const options = parseArguments(process.argv.slice(2), [
  "phase",
  "repository",
  "commit",
  "repository-evidence",
  "workflow-evidence",
  "branch-evidence",
  "comparison-evidence",
  "runs-evidence",
  "jobs-evidence",
]);
for (const required of [
  "phase",
  "repository",
  "commit",
  "repository-evidence",
  "workflow-evidence",
  "branch-evidence",
  "comparison-evidence",
  "runs-evidence",
]) {
  invariant(options[required], `--${required} is required`);
}
invariant(
  options.phase === "select" || options.phase === "verify",
  "--phase must be select or verify",
);

async function readJSON(file, label) {
  try {
    return JSON.parse(await readFile(path.resolve(file), "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

const evidence = {
  repository: await readJSON(
    options["repository-evidence"],
    "repository evidence",
  ),
  workflow: await readJSON(options["workflow-evidence"], "workflow evidence"),
  branch: await readJSON(options["branch-evidence"], "branch evidence"),
  comparison: await readJSON(
    options["comparison-evidence"],
    "comparison evidence",
  ),
  runs: await readJSON(options["runs-evidence"], "workflow-run evidence"),
};
const authorization = selectAuthorizedCIRun(evidence, {
  expectedRepository: options.repository,
  expectedCommit: options.commit,
});

if (options.phase === "select") {
  process.stdout.write(`${authorization.run.id}\n`);
} else {
  invariant(options["jobs-evidence"], "--jobs-evidence is required");
  const jobs = await readJSON(
    options["jobs-evidence"],
    "workflow-job evidence",
  );
  validateAuthorizedCIJobs(jobs, {
    run: authorization.run,
    expectedCommit: options.commit,
    defaultBranch: authorization.defaultBranch,
  });
  process.stdout.write(
    `verified protected ${authorization.defaultBranch} CI run ${authorization.run.id} for ${options.commit}\n`,
  );
}
