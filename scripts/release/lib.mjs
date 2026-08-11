import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  appendFile,
  lstat,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT_SHA = /^[0-9a-f]{40,64}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const releaseDirectory = path.dirname(fileURLToPath(import.meta.url));
export const MANAGED_GUEST_POLICY = JSON.parse(
  readFileSync(path.join(releaseDirectory, "guest-images/policy.json"), "utf8"),
);
export const MANAGED_RUNTIME_POLICY = JSON.parse(
  readFileSync(
    path.join(releaseDirectory, "managed-runtime-policy.json"),
    "utf8",
  ),
);
export const MANAGED_HOST_PACKAGE_POLICY = JSON.parse(
  readFileSync(
    path.join(releaseDirectory, "managed-host-packages-policy.json"),
    "utf8",
  ),
);

// The trusted release build is the only consumer of sourceUrl. Managed hosts
// receive these retained artifacts through the signed release instead.
const MANAGED_HOST_INPUTS = Object.fromEntries(
  ["amd64", "arm64"].map((arch) => [
    arch,
    Object.fromEntries(
      ["firecracker", "kernel"].map((component) => {
        const input = MANAGED_RUNTIME_POLICY.architectures[arch][component];
        return [
          component,
          {
            version: input.version,
            artifact: input.artifact,
            format: input.format,
            maxBytes: input.maxBytes,
            sha256: input.sha256,
            ...(component === "firecracker"
              ? {
                  firecrackerSha256: input.firecrackerSha256,
                  jailerSha256: input.jailerSha256,
                }
              : {}),
          },
        ];
      }),
    ),
  ]),
);

export function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function validateManagedRuntimePolicy() {
  invariant(
    MANAGED_RUNTIME_POLICY?.contractVersion === 1 &&
      JSON.stringify(
        Object.keys(MANAGED_RUNTIME_POLICY.architectures).sort(),
      ) === JSON.stringify(["amd64", "arm64"]),
    "managed runtime policy has an unsupported contract",
  );
  for (const arch of ["amd64", "arm64"]) {
    const architecture = MANAGED_RUNTIME_POLICY.architectures[arch];
    invariant(
      JSON.stringify(Object.keys(architecture).sort()) ===
        JSON.stringify(["firecracker", "kernel"]),
      `managed ${arch} runtime policy is not exact`,
    );
    for (const component of ["firecracker", "kernel"]) {
      const input = architecture[component];
      invariant(
        input &&
          typeof input === "object" &&
          !Array.isArray(input) &&
          JSON.stringify(Object.keys(input).sort()) ===
            JSON.stringify(
              component === "firecracker"
                ? [
                    "artifact",
                    "firecrackerSha256",
                    "format",
                    "jailerSha256",
                    "maxBytes",
                    "sha256",
                    "sourceUrl",
                    "version",
                  ]
                : [
                    "artifact",
                    "format",
                    "maxBytes",
                    "sha256",
                    "sourceUrl",
                    "version",
                  ],
            ),
        `managed ${arch} ${component} runtime policy is not exact`,
      );
      invariant(
        typeof input.version === "string" &&
          /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.version),
        `invalid managed ${arch} ${component} version`,
      );
      validateSafeFileName(input.artifact);
      invariant(
        input.artifact ===
          `nehemiah-runtime-${component}_${input.version}_linux_${arch}.${component === "firecracker" ? "tgz" : "bin"}`,
        `invalid managed ${arch} ${component} artifact name`,
      );
      invariant(
        input.format === (component === "firecracker" ? "tgz" : "linux-kernel"),
        `invalid managed ${arch} ${component} format`,
      );
      invariant(
        Number.isSafeInteger(input.maxBytes) &&
          input.maxBytes > 0 &&
          input.maxBytes <= 64 * 1024 * 1024,
        `invalid managed ${arch} ${component} size bound`,
      );
      invariant(
        typeof input.sha256 === "string" && SHA256.test(input.sha256),
        `invalid managed ${arch} ${component} SHA-256`,
      );
      if (component === "firecracker") {
        invariant(
          SHA256.test(input.firecrackerSha256) &&
            SHA256.test(input.jailerSha256),
          `invalid managed ${arch} installed VMM SHA-256`,
        );
      }
      let parsed;
      try {
        parsed = new URL(input.sourceUrl);
      } catch {
        throw new Error(`invalid managed ${arch} ${component} source URL`);
      }
      invariant(
        parsed.protocol === "https:" &&
          !parsed.username &&
          !parsed.password &&
          !parsed.search &&
          !parsed.hash &&
          !input.sourceUrl.includes("/latest"),
        `unsafe or mutable managed ${arch} ${component} source URL`,
      );
    }
  }
}

export function validateVersion(version) {
  invariant(
    typeof version === "string" && SEMVER.test(version),
    `invalid semantic version: ${String(version)}`,
  );
  return version;
}

