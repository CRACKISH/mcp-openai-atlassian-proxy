# MCP OpenAI Atlassian Proxy

![CI](https://github.com/CRACKISH/mcp-openai-atlassian-proxy/actions/workflows/docker-build-push.yml/badge.svg)

Dual shim (Jira + Confluence) that connects to a single upstream Atlassian MCP server (e.g. `sooperset/mcp-atlassian`) and re‑exposes a minimal, opinionated tool surface for OpenAI / other MCP clients.

Current status: Stable single-path (no legacy / debug modes) Jira + Confluence `search` + `fetch`; strict typing (no `any`/`unknown` leaks) and clean output.

## Features

- Single upstream MCP SSE connection reused by both shims
- Jira shim (default :7100) exposes `search` + `fetch` (issues)
- Confluence shim (default :7200) exposes `search` + `fetch` (pages)
- No experimental probing / legacy fallbacks: only the new MCP spec (`initialize`, `notifications/initialized`, `tools/list`, `tools/call`)
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

| Variable               | Required | Default | Description                                                                    |
| ---------------------- | -------- | ------- | ------------------------------------------------------------------------------ |
| `UPSTREAM_MCP_URL`     | yes      | -       | Full URL to upstream Atlassian MCP SSE endpoint (e.g. `https://host:7000/sse`) |
| `JIRA_SHIM_PORT`       | no       | `7100`  | Port for Jira shim server                                                      |
| `CONFLUENCE_SHIM_PORT` | no       | `7200`  | Port for Confluence shim server                                                |

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

Jira `search` -> `{ objectIds: ["jira:ABC-123", ...] }`

Jira `fetch` -> `{ resources: [{ objectId, type: 'jira_issue', contentType, content }] }`

Confluence `search` -> `{ objectIds: ["confluence:12345", ...] }`

Confluence `fetch` -> `{ resources: [{ objectId, type: 'confluence_page', contentType, content }] }`

## Roadmap (next)

1. Authentication (PAT / OAuth pluggable module)
2. Structured logging + log level
3. Env schema validation
4. Test suite (unit + integration)
5. Optional caching layer
6. Additional Atlassian surfaces (Crucible, Bitbucket)

## Development

Install deps:

```bash
npm install
```

Dev run (auto TS): `npm run dev`

Build + start: `npm run build && npm start`

## License

MIT
