## Atlassian MCP OpenAI Proxy (Jira + Confluence)

Dual-port shim that exposes a minimal, stable pair of tools (`search`, `fetch`) for Jira and Confluence while delegating real work to an upstream Atlassian MCP implementation.

Designed specifically as a thin compatibility layer so OpenAI ChatGPT / Claude or any MCP-capable client can safely consume Atlassian data from an upstream like:

Upstream reference implementation: https://github.com/sooperset/mcp-atlassian

Each product launches its own MCP server (using `@modelcontextprotocol/sdk`):

| Local Tool        | Upstream Tool         |
| ----------------- | --------------------- |
| jira:search       | `jira_search`         |
| jira:fetch        | `jira_get_issue`      |
| confluence:search | `confluence_search`   |
| confluence:fetch  | `confluence_get_page` |

The shim registers only those two tools; it does not forward or re‑label arbitrary upstream tools, keeping the surface area predictable for agents.

### How It Works (0.4.0)

1. Local MCP server (per product) registers `search` and `fetch`.
2. When called, it constructs arguments via small delegate mappers and invokes the upstream tool via an MCP client over SSE.
3. Results are mapped to a compact JSON object (id, title, url, text, metadata) and returned as a single text content item.
4. No session persistence beyond in-memory; one local session talks to a shared upstream client instance.

### Current State

Version: 0.4.0 (embedded MCP server again; simplified delegates; removed legacy health endpoint and generic tool filtering logic).

### Rationale

Keep a deliberately tiny stable contract for AI agents (exactly two tools per product) while allowing upstream evolution; minimize token noise and churn.

---

## Quick Start

```bash
npm install
cp .env.example .env
# edit .env (UPSTREAM_MCP_URL=https://your-upstream-host:7000/sse)
npm run build
npm start   # :7100 jira shim, :7200 confluence shim
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

1. Client connects: `GET /sse` on the relevant port.
2. Shim creates (or reuses shared upstream MCP client) and local MCP server emits its own endpoint for `/messages`.
3. Only `search` and `fetch` are listed; no dynamic filtering of upstream tool lists.
4. Tool invocation -> delegate builds upstream arguments -> upstream call -> delegate maps result -> compact JSON returned.
5. SSE only (streamable HTTP left out to stay lean).

---

## Integration with OpenAI ChatGPT (Model Context Protocol)

If you want ChatGPT (or any MCP compatible client) to use Jira / Confluence context, point ChatGPT at this shim instead of the full upstream. The shim keeps the tool surface tiny and stable.

1. Run the upstream Atlassian MCP (e.g. `sooperset/mcp-atlassian`). Note its SSE endpoint (e.g. `https://upstream-host:7000/sse`).
2. Configure this proxy `.env` with `UPSTREAM_MCP_URL` pointing to that SSE endpoint.
3. Start the proxy (this repo). It will expose two MCP servers locally:
	 - Jira: default `http://localhost:7100/sse`
	 - Confluence: default `http://localhost:7200/sse`
4. In ChatGPT MCP configuration (Custom tool / self-hosted MCP) register endpoints you need. Each exposes exactly two tools:
	 - `search`
	 - `fetch`

Example ChatGPT (conceptual JSON snippet):
```jsonc
{
	"mcpServers": {
		"jira": { "url": "http://localhost:7100/sse" },
		"confluence": { "url": "http://localhost:7200/sse" }
	}
}
```

Returned payloads (content[0].text) are compact JSON strings:

Search (jira): `{ "results": [{ "id": "RND-123", "title": "Summary", "url": "https://your.atlassian.net/browse/RND-123" }] }`

Fetch (jira): `{ "id": "RND-123", "title": "Summary", "text": "Summary: ...", "url": "https://your.atlassian.net/browse/RND-123", "metadata": { "source": "jira" } }`

Confluence analogous, with page id and markdown body in `text`.

Why not expose the whole upstream tool list? Smaller surface => lower token noise, simpler prompting and fewer accidental large calls.

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
docker build -t mcp-atlassian-proxy:0.4.0 .
docker run --rm -e UPSTREAM_MCP_URL="https://your-upstream:7000/sse" -p 7100:7100 -p 7200:7200 mcp-atlassian-proxy:0.4.0
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

0.4.0 = Re‑embed MCP server (explicit tool registration). Removed health endpoints. Cleaner delegates.  
0.3.0 = Pure pass‑through proxy variant (now superseded).  
0.2.x = Early experimental structure.

---

## License

MIT
