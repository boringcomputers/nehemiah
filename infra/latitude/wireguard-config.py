#!/usr/bin/env python3
"""Strict parser and canonical renderer for the managed WireGuard contract."""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import ipaddress
import pathlib
import re
import sys


KEY_FIELDS = {
    "Interface": ("PrivateKey", "Address"),
    "Peer": ("PublicKey", "Endpoint", "AllowedIPs", "PersistentKeepalive"),
}


def stop(message: str) -> "NoReturn":
    raise SystemExit(f"managed WireGuard config: {message}")


def key(value: str, label: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9+/]{43}=", value):
        stop(f"{label} is not a canonical WireGuard key")
    try:
        decoded = base64.b64decode(value, validate=True)
    except binascii.Error:
        stop(f"{label} is invalid base64")
    if len(decoded) != 32 or decoded == bytes(32):
        stop(f"{label} is invalid")
    return value


def endpoint(value: str) -> str:
    if len(value) > 253 or any(character.isspace() for character in value):
        stop("peer endpoint is invalid")
    host = ""
    port_text = ""
    if value.startswith("["):
        match = re.fullmatch(r"\[([^]]+)]:(\d{1,5})", value)
        if not match:
            stop("peer endpoint is invalid")
        host, port_text = match.groups()
        try:
            parsed_host = ipaddress.ip_address(host)
        except ValueError:
            stop("bracketed peer endpoint must contain IPv6")
        if parsed_host.version != 6:
            stop("bracketed peer endpoint must contain IPv6")
        host = parsed_host.compressed
        rendered = f"[{host}]:{int(port_text)}"
    else:
        if value.count(":") != 1:
            stop("peer endpoint is invalid")
        host, port_text = value.rsplit(":", 1)
        if not re.fullmatch(r"\d{1,5}", port_text):
            stop("peer endpoint port is invalid")
        try:
            parsed_host = ipaddress.ip_address(host)
        except ValueError:
            if (
                not re.fullmatch(
                    r"(?=.{1,253}\Z)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?",
                    host,
                )
                or "." not in host
            ):
                stop("peer endpoint hostname is invalid")
            host = host.lower()
        else:
            if parsed_host.version != 4:
                stop("IPv6 peer endpoints must be bracketed")
            host = parsed_host.compressed
        rendered = f"{host}:{int(port_text)}"
    port = int(port_text)
    if not 1 <= port <= 65535:
        stop("peer endpoint port is out of range")
    return rendered