export function validateCommit(commit) {
  invariant(
    typeof commit === "string" && COMMIT_SHA.test(commit),
    `invalid commit SHA: ${String(commit)}`,
  );
  return commit;
}

export function validateRepository(repository) {
  invariant(
    typeof repository === "string" && REPOSITORY.test(repository),
    `invalid GitHub repository: ${String(repository)}`,
  );
  return repository;
}

export function validateSafeFileName(name) {
  invariant(
    typeof name === "string" && SAFE_FILE_NAME.test(name),
    `unsafe artifact filename: ${String(name)}`,
  );
  invariant(
    name !== "." && name !== ".." && path.basename(name) === name,
    `unsafe artifact filename: ${name}`,
  );
  return name;
}

export function resolveRepositoryOutputDirectory(
  repositoryRoot,
  requestedPath,
) {
  invariant(
    typeof requestedPath === "string" && requestedPath.length > 0,
    "--out is required",
  );
  validateSafeFileName(requestedPath);
  invariant(
    !requestedPath.startsWith("."),
    "--out must be a visible repository child directory",
  );
  invariant(
    !path.isAbsolute(requestedPath),
    "--out must be repository-relative",
  );
  const root = path.resolve(repositoryRoot);
  const resolved = path.resolve(root, requestedPath);
  invariant(
    path.dirname(resolved) === root,
    "--out must be a direct child of the repository root",
  );
  return resolved;
}

export function parseArguments(argv, allowed) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    invariant(
      option?.startsWith("--"),
      `expected an option, received: ${String(option)}`,
    );
    invariant(
      value !== undefined && !value.startsWith("--"),
      `missing value for ${option}`,
    );
    const name = option.slice(2);
    invariant(allowed.includes(name), `unknown option: ${option}`);
    invariant(result[name] === undefined, `duplicate option: ${option}`);
    result[name] = value;
  }
  return result;
}

export async function runCommand(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
    if (options.echoStdout && result.stdout)
      process.stdout.write(result.stdout);
    if (options.echoStderr && result.stderr)
      process.stderr.write(result.stderr);
    return result;
  } catch (error) {
    const details = [error?.stdout, error?.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(
      `${command} ${args.join(" ")} failed${details ? `:\n${details}` : ""}`,
      {
        cause: error,
      },
    );
  }
}

export async function assertRegularFile(filePath, label = filePath) {
  let stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} is missing`);
    throw error;
  }
  invariant(
    stats.isFile() && !stats.isSymbolicLink(),
    `${label} must be a regular, non-symlink file`,
  );
  return stats;
}

export async function sha256File(filePath) {
  await assertRegularFile(filePath);
  const bytes = await readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

export function parseChecksums(contents) {
  invariant(
    typeof contents === "string" && contents.length > 0,
    "SHA256SUMS is empty",
  );
  invariant(!contents.includes("\r"), "SHA256SUMS must use LF line endings");
  invariant(contents.endsWith("\n"), "SHA256SUMS must end with a newline");
  const lines = contents.slice(0, -1).split("\n");
  invariant(
    lines.length > 0 && lines.every(Boolean),
    "SHA256SUMS contains an empty line",
  );

  const checksums = new Map();
  for (const line of lines) {
    const match =
      /^([0-9a-f]{64}) ([ *])([A-Za-z0-9][A-Za-z0-9._+-]{0,254})$/.exec(line);
    invariant(match, `malformed SHA256SUMS entry: ${line}`);
    const [, digest, , name] = match;
    validateSafeFileName(name);
    invariant(
      name !== "SHA256SUMS",
      "SHA256SUMS must not contain a self-reference",
    );
    invariant(!checksums.has(name), `duplicate SHA256SUMS entry: ${name}`);
    checksums.set(name, digest);
  }
  return checksums;
}

export async function writeChecksums(directory, names) {
  const sortedNames = [...names].map(validateSafeFileName).sort();
  invariant(
    sortedNames.length > 0,
    "refusing to write an empty SHA256SUMS file",
  );
  invariant(
    new Set(sortedNames).size === sortedNames.length,
    "duplicate artifact passed to checksum writer",
  );
  const lines = [];
  for (const name of sortedNames) {
    lines.push(`${await sha256File(path.join(directory, name))}  ${name}`);
  }
  await writeFile(path.join(directory, "SHA256SUMS"), `${lines.join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
  return parseChecksums(`${lines.join("\n")}\n`);
}

