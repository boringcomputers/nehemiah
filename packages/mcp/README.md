# nehemiah-mcp

An [MCP](https://modelcontextprotocol.io) server that lets Claude Desktop,
Cursor, and other agents launch and drive Boring Computers Cloud or a local
`nehemiahd` machine.

Tools include machine launch/list/stop, deterministic command execution,
short-lived preview URLs, TTL extension, fork, and templates. Local and
self-hosted targets additionally expose volumes, host-local agent-run tasks,
screenshots, publishing, and machine save/restore. The managed-cloud catalog
does not advertise volume creation while the production broker is disabled.

## Boring Computers Cloud

```bash
NEHEMIAH_API_KEY=bc_... \
NEHEMIAH_PROJECT=your-project-id \
npx nehemiah-mcp@beta
```

`NEHEMIAH_URL` overrides the default
`https://api.boringcomputers.com`; `NEHEMIAH_REGION` sets the default region.
Cloud preview URLs use short-lived gateway capabilities issued for the requested
machine and operation. Host-local `run_task` is deliberately absent from the
managed catalog: provider master credentials are not distributed to fleet hosts,
and inference remains disabled until centrally brokered, tenant-attributed cost
admission exists. Use deterministic `run_command` or run a customer-selected
agent inside the guest. The MCP server never prints API keys, authorization
headers, or capability-bearing URLs.

Local/self-hosted agent runs send the bounded task after upgrade in the first
control frame (1–4096 UTF-8 bytes) while retaining query-token compatibility for
the legacy daemon.

Managed guest egress is code-enforced off for the private beta. Hostname and CIDR
rules remain reserved until hard organization, project, and host-network traffic
quotas plus connection-aware hostname enforcement exist. The `internet` boolean
is retained only for legacy local/self-hosted launches.

Managed volumes are likewise production-disabled: the cloud tool catalog omits
volume creation and cloud launches reject a volume attachment locally. The
non-production broker cannot be exposed until revision-count, aggregate
storage, and global transfer admission are complete.

Claude Desktop/Cursor configuration:

```json
{
  "mcpServers": {
    "nehemiah": {
      "command": "npx",
      "args": ["-y", "nehemiah-mcp@beta"],
      "env": {
        "NEHEMIAH_API_KEY": "bc_...",
        "NEHEMIAH_PROJECT": "your-project-id"
      }
    }
  }
}
```

Prefer configuring the key through the MCP client's secret/environment support
instead of checking it into that JSON file.

## Local/self-hosted

The old local flow remains available and defaults to `http://localhost:8080`:

```bash
NEHEMIAH_URL=http://localhost:8088 npx nehemiah-mcp@beta
```

`NEHEMIAH_TOKEN` remains a compatibility alias. Set
`NEHEMIAH_TARGET=self-hosted` explicitly when a self-hosted endpoint also uses
an API key.
