# nehemiah-mcp

An [MCP](https://modelcontextprotocol.io) server that lets any AI spin up and
drive a real Linux computer — a Firecracker microVM from
[Nehemiah](https://boringcomputers.com).

Tools: `launch_computer` (built-ins or your published templates),
`run_command` (run one shell command, get output + exit code back —
deterministic, no agent), `run_task` (give it a plain-English task and an agent
writes + runs the code, returning a live preview URL if it starts a server),
`screenshot`, `preview_url`, `extend_computer` (reset the self-destruct timer),
`fork_computer` (with `count` — N clones from one snapshot, try a different
approach in each), `publish_computer` (freeze a computer as a named template
that boots in milliseconds), `list_templates`, `list_computers`,
`stop_computer`.

It talks to **your own nehemiahd** — there is no public hosted endpoint. Set
`NEHEMIAH_URL` to wherever yours runs (defaults to `http://localhost:8080`, which
is right if nehemiahd is on the same machine or reached over an SSH tunnel; the
Mac/Lima local setup forwards to `http://localhost:8088`). If your nehemiahd sets
`NEHEMIAH_TOKEN`, pass the same value so the server can authenticate.

## Run

```bash
NEHEMIAH_URL=http://localhost:8080 npx nehemiah-mcp
```

(Or from the monorepo source: `node packages/mcp/index.mjs`.)

## Claude Desktop / Cursor

Add to `claude_desktop_config.json` (or Cursor's MCP settings), then ask
_"launch a computer and build me a snake game."_

```json
{
	"mcpServers": {
		"nehemiah": {
			"command": "npx",
			"args": ["-y", "nehemiah-mcp"],
			"env": { "NEHEMIAH_URL": "http://localhost:8080" }
		}
	}
}
```
