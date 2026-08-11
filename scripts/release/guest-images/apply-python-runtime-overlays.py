#!/usr/bin/env python3
"""Apply digest-verified security overlays to pip's vendored runtime.

The caller verifies both archives before invoking this script.  This script
then accepts only the exact upstream package layouts and exact source snippets
reviewed for the pinned versions.  It intentionally avoids executing either
distribution's build backend.
"""

from __future__ import annotations

import argparse
import json
import shutil
import tarfile
import tempfile
import zipfile
from pathlib import Path, PurePosixPath


MSGPACK_FILES = (
    "__init__.py",
    "exceptions.py",
    "ext.py",
    "fallback.py",
)

SETUPTOOLS_VENDOR_PATH = "pkg_resources/__init__.py"

UPSTREAM_IMPORTS = """sys.path.extend(((vendor_path := os.path.join(os.path.dirname(os.path.dirname(__file__)), 'setuptools', '_vendor')) not in sys.path) * [vendor_path])  # fmt: skip
# workaround for #4476
sys.modules.pop('backports', None)
"""

PIP_IMPORTS = """# pip provides its own isolated dependency namespace.
# workaround for #4476
sys.modules.pop('backports', None)
"""

UPSTREAM_DEPENDENCIES = """import packaging.markers
import packaging.requirements
import packaging.specifiers
import packaging.utils
import packaging.version
from jaraco.text import drop_comment, join_continuation, yield_lines
from platformdirs import user_cache_dir as _user_cache_dir
"""

PIP_DEPENDENCIES = """from pip._vendor import packaging
from pip._vendor.packaging import markers, requirements, specifiers, utils, version
from pip._internal.utils._jaraco_text import (
    drop_comment,
    join_continuation,
    yield_lines,
)
from pip._vendor.platformdirs import user_cache_dir as _user_cache_dir
"""

UPSTREAM_WARNING = """warnings.warn(
    \"pkg_resources is deprecated as an API. \"
    \"See https://setuptools.pypa.io/en/latest/pkg_resources.html. \"
    \"The pkg_resources package is slated for removal as early as \"
    \"2025-11-30. Refrain from using this package or pin to \"
    \"Setuptools<81.\",
    UserWarning,
    stacklevel=2,
)
"""

PIP_WARNING = """# The vendored compatibility module is internal to pip.  Do not emit
# setuptools' public-API deprecation warning when pip imports its fallback.
"""


def fail(message: str) -> None:
    raise SystemExit(message)


def safe_member(name: str) -> bool:
    path = PurePosixPath(name)
    return bool(name) and not path.is_absolute() and ".." not in path.parts


def install_msgpack(archive: Path, destination: Path, version: str) -> None:
    prefix = f"msgpack-{version}/msgpack/"
    expected = {f"{prefix}{name}" for name in MSGPACK_FILES}
    with tarfile.open(archive, mode="r:gz") as bundle:
        members = {member.name: member for member in bundle.getmembers()}
        if any(not safe_member(name) for name in members):
            fail("msgpack overlay contains an unsafe archive entry")
        if not expected.issubset(members):
            fail("msgpack overlay is missing its reviewed pure-Python runtime")
        if any(
            not members[name].isfile() or members[name].size > 2 * 1024 * 1024
            for name in expected
        ):
            fail("msgpack overlay contains an unsafe runtime member")
        with tempfile.TemporaryDirectory(prefix="pip-msgpack-overlay.") as raw:
            staging = Path(raw) / "msgpack"
            staging.mkdir(mode=0o755)
            for name in MSGPACK_FILES:
                member = members[f"{prefix}{name}"]
                source = bundle.extractfile(member)
                if source is None:
                    fail("msgpack overlay member could not be read")
                (staging / name).write_bytes(source.read())
            shutil.rmtree(destination)
            shutil.copytree(staging, destination)


