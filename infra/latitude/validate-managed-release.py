#!/usr/bin/env python3
"""Validate signed release schema 5 and emit one architecture's safe inputs."""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re


SHA256 = re.compile(r"[0-9a-f]{64}")
SAFE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,254}")
ARCHES = ("amd64", "arm64")
RUNTIME = {
    "amd64": {
        "firecracker": {
            "version": "1.15.1",
            "artifact": "nehemiah-runtime-firecracker_1.15.1_linux_amd64.tgz",
            "format": "tgz",
            "maxBytes": 16777216,
            "sha256": "d4a32ab2322d887ca1bc4a4e7afa9cc35393e6362dfc2b3becb389d362e4275a",
            "firecrackerSha256": "7e8b57e88c459396d4680d83dcdd8c7f72305447cb55b11f4ac98ad70a3f7825",
            "jailerSha256": "4830a9b1fc6cece036d8992ff12f1fe9c5247aacad77f42c7aba683c7a08622e",
        },
        "kernel": {
            "version": "6.1.155",
            "artifact": "nehemiah-runtime-kernel_6.1.155_linux_amd64.bin",
            "format": "linux-kernel",
            "maxBytes": 67108864,
            "sha256": "e20e46d0c36c55c0d1014eb20576171b3f3d922260d9f792017aeff53af3d4f2",
        },
    },
    "arm64": {
        "firecracker": {
            "version": "1.15.1",
            "artifact": "nehemiah-runtime-firecracker_1.15.1_linux_arm64.tgz",
            "format": "tgz",
            "maxBytes": 16777216,
            "sha256": "00654ac1e702a22744121ea9f10a4f792ebd7c3a744cba587dfac9fcb79b41a5",
            "firecrackerSha256": "e9ce7466c3b0d879d7a9158f4bf710dd5e131bbc5e580e5269fec66d5b5a0f0a",
            "jailerSha256": "7faa581395fd1994ee005efc0a9c8826b4a9f0616dd942c2486adb8a8eac13f0",
        },
        "kernel": {
            "version": "6.1.155",
            "artifact": "nehemiah-runtime-kernel_6.1.155_linux_arm64.bin",
            "format": "linux-kernel",
            "maxBytes": 67108864,
            "sha256": "e3544b10603acbf3db492cb52e000d22ba202cb4b63b9add027565683e11c591",
        },
    },
}


def stop(message: str) -> "NoReturn":
    raise SystemExit(f"signed release manifest: {message}")


def exact(value: object, keys: set[str], label: str) -> dict:
    if not isinstance(value, dict) or set(value) != keys:
        stop(f"{label} does not contain the exact key set")
    return value


def artifact_names(version: str) -> list[str]:
    names = [
        "nehemiah.rb",
        f"nehemiah-cli-{version}.tgz",
        f"nehemiah-host-bootstrap_{version}.tar.gz",
    ]
    for component in ("nehemiahd", "bc-guest-agent", "bc-gateway"):
        for arch in ARCHES:
            names.append(f"{component}_{version}_linux_{arch}.tar.gz")
    for flavor in ("python", "desktop"):
        for arch in ARCHES:
            names.append(f"nehemiah-guest-{flavor}_{version}_linux_{arch}.ext4.gz")
    for arch in ARCHES:
        names.extend(
            [
                f"nehemiah-guest-scan_{version}_linux_{arch}.json",
                f"nehemiah-host-packages_{version}_ubuntu24.04_linux_{arch}.tar.gz",
                RUNTIME[arch]["firecracker"]["artifact"],
                RUNTIME[arch]["kernel"]["artifact"],
            ]
        )
    return sorted(names)


def runtime_cohort(arch: str, images: dict) -> dict:
    runtime = RUNTIME[arch]
    fields = {
        "contractVersion": 4,
        "arch": arch,
        "pythonSha256": images["python"]["uncompressedSha256"],
        "desktopSha256": images["desktop"]["uncompressedSha256"],
        "kernelSha256": runtime["kernel"]["sha256"],
        "firecrackerSha256": runtime["firecracker"]["firecrackerSha256"],
        "jailerSha256": runtime["firecracker"]["jailerSha256"],
    }
    canonical = (
        "contract_version=4\n"
        f"arch={arch}\n"
        f"python={fields['pythonSha256']}\n"
        f"desktop={fields['desktopSha256']}\n"
        f"kernel={fields['kernelSha256']}\n"
        f"firecracker={fields['firecrackerSha256']}\n"
        f"jailer={fields['jailerSha256']}\n"
    ).encode()
    fields["cohortId"] = hashlib.sha256(canonical).hexdigest()
    return fields


def validate_guest_policy(policy: object) -> None:
    if not isinstance(policy, dict):
        stop("guest image policy is missing")
    if (
        policy.get("contractVersion") != 1
        or policy.get("rootfsProfile") != "signed-developer-ext4-v1"
    ):
        stop("guest image policy contract is unsupported")
    architectures = policy.get("architectures")
    if not isinstance(architectures, dict) or set(architectures) != set(ARCHES):
        stop("guest image architecture policy is invalid")
    for arch in ARCHES:
        base = architectures[arch].get("ociBase", {})
        if (
            not re.fullmatch(r"24\.[0-9]+\.[0-9]+", str(base.get("nodeVersion", "")))
            or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", str(base.get("bundledNpmVersion", "")))
            or not re.fullmatch(
                r"docker\.io/library/node@sha256:[0-9a-f]{64}",
                str(base.get("reference", "")),
            )
        ):
            stop(f"{arch} guest OCI policy is mutable or unsupported")
    snapshot = policy.get("alpineRepositorySnapshot", {})
    if (
        snapshot.get("release") != "v3.23"
        or not isinstance(snapshot.get("maxIndexAgeHours"), int)
        or not 0 < snapshot["maxIndexAgeHours"] <= 168
        or not re.fullmatch(
            r"2026-08-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z",
            str(snapshot.get("capturedAt", "")),
        )
    ):
        stop("guest APK snapshot policy is invalid")
    for arch, apk_arch in (("amd64", "x86_64"), ("arm64", "aarch64")):
        repositories = snapshot.get("architectures", {}).get(arch, {})
        if repositories.get("apkArchitecture") != apk_arch:
            stop(f"{arch} APK architecture is invalid")
        for component in ("main", "community"):
            source = repositories.get(component, {})
            if (
                source.get("url")
                != f"https://dl-cdn.alpinelinux.org/alpine/v3.23/{component}/{apk_arch}/APKINDEX.tar.gz"
                or not SHA256.fullmatch(str(source.get("sha256", "")))
            ):
                stop(f"{arch} {component} APK index is not digest-pinned")
    npm = policy.get("npmRuntime", {})
    if (
        npm.get("version") != "11.19.0"
        or npm.get("tarball", {}).get("url")
        != "https://registry.npmjs.org/npm/-/npm-11.19.0.tgz"
        or not SHA256.fullmatch(str(npm.get("tarball", {}).get("sha256", "")))
    ):
        stop("npm runtime policy is not exact")
    python = policy.get("pythonRuntime", {})
    for name, version in (("pip", "26.2.1"), ("setuptools", "84.0.0")):
        wheel = python.get(name, {})
        if wheel.get("version") != version or not SHA256.fullmatch(str(wheel.get("sha256", ""))):
            stop(f"Python {name} runtime is not exact")


def validate(path: pathlib.Path, version: str, arch: str) -> dict[str, str]:
    try:
        manifest = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        stop("manifest is not valid JSON")
    exact(
        manifest,
        {
            "artifacts",
            "commit",
            "managedCloudInitCompatible",
            "managedHost",
            "repository",
            "schemaVersion",
            "sourceDateEpoch",
            "version",
        },
        "manifest",
    )
    if (
        manifest["schemaVersion"] != 5
        or manifest["managedCloudInitCompatible"] is not True
        or manifest["version"] != version
        or not re.fullmatch(r"[0-9a-f]{40,64}", str(manifest["commit"]))
        or not isinstance(manifest["sourceDateEpoch"], int)
        or manifest["sourceDateEpoch"] <= 0
    ):
        stop("manifest release identity is invalid")
    artifacts = manifest["artifacts"]
    if not isinstance(artifacts, list):
        stop("artifact matrix is invalid")
    names = []
    for artifact in artifacts:
        if not isinstance(artifact, dict) or not SAFE_NAME.fullmatch(str(artifact.get("name", ""))):
            stop("artifact matrix contains an unsafe entry")
        names.append(artifact["name"])
    if names != artifact_names(version):
        stop("manifest does not contain the exact release artifact set")
    host = exact(
        manifest["managedHost"],
        {
            "bootstrapArtifact",
            "contractVersion",
            "guestImagePolicy",
            "guestImages",
            "inputs",
            "packageRepositories",
            "rootfsProfile",
            "runtimeCohorts",
        },
        "managed-host contract",
    )
    if (
        host["contractVersion"] != 4
        or host["bootstrapArtifact"] != f"nehemiah-host-bootstrap_{version}.tar.gz"
        or host["rootfsProfile"] != "signed-developer-ext4-v1"
    ):
        stop("managed-host contract is unsupported")
    validate_guest_policy(host["guestImagePolicy"])
    if not isinstance(host["inputs"], dict) or set(host["inputs"]) != set(ARCHES):
        stop("managed runtime inputs are invalid")
    for candidate in ARCHES:
        if host["inputs"][candidate] != RUNTIME[candidate]:
            stop(f"{candidate} runtime inputs differ from reviewed pins")
    if not isinstance(host["guestImages"], dict) or set(host["guestImages"]) != set(ARCHES):
        stop("managed guest image matrix is invalid")
    for candidate in ARCHES:
        images = host["guestImages"][candidate]
        if not isinstance(images, dict) or set(images) != {"desktop", "python", "scanEvidence"}:
            stop(f"{candidate} guest image set is not exact")
        for flavor, uncompressed, maximum in (
            ("python", 2147483648, 805306368),
            ("desktop", 6442450944, 2147483648),
        ):
            image = exact(
                images[flavor],
                {
                    "artifact",
                    "format",
                    "maxCompressedBytes",
                    "uncompressedBytes",
                    "uncompressedSha256",
                },
                f"{candidate} {flavor} image",
            )
            if (
                image["artifact"]
                != f"nehemiah-guest-{flavor}_{version}_linux_{candidate}.ext4.gz"
                or image["format"] != "ext4.gz"
                or image["uncompressedBytes"] != uncompressed
                or image["maxCompressedBytes"] != maximum
                or not SHA256.fullmatch(str(image["uncompressedSha256"]))
            ):
                stop(f"{candidate} {flavor} image contract is invalid")
        scan = images["scanEvidence"]
        if scan.get("artifact") != f"nehemiah-guest-scan_{version}_linux_{candidate}.json":
            stop(f"{candidate} guest scan evidence is invalid")
        expected_cohort = runtime_cohort(candidate, images)
        if host.get("runtimeCohorts", {}).get(candidate) != expected_cohort:
            stop(f"{candidate} runtime cohort is invalid")
        packages = exact(
            host.get("packageRepositories", {}).get(candidate),
            {
                "artifact",
                "contractVersion",
                "format",
                "manifestSha256",
                "maxBytes",
                "operatingSystem",
                "packageCount",
                "snapshot",
            },
            f"{candidate} package repository",
        )
        if (
            packages["contractVersion"] != 1
            or packages["artifact"]
            != f"nehemiah-host-packages_{version}_ubuntu24.04_linux_{candidate}.tar.gz"
            or packages["format"] != "tar.gz"
            or packages["maxBytes"] != 268435456
            or not SHA256.fullmatch(str(packages["manifestSha256"]))
            or not isinstance(packages["packageCount"], int)
            or not 0 < packages["packageCount"] <= 256
            or packages["operatingSystem"]
            != {"codename": "noble", "id": "ubuntu", "version": "24.04"}
            or packages["snapshot"]
            != {
                "baseUrl": "https://snapshot.ubuntu.com/ubuntu/20260809T000000Z",
                "capturedAt": "2026-08-09T00:00:00Z",
            }
        ):
            stop(f"{candidate} package repository contract is invalid")

    images = host["guestImages"][arch]
    packages = host["packageRepositories"][arch]
    runtime = RUNTIME[arch]
    cohort = host["runtimeCohorts"][arch]
    return {
        "DAEMON_ARTIFACT": f"nehemiahd_{version}_linux_{arch}.tar.gz",
        "AGENT_ARTIFACT": f"bc-guest-agent_{version}_linux_{arch}.tar.gz",
        "HOST_ARTIFACT": host["bootstrapArtifact"],
        "PACKAGE_ARTIFACT": packages["artifact"],
        "PACKAGE_MAX_BYTES": str(packages["maxBytes"]),
        "PACKAGE_MANIFEST_SHA256": packages["manifestSha256"],
        "FIRECRACKER_ARTIFACT": runtime["firecracker"]["artifact"],
        "FIRECRACKER_MAX_BYTES": str(runtime["firecracker"]["maxBytes"]),
        "FIRECRACKER_ARCHIVE_SHA256": runtime["firecracker"]["sha256"],
        "FIRECRACKER_INSTALLED_SHA256": runtime["firecracker"]["firecrackerSha256"],
        "JAILER_INSTALLED_SHA256": runtime["firecracker"]["jailerSha256"],
        "KERNEL_ARTIFACT": runtime["kernel"]["artifact"],
        "KERNEL_MAX_BYTES": str(runtime["kernel"]["maxBytes"]),
        "KERNEL_SHA256": runtime["kernel"]["sha256"],
        "PYTHON_ARTIFACT": images["python"]["artifact"],
        "PYTHON_MAX_BYTES": str(images["python"]["maxCompressedBytes"]),
        "PYTHON_UNCOMPRESSED_BYTES": str(images["python"]["uncompressedBytes"]),
        "PYTHON_SHA256": images["python"]["uncompressedSha256"],
        "DESKTOP_ARTIFACT": images["desktop"]["artifact"],
        "DESKTOP_MAX_BYTES": str(images["desktop"]["maxCompressedBytes"]),
        "DESKTOP_UNCOMPRESSED_BYTES": str(images["desktop"]["uncompressedBytes"]),
        "DESKTOP_SHA256": images["desktop"]["uncompressedSha256"],
        "RUNTIME_COHORT_ID": cohort["cohortId"],
        "RUNTIME_CONTRACT_VERSION": str(cohort["contractVersion"]),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=pathlib.Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--arch", required=True, choices=ARCHES)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    args = parser.parse_args()
    if not re.fullmatch(
        r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?",
        args.version,
    ):
        stop("release version is invalid")
    if args.output.exists() or args.output.is_symlink():
        stop("output already exists")
    values = validate(args.manifest, args.version, args.arch)
    args.output.write_text("".join(f"{key}={value}\n" for key, value in sorted(values.items())))
    args.output.chmod(0o600)


if __name__ == "__main__":
    main()
