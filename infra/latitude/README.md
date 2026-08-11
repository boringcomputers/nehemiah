# Manual Latitude managed-host runbook

This is the executable provisioning path for an approved beta host. It creates one Latitude bare-metal server, supplies a self-contained cloud-config, enrolls the daemon into the managed control plane, and removes the reusable Latitude user-data record after the server reaches `status=on`.

It is deliberately manual. It does not implement provider autoscaling, capacity reconciliation, or control-plane-driven provisioning. Do not admit tenant workloads until the canary checks below pass.

## Trust and secret boundaries

Use only a published `v<version>` release that completed the protected release workflow. Managed cloud-init requires all of the following before it installs anything from the release:

- a valid Minisign signature over `SHA256SUMS`;
- the exact schema 5 / managed-host contract 4 release manifest and artifact matrix;
- the versioned daemon, guest-agent, and host-bootstrap archives; and
- signed, retained per-architecture Firecracker, jailer, and guest-kernel artifacts with exact SHA-256 pins; and
- signed `python` and `desktop` ext4 images plus their final-filesystem vulnerability-scan evidence; and
- a signed per-architecture Ubuntu 24.04 package closure built from the reviewed immutable snapshot, including its exact package/index identities.

There is no mutable `latest` lookup. The release image builder uses exact
per-architecture Node 24.19 OCI digests, SHA-256-pinned Alpine 3.23 repository
indexes, and SHA-256-pinned npm runtime inputs from the signed manifest.
Cloud-init never resolves apk, network apt, npm, or OCI inputs and has no
minimal-image fallback. It installs host packages only from the selected signed
release's flat repository with `--no-download`, then continuously checks exact
package versions, architecture and non-documentation package files for drift.
The trusted release build is the only step that contacts the reviewed upstream
Firecracker/kernel locations. Provisioning consumes those bytes only from the
immutable signed release, so a fresh host or rollback does not depend on
upstream object retention.

The operator config contains a short-lived, one-use, host-bound enrollment grant and a WireGuard private key. The grant is issued by an allowlisted fleet operator only after the provider identity, region, overlay address, architecture, and exact capacity are known; it is not a reusable control-plane environment secret. The rendered cloud-config contains recoverable base64 encodings of those values. Both files must remain mode 0600. The renderer and provisioner never print credentials or place them in command arguments, but Latitude necessarily receives the cloud-config to install the host. Deleting the API user-data object cannot prove deletion from provider audit logs or backups.

## 1. Prepare private operator inputs

Copy the example outside the checkout and lock it before editing:

```sh
install -d -m 0700 "${XDG_CONFIG_HOME:-$HOME/.config}/nehemiah"
install -m 0600 infra/latitude/managed-host.env.example \
  "${XDG_CONFIG_HOME:-$HOME/.config}/nehemiah/latitude-host.env"
```

Fill every placeholder in that file:

- `NEHEMIAH_RELEASE_BASE` is the release download collection, normally `https://github.com/boringcomputers/nehemiah/releases/download`.
- `NEHEMIAH_RELEASE_VERSION` is an exact tag version without the leading `v`.
- `NEHEMIAH_RELEASE_MINISIGN_KEY` is the reviewed `RW...` public key matching the protected release environment.
- `NEHEMIAH_HOST_ID` and `NEHEMIAH_PROVIDER_ID` are stable, unique identifiers for this approved physical host. Reusing a provider identity after enrollment is rejected.
- `LATITUDE_OS_ID` is an operator-reviewed opaque Latitude operating-system ID;
  the adjacent slug, version and architecture must be copied from the same live
  API record. Before any user-data or billable server request, the provisioner
  re-fetches the bounded OS inventory and requires the exact ID-to-fields match
  plus `LATITUDE_PLAN` membership in `provisionable_on`. It records the selected
  evidence beside the server ID. There is deliberately no default production OS.
