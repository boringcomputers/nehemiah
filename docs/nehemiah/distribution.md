# Release distribution

Nehemiah releases are built by [`.github/workflows/release.yml`](../../.github/workflows/release.yml). The workflow produces static Linux binaries for both supported architectures, the Node CLI package, a generated Homebrew formula, a release manifest, and a fail-closed checksum set. A tag release is published only after GitHub proves that the exact tagged commit belongs to the protected default branch, its complete default-branch CI job matrix succeeded for that exact SHA, and GitHub verifies the annotated tag signature, every artifact checksum, and GitHub artifact provenance.

Pull requests and manual workflow dispatches are build-only. They never create attestations or a GitHub Release. A `v*` tag is the only publishing trigger.

## Managed-host bootstrap contract

Published tag releases contain the complete contract consumed by [`infra/latitude/cloud-init.sh`](../../infra/latitude/cloud-init.sh). The contract is deliberately versioned and fail closed:

- `nehemiahd_<version>_linux_<arch>.tar.gz` and `bc-guest-agent_<version>_linux_<arch>.tar.gz` provide the exact host and guest binaries;
- `nehemiah-host-bootstrap_<version>.tar.gz` contains the reviewed host bootstrap, network policy, systemd units, and isolation verifier;
- `nehemiah-guest-{python,desktop}_<version>_linux_<arch>.ext4.gz` are the complete developer and VNC desktop filesystems, with Node 24.19.0 LTS/npm 11.19.0, Python, git, curl/CA, shell, and the exact static guest agent already installed;
- `nehemiah-guest-scan_<version>_linux_<arch>.json` records the pinned scanner binary, exact vulnerability-DB digest/timestamps, final-filesystem reports, and zero unapproved high/critical findings;
- `nehemiah-host-packages_<version>_ubuntu24.04_linux_<arch>.tar.gz` is the exact host `.deb` dependency closure and flat-repository metadata resolved on a native runner from the reviewed immutable Ubuntu snapshot;
- `nehemiah-runtime-firecracker_1.15.1_linux_<arch>.tgz` and `nehemiah-runtime-kernel_6.1.155_linux_<arch>.bin` retain the exact per-architecture Firecracker, jailer, and kernel bytes inside the immutable release;
- schema 5 / managed-host contract 4 of `release-manifest.json` declares `managedCloudInitCompatible: true`, names and SHA-256-pins retained runtime/package artifacts without exposing upstream URLs, carries each image's installed/uncompressed digest, and records a deterministic runtime cohort per architecture; and
- `SHA256SUMS.minisig` authenticates the checksum file with the protected release Minisign key. The checksum file in turn covers every versioned artifact and the manifest.

Cloud-init downloads only the requested `v<version>` release, verifies the
Minisign signature before reading the manifest, requires the schema 5 managed
host declaration, verifies every selected artifact, and atomically installs the
two exact ext4 images after gzip, size, type and e2fsck checks. It rejects
missing metadata, upstream runtime URLs, unsupported architectures, extra or
duplicate checksum entries, unsafe archive entries, and any missing image. It
never builds a guest or resolves network apt/apk/npm/OCI inputs at provision time.

The host package policy fixes Ubuntu 24.04 noble to
`https://snapshot.ubuntu.com/ubuntu/20260809T000000Z`, pins every selected
suite's `InRelease` SHA-256, verifies the package-index hashes carried by those
exact bytes, and resolves the root package set against an empty dpkg status.
Native amd64 and arm64 jobs build and inspect the complete repository twice,
byte-compare it, and reject wrong architecture/version, missing/extra packages,
or changed bytes. Managed cloud-init seeds an isolated APT cache from that
verified local repository and installs exact versions using `--no-download`;
bootstrap and network setup contain no apt mutation. Startup verifies the
persisted package manifest, installed versions/architectures, and package-file
checksums. The separate local/prototype scripts retain their mutable developer
package path and are not included in the signed managed contract.

The runtime cohort ID is the lowercase SHA-256 of these exact ASCII bytes, with
the shown order and a final line feed:

```text
contract_version=4
arch=<amd64|arm64>
python=<installed/uncompressed ext4 sha256>
desktop=<installed/uncompressed ext4 sha256>
kernel=<installed kernel sha256>
firecracker=<installed binary sha256>
jailer=<installed binary sha256>
```

Cloud-init writes the cohort ID, contract, architecture and five component
hashes into the private daemon environment. The daemon recomputes and verifies
the same cohort at startup and heartbeat; the release build also pins
`main.Version` to the exact release version exposed as `daemon_version`.

