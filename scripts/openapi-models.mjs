#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.slice(2).includes("--check");
const unknown = process.argv
  .slice(2)
  .filter((argument) => argument !== "--check");
if (unknown.length) throw new Error(`unknown arguments: ${unknown.join(", ")}`);

const loadBuiltModule = async (relativePath) => {
  try {
    return await import(pathToFileURL(resolve(root, relativePath)).href);
  } catch (error) {
    throw new Error(
      `OpenAPI model generation requires a current control-plane build. Run npm -w apps/nehemiah run build first. (${String(error)})`,
    );
  }
};

const { openApiDocument } = await loadBuiltModule(
  "apps/nehemiah/dist/http/openapi.js",
);
const { generateOpenApiModels } = await loadBuiltModule(
  "apps/nehemiah/dist/http/openapi-models.js",
);
const generated = generateOpenApiModels(openApiDocument);
const canonicalContents = (file) => {
  if (file.path !== "generated/openapi/go/models.go") return file.contents;
  try {
    return execFileSync("gofmt", [], {
      encoding: "utf8",
      input: file.contents,
    });
  } catch (error) {
    throw new Error(
      "OpenAPI Go model generation requires gofmt. Install the Go version documented in generated/openapi/README.md.",
      { cause: error },
    );
  }
};
let drift = false;
for (const file of generated) {
  const destination = resolve(root, file.path);
  const contents = canonicalContents(file);
  if (check) {
    const existing = await readFile(destination, "utf8").catch(() => undefined);
    if (existing !== contents) {
      process.stderr.write(`OpenAPI model drift: ${file.path}\n`);
      drift = true;
    }
    continue;
  }
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, contents, "utf8");
  process.stdout.write(`Generated ${file.path}\n`);
}
if (drift) process.exitCode = 1;
