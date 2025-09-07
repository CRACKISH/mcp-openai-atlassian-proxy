# MCP OpenAI Atlassian Proxy

Dual shim (Jira + Confluence) that connects to a single upstream Atlassian MCP server and re‑exposes focused tool surfaces for OpenAI / other MCP clients.

Current status: Jira + Confluence search & fetch tools proxied; strong typing and strict lint (no `any`/`unknown`/`never`).

## Features

- One upstream connection reused by two shim endpoints
- Jira shim (default :7100) exposes `search` and `fetch` (issues)
- Confluence shim (default :7200) exposes `search` and `fetch` (pages)
- Clean code style: explicit access modifiers, descriptive names
- Strong JSON value model (no `any` / `unknown` leaks)
- ESLint + Prettier + strict typing

## Tech Stack

- TypeScript (Node.js >= 20)
- Model Context Protocol SDK (@modelcontextprotocol/sdk)
- Express + SSE transport
- ESLint (flat config) + Prettier (tabs width 4)

## Scripts

| Command                | Description                   |
| ---------------------- | ----------------------------- |
| `npm run dev`          | Run in development (ts-node)  |
| `npm run build`        | Compile TypeScript to `dist/` |
| `npm start`            | Run compiled build            |
| `npm run lint`         | Lint sources                  |
| `npm run lint:fix`     | Auto-fix lint issues          |
| `npm run format`       | Prettier write                |
| `npm run format:check` | Prettier check                |
| `npm run typecheck`    | Type check only               |

## Configuration

Environment variables (all string values):

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `UPSTREAM_MCP_URL` | yes | - | Full URL to upstream Atlassian MCP SSE endpoint (e.g. `https://host:7000/sse`) |
| `JIRA_SHIM_PORT` | no | `7100` | Port for Jira shim server |
| `CONFLUENCE_SHIM_PORT` | no | `7200` | Port for Confluence shim server |

Example `.env`:

```env
UPSTREAM_MCP_URL=https://your-atlassian-mcp:7000/sse
JIRA_SHIM_PORT=7100
CONFLUENCE_SHIM_PORT=7200
```

## Running

### Dev (ts-node)

```bash
npm install
cp .env.example .env   # adjust values
npm run dev
```

Health checks:

- Jira: http://localhost:7100/healthz
- Confluence: http://localhost:7200/healthz

### Production build

```bash
npm run build
UPSTREAM_MCP_URL=... node dist/index.js
```

### Docker

Build image:

```bash
docker build -t mcp-atlassian-proxy:local .
```

Run container:

```bash
docker run --rm \
	-e UPSTREAM_MCP_URL="https://your-atlassian-mcp:7000/sse" \
	-e JIRA_SHIM_PORT=7100 \
	-e CONFLUENCE_SHIM_PORT=7200 \
	-p 7100:7100 -p 7200:7200 \
	mcp-atlassian-proxy:local
```

Verify:

```bash
curl http://localhost:7100/healthz
curl http://localhost:7200/healthz
```

### Tool Contracts

Jira `search` returns: `{ objectIds: ["jira:ABC-123", ...] }`

Jira `fetch` returns: `{ resources: [{ objectId, type: 'jira_issue', contentType, content }] }`

Confluence equivalents mirror the pattern with `confluence:<id>` and `type: 'confluence_page'`.

## Roadmap (next)

1. Auth strategy module (tokens / OAuth)
2. Structured logging + log level control
3. Env schema validation
4. Tests (unit + integration harness)
5. Optional caching layer
6. Additional Atlassian surfaces (Crucible placeholder)

## Development

Install deps:

```bash
npm install
```

Dev run (auto TS): `npm run dev`

Build + start: `npm run build && npm start`

## License

MIT
