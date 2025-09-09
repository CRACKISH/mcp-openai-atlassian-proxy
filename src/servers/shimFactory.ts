import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import cors from 'cors';
import express from 'express';
import { z } from 'zod';
import type { JsonObject, JsonValue } from '../types/json.js';

export interface ShimOptions {
	port: number;
	upstreamUrl: string;
}

export interface SearchDelegate {
	prepareSearchArguments(query: string): JsonObject;
	mapSearchResults(rawResults: JsonValue): {
		results: { id: string; title: string; url: string }[];
	};
}

export interface FetchDelegate {
	prepareFetchArguments(id: string): JsonObject;
	mapFetchResults(rawResults: JsonValue): {
		id: string;
		title: string;
		text: string;
		url: string;
		metadata: JsonObject;
	};
}

export interface ProductShimConfig {
	productKey: string;
	serverName: string;
	upstreamSearchTool: string;
	upstreamFetchTool: string;
	defaultSearchDescription: string;
	defaultFetchDescription: string;
	searchDelegate: SearchDelegate;
	fetchDelegate: FetchDelegate;
}

export function extractJsonFromContent(res: JsonValue): JsonValue {
	if (res && typeof res === 'object' && !Array.isArray(res)) {
		const obj = res as Record<string, JsonValue>;
		const content = obj.content;
		if (Array.isArray(content)) {
			for (const item of content) {
				if (item && typeof item === 'object' && !Array.isArray(item)) {
					const it = item as Record<string, JsonValue>;
					if (it.type === 'text' && typeof it.text === 'string') {
						try {
							return JSON.parse(String(it.text)) as JsonValue;
						} catch {
							return res;
						}
					}
				}
			}
		}
	}
	return res;
}

async function createUpstreamClient(upstreamUrl: string) {
	const client = new Client({ name: 'openai-shim-upstream', version: '0.4.0' });
	const transport = new SSEClientTransport(new URL(upstreamUrl));
	await client.connect(transport);
	return client;
}

export async function startShimServer(opts: ShimOptions, cfg: ProductShimConfig) {
	const upstream = await createUpstreamClient(opts.upstreamUrl);

	const buildServer = () => {
		const mcp = new McpServer({ name: cfg.serverName, version: '0.4.0' });

		mcp.registerTool(
			'search',
			{
				title: 'Search',
				description: cfg.defaultSearchDescription,
				inputSchema: { query: z.string() },
			},
			async ({ query }) => {
				const args = cfg.searchDelegate.prepareSearchArguments(String(query));
				const res = await upstream.callTool({
					name: cfg.upstreamSearchTool,
					arguments: args,
				});
				const raw = JSON.parse(JSON.stringify(res)) as JsonValue;
				const mapped = cfg.searchDelegate.mapSearchResults(extractJsonFromContent(raw));
				return { content: [{ type: 'text', text: JSON.stringify(mapped) }] };
			},
		);

		mcp.registerTool(
			'fetch',
			{
				title: 'Fetch',
				description: cfg.defaultFetchDescription,
				inputSchema: { id: z.string() },
			},
			async ({ id }) => {
				const args = cfg.fetchDelegate.prepareFetchArguments(String(id));
				const res = await upstream.callTool({
					name: cfg.upstreamFetchTool,
					arguments: args,
				});
				const raw = JSON.parse(JSON.stringify(res)) as JsonValue;
				const mapped = cfg.fetchDelegate.mapFetchResults(extractJsonFromContent(raw));
				return { content: [{ type: 'text', text: JSON.stringify(mapped) }] };
			},
		);

		return mcp;
	};

	const app = express();
	app.use(cors());
	app.use(express.json());

	const sseTransports: Record<string, SSEServerTransport> = {};

	app.get('/sse', async (req, res) => {
		const transport = new SSEServerTransport('/messages', res);
		sseTransports[transport.sessionId] = transport;

		res.on('close', () => {
			delete sseTransports[transport.sessionId];
		});

		const server = buildServer();
		await server.connect(transport);
	});

	app.post('/messages', async (req, res) => {
		const sessionId = String(req.query.sessionId || '');
		const transport = sseTransports[sessionId];
		if (!transport) {
			res.status(400).send('No transport found for sessionId');
			return;
		}
		await transport.handlePostMessage(req, res, req.body);
	});

	app.listen(opts.port, () => {
		console.log(`[shim:${cfg.productKey}] HTTP listening on :${opts.port}`);
		console.log(`[shim:${cfg.productKey}] SSE endpoint: http://localhost:${opts.port}/sse`);
		console.log(`[shim:${cfg.productKey}] upstream ${opts.upstreamUrl}`);
	});
}
