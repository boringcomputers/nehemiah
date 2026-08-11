#!/usr/bin/env python3
"""Minimal strict verifier for the prehashed Minisign release envelope.

Managed cloud-init runs before the retained offline package repository has
installed ``minisign``. Ubuntu's base-image bootstrap contract already contains
Python and OpenSSL; this verifier supports only Minisign's current prehashed
Ed25519 form and verifies both the payload and trusted-comment signatures. The
newly installed pinned Minisign package verifies the envelope again afterward.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import pathlib
import re
import subprocess
import tempfile


def stop(message: str) -> "NoReturn":
    raise SystemExit(f"release signature verification failed: {message}")


def decode_exact(value: str, size: int, label: str) -> bytes:
    if not re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", value):
        stop(f"invalid {label} encoding")
    try:
        decoded = base64.b64decode(value, validate=True)
    except binascii.Error:
        stop(f"invalid {label} encoding")
    if len(decoded) != size:
        stop(f"invalid {label} length")
    return decoded


def verify(public_key: str, message: pathlib.Path, signature: pathlib.Path) -> None:
    if not message.is_file() or message.is_symlink() or message.stat().st_size > 1024 * 1024:
        stop("unsafe checksum metadata")
    if not signature.is_file() or signature.is_symlink() or signature.stat().st_size > 65536:
        stop("unsafe signature metadata")
    public_packet = decode_exact(public_key, 42, "public key")
    if public_packet[:2] != b"Ed":
        stop("unsupported public-key algorithm")
    key_id = public_packet[2:10]
    raw_public_key = public_packet[10:]

    try:
        signature_bytes = signature.read_bytes()
        signature_text = signature_bytes.decode("utf-8")
    except (OSError, UnicodeDecodeError):
        stop("signature file is not strict UTF-8")
    if b"\r" in signature_bytes or b"\x00" in signature_bytes or not signature_text.endswith("\n"):
        stop("signature file has invalid line endings")
    lines = signature_text[:-1].split("\n")
    if len(lines) != 4 or not lines[0].startswith("untrusted comment: "):
        stop("signature file has an invalid envelope")
    if not lines[2].startswith("trusted comment: "):
        stop("signature file omits its trusted comment")
    trusted_comment = lines[2][len("trusted comment: ") :]
    if not trusted_comment or len(trusted_comment.encode()) > 1024:
        stop("trusted comment is invalid")
    if not all(character == "\t" or 0x20 <= ord(character) <= 0x7E for character in trusted_comment):
        stop("trusted comment contains non-printable data")

    signature_packet = decode_exact(lines[1], 74, "payload signature")
    if signature_packet[:2] != b"ED":
        stop("legacy or unsupported Minisign signature")
    if signature_packet[2:10] != key_id:
        stop("signature key identifier does not match")
    payload_signature = signature_packet[10:]
    comment_signature = decode_exact(lines[3], 64, "trusted-comment signature")
    payload_hash = hashlib.blake2b(message.read_bytes(), digest_size=64).digest()

    # RFC 8410 SubjectPublicKeyInfo prefix for a raw Ed25519 public key.
    public_der = bytes.fromhex("302a300506032b6570032100") + raw_public_key
    with tempfile.TemporaryDirectory(prefix="nehemiah-minisign-") as temporary:
        directory = pathlib.Path(temporary)
        key_path = directory / "public.der"
        payload_path = directory / "payload.blake2b"
        payload_signature_path = directory / "payload.sig"
        comment_path = directory / "comment"
        comment_signature_path = directory / "comment.sig"
        key_path.write_bytes(public_der)
        payload_path.write_bytes(payload_hash)
        payload_signature_path.write_bytes(payload_signature)
        comment_path.write_bytes(payload_signature + trusted_comment.encode())
        comment_signature_path.write_bytes(comment_signature)
        for data, detached, label in (
            (payload_path, payload_signature_path, "payload"),
            (comment_path, comment_signature_path, "trusted comment"),
        ):
            result = subprocess.run(
                [
                    "openssl",
                    "pkeyutl",
                    "-verify",
                    "-pubin",
                    "-inkey",
                    str(key_path),
                    "-keyform",
                    "DER",
                    "-rawin",
                    "-in",
                    str(data),
                    "-sigfile",
                    str(detached),
                ],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
            if result.returncode != 0:
                stop(f"{label} signature is invalid")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--public-key", required=True)
    parser.add_argument("--message", required=True, type=pathlib.Path)
    parser.add_argument("--signature", required=True, type=pathlib.Path)
    args = parser.parse_args()
    verify(args.public_key, args.message, args.signature)


if __name__ == "__main__":
    main()
