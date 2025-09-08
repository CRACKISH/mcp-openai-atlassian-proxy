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
	const upstream = opts.upstreamClient ?? new UpstreamClient({ remoteUrl: opts.upstreamUrl, monitorTools: [JIRA_SEARCH, JIRA_GET] });
	await upstream.connectIfNeeded();

	const mcp = new MCPServer({ name: 'jira-shim', version: '0.2.0' }, { capabilities: { tools: {} } });

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

		const transport = new SSEServerTransport('jira/messages', res); // prefixed endpoint for client POSTs
		transports.set(transport.sessionId, transport);

		// heartbeat every 15s
		const heartbeat = setInterval(() => {
			try { res.write(':ka\n\n'); } catch { /* ignore */ }
		}, 15000);

		transport.onclose = () => {
			clearInterval(heartbeat);
			transports.delete(transport.sessionId);
		};
		try { await mcp.connect(transport); } catch { clearInterval(heartbeat); transports.delete(transport.sessionId); }
	});

	app.post('/messages', express.raw({ type: 'application/json', limit: '4mb' }), async (req, res) => {
		const sid = (req.query.sessionId as string) || (req.query.session_id as string) || [...transports.keys()][0];
		const transport = transports.get(sid);
		if (!transport) { res.status(404).end(); return; }
		const raw = (req.body as Buffer | undefined)?.toString('utf-8');
		await (transport as unknown as { handlePostMessage: (r: express.Request, s: express.Response, body?: string) => Promise<void> })
			.handlePostMessage(req, res, raw);
	});

	app.listen(opts.port, () => console.log(`[jira-shim] :${opts.port} -> ${opts.upstreamUrl}`));
}
