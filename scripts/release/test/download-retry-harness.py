#!/usr/bin/env python3
"""Exercise the snapshot downloader's retry contract with a stubbed opener.

Run by managed-host-packages-download.test.mjs; exits nonzero on any drift.
Covers the transient failures the release builder must survive — 5xx bursts
and bodies truncated mid-stream — plus the failures that must stay immediate
(client errors) and the fail-closed exhaustion path that must leave no
partial artifact behind.
"""

from __future__ import annotations

import http.client
import importlib.util
import io
import pathlib
import sys
import tempfile
import urllib.error

MODULE_PATH = pathlib.Path(__file__).resolve().parents[1] / "managed_host_packages.py"

spec = importlib.util.spec_from_file_location("managed_host_packages", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.time.sleep = lambda seconds: None


class FakeResponse:
    def __init__(self, blocks):
        self.blocks = list(blocks)

    def read(self, size):
        action = self.blocks.pop(0)
        if isinstance(action, Exception):
            raise action
        return action

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeOpener:
    def __init__(self, script):
        self.script = list(script)
        self.calls = 0

    def open(self, request, timeout=None):
        self.calls += 1
        action = self.script.pop(0)
        if isinstance(action, Exception):
            raise action
        return FakeResponse(action)


def run(script):
    opener = FakeOpener(script)
    module.urllib.request.build_opener = lambda *handlers: opener
    with tempfile.TemporaryDirectory() as scratch:
        output = pathlib.Path(scratch) / "artifact"
        try:
            module.download("https://snapshot.ubuntu.com/x", output, 1 << 20)
            return "ok", opener.calls, output.read_bytes()
        except SystemExit as error:
            return "exit", opener.calls, (str(error), output.exists())


def http_error(code):
    return urllib.error.HTTPError("https://x", code, "err", {}, io.BytesIO())


def truncated():
    # One partial block lands in the output file before the stream dies.
    return [b"partial-", http.client.IncompleteRead(b"partial-")]


failures = []


def expect(label, actual, expected):
    if actual != expected:
        failures.append(f"{label}: {actual!r} != {expected!r}")


# A truncated body is retried, the partial file is discarded, and the retry's
# complete payload is exactly what lands on disk.
expect(
    "truncated body retried",
    run([truncated(), [b"payload", b""]]),
    ("ok", 2, b"payload"),
)

# Persistent truncation exhausts the retry budget, fails closed, and leaves
# no partial artifact behind.
status, calls, (message, leftover) = run([truncated()] * 8)
expect(
    "persistent truncation fails closed",
    (status, calls, "snapshot download failed" in message, leftover),
    ("exit", 8, True, False),
)

# 5xx bursts are retried until the mirror recovers.
expect(
    "5xx burst retried",
    run([http_error(503), http_error(502), [b"payload", b""]]),
    ("ok", 3, b"payload"),
)

# Client errors are permanent and must fail on the first attempt.
status, calls, (message, leftover) = run([http_error(404)])
expect(
    "client error fails fast",
    (status, calls, "404" in message, leftover),
    ("exit", 1, True, False),
)

if failures:
    print("download retry contract drifted:", file=sys.stderr)
    for failure in failures:
        print(f"  {failure}", file=sys.stderr)
    raise SystemExit(1)
print("download retry contract holds")
