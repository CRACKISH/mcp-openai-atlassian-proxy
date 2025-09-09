import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import cors from 'cors';
import express, { Request, Response } from 'express';
import { z } from 'zod';
import { log } from '../log.js';
import { JsonObject, JsonValue } from '../types/json.js';
import { FetchedDocument, SearchResults } from '../types/tools.js';
import { createUpstreamClient } from './upstreamClient.js';

export interface ShimOptions {
	port: number;
	upstreamUrl: string;
	publicPrefix?: string;
}

export interface SearchDelegate {
	prepareSearchArguments(query: string): JsonObject;
	mapSearchResults(rawResults: JsonValue): SearchResults;
}

export interface FetchDelegate {
	prepareFetchArguments(id: string): JsonObject;
	mapFetchResults(rawResults: JsonValue): FetchedDocument;
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

export async function startShimServer(opts: ShimOptions, cfg: ProductShimConfig) {
	await new Promise(r => setTimeout(r, 1000));
	const initTs = Date.now();
	log({
		evt: 'shim_init',
		msg: 'init',
		shim: cfg.productKey,
		port: opts.port,
		upstreamUrl: opts.upstreamUrl,
	});
	const upstream = await createUpstreamClient(opts.upstreamUrl, { label: cfg.productKey });
	const prefix = (opts.publicPrefix ?? '').replace(/\/+$/, '');

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
	app.disable('x-powered-by');
	app.set('trust proxy', true);

	app.use(cors());
	app.use(express.json({ limit: '4mb' }));
	app.use(express.urlencoded({ extended: false }));

	app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

	const sessions: Record<string, SSEServerTransport> = {};

	app.get('/sse', async (req: Request, res: Response) => {
		const endpoint = `${prefix}/messages`;
		const transport = new SSEServerTransport(endpoint, res);
		sessions[transport.sessionId] = transport;
		const ip = (req.headers['x-forwarded-for'] || req.ip || req.socket.remoteAddress || '')
			.toString()
			.split(',')[0]
			.trim();
		log({
			evt: 'session_open',
			msg: 'open',
			shim: cfg.productKey,
			sessionId: transport.sessionId,
			ip,
		});

		const keepAliveMs = Number(25_000);
		const keepAliveTimer = setInterval(() => {
			try {
				if (res.writableEnded || res.destroyed) {
					clearInterval(keepAliveTimer);
					return;
				}
				res.write(`:ka ${Date.now()}\n\n`);
			} catch {
				clearInterval(keepAliveTimer);
			}
		}, keepAliveMs).unref?.();

		res.on('close', () => {
			clearInterval(keepAliveTimer as unknown as NodeJS.Timeout);
			delete sessions[transport.sessionId];
			log({
				evt: 'session_close',
				msg: 'close',
				shim: cfg.productKey,
				sessionId: transport.sessionId,
				ip,
			});
		});

		const server = buildServer();
		await server.connect(transport);
	});

	const resolveSession = (req: Request) => {
		const sid = req.query.sessionId ?? req.query.session_id ?? req.query['session-id'] ?? '';
		return String(sid || '');
	};

	app.post('/messages', async (req: Request, res: Response) => {
		const sid = resolveSession(req);
		const t = sessions[sid];
		if (!t) return res.status(400).send('No transport found for sessionId');
		try {
			await t.handlePostMessage(req, res, req.body);
		} catch (e) {
			log({
				evt: 'session_error',
				msg: 'error',
				shim: cfg.productKey,
				sessionId: sid,
				lvl: 'error',
				reason: e instanceof Error ? e.message : String(e),
			});
			throw e;
		}
	});

	const server = app.listen(opts.port, () => {
		log({
			evt: 'shim_listen',
			msg: 'listen',
			shim: cfg.productKey,
			port: opts.port,
			durationMs: Date.now() - initTs,
		});
		log({
			evt: 'shim_sse',
			msg: 'sse_ready',
			shim: cfg.productKey,
			url: `http://localhost:${opts.port}/sse`,
		});
	});

	const shutdown = () => {
		log({ evt: 'shim_shutdown', msg: 'shutdown', shim: cfg.productKey });
		server.close(() => process.exit(0));
		void (upstream as { close?: () => Promise<void> })?.close?.();
		for (const [sid, t] of Object.entries(sessions)) {
			try {
				t.close?.();
				delete sessions[sid];
			} catch {
				void 0;
			}
		}
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	return server;
}
