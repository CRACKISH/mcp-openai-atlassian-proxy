## Atlassian MCP Passthrough (Jira + Confluence)

Minimal dual MCP shim that exposes only two stable tool names per product:

Jira: `search`, `fetch`
Confluence: `search`, `fetch`

Each is a direct passthrough to fixed upstream tools:

| Shim Tool         | Upstream Tool         |
| ----------------- | --------------------- |
| jira:search       | `jira_search`         |
| jira:fetch        | `jira_get_issue`      |
| confluence:search | `confluence_search`   |
| confluence:fetch  | `confluence_get_page` |

No wrapping of responses. Arguments + schemas are forwarded exactly as provided by the upstream Atlassian MCP server. Output content array is returned unchanged.

### Current State

Version: 0.2.0 (breaking simplification – removed legacy base shim, resource/objectId abstraction, transparent mode, dynamic probing logic).

### Why

You only need the original tool contracts but under short stable names so AI clients can rely on a tiny surface. Everything else (all other upstream tools) is hidden to reduce noise and prompt token usage.

---

## Quick Start

```bash
npm install
cp .env.example .env   # set UPSTREAM_MCP_URL=https://your-upstream-host:7000/sse
npm run build
npm start
```

Health:

```
GET http://localhost:7100/healthz   # jira
GET http://localhost:7200/healthz   # confluence
```

### Required Env

| Var                | Description                                                            |
| ------------------ | ---------------------------------------------------------------------- |
| `UPSTREAM_MCP_URL` | Full SSE endpoint of upstream MCP (accepts with/without trailing /sse) |

Optional:

| Var                    | Default | Description          |
| ---------------------- | ------- | -------------------- |
| `JIRA_SHIM_PORT`       | 7100    | Jira shim port       |
| `CONFLUENCE_SHIM_PORT` | 7200    | Confluence shim port |

Example `.env`:

```env
UPSTREAM_MCP_URL=https://mcp-atlassian.internal:7000/sse
JIRA_SHIM_PORT=7100
CONFLUENCE_SHIM_PORT=7200
```

---

## Behavior

1. On startup each shim establishes its own upstream SSE session.
2. `tools/list` returns exactly two tools; their `inputSchema` is the upstream schema (sanitized description).
3. `tools/call` forwards arguments verbatim; returned `content` is not altered.
4. Logging: only the four proxied upstream tools are logged (sanitized single line).
5. No retries/adaptive variants – if upstream rejects, error text is returned directly.

### Not Included Anymore

| Removed                                      | Reason                                 |
| -------------------------------------------- | -------------------------------------- |
| Resource wrapping (`objectIds`, `resources`) | Unnecessary indirection                |
| Dynamic tool discovery predicates            | Fixed upstream tool names now known    |
| Transparent universal shim                   | Out of scope for minimal dual setup    |
| Base generic shim abstraction                | Added complexity, no remaining benefit |

---

## Docker

```bash
docker build -t mcp-atlassian-proxy:0.2.0 .
docker run --rm -e UPSTREAM_MCP_URL="https://your-upstream:7000/sse" -p 7100:7100 -p 7200:7200 mcp-atlassian-proxy:0.2.0
```

---

## Development

| Script              | Purpose            |
| ------------------- | ------------------ |
| `npm run dev`       | ts-node dev mode   |
| `npm run build`     | build to `dist/`   |
| `npm start`         | run compiled shims |
| `npm run lint`      | lint               |
| `npm run typecheck` | type-only check    |

---

## Versioning

0.2.0 = Breaking cleanup. If you previously relied on `objectIds`/`resources`, migrate to using upstream schemas directly (same args you would send to original Atlassian MCP tools).

---

## License

MIT
