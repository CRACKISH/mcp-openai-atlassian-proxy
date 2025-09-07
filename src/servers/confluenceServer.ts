import express from 'express';
import cors from 'cors';
import { Server as MCPServer } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { UpstreamClient } from '../remote/index.js';
import { extractConfluenceIds, firstJson } from '../utils/index.js';
import { ContentPart, ToolArguments, JsonValue } from '../types/index.js';

export interface ConfluenceShimOptions {
	port: number;
	upstreamUrl: string;
}

export async function startConfluenceShim(options: ConfluenceShimOptions) {
	const upstream = new UpstreamClient({ remoteUrl: options.upstreamUrl });
	await upstream.connectIfNeeded();

	const confSearchTool = upstream.findToolName(
		n => (n.includes('confluence') || n.includes('conf')) && n.includes('search')
	);
	const confGetTool = upstream.findToolName(
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

	mcp.setRequestHandler(CallToolRequestSchema, async rawReq => {
		if (!upstream.isConnected()) {
			return { content: [{ type: 'text', text: 'Upstream not connected' }] } as { content: ContentPart[] };
		}
		interface ToolCallLike { params?: { name?: string; arguments?: ToolArguments }; name?: string; arguments?: ToolArguments }
		const req = rawReq as unknown as ToolCallLike;
		const name = req.params?.name || req.name || '';
		const args: ToolArguments = req.params?.arguments || req.arguments || {};
		try {
			if (name === 'search') {
				if (!confSearchTool) {
					return { content: [{ type: 'text', text: 'No upstream Confluence search tool' }] };
				}
				const searchResponse = await upstream.callTool(confSearchTool, {
					query: args.query as JsonValue,
					cql: args.query as JsonValue,
					limit: (args.topK as number) || 20
				});
				const ids = extractConfluenceIds(searchResponse.content);
				return { content: [{ type: 'json', data: { objectIds: ids.map(id => `confluence:${id}`) } }] };
			}
			if (name === 'fetch') {
				if (!confGetTool) {
					return { content: [{ type: 'text', text: 'No upstream Confluence get tool' }] };
				}
				const objectIds: string[] = (() => {
					const maybe = args.objectIds as JsonValue;
					return Array.isArray(maybe) && maybe.every(v => typeof v === 'string') ? (maybe as string[]) : [];
				})();
				interface Resource { objectId: string; type: string; contentType: string; content: JsonValue | null }
				const resources: Resource[] = [];
				for (const rawObjectId of objectIds) {
					const id = rawObjectId.replace(/^confluence:/i, '');
					const pageResponse = await upstream.callTool(confGetTool, { id, pageId: id });
					const parsed = firstJson(pageResponse.content || []);
					resources.push({
						objectId: `confluence:${id}`,
						type: 'confluence_page',
						contentType: 'application/json',
						content: parsed ?? null
					});
				}
				return { content: [{ type: 'json', data: { resources } }] };
			}
			return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
		} catch (e) {
			const message = (e as { message?: string })?.message || String(e);
			return { content: [{ type: 'text', text: `confluence-shim error: ${message}` }] };
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