Only the trusted release build resolves the reviewed upstream runtime URLs in
`scripts/release/managed-runtime-policy.json`. It checks their exact SHA-256,
size, archive safety, executable type, and architecture before copying the four
files into the checksum matrix. Cloud-init subsequently downloads Firecracker,
jailer, and the kernel only from the selected signed release, so fresh hosts and
rollbacks do not depend on upstream retaining those objects.

The native amd64 and arm64 image jobs use the official Node 24.19.0 LTS
Alpine 3.23 platform manifests by digest. Both Alpine repository indexes are
captured per architecture and SHA-256 pinned; APK package signatures and the
pinned indexes bind the complete resolved package closure. npm 11.19.0 is
installed from its exact HTTPS tarball and SHA-256, with exact patched
`brace-expansion` 5.0.9 and `ip-address` 10.3.1 overlays. The builder refuses
to install anything if a repository index changes. Python packaging uses exact
SHA-256-pinned pip 26.2.1 and setuptools 84.0.0 wheels instead of the stale
repository-vendored copies. pip's bundled msgpack and pkg_resources copies are
also replaced from exact SHA-256-pinned msgpack 1.2.1 and setuptools 80.9.0
upstream artifacts before the image is scanned. Each assembled ext4 is built
twice and byte-compared.
Trivy 0.72.0 is downloaded from its exact release
URL with the policy SHA-256, its database must be at most 24 hours old, and the
database file SHA-256 plus update/download/observation timestamps are recorded.
The final filesystem scan includes the injected static `bc-guest-agent` and
rejects every HIGH/CRITICAL result unless an exact, reviewed exception expires
within 30 days. The committed exception list is empty.

The image policy fixes the headless filesystem at 2 GiB with a 768 MiB
compressed ceiling and the desktop filesystem at 6 GiB with a 2 GiB compressed
ceiling. Only the explicit package arrays in that policy may be installed; the
desktop delta is the Xvfb/Openbox/Chromium/x11vnc/socat stack needed by the
existing guest-vsock VNC contract.

A local or manually dispatched build has the same deterministic files and manifest but no `SHA256SUMS.minisig`, so it is not deployable by managed cloud-init. Only a tag release completed by the protected `release` environment is a managed-host input.

## Release payload

For version `<version>`, the payload is:

| Component               | Release files                                                             |
| ----------------------- | ------------------------------------------------------------------------- |
| Host daemon             | `nehemiahd_<version>_linux_{amd64,arm64}.tar.gz`                          |
| Guest agent             | `bc-guest-agent_<version>_linux_{amd64,arm64}.tar.gz`                     |
| Gateway                 | `bc-gateway_<version>_linux_{amd64,arm64}.tar.gz`                         |
| Managed guest images    | `nehemiah-guest-{python,desktop}_<version>_linux_{amd64,arm64}.ext4.gz`   |
| Guest scan evidence     | `nehemiah-guest-scan_<version>_linux_{amd64,arm64}.json`                  |
| Managed host packages   | `nehemiah-host-packages_<version>_ubuntu24.04_linux_{amd64,arm64}.tar.gz` |
| Managed VMM runtime     | `nehemiah-runtime-firecracker_1.15.1_linux_{amd64,arm64}.tgz`             |
| Managed guest kernel    | `nehemiah-runtime-kernel_6.1.155_linux_{amd64,arm64}.bin`                 |
| Managed-host bootstrap  | `nehemiah-host-bootstrap_<version>.tar.gz`                                |
| Self-contained Node CLI | `nehemiah-cli-<version>.tgz`                                              |
| Homebrew                | `nehemiah.rb`                                                             |
| Integrity               | `release-manifest.json`, `SHA256SUMS`, `SHA256SUMS.minisig`               |
| Offline provenance      | `artifact-provenance.sigstore.json`, `checksums-provenance.sigstore.json` |

Each binary archive also contains `LICENSE` and `NOTICE`. Go builds use `CGO_ENABLED=0`, `-trimpath`, an empty build ID, a fixed source timestamp, and a post-build static ELF/architecture check. The CLI, SDK, Effect runtime, and their transitive code are bundled into one executable JavaScript file; the release npm package has no runtime npm dependencies. The builder installs that tarball globally into an empty prefix using npm's offline mode and executes the installed `bc help` symlink before accepting it, matching the important assumptions of Homebrew's `std_npm_args` layout. The manifest records the source commit and timestamp. The checksum verifier requires the complete architecture/component matrix and rejects missing metadata, extra checksum entries, malformed filenames, symlinks, and changed bytes.

