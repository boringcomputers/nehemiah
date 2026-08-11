#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  parseArguments,
  invariant,
  validateSignedTagEvidence,
} from "./lib.mjs";

const options = parseArguments(process.argv.slice(2), [
  "ref",
  "tag",
  "expected-tag",
  "expected-commit",
]);
for (const required of ["ref", "tag", "expected-tag", "expected-commit"]) {
  invariant(options[required], `--${required} is required`);
}
const ref = JSON.parse(await readFile(path.resolve(options.ref), "utf8"));
const tag = JSON.parse(await readFile(path.resolve(options.tag), "utf8"));
validateSignedTagEvidence(ref, tag, {
  expectedTag: options["expected-tag"],
  expectedCommit: options["expected-commit"],
});
process.stdout.write(
  `verified signed annotated tag ${options["expected-tag"]}\n`,
);
