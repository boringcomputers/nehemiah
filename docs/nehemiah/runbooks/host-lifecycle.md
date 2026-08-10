# Runbook: managed-host lifecycle and credentials

Use this private fleet-admin procedure for maintenance, suspected compromise,
credential rotation, and permanent host retirement. These endpoints are not part
of the customer OpenAPI.

## Operator authorization

A caller must use a Clerk dashboard session, hold the `owner` or `admin` role in
the selected organization, and have that organization explicitly allowlisted in
`fleet_operator_organizations`. Customer API keys and administrators of ordinary
tenant organizations are denied. Bootstrap the operator organization through the
reviewed database change process:

```sql
INSERT INTO fleet_operator_organizations (organization_id) VALUES ('<operator-org-uuid>');
```

Every accepted lifecycle mutation and authenticated denial is written to the
append-only audit stream. Requests use `Authorization: Bearer <session>` and
`X-Nehemiah-Organization-Id: <operator-org-uuid>`. Never put a credential in a URL.

## Operations

All lifecycle requests accept JSON `{ "reason": "<incident or change reference>" }`.

| Operation | Endpoint | Effect |
| --- | --- | --- |
| Drain | `POST /v1/operator/hosts/{id}/drain` | Stops new placement while retaining credentials and existing-machine routing. A stale host remains non-routable until an explicit transition. |
| Activate | `POST /v1/operator/hosts/{id}/activate` | Clears stale observation data and sets the host unhealthy. It becomes schedulable only after a fresh authenticated healthy heartbeat. |
| Quarantine | `POST /v1/operator/hosts/{id}/quarantine` | Immediately marks the host stale, clears all stored host credential material, blocks routing/placement, and makes active leases eligible for loss reconciliation. |
| Revoke | `POST /v1/operator/hosts/{id}/revoke` | Performs quarantine containment and permanently retires the application identity. It cannot be activated or rotated. |

Credential rotation uses `POST /v1/operator/hosts/{id}/credentials/rotate` with
`control_token`, `gateway_token`, and an optional `reason`. Both supplied tokens
must be independently generated with at least 32 characters. The response returns
a new host-to-control-plane credential exactly once with `Cache-Control: no-store`.
Do not send the request from a shell command that records secrets in history.
Rotation atomically moves an active host to draining/unhealthy before replacing
credential material. It cannot receive placement again until the new credentials
are deployed, a new-generation drained heartbeat is accepted, an operator activates
it, and a subsequent healthy heartbeat makes the observed state ready.

Each successful enrollment or rotation increments `credential_generation`.
Revocation erases the host heartbeat hash plus both encrypted inbound control and
gateway tokens. Credential readers also require an active generation, a permitted
desired lifecycle state, and a non-stale observation, so database races fail closed.

## Maintenance sequence

1. Drain the host and confirm new placement selects another host.
2. Wait for or explicitly stop current tenant machines according to the change plan.
3. Perform maintenance and verify the daemon, KVM, isolation, and overlay health.
4. Activate the host. Confirm it remains `unhealthy` and unschedulable before its
   next heartbeat.
5. Wait for a fresh healthy heartbeat, then perform a synthetic create/ready/exec/
   destroy check before ending the change.

## Compromise recovery

1. Quarantine the host immediately and follow the
   [host-loss runbook](host-loss.md). Remove its WireGuard peer separately; this
   API revokes application credentials but does not mutate network peer inventory.
2. Preserve approved evidence. Do not return a compromised installation directly
   to service.
3. Reimage and generate new control, gateway, and host credentials.
4. Rotate credentials while the host remains quarantined. Deploy the returned host
   credential and the new inbound tokens through the approved secret channel.
5. Activate only after identity and image verification. A fresh heartbeat is still
   required before scheduling resumes.
6. Use permanent revoke instead when the provider host is retired. Re-enrollment
   of the same provider identity is intentionally denied; provision a replacement.

## Verification

- The scheduler sees only `desired_state = active`, active credential generation,
  healthy state, and a fresh heartbeat.
- Gateway and control-plane credential resolvers return nothing for stale,
  quarantined, revoked, or credential-revoked hosts.
- A daemon heartbeat cannot undo drain/quarantine/revoke and cannot revive stale.
- Quarantine/revoke rows contain no credential hash or encrypted token material.
- Audit events include the operator, request ID, action, outcome, host ID, and
  reason code, but never supplied or returned credentials.
