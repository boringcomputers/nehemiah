#!/usr/bin/env python3
"""Build and inspect the signed managed-host offline Debian repository.

Network access is confined to ``build``. ``inspect`` resolves the complete root
package closure against the retained flat repository with an empty dpkg status,
so it cannot accidentally rely on packages installed on the runner.
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import json
import lzma
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request
import zlib


ROOT = pathlib.Path(__file__).resolve().parents[2]
POLICY_PATH = ROOT / "scripts/release/managed-host-packages-policy.json"
SHA256 = re.compile(r"[0-9a-f]{64}")
SAFE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+~-]{0,254}")
SAFE_PACKAGE = re.compile(r"[a-z0-9][a-z0-9+.-]{0,127}")
SAFE_VERSION = re.compile(r"[A-Za-z0-9][A-Za-z0-9.+:~_-]{0,255}")
ARCHES = ("amd64", "arm64")


def fail(message: str) -> "NoReturn":
    raise SystemExit(f"managed host packages: {message}")


def sha256_path(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def canonical_json(value: object) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()


def exact_keys(value: object, keys: set[str], label: str) -> dict:
    if not isinstance(value, dict) or set(value) != keys:
        fail(f"{label} does not contain the exact key set")
    return value


def load_policy() -> dict:
    try:
        policy = json.loads(POLICY_PATH.read_text())
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot read policy: {error}")
    exact_keys(
        policy,
        {
            "architectures",
            "components",
            "contractVersion",
            "limits",
            "operatingSystem",
            "rootPackages",
            "snapshot",
        },
        "policy",
    )
    if policy["contractVersion"] != 1:
        fail("unsupported policy contract")
    operating_system = exact_keys(
        policy["operatingSystem"], {"codename", "id", "version"}, "operating system"
    )
    if operating_system != {"id": "ubuntu", "version": "24.04", "codename": "noble"}:
        fail("managed package policy must target Ubuntu 24.04 noble")
    if policy["architectures"] != list(ARCHES):
        fail("architecture policy is not exact")
    if policy["components"] != ["main", "universe"]:
        fail("component policy is not exact")
    roots = policy["rootPackages"]
    if (
        not isinstance(roots, list)
        or roots != sorted(set(roots))
        or not roots
        or not all(isinstance(name, str) and SAFE_PACKAGE.fullmatch(name) for name in roots)
    ):
        fail("root package set must be nonempty, unique, sorted, and safe")
    required_roots = {
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
    if not required_roots.issubset(roots):
        fail("root package policy omits a managed runtime dependency")
    limits = exact_keys(
        policy["limits"],
        {
            "maxArchiveBytes",
            "maxIndexBytes",
            "maxPackageBytes",
            "maxPackageCount",
            "maxUnpackedBytes",
        },
        "limits",
    )
    bounds = {
        "maxArchiveBytes": 512 * 1024 * 1024,
        "maxIndexBytes": 64 * 1024 * 1024,
        "maxPackageBytes": 128 * 1024 * 1024,
        "maxPackageCount": 512,
        "maxUnpackedBytes": 2 * 1024 * 1024 * 1024,
    }
    for key, ceiling in bounds.items():
        if not isinstance(limits[key], int) or not 0 < limits[key] <= ceiling:
            fail(f"invalid {key}")
    snapshot = exact_keys(
        policy["snapshot"],
        {"baseUrl", "capturedAt", "maxAgeHours", "suites"},
        "snapshot",
    )
    if not re.fullmatch(
        r"https://snapshot\.ubuntu\.com/ubuntu/[0-9]{8}T[0-9]{6}Z", snapshot["baseUrl"]
    ):
        fail("snapshot URL is not an immutable Ubuntu snapshot")
    try:
        captured = dt.datetime.strptime(snapshot["capturedAt"], "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=dt.timezone.utc
        )
    except (TypeError, ValueError):
        fail("snapshot capture timestamp is invalid")
    if not isinstance(snapshot["maxAgeHours"], int) or not 0 < snapshot["maxAgeHours"] <= 168:
        fail("snapshot freshness bound is invalid")
    expected_suites = {"noble", "noble-security", "noble-updates"}
    suites = exact_keys(snapshot["suites"], expected_suites, "snapshot suites")
    for suite, metadata in suites.items():
        exact_keys(metadata, {"inReleaseSha256"}, f"{suite} snapshot metadata")
        if not isinstance(metadata["inReleaseSha256"], str) or not SHA256.fullmatch(
            metadata["inReleaseSha256"]
        ):
            fail(f"{suite} InRelease digest is invalid")
    policy["_captured"] = captured
    return policy


class StrictHTTPSRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        source = urllib.parse.urlsplit(request.full_url)
        target = urllib.parse.urlsplit(newurl)
        if target.scheme != "https" or target.hostname != source.hostname:
            fail("snapshot download attempted an unsafe redirect")
        return super().redirect_request(request, fp, code, msg, headers, newurl)


def download(url: str, output: pathlib.Path, max_bytes: int) -> None:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.query or parsed.fragment:
        fail("unsafe snapshot download URL")
    opener = urllib.request.build_opener(StrictHTTPSRedirect())
    request = urllib.request.Request(url, headers={"User-Agent": "nehemiah-release-builder/1"})
    try:
        with opener.open(request, timeout=60) as response, output.open("xb") as stream:
            total = 0
            while True:
                block = response.read(1024 * 1024)
                if not block:
                    break
                total += len(block)
                if total > max_bytes:
                    fail("snapshot download exceeds its size policy")
                stream.write(block)
    except (OSError, urllib.error.URLError) as error:
        fail(f"snapshot download failed: {error}")
    if output.stat().st_size == 0:
        fail("snapshot returned an empty object")


def parse_release_sha256(contents: str) -> dict[str, tuple[str, int]]:
    marker = "SHA256:\n"
    if marker not in contents:
        fail("InRelease omits SHA256 metadata")
    block = contents.split(marker, 1)[1]
    entries: dict[str, tuple[str, int]] = {}
    for line in block.splitlines():
        match = re.fullmatch(r" ([0-9a-f]{64}) +([0-9]+) (\S+)", line)
        if not match:
            break
        digest, size, name = match.groups()
        if name in entries:
            fail("InRelease contains duplicate SHA256 metadata")
        entries[name] = (digest, int(size))
    return entries


def parse_debian_paragraphs(contents: str) -> list[dict[str, str]]:
    paragraphs: list[dict[str, str]] = []
    for raw in contents.strip().split("\n\n"):
        if not raw.strip():
            continue
        fields: dict[str, str] = {}
        last = None
        for line in raw.splitlines():
            if line.startswith((" ", "\t")):
                if last is None:
                    fail("package metadata has an orphan continuation")
                fields[last] += "\n" + line
                continue
            if ":" not in line:
                fail("package metadata contains a malformed field")
            name, value = line.split(":", 1)
            if value.startswith(" "):
                value = value[1:]
            if name in fields:
                fail("package metadata contains a duplicate field")
            fields[name] = value
            last = name
        paragraphs.append(fields)
    return paragraphs


def render_debian_paragraph(fields: dict[str, str]) -> str:
    return "\n".join(f"{name}: {value}" for name, value in fields.items()) + "\n"


def apt_options(work: pathlib.Path, arch: str, source: pathlib.Path, empty_status: bool) -> list[str]:
    state = work / "apt-state"
    cache = work / "apt-cache"
    etc = work / "apt-etc"
    (state / "lists/partial").mkdir(parents=True, exist_ok=True)
    (cache / "archives/partial").mkdir(parents=True, exist_ok=True)
    etc.mkdir(parents=True, exist_ok=True)
    status = state / "status"
    if empty_status:
        status.write_text("")
    return [
        "-o", f"Dir::Etc::sourcelist={source}",
        "-o", "Dir::Etc::sourceparts=-",
        "-o", f"Dir::State={state}",
        "-o", f"Dir::State::status={status}",
        "-o", f"Dir::Cache={cache}",
        "-o", f"APT::Architecture={arch}",
        "-o", f"APT::Architectures::={arch}",
        "-o", "Acquire::Languages=none",
        "-o", "Acquire::AllowInsecureRepositories=true",
    ]


def run(command: list[str], *, capture: bool = True, env: dict | None = None) -> subprocess.CompletedProcess:
    result = subprocess.run(
        command,
        check=False,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
        env=env,
    )
    if result.returncode != 0:
        detail = ((result.stdout or "") + "\n" + (result.stderr or "")).strip()
        fail(f"command failed ({' '.join(command[:3])}): {detail}")
    return result


def resolve_flat_repository(
    flat: pathlib.Path, roots: list[str], arch: str, work: pathlib.Path
) -> list[str]:
    source = work / "apt-etc/sources.list"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text(f"deb [trusted=yes] file:{flat} ./\n")
    options = apt_options(work, arch, source, True)
    environment = {**os.environ, "LC_ALL": "C", "LANG": "C"}
    run(["apt-get", *options, "update"], env=environment)
    result = run(
        [
            "apt-get",
            "--print-uris",
            "--yes",
            "--no-install-recommends",
            "--download-only",
            *options,
            "install",
            *roots,
        ],
        env=environment,
    )
    filenames: list[str] = []
    flat_prefix = flat.resolve().as_posix().rstrip("/") + "/"
    for line in result.stdout.splitlines():
        match = re.match(r"^'([^']+)' \S+ [0-9]+ (?:MD5Sum|SHA256):", line)
        if not match:
            continue
        uri = urllib.parse.urlsplit(match.group(1))
        decoded_path = urllib.parse.unquote(uri.path)
        if uri.scheme != "file" or uri.netloc or not decoded_path.startswith(flat_prefix):
            fail(f"APT selected a package outside the retained repository: {uri}")
        relative = decoded_path[len(flat_prefix) :]
        if relative.startswith("/") or ".." in pathlib.PurePosixPath(relative).parts:
            fail("APT selected an unsafe package path")
        filenames.append(relative)
    if not filenames or len(filenames) != len(set(filenames)):
        fail("APT returned an empty or duplicate dependency closure")
    return sorted(filenames)


def package_metadata(path: pathlib.Path) -> tuple[str, str, str]:
    values = []
    for field in ("Package", "Version", "Architecture"):
        value = run(["dpkg-deb", "--field", str(path), field]).stdout.strip()
        if not value or "\n" in value or "\r" in value:
            fail(f"{path.name} has invalid Debian metadata")
        values.append(value)
    name, version, arch = values
    if not SAFE_PACKAGE.fullmatch(name) or not SAFE_VERSION.fullmatch(version) or arch not in (*ARCHES, "all"):
        fail(f"{path.name} has unsafe Debian identity metadata")
    return name, version, arch


def validate_build_host(arch: str) -> None:
    native = run(["dpkg", "--print-architecture"]).stdout.strip()
    if native != arch:
        fail(f"production package repositories require a native {arch} runner")
    os_release = {}
    for line in pathlib.Path("/etc/os-release").read_text().splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            os_release[key] = value.strip('"')
    if os_release.get("ID") != "ubuntu" or os_release.get("VERSION_ID") != "24.04":
        fail("production package repositories require an Ubuntu 24.04 runner")


def build(args: argparse.Namespace) -> None:
    policy = load_policy()
    if args.arch not in ARCHES:
        fail("unsupported architecture")
    if not re.fullmatch(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", args.version):
        fail("invalid release version")
    if not args.source_date_epoch.isdigit() or int(args.source_date_epoch) <= 0:
        fail("source-date-epoch must be a positive integer")
    output = pathlib.Path(args.output).resolve()
    if output.exists() or output.is_symlink():
        fail("output already exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    if os.environ.get("NEHEMIAH_PACKAGE_BUILD_TEST_OS") != "1":
        validate_build_host(args.arch)
    now = dt.datetime.now(dt.timezone.utc)
    age = now - policy["_captured"]
    if age.total_seconds() < -3600 or age.total_seconds() > policy["snapshot"]["maxAgeHours"] * 3600:
        fail("Ubuntu snapshot is outside the reviewed freshness window")

    with tempfile.TemporaryDirectory(prefix=".nehemiah-host-packages-", dir=output.parent) as temporary:
        work = pathlib.Path(temporary)
        index_paragraphs: list[dict[str, str]] = []
        index_evidence = []
        base_url = policy["snapshot"]["baseUrl"]
        for suite, suite_policy in sorted(policy["snapshot"]["suites"].items()):
            inrelease = work / f"{suite}.InRelease"
            download(f"{base_url}/dists/{suite}/InRelease", inrelease, 4 * 1024 * 1024)
            if sha256_path(inrelease) != suite_policy["inReleaseSha256"]:
                fail(f"{suite} InRelease digest changed")
            release_entries = parse_release_sha256(inrelease.read_text())
            for component in policy["components"]:
                relative = f"{component}/binary-{args.arch}/Packages.xz"
                if relative not in release_entries:
                    fail(f"{suite} omits {relative}")
                expected_sha, expected_size = release_entries[relative]
                if not 0 < expected_size <= policy["limits"]["maxIndexBytes"]:
                    fail(f"{suite} {relative} violates the index size policy")
                index_path = work / f"{suite}-{component}-Packages.xz"
                download(f"{base_url}/dists/{suite}/{relative}", index_path, expected_size)
                if index_path.stat().st_size != expected_size or sha256_path(index_path) != expected_sha:
                    fail(f"{suite} {relative} does not match pinned InRelease metadata")
                try:
                    unpacked = lzma.decompress(index_path.read_bytes()).decode()
                except (lzma.LZMAError, UnicodeDecodeError) as error:
                    fail(f"cannot decode {suite} {relative}: {error}")
                index_paragraphs.extend(parse_debian_paragraphs(unpacked))
                index_evidence.append(
                    {
                        "component": component,
                        "path": relative,
                        "sha256": expected_sha,
                        "size": expected_size,
                        "suite": suite,
                    }
                )

        flat = work / "flat"
        flat.mkdir()
        combined = "\n".join(render_debian_paragraph(fields) for fields in index_paragraphs)
        (flat / "Packages").write_text(combined)
        selected_paths = resolve_flat_repository(flat, policy["rootPackages"], args.arch, work / "resolve")
        if len(selected_paths) > policy["limits"]["maxPackageCount"]:
            fail("resolved package closure exceeds its count policy")

        by_filename: dict[str, dict[str, str]] = {}
        for fields in index_paragraphs:
            filename = fields.get("Filename")
            if filename:
                if filename in by_filename and fields != by_filename[filename]:
                    fail("snapshot indexes disagree about a package path")
                by_filename[filename] = fields

        stage = work / "stage"
        package_dir = stage / "repo/packages"
        package_dir.mkdir(parents=True)
        selected_fields = []
        manifest_packages = []
        seen_names: set[str] = set()
        unpacked_bytes = 0
        for source_path in selected_paths:
            fields = by_filename.get(source_path)
            if fields is None:
                fail(f"APT selected unindexed package {source_path}")
            required = {"Architecture", "Filename", "Package", "SHA256", "Size", "Version"}
            if not required.issubset(fields):
                fail(f"{source_path} lacks required package metadata")
            expected_sha = fields["SHA256"]
            if not SHA256.fullmatch(expected_sha):
                fail(f"{source_path} has an invalid SHA256")
            try:
                expected_size = int(fields["Size"])
            except ValueError:
                fail(f"{source_path} has an invalid size")
            if not 0 < expected_size <= policy["limits"]["maxPackageBytes"]:
                fail(f"{source_path} violates the package size policy")
            filename = pathlib.PurePosixPath(source_path).name
            if not SAFE_NAME.fullmatch(filename) or filename in seen_names:
                fail("resolved package closure has an unsafe or duplicate filename")
            seen_names.add(filename)
            destination = package_dir / filename
            quoted_path = "/".join(urllib.parse.quote(part, safe="+~._-") for part in source_path.split("/"))
            download(f"{base_url}/{quoted_path}", destination, expected_size)
            if destination.stat().st_size != expected_size or sha256_path(destination) != expected_sha:
                fail(f"{source_path} package bytes do not match the pinned index")
            name, version, package_arch = package_metadata(destination)
            if (name, version, package_arch) != (
                fields["Package"],
                fields["Version"],
                fields["Architecture"],
            ):
                fail(f"{source_path} package identity does not match its index")
            if package_arch not in (args.arch, "all"):
                fail(f"{source_path} has the wrong architecture")
            extracted_size = int(fields.get("Installed-Size", "0")) * 1024
            unpacked_bytes += extracted_size
            rewritten = dict(fields)
            rewritten["Filename"] = f"packages/{filename}"
            selected_fields.append(rewritten)
            manifest_packages.append(
                {
                    "architecture": package_arch,
                    "filename": filename,
                    "installedBytes": extracted_size,
                    "name": name,
                    "sha256": expected_sha,
                    "size": expected_size,
                    "sourcePath": source_path,
                    "version": version,
                }
            )
        if unpacked_bytes > policy["limits"]["maxUnpackedBytes"]:
            fail("resolved package closure exceeds its unpacked size policy")
        manifest_packages.sort(key=lambda item: (item["name"], item["architecture"], item["version"]))
        selected_fields.sort(
            key=lambda fields: (fields["Package"], fields["Architecture"], fields["Version"])
        )
        packages_bytes = (
            "\n".join(render_debian_paragraph(fields) for fields in selected_fields)
        ).encode()
        packages_gzip = gzip.compress(packages_bytes, compresslevel=9, mtime=0)
        (stage / "repo/Packages").write_bytes(packages_bytes)
        (stage / "repo/Packages.gz").write_bytes(packages_gzip)
        manifest = {
            "architecture": args.arch,
            "contractVersion": 1,
            "operatingSystem": policy["operatingSystem"],
            "packageCount": len(manifest_packages),
            "packages": manifest_packages,
            "releaseVersion": args.version,
            "repository": {
                "packagesGzipSha256": hashlib.sha256(packages_gzip).hexdigest(),
                "packagesSha256": hashlib.sha256(packages_bytes).hexdigest(),
            },
            "rootPackages": policy["rootPackages"],
            "snapshot": {
                "baseUrl": base_url,
                "capturedAt": policy["snapshot"]["capturedAt"],
                "indexes": sorted(
                    index_evidence,
                    key=lambda item: (item["suite"], item["component"], item["path"]),
                ),
                "suites": policy["snapshot"]["suites"],
            },
            "unpackedBytes": unpacked_bytes,
        }
        (stage / "manifest.json").write_bytes(canonical_json(manifest))
        archive_name = f"nehemiah-host-packages_{args.version}_ubuntu24.04_linux_{args.arch}.tar.gz"
        if output.name != archive_name:
            fail(f"output filename must be {archive_name}")
        run(
            [
                "tar",
                "--sort=name",
                "--format=ustar",
                "--owner=0",
                "--group=0",
                "--numeric-owner",
                f"--mtime=@{args.source_date_epoch}",
                "--mode=u+rwX,go+rX,go-w",
                "--use-compress-program=gzip -n -9",
                "-cf",
                str(output),
                "-C",
                str(stage),
                ".",
            ]
        )
        if output.stat().st_size > policy["limits"]["maxArchiveBytes"]:
            fail("managed package archive exceeds its size policy")
        output.chmod(0o644)
    inspect_archive(output, args.version, args.arch)


def assert_intact_gzip_stream(archive: pathlib.Path, policy: dict) -> None:
    # tarfile stops reading at the tar end-of-archive marker and never
    # consumes the gzip trailer, so a truncated or tampered tail would
    # otherwise extract and inspect cleanly. Decompress the entire stream
    # (bounded by the extraction policy) so the CRC/length trailer is
    # always validated.
    limit = policy["limits"]["maxArchiveBytes"] + policy["limits"]["maxUnpackedBytes"]
    decompressed = 0
    try:
        with gzip.open(archive, "rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                decompressed += len(block)
                if decompressed > limit:
                    fail("managed package archive exceeds its extraction policy")
    except (OSError, EOFError, zlib.error) as error:
        fail(f"managed package archive gzip stream is corrupt: {error}")


def safe_extract(archive: pathlib.Path, destination: pathlib.Path, policy: dict) -> None:
    assert_intact_gzip_stream(archive, policy)
    total = 0
    seen = set()
    with tarfile.open(archive, "r:gz") as bundle:
        members = bundle.getmembers()
        if not members or len(members) > policy["limits"]["maxPackageCount"] + 16:
            fail("managed package archive has an invalid entry count")
        for member in members:
            path = pathlib.PurePosixPath(member.name)
            normalized = str(path)
            if path.is_absolute() or ".." in path.parts or normalized in seen:
                fail("managed package archive has an unsafe or duplicate path")
            if not (member.isdir() or member.isfile()):
                fail("managed package archive contains a non-regular entry")
            seen.add(normalized)
            total += member.size
        if total > policy["limits"]["maxArchiveBytes"] + policy["limits"]["maxUnpackedBytes"]:
            fail("managed package archive exceeds its extraction policy")
        bundle.extractall(destination, members=members, filter="data")


def validate_manifest(manifest: object, version: str, arch: str, policy: dict) -> dict:
    manifest = exact_keys(
        manifest,
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
        "package manifest",
    )
    if (
        manifest["contractVersion"] != 1
        or manifest["releaseVersion"] != version
        or manifest["architecture"] != arch
        or manifest["operatingSystem"] != policy["operatingSystem"]
        or manifest["rootPackages"] != policy["rootPackages"]
    ):
        fail("package manifest identity does not match the release policy")
    repository = exact_keys(
        manifest["repository"], {"packagesGzipSha256", "packagesSha256"}, "repository metadata"
    )
    if not all(isinstance(value, str) and SHA256.fullmatch(value) for value in repository.values()):
        fail("repository metadata digest is invalid")
    snapshot = exact_keys(
        manifest["snapshot"], {"baseUrl", "capturedAt", "indexes", "suites"}, "snapshot evidence"
    )
    if (
        snapshot["baseUrl"] != policy["snapshot"]["baseUrl"]
        or snapshot["capturedAt"] != policy["snapshot"]["capturedAt"]
        or snapshot["suites"] != policy["snapshot"]["suites"]
        or not isinstance(snapshot["indexes"], list)
        or len(snapshot["indexes"]) != 6
    ):
        fail("package manifest snapshot evidence does not match policy")
    packages = manifest["packages"]
    if (
        not isinstance(packages, list)
        or not packages
        or len(packages) != manifest["packageCount"]
        or len(packages) > policy["limits"]["maxPackageCount"]
    ):
        fail("package manifest package count is invalid")
    if packages != sorted(packages, key=lambda item: (item["name"], item["architecture"], item["version"])):
        fail("package manifest is not canonically sorted")
    names = set()
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
            "package entry",
        )
        if (
            not SAFE_PACKAGE.fullmatch(package["name"])
            or not SAFE_VERSION.fullmatch(package["version"])
            or package["architecture"] not in (arch, "all")
            or not SAFE_NAME.fullmatch(package["filename"])
            or package["filename"] in names
            or not SHA256.fullmatch(package["sha256"])
            or not isinstance(package["size"], int)
            or not 0 < package["size"] <= policy["limits"]["maxPackageBytes"]
            or not isinstance(package["installedBytes"], int)
            or package["installedBytes"] < 0
            or pathlib.PurePosixPath(package["sourcePath"]).is_absolute()
            or ".." in pathlib.PurePosixPath(package["sourcePath"]).parts
        ):
            fail("package manifest contains an unsafe entry")
        names.add(package["filename"])
    if manifest["unpackedBytes"] != sum(package["installedBytes"] for package in packages):
        fail("package manifest unpacked size is inconsistent")
    return manifest


def inspect_archive(archive: pathlib.Path, version: str, arch: str) -> dict:
    policy = load_policy()
    if not archive.is_file() or archive.is_symlink() or archive.stat().st_size == 0:
        fail("managed package archive is missing or unsafe")
    if archive.stat().st_size > policy["limits"]["maxArchiveBytes"]:
        fail("managed package archive exceeds its size policy")
    with tempfile.TemporaryDirectory(prefix="nehemiah-package-inspect-") as temporary:
        extracted = pathlib.Path(temporary) / "archive"
        extracted.mkdir()
        safe_extract(archive, extracted, policy)
        manifest_path = extracted / "manifest.json"
        try:
            manifest = validate_manifest(json.loads(manifest_path.read_text()), version, arch, policy)
        except (OSError, json.JSONDecodeError) as error:
            fail(f"invalid package manifest: {error}")
        package_index = extracted / "repo/Packages"
        package_index_gzip = extracted / "repo/Packages.gz"
        if (
            sha256_path(package_index) != manifest["repository"]["packagesSha256"]
            or sha256_path(package_index_gzip) != manifest["repository"]["packagesGzipSha256"]
            or gzip.decompress(package_index_gzip.read_bytes()) != package_index.read_bytes()
        ):
            fail("retained repository metadata digest mismatch")
        expected_files = {
            "manifest.json",
            "repo/Packages",
            "repo/Packages.gz",
            *(f"repo/packages/{package['filename']}" for package in manifest["packages"]),
        }
        actual_files = {
            path.relative_to(extracted).as_posix() for path in extracted.rglob("*") if path.is_file()
        }
        if actual_files != expected_files:
            fail("managed package archive does not contain the exact artifact set")
        index_by_filename = {}
        for fields in parse_debian_paragraphs(package_index.read_text()):
            filename = fields.get("Filename")
            if not filename or filename in index_by_filename:
                fail("retained Packages index has a missing or duplicate filename")
            index_by_filename[filename] = fields
        if set(index_by_filename) != {
            f"packages/{package['filename']}" for package in manifest["packages"]
        }:
            fail("retained Packages index does not match the package manifest")
        for package in manifest["packages"]:
            path = extracted / "repo/packages" / package["filename"]
            if path.stat().st_size != package["size"] or sha256_path(path) != package["sha256"]:
                fail(f"retained package {package['filename']} digest mismatch")
            if package_metadata(path) != (
                package["name"],
                package["version"],
                package["architecture"],
            ):
                fail(f"retained package {package['filename']} identity mismatch")
            fields = index_by_filename[f"packages/{package['filename']}"]
            if (
                fields.get("Package") != package["name"]
                or fields.get("Version") != package["version"]
                or fields.get("Architecture") != package["architecture"]
                or fields.get("SHA256") != package["sha256"]
                or fields.get("Size") != str(package["size"])
            ):
                fail(f"retained package {package['filename']} index mismatch")
        resolved = resolve_flat_repository(
            extracted / "repo", manifest["rootPackages"], arch, pathlib.Path(temporary) / "resolve"
        )
        if resolved != sorted(f"packages/{package['filename']}" for package in manifest["packages"]):
            fail("offline APT resolution does not reproduce the exact package closure")
        return manifest


def inspect(args: argparse.Namespace) -> None:
    manifest = inspect_archive(pathlib.Path(args.archive).resolve(), args.version, args.arch)
    if args.print_manifest_sha256:
        print(hashlib.sha256(canonical_json(manifest)).hexdigest())
    else:
        print(
            f"verified managed host package closure: {args.arch} "
            f"{manifest['packageCount']} packages"
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    build_parser = subparsers.add_parser("build")
    build_parser.add_argument("--version", required=True)
    build_parser.add_argument("--arch", required=True)
    build_parser.add_argument("--output", required=True)
    build_parser.add_argument("--source-date-epoch", required=True)
    build_parser.set_defaults(function=build)
    inspect_parser = subparsers.add_parser("inspect")
    inspect_parser.add_argument("--archive", required=True)
    inspect_parser.add_argument("--version", required=True)
    inspect_parser.add_argument("--arch", required=True)
    inspect_parser.add_argument("--print-manifest-sha256", action="store_true")
    inspect_parser.set_defaults(function=inspect)
    args = parser.parse_args()
    args.function(args)


if __name__ == "__main__":
    main()