function validateManagedHostPackagePolicy() {
  const policy = MANAGED_HOST_PACKAGE_POLICY;
  invariant(
    policy?.contractVersion === 1 &&
      JSON.stringify(Object.keys(policy).sort()) ===
        JSON.stringify([
          "architectures",
          "components",
          "contractVersion",
          "limits",
          "operatingSystem",
          "rootPackages",
          "snapshot",
        ]),
    "managed host package policy contract is not exact",
  );
  invariant(
    JSON.stringify(policy.operatingSystem) ===
      JSON.stringify({ id: "ubuntu", version: "24.04", codename: "noble" }) &&
      JSON.stringify(policy.architectures) ===
        JSON.stringify(["amd64", "arm64"]) &&
      JSON.stringify(policy.components) ===
        JSON.stringify(["main", "universe"]),
    "managed host package OS policy is invalid",
  );
  invariant(
    Array.isArray(policy.rootPackages) &&
      policy.rootPackages.length > 0 &&
      JSON.stringify(policy.rootPackages) ===
        JSON.stringify([...new Set(policy.rootPackages)].sort()) &&
      policy.rootPackages.every((name) => /^[a-z0-9][a-z0-9+.-]*$/.test(name)),
    "managed host root package set is invalid",
  );
  for (const required of [
    "apt",
    "bash",
    "ca-certificates",
    "curl",
    "dnsmasq",
    "e2fsprogs",
    "file",
    "iproute2",
    "ipset",
    "iptables",
    "jq",
    "kmod",
    "minisign",
    "openssl",
    "python3",
    "systemd",
    "wireguard-tools",
  ])
    invariant(
      policy.rootPackages.includes(required),
      `managed host root package set omits ${required}`,
    );
  invariant(
    /^https:\/\/snapshot\.ubuntu\.com\/ubuntu\/[0-9]{8}T[0-9]{6}Z$/.test(
      policy.snapshot.baseUrl,
    ) &&
      /^2026-08-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(
        policy.snapshot.capturedAt,
      ) &&
      Number.isSafeInteger(policy.snapshot.maxAgeHours) &&
      policy.snapshot.maxAgeHours > 0 &&
      policy.snapshot.maxAgeHours <= 168 &&
      JSON.stringify(Object.keys(policy.snapshot.suites).sort()) ===
        JSON.stringify(["noble", "noble-security", "noble-updates"]) &&
      Object.values(policy.snapshot.suites).every(
        (suite) =>
          JSON.stringify(Object.keys(suite)) ===
            JSON.stringify(["inReleaseSha256"]) &&
          SHA256.test(suite.inReleaseSha256),
      ),
    "managed host Ubuntu snapshot policy is not immutable",
  );
  invariant(
    Number.isSafeInteger(policy.limits.maxArchiveBytes) &&
      policy.limits.maxArchiveBytes > 0 &&
      policy.limits.maxArchiveBytes <= 512 * 1024 * 1024,
    "managed host package archive bound is invalid",
  );
}

export function canonicalRuntimeCohort({
  arch,
  pythonSha256,
  desktopSha256,
  kernelSha256,
  firecrackerSha256,
  jailerSha256,
}) {
  invariant(["amd64", "arm64"].includes(arch), "invalid runtime cohort arch");
  for (const [label, value] of Object.entries({
    python: pythonSha256,
    desktop: desktopSha256,
    kernel: kernelSha256,
    firecracker: firecrackerSha256,
    jailer: jailerSha256,
  }))
    invariant(
      typeof value === "string" && SHA256.test(value),
      `invalid runtime cohort ${label} digest`,
    );
  const canonical = [
    "contract_version=4",
    `arch=${arch}`,
    `python=${pythonSha256}`,
    `desktop=${desktopSha256}`,
    `kernel=${kernelSha256}`,
    `firecracker=${firecrackerSha256}`,
    `jailer=${jailerSha256}`,
    "",
  ].join("\n");
  return {
    contractVersion: 4,
    arch,
    pythonSha256,
    desktopSha256,
    kernelSha256,
    firecrackerSha256,
    jailerSha256,
    cohortId: createHash("sha256").update(canonical, "utf8").digest("hex"),
  };
}

