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

### How It Works (0.5.0)

**Now supports both streamable HTTP (default, /mcp) and SSE (legacy, /sse) for MCP protocol.**

**Default:**

- `/mcp` — streamable HTTP (recommended for new clients, lower latency, no session required)
- `/sse` — SSE (legacy, session-based, for compatibility)

**Switching:**

- Use `?transport=sse` to force SSE mode on `/mcp` endpoint
- Use `?transport=http` to force HTTP mode on `/sse` endpoint (not recommended)

**Summary:**

- By default, `/mcp` is preferred and works with any MCP-native client (Claude, OpenAI, etc)
- `/sse` is kept for legacy compatibility

1. Local MCP server (per product) registers `search` and `fetch`.
2. When called, it constructs arguments via small delegate mappers and invokes the upstream tool via an MCP client over SSE.
3. Results are mapped to a compact JSON object (id, title, url, text, metadata) and returned as a single text content item.
4. No session persistence beyond in-memory; one local session talks to a shared upstream client instance.

### Current State

Version: 0.4.1 (lazy + idle upstream connection; refactored utilities; no breaking surface changes).

### Rationale

Keep a deliberately tiny stable contract for AI agents (exactly two tools per product) while allowing upstream evolution; minimize token noise and churn.

---

## Quick Start

```bash
npm install
cp .env .env

# edit .env (UPSTREAM_MCP_URL=https://your-upstream-host:7000/sse)
npm run build
npm start   # :7100 jira shim, :7200 confluence shim
```

**Protocol is selected automatically for upstream:**

- If `UPSTREAM_MCP_URL` ends with `/mcp` or `.mcp` — streamable HTTP (MCP native) is used for upstream.
- If it ends with `/sse` or `.sse` — SSE is used for upstream.
- If not specified — the shim will try both options in order.

**Local endpoints:**

- `http://localhost:7100/mcp` (Jira, streamable HTTP)
- `http://localhost:7100/sse` (Jira, SSE)
- `http://localhost:7200/mcp` (Confluence, streamable HTTP)
- `http://localhost:7200/sse` (Confluence, SSE)

**Switching protocol:**

- `http://localhost:7100/mcp?transport=sse` — force SSE
- `http://localhost:7100/sse?transport=http` — force HTTP (not recommended)

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

1. Client connects: `POST /mcp` (recommended, streamable HTTP) or `GET /sse` (legacy) on the relevant port.
2. Shim creates (or reuses) the upstream MCP client and local MCP server.
3. The proxy automatically determines the protocol for connecting to upstream:
    - `/mcp` or `.mcp` — streamable HTTP (upstream)
    - `/sse` or `.sse` — SSE (upstream)
    - fallback: tries both options
4. Only `search` and `fetch` are listed; no dynamic filtering of upstream tool lists.
5. Tool invocation -> delegate builds upstream arguments -> upstream call -> delegate maps result -> compact JSON returned.

---

## Integration with OpenAI ChatGPT (Model Context Protocol)

If you want ChatGPT (or any MCP compatible client) to use Jira / Confluence context, point ChatGPT at this shim instead of the full upstream. The shim keeps the tool surface tiny and stable.

1. Run the upstream Atlassian MCP (e.g. `sooperset/mcp-atlassian`). Note its SSE endpoint (e.g. `https://upstream-host:7000/sse`).
2. Configure this proxy `.env` with `UPSTREAM_MCP_URL` pointing to that SSE endpoint.
3. Start the proxy (this repo). It will expose two MCP servers locally:
    - Jira: default `http://localhost:7100/mcp` (recommended)
    - Confluence: default `http://localhost:7200/mcp` (recommended)
    - SSE endpoints (`/sse`) are also available for legacy clients
4. In ChatGPT MCP configuration (Custom tool / self-hosted MCP) register endpoints you need. Each exposes exactly two tools:
    - `search`
    - `fetch`

Example ChatGPT (conceptual JSON snippet):

```jsonc
{
	"mcpServers": {
		"jira": { "url": "http://localhost:7100/mcp" },
		"confluence": { "url": "http://localhost:7200/mcp" },
	},
}
```

Returned payloads (content[0].text) are compact JSON strings:

Search (jira, limit 20): `{ "results": [{ "id": "RND-123", "title": "Summary", "url": "https://your.atlassian.net/browse/RND-123" }] }`

Fetch (jira enriched): `{ "id": "RND-123", "title": "Summary", "text": "Summary: ...", "url": "https://your.atlassian.net/browse/RND-123", "metadata": { "source": "jira", "statusObject": {...}, "commentsExcerpt": [...], "<otherRawField>": ... } }`

Confluence analogous (search limit 20). Fetch returns markdown body in `text` plus enriched metadata: `{ source: "confluence", pageMeta: {...}, <otherRawField>: ... }`.

Why not expose the whole upstream tool list? Smaller surface => lower token noise, simpler prompting and fewer accidental large calls.

### Not Included Anymore

| Removed                                  | Reason                                       |
| ---------------------------------------- | -------------------------------------------- |
| Embedded MCPServer / SDK layer           | Proxy does not need to re-implement MCP      |
| Custom pending map JSON-RPC client       | Direct relay; upstream already handles it    |
| Tool description sanitizing & truncation | Preserve original upstream wording           |
| Session limiting flags                   | Simplified (one upstream per client session) |

---

## Example nginx Configuration

An anonymized example nginx config is provided in `examples/nginx.conf`. Use this as a template for your own deployments. See the `examples/README.md` for more details.

## Docker

```bash
docker build -t mcp-atlassian-proxy:0.4.1 .
docker run --rm -e UPSTREAM_MCP_URL="https://your-upstream:7000/sse" -p 7100:7100 -p 7200:7200 mcp-atlassian-proxy:0.4.1
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

0.4.1 = Lazy + idle upstream client (reduces idle resource usage), internal refactors (utils split).  
0.4.0 = Re‑embed MCP server (explicit tool registration). Removed health endpoints. Cleaner delegates.  
0.3.0 = Pure pass‑through proxy variant (now superseded).  
0.2.x = Early experimental structure.

---

## License

MIT
