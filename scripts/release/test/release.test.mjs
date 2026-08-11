import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createManifest,
  MANAGED_RUNTIME_POLICY,
  parseChecksums,
  renderFormula,
  resolveRepositoryOutputDirectory,
  resolveReleaseVersion,
  validateSignedTagEvidence,
  verifyReleaseDirectory,
  writeChecksums,
  writeManifest,
} from "../lib.mjs";

const VERSION = "1.2.3-beta.4";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const REPOSITORY = "boringcomputers/nehemiah";
const TEST_GUEST_DIGESTS = {
  amd64: { python: "1".repeat(64), desktop: "2".repeat(64) },
  arm64: { python: "3".repeat(64), desktop: "4".repeat(64) },
};
const TEST_PACKAGE_MANIFESTS = Object.fromEntries(
  ["amd64", "arm64"].map((arch, index) => [
    arch,
    {
      contractVersion: 1,
      architecture: arch,
      releaseVersion: VERSION,
      operatingSystem: {
        id: "ubuntu",
        version: "24.04",
        codename: "noble",
      },
      packageCount: 152,
      manifestSha256: String(index + 5).repeat(64),
      snapshot: {
        baseUrl: "https://snapshot.ubuntu.com/ubuntu/20260809T000000Z",
        capturedAt: "2026-08-09T00:00:00Z",
      },
    },
  ]),
);

function createTestManifest() {
  return createManifest({
    version: VERSION,
    commit: COMMIT,
    sourceDateEpoch: 1_700_000_000,
    repository: REPOSITORY,
    guestRootfsDigests: TEST_GUEST_DIGESTS,
    hostPackageManifests: TEST_PACKAGE_MANIFESTS,
  });
}

async function withTempDirectory(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "release-test-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function createFixture(directory) {
  const manifest = createTestManifest();
  for (const artifact of manifest.artifacts) {
    await writeFile(
      path.join(directory, artifact.name),
      `fixture:${artifact.name}\n`,
      "utf8",
    );
  }
  await writeManifest(directory, manifest);
  await writeChecksums(directory, [
    ...manifest.artifacts.map(({ name }) => name),
    "release-manifest.json",
  ]);
  return manifest;
}