def install_pkg_resources(archive: Path, destination: Path) -> None:
    with zipfile.ZipFile(archive) as bundle:
        infos = bundle.infolist()
        if any(not safe_member(info.filename) for info in infos):
            fail("setuptools overlay contains an unsafe archive entry")
        try:
            info = bundle.getinfo(SETUPTOOLS_VENDOR_PATH)
        except KeyError:
            fail("setuptools overlay is missing pkg_resources")
        if info.file_size <= 0 or info.file_size > 2 * 1024 * 1024:
            fail("setuptools pkg_resources member has an unsafe size")
        source = bundle.read(info).decode("utf-8")

    replacements = (
        (UPSTREAM_IMPORTS, PIP_IMPORTS),
        (UPSTREAM_DEPENDENCIES, PIP_DEPENDENCIES),
        (UPSTREAM_WARNING, PIP_WARNING),
    )
    for old, new in replacements:
        if source.count(old) != 1:
            fail("setuptools overlay no longer matches the reviewed pip patch")
        source = source.replace(old, new)
    destination.write_text(source, encoding="utf-8", newline="\n")


def update_vendor_inventory(path: Path, msgpack_version: str, setuptools_version: str) -> None:
    source = path.read_text(encoding="utf-8")
    replacements = (
        ("msgpack==1.1.2\n", f"msgpack=={msgpack_version}\n"),
        ("setuptools==70.3.0\n", f"setuptools=={setuptools_version}\n"),
    )
    for old, new in replacements:
        if source.count(old) != 1:
            fail("pip vendor inventory no longer matches the reviewed baseline")
        source = source.replace(old, new)
    path.write_text(source, encoding="utf-8", newline="\n")


def update_vendor_sbom(path: Path, msgpack_version: str, setuptools_version: str) -> None:
    document = json.loads(path.read_text(encoding="utf-8"))
    expected = {"msgpack": "1.1.2", "setuptools": "70.3.0"}
    replacement = {
        "msgpack": msgpack_version,
        "setuptools": setuptools_version,
    }
    components = document.get("components")
    if not isinstance(components, list):
        fail("pip vendor SBOM has no component inventory")
    seen: set[str] = set()
    for component in components:
        name = component.get("name") if isinstance(component, dict) else None
        if name not in expected:
            continue
        if name in seen or component.get("version") != expected[name]:
            fail("pip vendor SBOM no longer matches the reviewed baseline")
        old_purl = f"pkg:pypi/{name}@{expected[name]}"
        if component.get("bom-ref") != old_purl or component.get("purl") != old_purl:
            fail("pip vendor SBOM component identity is malformed")
        component["version"] = replacement[name]
        seen.add(name)
    if seen != set(expected):
        fail("pip vendor SBOM is missing a security overlay component")

    old_purls = {f"pkg:pypi/{name}@{version}": name for name, version in expected.items()}

    def replace_purls(value: object) -> object:
        if isinstance(value, str) and value in old_purls:
            name = old_purls[value]
            return f"pkg:pypi/{name}@{replacement[name]}"
        if isinstance(value, list):
            return [replace_purls(item) for item in value]
        if isinstance(value, dict):
            return {key: replace_purls(item) for key, item in value.items()}
        return value

    document = replace_purls(document)
    encoded = json.dumps(document, indent=2, ensure_ascii=False) + "\n"
    for name, old_version in expected.items():
        if old_version in encoded or f"pkg:pypi/{name}@{old_version}" in encoded:
            fail("pip vendor SBOM retained a superseded component")
    path.write_text(encoded, encoding="utf-8", newline="\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--site-packages", required=True, type=Path)
    parser.add_argument("--msgpack-archive", required=True, type=Path)
    parser.add_argument("--msgpack-version", required=True)
    parser.add_argument("--setuptools-wheel", required=True, type=Path)
    parser.add_argument("--setuptools-version", required=True)
    args = parser.parse_args()

    pip_vendor = args.site_packages / "pip" / "_vendor"
    for path in (pip_vendor, args.msgpack_archive, args.setuptools_wheel):
        if not path.exists() or path.is_symlink():
            fail(f"unsafe or missing Python overlay input: {path}")

    install_msgpack(
        args.msgpack_archive,
        pip_vendor / "msgpack",
        args.msgpack_version,
    )
    install_pkg_resources(
        args.setuptools_wheel,
        pip_vendor / "pkg_resources" / "__init__.py",
    )
    update_vendor_inventory(
        pip_vendor / "vendor.txt",
        args.msgpack_version,
        args.setuptools_version,
    )
    update_vendor_sbom(
        pip_vendor / "bom.cdx.json",
        args.msgpack_version,
        args.setuptools_version,
    )


if __name__ == "__main__":
    main()