function expectedArtifacts(version) {
  const artifacts = [];
  for (const component of ["nehemiahd", "bc-guest-agent", "bc-gateway"]) {
    for (const arch of ["amd64", "arm64"]) {
      artifacts.push({
        name: `${component}_${version}_linux_${arch}.tar.gz`,
        component,
        os: "linux",
        arch,
        format: "tar.gz",
      });
    }
  }
  for (const flavor of ["python", "desktop"]) {
    for (const arch of ["amd64", "arm64"]) {
      artifacts.push({
        name: `nehemiah-guest-${flavor}_${version}_linux_${arch}.ext4.gz`,
        component: `nehemiah-guest-${flavor}`,
        os: "linux",
        arch,
        format: "ext4.gz",
      });
    }
  }
  for (const arch of ["amd64", "arm64"]) {
    artifacts.push({
      name: `nehemiah-guest-scan_${version}_linux_${arch}.json`,
      component: "nehemiah-guest-scan",
      os: "linux",
      arch,
      format: "json",
    });
  }
  for (const arch of ["amd64", "arm64"]) {
    for (const component of ["firecracker", "kernel"]) {
      const input = MANAGED_RUNTIME_POLICY.architectures[arch][component];
      artifacts.push({
        name: input.artifact,
        component: `nehemiah-runtime-${component}`,
        os: "linux",
        arch,
        format: input.format,
      });
    }
    artifacts.push({
      name: `nehemiah-host-packages_${version}_ubuntu24.04_linux_${arch}.tar.gz`,
      component: "nehemiah-host-packages",
      os: "linux",
      arch,
      format: "tar.gz",
    });
  }
  artifacts.push({
    name: `nehemiah-host-bootstrap_${version}.tar.gz`,
    component: "nehemiah-host-bootstrap",
    os: "linux",
    arch: "any",
    format: "tar.gz",
  });
  artifacts.push({
    name: `nehemiah-cli-${version}.tgz`,
    component: "nehemiah-cli",
    os: "any",
    arch: "any",
    format: "npm",
  });
  artifacts.push({
    name: "nehemiah.rb",
    component: "homebrew-formula",
    os: "macos",
    arch: "any",
    format: "ruby",
  });
  return artifacts.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

function expectedGuestImages(version, rootfsDigests) {
  return Object.fromEntries(
    ["amd64", "arm64"].map((arch) => [
      arch,
      {
        scanEvidence: {
          artifact: `nehemiah-guest-scan_${version}_linux_${arch}.json`,
          format: "json",
          maxBytes: MANAGED_GUEST_POLICY.vulnerabilityScan.maxEvidenceBytes,
        },
        ...Object.fromEntries(
          ["python", "desktop"].map((flavor) => [
            flavor,
            {
              artifact: `nehemiah-guest-${flavor}_${version}_linux_${arch}.ext4.gz`,
              format: "ext4.gz",
              uncompressedBytes:
                MANAGED_GUEST_POLICY.flavors[flavor].imageBytes,
              uncompressedSha256: rootfsDigests[arch][flavor],
              maxCompressedBytes:
                MANAGED_GUEST_POLICY.flavors[flavor].maxCompressedBytes,
            },
          ]),
        ),
      },
    ]),
  );
}

export function createManifest({
  version,
  commit,
  sourceDateEpoch,
  repository,
  guestRootfsDigests,
  hostPackageManifests,
}) {
  validateVersion(version);
  validateCommit(commit);
  validateRepository(repository);
  validateManagedRuntimePolicy();
  validateManagedHostPackagePolicy();
  invariant(
    Number.isSafeInteger(sourceDateEpoch) && sourceDateEpoch > 0,
    "sourceDateEpoch must be a positive integer",
  );
  invariant(
    guestRootfsDigests && hostPackageManifests,
    "managed runtime evidence is required",
  );
  const runtimeCohorts = Object.fromEntries(
    ["amd64", "arm64"].map((arch) => {
      invariant(
        guestRootfsDigests[arch] &&
          SHA256.test(guestRootfsDigests[arch].python) &&
          SHA256.test(guestRootfsDigests[arch].desktop),
        `managed ${arch} guest rootfs digests are invalid`,
      );
      const runtime = MANAGED_RUNTIME_POLICY.architectures[arch];
      return [
        arch,
        canonicalRuntimeCohort({
          arch,
          pythonSha256: guestRootfsDigests[arch].python,
          desktopSha256: guestRootfsDigests[arch].desktop,
          kernelSha256: runtime.kernel.sha256,
          firecrackerSha256: runtime.firecracker.firecrackerSha256,
          jailerSha256: runtime.firecracker.jailerSha256,
        }),
      ];
    }),
  );
  const packageRepositories = Object.fromEntries(
    ["amd64", "arm64"].map((arch) => {
      const evidence = hostPackageManifests[arch];
      invariant(
        evidence &&
          evidence.contractVersion === 1 &&
          evidence.architecture === arch &&
          evidence.releaseVersion === version &&
          JSON.stringify(Object.keys(evidence.operatingSystem ?? {}).sort()) ===
            JSON.stringify(["codename", "id", "version"]) &&
          evidence.operatingSystem.id === "ubuntu" &&
          evidence.operatingSystem.version === "24.04" &&
          evidence.operatingSystem.codename === "noble" &&
          evidence.snapshot?.baseUrl ===
            MANAGED_HOST_PACKAGE_POLICY.snapshot.baseUrl &&
          evidence.snapshot?.capturedAt ===
            MANAGED_HOST_PACKAGE_POLICY.snapshot.capturedAt &&
          Number.isSafeInteger(evidence.packageCount) &&
          evidence.packageCount > 0 &&
          evidence.packageCount <=
            MANAGED_HOST_PACKAGE_POLICY.limits.maxPackageCount &&
          SHA256.test(evidence.manifestSha256),
        `managed ${arch} package repository evidence is invalid`,
      );
      return [
        arch,
        {
          contractVersion: 1,
          artifact: `nehemiah-host-packages_${version}_ubuntu24.04_linux_${arch}.tar.gz`,
          format: "tar.gz",
          maxBytes: MANAGED_HOST_PACKAGE_POLICY.limits.maxArchiveBytes,
          manifestSha256: evidence.manifestSha256,
          packageCount: evidence.packageCount,
          // The packager emits canonically sorted JSON, so rebuild the object
          // in the reviewed policy key order that the contract validator and
          // its JSON.stringify deep-equality checks expect.
          operatingSystem: {
            id: evidence.operatingSystem.id,
            version: evidence.operatingSystem.version,
            codename: evidence.operatingSystem.codename,
          },
          snapshot: {
            baseUrl: evidence.snapshot.baseUrl,
            capturedAt: evidence.snapshot.capturedAt,
          },
        },
      ];
    }),
  );
  return {
    schemaVersion: 5,
    managedCloudInitCompatible: true,
    managedHost: {
      contractVersion: 4,
      bootstrapArtifact: `nehemiah-host-bootstrap_${version}.tar.gz`,
      rootfsProfile: MANAGED_GUEST_POLICY.rootfsProfile,
      inputs: structuredClone(MANAGED_HOST_INPUTS),
      guestImagePolicy: structuredClone(MANAGED_GUEST_POLICY),
      guestImages: expectedGuestImages(version, guestRootfsDigests),
      packageRepositories,
      runtimeCohorts,
    },
    version,
    commit,
    sourceDateEpoch,
    repository,
    artifacts: expectedArtifacts(version),
  };
}

function validateManagedHostContract(contract, version) {
  validateManagedRuntimePolicy();
  validateManagedHostPackagePolicy();
  invariant(
    contract && typeof contract === "object" && !Array.isArray(contract),
    "managed host contract must be an object",
  );
  invariant(
    contract.contractVersion === 4,
    "unsupported managed host contractVersion",
  );
  invariant(
    contract.bootstrapArtifact === `nehemiah-host-bootstrap_${version}.tar.gz`,
    "managed host bootstrap artifact does not match the release version",
  );
  invariant(
    contract.rootfsProfile === "signed-developer-ext4-v1",
    "managed rootfs profile must use signed developer images",
  );
  invariant(
    JSON.stringify(contract.inputs) === JSON.stringify(MANAGED_HOST_INPUTS),
    "managed host inputs do not match the reviewed retained runtime pins",
  );
  for (const arch of ["amd64", "arm64"]) {
    const inputs = contract.inputs[arch];
    for (const component of ["firecracker", "kernel"]) {
      const input = inputs[component];
      invariant(
        typeof input.version === "string" &&
          /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.version),
        `invalid ${arch} ${component} version`,
      );
      invariant(
        typeof input.sha256 === "string" && SHA256.test(input.sha256),
        `invalid ${arch} ${component} SHA-256`,
      );
      validateSafeFileName(input.artifact);
      invariant(
        input.format ===
          (component === "firecracker" ? "tgz" : "linux-kernel") &&
          Number.isSafeInteger(input.maxBytes) &&
          input.maxBytes > 0 &&
          input.maxBytes <= 64 * 1024 * 1024,
        `invalid ${arch} ${component} retained artifact policy`,
      );
      invariant(
        input.sourceUrl === undefined && input.url === undefined,
        `managed ${arch} ${component} input must not expose an upstream URL`,
      );
    }
  }
  invariant(
    JSON.stringify(contract.guestImagePolicy) ===
      JSON.stringify(MANAGED_GUEST_POLICY),
    "managed guest image policy does not match the reviewed immutable policy",
  );
  invariant(
    contract.guestImages &&
      JSON.stringify(Object.keys(contract.guestImages).sort()) ===
        JSON.stringify(["amd64", "arm64"]),
    "managed guest image artifact contract is not exact",
  );
  for (const arch of ["amd64", "arm64"]) {
    const reference =
      contract.guestImagePolicy.architectures[arch].ociBase.reference;
    invariant(
      /^docker\.io\/library\/node@sha256:[0-9a-f]{64}$/.test(reference),
      `managed ${arch} Node base must be digest-pinned`,
    );
    const repositorySnapshot =
      contract.guestImagePolicy.alpineRepositorySnapshot.architectures[arch];
    const apkArchitecture = arch === "amd64" ? "x86_64" : "aarch64";
    invariant(
      repositorySnapshot.apkArchitecture === apkArchitecture,
      `managed ${arch} APK architecture is invalid`,
    );
    for (const repository of ["main", "community"]) {
      const index = repositorySnapshot[repository];
      invariant(
        index.url ===
          `https://dl-cdn.alpinelinux.org/alpine/v3.23/${repository}/${apkArchitecture}/APKINDEX.tar.gz` &&
          SHA256.test(index.sha256) &&
          /^2026-08-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(
            index.publishedAt,
          ),
        `managed ${arch} ${repository} APK index is not immutable`,
      );
    }
    for (const flavor of ["python", "desktop"]) {
      const image = contract.guestImages[arch][flavor];
      invariant(
        image && typeof image === "object" && !Array.isArray(image),
        "managed guest image artifact contract is not exact",
      );
      validateSafeFileName(image.artifact);
      invariant(
        JSON.stringify(Object.keys(image).sort()) ===
          JSON.stringify([
            "artifact",
            "format",
            "maxCompressedBytes",
            "uncompressedBytes",
            "uncompressedSha256",
          ]) &&
          image.artifact ===
            `nehemiah-guest-${flavor}_${version}_linux_${arch}.ext4.gz` &&
          image.format === "ext4.gz" &&
          image.uncompressedBytes ===
            MANAGED_GUEST_POLICY.flavors[flavor].imageBytes &&
          image.maxCompressedBytes ===
            MANAGED_GUEST_POLICY.flavors[flavor].maxCompressedBytes &&
          SHA256.test(image.uncompressedSha256),
        `invalid ${arch} ${flavor} image size policy`,
      );
    }
    const scanEvidence = contract.guestImages[arch].scanEvidence;
    validateSafeFileName(scanEvidence.artifact);
    invariant(
      scanEvidence.format === "json" && scanEvidence.maxBytes > 0,
      `invalid ${arch} guest scan evidence policy`,
    );
    const packages = contract.packageRepositories?.[arch];
    invariant(
      packages &&
        JSON.stringify(Object.keys(packages).sort()) ===
          JSON.stringify([
            "artifact",
            "contractVersion",
            "format",
            "manifestSha256",
            "maxBytes",
            "operatingSystem",
            "packageCount",
            "snapshot",
          ]) &&
        packages.contractVersion === 1 &&
        packages.artifact ===
          `nehemiah-host-packages_${version}_ubuntu24.04_linux_${arch}.tar.gz` &&
        packages.format === "tar.gz" &&
        packages.maxBytes ===
          MANAGED_HOST_PACKAGE_POLICY.limits.maxArchiveBytes &&
        SHA256.test(packages.manifestSha256) &&
        Number.isSafeInteger(packages.packageCount) &&
        packages.packageCount > 0 &&
        packages.packageCount <=
          MANAGED_HOST_PACKAGE_POLICY.limits.maxPackageCount &&
        JSON.stringify(packages.operatingSystem) ===
          JSON.stringify(MANAGED_HOST_PACKAGE_POLICY.operatingSystem) &&
        JSON.stringify(packages.snapshot) ===
          JSON.stringify({
            baseUrl: MANAGED_HOST_PACKAGE_POLICY.snapshot.baseUrl,
            capturedAt: MANAGED_HOST_PACKAGE_POLICY.snapshot.capturedAt,
          }),
      `managed ${arch} package repository contract is invalid`,
    );
    const expectedCohort = canonicalRuntimeCohort({
      arch,
      pythonSha256: contract.guestImages[arch].python.uncompressedSha256,
      desktopSha256: contract.guestImages[arch].desktop.uncompressedSha256,
      kernelSha256: MANAGED_RUNTIME_POLICY.architectures[arch].kernel.sha256,
      firecrackerSha256:
        MANAGED_RUNTIME_POLICY.architectures[arch].firecracker
          .firecrackerSha256,
      jailerSha256:
        MANAGED_RUNTIME_POLICY.architectures[arch].firecracker.jailerSha256,
    });
    invariant(
      JSON.stringify(contract.runtimeCohorts?.[arch]) ===
        JSON.stringify(expectedCohort),
      `managed ${arch} runtime cohort is invalid`,
    );
  }
  invariant(
    contract.guestImagePolicy.alpineRepositorySnapshot.maxIndexAgeHours > 0 &&
      contract.guestImagePolicy.alpineRepositorySnapshot.maxIndexAgeHours <=
        168,
    "managed APK index freshness window is invalid",
  );
  const npmRuntime = contract.guestImagePolicy.npmRuntime;
  invariant(
    npmRuntime.version === "11.19.0" &&
      npmRuntime.tarball.url ===
        "https://registry.npmjs.org/npm/-/npm-11.19.0.tgz" &&
      SHA256.test(npmRuntime.tarball.sha256),
    "managed npm runtime is not exact and digest-pinned",
  );
  invariant(
    JSON.stringify(
      npmRuntime.overlays.map(({ name, version }) => ({ name, version })),
    ) ===
      JSON.stringify([
        { name: "brace-expansion", version: "5.0.9" },
        { name: "ip-address", version: "10.3.1" },
      ]) &&
      npmRuntime.overlays.every(
        (overlay) =>
          overlay.url ===
            `https://registry.npmjs.org/${overlay.name}/-/${overlay.name}-${overlay.version}.tgz` &&
          SHA256.test(overlay.sha256),
      ),
    "managed npm security overlays are not exact and digest-pinned",
  );
  const pythonRuntime = contract.guestImagePolicy.pythonRuntime;
  for (const [name, version] of [
    ["pip", "26.2.1"],
    ["setuptools", "84.0.0"],
  ]) {
    const wheel = pythonRuntime[name];
    invariant(
      wheel.version === version &&
        wheel.url.startsWith("https://files.pythonhosted.org/packages/") &&
        wheel.url.endsWith(`/${name}-${version}-py3-none-any.whl`) &&
        SHA256.test(wheel.sha256),
      `managed Python ${name} wheel is not exact and digest-pinned`,
    );
  }
  invariant(
    JSON.stringify(
      pythonRuntime.pipVendorOverlays.map(({ name, version, format }) => ({
        name,
        version,
        format,
      })),
    ) ===
      JSON.stringify([
        { name: "msgpack", version: "1.2.1", format: "sdist" },
        { name: "setuptools", version: "80.9.0", format: "wheel" },
      ]) &&
      pythonRuntime.pipVendorOverlays.every(
        (overlay) =>
          overlay.url.startsWith("https://files.pythonhosted.org/packages/") &&
          SHA256.test(overlay.sha256),
      ),
    "managed pip vendor security overlays are not exact and digest-pinned",
  );
}

