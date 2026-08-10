#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  invariant,
  parseArguments,
  parseChecksums,
  renderFormula,
  validateRepository,
  validateVersion,
} from "./lib.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const options = parseArguments(process.argv.slice(2), [
  "version",
  "repository",
  "checksums",
  "out",
  "template",
]);
const version = validateVersion(options.version);
const repository = validateRepository(options.repository);
invariant(options.checksums, "--checksums is required");
invariant(options.out, "--out is required");
const checksums = parseChecksums(
  await readFile(path.resolve(options.checksums), "utf8"),
);
const cliName = `nehemiah-cli-${version}.tgz`;
invariant(checksums.has(cliName), `${cliName} is missing from SHA256SUMS`);
const templatePath = path.resolve(
  options.template ?? path.join(scriptDirectory, "templates/nehemiah.rb.tpl"),
);
const formula = renderFormula(await readFile(templatePath, "utf8"), {
  version,
  repository,
  sha256: checksums.get(cliName),
});
await writeFile(path.resolve(options.out), formula, {
  encoding: "utf8",
  mode: 0o644,
});
