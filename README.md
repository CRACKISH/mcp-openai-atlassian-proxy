# MCP OpenAI Atlassian Proxy

Proxy / shim server implementing the Model Context Protocol (MCP) to let OpenAI and other MCP compatible clients interact with Atlassian products (Jira, Confluence, Crucible\*).

> _Early scaffold — functionality to be added._

## Goals

- Provide a secure bridge (no direct credentials in the AI client)
- Unified tool abstractions for Jira issues, Confluence pages
- Extensible design for additional Atlassian services

## Tech Stack

- TypeScript (Node.js >= 20)
- MCP server protocol (JSON-RPC over stdio / sockets)
- ESLint + Prettier enforced style

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

## Initial Roadmap

1. Define minimal MCP server harness
2. Implement Atlassian auth module (env/token based)
3. Add Jira issue fetch tool
4. Add Confluence page fetch tool
5. Add batching + pagination helpers
6. Security hardening & config validation
7. Docker image + publish

## Development

Install deps:

```bash
npm install
```

Dev run:

```bash
npm run dev
```

Build:

```bash
npm run build && npm start
```

## License

MIT