export function validateManifest(manifest) {
  invariant(
    manifest && typeof manifest === "object" && !Array.isArray(manifest),
    "release manifest must be an object",
  );
  invariant(
    manifest.schemaVersion === 5,
    "unsupported release manifest schemaVersion",
  );
  invariant(
    manifest.managedCloudInitCompatible === true,
    "release manifest must declare the managed cloud-init contract",
  );
  validateManagedHostContract(manifest.managedHost, manifest.version);
  validateVersion(manifest.version);
  validateCommit(manifest.commit);
  validateRepository(manifest.repository);
  invariant(
    Number.isSafeInteger(manifest.sourceDateEpoch) &&
      manifest.sourceDateEpoch > 0,
    "invalid manifest sourceDateEpoch",
  );
  invariant(
    Array.isArray(manifest.artifacts),
    "manifest artifacts must be an array",
  );

  const actual = manifest.artifacts.map((artifact) => {
    invariant(
      artifact && typeof artifact === "object" && !Array.isArray(artifact),
      "invalid manifest artifact",
    );
    validateSafeFileName(artifact.name);
    return {
      name: artifact.name,
      component: artifact.component,
      os: artifact.os,
      arch: artifact.arch,
      format: artifact.format,
    };
  });
  const expected = expectedArtifacts(manifest.version);
  invariant(
    JSON.stringify(actual) === JSON.stringify(expected),
    "manifest does not contain the exact release artifact matrix",
  );
  return manifest;
}

