import express from 'express';
import cors from 'cors';
import { Server as MCPServer } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ListPromptsRequestSchema, ListResourcesRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { UpstreamClient } from '../remote/index.js';
import { ToolArguments } from '../types/index.js';

export interface JiraShimOptions { port: number; upstreamUrl: string; upstreamClient?: UpstreamClient }

// Fixed upstream tool names we proxy as-is
const JIRA_SEARCH = 'jira_search';
const JIRA_GET = 'jira_get_issue';

export async function startJiraShim(opts: JiraShimOptions) {
	// small startup delay to let upstream come up (race mitigation)
	const startDelay = Number(process.env.SHIM_START_DELAY_MS || 2000);
	if (startDelay > 0) await new Promise(r => setTimeout(r, startDelay));
	const upstream = opts.upstreamClient ?? new UpstreamClient({ remoteUrl: opts.upstreamUrl, monitorTools: [JIRA_SEARCH, JIRA_GET] });
	await upstream.connectIfNeeded();

	const mcp = new MCPServer({ name: 'jira-shim', version: '0.2.0' }, { capabilities: { tools: {}, prompts: {}, resources: {} } });

	// respond with empty lists instead of method-not-found
	mcp.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
	mcp.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));

	mcp.setRequestHandler(ListToolsRequestSchema, async () => {
		const tools = upstream.listTools();
		const searchInfo = tools.find(t => t.name === JIRA_SEARCH);
		const getInfo = tools.find(t => t.name === JIRA_GET);
		return {
			tools: [
				{ name: 'search', description: searchInfo?.description || 'Jira search', inputSchema: searchInfo?.inputSchema || { type: 'object', properties: {} } },
				{ name: 'fetch', description: getInfo?.description || 'Jira issue fetch', inputSchema: getInfo?.inputSchema || { type: 'object', properties: {} } }
			]
		};
	});

	mcp.setRequestHandler(CallToolRequestSchema, async req => {
		const tool = req.params.name as string;
		const args = (req.params.arguments || {}) as ToolArguments;
		try {
			if (tool === 'search') {
				const r = await upstream.callTool(JIRA_SEARCH, args);
				return { content: r.content };
			}
			if (tool === 'fetch') {
				const r = await upstream.callTool(JIRA_GET, args);
				return { content: r.content };
			}
			return { content: [{ type: 'text', text: `unknown tool ${tool}` }] };
		} catch (e) {
			return { content: [{ type: 'text', text: `jira error: ${(e as { message?: string }).message || String(e)}` }] };
		}
	});

	const app = express();
	app.use(cors());
	const transports = new Map<string, SSEServerTransport>();

	app.get('/healthz', (_req, res) => res.json({ ok: true, upstream: opts.upstreamUrl, search: JIRA_SEARCH, fetch: JIRA_GET }));

	app.get('/sse', async (_req, res) => {
		// explicit SSE headers (defensive for proxies)
		res.setHeader('Content-Type', 'text/event-stream');
		res.setHeader('Cache-Control', 'no-cache');
		res.setHeader('Connection', 'keep-alive');
		res.setHeader('X-Accel-Buffering', 'no');
		// flush headers early if supported
		(res as unknown as { flushHeaders?: () => void }).flushHeaders?.();
		// first byte to prevent idle timeouts before endpoint event
		try { res.write(': open jira\n\n'); } catch { /* ignore */ }

		// strict single session mode: reject new connection instead of silently closing old
		if (process.env.STRICT_SINGLE_SESSION && transports.size) {
			res.write('event: error\n');
			res.write('data: another session active\n\n');
			res.end();
			return;
		}

		// optional single-session mode: close previous transports
		if (process.env.SINGLE_SESSION && transports.size) {
			for (const [id, old] of transports.entries()) {
				try { (old as unknown as { close?: () => void }).close?.(); } catch { /* ignore */ }
				transports.delete(id);
			}
		}

		const transport = new SSEServerTransport('jira/messages', res);
		transports.set(transport.sessionId, transport);
		console.log('[jira-shim] SSE session created:', transport.sessionId, 'total:', transports.size);

		// Manual immediate endpoint emit BEFORE mcp.connect to avoid clients waiting 60s for SDK-driven emit
		try {
			const path = `/jira/messages?sessionId=${encodeURIComponent(transport.sessionId)}`;
			res.write('event: endpoint\n');
			res.write(`data: ${path}\n\n`);
			// Force flush the endpoint event immediately
			if (typeof (res as any).flush === 'function') (res as any).flush();
		} catch { /* ignore */ }

		// heartbeat every 15s
		const heartbeat = setInterval(() => {
			try { res.write(':ka\n\n'); } catch { /* ignore */ }
		}, 15000);

		transport.onclose = () => {
			clearInterval(heartbeat);
			transports.delete(transport.sessionId);
			console.log('[jira-shim] SSE session closed:', transport.sessionId, 'remaining:', transports.size);
		};
		
		// Don't await mcp.connect - let it run async to avoid premature session cleanup
		mcp.connect(transport).catch(err => {
			console.warn('[jira-shim] mcp.connect failed for session', transport.sessionId, ':', err.message);
		});
	});

	app.post('/messages', express.raw({ type: 'application/json', limit: '4mb' }), async (req, res) => {
		let sid = (req.query.sessionId as string) || (req.query.session_id as string);
		if (!sid) {
			const keys = [...transports.keys()];
			if (keys.length === 1) sid = keys[0];
			else if (keys.length > 1) {
				sid = keys[keys.length - 1];
				console.warn('[jira-shim] POST without sessionId; picked last session', sid, 'from', keys);
			} else { 
				console.error('[jira-shim] POST /messages: no sessionId and no active transports');
				res.status(404).end(); return; 
			}
		}
		const transport = transports.get(sid);
		if (!transport) { 
			console.error('[jira-shim] POST /messages: sessionId', sid, 'not found in', [...transports.keys()]);
			res.status(404).end(); return; 
		}
		const raw = (req.body as Buffer | undefined)?.toString('utf-8');
		
		// Fast-path initialize to prevent 60s timeout
		if (raw) {
			try {
				const msg = JSON.parse(raw);
				if (msg && msg.method === 'initialize' && typeof msg.id !== 'undefined') {
					console.log('[jira-shim] Fast-path initialize response for session', sid);
					res.json({
						jsonrpc: '2.0',
						id: msg.id,
						result: {
							protocolVersion: msg.params?.protocolVersion || '2025-06-18',
							capabilities: { tools: {}, prompts: {}, resources: {} },
							serverInfo: { name: 'jira-shim', version: '0.2.0' }
						}
					});
					return;
				}
			} catch { /* parse error, fall through */ }
		}
		
		await (transport as unknown as { handlePostMessage: (r: express.Request, s: express.Response, body?: string) => Promise<void> })
			.handlePostMessage(req, res, raw);
	});

	app.listen(opts.port, () => console.log(`[jira-shim] :${opts.port} -> ${opts.upstreamUrl}`));
}
