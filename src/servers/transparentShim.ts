import express from 'express';
import cors from 'cors';
import { Server as MCPServer } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { UpstreamClient } from '../remote/index.js';
import { ToolArguments } from '../types/index.js';

export interface TransparentShimOptions { port: number; upstreamUrl: string; upstreamClient?: UpstreamClient; name: string; version: string; prefix: string }

export async function startTransparentShim(opts: TransparentShimOptions) {
  const upstream = opts.upstreamClient ?? new UpstreamClient({ remoteUrl: opts.upstreamUrl });
  await upstream.connectIfNeeded();

  const mcp = new MCPServer({ name: opts.name, version: opts.version }, { capabilities: { tools: {} } });

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: upstream.listTools().map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema || { type: 'object', properties: {} } }))
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async req => {
    // Schemas guarantee params.name / params.arguments
    const toolName = req.params.name as string;
    const args = (req.params.arguments || {}) as ToolArguments;
    try {
      const result = await upstream.callTool(toolName, args);
      return { content: result.content };
    } catch (e) {
      return { content: [{ type: 'text', text: `error: ${(e as { message?: string }).message || String(e)}` }] };
    }
  });

  const app = express();
  app.use(cors());
  const transports = new Map<string, SSEServerTransport>();

  app.get('/sse', async (_req, res) => {
  const transport = new SSEServerTransport(`${opts.prefix}/messages`, res);
    transports.set(transport.sessionId, transport);
    transport.onclose = () => transports.delete(transport.sessionId);
    try { await mcp.connect(transport); } catch { transports.delete(transport.sessionId); }
  });

  app.post('/messages', express.raw({ type: 'application/json', limit: '4mb' }), async (req, res) => {
    const sid = (req.query.sessionId as string) || (req.query.session_id as string) || [...transports.keys()][0];
    const transport = transports.get(sid);
    if (!transport) { res.status(404).end(); return; }
    const rawBody = (req.body as Buffer | undefined)?.toString('utf-8');
    await (transport as unknown as { handlePostMessage: (r: express.Request, s: express.Response, body?: string) => Promise<void> })
      .handlePostMessage(req, res, rawBody);
  });

  app.listen(opts.port, () => console.log(`[transparent] listening :${opts.port} -> ${opts.upstreamUrl}`));
}