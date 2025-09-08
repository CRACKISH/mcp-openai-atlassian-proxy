import express, { Request, Response } from 'express';
import cors from 'cors';
import { Server as MCPServer } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { UpstreamClient } from '../remote/index.js';
import { ContentPart, ToolArguments, ToolResponse, JsonValue } from '../types/index.js';

export interface ShimOptions { port: number; upstreamUrl: string; upstreamClient?: UpstreamClient }

export interface ShimConfig {
  name: string;              // e.g. 'jira-shim'
  version: string;           // e.g. '0.1.0'
  objectIdPrefix: string;    // 'jira' | 'confluence'
  resourceType: string;      // 'jira_issue' | 'confluence_page'
  searchDescription: string; // description for search tool
  fetchDescription: string;  // description for fetch tool
  startupDelayMs?: number;   // optional delay before starting HTTP
  // Predicates to discover upstream tool names
  searchToolPredicate: (toolNameLower: string) => boolean;
  getToolPredicate: (toolNameLower: string) => boolean;
  // Build upstream arguments
  buildSearchArgs: (query: string, topK?: number) => ToolArguments;
  buildFetchArgs: (id: string) => ToolArguments;
  // Extract search IDs from upstream search ToolResponse.content
  extractIds: (content: JsonValue[]) => string[];
  // Parse fetched content (first JSON etc.)
  parseFetched: (content: JsonValue[]) => JsonValue | null;
}

export async function startShim(config: ShimConfig, options: ShimOptions) {
  const upstream = options.upstreamClient ?? new UpstreamClient({
    remoteUrl: options.upstreamUrl,
    logger: (line: string, ...rest: string[]) => console.log(`[${config.name}] ${line}`, ...rest)
  });
  await upstream.connectIfNeeded();

  const searchTool = upstream.findToolName(n => config.searchToolPredicate(n));
  const getTool = upstream.findToolName(n => config.getToolPredicate(n));

  const mcp = new MCPServer(
    { name: config.name, version: config.version },
    { capabilities: { tools: {} } }
  );

  // List tools (generic schema reused)
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'search',
        description: config.searchDescription,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            topK: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
          },
            required: ['query']
        }
      },
      {
        name: 'fetch',
        description: config.fetchDescription,
        inputSchema: {
          type: 'object',
          properties: { objectIds: { type: 'array', items: { type: 'string' }, minItems: 1 } },
          required: ['objectIds']
        }
      }
    ]
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async rawReq => {
    if (!upstream.isConnected()) return textContent('Upstream not connected');
    const { name, args } = normalizeToolCall(rawReq);
    try {
      if (name === 'search') return handleSearch(upstream, searchTool, args, config);
      if (name === 'fetch') return handleFetch(upstream, getTool, args, config);
      return textContent(`Unknown tool: ${name}`);
    } catch (e) {
      const message = (e as { message?: string })?.message || String(e);
      return textContent(`${config.name} error: ${message}`);
    }
  });

  if (config.startupDelayMs) await delay(config.startupDelayMs);
  startHttpServer(config, options, mcp, searchTool, getTool, upstream.options.remoteUrl);
}

// ------------------ Handlers ------------------

function normalizeToolCall(rawReq: object): { name: string; args: ToolArguments } {
  interface ToolCallLike { params?: { name?: string; arguments?: ToolArguments }; name?: string; arguments?: ToolArguments }
  const req = rawReq as ToolCallLike;
  return { name: req.params?.name || req.name || '', args: req.params?.arguments || req.arguments || {} };
}

function assertTool(toolName: string | null, label: string, shimName: string) {
  if (!toolName) throw new Error(`No upstream ${shimName} ${label} tool`);
}

async function handleSearch(
  upstream: UpstreamClient,
  searchTool: string | null,
  args: ToolArguments,
  cfg: ShimConfig
) {
  assertTool(searchTool, 'search', cfg.objectIdPrefix);
  const query = String(args.query || '');
  const topK = (args.topK as number | undefined) || 20;
  const searchResponse = await upstream.callTool(searchTool!, cfg.buildSearchArgs(query, topK));
  const rawContent = (searchResponse as ToolResponse).content || [];
  const jsonValues: JsonValue[] = Array.isArray(rawContent)
    ? rawContent.map(v => (v as unknown as JsonValue))
    : [];
  const ids = cfg.extractIds(jsonValues);
  return { content: [{ type: 'json', data: { objectIds: ids.map(id => `${cfg.objectIdPrefix}:${id}`) } }] };
}