export async function writeManifest(directory, manifest) {
  validateManifest(manifest);
  await writeFile(
    path.join(directory, "release-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o644,
    },
  );
}

export async function verifyReleaseDirectory(
  directory,
  { allowedUnchecksummedFiles = [] } = {},
) {
  invariant(
    Array.isArray(allowedUnchecksummedFiles),
    "allowedUnchecksummedFiles must be an array",
  );
  const allowedExtras = new Set();
  for (const name of allowedUnchecksummedFiles) {
    validateSafeFileName(name);
    invariant(name !== "SHA256SUMS", "SHA256SUMS cannot be an allowed extra");
    invariant(
      !allowedExtras.has(name),
      `duplicate allowed extra file: ${name}`,
    );
    allowedExtras.add(name);
  }

  const checksumPath = path.join(directory, "SHA256SUMS");
  await assertRegularFile(checksumPath, "SHA256SUMS");
  const checksums = parseChecksums(await readFile(checksumPath, "utf8"));
  invariant(
    checksums.has("release-manifest.json"),
    "release-manifest.json is not covered by SHA256SUMS",
  );

  const manifestPath = path.join(directory, "release-manifest.json");
  await assertRegularFile(manifestPath, "release-manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error("release-manifest.json is not valid JSON", {
      cause: error,
    });
  }
  validateManifest(manifest);

  const expectedNames = [
    ...manifest.artifacts.map(({ name }) => name),
    "release-manifest.json",
  ].sort();
  const checksumNames = [...checksums.keys()].sort();
  invariant(
    JSON.stringify(checksumNames) === JSON.stringify(expectedNames),
    "SHA256SUMS does not contain the exact manifest artifact set",
  );

  for (const name of allowedExtras) {
    invariant(
      !checksums.has(name),
      `${name} is both checksummed and allowlisted`,
    );
  }
  const expectedDirectoryNames = [
    "SHA256SUMS",
    ...checksumNames,
    ...allowedExtras,
  ].sort();
  const entries = await readdir(directory, { withFileTypes: true });
  const actualDirectoryNames = entries.map(({ name }) => name).sort();
  invariant(
    JSON.stringify(actualDirectoryNames) ===
      JSON.stringify(expectedDirectoryNames),
    "release directory contains an unexpected physical artifact set",
  );

  for (const [name, expectedDigest] of checksums) {
    const artifactPath = path.join(directory, name);
    await assertRegularFile(artifactPath, name);
    const actualDigest = await sha256File(artifactPath);
    invariant(actualDigest === expectedDigest, `checksum mismatch for ${name}`);
  }
  for (const name of allowedExtras) {
    await assertRegularFile(path.join(directory, name), name);
  }
  return { manifest, checksums };
}