- `NEHEMIAH_FLEET_BOOTSTRAP_TOKEN` is the per-host `nhe_...` enrollment grant returned once by `POST /v1/operator/host-enrollments`. It expires in at most 30 minutes and is bound to this file's provider identity, region, overlay address, architecture, and capacity. Never reuse a token or configure it as a control-plane-wide secret.
- `NEHEMIAH_TEMPLATE_OBJECT_ORIGIN` is optional unless durable template transfers
  are enabled. Set it to the exact HTTPS origin produced by presigned template
  URLs (bucket hostname for virtual-hosted S3, endpoint origin for path-style S3).
  The host rejects redirects and every other object origin.
- `NEHEMIAH_ADVERTISE_ADDRESS` is this host's literal managed-overlay address, not its public Latitude address.
- `NEHEMIAH_WIREGUARD_CONTROL_PLANE_ADDRESS` and
  `NEHEMIAH_WIREGUARD_GATEWAY_ADDRESS` are distinct, reviewed overlay host
  addresses for those two roles. They must use the host overlay's address
  family and must not overlap the managed guest subnet.
- `NEHEMIAH_WIREGUARD_CONFIG_B64` is `base64 -w0` of the complete host `wg0.conf`.
  The renderer parses and canonically re-renders exactly one Interface and one
  Peer. The interface must contain only its private key and the advertised host
  address; the peer must contain only its key, bounded endpoint, the exact two
  separately configured CP/gateway host routes, and `PersistentKeepalive = 25`.
  Missing, extra, arbitrary, self, or guest-subnet routes fail closed. Hooks, DNS,
  Table, SaveConfig, comments, duplicate/unknown fields, and broad/default routes
  fail at render, cloud-init and every managed service preflight.
- All nine telemetry values are mandatory. Use an origin-only HTTPS collector
  URL with a DNS hostname, exact `NEHEMIAH_OTEL_ENABLED=true`, bounded export
  settings, the immutable release/service and stable host identities, and a
  per-host authorization credential that is distinct from the fleet,
  daemon-internal, and gateway credentials.
- `NEHEMIAH_ROOT_SSH_AUTHORIZED_KEY_B64` is `base64 -w0` of one recovery **public** SSH key line. Never put an SSH private key here.

The file format is literal `KEY=value`, not shell. Unknown keys, duplicates, shell syntax, unsafe URLs, malformed base64, and loose file permissions fail closed.

Store the Latitude API key in a separate private file:

```sh
install -d -m 0700 "${XDG_CONFIG_HOME:-$HOME/.config}/latitude"
install -m 0600 /dev/stdin "${XDG_CONFIG_HOME:-$HOME/.config}/latitude/api_key"
```

Paste only the API key, then end input with Ctrl-D. The provisioner also accepts `LATITUDE_API_KEY` for ephemeral automation, but the file avoids putting it in a long-lived shell environment.

## 2. Rehearse rendering offline

Rendering makes no network or provider request and refuses to overwrite a path:

```sh
infra/latitude/render-user-data.sh \
  --config "${XDG_CONFIG_HOME:-$HOME/.config}/nehemiah/latitude-host.env" \
  --output "${XDG_CONFIG_HOME:-$HOME/.config}/nehemiah/latitude-user-data.yaml"
```

The output is mode 0600. Delete it securely after review; it is not a harmless public artifact. The equivalent provisioner rehearsal is:

```sh
infra/latitude/provision.sh \
  --config "${XDG_CONFIG_HOME:-$HOME/.config}/nehemiah/latitude-host.env" \
  --output "${XDG_CONFIG_HOME:-$HOME/.config}/nehemiah/latitude-user-data.yaml" \
  --render-only
```

Use a new output pathname for each run because no existing file is overwritten.

## 3. Provision one approved host

Latitude project, SSH-key, plan, site, and hostname values are identifiers rather than credentials. The approved OS identity is read only from the private config above:

```sh
export LATITUDE_PROJECT=proj_...
export LATITUDE_SSH_KEY=ssh_...
export LATITUDE_PLAN=c3-small-x86
export LATITUDE_SITE=MIA2
export LATITUDE_HOSTNAME=nehemiah-metal-01

infra/latitude/provision.sh \
  --config "${XDG_CONFIG_HOME:-$HOME/.config}/nehemiah/latitude-host.env"
```

The provisioner:

1. renders into a private temporary directory;
2. resolves and records the exact approved Latitude OS ID/slug/version/architecture/plan record;
3. creates a one-time Latitude user-data object with base64 content;
4. creates an hourly-billed server referencing that object and the uploaded SSH key;
5. waits for Latitude to report the server online;
6. deletes the reusable user-data API object; and
7. stores the non-secret server ID and mode-0600 provider-image evidence under `${XDG_CONFIG_HOME:-$HOME/.config}/latitude` without overwriting prior records.

It never prints an API response because the create-user-data response echoes decoded credential material. On failure it still attempts to delete the one-time object. A server ID in an error means the hourly-billed server exists; inspect or tear it down promptly.

Cloud-init then verifies the published release, atomically installs the exact
`python` developer and VNC `desktop` ext4 images, validates their signed size,
compression, ext4 type, and filesystem health, installs the pinned host inputs,
verifies their runtime cohort ID (contract, arch and five installed hashes),
configures canonical WireGuard and the isolated guest bridge, starts the daemon, and waits
for durable control-plane enrollment. Only after enrollment does it remove the
fleet token, private bootstrap environment, and cached cloud-init user data.
Success creates `/var/lib/nehemiahd/bootstrap.complete`.

The signed systemd units are managed-only. They require the root-owned
`/etc/boring/nehemiahd.env` and `/etc/boring/managed-host` marker created after
the verified runtime bootstrap, and their command lines hard-pin
`NEHEMIAH_MODE=1` even if the environment file says otherwise. `nehemiahd` is
bound to `boring-net`: a failed or stopped network unit stops the daemon, and
the network unit disables and detaches every guest tap on failed setup or stop.
Local setup scripts install separate `*-local.service` units and never create
the managed marker.

### Recover a lost enrollment response

The grant is consumed in the same database statement that creates or recovers
the host row. If that `201` response is lost before the daemon durably stores its
heartbeat credential, automatic retries correctly fail because the grant cannot
be replayed. This is a manual static-fleet recovery case:

1. Confirm `/var/lib/nehemiahd/enrollment.json` is absent and record the exact
   provider ID, region, overlay address, architecture, and capacity from the
   original operator config. Do not change or recycle the provider identity.
2. From an allowlisted fleet-operator session, issue another
   `POST /v1/operator/host-enrollments` with those exact bindings. The control
   plane reserves the existing pre-heartbeat host ID and revokes any other
   pending grant.
3. Over the recovery SSH channel, stop `nehemiahd`, edit
   `/etc/boring/nehemiahd.env` with a credential-safe editor (do not put the
   returned token in command arguments or shell history), replace only the
   `NEHEMIAH_FLEET_BOOTSTRAP_TOKEN=` value, and retain root ownership and mode
   `0600`.
4. Restart `nehemiahd`. Require a mode-`0600` enrollment file, an accepted fresh
   heartbeat, and automatic removal of the token line from the environment file
   before resuming the canary. Revoke the unused grant through
   `POST /v1/operator/host-enrollments/:id/revoke` if recovery is abandoned.

After the first accepted heartbeat, enrollment is permanently closed; use the
separate operator credential-rotation lifecycle rather than issuing another
enrollment grant.

## 4. Canary acceptance

The provider's `status=on` is not proof that cloud-init or enrollment succeeded. Before workloads are admitted, use the recovery SSH key and confirm:

```sh
test -r /var/lib/nehemiahd/bootstrap.complete
test -r /var/lib/nehemiahd/enrollment.json
test "$(stat -c '%a:%u' /etc/boring/managed-host)" = 400:0
test "$(cat /etc/boring/managed-host)" = nehemiah-managed-host-v1
systemctl is-active --quiet wg-quick@wg0 boring-net nehemiahd
test "$(systemctl show nehemiahd.service -p KillMode --value)" = control-group
test -f /opt/boring/rootfs/rootfs.ext4
test -f /opt/boring/rootfs/desktop.ext4
/opt/boring/bin/managed-host-packages verify-installed \
  --arch "$(dpkg --print-architecture)" --release-version 0.2.0-beta.0
/opt/nehemiah/infra/latitude/verify-isolation.sh
journalctl -u nehemiahd --since=-10m --no-pager
```

Also cold-boot one `python` machine and one `desktop` machine. Require Node 24.19,
npm 11.19, git, curl with a valid CA store, shell and guest-agent exec in both; require
the existing VNC/vsock desktop contract in `desktop`. Confirm the control plane
reports this exact provider identity healthy, the advertised address is the
expected managed-overlay IP, `/dev/kvm` is usable, the one-time user-data record
no longer exists in Latitude, and dnsmasq is DHCP-only while the daemon owns
managed DNS interception. Treat any mismatch as a failed canary.

For the restart canary, create one test machine through the control plane and
record its host-local ID, lease, VMM PID, and
`nehemiah-vmm-<host-local-id>.scope`. Restart `nehemiahd.service`, then require
the same scope and PID to remain active, the daemon to report the same current
lease, and fresh exec/TTY/VNC connections to succeed. Also require a terminal
opened before restart to disconnect without leaking its guest shell and the SDK
reconnect path to open a fresh PTY. Delete the canary through the control plane
and require the exact scope, cgroup, tap, socket, and overlay to disappear.

## 5. Stop billing

Deleting the server is destructive and is the only way to stop its hourly meter:

```sh
infra/latitude/teardown.sh
```

The teardown script reads the private API key and saved server ID from the operator's `.config/latitude` directory and asks for explicit confirmation. If provisioning preserved an older `server_id`, pass the newly printed ID as `LATITUDE_SERVER_ID`.

## Evidence still required outside the repository

Offline tests validate rendering, strict WireGuard grammar, provider-image mismatch denial before billing, API request structure, one-time user-data deletion, exact release filenames, signature-before-manifest ordering, mutable-URL rejection, and exact template-object-origin propagation. They cannot prove current Latitude inventory, provider OS image bytes/attestation, KVM availability, provider retention behavior, live native-arm package installation, WireGuard routing, or a real control-plane heartbeat. Each release/provider-image combination therefore needs an approved no-workload Latitude canary and recorded acceptance evidence before beta use.

## Files

| File                        | Purpose                                                                    |
| --------------------------- | -------------------------------------------------------------------------- |
| `managed-host.env.example`  | Strict operator-input template with no real credentials.                   |
| `render-user-data.sh`       | Offline mode-0600 cloud-config renderer.                                   |
| `provision.sh`              | Manual Latitude user-data/server API flow.                                 |
| `cloud-init.sh`             | Fail-closed signed-release installer and enrollment gate.                  |
| `bootstrap.sh`              | Installs retained release Firecracker/kernel; requires both signed images. |
| `build-rootfs.sh`           | Mutable Alpine builder for local development only; rejects managed use.    |
| `build-desktop-rootfs.sh`   | Mutable desktop builder for local development only; rejects managed use.   |
| `managed-host-preflight.sh` | Exact marker/env ownership gate shared by both managed systemd units.      |
| `net-setup.sh`              | Isolated bridge, DHCP, and egress firewall.                                |
| `boring-net.service`        | Fail-closed managed networking unit; requires verified marker and env.     |
| `nehemiahd.service`         | Managed daemon unit bound to networking; hard-pins managed mode.           |
| `*-local.service`           | Permissive units used only by local/prototype setup scripts.               |
| `verify-isolation.sh`       | On-host network/isolation acceptance checks.                               |
| `teardown.sh`               | Confirmed server deletion to stop billing.                                 |

The older `deploy.sh` and `tunnel.sh` remain local/prototype conveniences. They are not substitutes for the managed signed-release path.