async function handleFetch(
  upstream: UpstreamClient,
  getTool: string | null,
  args: ToolArguments,
  cfg: ShimConfig
) {
  assertTool(getTool, 'get', cfg.objectIdPrefix);
  const objectIds = parseObjectIds(args.objectIds as JsonValue);
  const resources = await Promise.all(objectIds.map(id => fetchOne(upstream, getTool!, id, cfg)));
  return { content: [{ type: 'json', data: { resources } }] };
}

function parseObjectIds(maybe: JsonValue): string[] {
  return Array.isArray(maybe) && maybe.every(v => typeof v === 'string') ? (maybe as string[]) : [];
}

async function fetchOne(
  upstream: UpstreamClient,
  tool: string,
  rawObjectId: string,
  cfg: ShimConfig
) {
  const id = rawObjectId.replace(new RegExp(`^${cfg.objectIdPrefix}:`, 'i'), '');
  const resp = await upstream.callTool(tool, cfg.buildFetchArgs(id));
  const rawContent = resp.content || [];
  const jsonValues: JsonValue[] = Array.isArray(rawContent)
    ? rawContent.map(v => (v as unknown as JsonValue))
    : [];
  const parsed = cfg.parseFetched(jsonValues);
  return { objectId: `${cfg.objectIdPrefix}:${id}`, type: cfg.resourceType, contentType: 'application/json', content: parsed ?? null };
}

// ------------------ HTTP layer ------------------
function startHttpServer(
  cfg: ShimConfig,
  options: ShimOptions,
  mcp: MCPServer,
  searchTool: string | null,
  getTool: string | null,
  upstreamUrl: string
) {
  const app = express();
  app.use(cors());
  let connectionSeq = 0;
  // Active SSE transports by sessionId (so POSTs can be routed)
  const transports = new Map<string, SSEServerTransport>();

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, upstream: upstreamUrl, searchTool, getTool, prefix: cfg.objectIdPrefix });
  });

  app.get('/sse', async (_req, res) => {
    const req = _req;
    const id = ++connectionSeq;
    const ipHeader = (req.headers['x-forwarded-for'] as string | undefined) || req.socket.remoteAddress || 'unknown';
    const ip = ipHeader.split(',')[0].trim();
    const ua = (req.headers['user-agent'] as string | undefined) || '';
    console.log(`[${cfg.name}] connect #${id} ip=${ip} ua="${ua}"`);
    res.on('close', () => console.log(`[${cfg.name}] disconnect #${id}`));
    const transport = new SSEServerTransport('/sse', res);
    await mcp.connect(transport);
    transports.set(transport.sessionId, transport);
    console.log(`[${cfg.name}] session ${transport.sessionId} established`);
    // Remove when closed
    transport.onclose = () => {
      transports.delete(transport.sessionId);
      console.log(`[${cfg.name}] session ${transport.sessionId} closed`);
    };
  });

  // Accept POST messages: /sse?sessionId=...
  app.post('/sse', express.raw({ type: 'application/json', limit: '4mb' }), async (req, res) => {
    let sessionId = (req.query.sessionId as string) || '';
    // If no sessionId provided but exactly one active session exists, assume that one (helps some clients)
    if (!sessionId && transports.size === 1) {
      sessionId = [...transports.keys()][0];
      console.log(`[${cfg.name}] inferred sessionId=${sessionId} for POST without param`);
    }
    if (!sessionId) {
      // Return 404 so http-first clients gracefully fallback to SSE only instead of treating as protocol error
      res.status(404).send('no session');
      return;
    }
    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(404).send('unknown session');
      return;
    }
    try {
      // Express raw middleware sets req.body as Buffer
      const rawBody = (req.body as Buffer | undefined)?.toString('utf-8');
      // Cast to the minimal shape required by handlePostMessage without using 'any'
      const minimalReq = req as unknown as Request;
      const minimalRes = res as unknown as Response;
      await transport.handlePostMessage(minimalReq as never, minimalRes as never, rawBody);
    } catch (e) {
      console.error(`[${cfg.name}] post error session=${sessionId}:`, e);
      if (!res.headersSent) res.status(500).send('error');
    }
  });

  app.listen(options.port, () => {
    console.log(`[${cfg.name}] listening on :${options.port} -> upstream ${upstreamUrl}`);
  });
}

// ------------------ Small utils ------------------
function textContent(text: string): { content: ContentPart[] } { return { content: [{ type: 'text', text }] } as { content: ContentPart[] }; }
function delay(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }
