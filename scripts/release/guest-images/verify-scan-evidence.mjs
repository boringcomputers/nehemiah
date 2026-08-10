#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertRegularFile,
  invariant,
  parseArguments,
  sha256File,
  validateVersion,
} from "../lib.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const options = parseArguments(process.argv.slice(2), [
  "evidence",
  "images",
  "version",
  "arch",
]);
const version = validateVersion(options.version);
const arch = options.arch;
invariant(
  arch === "amd64" || arch === "arm64",
  "invalid evidence architecture",
);
const evidencePath = path.resolve(options.evidence);
const imageDirectory = path.resolve(options.images);
await assertRegularFile(evidencePath, "guest scan evidence");

const policyPath = path.join(scriptDirectory, "policy.json");
const allowlistPath = path.join(
  scriptDirectory,
  "vulnerability-allowlist.json",
);
const [policyBytes, allowlistBytes, evidenceBytes] = await Promise.all([
  readFile(policyPath),
  readFile(allowlistPath),
  readFile(evidencePath),
]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const policy = JSON.parse(policyBytes);
const allowlist = JSON.parse(allowlistBytes);
const evidence = JSON.parse(evidenceBytes);
const now = Date.now();

invariant(
  evidence.schemaVersion === 1,
  "unsupported guest scan evidence schema",
);
invariant(evidence.version === version, "guest scan evidence version mismatch");
invariant(
  evidence.architecture === arch,
  "guest scan evidence architecture mismatch",
);
invariant(
  evidence.policySha256 === sha256(policyBytes),
  "guest scan policy digest mismatch",
);
invariant(
  evidenceBytes.length <= policy.vulnerabilityScan.maxEvidenceBytes,
  "guest scan evidence exceeds policy",
);

const scanner = evidence.scanner;
invariant(scanner?.tool === "trivy", "unsupported guest scanner");
invariant(
  scanner.version === policy.vulnerabilityScan.version,
  "guest scanner version mismatch",
);
invariant(
  scanner.archiveSha256 === policy.vulnerabilityScan.artifacts[arch].sha256,
  "guest scanner archive digest mismatch",
);
for (const digest of [
  scanner.archiveSha256,
  scanner.binarySha256,
  scanner.database?.sha256,
]) {
  invariant(/^[0-9a-f]{64}$/.test(digest), "invalid scanner evidence digest");
}
invariant(
  scanner.database.maxAgeHours === policy.vulnerabilityScan.maxDatabaseAgeHours,
  "scanner DB freshness policy mismatch",
);
const updatedAt = Date.parse(scanner.database.updatedAt);
const nextUpdate = Date.parse(scanner.database.nextUpdate);
const downloadedAt = Date.parse(scanner.database.downloadedAt);
const observedAt = Date.parse(scanner.database.observedAt);
for (const timestamp of [updatedAt, nextUpdate, downloadedAt, observedAt]) {
  invariant(Number.isFinite(timestamp), "invalid scanner database timestamp");
}
invariant(updatedAt <= now + 5 * 60_000, "scanner database is future-dated");
invariant(
  now - updatedAt <= policy.vulnerabilityScan.maxDatabaseAgeHours * 3_600_000,
  "scanner database is stale",
);
invariant(now <= nextUpdate, "scanner database is past NextUpdate");
invariant(
  downloadedAt >= updatedAt && observedAt >= downloadedAt,
  "scanner database evidence timestamps are inconsistent",
);

invariant(
  policy.vulnerabilityScan.allowlistSha256 === sha256(allowlistBytes),
  "vulnerability allowlist digest mismatch",
);
invariant(
  allowlist.schemaVersion === 1 && Array.isArray(allowlist.exceptions),
  "invalid vulnerability allowlist",
);

invariant(
  Array.isArray(evidence.scans) && evidence.scans.length === 2,
  "guest evidence must contain two scans",
);
const seen = new Set();
for (const scan of evidence.scans) {
  const summary = scan?.summary;
  const flavor = summary?.flavor;
  invariant(flavor === "python" || flavor === "desktop", "invalid scan flavor");
  invariant(!seen.has(flavor), `duplicate ${flavor} scan`);
  seen.add(flavor);
  invariant(summary.architecture === arch, "scan architecture mismatch");
  invariant(
    JSON.stringify(summary.scanner) === JSON.stringify(scanner),
    "scan uses different scanner evidence",
  );
  invariant(
    summary.allowlistSha256 === sha256(allowlistBytes),
    "scan allowlist digest mismatch",
  );
  invariant(summary.rejectedFindings === 0, "scan contains rejected findings");
  invariant(
    typeof scan.report === "string" && scan.report.length > 0,
    "scan report is missing",
  );
  invariant(
    sha256(scan.report) === summary.reportSha256,
    "scan report digest mismatch",
  );

  const imageName = `nehemiah-guest-${flavor}_${version}_linux_${arch}.ext4.gz`;
  invariant(
    summary.artifactSha256 ===
      (await sha256File(path.join(imageDirectory, imageName))),
    `scan does not cover ${imageName}`,
  );
  const report = JSON.parse(scan.report);
  invariant(Array.isArray(report.Results), "invalid Trivy filesystem report");
  invariant(
    report.Results.some(({ Target }) =>
      Target?.endsWith("opt/boring/bin/bc-guest-agent"),
    ),
    "Trivy report did not inventory the injected guest agent",
  );
  const findings = report.Results.flatMap((result) =>
    (result.Vulnerabilities ?? [])
      .filter(({ Severity }) => Severity === "HIGH" || Severity === "CRITICAL")
      .map(({ VulnerabilityID, PkgName }) => ({
        id: VulnerabilityID,
        package: PkgName,
      })),
  );
  const exceptions = allowlist.exceptions.filter(
    (exception) => exception.flavor === flavor,
  );
  invariant(
    new Set(exceptions.map(({ id, package: name }) => `${id}\0${name}`))
      .size === exceptions.length,
    `duplicate ${flavor} vulnerability exception`,
  );
  for (const exception of exceptions) {
    const expiry = Date.parse(exception.expiresAt);
    invariant(
      Number.isFinite(expiry) &&
        expiry > now &&
        expiry <= now + 30 * 24 * 3_600_000,
      `stale or overlong ${exception.id} exception`,
    );
    invariant(
      typeof exception.reason === "string" && exception.reason.length >= 20,
      `missing review reason for ${exception.id}`,
    );
    invariant(
      findings.some(
        (finding) =>
          finding.id === exception.id && finding.package === exception.package,
      ),
      `unused ${exception.id} exception`,
    );
  }
  for (const finding of findings) {
    invariant(
      exceptions.some(
        (exception) =>
          exception.id === finding.id && exception.package === finding.package,
      ),
      `unapproved ${finding.id} in ${finding.package}`,
    );
  }
  invariant(
    summary.highCriticalFindings === findings.length &&
      summary.approvedExceptions === exceptions.length,
    "scan finding counts do not match the report",
  );
}
invariant(
  seen.has("python") && seen.has("desktop"),
  "guest scan flavor set is incomplete",
);
process.stdout.write(
  `verified ${path.basename(evidencePath)}: Trivy ${scanner.version}, DB ${scanner.database.updatedAt} (${scanner.database.sha256})\n`,
);
