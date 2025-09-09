// shimFactory.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import cors from 'cors';
import express, { Request, Response } from 'express';
import { z } from 'zod';
import { JsonObject, JsonValue } from '../types/json.js';

export interface ShimOptions {
	port: number;
	upstreamUrl: string;
	publicPrefix?: string;
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

/* ------------------------ helpers ------------------------ */
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

/* ------------------------ server factory ------------------------ */

export async function startShimServer(opts: ShimOptions, cfg: ProductShimConfig) {
	const upstream = await createUpstreamClient(opts.upstreamUrl);
	const prefix = (opts.publicPrefix ?? '').replace(/\/+$/, '');

	const buildServer = () => {
		const mcp = new McpServer({ name: cfg.serverName, version: '0.4.0' });

		// search(query: string)
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
				const raw = JSON.parse(JSON.stringify(res)) as JsonValue; // de-proxy
				const mapped = cfg.searchDelegate.mapSearchResults(extractJsonFromContent(raw));
				return { content: [{ type: 'text', text: JSON.stringify(mapped) }] };
			},
		);

		// fetch(id: string)
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
	app.disable('x-powered-by');
	app.set('trust proxy', true);

	app.use(cors());
	app.use(express.json({ limit: '4mb' }));
	app.use(express.urlencoded({ extended: false }));

	app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

	const sessions: Record<string, SSEServerTransport> = {};

	// GET {prefix}/sse -> віддаємо endpoint з тим самим префіксом!
	app.get('/sse', async (req: Request, res: Response) => {
		// важливо: endpoint має бути з публічним префіксом
		const endpoint = `${prefix}/messages`;
		const transport = new SSEServerTransport(endpoint, res);
		sessions[transport.sessionId] = transport;

		res.on('close', () => {
			delete sessions[transport.sessionId];
		});

		const server = buildServer();
		await server.connect(transport);
	});

	// GET/POST {prefix}/messages?sessionId=... (або session_id=...)
	const resolveSession = (req: Request) => {
		const sid = req.query.sessionId ?? req.query.session_id ?? req.query['session-id'] ?? '';
		return String(sid || '');
	};

	app.post('/messages', async (req: Request, res: Response) => {
		const sid = resolveSession(req);
		const t = sessions[sid];
		if (!t) return res.status(400).send('No transport found for sessionId');
		await t.handlePostMessage(req, res, req.body);
	});

	const server = app.listen(opts.port, () => {
		console.log(`[shim:${cfg.productKey}] HTTP :${opts.port}`);
		console.log(`[shim:${cfg.productKey}] SSE endpoint: http://localhost:${opts.port}/sse`);
		console.log(`[shim:${cfg.productKey}] upstream: ${opts.upstreamUrl}`);
	});

	const shutdown = () => {
		console.log(`[shim:${cfg.productKey}] shutting down...`);
		server.close(() => process.exit(0));
		for (const [sid, t] of Object.entries(sessions)) {
			try {
				t.close?.();
				delete sessions[sid];
			} catch {
				// ignore
			}
		}
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	return server;
}
