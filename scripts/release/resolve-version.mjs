#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReleaseVersion, writeGitHubOutput } from "./lib.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const cliPackage = JSON.parse(
  await readFile(
    path.join(repositoryRoot, "packages/cli/package.json"),
    "utf8",
  ),
);
const sdkPackage = JSON.parse(
  await readFile(
    path.join(repositoryRoot, "packages/sdk/package.json"),
    "utf8",
  ),
);
const version = resolveReleaseVersion({
  eventName: process.env.GITHUB_EVENT_NAME,
  refName: process.env.GITHUB_REF_NAME,
  inputVersion: process.env.RELEASE_INPUT_VERSION,
  cliVersion: cliPackage.version,
  sdkVersion: sdkPackage.version,
});
if (process.env.GITHUB_OUTPUT)
  await writeGitHubOutput(process.env.GITHUB_OUTPUT, { version });
process.stdout.write(`${version}\n`);