def canonicalize(
    raw: bytes,
    advertise_address: str,
    control_plane_address: str,
    gateway_address: str,
    guest_subnet: str,
) -> bytes:
    if not raw or len(raw) > 65536 or b"\x00" in raw or b"\r" in raw:
        stop("configuration is empty, oversized, or has unsafe bytes")
    try:
        contents = raw.decode("ascii")
    except UnicodeDecodeError:
        stop("configuration must be ASCII")
    try:
        advertised = ipaddress.ip_address(advertise_address)
    except ValueError:
        stop("advertised address is invalid")
    try:
        control_plane = ipaddress.ip_address(control_plane_address)
        gateway = ipaddress.ip_address(gateway_address)
        guests = ipaddress.ip_network(guest_subnet, strict=True)
    except ValueError:
        stop("approved peer or guest network is invalid")
    approved_routes = (control_plane, gateway)
    if (
        control_plane == gateway
        or guests.version != 4
        or guests.prefixlen != 24
        or any(address.version != advertised.version for address in approved_routes)
        or any(
            address == advertised
            or address.is_unspecified
            or address.is_loopback
            or address.is_link_local
            or address.is_multicast
            or address in guests
            for address in approved_routes
        )
    ):
        stop("approved CP/gateway addresses are unsafe or ambiguous")
    sections: dict[str, dict[str, str]] = {}
    current = None
    observed_order = []
    for line_number, raw_line in enumerate(contents.splitlines(), 1):
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith(("#", ";")):
            stop(f"comments are not permitted (line {line_number})")
        section_match = re.fullmatch(r"\[([A-Za-z]+)]", line)
        if section_match:
            current = section_match.group(1)
            if current not in KEY_FIELDS or current in sections:
                stop(f"unknown or duplicate section on line {line_number}")
            sections[current] = {}
            observed_order.append(current)
            continue
        if current is None:
            stop(f"field appears before a section on line {line_number}")
        field_match = re.fullmatch(r"([A-Za-z]+)\s*=\s*(\S(?:.*\S)?)", line)
        if not field_match:
            stop(f"malformed field on line {line_number}")
        name, value = field_match.groups()
        if name not in KEY_FIELDS[current] or name in sections[current]:
            stop(f"unknown or duplicate {current} field on line {line_number}")
        sections[current][name] = value
    if observed_order != ["Interface", "Peer"]:
        stop("configuration must contain exactly one Interface then one Peer")
    for section, names in KEY_FIELDS.items():
        if set(sections[section]) != set(names):
            stop(f"{section} does not contain the exact field set")

    private_key = key(sections["Interface"]["PrivateKey"], "private key")
    public_key = key(sections["Peer"]["PublicKey"], "peer public key")
    if private_key == public_key:
        stop("interface and peer keys must be distinct")
    try:
        interface = ipaddress.ip_interface(sections["Interface"]["Address"])
    except ValueError:
        stop("interface address is invalid")
    if (
        interface.ip != advertised
        or interface.network.prefixlen != interface.max_prefixlen
        or interface.ip.is_unspecified
        or interface.ip.is_multicast
    ):
        stop("interface address must be the advertised host route")

    routes = []
    route_values = [part.strip() for part in sections["Peer"]["AllowedIPs"].split(",")]
    if not 1 <= len(route_values) <= 8 or any(not value for value in route_values):
        stop("AllowedIPs must contain between one and eight host routes")
    for value in route_values:
        try:
            route = ipaddress.ip_network(value, strict=True)
        except ValueError:
            stop("AllowedIPs contains an invalid route")
        if (
            route.prefixlen != route.max_prefixlen
            or route.network_address == advertised
            or route.network_address.is_unspecified
            or route.network_address.is_multicast
        ):
            stop("AllowedIPs may contain only distinct CP/gateway host routes")
        routes.append(route)
    if len(routes) != len(set(routes)):
        stop("AllowedIPs contains a duplicate route")
    expected_routes = {
        ipaddress.ip_network(f"{address}/{address.max_prefixlen}")
        for address in approved_routes
    }
    if set(routes) != expected_routes:
        stop("AllowedIPs must exactly match the approved CP/gateway host routes")
    routes.sort(key=lambda route: (route.version, int(route.network_address)))
    if sections["Peer"]["PersistentKeepalive"] != "25":
        stop("PersistentKeepalive must be exactly 25")
    peer_endpoint = endpoint(sections["Peer"]["Endpoint"])
    canonical = (
        "[Interface]\n"
        f"PrivateKey = {private_key}\n"
        f"Address = {interface.ip.compressed}/{interface.max_prefixlen}\n"
        "\n"
        "[Peer]\n"
        f"PublicKey = {public_key}\n"
        f"Endpoint = {peer_endpoint}\n"
        f"AllowedIPs = {', '.join(str(route) for route in routes)}\n"
        "PersistentKeepalive = 25\n"
    )
    return canonical.encode()


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    canonical_parser = subparsers.add_parser("canonicalize-base64")
    canonical_parser.add_argument("--advertise-address", required=True)
    verify_parser = subparsers.add_parser("verify")
    verify_parser.add_argument("--advertise-address", required=True)
    verify_parser.add_argument("--expected-sha256", required=True)
    verify_parser.add_argument("--path", required=True, type=pathlib.Path)
    for subparser in (canonical_parser, verify_parser):
        subparser.add_argument("--control-plane-address", required=True)
        subparser.add_argument("--gateway-address", required=True)
        subparser.add_argument("--guest-subnet", required=True)
    args = parser.parse_args()
    if args.command == "canonicalize-base64":
        encoded = sys.stdin.buffer.read()
        if len(encoded) > 131072 or not re.fullmatch(rb"[A-Za-z0-9+/]*={0,2}", encoded):
            stop("encoded configuration is invalid")
        try:
            raw = base64.b64decode(encoded, validate=True)
        except binascii.Error:
            stop("encoded configuration is invalid")
        sys.stdout.buffer.write(
            canonicalize(
                raw,
                args.advertise_address,
                args.control_plane_address,
                args.gateway_address,
                args.guest_subnet,
            )
        )
        return
    if not re.fullmatch(r"[0-9a-f]{64}", args.expected_sha256):
        stop("expected configuration digest is invalid")
    try:
        stats = args.path.lstat()
    except OSError:
        stop("configuration file is missing")
    if not args.path.is_file() or args.path.is_symlink() or (stats.st_mode & 0o777) != 0o600:
        stop("configuration file is unsafe")
    raw = args.path.read_bytes()
    rendered = canonicalize(
        raw,
        args.advertise_address,
        args.control_plane_address,
        args.gateway_address,
        args.guest_subnet,
    )
    if rendered != raw or hashlib.sha256(raw).hexdigest() != args.expected_sha256:
        stop("configuration is not the approved canonical file")


if __name__ == "__main__":
    main()
