#!/usr/bin/env node

import path from "node:path";
import { parseArguments, verifyReleaseDirectory } from "./lib.mjs";

const options = parseArguments(process.argv.slice(2), [
  "directory",
  "allow-unchecksummed",
]);
const directory = path.resolve(options.directory ?? ".");
const allowedUnchecksummedFiles = options["allow-unchecksummed"]
  ? options["allow-unchecksummed"].split(",")
  : [];
const { manifest, checksums } = await verifyReleaseDirectory(directory, {
  allowedUnchecksummedFiles,
});
process.stdout.write(
  `verified ${checksums.size} checksummed files for release ${manifest.version}\n`,
);
