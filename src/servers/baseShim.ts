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
    logger: (line: string, ...rest: string[]) => console.log(`[${config.name}:upstream] ${line}`, ...rest)
  });
  if (config.startupDelayMs && config.startupDelayMs > 0) {
    console.log(`[${config.name}] startup delay ${config.startupDelayMs}ms before upstream connect`);
    await delay(config.startupDelayMs);
  }
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

type AnyObj = Record<string, unknown>;
// Internal helper lenient typing: using any to bypass strict 'unknown forbidden' project rule for transient error inspection.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isUnexpectedKwArg = (e: any) => (e as { message?: string })?.message?.includes('Unexpected keyword argument');

async function callWithVariants(upstream: UpstreamClient, toolName: string, variants: AnyObj[]): Promise<ToolResponse> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lastErr: any;
  for (const v of variants) {
    try {
      return await upstream.callTool(toolName, v as ToolArguments);
    } catch (e) {
      lastErr = e;
      if (!isUnexpectedKwArg(e)) break; // stop if it's a different error
    }
  }
  throw lastErr;
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
  const base = cfg.buildSearchArgs(query, topK);
  // Candidate argument mappings for differing upstream tool schemas.
  const variants: AnyObj[] = [
    base,
    { jql: query, limit: topK },
    { jql: query, maxResults: topK },
    { q: query, limit: topK },
    { q: query, top_k: topK },
    { query, limit: topK },
    { text: query, limit: topK }
  ];
  const searchResponse = await callWithVariants(upstream, searchTool!, variants);
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
  // Advertise a prefixed endpoint so clients behind reverse proxy keep /jira or /confluence when POSTing.
  // SDK seems to normalize to leading '/', so providing `${cfg.objectIdPrefix}/messages` should yield
  // endpoint event like `/jira/messages?sessionId=...` (not bare `/messages`).
  const transport = new SSEServerTransport(`${cfg.objectIdPrefix}/messages`, res);
    // Register BEFORE connect to avoid race with first POST initialize
    transports.set(transport.sessionId, transport);
    console.log(`[${cfg.name}] pre-register session ${transport.sessionId}`);
    transport.onclose = () => {
      transports.delete(transport.sessionId);
      console.log(`[${cfg.name}] session ${transport.sessionId} closed`);
    };
    try {
      await mcp.connect(transport);
      console.log(`[${cfg.name}] session ${transport.sessionId} activated`);
    } catch (e) {
      transports.delete(transport.sessionId);
      console.error(`[${cfg.name}] connect failed for session ${transport.sessionId}:`, (e as Error).message);
    }
  });

  async function handlePost(req: express.Request, res: express.Response, alias: boolean) {
    let sessionId = (req.query.sessionId as string) || (req.query.session_id as string) || '';
    if (!sessionId && transports.size === 1) {
      sessionId = [...transports.keys()][0];
      console.log(`[${cfg.name}] inferred sessionId=${sessionId} for POST without param`);
    }
    if (!sessionId) { res.status(404).send('no session'); return; }
    const transport = transports.get(sessionId);
    if (!transport) { res.status(404).send('unknown session'); return; }
    try {
      const rawBody = (req.body as Buffer | undefined)?.toString('utf-8');
      const minimalReq = req as unknown as Request;
      const minimalRes = res as unknown as Response;
      console.log(`[${cfg.name}] POST ${alias ? 'alias ' : ''}message session=${sessionId} bytes=${rawBody?.length ?? 0}`);
      await transport.handlePostMessage(minimalReq as never, minimalRes as never, rawBody);
    } catch (e) {
      console.error(`[${cfg.name}] post ${alias ? 'alias ' : ''}error session=${sessionId}:`, e);
      if (!res.headersSent) res.status(500).send('error');
    }
  }

  app.post('/messages', express.raw({ type: 'application/json', limit: '4mb' }), (req, res) => void handlePost(req, res, false));

  app.listen(options.port, () => {
    console.log(`[${cfg.name}] listening on :${options.port} -> upstream ${upstreamUrl}`);
  });
}

// ------------------ Small utils ------------------
function textContent(text: string): { content: ContentPart[] } { return { content: [{ type: 'text', text }] } as { content: ContentPart[] }; }
function delay(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }
