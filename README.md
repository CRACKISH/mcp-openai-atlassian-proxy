## Atlassian MCP OpenAI Proxy (Jira + Confluence)

Ultra‑thin dual port proxy that makes an existing Atlassian MCP server (e.g. `mcp-atlassian`) look minimal & stable to OpenAI MCP clients.

Per product it exposes only two tool names:

Jira: `search`, `fetch`
Confluence: `search`, `fetch`

Mapped 1:1 to upstream fixed tools:

| Shim Tool         | Upstream Tool         |
| ----------------- | --------------------- |
| jira:search       | `jira_search`         |
| jira:fetch        | `jira_get_issue`      |
| confluence:search | `confluence_search`   |
| confluence:fetch  | `confluence_get_page` |

Everything else is hidden. JSON-RPC payloads are forwarded almost verbatim; only two transformations happen:

1. Upstream `tools/list` response is filtered & tool names rewritten to `search` / `fetch`.
2. Outgoing `tools/call` with `search` / `fetch` are renamed back to upstream tool identifiers.

No local MCP server instance, no additional JSON-RPC logic — just SSE + POST relay with tiny name rewrite.

### Current State

Version: 0.3.0 (pure transparent proxy refactor; removed embedded MCP SDK and custom upstream client class).

### Why

Goal: keep a tiny stable surface for AI agents while delegating everything to the authoritative upstream; cut token noise and avoid unexpected extra tools.

---

## Quick Start

```bash
npm install
cp .env.example .env   # set UPSTREAM_MCP_URL=https://your-upstream-host:7000/sse
npm run build
npm start  # starts :7100 (jira) and :7200 (confluence)
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

1. Client opens `GET /sse` (jira or confluence port). Proxy simultaneously opens upstream `/sse`.
2. On upstream `endpoint` event we emit our own `endpoint` pointing to local `/messages?sessionId=...`.
3. All JSON events are forwarded; when a payload looks like `tools/list` response its `result.tools` is filtered & renamed.
4. Client `POST /messages` JSON-RPC: if `method=tools/call` and `params.name` is `search|fetch` it is rewritten to upstream name; otherwise untouched.
5. Responses flow back unchanged (except the earlier tool-list filtering).
6. One local session = one upstream session; simple in-memory map, no persistence.

### Not Included Anymore

| Removed                                  | Reason                                       |
| ---------------------------------------- | -------------------------------------------- |
| Embedded MCPServer / SDK layer           | Proxy does not need to re-implement MCP      |
| Custom pending map JSON-RPC client       | Direct relay; upstream already handles it    |
| Tool description sanitizing & truncation | Preserve original upstream wording           |
| Session limiting flags                   | Simplified (one upstream per client session) |

---

## Docker

```bash
docker build -t mcp-atlassian-proxy:0.3.0 .
docker run --rm -e UPSTREAM_MCP_URL="https://your-upstream:7000/sse" -p 7100:7100 -p 7200:7200 mcp-atlassian-proxy:0.3.0
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

0.3.0 = Pure proxy (no embedded SDK). If upgrading from 0.2.x nothing to change client‑side; behavior is identical except tool descriptions are no longer truncated.

---

## License

MIT