The two Sigstore bundles and `SHA256SUMS.minisig` are deliberately not listed in `SHA256SUMS`: they are created from the immutable checksum subjects afterward and cannot checksum themselves without a cycle. Their signatures are verified before publishing. Post-signing verification explicitly allows those three filenames and rejects every other physical file, so the workflow cannot accidentally publish an unchecksummed extra.

## Local build-only rehearsal

Run from a clean checkout with Docker, GNU `tar`, `gzip`, `e2fsprogs`, `file`,
Go 1.25 or newer, Node.js 24, and locked npm dependencies installed. Production
images must be built on native amd64 and arm64 runners; QEMU output is rejected:

The deterministic two-pass desktop build needs at least 20 GiB of scratch
space. If `/tmp` is a smaller tmpfs, set `NEHEMIAH_GUEST_IMAGE_TMPDIR` to a
private, non-symlink directory on the runner's build volume; cleanup remains
scoped to the exact generated child directory.

```sh
version="$(node -p 'require("./packages/cli/package.json").version')"
commit="$(git rev-parse HEAD)"
source_date_epoch="$(git show -s --format=%ct HEAD)"

node --test scripts/release/test/*.test.mjs
node scripts/release/check.mjs
bash infra/latitude/test/managed-provisioning.test.sh
# Fetches only the reviewed upstream runtime inputs and verifies their exact
# policy digests/types before they enter the release.
scripts/release/fetch-managed-runtime-assets.sh managed-runtime-assets
# Build each exact host package archive on its matching native Ubuntu 24.04
# architecture and merge the two outputs into host-packages/.
scripts/release/build-managed-host-packages.sh \
  --version "$version" \
  --arch "$(dpkg --print-architecture)" \
  --source-date-epoch "$source_date_epoch" \
  --output "host-packages/nehemiah-host-packages_${version}_ubuntu24.04_linux_$(dpkg --print-architecture).tar.gz"
# Build `guest-images/` with scripts/release/build-guest-images.sh on each
# native architecture and merge its four ext4.gz plus two scan JSON files.
node scripts/release/build.mjs \
  --version "$version" \
  --out release-dist \
  --source-date-epoch "$source_date_epoch" \
  --commit "$commit" \
  --repository boringcomputers/nehemiah \
  --guest-images guest-images \
  --host-packages host-packages \
  --runtime-assets managed-runtime-assets
node scripts/release/verify.mjs --directory release-dist
```

The release output directory must be absent or empty, and the managed-runtime input directory must be absent. `guest-images/` and `host-packages/` must contain the exact two-architecture artifact sets. A failed fetch/build removes partial output. This rehearsal does not sign, upload, publish to npm, create a GitHub Release, or modify a Homebrew tap.

To regenerate only the formula from a verified release directory:

```sh
node scripts/release/formula.mjs \
  --version "$version" \
  --repository boringcomputers/nehemiah \
  --checksums release-dist/SHA256SUMS \
  --out release-dist/nehemiah.rb
```

Regenerating `nehemiah.rb` changes a checksummed artifact. Re-run the full build to produce release-ready checksum metadata; do not hand-edit the formula after checksums or attestations exist.

## Tag release procedure

1. Set the same exact semantic version in `packages/cli/package.json`, `packages/sdk/package.json`, and the CLI's `nehemiah-sdk` dependency. Commit and merge it into the protected default branch.
2. Wait for the exact merge commit's default-branch `CI` push run to complete successfully. The required matrix is the host/guest/gateway Go gate, workspace gate, generated wire-contract gate, and infra shell gate; missing, skipped, cancelled, or failed jobs are not release evidence.
3. Create a signed annotated tag pointing directly at that commit, for example `git tag -s v0.2.0-beta.0 -m "Nehemiah v0.2.0-beta.0"`.
4. Push the tag. Before any release build or attestation, the workflow uses read-only GitHub API evidence to verify the repository's current default branch is protected, the tag commit is its ancestor, and a successful `push` run of `.github/workflows/ci.yml` executed the exact required job set for the tag SHA. Unavailable or paginated evidence fails closed.
5. Approve the protected `release` environment after reviewing the build and attestation jobs.
6. The workflow rechecks protected-branch and exact-SHA CI evidence immediately before Sigstore attestation and again after protected-environment approval before Minisign signing. It also re-verifies the tag, checksum matrix, each subject's provenance, and checksum-file provenance. The protected environment then verifies that its Minisign secret key matches the configured public key, signs `SHA256SUMS`, verifies that signature, and checks the exact physical payload again.
7. The workflow creates the release and requires `gh release verify` to validate GitHub's signed immutable-release attestation.

A package/tag mismatch, off-default-branch commit, unprotected default branch, absent or unsuccessful exact-SHA CI matrix, lightweight or unverified tag, disabled immutable releases, missing checksum file, artifact change, unexpected artifact set, provenance mismatch, or unavailable verification service stops the release.