export function renderFormula(template, { version, repository, sha256 }) {
  validateVersion(version);
  validateRepository(repository);
  invariant(
    typeof sha256 === "string" && SHA256.test(sha256),
    "invalid CLI SHA-256 for Homebrew formula",
  );
  let rendered = template;
  for (const [token, value] of Object.entries({
    VERSION: version,
    REPOSITORY: repository,
    SHA256: sha256,
  })) {
    rendered = rendered.replaceAll(`@@${token}@@`, value);
  }
  invariant(
    !/@@[A-Z0-9_]+@@/.test(rendered),
    "unresolved Homebrew formula template token",
  );
  return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
}

export function resolveReleaseVersion({
  eventName,
  refName,
  inputVersion,
  cliVersion,
  sdkVersion,
}) {
  validateVersion(cliVersion);
  validateVersion(sdkVersion);
  invariant(
    cliVersion === sdkVersion,
    `CLI version ${cliVersion} does not match SDK version ${sdkVersion}`,
  );

  if (eventName === "push") {
    invariant(
      typeof refName === "string" && refName.startsWith("v"),
      "release pushes must use a v-prefixed tag",
    );
    const tagVersion = validateVersion(refName.slice(1));
    invariant(
      tagVersion === cliVersion,
      `tag version ${tagVersion} does not match package version ${cliVersion}`,
    );
    return tagVersion;
  }
  if (eventName === "workflow_dispatch") {
    const requestedVersion = validateVersion(inputVersion);
    invariant(
      requestedVersion === cliVersion,
      `requested version ${requestedVersion} does not match package version ${cliVersion}`,
    );
    return requestedVersion;
  }
  if (eventName === "pull_request") return cliVersion;
  throw new Error(`unsupported release event: ${String(eventName)}`);
}

