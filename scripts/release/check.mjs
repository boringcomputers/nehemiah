#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateReleaseWorkflowPolicy } from "./ci-policy.mjs";
import { invariant, validateVersion } from "./lib.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const workflow = await readFile(
  path.join(repositoryRoot, ".github/workflows/release.yml"),
  "utf8",
);
const ciWorkflow = await readFile(
  path.join(repositoryRoot, ".github/workflows/ci.yml"),
  "utf8",
);
const ciAuthorization = await readFile(
  path.join(repositoryRoot, "scripts/release/authorize-ci.sh"),
  "utf8",
);
const ciAuthorizationStat = await stat(
  path.join(repositoryRoot, "scripts/release/authorize-ci.sh"),
);
const formulaTemplate = await readFile(
  path.join(repositoryRoot, "scripts/release/templates/nehemiah.rb.tpl"),
  "utf8",
);
const buildScript = await readFile(
  path.join(repositoryRoot, "scripts/release/build.mjs"),
  "utf8",
);
const distributionDocumentation = await readFile(
  path.join(repositoryRoot, "docs/nehemiah/distribution.md"),
  "utf8",
);
const cloudInit = await readFile(
  path.join(repositoryRoot, "infra/latitude/cloud-init.sh"),
  "utf8",
);
const bootstrap = await readFile(
  path.join(repositoryRoot, "infra/latitude/bootstrap.sh"),
  "utf8",
);
const rootfsBuilder = await readFile(
  path.join(repositoryRoot, "infra/latitude/build-rootfs.sh"),
  "utf8",
);
const guestPolicy = await readFile(
  path.join(repositoryRoot, "scripts/release/guest-images/policy.json"),
  "utf8",
);
const managedRuntimePolicyContents = await readFile(
  path.join(repositoryRoot, "scripts/release/managed-runtime-policy.json"),
  "utf8",
);
const managedRuntimeFetcher = await readFile(
  path.join(repositoryRoot, "scripts/release/fetch-managed-runtime-assets.sh"),
  "utf8",
);
const managedRuntimeInspector = await readFile(
  path.join(
    repositoryRoot,
    "scripts/release/inspect-managed-runtime-assets.sh",
  ),
  "utf8",
);
const managedHostPackagePolicyContents = await readFile(
  path.join(
    repositoryRoot,
    "scripts/release/managed-host-packages-policy.json",
  ),
  "utf8",
);
const managedHostPackageBuilder = await readFile(
  path.join(repositoryRoot, "scripts/release/managed_host_packages.py"),
  "utf8",
);
const managedHostPackageInstaller = await readFile(
  path.join(repositoryRoot, "infra/latitude/managed-host-packages.py"),
  "utf8",
);
const managedReleaseValidator = await readFile(
  path.join(repositoryRoot, "infra/latitude/validate-managed-release.py"),
  "utf8",
);
const managedWireGuardValidator = await readFile(
  path.join(repositoryRoot, "infra/latitude/wireguard-config.py"),
  "utf8",
);
const managedNetworkSetup = await readFile(
  path.join(repositoryRoot, "infra/latitude/net-setup.sh"),
  "utf8",
);
const managedHostPreflight = await readFile(
  path.join(repositoryRoot, "infra/latitude/managed-host-preflight.sh"),
  "utf8",
);
const guestImageBuilder = await readFile(
  path.join(repositoryRoot, "scripts/release/build-guest-images.sh"),
  "utf8",
);
const guestImageDockerfile = await readFile(
  path.join(repositoryRoot, "scripts/release/guest-images/Dockerfile"),
  "utf8",
);
const pythonRuntimeOverlay = await readFile(
  path.join(
    repositoryRoot,
    "scripts/release/guest-images/apply-python-runtime-overlays.py",
  ),
  "utf8",
);
const guestScanner = await readFile(
  path.join(
    repositoryRoot,
    "scripts/release/guest-images/prepare-vulnerability-scanner.sh",
  ),
  "utf8",
);
const guestScanGate = await readFile(
  path.join(
    repositoryRoot,
    "scripts/release/guest-images/scan-final-rootfs.sh",
  ),
  "utf8",
);
const userDataRenderer = await readFile(
  path.join(repositoryRoot, "infra/latitude/render-user-data.sh"),
  "utf8",
);
const latitudeProvisioner = await readFile(
  path.join(repositoryRoot, "infra/latitude/provision.sh"),
  "utf8",
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

function requireText(haystack, needle, label = needle) {
  invariant(haystack.includes(needle), `release check is missing ${label}`);
}

function requireBefore(haystack, first, second) {
  const firstIndex = haystack.indexOf(first);
  const secondIndex = haystack.indexOf(second);
  invariant(
    firstIndex >= 0 && secondIndex >= 0 && firstIndex < secondIndex,
    `${first} must appear before ${second}`,
  );
}

invariant(
  !workflow.includes("pull_request_target"),
  "release workflow must not use pull_request_target",
);
validateReleaseWorkflowPolicy(workflow, ciWorkflow, ciAuthorization);
invariant(
  ciAuthorizationStat.isFile() && (ciAuthorizationStat.mode & 0o111) !== 0,
  "release CI authorization script must be executable",
);
invariant(
  !/\bnpm\s+publish\b/.test(workflow),
  "release workflow must not publish to npm",
);
invariant(
  !/\bbrew\s+(tap|create|install)\b/.test(workflow),
  "release workflow must not mutate a Homebrew tap",
);
requireText(
  workflow,
  "permissions:\n  contents: read",
  "default read-only permissions",
);
requireText(workflow, "ubuntu-24.04-arm", "native arm64 guest image runner");
requireText(
  workflow,
  "scripts/release/build-guest-images.sh",
  "production guest image build",
);
requireText(
  workflow,
  "scripts/release/fetch-managed-runtime-assets.sh managed-runtime-assets",
  "trusted retained runtime fetch",
);
invariant(
  workflow.match(/--runtime-assets managed-runtime-assets/g)?.length === 2,
  "both deterministic release builds must use the retained runtime directory",
);
requireText(
  workflow,
  "scripts/release/build-managed-host-packages.sh",
  "production managed-host package build",
);
requireText(
  workflow,
  "scripts/release/inspect-managed-host-packages.sh",
  "offline managed-host package inspection",
);
invariant(
  workflow.match(/--host-packages host-packages/g)?.length === 2,
  "both deterministic release builds must use retained host packages",
);
requireText(
  workflow,
  'cmp --silent "host-packages/$artifact" "host-packages-repeat/$artifact"',
  "two-pass managed-host package comparison",
);
requireText(
  workflow,
  "diff --recursive --no-dereference release-dist release-dist-repeat",
  "two-pass deterministic release comparison",
);
requireText(workflow, "workflow_dispatch:", "manual build trigger");
requireText(
  workflow,
  "github.event_name == 'push'",
  "tag-only publish condition",
);
requireText(
  workflow,
  "scripts/release/verify-tag.mjs",
  "signed annotated tag verification",
);
requireText(
  workflow,
  "repos/${GITHUB_REPOSITORY}/immutable-releases",
  "immutable-release preflight",
);
requireText(workflow, "actions/attest@", "artifact provenance attestation");
requireText(
  workflow,
  "subject-checksums: release-dist/SHA256SUMS",
  "per-artifact checksum attestation",
);
requireText(workflow, "gh attestation verify", "provenance verification");
requireText(
  workflow,
  "gh release verify",
  "signed immutable release verification",
);
requireBefore(
  workflow,
  "scripts/release/verify-tag.mjs",
  "node scripts/release/build.mjs",
);
requireBefore(workflow, "node scripts/release/verify.mjs", "gh release create");
requireBefore(
  workflow,
  "Sign checksum metadata for managed hosts",
  "gh release create",
);
requireText(
  workflow,
  "NEHEMIAH_RELEASE_MINISIGN_SECRET_KEY_B64",
  "protected Minisign signing key",
);
requireText(
  workflow,
  "NEHEMIAH_RELEASE_MINISIGN_PUBLIC_KEY",
  "reviewed Minisign public key",
);
requireText(
  workflow,
  "854c5f9dddaa99a02915f8cacd41e03442cb6cda25f7bbc53c0a3d297bcd064f",
  "pinned Minisign package digest",
);
requireText(workflow, "SHA256SUMS.minisig", "managed-host checksum signature");
requireText(buildScript, '"--offline"', "offline CLI installation smoke test");
requireText(
  buildScript,
  '"--packages=bundle"',
  "self-contained CLI dependency bundle",
);
requireText(
  buildScript,
  "must vendor exactly the bundled keyring dependency",
  "vendored-only release package dependency assertion",
);
requireText(
  buildScript,
  "vendored keyring tarball digest mismatch",
  "digest-pinned vendored keyring downloads",
);
requireText(
  buildScript,
  "resolveRepositoryOutputDirectory",
  "release output path containment",
);
requireText(
  distributionDocumentation,
  "Managed-host bootstrap contract",
  "managed cloud-init distribution contract",
);
requireText(
  buildScript,
  "buildManagedHostBootstrapArtifact",
  "deterministic managed-host bootstrap artifact",
);
requireText(
  buildScript,
  "stageManagedRuntimeArtifacts",
  "retained managed runtime staging",
);
requireText(
  buildScript,
  "stageManagedHostPackageArtifacts",
  "retained managed-host package staging",
);
requireText(
  buildScript,
  "inspect-managed-runtime-assets.sh",
  "retained runtime type inspection",
);
requireText(cloudInit, "minisign -Vm", "fail-closed Minisign verification");
requireText(
  managedReleaseValidator,
  '"DAEMON_ARTIFACT": f"nehemiahd_{version}_linux_{arch}.tar.gz"',
  "versioned daemon artifact",
);
requireText(
  managedReleaseValidator,
  '"HOST_ARTIFACT": host["bootstrapArtifact"]',
  "versioned host bootstrap artifact",
);
requireText(
  managedReleaseValidator,
  'host["inputs"][candidate] != RUNTIME[candidate]',
  "signed managed-host input pins",
);
requireText(
  cloudInit,
  "install_guest_image python /opt/boring/rootfs/rootfs.ext4",
  "signed python image install",
);
requireText(
  cloudInit,
  "install_guest_image desktop /opt/boring/rootfs/desktop.ext4",
  "signed desktop image install",
);
requireText(cloudInit, "gzip --test", "compressed image validation");
requireText(cloudInit, "e2fsck -fn", "guest filesystem validation");
requireText(
  bootstrap,
  "NEHEMIAH_FIRECRACKER_ARCHIVE",
  "local signed-release Firecracker input",
);
requireText(
  bootstrap,
  "NEHEMIAH_KERNEL_IMAGE",
  "local signed-release kernel input",
);
requireText(
  cloudInit,
  'fetch_release_artifact "$FIRECRACKER_ARTIFACT"',
  "release-only Firecracker fetch",
);
requireText(
  cloudInit,
  'fetch_release_artifact "$KERNEL_ARTIFACT"',
  "release-only kernel fetch",
);
invariant(
  !bootstrap.includes("download_verified") &&
    !bootstrap.includes("NEHEMIAH_FIRECRACKER_URL") &&
    !bootstrap.includes("NEHEMIAH_KERNEL_URL") &&
    !bootstrap.includes("curl --fail"),
  "managed bootstrap must not fetch runtime inputs from upstream",
);
requireText(
  rootfsBuilder,
  "managed rootfs builds are forbidden",
  "local-only mutable rootfs guard",
);
invariant(
  !bootstrap.includes("MINIROOTFS") && !bootstrap.includes("build-rootfs.sh"),
  "managed bootstrap must not build a guest rootfs",
);
invariant(
  !cloudInit.includes("MINIROOTFS") && !cloudInit.includes("build-rootfs.sh"),
  "managed cloud-init must not fall back to a minimal guest build",
);
const parsedGuestPolicy = JSON.parse(guestPolicy);
const parsedManagedRuntimePolicy = JSON.parse(managedRuntimePolicyContents);
const parsedManagedHostPackagePolicy = JSON.parse(
  managedHostPackagePolicyContents,
);
invariant(
  parsedManagedRuntimePolicy.contractVersion === 1 &&
    JSON.stringify(
      Object.keys(parsedManagedRuntimePolicy.architectures).sort(),
    ) === JSON.stringify(["amd64", "arm64"]),
  "managed runtime policy contract is not exact",
);
const expectedRuntimePins = {
  amd64: {
    firecracker: {
      version: "1.15.1",
      artifact: "nehemiah-runtime-firecracker_1.15.1_linux_amd64.tgz",
      sha256:
        "d4a32ab2322d887ca1bc4a4e7afa9cc35393e6362dfc2b3becb389d362e4275a",
      firecrackerSha256:
        "7e8b57e88c459396d4680d83dcdd8c7f72305447cb55b11f4ac98ad70a3f7825",
      jailerSha256:
        "4830a9b1fc6cece036d8992ff12f1fe9c5247aacad77f42c7aba683c7a08622e",
    },
    kernel: {
      version: "6.1.155",
      artifact: "nehemiah-runtime-kernel_6.1.155_linux_amd64.bin",
      sha256:
        "e20e46d0c36c55c0d1014eb20576171b3f3d922260d9f792017aeff53af3d4f2",
    },
  },
  arm64: {
    firecracker: {
      version: "1.15.1",
      artifact: "nehemiah-runtime-firecracker_1.15.1_linux_arm64.tgz",
      sha256:
        "00654ac1e702a22744121ea9f10a4f792ebd7c3a744cba587dfac9fcb79b41a5",
      firecrackerSha256:
        "e9ce7466c3b0d879d7a9158f4bf710dd5e131bbc5e580e5269fec66d5b5a0f0a",
      jailerSha256:
        "7faa581395fd1994ee005efc0a9c8826b4a9f0616dd942c2486adb8a8eac13f0",
    },
    kernel: {
      version: "6.1.155",
      artifact: "nehemiah-runtime-kernel_6.1.155_linux_arm64.bin",
      sha256:
        "e3544b10603acbf3db492cb52e000d22ba202cb4b63b9add027565683e11c591",
    },
  },
};
for (const arch of ["amd64", "arm64"]) {
  for (const component of ["firecracker", "kernel"]) {
    const runtime = parsedManagedRuntimePolicy.architectures[arch][component];
    const expected = expectedRuntimePins[arch][component];
    invariant(
      runtime.version === expected.version &&
        runtime.artifact === expected.artifact &&
        runtime.sha256 === expected.sha256 &&
        (component !== "firecracker" ||
          (runtime.firecrackerSha256 === expected.firecrackerSha256 &&
            runtime.jailerSha256 === expected.jailerSha256)) &&
        runtime.format ===
          (component === "firecracker" ? "tgz" : "linux-kernel") &&
        Number.isSafeInteger(runtime.maxBytes) &&
        runtime.maxBytes > 0 &&
        runtime.maxBytes <= 64 * 1024 * 1024 &&
        /^https:\/\//.test(runtime.sourceUrl) &&
        !/[?#]/.test(runtime.sourceUrl) &&
        !runtime.sourceUrl.includes("/latest"),
      `${arch} ${component} runtime input must be exact and digest-pinned`,
    );
  }
}
requireText(
  managedRuntimeFetcher,
  "curl --fail --silent --show-error --location --proto '=https'",
  "TLS-only managed runtime fetch",
);
requireText(
  managedRuntimeFetcher,
  '"$script_dir/inspect-managed-runtime-assets.sh"',
  "post-download runtime inspection",
);
requireText(
  managedRuntimeInspector,
  "exact artifact set",
  "retained runtime exact-set rejection",
);
requireText(
  managedRuntimeInspector,
  "wrong-architecture binary",
  "retained runtime architecture rejection",
);
invariant(
  parsedManagedHostPackagePolicy.contractVersion === 1 &&
    JSON.stringify(parsedManagedHostPackagePolicy.architectures) ===
      JSON.stringify(["amd64", "arm64"]) &&
    parsedManagedHostPackagePolicy.operatingSystem?.id === "ubuntu" &&
    parsedManagedHostPackagePolicy.operatingSystem?.version === "24.04" &&
    parsedManagedHostPackagePolicy.snapshot?.baseUrl ===
      "https://snapshot.ubuntu.com/ubuntu/20260809T000000Z" &&
    parsedManagedHostPackagePolicy.snapshot?.capturedAt ===
      "2026-08-09T00:00:00Z" &&
    parsedManagedHostPackagePolicy.snapshot?.maxAgeHours <= 168,
  "managed-host package snapshot policy is not exact and fresh",
);
for (const suite of ["noble", "noble-security", "noble-updates"]) {
  invariant(
    /^[0-9a-f]{64}$/.test(
      parsedManagedHostPackagePolicy.snapshot?.suites?.[suite]?.inReleaseSha256,
    ),
    `${suite} package repository metadata must be digest-pinned`,
  );
}
for (const runtimePackage of [
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
]) {
  invariant(
    parsedManagedHostPackagePolicy.rootPackages.includes(runtimePackage),
    `managed-host package policy omits ${runtimePackage}`,
  );
}
requireText(
  managedHostPackageBuilder,
  "production package repositories require a native",
  "native package architecture guard",
);
requireText(
  managedHostPackageBuilder,
  "APT selected a package outside the retained repository",
  "empty-host exact closure resolution",
);
requireText(
  managedHostPackageInstaller,
  '"--no-download"',
  "network-free local APT install",
);
requireText(
  managedHostPackageInstaller,
  "installed package file drift detected",
  "installed package drift gate",
);
for (const [label, contents] of [
  ["cloud-init", cloudInit],
  ["managed bootstrap", bootstrap],
  ["managed network setup", managedNetworkSetup],
]) {
  invariant(
    !/\b(?:apt|apt-get|aptitude)\s+(?:install|update|upgrade|full-upgrade|dist-upgrade)\b/.test(
      contents,
    ),
    `${label} must not mutate a network package repository`,
  );
}
for (const arch of ["amd64", "arm64"]) {
  const runtime = parsedGuestPolicy.architectures[arch].ociBase;
  invariant(
    runtime.nodeVersion === "24.19.0",
    `${arch} Node 24 LTS pin is stale`,
  );
  invariant(
    /^docker\.io\/library\/node@sha256:[0-9a-f]{64}$/.test(runtime.reference),
    `${arch} Node OCI base must be digest-pinned`,
  );
  const apk = parsedGuestPolicy.alpineRepositorySnapshot.architectures[arch];
  const apkArch = arch === "amd64" ? "x86_64" : "aarch64";
  invariant(
    apk.apkArchitecture === apkArch,
    `${arch} APK architecture mismatch`,
  );
  for (const repository of ["main", "community"]) {
    invariant(
      apk[repository].url ===
        `https://dl-cdn.alpinelinux.org/alpine/v3.23/${repository}/${apkArch}/APKINDEX.tar.gz` &&
        /^[0-9a-f]{64}$/.test(apk[repository].sha256),
      `${arch} ${repository} APK index must be digest-pinned`,
    );
  }
}
invariant(
  parsedGuestPolicy.alpineRepositorySnapshot.release === "v3.23" &&
    parsedGuestPolicy.alpineRepositorySnapshot.capturedAt ===
      "2026-08-11T05:45:11Z" &&
    parsedGuestPolicy.alpineRepositorySnapshot.maxIndexAgeHours === 168,
  "guest APK indexes must match the reviewed security refresh",
);
invariant(
  parsedGuestPolicy.npmRuntime.version === "11.19.0" &&
    /^[0-9a-f]{64}$/.test(parsedGuestPolicy.npmRuntime.tarball.sha256) &&
    parsedGuestPolicy.npmRuntime.overlays.every((entry) =>
      /^[0-9a-f]{64}$/.test(entry.sha256),
    ),
  "guest npm runtime and security overlays must be digest-pinned",
);
invariant(
  parsedGuestPolicy.pythonRuntime.pip.version === "26.2.1" &&
    parsedGuestPolicy.pythonRuntime.setuptools.version === "84.0.0" &&
    [
      parsedGuestPolicy.pythonRuntime.pip,
      parsedGuestPolicy.pythonRuntime.setuptools,
    ].every(
      (entry) =>
        entry.url.startsWith("https://files.pythonhosted.org/packages/") &&
        /^[0-9a-f]{64}$/.test(entry.sha256),
    ) &&
    JSON.stringify(
      parsedGuestPolicy.pythonRuntime.pipVendorOverlays.map(
        ({ name, version, format }) => ({ name, version, format }),
      ),
    ) ===
      JSON.stringify([
        { name: "msgpack", version: "1.2.1", format: "sdist" },
        { name: "setuptools", version: "80.9.0", format: "wheel" },
      ]) &&
    parsedGuestPolicy.pythonRuntime.pipVendorOverlays.every(
      (entry) =>
        entry.url.startsWith("https://files.pythonhosted.org/packages/") &&
        /^[0-9a-f]{64}$/.test(entry.sha256),
    ),
  "guest Python packaging runtime must be current and digest-pinned",
);
invariant(
  parsedGuestPolicy.vulnerabilityScan.version === "0.72.0" &&
    parsedGuestPolicy.vulnerabilityScan.maxDatabaseAgeHours <= 24,
  "guest vulnerability scanner must be pinned with a fresh DB policy",
);
for (const scanner of Object.values(
  parsedGuestPolicy.vulnerabilityScan.artifacts,
)) {
  invariant(
    scanner.url.startsWith(
      "https://github.com/aquasecurity/trivy/releases/download/v0.72.0/",
    ) && /^[0-9a-f]{64}$/.test(scanner.sha256),
    "Trivy binary must use exact HTTPS and SHA-256",
  );
}
requireText(
  guestImageBuilder,
  "production guest images require a native",
  "native architecture guard",
);
requireText(
  guestImageBuilder,
  "first_sha",
  "deterministic guest image comparison",
);
requireText(
  guestImageDockerfile,
  'test "$actual_indexes" = "$expected_indexes"',
  "APK index digest enforcement before package resolution",
);
for (const securityOverlay of ["brace-expansion", "ip-address"]) {
  requireText(
    guestImageDockerfile,
    `node_modules/${securityOverlay}`,
    `pinned npm ${securityOverlay} security overlay`,
  );
}
requireText(
  guestImageDockerfile,
  "apply-python-runtime-overlays.py",
  "digest-pinned pip vendor security overlays",
);
requireText(
  pythonRuntimeOverlay,
  "update_vendor_sbom",
  "pip CycloneDX inventory security overlay",
);
requireText(guestScanner, "databaseSha256", "recorded scanner database digest");
requireText(
  guestScanner,
  "max_age_hours * 3600",
  "scanner DB freshness rejection",
);
requireText(
  guestScanGate,
  "--offline-scan",
  "network-free final filesystem scan",
);
requireText(
  guestScanGate,
  "bc-guest-agent",
  "injected guest-agent scan assertion",
);
requireText(
  userDataRenderer,
  "output already exists; refusing to overwrite it",
  "private no-overwrite user-data rendering",
);
for (const key of [
  "NEHEMIAH_OTEL_ENABLED",
  "NEHEMIAH_OTEL_ENDPOINT",
  "NEHEMIAH_OTEL_AUTHORIZATION",
  "NEHEMIAH_SERVICE_VERSION",
  "NEHEMIAH_INSTANCE_ID",
  "NEHEMIAH_DEPLOYMENT_ENVIRONMENT",
  "NEHEMIAH_OTEL_EXPORT_INTERVAL_MS",
  "NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS",
  "NEHEMIAH_OTEL_TRACE_SAMPLE_RATIO",
]) {
  requireText(userDataRenderer, key, `required managed telemetry input ${key}`);
  requireText(
    cloudInit,
    `: "\${${key}:?required}"`,
    `cloud-init telemetry requirement ${key}`,
  );
  requireText(
    cloudInit,
    `${key}=\${${key}}`,
    `daemon telemetry environment ${key}`,
  );
}
for (const key of [
  "NEHEMIAH_RUNTIME_COHORT_ID",
  "NEHEMIAH_RUNTIME_CONTRACT_VERSION",
  "NEHEMIAH_RUNTIME_ARCH",
  "NEHEMIAH_RUNTIME_PYTHON_SHA256",
  "NEHEMIAH_RUNTIME_DESKTOP_SHA256",
  "NEHEMIAH_RUNTIME_KERNEL_SHA256",
  "NEHEMIAH_RUNTIME_FIRECRACKER_SHA256",
  "NEHEMIAH_RUNTIME_JAILER_SHA256",
]) {
  requireText(
    cloudInit,
    `${key}=`,
    `managed runtime cohort environment ${key}`,
  );
}
requireText(
  managedReleaseValidator,
  '"contract_version=4\\n"',
  "canonical managed runtime cohort",
);
requireText(
  managedReleaseValidator,
  'host.get("runtimeCohorts", {}).get(candidate) != expected_cohort',
  "signed runtime cohort verification",
);
requireText(
  cloudInit,
  'python3 "$RELEASE_DIR/host/infra/latitude/managed-host-packages.py" install',
  "signed offline package installation",
);
requireBefore(
  cloudInit,
  "/usr/local/libexec/nehemiah-verify-minisign",
  'managed-host-packages.py" install',
);
requireText(
  userDataRenderer,
  'wireguard-config.py" canonicalize-base64',
  "typed WireGuard canonicalization",
);
for (const forbiddenField of [
  "PreUp",
  "PostUp",
  "PreDown",
  "PostDown",
  "DNS",
  "Table",
  "SaveConfig",
]) {
  invariant(
    !managedWireGuardValidator.includes(`"${forbiddenField}"`),
    `managed WireGuard allowlist unexpectedly permits ${forbiddenField}`,
  );
}
requireText(
  managedWireGuardValidator,
  "AllowedIPs may contain only distinct CP/gateway host routes",
  "WireGuard host-route-only policy",
);
requireText(
  managedWireGuardValidator,
  "AllowedIPs must exactly match the approved CP/gateway host routes",
  "WireGuard exact role-bound route policy",
);
for (const key of [
  "NEHEMIAH_WIREGUARD_CONTROL_PLANE_ADDRESS",
  "NEHEMIAH_WIREGUARD_GATEWAY_ADDRESS",
]) {
  requireText(userDataRenderer, key, `required WireGuard role input ${key}`);
  requireText(
    cloudInit,
    `: "\${${key}:?required}"`,
    `cloud-init WireGuard role requirement ${key}`,
  );
  requireText(
    cloudInit,
    `${key}=\${${key}}`,
    `daemon WireGuard role environment ${key}`,
  );
}
for (const script of [cloudInit, managedHostPreflight, managedNetworkSetup]) {
  requireText(
    script,
    "--control-plane-address",
    "WireGuard control-plane role verification",
  );
  requireText(
    script,
    "--gateway-address",
    "WireGuard gateway role verification",
  );
  requireText(script, "--guest-subnet", "WireGuard guest-subnet exclusion");
}
for (const key of [
  "LATITUDE_OS_ID",
  "LATITUDE_OS_SLUG",
  "LATITUDE_OS_VERSION",
  "LATITUDE_OS_ARCH",
]) {
  requireText(userDataRenderer, key, `required provider image input ${key}`);
  requireText(
    cloudInit,
    `: "\${${key}:?required}"`,
    `cloud-init provider image ${key}`,
  );
}
requireText(
  latitudeProvisioner,
  'header = "Authorization: Bearer ${API_KEY}"',
  "private curl authorization config",
);
requireText(
  latitudeProvisioner,
  "/plans/operating_systems?page%5Bsize%5D=100",
  "live provider image id lookup",
);
requireText(
  latitudeProvisioner,
  "before creating user data or any billable server",
  "provider image lookup ordering",
);
invariant(
  !latitudeProvisioner.includes("LATITUDE_OS:-") &&
    !latitudeProvisioner.includes('LATITUDE_OS="'),
  "provisioning must not default to a mutable provider OS slug",
);
for (const [label, contents] of [
  ["cloud-init", cloudInit],
  ["managed bootstrap", bootstrap],
]) {
  invariant(
    !contents.includes("releases/latest") &&
      !contents.includes("/latest/download"),
    `${label} must not fetch mutable latest assets`,
  );
}

const actionReferences = [
  ...workflow.matchAll(/\buses:\s*([^\s@]+)@([^\s#]+)/g),
];
invariant(actionReferences.length > 0, "release workflow contains no actions");
for (const [, action, reference] of actionReferences) {
  invariant(
    /^[0-9a-f]{40}$/.test(reference),
    `${action} must be pinned to a full commit SHA`,
  );
}

for (const token of ["@@VERSION@@", "@@REPOSITORY@@", "@@SHA256@@"]) {
  requireText(formulaTemplate, token, `Homebrew token ${token}`);
}
requireText(
  formulaTemplate,
  "*std_npm_args",
  "Homebrew standard npm install arguments",
);
requireText(formulaTemplate, 'depends_on "node"', "Homebrew Node dependency");

validateVersion(cliPackage.version);
validateVersion(sdkPackage.version);
invariant(
  cliPackage.version === sdkPackage.version,
  "CLI and SDK package versions must match for a release",
);
invariant(
  cliPackage.dependencies?.["nehemiah-sdk"] === `^${sdkPackage.version}`,
  "CLI must depend on the matching SDK release line",
);
invariant(
  cliPackage.devDependencies?.esbuild,
  "CLI must declare the bundler used for self-contained releases",
);

process.stdout.write(`release checks passed for ${cliPackage.version}\n`);
