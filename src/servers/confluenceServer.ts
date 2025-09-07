import express from 'express';
import cors from 'cors';
import { Server as MCPServer } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { UpstreamClient } from '../remote/upstreamClient.js';

export interface ConfluenceShimOptions {
	port: number;
	upstreamUrl: string;
}

export async function startConfluenceShim(options: ConfluenceShimOptions) {
	const upstream = new UpstreamClient({ remoteUrl: options.upstreamUrl });
	await upstream.ensureConnected();

	const confSearchTool = upstream.findToolBy(
		n => (n.includes('confluence') || n.includes('conf')) && n.includes('search')
	);
	const confGetTool = upstream.findToolBy(
		n => (n.includes('confluence') || n.includes('conf')) && (n.includes('get') || n.includes('page'))
	);

	const mcp = new MCPServer(
		{ name: 'confluence-shim', version: '0.1.0' },
		{ capabilities: { tools: {} } }
	);

	mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
			{
				name: 'search',
				description: 'Search Confluence pages; returns { objectIds: ["confluence:ID"] }',
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
				description: 'Fetch Confluence pages by id',
				inputSchema: {
					type: 'object',
					properties: {
						objectIds: { type: 'array', items: { type: 'string' }, minItems: 1 }
					},
					required: ['objectIds']
				}
			}
		]
	}));

	mcp.setRequestHandler(CallToolRequestSchema, async req => {
		if (!upstream.isConnected()) {
			return { content: [{ type: 'text', text: 'Upstream not connected' }] } as any;
		}
		const name = (req as unknown as { params?: { name?: string; arguments?: Record<string, unknown> }; name?: string }).params?.name || (req as any).name;
		const args = (req as unknown as { params?: { arguments?: Record<string, unknown> }; arguments?: Record<string, unknown> }).params?.arguments || (req as any).arguments || {};
		try {
			if (name === 'search') {
				if (!confSearchTool) {
					return { content: [{ type: 'text', text: 'No upstream Confluence search tool' }] } as any;
				}
				const r = await upstream.callTool(confSearchTool, {
					query: args.query,
					cql: args.query,
					limit: args.topK || 20
				});
				const ids = extractPageIds((r as { content?: unknown[] })?.content || []);
				return { content: [{ type: 'json', data: { objectIds: ids.map(id => `confluence:${id}`) } }] } as any;
			}
			if (name === 'fetch') {
				if (!confGetTool) {
					return { content: [{ type: 'text', text: 'No upstream Confluence get tool' }] } as any;
				}
				const objectIds: string[] = Array.isArray(args.objectIds) ? args.objectIds : [];
				const resources = [] as any[];
				for (const oid of objectIds) {
					const id = oid.replace(/^confluence:/i, '');
					const r = await upstream.callTool(confGetTool, { id, pageId: id });
					const parsed = firstJsonContent((r as { content?: unknown[] })?.content || []);
					resources.push({
						objectId: `confluence:${id}`,
						type: 'confluence_page',
						contentType: 'application/json',
						content: parsed ?? null
					});
				}
				return { content: [{ type: 'json', data: { resources } }] } as any;
			}
			return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] } as any;
		} catch (e: any) {
			return { content: [{ type: 'text', text: `confluence-shim error: ${e?.message || e}` }] } as any;
		}
	});

	const app = express();
	app.use(cors());
	app.get('/healthz', (_req, res) => {
		res.json({ ok: true, upstream: options.upstreamUrl, confSearchTool, confGetTool });
	});
	app.get('/sse', async (_req, res) => {
		const transport = new SSEServerTransport('/sse', res);
		await mcp.connect(transport);
	});
	app.listen(options.port, () => {
		console.log(`[confluence-shim] listening on :${options.port} -> upstream ${options.upstreamUrl}`);
	});
}

function extractPageIds(content: any[]): string[] {
	const ids = new Set<string>();
	for (const c of content) {
		if (c.type === 'json' && c.data) collect(c.data);
	}
	return [...ids];
	function collect(x: any) {
		if (!x) return;
		if (Array.isArray(x)) return x.forEach(collect);
		if (typeof x === 'object') {
			if (typeof x.id === 'string' || typeof x.id === 'number') ids.add(String(x.id));
			for (const v of Object.values(x)) collect(v);
		}
	}
}

function firstJsonContent(content: any[]): any | null {
	for (const c of content) if (c.type === 'json') return c.data ?? null;
	for (const c of content)
		if (c.type === 'text' && typeof c.text === 'string') {
			try {
				return JSON.parse(c.text);
			} catch {}
		}
	return null;
}