test("checksum generation is sorted, deterministic, and verifies the exact matrix", async () => {
  await withTempDirectory(async (first) => {
    await withTempDirectory(async (second) => {
      await createFixture(first);
      await createFixture(second);
      const firstChecksums = await readFile(
        path.join(first, "SHA256SUMS"),
        "utf8",
      );
      const secondChecksums = await readFile(
        path.join(second, "SHA256SUMS"),
        "utf8",
      );
      assert.equal(firstChecksums, secondChecksums);
      const names = [...parseChecksums(firstChecksums).keys()];
      assert.deepEqual(names, [...names].sort());
      const result = await verifyReleaseDirectory(first);
      assert.equal(result.manifest.version, VERSION);
      assert.equal(result.checksums.size, 22);
      assert.equal(result.manifest.schemaVersion, 5);
      assert.equal(result.manifest.managedCloudInitCompatible, true);
      assert.equal(
        result.manifest.managedHost.bootstrapArtifact,
        `nehemiah-host-bootstrap_${VERSION}.tar.gz`,
      );
      assert.equal(result.manifest.managedHost.contractVersion, 4);
      assert.equal(
        result.manifest.managedHost.rootfsProfile,
        "signed-developer-ext4-v1",
      );
      assert.deepEqual(
        Object.keys(result.manifest.managedHost.inputs.amd64).sort(),
        ["firecracker", "kernel"],
      );
      for (const arch of ["amd64", "arm64"]) {
        const hostImages = result.manifest.managedHost.guestImages[arch];
        for (const flavor of ["python", "desktop"]) {
          assert.equal(hostImages[flavor].format, "ext4.gz");
          assert.match(
            hostImages[flavor].artifact,
            new RegExp(
              `^nehemiah-guest-${flavor}_.+_linux_${arch}\\.ext4\\.gz$`,
            ),
          );
          assert.ok(hostImages[flavor].uncompressedBytes > 0);
          assert.ok(hostImages[flavor].maxCompressedBytes > 0);
          assert.match(hostImages[flavor].uncompressedSha256, /^[0-9a-f]{64}$/);
        }
        assert.equal(hostImages.scanEvidence.format, "json");
      }
      const policy = result.manifest.managedHost.guestImagePolicy;
      assert.equal(policy.architectures.amd64.ociBase.nodeVersion, "24.19.0");
      assert.equal(policy.architectures.arm64.ociBase.nodeVersion, "24.19.0");
      assert.equal(policy.alpineRepositorySnapshot.release, "v3.23");
      assert.equal(
        policy.alpineRepositorySnapshot.capturedAt,
        "2026-08-09T10:08:00Z",
      );
      assert.equal(policy.npmRuntime.version, "11.19.0");
      assert.equal(policy.pythonRuntime.pip.version, "26.2.1");
      assert.equal(policy.pythonRuntime.setuptools.version, "84.0.0");
      assert.deepEqual(
        policy.pythonRuntime.pipVendorOverlays.map(
          ({ name, version, format }) => ({ name, version, format }),
        ),
        [
          { name: "msgpack", version: "1.2.1", format: "sdist" },
          { name: "setuptools", version: "80.9.0", format: "wheel" },
        ],
      );
      for (const overlay of policy.pythonRuntime.pipVendorOverlays) {
        assert.match(overlay.url, /^https:\/\/files\.pythonhosted\.org\//);
        assert.match(overlay.sha256, /^[0-9a-f]{64}$/);
      }
      for (const snapshot of Object.values(
        policy.alpineRepositorySnapshot.architectures,
      )) {
        for (const repository of [snapshot.main, snapshot.community]) {
          assert.match(repository.url, /^https:\/\//);
          assert.match(repository.sha256, /^[0-9a-f]{64}$/);
        }
      }
      assert.equal(policy.vulnerabilityScan.version, "0.72.0");
      assert.equal(policy.vulnerabilityScan.maxDatabaseAgeHours, 24);
      assert.match(policy.vulnerabilityScan.allowlistSha256, /^[0-9a-f]{64}$/);
      for (const inputs of Object.values(result.manifest.managedHost.inputs)) {
        for (const input of Object.values(inputs)) {
          assert.match(input.sha256, /^[0-9a-f]{64}$/);
          assert.match(input.artifact, /^nehemiah-runtime-/);
          assert.ok(input.maxBytes > 0);
          assert.equal(input.url, undefined);
          assert.equal(input.sourceUrl, undefined);
        }
      }
      for (const arch of ["amd64", "arm64"]) {
        for (const component of ["firecracker", "kernel"]) {
          const policy = MANAGED_RUNTIME_POLICY.architectures[arch][component];
          const input = result.manifest.managedHost.inputs[arch][component];
          assert.deepEqual(input, {
            version: policy.version,
            artifact: policy.artifact,
            format: policy.format,
            maxBytes: policy.maxBytes,
            sha256: policy.sha256,
            ...(component === "firecracker"
              ? {
                  firecrackerSha256: policy.firecrackerSha256,
                  jailerSha256: policy.jailerSha256,
                }
              : {}),
          });
          assert.ok(
            result.manifest.artifacts.some(
              (artifact) => artifact.name === policy.artifact,
            ),
          );
        }
        assert.match(
          result.manifest.managedHost.runtimeCohorts[arch].cohortId,
          /^[0-9a-f]{64}$/,
        );
        assert.equal(
          result.manifest.managedHost.packageRepositories[arch].packageCount,
          152,
        );
      }
    });
  });
});

test("verification fails closed when checksum metadata is missing", async () => {
  await withTempDirectory(async (directory) => {
    await createFixture(directory);
    await unlink(path.join(directory, "SHA256SUMS"));
    await assert.rejects(
      verifyReleaseDirectory(directory),
      /SHA256SUMS is missing/,
    );
  });
});

test("verification rejects a tampered artifact", async () => {
  await withTempDirectory(async (directory) => {
    const manifest = await createFixture(directory);
    await writeFile(
      path.join(directory, manifest.artifacts[0].name),
      "tampered\n",
      "utf8",
    );
    await assert.rejects(
      verifyReleaseDirectory(directory),
      /checksum mismatch/,
    );
  });
});

test("verification rejects unexpected files and permits only explicit release metadata", async () => {
  await withTempDirectory(async (directory) => {
    await createFixture(directory);
    await writeFile(
      path.join(directory, "unexpected.txt"),
      "untrusted\n",
      "utf8",
    );
    await assert.rejects(
      verifyReleaseDirectory(directory),
      /unexpected physical artifact set/,
    );

    await unlink(path.join(directory, "unexpected.txt"));
    const extras = ["artifact-provenance.sigstore.json", "SHA256SUMS.minisig"];
    for (const extra of extras) {
      await writeFile(path.join(directory, extra), "fixture\n", "utf8");
    }
    await assert.rejects(
      verifyReleaseDirectory(directory),
      /unexpected physical artifact set/,
    );
    await verifyReleaseDirectory(directory, {
      allowedUnchecksummedFiles: extras,
    });

    await assert.rejects(
      verifyReleaseDirectory(directory, {
        allowedUnchecksummedFiles: [extras[0], extras[0]],
      }),
      /duplicate allowed extra file/,
    );
  });
});

test("managed-host retained runtime pins are immutable release policy", async () => {
  await withTempDirectory(async (directory) => {
    const manifest = createTestManifest();
    manifest.managedHost.inputs.amd64.firecracker.sha256 = "0".repeat(64);
    await assert.rejects(
      writeManifest(directory, manifest),
      /reviewed retained runtime pins/,
    );

    const mutable = createTestManifest();
    mutable.managedHost.inputs.arm64.kernel.artifact = "other-kernel.bin";
    await assert.rejects(
      writeManifest(directory, mutable),
      /reviewed retained runtime pins/,
    );

    const mutableGuest = createTestManifest();
    mutableGuest.managedHost.guestImagePolicy.architectures.amd64.ociBase.reference =
      "docker.io/library/node:24";
    await assert.rejects(
      writeManifest(directory, mutableGuest),
      /reviewed immutable policy/,
    );

    const omittedDesktop = createTestManifest();
    delete omittedDesktop.managedHost.guestImages.arm64.desktop;
    await assert.rejects(
      writeManifest(directory, omittedDesktop),
      /artifact contract is not exact/,
    );
  });
});

test("cloud-init validator reproduces the signed runtime cohort and rejects drift", async () => {
  await withTempDirectory(async (directory) => {
    const manifest = createTestManifest();
    const manifestPath = path.join(directory, "release-manifest.json");
    const selectedPath = path.join(directory, "selected.env");
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
    const accepted = spawnSync(
      "python3",
      [
        path.resolve("infra/latitude/validate-managed-release.py"),
        "--manifest",
        manifestPath,
        "--version",
        VERSION,
        "--arch",
        "amd64",
        "--output",
        selectedPath,
      ],
      { encoding: "utf8" },
    );
    assert.equal(accepted.status, 0, accepted.stderr);
    const selected = Object.fromEntries(
      (await readFile(selectedPath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => line.split("=", 2)),
    );
    assert.equal(
      selected.RUNTIME_COHORT_ID,
      manifest.managedHost.runtimeCohorts.amd64.cohortId,
    );
    assert.equal(selected.RUNTIME_CONTRACT_VERSION, "4");
    assert.equal(selected.PYTHON_SHA256, TEST_GUEST_DIGESTS.amd64.python);
    assert.equal(selected.DESKTOP_SHA256, TEST_GUEST_DIGESTS.amd64.desktop);

    manifest.managedHost.runtimeCohorts.amd64.cohortId = "0".repeat(64);
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
    const rejected = spawnSync(
      "python3",
      [
        path.resolve("infra/latitude/validate-managed-release.py"),
        "--manifest",
        manifestPath,
        "--version",
        VERSION,
        "--arch",
        "amd64",
        "--output",
        path.join(directory, "rejected.env"),
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /runtime cohort is invalid/);
  });
});

test("verification rejects omitted metadata and symlink artifacts", async () => {
  await withTempDirectory(async (directory) => {
    const manifest = await createFixture(directory);
    const checksumPath = path.join(directory, "SHA256SUMS");
    const lines = (await readFile(checksumPath, "utf8")).trimEnd().split("\n");
    await writeFile(checksumPath, `${lines.slice(1).join("\n")}\n`, "utf8");
    await assert.rejects(
      verifyReleaseDirectory(directory),
      /exact manifest artifact set/,
    );

    await createFixture(directory);
    const artifactPath = path.join(directory, manifest.artifacts[0].name);
    await unlink(artifactPath);
    await symlink("release-manifest.json", artifactPath);
    await assert.rejects(
      verifyReleaseDirectory(directory),
      /regular, non-symlink/,
    );
  });
});

test("checksum parser rejects traversal, duplicates, malformed digests, and self-reference", () => {
  const digest = "a".repeat(64);
  assert.throws(
    () => parseChecksums(`${digest}  ../artifact\n`),
    /malformed|unsafe/,
  );
  assert.throws(
    () => parseChecksums(`${digest}  artifact\n${digest}  artifact\n`),
    /duplicate/,
  );
  assert.throws(
    () => parseChecksums(`${"A".repeat(64)}  artifact\n`),
    /malformed/,
  );
  assert.throws(
    () => parseChecksums(`${digest}  SHA256SUMS\n`),
    /self-reference/,
  );
  assert.throws(() => parseChecksums(""), /empty/);
});

test("release output is constrained to one visible repository child", () => {
  const root = "/workspace/repository";
  assert.equal(
    resolveRepositoryOutputDirectory(root, "release-dist"),
    "/workspace/repository/release-dist",
  );
  for (const unsafe of [
    "",
    ".",
    "..",
    ".git",
    "../outside",
    "nested/output",
    "/tmp/output",
  ]) {
    assert.throws(
      () => resolveRepositoryOutputDirectory(root, unsafe),
      /--out|unsafe artifact filename/,
    );
  }
});

test("Homebrew formula rendering is deterministic and checksum-pinned", () => {
  const template = [
    "class Nehemiah < Formula",
    '  url "https://github.com/@@REPOSITORY@@/releases/download/v@@VERSION@@/nehemiah-cli-@@VERSION@@.tgz"',
    '  sha256 "@@SHA256@@"',
    "end",
  ].join("\n");
  const sha256 = "b".repeat(64);
  const first = renderFormula(template, {
    version: VERSION,
    repository: REPOSITORY,
    sha256,
  });
  const second = renderFormula(template, {
    version: VERSION,
    repository: REPOSITORY,
    sha256,
  });
  assert.equal(first, second);
  assert.match(first, new RegExp(sha256));
  assert.match(first, /releases\/download\/v1\.2\.3-beta\.4/);
  assert.doesNotMatch(first, /@@/);
});

test("release version resolution is tag-bound and keeps manual runs build-only", () => {
  assert.equal(
    resolveReleaseVersion({
      eventName: "push",
      refName: `v${VERSION}`,
      cliVersion: VERSION,
      sdkVersion: VERSION,
    }),
    VERSION,
  );
  assert.equal(
    resolveReleaseVersion({
      eventName: "workflow_dispatch",
      inputVersion: VERSION,
      cliVersion: VERSION,
      sdkVersion: VERSION,
    }),
    VERSION,
  );
  assert.throws(
    () =>
      resolveReleaseVersion({
        eventName: "push",
        refName: "v1.2.4",
        cliVersion: VERSION,
        sdkVersion: VERSION,
      }),
    /does not match package version/,
  );
  assert.throws(
    () =>
      resolveReleaseVersion({
        eventName: "pull_request",
        cliVersion: VERSION,
        sdkVersion: "1.2.4",
      }),
    /does not match SDK version/,
  );
});

test("signed tag evidence rejects lightweight, unverified, and commit-mismatched tags", () => {
  const tagObjectSha = "f".repeat(40);
  const ref = {
    ref: `refs/tags/v${VERSION}`,
    object: { type: "tag", sha: tagObjectSha },
  };
  const tag = {
    tag: `v${VERSION}`,
    sha: tagObjectSha,
    object: { type: "commit", sha: COMMIT },
    verification: { verified: true, reason: "valid" },
  };
  assert.equal(
    validateSignedTagEvidence(ref, tag, {
      expectedTag: `v${VERSION}`,
      expectedCommit: COMMIT,
    }),
    true,
  );
  assert.throws(
    () =>
      validateSignedTagEvidence(
        { ...ref, object: { type: "commit", sha: COMMIT } },
        tag,
        {
          expectedTag: `v${VERSION}`,
          expectedCommit: COMMIT,
        },
      ),
    /annotated, not lightweight/,
  );
  assert.throws(
    () =>
      validateSignedTagEvidence(
        ref,
        { ...tag, verification: { verified: false, reason: "unsigned" } },
        {
          expectedTag: `v${VERSION}`,
          expectedCommit: COMMIT,
        },
      ),
    /did not verify/,
  );
  assert.throws(
    () =>
      validateSignedTagEvidence(
        ref,
        { ...tag, object: { type: "commit", sha: "e".repeat(40) } },
        {
          expectedTag: `v${VERSION}`,
          expectedCommit: COMMIT,
        },
      ),
    /unexpected commit/,
  );
});
