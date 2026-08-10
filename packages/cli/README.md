# nehemiah-cli

`bc` manages local, self-hosted, and Boring Computers Cloud machines from one
command line. Cloud is the CLI default.

```bash
export NEHEMIAH_API_KEY=bc_...
export NEHEMIAH_PROJECT=your-project-id

bc machines create --template desktop --size small
bc machines list --json
bc machines exec m_... --command 'uname -a'
bc machines upload m_... ./input.txt --name input.txt
bc machines download m_... /root/output.txt ./output.txt
bc machines tty m_...
bc machines fork m_...
bc machines stop m_...
bc templates list
bc templates delete TEMPLATE_UUID
```

`--template NAME` selects a built-in or named template; `--template-id UUID`
selects a managed published-template record.

File upload requires an explicit local source path and accepts an optional safe
`--name`; the gateway stores it under `/root`. File download requires both an
explicit absolute guest source path and an explicit local destination path.
`--max-bytes`, `--timeout-ms`, and `--ttl` can tighten the SDK limits. Upload
sources must be stable regular files and final-component symlinks are refused.
Downloads are written to a same-directory temporary file, flushed, atomically
renamed, and set to mode `0600`; an existing symlink or non-file destination is
never followed or replaced.

Managed custom-template publication is disabled in production until aggregate
storage quotas and durable object/replica eviction are enforced. The `publish`
subcommand therefore fails locally without an API request. `list` and `delete`
accept `--project`; otherwise the configured `NEHEMIAH_PROJECT` is used. Legacy
single-host publish/list/delete behavior is separate and remains local-only.

Managed Cloud guest networking is hard-disabled for the private beta. Passing
`--allow-cidrs` or `--allow-hostnames` fails locally before the SDK sends a
request on every target. Public local/self-hosted routes retain only the legacy
`--net` switch; they do not implement the managed CIDR-policy contract.

Use `--url` and `--target self-hosted` for another endpoint. `NEHEMIAH_URL`,
`NEHEMIAH_REGION`, and `NEHEMIAH_TARGET` are also supported.

## Credentials

For an interactive cloud login, run `bc login`. The CLI prints a short code and
an HTTPS dashboard URL, opens that validated URL when possible, and polls until
you approve an organization, project, and explicit subset of the requested
scopes. Use `--no-browser` to suppress browser launch; `--json` is fully
noninteractive, emits machine-readable progress records, and never launches a
browser. `bc logout` revokes the remote login before removing it locally.

The rotating refresh credential and bounded short-lived access-token cache are
persisted only in the native operating system credential store (macOS Keychain,
Windows Credential Manager, or Linux Secret Service). For device login, the
JSON config contains a random credential-store account ID and its nonsecret
bound origin, but no token. If the platform store is missing or locked, login fails with
`credential_store_unavailable`; there is no plaintext fallback.

Every persisted refresh credential and API key is bound to the canonical API
origin used when it was saved. A different `--url`, `NEHEMIAH_URL`, or edited
config URL is rejected before the CLI reads a refresh credential or sends a
Bearer header. An API key supplied through `NEHEMIAH_API_KEY` is explicit for
that invocation and may be paired with its invocation's URL.

The verification page must use the API origin, or the exact hosted deployment
relation `https://api.<dashboard-host>` to `https://<dashboard-host>`; loopback
HTTP is allowed only for local development. Other origins, URL credentials,
fragments, and extra query parameters are rejected before browser launch.

Automation should continue to use `NEHEMIAH_API_KEY`. `bc config set-key bc_...
--url https://api.example.com` is also available for the API-key path and stores
the key in the operating system's user config directory; the directory is
user-only and the JSON file is mode `0600`. The CLI never writes credentials to
a repository or project file, and `bc config show` redacts configured
credentials. Run `bc logout` before switching an active device login to a
configured API key.

`bc config set --url` refuses to change an endpoint while any stored credential
is active. To move an API key, explicitly re-bind it with `bc config set-key KEY
--url URL`. To move a device login, run `bc logout` against its bound endpoint,
then `bc login --url URL`. Legacy device logins are migrated automatically only
when they use the known cloud default; other legacy device logins require a new
`bc login`, and legacy saved API keys require `bc config set-key` again.

Every machine command accepts `--json`; failures are emitted as structured JSON
with a stable code, HTTP status, and request ID where available.

If a managed fork is still pending, the command exits successfully with the
durable operation in JSON mode and prints an exact retry command in human mode,
including the original `--count` and `--idempotency-key`.

`bc machines create --oci ...` is not a managed-cloud import path. It returns the
stable typed `not_supported` error before a machine record is created. This
change does not add or alter any direct legacy local daemon behavior and never
attempts an OCI pull.
