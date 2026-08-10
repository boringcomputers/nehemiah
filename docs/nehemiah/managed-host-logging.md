# Managed host logging contract

`nehemiahd` treats its process logs as an operator-facing security boundary in
managed mode. The daemon emits JSON records through the closed event enum in
`nehemiahd/safe_log.go`. A managed event can contain only:

- a reviewed, fixed event name;
- an internally generated UTC timestamp;
- machine IDs that pass the canonical `m-[0-9a-f]{8}` validator;
- positive internal counters, limits, and durations bounded to JSON's exact
  integer range;
- internal booleans; and
- the bounded error classification `none`, `canceled`, `deadline`, `network`,
  or `internal`.

The logger never serializes `error.Error()`, concrete error values, arbitrary
strings, commands, file paths, guest output, Firecracker response bodies,
credentials, request bodies, terminal bytes, or customer file contents. An
invalid identifier is omitted rather than repaired or echoed. A new field or
event requires a review of this allowlist and a canary test.

Managed mode also replaces `net/http`'s default error sink. This prevents the
standard server from echoing panic values, request paths, or connection-error
text around the application logger; it emits the fixed `http_runtime_error`
event instead.

Local/self-hosted mode may retain verbose diagnostics where they are useful to
the operator and where the branch is explicitly guarded by `!NehemiahMode` (or
an equivalent managed-mode early return). That exception does not apply to an
HTTP capability response: for example, VNC dial failures always return the
fixed `vnc_unavailable` code, never the underlying vsock error.

## Verification

`safe_log_test.go` injects a marker containing a secret, customer path,
command, and raw Firecracker-style response. It verifies that the structured
log contains only the fixed event and error class, and that a VNC capability
failure exposes only `vnc_unavailable`. Run the ordinary, race, and vet gates:

```sh
cd nehemiahd
go test ./...
go test -race ./...
go vet ./...
```