export async function writeGitHubOutput(filePath, values) {
  invariant(filePath, "GITHUB_OUTPUT is not set");
  for (const [name, value] of Object.entries(values)) {
    invariant(
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(name),
      `invalid GitHub output name: ${name}`,
    );
    invariant(
      !String(value).includes("\n"),
      `GitHub output ${name} must be single-line`,
    );
    await appendFile(filePath, `${name}=${value}\n`, "utf8");
  }
}

export function validateSignedTagEvidence(
  ref,
  tag,
  { expectedTag, expectedCommit },
) {
  validateCommit(expectedCommit);
  invariant(
    typeof expectedTag === "string" &&
      expectedTag.startsWith("v") &&
      validateVersion(expectedTag.slice(1)),
    "release tag must contain a valid v-prefixed semantic version",
  );
  invariant(
    ref?.ref === `refs/tags/${expectedTag}`,
    "GitHub tag reference does not match the release tag",
  );
  invariant(
    ref?.object?.type === "tag",
    "release tag must be annotated, not lightweight",
  );
  invariant(
    typeof ref.object.sha === "string",
    "GitHub tag reference is missing its tag object SHA",
  );
  invariant(
    tag?.sha === ref.object.sha,
    "annotated tag object does not match the GitHub tag reference",
  );
  invariant(
    tag?.tag === expectedTag,
    "annotated tag name does not match the release tag",
  );
  invariant(
    tag?.object?.type === "commit",
    "annotated release tag must point directly to a commit",
  );
  invariant(
    tag?.object?.sha === expectedCommit,
    "annotated release tag points to an unexpected commit",
  );
  invariant(
    tag?.verification?.verified === true,
    "GitHub did not verify the annotated tag signature",
  );
  invariant(
    tag?.verification?.reason === "valid",
    `GitHub tag signature reason is ${String(tag?.verification?.reason)}`,
  );
  return true;
}

export async function assertDirectoryEmpty(directory) {
  let stats;
  try {
    stats = await lstat(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  invariant(
    stats.isDirectory() && !stats.isSymbolicLink(),
    `${directory} must be a real directory`,
  );
  invariant(
    (await readdir(directory)).length === 0,
    `${directory} must be empty`,
  );
  return true;
}
