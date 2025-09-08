import express from 'express';
import cors from 'cors';
import { Server as MCPServer } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ListPromptsRequestSchema, ListResourcesRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { UpstreamClient } from '../remote/index.js';
import { ToolArguments } from '../types/index.js';

export interface ConfluenceShimOptions { port: number; upstreamUrl: string; upstreamClient?: UpstreamClient }

const CONF_SEARCH = 'confluence_search';
const CONF_GET = 'confluence_get_page';

export async function startConfluenceShim(opts: ConfluenceShimOptions) {
	const startDelay = Number(process.env.SHIM_START_DELAY_MS || 500);
	if (startDelay > 0) await new Promise(r => setTimeout(r, startDelay));
	const upstream = opts.upstreamClient ?? new UpstreamClient({ remoteUrl: opts.upstreamUrl, monitorTools: [CONF_SEARCH, CONF_GET] });
	await upstream.connectIfNeeded();

	const mcp = new MCPServer({ name: 'confluence-shim', version: '0.2.0' }, { capabilities: { tools: {}, prompts: {}, resources: {} } });

	mcp.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
	mcp.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));

	mcp.setRequestHandler(ListToolsRequestSchema, async () => {
		const tools = upstream.listTools();
		const searchInfo = tools.find(t => t.name === CONF_SEARCH);
		const getInfo = tools.find(t => t.name === CONF_GET);
		return {
			tools: [
				{ name: 'search', description: searchInfo?.description || 'Confluence search', inputSchema: searchInfo?.inputSchema || { type: 'object', properties: {} } },
				{ name: 'fetch', description: getInfo?.description || 'Confluence page fetch', inputSchema: getInfo?.inputSchema || { type: 'object', properties: {} } }
			]
		};
	});

	mcp.setRequestHandler(CallToolRequestSchema, async req => {
		const tool = req.params.name as string;
		const args = (req.params.arguments || {}) as ToolArguments;
		try {
			if (tool === 'search') {
				const r = await upstream.callTool(CONF_SEARCH, args);
				return { content: r.content };
			}
			if (tool === 'fetch') {
				const r = await upstream.callTool(CONF_GET, args);
				return { content: r.content };
			}
			return { content: [{ type: 'text', text: `unknown tool ${tool}` }] };
		} catch (e) {
			return { content: [{ type: 'text', text: `confluence error: ${(e as { message?: string }).message || String(e)}` }] };
		}
	});

	const app = express();
	app.use(cors());
	const transports = new Map<string, SSEServerTransport>();

	app.get('/healthz', (_req, res) => res.json({ ok: true, upstream: opts.upstreamUrl, search: CONF_SEARCH, fetch: CONF_GET }));

	app.get('/sse', async (_req, res) => {
		res.setHeader('Content-Type', 'text/event-stream');
		res.setHeader('Cache-Control', 'no-cache');
		res.setHeader('Connection', 'keep-alive');
		res.setHeader('X-Accel-Buffering', 'no');
		(res as unknown as { flushHeaders?: () => void }).flushHeaders?.();
		try { res.write(': open confluence\n\n'); } catch { /* ignore */ }

		if (process.env.STRICT_SINGLE_SESSION && transports.size) {
			res.write('event: error\n');
			res.write('data: another session active\n\n');
			res.end();
			return;
		}

		if (process.env.SINGLE_SESSION && transports.size) {
			for (const [id, old] of transports.entries()) {
				try { (old as unknown as { close?: () => void }).close?.(); } catch { /* ignore */ }
				transports.delete(id);
			}
		}

		const transport = new SSEServerTransport('confluence/messages', res);
		transports.set(transport.sessionId, transport);

		// Manual immediate endpoint emit BEFORE mcp.connect to eliminate client-side initialize timeouts
		try {
			const path = `/confluence/messages?sessionId=${encodeURIComponent(transport.sessionId)}`;
			res.write('event: endpoint\n');
			res.write(`data: ${path}\n\n`);
			// Force flush the endpoint event immediately
			if (typeof (res as any).flush === 'function') (res as any).flush();
		} catch { /* ignore */ }

		const heartbeat = setInterval(() => {
			try { res.write(':ka\n\n'); } catch { /* ignore */ }
		}, 15000);

		transport.onclose = () => {
			clearInterval(heartbeat);
			transports.delete(transport.sessionId);
		};
		try {
			await mcp.connect(transport);
		} catch { clearInterval(heartbeat); transports.delete(transport.sessionId); }
	});

	app.post('/messages', express.raw({ type: 'application/json', limit: '4mb' }), async (req, res) => {
		let sid = (req.query.sessionId as string) || (req.query.session_id as string);
		if (!sid) {
			const keys = [...transports.keys()];
			if (keys.length === 1) sid = keys[0];
			else if (keys.length > 1) {
				sid = keys[keys.length - 1];
				console.warn('[confluence-shim] POST without sessionId; picked last session', sid, 'from', keys);
			} else { res.status(404).end(); return; }
		}
		const transport = transports.get(sid);
		if (!transport) { res.status(404).end(); return; }
		const raw = (req.body as Buffer | undefined)?.toString('utf-8');
		
		// Fast-path initialize to prevent 60s timeout
		if (raw) {
			try {
				const msg = JSON.parse(raw);
				if (msg && msg.method === 'initialize' && typeof msg.id !== 'undefined') {
					res.json({
						jsonrpc: '2.0',
						id: msg.id,
						result: {
							protocolVersion: msg.params?.protocolVersion || '2025-06-18',
							capabilities: { tools: {}, prompts: {}, resources: {} },
							serverInfo: { name: 'confluence-shim', version: '0.2.0' }
						}
					});
					return;
				}
			} catch { /* parse error, fall through */ }
		}
		
		await (transport as unknown as { handlePostMessage: (r: express.Request, s: express.Response, body?: string) => Promise<void> })
			.handlePostMessage(req, res, raw);
	});

	app.listen(opts.port, () => console.log(`[confluence-shim] :${opts.port} -> ${opts.upstreamUrl}`));
}

