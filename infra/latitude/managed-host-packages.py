#!/usr/bin/env python3
"""Install and continuously verify the signed managed-host package closure."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile


SHA256 = re.compile(r"[0-9a-f]{64}")
SAFE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+~-]{0,254}")
SAFE_CACHE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9%._+~-]{0,254}")
SAFE_PACKAGE = re.compile(r"[a-z0-9][a-z0-9+.-]{0,127}")
SAFE_VERSION = re.compile(r"[A-Za-z0-9][A-Za-z0-9.+:~_-]{0,255}")
ARCHES = ("amd64", "arm64")
INSTALLED_MANIFEST = pathlib.Path("/var/lib/nehemiahd/managed-host-packages.json")
MAX_ARCHIVE_BYTES = 268435456
MAX_PACKAGE_BYTES = 67108864
MAX_PACKAGE_COUNT = 256
MAX_UNPACKED_BYTES = 1073741824


def stop(message: str) -> "NoReturn":
    raise SystemExit(f"managed host package guard: {message}")


def digest(path: pathlib.Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def exact_keys(value: object, keys: set[str], label: str) -> dict:
    if not isinstance(value, dict) or set(value) != keys:
        stop(f"{label} does not contain the exact key set")
    return value


def validate_manifest(value: object, arch: str, release_version: str | None) -> dict:
    manifest = exact_keys(
        value,
        {
            "architecture",
            "contractVersion",
            "operatingSystem",
            "packageCount",
            "packages",
            "releaseVersion",
            "repository",
            "rootPackages",
            "snapshot",
            "unpackedBytes",
        },
        "manifest",
    )
    if manifest["contractVersion"] != 1 or manifest["architecture"] != arch:
        stop("manifest contract or architecture mismatch")
    if release_version is not None and manifest["releaseVersion"] != release_version:
        stop("manifest release version mismatch")
    if manifest["operatingSystem"] != {
        "codename": "noble",
        "id": "ubuntu",
        "version": "24.04",
    }:
        stop("manifest targets an unsupported host operating system")
    if not isinstance(manifest["releaseVersion"], str) or not re.fullmatch(
        r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?",
        manifest["releaseVersion"],
    ):
        stop("manifest release version is invalid")
    roots = manifest["rootPackages"]
    if (
        not isinstance(roots, list)
        or roots != sorted(set(roots))
        or not roots
        or not all(isinstance(name, str) and SAFE_PACKAGE.fullmatch(name) for name in roots)
    ):
        stop("manifest root package set is unsafe")
    required = {
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
    }
    if not required.issubset(roots):
        stop("manifest omits a required runtime package")
    repository = exact_keys(
        manifest["repository"], {"packagesGzipSha256", "packagesSha256"}, "repository"
    )
    if not all(isinstance(value, str) and SHA256.fullmatch(value) for value in repository.values()):
        stop("manifest repository digest is invalid")
    snapshot = exact_keys(
        manifest["snapshot"], {"baseUrl", "capturedAt", "indexes", "suites"}, "snapshot"
    )
    if (
        not isinstance(snapshot["baseUrl"], str)
        or not re.fullmatch(
            r"https://snapshot\.ubuntu\.com/ubuntu/[0-9]{8}T[0-9]{6}Z",
            snapshot["baseUrl"],
        )
        or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z", snapshot["capturedAt"])
        or not isinstance(snapshot["indexes"], list)
        or len(snapshot["indexes"]) != 6
        or not isinstance(snapshot["suites"], dict)
        or set(snapshot["suites"]) != {"noble", "noble-security", "noble-updates"}
    ):
        stop("manifest snapshot evidence is invalid")
    packages = manifest["packages"]
    if (
        not isinstance(packages, list)
        or not packages
        or len(packages) != manifest["packageCount"]
        or len(packages) > MAX_PACKAGE_COUNT
    ):
        stop("manifest package count is invalid")
    expected_order = sorted(packages, key=lambda item: (item["name"], item["architecture"], item["version"]))
    if packages != expected_order:
        stop("manifest packages are not canonically sorted")
    filenames = set()
    package_names = set()
    for package in packages:
        exact_keys(
            package,
            {
                "architecture",
                "filename",
                "installedBytes",
                "name",
                "sha256",
                "size",
                "sourcePath",
                "version",
            },
            "package",
        )
        source_path = pathlib.PurePosixPath(package["sourcePath"])
        if (
            not isinstance(package["name"], str)
            or not SAFE_PACKAGE.fullmatch(package["name"])
            or package["name"] in package_names
            or not isinstance(package["version"], str)
            or not SAFE_VERSION.fullmatch(package["version"])
            or package["architecture"] not in (arch, "all")
            or not isinstance(package["filename"], str)
            or not SAFE_NAME.fullmatch(package["filename"])
            or package["filename"] in filenames
            or not isinstance(package["sha256"], str)
            or not SHA256.fullmatch(package["sha256"])
            or not isinstance(package["size"], int)
            or not 0 < package["size"] <= MAX_PACKAGE_BYTES
            or not isinstance(package["installedBytes"], int)
            or package["installedBytes"] < 0
            or source_path.is_absolute()
            or ".." in source_path.parts
        ):
            stop("manifest contains an unsafe package entry")
        package_names.add(package["name"])
        filenames.add(package["filename"])
    if (
        not isinstance(manifest["unpackedBytes"], int)
        or manifest["unpackedBytes"] != sum(item["installedBytes"] for item in packages)
        or manifest["unpackedBytes"] > MAX_UNPACKED_BYTES
    ):
        stop("manifest unpacked size is invalid")
    return manifest


def parse_packages(contents: str) -> dict[str, dict[str, str]]:
    result = {}
    for raw in contents.strip().split("\n\n"):
        fields = {}
        current = None
        for line in raw.splitlines():
            if line.startswith((" ", "\t")):
                if current is None:
                    stop("Packages has an orphan continuation")
                fields[current] += "\n" + line
                continue
            if ":" not in line:
                stop("Packages has a malformed field")
            name, value = line.split(":", 1)
            if value.startswith(" "):
                value = value[1:]
            if name in fields:
                stop("Packages has a duplicate field")
            fields[name] = value
            current = name
        filename = fields.get("Filename")
        if not filename or filename in result:
            stop("Packages has a missing or duplicate filename")
        result[filename] = fields
    return result


def command(arguments: list[str], *, environment: dict | None = None) -> str:
    result = subprocess.run(
        arguments,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=environment,
        check=False,
    )
    if result.returncode != 0:
        detail = (result.stdout + "\n" + result.stderr).strip()
        stop(f"command failed ({' '.join(arguments[:3])}): {detail}")
    return result.stdout


def deb_identity(path: pathlib.Path) -> tuple[str, str, str]:
    values = []
    for field in ("Package", "Version", "Architecture"):
        value = command(["dpkg-deb", "--field", str(path), field]).strip()
        if not value or "\n" in value or "\r" in value:
            stop(f"{path.name} has invalid package metadata")
        values.append(value)
    return tuple(values)


def safe_extract(archive: pathlib.Path, destination: pathlib.Path) -> None:
    if not archive.is_file() or archive.is_symlink() or not 0 < archive.stat().st_size <= MAX_ARCHIVE_BYTES:
        stop("package archive is missing, unsafe, or oversized")
    total = 0
    seen = set()
    with tarfile.open(archive, "r:gz") as bundle:
        members = bundle.getmembers()
        if not members or len(members) > MAX_PACKAGE_COUNT + 16:
            stop("package archive entry count is invalid")
        for member in members:
            path = pathlib.PurePosixPath(member.name)
            normalized = str(path)
            if path.is_absolute() or ".." in path.parts or normalized in seen:
                stop("package archive contains an unsafe or duplicate path")
            if not (member.isdir() or member.isfile()):
                stop("package archive contains a non-regular entry")
            seen.add(normalized)
            total += member.size
        if total > MAX_ARCHIVE_BYTES + MAX_UNPACKED_BYTES:
            stop("package archive exceeds the extraction size policy")
        bundle.extractall(destination, members=members, filter="data")


def validate_repository(root: pathlib.Path, manifest: dict) -> None:
    packages_path = root / "repo/Packages"
    packages_gzip_path = root / "repo/Packages.gz"
    if (
        digest(packages_path) != manifest["repository"]["packagesSha256"]
        or digest(packages_gzip_path) != manifest["repository"]["packagesGzipSha256"]
    ):
        stop("repository metadata checksum mismatch")
    try:
        if gzip.decompress(packages_gzip_path.read_bytes()) != packages_path.read_bytes():
            stop("compressed repository metadata does not reproduce Packages")
    except (OSError, gzip.BadGzipFile):
        stop("compressed repository metadata is invalid")
    index = parse_packages(packages_path.read_text())
    expected_files = {
        "manifest.json",
        "repo/Packages",
        "repo/Packages.gz",
        *(f"repo/packages/{package['filename']}" for package in manifest["packages"]),
    }
    actual_files = {
        path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file()
    }
    if actual_files != expected_files:
        stop("package archive does not contain the exact file set")
    if set(index) != {f"packages/{package['filename']}" for package in manifest["packages"]}:
        stop("Packages and manifest file sets differ")
    for package in manifest["packages"]:
        package_path = root / "repo/packages" / package["filename"]
        fields = index[f"packages/{package['filename']}"]
        if (
            package_path.stat().st_size != package["size"]
            or digest(package_path) != package["sha256"]
            or deb_identity(package_path)
            != (package["name"], package["version"], package["architecture"])
            or fields.get("Package") != package["name"]
            or fields.get("Version") != package["version"]
            or fields.get("Architecture") != package["architecture"]
            or fields.get("SHA256") != package["sha256"]
            or fields.get("Size") != str(package["size"])
        ):
            stop(f"retained package identity mismatch: {package['filename']}")


def os_identity() -> tuple[str, str]:
    values = {}
    for line in pathlib.Path("/etc/os-release").read_text().splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            values[key] = value.strip('"')
    return values.get("ID", ""), values.get("VERSION_ID", "")


def install(args: argparse.Namespace) -> None:
    if os.geteuid() != 0:
        stop("installation requires root")
    if args.arch not in ARCHES or not SHA256.fullmatch(args.manifest_sha256):
        stop("invalid expected package identity")
    if os_identity() != ("ubuntu", "24.04"):
        stop("provider base image is not Ubuntu 24.04")
    archive = args.archive.resolve()
    with tempfile.TemporaryDirectory(prefix="nehemiah-package-install-", dir="/var/tmp") as temporary:
        root = pathlib.Path(temporary) / "archive"
        root.mkdir()
        safe_extract(archive, root)
        manifest_path = root / "manifest.json"
        if digest(manifest_path) != args.manifest_sha256:
            stop("package manifest does not match the signed release")
        try:
            manifest = validate_manifest(
                json.loads(manifest_path.read_text()), args.arch, args.release_version
            )
        except (OSError, json.JSONDecodeError):
            stop("package manifest is invalid JSON")
        validate_repository(root, manifest)
        apt_root = pathlib.Path(temporary) / "apt"
        lists = apt_root / "lists"
        archive_cache = apt_root / "archives"
        lists.joinpath("partial").mkdir(parents=True)
        archive_cache.joinpath("partial").mkdir(parents=True)
        empty_parts = apt_root / "apt.conf.d"
        empty_parts.mkdir()
        # --no-download accepts only packages already present in APT's archive
        # cache. Seed that cache from the verified flat repository so neither a
        # misconfiguration nor a maintainer changing APT URI handling can turn
        # this install into a network fetch.
        for package in manifest["packages"]:
            source_package = root / "repo/packages" / package["filename"]
            shutil.copyfile(source_package, archive_cache / package["filename"])
            cache_version = package["version"].replace(":", "%3a")
            cache_name = (
                f"{package['name']}_{cache_version}_{package['architecture']}.deb"
            )
            if not SAFE_CACHE_NAME.fullmatch(cache_name):
                stop("package identity produced an unsafe APT cache name")
            if cache_name != package["filename"]:
                shutil.copyfile(source_package, archive_cache / cache_name)
        source = apt_root / "sources.list"
        source.write_text(f"deb [trusted=yes] file:{root / 'repo'} ./\n")
        options = [
            "-o", "Dir::Etc::main=/dev/null",
            "-o", f"Dir::Etc::parts={empty_parts}",
            "-o", f"Dir::Etc::sourcelist={source}",
            "-o", "Dir::Etc::sourceparts=-",
            "-o", f"Dir::State::lists={lists}",
            "-o", f"Dir::Cache::archives={archive_cache}",
            "-o", "Acquire::Languages=none",
            "-o", "Acquire::Retries=0",
            "-o", "Acquire::http::Proxy=false",
            "-o", "Acquire::https::Proxy=false",
        ]
        environment = {
            **os.environ,
            "APT_CONFIG": "/dev/null",
            "DEBIAN_FRONTEND": "noninteractive",
            "LC_ALL": "C",
        }
        command(["apt-get", *options, "update"], environment=environment)
        exact_packages = [f"{package['name']}={package['version']}" for package in manifest["packages"]]
        command(
            [
                "apt-get",
                "--yes",
                "--no-download",
                "--no-install-recommends",
                "--no-remove",
                "--allow-downgrades",
                "--allow-change-held-packages",
                *options,
                "install",
                *exact_packages,
            ],
            environment=environment,
        )
        INSTALLED_MANIFEST.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary_manifest = INSTALLED_MANIFEST.parent / ".managed-host-packages.json.tmp"
        temporary_manifest.write_bytes(manifest_path.read_bytes())
        os.chown(temporary_manifest, 0, 0)
        temporary_manifest.chmod(0o600)
        temporary_manifest.replace(INSTALLED_MANIFEST)
    verify_installed(args.arch, args.release_version)


def verify_installed(arch: str, release_version: str | None) -> None:
    if arch not in ARCHES:
        stop("invalid installed architecture")
    try:
        stats = INSTALLED_MANIFEST.lstat()
    except OSError:
        stop("installed package manifest is missing")
    if not INSTALLED_MANIFEST.is_file() or INSTALLED_MANIFEST.is_symlink():
        stop("installed package manifest is unsafe")
    if (stats.st_mode & 0o777) != 0o600 or stats.st_uid != 0 or stats.st_gid != 0:
        stop("installed package manifest ownership is unsafe")
    try:
        manifest = validate_manifest(
            json.loads(INSTALLED_MANIFEST.read_text()), arch, release_version
        )
    except (OSError, json.JSONDecodeError):
        stop("installed package manifest is invalid")
    for package in manifest["packages"]:
        result = command(
            [
                "dpkg-query",
                "--show",
                "--showformat=${db:Status-Status}\n${Version}\n${Architecture}\n",
                package["name"],
            ]
        ).splitlines()
        if result != ["installed", package["version"], package["architecture"]]:
            stop(f"installed package drift detected: {package['name']}")
    verification = subprocess.run(
        ["dpkg", "--verify", *(package["name"] for package in manifest["packages"])],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    allowed_missing_prefixes = (
        "/usr/share/doc/",
        "/usr/share/info/",
        "/usr/share/locale/",
        "/usr/share/man/",
    )
    allowed_missing_exact = {
        "/var/cache/apt/archives/partial",
        "/var/lib/apt/lists/partial",
    }
    unexpected = []
    for line in verification.stdout.splitlines():
        match = re.fullmatch(r"missing +(/\S+)", line)
        if match and (
            match.group(1).startswith(allowed_missing_prefixes)
            or match.group(1) in allowed_missing_exact
        ):
            # Provider images may use dpkg path-exclude for documentation and
            # translations. Those files are not executable/runtime inputs;
            # every present file and every non-documentation path remains
            # covered by dpkg's package checksum database.
            continue
        unexpected.append(line)
    if unexpected or verification.stderr.strip():
        stop(
            "installed package file drift detected "
            f"(paths={len(unexpected)}, verifier_error={bool(verification.stderr.strip())})"
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    install_parser = subparsers.add_parser("install")
    install_parser.add_argument("--archive", type=pathlib.Path, required=True)
    install_parser.add_argument("--manifest-sha256", required=True)
    install_parser.add_argument("--arch", required=True)
    install_parser.add_argument("--release-version", required=True)
    install_parser.set_defaults(action=lambda args: install(args))
    verify_parser = subparsers.add_parser("verify-installed")
    verify_parser.add_argument("--arch", required=True)
    verify_parser.add_argument("--release-version")
    verify_parser.set_defaults(action=lambda args: verify_installed(args.arch, args.release_version))
    args = parser.parse_args()
    args.action(args)


if __name__ == "__main__":
    main()
