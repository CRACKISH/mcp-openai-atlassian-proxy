import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import cors from 'cors';
import express, { Request, Response } from 'express';
import { log } from '../log.js';
import { ProductShimConfig, ShimOptions } from '../types/shim.js';
import { getClientIp, startKeepAlive } from '../utils/net.js';
import { normalizePrefix, resolveDynamicPrefix } from '../utils/prefix.js';
import { VERSION } from '../version.js';
import { buildMcpServer } from './mcpServerFactory.js';
import { createUpstreamClient, UpstreamCallable } from './upstreamClient.js';

export interface CreateHttpServerOptions {
	opts: ShimOptions;
	cfg: ProductShimConfig;
	upstreamUrl: string;
	staticPrefix: string;
	initTs: number;
}

export function createHttpServer({
	opts,
	cfg,
	upstreamUrl,
	staticPrefix,
	initTs,
}: CreateHttpServerOptions) {
	const app = express();
	app.disable('x-powered-by');
	app.set('trust proxy', true);
	app.use(cors());
	app.use(express.json({ limit: '4mb' }));
	app.use(express.urlencoded({ extended: false }));
	app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

	const sessions: Record<string, SSEServerTransport> = {};
	let idleTimer: NodeJS.Timeout | null = null;
	const idleMs = Number(120_000);

	function cancelIdleTimer() {
		if (idleTimer) {
			clearTimeout(idleTimer);
			idleTimer = null;
		}
	}

	async function scheduleIdleClose() {
		if (idleTimer || Object.keys(sessions).length) return;
		idleTimer = setTimeout(async () => {
			idleTimer = null;
			if (Object.keys(sessions).length) return;
			await closeUpstream();
			log({
				evt: 'upstream_idle_close',
				msg: 'idle_close',
				shim: cfg.productKey,
				durationMs: idleMs,
			});
		}, idleMs).unref?.();
	}

	function openSession(req: Request, res: Response) {
		cancelIdleTimer();
		const resolved = resolveDynamicPrefix(req, { staticPrefix });
		const dynamicPrefix = normalizePrefix(resolved.prefix);
		const endpoint = `${dynamicPrefix}/messages`;
		const transport = new SSEServerTransport(endpoint, res);
		sessions[transport.sessionId] = transport;
		const ip = getClientIp(req);
		log({
			evt: 'session_open',
			msg: 'open',
			shim: cfg.productKey,
			sessionId: transport.sessionId,
			ip,
			prefix: dynamicPrefix,
			prefixReason: resolved.reason,
			version: VERSION,
		});
		return { transport, ip };
	}

	function attachKeepAlive(res: Response) {
		const handle = startKeepAlive(res, 25_000);
		return handle;
	}

	function onSessionClose(sessionId: string, ip: string, keepAlive: { stop: () => void }) {
		keepAlive.stop();
		delete sessions[sessionId];
		log({ evt: 'session_close', msg: 'close', shim: cfg.productKey, sessionId, ip });
		scheduleIdleClose();
	}

	let upstreamClient: UpstreamCallable | null = null;
	let upstreamPromise: Promise<UpstreamCallable> | null = null;

	async function ensureUpstream(): Promise<UpstreamCallable> {
		if (upstreamClient) return upstreamClient;
		if (upstreamPromise) return upstreamPromise;
		upstreamPromise = (async () => {
			const u = await createUpstreamClient(upstreamUrl, { label: cfg.productKey }); // just to ensure upstream is alive, not used directly here
			upstreamClient = u;
			return u;
		})();
		try {
			return await upstreamPromise;
		} finally {
			upstreamPromise = null;
		}
	}

	async function closeUpstream() {
		try {
			await (upstreamClient as { close?: () => Promise<void> })?.close?.();
		} catch {
			void 0;
		} finally {
			upstreamClient = null;
		}
	}

	async function handleSSE(req: Request, res: Response) {
		const { transport, ip } = openSession(req, res);
		const keepAlive = attachKeepAlive(res);
		res.on('close', () => onSessionClose(transport.sessionId, ip, keepAlive));
		const upstream = await ensureUpstream();
		const server = buildMcpServer({ cfg, upstream });
		await server.connect(transport);
	}

	async function handleStreamableHTTP(req: Request, res: Response) {
		await ensureUpstream();
		if (req.method === 'GET') {
			res.status(200).json({ ok: true, transport: 'http', version: VERSION });
			return;
		}
		const http = await import('http');
		const https = await import('https');
		const url = new URL(upstreamUrl);
		const mod = url.protocol === 'https:' ? https : http;
		const proxyReq = mod.request(
			{
				method: req.method,
				hostname: url.hostname,
				port: url.port,
				path: url.pathname,
				headers: req.headers,
			},
			proxyRes => {
				res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
				proxyRes.pipe(res);
			},
		);
		proxyReq.on('error', err => {
			res.status(502).json({ error: 'Upstream error', detail: err.message });
		});
		req.pipe(proxyReq);
	}

	const resolveSession = (req: Request) => {
		const sid = req.query.sessionId ?? req.query.session_id ?? req.query['session-id'] ?? '';
		return String(sid || '');
	};

	app.all(['/mcp', '/sse'], async (req: Request, res: Response) => {
		const accept = req.headers.accept || '';
		const transportType = (req.query.transport || '').toString().toLowerCase();
		const isSse =
			req.path.endsWith('/sse') ||
			transportType === 'sse' ||
			(req.method === 'GET' && accept.includes('text/event-stream'));
		if (isSse) {
			res.setHeader('Content-Type', 'text/event-stream');
			await handleSSE(req, res);
		} else {
			await handleStreamableHTTP(req, res);
		}
	});

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
		const listenLog = {
			evt: 'shim_listen',
			msg: 'listen',
			shim: cfg.productKey,
			port: opts.port,
			durationMs: Date.now() - initTs,
			version: VERSION,
		} as const;
		log(listenLog);
		log({
			evt: 'shim_http',
			msg: 'http_ready',
			shim: cfg.productKey,
			url: `http://localhost:${opts.port}/mcp`,
			version: VERSION,
		});
		log({
			evt: 'shim_sse',
			msg: 'sse_ready',
			shim: cfg.productKey,
			url: `http://localhost:${opts.port}/sse`,
			version: VERSION,
		});
	});

	return { app, server, sessions, closeUpstream };
}
