# Managed volume object broker

The managed volume broker is implemented for non-production contract testing but
is deliberately disabled in production. Per-object byte bounds alone do not cap
the lifetime number of volumes/revisions or aggregate transfer concurrency across
replicas, so exposing this path would leave storage and network cost unbounded.

When exercised in an isolated test environment, managed volume data crosses the control plane through a bounded streaming broker.
Clients and hosts never receive the S3 service principal, and the API never emits
a raw presigned PUT: ordinary S3 PUT capabilities cannot enforce a maximum body
size.

## Data model

A volume is a tenant-qualified prefix. Each successful PUT creates one immutable
snapshot revision at an exact reservation-derived key:

```text
organizations/<organization UUID>/projects/<project UUID>/volumes/<volume ID>/
  revisions/<write-reservation UUID>.bin
```

Every revision counts toward `used_bytes`; a PUT reservation covers only currently
unallocated bytes, including still-live concurrent grants. The broker allows at
most 5 GiB in one revision (the S3 single-PUT limit), while the control-plane
volume allocation may span multiple revisions up to 1 TiB. A GET grant resolves
the latest successfully completed, checksum-verified revision. Replaying the
same reservation with identical bytes returns 204; different bytes return 409.

The current cloud machine API does **not** yet attach or save managed volumes.
Cloud SDK calls with `volume` remain rejected rather than implying persistence.
The broker makes tenant-safe durable revisions available through the volume grant
API, but a lease-bound host attach/save transport remains required to complete
machine-level volume persistence.

## Transfer contract

`POST /v1/volumes` and `POST /v1/volumes/{id}/grants` return a grant containing:

- an HTTPS `/v1/volume-objects/<opaque ID>` URL with no query credential;
- `x-nehemiah-volume-capability`, a short-lived HS256 token sent only as a header;
- `content-type: application/octet-stream` for PUT;
- `maximum_bytes` for PUT, never larger than the durable reservation or 5 GiB;
- an expiry no more than 900 seconds away.

For PUT, the caller must also send an exact positive `Content-Length` and
`x-nehemiah-content-sha256: sha256:<64 lowercase hex>`. Chunked, encoded, ranged,
and trailer uploads are rejected. The broker streams the body directly to S3,
counts every byte, computes SHA-256 while streaming, and binds the same length,
native SHA-256, `If-None-Match: *`, and `AES256` SSE requirement into PutObject.
It accepts success only when the provider confirms the native checksum and
encryption mode. A provider-accepted mismatch is deleted by exact key/version
before the request fails.

The broker aborts an in-flight stream when its public capability expires. Its
durable byte reservation remains charged for a further 60-second settlement
window, closing the gap in which an ambiguous provider commit becomes visible;
a replacement grant cannot consume those bytes during that window.

GET verifies the tenant metadata, full native checksum, size, content type, and
SSE mode before streaming. Its response includes `Content-Length` and a `Digest`
header. Byte ranges are intentionally unsupported in the beta contract.

The broker path is handled before the ordinary JSON router, so it does not use
the router's 1 MiB buffered request conversion. Proxies must preserve streaming
and the capability/checksum headers. Logs must record only the normalized path
`/v1/volume-objects/[redacted]`; neither the opaque ID nor capability header is
telemetry-safe.

## Configuration (non-production only)

Production configuration rejects the broker group. In test/development, the adapter is enabled only when both the complete `NEHEMIAH_S3_*` group and the
complete broker group are present:

```dotenv
NEHEMIAH_VOLUME_BROKER_URL=https://api.example.com
NEHEMIAH_VOLUME_BROKER_SECRET=<canonical base64 of 32 random bytes>
```

The URL must be an origin-only HTTPS URL. The secret must be distinct from the
host-credential encryption, gateway service, device-code, telemetry, and preview
capability secrets. If either broker value, any required S3 value, or a strict
validation check is missing, the adapter is absent and volume mutations retain
the typed `volume_infrastructure_unavailable` 503 response.

Re-enabling production additionally requires durable organization/project volume
and revision-count quotas, bounded revision discovery/compaction, and global
stream and bandwidth admission for every object transfer.

The S3 service principal is control-plane-only and should be restricted to this
bucket's `organizations/*` namespace with the object list/head/get/put/delete and
version-list/delete actions used by the broker. The provider must implement:

- HTTPS S3 APIs and SSE-S3 reported exactly as `AES256`;
- full native SHA-256 on PutObject, HeadObject, and GetObject;
- conditional `If-None-Match: *` writes;
- consistent prefix listing and version-aware deletion.

An S3-compatible brand name is not sufficient evidence. Providers that omit the
native full checksum, rewrite the encryption metadata, or implement only a
weaker compatibility subset fail closed and require a staging canary before use.

## Retention and deletion

DELETE soft-deletes metadata immediately and keeps the allocation charged for
the seven-day retention window. The PostgreSQL deletion outbox remains pending
until `delete_after`; only then does the worker remove every object version and
delete marker under the exact tenant volume prefix. Delivery uses leased claims,
bounded batches, retries, and idempotent exact-key deletes. Quota is released
only after the deletion result is durable in PostgreSQL.