## Consumer verification

Download the complete release payload into one directory. The repository verifier fails closed when metadata is missing:

```sh
node scripts/release/verify.mjs \
  --directory ./downloaded-release \
  --allow-unchecksummed artifact-provenance.sigstore.json,checksums-provenance.sigstore.json,SHA256SUMS.minisig

minisign -Vm ./downloaded-release/SHA256SUMS \
  -x ./downloaded-release/SHA256SUMS.minisig \
  -P "$NEHEMIAH_RELEASE_MINISIGN_KEY"
```

Verify online provenance and the signed immutable release as well:

```sh
repo="boringcomputers/nehemiah"
tag="v0.2.0-beta.0"

while read -r _ artifact; do
  gh attestation verify "./downloaded-release/$artifact" \
    --repo "$repo" \
    --signer-workflow "$repo/.github/workflows/release.yml" \
    --source-ref "refs/tags/$tag" \
    --deny-self-hosted-runners
done < ./downloaded-release/SHA256SUMS

gh attestation verify ./downloaded-release/SHA256SUMS \
  --repo "$repo" \
  --signer-workflow "$repo/.github/workflows/release.yml" \
  --source-ref "refs/tags/$tag" \
  --deny-self-hosted-runners
gh release verify "$tag" --repo "$repo"
```

Do not install an artifact if any command fails or the metadata is unavailable.

## Homebrew handoff

The generated `nehemiah.rb` is a checksum-pinned formula candidate. It uses Homebrew's standard npm installation layout, declares Node, and includes a functional CLI test. This repository intentionally does not write to an external tap.

Before submitting the generated formula to `boringcomputers/homebrew-tap` or another tap, the tap maintainer must:

- run `brew audit --strict --online`, `brew install --build-from-source`, and `brew test` on the target macOS versions;
- review the formula diff and open the tap change using that repository's protected credentials and approval process.

The formula does not require `nehemiah-sdk` or other JavaScript packages to be published separately: its checksummed CLI tarball is self-contained. Node itself remains a declared Homebrew runtime dependency.

## External prerequisites

Repository administrators must configure these outside this codebase before the first real release:

- Enable GitHub immutable releases. The workflow queries the setting and refuses to publish when it is disabled or unavailable.
- Protect the repository's default branch and require reviewed merges. Keep `.github/workflows/ci.yml` enabled for default-branch pushes; release authorization independently checks the exact run and job evidence rather than trusting a tag name or branch-like ref.
- Configure a protected GitHub `release` environment with required reviewers, and protect `v*` tags against force updates or deletion.
- Store a passwordless Minisign secret key as the protected environment secret `NEHEMIAH_RELEASE_MINISIGN_SECRET_KEY_B64` (base64 of the complete mode-0600 key file). Store its exact `RW...` public key as environment variable `NEHEMIAH_RELEASE_MINISIGN_PUBLIC_KEY`. Keep the offline backup and rotation procedure outside GitHub, and update approved host configs only after a reviewed rotation release.
- Register and maintain trusted GPG or SSH signing identities so GitHub reports annotated tag verification as `valid`.
- Permit the workflow's scoped `GITHUB_TOKEN` to write release contents and attestations and to mint an OIDC token. No long-lived signing key is stored in the repository.
- Use a public GitHub repository, or GitHub Enterprise Cloud for a private/internal repository, because GitHub artifact attestations are not available for every private-repository plan or GitHub Enterprise Server.
- Ensure the runner GitHub CLI supports `gh attestation verify`, `gh release verify`, and immutable-release verification.
- Arrange separate credentials and review for the external Homebrew tap. This workflow never publishes npm packages and never changes a tap.

The release workflow is intentionally unable to work around any of these prerequisites; unavailable signing or verification metadata is a release failure.

Repository checks cannot prove Latitude's current bare-metal inventory or attest the bytes behind its opaque OS image ID, KVM availability, provider-side user-data deletion/retention, native arm64 installation on a live Latitude host, WireGuard reachability, or successful enrollment against a deployed control plane. Before admitting beta workloads, an approved operator must use the live API to record the exact provider image ID-to-slug/version/architecture/plan mapping, provision a canary with the manual Latitude runbook, confirm `/dev/kvm`, verify `/var/lib/nehemiahd/bootstrap.complete`, run the installed package/runtime-cohort and isolation checks, confirm the control-plane host reports the expected daemon version and cohort healthy, and confirm the one-time Latitude user-data record was deleted. That live canary evidence is intentionally an external release/provisioning gate.
