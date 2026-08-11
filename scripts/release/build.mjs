#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import {
  assertDirectoryEmpty,
  assertRegularFile,
  createManifest,
  invariant,
  MANAGED_GUEST_POLICY,
  MANAGED_RUNTIME_POLICY,
  parseArguments,
  renderFormula,
  resolveRepositoryOutputDirectory,
  runCommand,
  sha256File,
  validateCommit,
  validateRepository,
  validateVersion,
  verifyReleaseDirectory,
  writeChecksums,
  writeManifest,
} from "./lib.mjs";

const releaseDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(releaseDirectory, "../..");

const options = parseArguments(process.argv.slice(2), [
  "version",
  "out",
  "source-date-epoch",
  "commit",
  "repository",
  "guest-images",
  "host-packages",
  "runtime-assets",
]);
const version = validateVersion(options.version);
const commit = validateCommit(options.commit);
const repository = validateRepository(options.repository);
invariant(options["guest-images"], "--guest-images is required");
const guestImageDirectory = path.resolve(
  repositoryRoot,
  options["guest-images"],
);
const guestImageDirectoryStats = await lstat(guestImageDirectory).catch(
  (error) => {
    if (error?.code === "ENOENT")
      throw new Error("guest image directory is missing");
    throw error;
  },
);
invariant(
  guestImageDirectoryStats.isDirectory() &&
    !guestImageDirectoryStats.isSymbolicLink(),
  "guest image input must be a non-symlink directory",
);
invariant(options["runtime-assets"], "--runtime-assets is required");
const runtimeAssetDirectory = path.resolve(
  repositoryRoot,
  options["runtime-assets"],
);
const runtimeAssetDirectoryStats = await lstat(runtimeAssetDirectory).catch(
  (error) => {
    if (error?.code === "ENOENT")
      throw new Error("managed runtime asset directory is missing");
    throw error;
  },
);
invariant(
  runtimeAssetDirectoryStats.isDirectory() &&
    !runtimeAssetDirectoryStats.isSymbolicLink(),
  "managed runtime asset input must be a non-symlink directory",
);
invariant(options["host-packages"], "--host-packages is required");
const hostPackageDirectory = path.resolve(
  repositoryRoot,
  options["host-packages"],
);
const hostPackageDirectoryStats = await lstat(hostPackageDirectory).catch(
  (error) => {
    if (error?.code === "ENOENT")
      throw new Error("managed host package directory is missing");
    throw error;
  },
);
invariant(
  hostPackageDirectoryStats.isDirectory() &&
    !hostPackageDirectoryStats.isSymbolicLink(),
  "managed host package input must be a non-symlink directory",
);
const sourceDateEpoch = Number(options["source-date-epoch"]);
invariant(
  Number.isSafeInteger(sourceDateEpoch) && sourceDateEpoch > 0,
  "--source-date-epoch must be a positive integer",
);
const outputDirectory = resolveRepositoryOutputDirectory(
  repositoryRoot,
  options.out,
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
invariant(
  cliPackage.version === version,
  `CLI package version ${cliPackage.version} does not match ${version}`,
);
invariant(
  sdkPackage.version === version,
  `SDK package version ${sdkPackage.version} does not match ${version}`,
);
invariant(
  cliPackage.dependencies?.["nehemiah-sdk"] === `^${version}`,
  `CLI nehemiah-sdk dependency must be ^${version}`,
);

const outputDirectoryExisted = await assertDirectoryEmpty(outputDirectory);
const scratchDirectory = await mkdtemp(
  path.join(repositoryRoot, ".nehemiah-release-"),
);
const stagedOutputDirectory = path.join(scratchDirectory, "output");
await mkdir(stagedOutputDirectory, { mode: 0o755 });

const goComponents = [
  {
    component: "nehemiahd",
    source: "nehemiahd",
    versionSymbol: "main.Version",
  },
  { component: "bc-guest-agent", source: "guest-agent" },
  { component: "bc-gateway", source: "gateway" },
];

async function assertStaticLinuxBinary(binaryPath, arch) {
  const { stdout } = await runCommand("file", ["--brief", binaryPath]);
  invariant(
    stdout.includes("ELF 64-bit LSB"),
    `${binaryPath} is not a 64-bit Linux ELF binary: ${stdout.trim()}`,
  );
  invariant(
    stdout.includes("statically linked"),
    `${binaryPath} is dynamically linked: ${stdout.trim()}`,
  );
  const expectedArchitecture = arch === "amd64" ? "x86-64" : "ARM aarch64";
  invariant(
    stdout.includes(expectedArchitecture),
    `${binaryPath} is not ${arch}: ${stdout.trim()}`,
  );
}

async function buildGoArtifact(definition, arch) {
  const artifactName = `${definition.component}_${version}_linux_${arch}.tar.gz`;
  const binaryDirectory = path.join(
    scratchDirectory,
    `${definition.component}-${arch}-binary`,
  );
  const stagingDirectory = path.join(
    scratchDirectory,
    `${definition.component}-${arch}-archive`,
  );
  await mkdir(binaryDirectory, { recursive: true });
  await mkdir(stagingDirectory, { recursive: true });
  const binaryPath = path.join(binaryDirectory, definition.component);
  const linkerFlags = ["-s", "-w", "-buildid="];
  if (definition.versionSymbol)
    linkerFlags.push("-X", `${definition.versionSymbol}=${version}`);

  await runCommand(
    "go",
    [
      "build",
      "-trimpath",
      "-buildvcs=false",
      "-ldflags",
      linkerFlags.join(" "),
      "-o",
      binaryPath,
      ".",
    ],
    {
      cwd: path.join(repositoryRoot, definition.source),
      env: {
        ...process.env,
        CGO_ENABLED: "0",
        GOARCH: arch,
        GOOS: "linux",
        GOFLAGS: "-mod=readonly",
        SOURCE_DATE_EPOCH: String(sourceDateEpoch),
      },
    },
  );
  await assertStaticLinuxBinary(binaryPath, arch);
  await chmod(binaryPath, 0o755);
  await copyFile(binaryPath, path.join(stagingDirectory, definition.component));
  await copyFile(
    path.join(repositoryRoot, "LICENSE"),
    path.join(stagingDirectory, "LICENSE"),
  );
  await copyFile(
    path.join(repositoryRoot, "NOTICE"),
    path.join(stagingDirectory, "NOTICE"),
  );
  await chmod(path.join(stagingDirectory, definition.component), 0o755);
  await chmod(path.join(stagingDirectory, "LICENSE"), 0o644);
  await chmod(path.join(stagingDirectory, "NOTICE"), 0o644);

  await runCommand("tar", [
    "--sort=name",
    "--format=ustar",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    `--mtime=@${sourceDateEpoch}`,
    "--mode=u+rwX,go+rX,go-w",
    "--use-compress-program=gzip -n -9",
    "-cf",
    path.join(stagedOutputDirectory, artifactName),
    "-C",
    stagingDirectory,
    ".",
  ]);
  return artifactName;
}

// The credential store loads the napi-rs keyring at runtime; its native
// .node bindings cannot be bundled by esbuild, and the packed CLI must
// install offline, so the keyring and every platform binding are vendored
// into the tarball as a bundled dependency, pinned by exact registry
// tarball digest.
const VENDORED_CLI_KEYRING = Object.freeze({
  name: "@napi-rs/keyring",
  version: "1.3.0",
  tarballs: Object.freeze([
    {
      name: "@napi-rs/keyring",
      sha256:
        "3303402123327ecfc472e12b5577f4d7acf2e0780d1d646212ca51c8fbf50b84",
    },
    {
      name: "@napi-rs/keyring-darwin-arm64",
      sha256:
        "b57f9a3136ab0e74d570370facf26fd0aafaceab41336853edffccb250b0a959",
    },
    {
      name: "@napi-rs/keyring-darwin-x64",
      sha256:
        "962dc87ae7e6dfa5c496ee0c61ff0949a22d2c46b23805e0908a04ed4185ea53",
    },
    {
      name: "@napi-rs/keyring-freebsd-x64",
      sha256:
        "693f11ec41e64baa36753ff33d2da68891d78e7b93f9226c2e2427ca7afcdcc2",
    },
    {
      name: "@napi-rs/keyring-linux-arm-gnueabihf",
      sha256:
        "dcc7976c7a5285c1051170a14cd156bcac88ff92e8ebc80b84e54cf14fae4a41",
    },
    {
      name: "@napi-rs/keyring-linux-arm64-gnu",
      sha256:
        "8765084a2d3b53d6bb1b731e050d812b94b4bab71aeafe6cff4e46e773e0e0e7",
    },
    {
      name: "@napi-rs/keyring-linux-arm64-musl",
      sha256:
        "f29cac9864985cb268b307ba138966f53f249c6d16ec7adfeb6a64ceb75d5750",
    },
    {
      name: "@napi-rs/keyring-linux-riscv64-gnu",
      sha256:
        "45bdbeb4f875c0e412ac68832350d1cd96c9b45b456e034f3ec52caeaac0f118",
    },
    {
      name: "@napi-rs/keyring-linux-x64-gnu",
      sha256:
        "c739de9323a5ae7d27b93669661a78b9678e6d66d891435447e628f6432eb05b",
    },
    {
      name: "@napi-rs/keyring-linux-x64-musl",
      sha256:
        "9a9743d13272b6a66370bf93d7f64decf076794804f7b9de9fce842e0ec0ae26",
    },
    {
      name: "@napi-rs/keyring-win32-arm64-msvc",
      sha256:
        "7dfe816fb394c90b34d1284c7f64e2ee75c23b9e6cc68e97668fb102ce789d65",
    },
    {
      name: "@napi-rs/keyring-win32-ia32-msvc",
      sha256:
        "8fbbb969e43ccf942d730fa91e480c8a02b68965681f22fcb4d26b89a3f77bc2",
    },
    {
      name: "@napi-rs/keyring-win32-x64-msvc",
      sha256:
        "a775ca1dda8f344a4d92fd2efb46f8c0ae6214ff30f8a066262788f34e43b184",
    },
  ]),
});

async function vendorCliKeyring(packageDirectory) {
  const vendorScratch = path.join(scratchDirectory, "cli-keyring-vendor");
  await mkdir(vendorScratch, { recursive: true });
  const keyringRoot = path.join(
    packageDirectory,
    "node_modules",
    VENDORED_CLI_KEYRING.name,
  );
  for (const tarball of VENDORED_CLI_KEYRING.tarballs) {
    const shortName = tarball.name.split("/")[1];
    const filename = `${shortName}-${VENDORED_CLI_KEYRING.version}.tgz`;
    const url = `https://registry.npmjs.org/${tarball.name}/-/${filename}`;
    const response = await fetch(url);
    invariant(
      response.ok,
      `vendored keyring download failed: ${url} (${response.status})`,
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    invariant(
      createHash("sha256").update(bytes).digest("hex") === tarball.sha256,
      `vendored keyring tarball digest mismatch: ${tarball.name}`,
    );
    const archivePath = path.join(vendorScratch, filename);
    await writeFile(archivePath, bytes, { mode: 0o644 });
    // Platform bindings nest under the keyring package so its dynamic
    // per-platform require() resolves them without touching the registry.
    const destination =
      tarball.name === VENDORED_CLI_KEYRING.name
        ? keyringRoot
        : path.join(keyringRoot, "node_modules", tarball.name);
    await mkdir(destination, { recursive: true });
    await runCommand("tar", [
      "-xzf",
      archivePath,
      "-C",
      destination,
      "--strip-components=1",
    ]);
  }
}

async function buildCliArtifact() {
  await runCommand("npm", ["run", "build", "--workspace", "nehemiah-sdk"], {
    cwd: repositoryRoot,
  });
  await runCommand("npm", ["run", "build", "--workspace", "nehemiah-cli"], {
    cwd: repositoryRoot,
  });
  const packageDirectory = path.join(scratchDirectory, "cli-package");
  await mkdir(path.join(packageDirectory, "dist"), { recursive: true });
  await runCommand(path.join(repositoryRoot, "node_modules/.bin/esbuild"), [
    path.join(repositoryRoot, "packages/cli/dist/index.js"),
    "--bundle",
    "--platform=node",
    "--target=node20",
    "--format=esm",
    "--packages=bundle",
    // The credential store loads the napi-rs keyring at runtime; its native
    // .node binding cannot be bundled, so it stays the package's single
    // runtime dependency and npm resolves the platform binding on install.
    "--external:@napi-rs/keyring",
    "--legal-comments=external",
    `--outfile=${path.join(packageDirectory, "dist/cli.js")}`,
  ]);
  await writeFile(
    path.join(packageDirectory, "dist/index.js"),
    [
      "#!/usr/bin/env node",
      'import { runCli } from "./cli.js";',
      "process.exitCode = await runCli(process.argv.slice(2));",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
  await chmod(path.join(packageDirectory, "dist/index.js"), 0o755);
  await copyFile(
    path.join(repositoryRoot, "packages/cli/README.md"),
    path.join(packageDirectory, "README.md"),
  );
  await copyFile(
    path.join(repositoryRoot, "LICENSE"),
    path.join(packageDirectory, "LICENSE"),
  );
  await copyFile(
    path.join(repositoryRoot, "NOTICE"),
    path.join(packageDirectory, "NOTICE"),
  );
  const distributablePackage = {
    name: cliPackage.name,
    version: cliPackage.version,
    description: cliPackage.description,
    license: cliPackage.license,
    repository: cliPackage.repository,
    homepage: cliPackage.homepage,
    keywords: cliPackage.keywords,
    type: "module",
    main: "./dist/cli.js",
    bin: cliPackage.bin,
    files: ["dist", "README.md", "LICENSE", "NOTICE"],
    engines: cliPackage.engines,
    dependencies: {
      [VENDORED_CLI_KEYRING.name]: VENDORED_CLI_KEYRING.version,
    },
    bundleDependencies: [VENDORED_CLI_KEYRING.name],
  };
  invariant(
    cliPackage.dependencies[VENDORED_CLI_KEYRING.name] ===
      VENDORED_CLI_KEYRING.version,
    "vendored keyring version does not match the CLI workspace pin",
  );
  await writeFile(
    path.join(packageDirectory, "package.json"),
    `${JSON.stringify(distributablePackage, null, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o644,
    },
  );
  await vendorCliKeyring(packageDirectory);
  const packDirectory = path.join(scratchDirectory, "npm-pack");
  await mkdir(packDirectory);
  const { stdout } = await runCommand(
    "npm",
    [
      "pack",
      packageDirectory,
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      packDirectory,
    ],
    { cwd: repositoryRoot },
  );
  let packResult;
  try {
    packResult = JSON.parse(stdout);
  } catch (error) {
    throw new Error("npm pack did not return JSON", { cause: error });
  }
  invariant(
    Array.isArray(packResult) && packResult.length === 1,
    "npm pack returned an unexpected artifact set",
  );
  const expectedName = `nehemiah-cli-${version}.tgz`;
  invariant(
    packResult[0]?.filename === expectedName,
    `npm pack created ${String(packResult[0]?.filename)}, expected ${expectedName}`,
  );
  const artifactPath = path.join(stagedOutputDirectory, expectedName);
  await rename(path.join(packDirectory, expectedName), artifactPath);

  const installDirectory = path.join(scratchDirectory, "offline-cli-install");
  await mkdir(installDirectory);
  await runCommand(
    "npm",
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--global",
      "--prefix",
      installDirectory,
      artifactPath,
    ],
    {
      cwd: scratchDirectory,
      env: {
        ...process.env,
        npm_config_cache: path.join(scratchDirectory, "empty-npm-cache"),
      },
    },
  );
  const installedPackage = JSON.parse(
    await readFile(
      path.join(installDirectory, "lib/node_modules/nehemiah-cli/package.json"),
      "utf8",
    ),
  );
  // The offline install above already proves nothing is fetched from a
  // registry; the only permitted runtime dependency is the vendored,
  // bundled OS-keyring binding, which must have landed inside the package.
  invariant(
    JSON.stringify(installedPackage.dependencies) ===
      JSON.stringify({
        [VENDORED_CLI_KEYRING.name]: VENDORED_CLI_KEYRING.version,
      }) &&
      installedPackage.optionalDependencies === undefined &&
      JSON.stringify(
        installedPackage.bundleDependencies ??
          installedPackage.bundledDependencies,
      ) === JSON.stringify([VENDORED_CLI_KEYRING.name]),
    "release CLI package must vendor exactly the bundled keyring dependency",
  );
  await assertRegularFile(
    path.join(
      installDirectory,
      "lib/node_modules/nehemiah-cli/node_modules",
      VENDORED_CLI_KEYRING.name,
      "package.json",
    ),
  );
  const { stdout: helpOutput } = await runCommand(
    path.join(installDirectory, "bin/bc"),
    ["help"],
  );
  invariant(
    helpOutput.includes("Boring Computers command line"),
    "offline-installed CLI smoke test failed",
  );
  return expectedName;
}

const managedHostFiles = [
  "infra/latitude/bootstrap.sh",
  "infra/latitude/cloud-init.sh",
  "infra/latitude/managed-host-packages.py",
  "infra/latitude/managed-host-preflight.sh",
  "infra/latitude/net-setup.sh",
  "infra/latitude/validate-managed-release.py",
  "infra/latitude/verify-minisign.py",
  "infra/latitude/boring-net.service",
  "infra/latitude/nehemiahd.service",
  "infra/latitude/verify-isolation.sh",
  "infra/latitude/wireguard-config.py",
];

async function sha256UncompressedGzip(filePath) {
  const hash = createHash("sha256");
  const gunzip = createGunzip();
  createReadStream(filePath).pipe(gunzip);
  for await (const chunk of gunzip) hash.update(chunk);
  return hash.digest("hex");
}

async function stageGuestImageArtifacts() {
  const expectedNames = [];
  const rootfsDigests = { amd64: {}, arm64: {} };
  for (const arch of ["amd64", "arm64"]) {
    for (const flavor of ["python", "desktop"]) {
      expectedNames.push(
        `nehemiah-guest-${flavor}_${version}_linux_${arch}.ext4.gz`,
      );
    }
  }
  for (const arch of ["amd64", "arm64"])
    expectedNames.push(`nehemiah-guest-scan_${version}_linux_${arch}.json`);
  expectedNames.sort();
  const entries = await readdir(guestImageDirectory, {
    withFileTypes: true,
  });
  const actualNames = entries.map(({ name }) => name).sort();
  invariant(
    JSON.stringify(actualNames) === JSON.stringify(expectedNames),
    "guest image directory must contain the exact four release images",
  );
  for (const arch of ["amd64", "arm64"]) {
    for (const flavor of ["python", "desktop"]) {
      const name = `nehemiah-guest-${flavor}_${version}_linux_${arch}.ext4.gz`;
      const source = path.join(guestImageDirectory, name);
      const stats = await assertRegularFile(source, name);
      invariant(
        stats.size > 0 &&
          stats.size <= MANAGED_GUEST_POLICY.flavors[flavor].maxCompressedBytes,
        `${name} exceeds the signed image size policy`,
      );
      await runCommand(
        path.join(
          repositoryRoot,
          "scripts/release/guest-images/inspect-guest-image.sh",
        ),
        [
          path.join(repositoryRoot, "scripts/release/guest-images/policy.json"),
          source,
          version,
          arch,
          flavor,
        ],
      );
      await copyFile(source, path.join(stagedOutputDirectory, name));
      await chmod(path.join(stagedOutputDirectory, name), 0o644);
      rootfsDigests[arch][flavor] = await sha256UncompressedGzip(source);
    }
    const scanName = `nehemiah-guest-scan_${version}_linux_${arch}.json`;
    const scanSource = path.join(guestImageDirectory, scanName);
    const scanStats = await assertRegularFile(scanSource, scanName);
    invariant(
      scanStats.size > 0 &&
        scanStats.size <=
          MANAGED_GUEST_POLICY.vulnerabilityScan.maxEvidenceBytes,
      `${scanName} exceeds the signed scan evidence size policy`,
    );
    await runCommand(
      "node",
      [
        path.join(
          repositoryRoot,
          "scripts/release/guest-images/verify-scan-evidence.mjs",
        ),
        "--evidence",
        scanSource,
        "--images",
        guestImageDirectory,
        "--version",
        version,
        "--arch",
        arch,
      ],
      { cwd: repositoryRoot },
    );
    await copyFile(scanSource, path.join(stagedOutputDirectory, scanName));
    await chmod(path.join(stagedOutputDirectory, scanName), 0o644);
  }
  return { names: expectedNames, rootfsDigests };
}

async function stageManagedHostPackageArtifacts() {
  const entries = await readdir(hostPackageDirectory, { withFileTypes: true });
  const expectedNames = ["amd64", "arm64"].map(
    (arch) =>
      `nehemiah-host-packages_${version}_ubuntu24.04_linux_${arch}.tar.gz`,
  );
  invariant(
    JSON.stringify(entries.map(({ name }) => name).sort()) ===
      JSON.stringify(expectedNames),
    "managed host package directory must contain the exact architecture set",
  );
  const manifests = {};
  for (const arch of ["amd64", "arm64"]) {
    const name = `nehemiah-host-packages_${version}_ubuntu24.04_linux_${arch}.tar.gz`;
    const source = path.join(hostPackageDirectory, name);
    await assertRegularFile(source, name);
    await runCommand(
      path.join(
        repositoryRoot,
        "scripts/release/inspect-managed-host-packages.sh",
      ),
      ["--archive", source, "--version", version, "--arch", arch],
    );
    const { stdout } = await runCommand("tar", [
      "-xOf",
      source,
      "./manifest.json",
    ]);
    let manifest;
    try {
      manifest = JSON.parse(stdout);
    } catch (error) {
      throw new Error(`${name} contains invalid package manifest JSON`, {
        cause: error,
      });
    }
    manifests[arch] = {
      ...manifest,
      manifestSha256: createHash("sha256").update(stdout).digest("hex"),
    };
    await copyFile(source, path.join(stagedOutputDirectory, name));
    await chmod(path.join(stagedOutputDirectory, name), 0o644);
  }
  return { names: expectedNames, manifests };
}

async function stageManagedRuntimeArtifacts() {
  await runCommand(
    path.join(
      repositoryRoot,
      "scripts/release/inspect-managed-runtime-assets.sh",
    ),
    [
      path.join(repositoryRoot, "scripts/release/managed-runtime-policy.json"),
      runtimeAssetDirectory,
    ],
  );
  const expectedNames = [];
  for (const arch of ["amd64", "arm64"]) {
    for (const component of ["firecracker", "kernel"]) {
      const policy = MANAGED_RUNTIME_POLICY.architectures[arch][component];
      const source = path.join(runtimeAssetDirectory, policy.artifact);
      const stats = await assertRegularFile(source, policy.artifact);
      invariant(
        stats.size > 0 && stats.size <= policy.maxBytes,
        `${policy.artifact} exceeds the retained runtime size policy`,
      );
      invariant(
        (await sha256File(source)) === policy.sha256,
        `${policy.artifact} does not match the reviewed runtime digest`,
      );
      await copyFile(source, path.join(stagedOutputDirectory, policy.artifact));
      await chmod(path.join(stagedOutputDirectory, policy.artifact), 0o644);
      expectedNames.push(policy.artifact);
    }
  }
  return expectedNames.sort();
}

async function buildManagedHostBootstrapArtifact() {
  const artifactName = `nehemiah-host-bootstrap_${version}.tar.gz`;
  const stagingDirectory = path.join(
    scratchDirectory,
    "managed-host-bootstrap-archive",
  );
  await mkdir(stagingDirectory, { recursive: true });
  for (const relativePath of managedHostFiles) {
    const destination = path.join(stagingDirectory, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(repositoryRoot, relativePath), destination);
    await chmod(
      destination,
      relativePath.endsWith(".sh") || relativePath.endsWith(".py")
        ? 0o755
        : 0o644,
    );
  }
  for (const name of ["LICENSE", "NOTICE"]) {
    await copyFile(
      path.join(repositoryRoot, name),
      path.join(stagingDirectory, name),
    );
    await chmod(path.join(stagingDirectory, name), 0o644);
  }
  await runCommand("tar", [
    "--sort=name",
    "--format=ustar",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    `--mtime=@${sourceDateEpoch}`,
    "--mode=u+rwX,go+rX,go-w",
    "--use-compress-program=gzip -n -9",
    "-cf",
    path.join(stagedOutputDirectory, artifactName),
    "-C",
    stagingDirectory,
    ".",
  ]);
  return artifactName;
}

try {
  const artifactNames = [];
  for (const component of goComponents) {
    for (const arch of ["amd64", "arm64"])
      artifactNames.push(await buildGoArtifact(component, arch));
  }
  const cliArtifact = await buildCliArtifact();
  artifactNames.push(cliArtifact);
  artifactNames.push(await buildManagedHostBootstrapArtifact());
  const guestImages = await stageGuestImageArtifacts();
  artifactNames.push(...guestImages.names);
  const hostPackages = await stageManagedHostPackageArtifacts();
  artifactNames.push(...hostPackages.names);
  artifactNames.push(...(await stageManagedRuntimeArtifacts()));

  const template = await readFile(
    path.join(releaseDirectory, "templates/nehemiah.rb.tpl"),
    "utf8",
  );
  const formula = renderFormula(template, {
    version,
    repository,
    sha256: await sha256File(path.join(stagedOutputDirectory, cliArtifact)),
  });
  await writeFile(path.join(stagedOutputDirectory, "nehemiah.rb"), formula, {
    encoding: "utf8",
    mode: 0o644,
  });
  artifactNames.push("nehemiah.rb");

  const manifest = createManifest({
    version,
    commit,
    sourceDateEpoch,
    repository,
    guestRootfsDigests: guestImages.rootfsDigests,
    hostPackageManifests: hostPackages.manifests,
  });
  await writeManifest(stagedOutputDirectory, manifest);
  await writeChecksums(stagedOutputDirectory, [
    ...artifactNames,
    "release-manifest.json",
  ]);
  await verifyReleaseDirectory(stagedOutputDirectory);
  if (outputDirectoryExisted) await rmdir(outputDirectory);
  try {
    await rename(stagedOutputDirectory, outputDirectory);
  } catch (error) {
    if (outputDirectoryExisted) await mkdir(outputDirectory, { mode: 0o755 });
    throw error;
  }
  process.stdout.write(
    `${JSON.stringify({ outputDirectory, version, artifacts: manifest.artifacts.map(({ name }) => name) }, null, 2)}\n`,
  );
} finally {
  await rm(scratchDirectory, { recursive: true, force: true });
}
