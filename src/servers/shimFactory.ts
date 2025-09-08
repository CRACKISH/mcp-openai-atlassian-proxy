import express from 'express';
import cors from 'cors';
import { JsonValue } from '../types/index.js';

// ---------------- Types -----------------
export interface ShimOptions {
	port: number;
	upstreamUrl: string;
}
interface ProductShimConfig {
	productKey: string; // 'jira' | 'confluence'
	serverName: string; // log prefix / visibility
	upstreamSearchTool: string; // e.g. jira_search
	upstreamFetchTool: string; // e.g. jira_get_issue
	defaultSearchDescription: string; // fallback only
	defaultFetchDescription: string; // fallback only
}

interface SessionMapping {
	upstreamMessagesUrl: string; // full URL (already contains remote session id)
	upstreamSearch: string;
	upstreamFetch: string;
	searchDesc?: string;
	fetchDesc?: string;
	close: () => void; // close upstream SSE
}

// -------------- Helpers -----------------
function makeId(): string {
	return Math.random().toString(36).slice(2, 10);
}

function parseSseChunk(
	buffer: string,
	onEvent: (ev: { event?: string; data: string[] }) => void,
): string {
	let idx: number;
	while ((idx = buffer.indexOf('\n\n')) !== -1) {
		const raw = buffer.slice(0, idx);
		buffer = buffer.slice(idx + 2);
		const lines = raw.split('\n');
		const ev: { event?: string; data: string[] } = { data: [] };
		for (const l of lines) {
			if (l.startsWith('event:')) ev.event = l.slice(6).trim();
			else if (l.startsWith('data:')) ev.data.push(l.slice(5).trimStart());
		}
		if (ev.data.length) onEvent(ev);
	}
	return buffer;
}

// Rewrite tools array: keep only two product-specific upstream tools and rename to generic ('search','fetch').
type JsonObject = Record<string, JsonValue>;

function isObject(v: JsonValue | object): v is JsonObject {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function rewriteToolsPayload(payload: JsonValue, sess: SessionMapping): JsonValue {
	if (!isObject(payload)) return payload;
	const obj = payload as JsonObject;
	const resultRaw = obj.result as JsonValue | undefined;
	if (resultRaw === undefined || !isObject(resultRaw)) return payload;
	const result = resultRaw as JsonObject;
	const toolsVal = result.tools as JsonValue | undefined;
	if (!Array.isArray(toolsVal)) return payload;
	const filtered: JsonObject[] = [];
	for (const t of toolsVal) {
		if (!isObject(t)) continue;
		const name = String((t as JsonObject).name || '');
		if (name === sess.upstreamSearch) {
			filtered.push({
				...t,
				name: 'search',
				description:
					typeof (t as JsonObject).description === 'string'
						? (t as JsonObject).description
						: sess.searchDesc || 'Search',
			});
		} else if (name === sess.upstreamFetch) {
			filtered.push({
				...t,
				name: 'fetch',
				description:
					typeof (t as JsonObject).description === 'string'
						? (t as JsonObject).description
						: sess.fetchDesc || 'Fetch',
			});
		}
	}
	result.tools = filtered as unknown as JsonValue;
	return obj;
}

// Rewrite outgoing tool call names from generic to upstream specific.
function rewriteOutgoing(payload: JsonValue, sess: SessionMapping): JsonValue {
	if (!isObject(payload)) return payload;
	const obj = payload as JsonObject;
	const method = obj.method as string | undefined;
	if (method === 'tools/call' && isObject(obj.params as JsonValue)) {
		const p = obj.params as JsonObject;
		const nm = p.name as string | undefined;
		if (nm === 'search') p.name = sess.upstreamSearch as unknown as JsonValue;
		else if (nm === 'fetch') p.name = sess.upstreamFetch as unknown as JsonValue;
	}
	return obj;
}

// -------------- Main server factory -----------------
export async function startShimServer(opts: ShimOptions, cfg: ProductShimConfig): Promise<void> {
	const app = express();
	app.use(cors());
	app.use(express.raw({ type: 'application/json', limit: '4mb' }));

	const sessions = new Map<string, SessionMapping>();

	app.get('/healthz', (_req, res) => {
		res.json({ ok: true, product: cfg.productKey, upstream: opts.upstreamUrl });
	});

	app.get('/sse', async (_req, res) => {
		res.setHeader('Content-Type', 'text/event-stream');
		res.setHeader('Cache-Control', 'no-cache');
		res.setHeader('Connection', 'keep-alive');
		res.setHeader('X-Accel-Buffering', 'no');
		res.write(`: shim open ${cfg.productKey}\n\n`);

		// Create upstream SSE connection per client session.
		const upstreamBase = opts.upstreamUrl.replace(/\/sse\/?$/, '');
		const upstreamSseUrl = opts.upstreamUrl.endsWith('/sse')
			? opts.upstreamUrl
			: `${upstreamBase}/sse`;

		const ac = new AbortController();
		let closed = false;
		const localSessionId = makeId();
		let upstreamMessagesUrl: string | null = null;

		function closeAll() {
			if (closed) return;
			closed = true;
			ac.abort();
			sessions.delete(localSessionId);
			try {
				res.end();
			} catch {
				/* ignore */
			}
			console.log(`[${cfg.serverName}] session closed ${localSessionId}`);
		}

		_req.on('close', closeAll);

		try {
			const upstreamRes = await fetch(upstreamSseUrl, {
				headers: { Accept: 'text/event-stream' },
				signal: ac.signal,
			});
			if (!upstreamRes.ok || !upstreamRes.body) {
				res.write('event: error\n');
				res.write(`data: upstream connect failed (${upstreamRes.status})\n\n`);
				return;
			}
			console.log(`[${cfg.serverName}] upstream SSE open -> ${upstreamSseUrl}`);

			const reader = upstreamRes.body.getReader();
			const decoder = new TextDecoder('utf-8');
			let buffer = '';
			(async () => {
				try {
					for (;;) {
						const ch = await reader.read();
						if (ch.done) break;
						buffer += decoder.decode(ch.value, { stream: true });
						buffer = parseSseChunk(buffer, ev => {
							const { event, data } = ev;
							if (event === 'endpoint') {
								// Build remote messages URL (data is path like /messages?sessionId=abc)
								const rawPath = data.join('\n').trim();
								let path = rawPath.startsWith('/') ? rawPath : '/' + rawPath;
								// Expand potential '/sse?' variant
								if (/^\/sse\?/i.test(path))
									path = path.replace(/^\/sse\?/i, '/messages?');
								// Compose absolute
								const u = new URL(opts.upstreamUrl);
								upstreamMessagesUrl = `${u.origin}${path}`;
								sessions.set(localSessionId, {
									upstreamMessagesUrl,
									upstreamSearch: cfg.upstreamSearchTool,
									upstreamFetch: cfg.upstreamFetchTool,
									searchDesc: cfg.defaultSearchDescription,
									fetchDesc: cfg.defaultFetchDescription,
									close: closeAll,
								});
								// Emit shim endpoint for client (local session id)
								res.write('event: endpoint\n');
								res.write(`data: /messages?sessionId=${localSessionId}\n\n`);
								return;
							}
							// JSON payloads (no event name) -> transform if needed
							if (!data.length) return;
							const payload = data.join('\n');
							try {
								const json = JSON.parse(payload);
								const sess = sessions.get(localSessionId);
								if (sess) rewriteToolsPayload(json, sess);
								const out = JSON.stringify(json);
								res.write(`data: ${out}\n\n`);
							} catch {
								// pass-through raw if not JSON
								res.write(`data: ${payload}\n\n`);
							}
						});
					}
				} catch (e) {
					console.warn(`[${cfg.serverName}] upstream SSE error`, (e as Error).message);
				} finally {
					closeAll();
				}
			})().catch(() => closeAll());
		} catch (e) {
			res.write('event: error\n');
			res.write(`data: ${(e as Error).message}\n\n`);
		}
	});

	app.post('/messages', (req, res) => {
		const sid = (req.query.sessionId as string) || (req.query.session_id as string);
		if (!sid) return res.status(400).json({ error: 'sessionId required' });
		const sess = sessions.get(sid);
		if (!sess) return res.status(404).json({ error: 'unknown session' });
		if (!sess.upstreamMessagesUrl) return res.status(503).json({ error: 'upstream not ready' });
		const bodyText = (req.body as Buffer | undefined)?.toString('utf-8') || '';
		let json: JsonValue | undefined = undefined;
		try {
			json = JSON.parse(bodyText);
		} catch {
			/* ignore */
		}
		if (json) {
			rewriteOutgoing(json, sess);
		}
		const finalBody = json ? JSON.stringify(json) : bodyText;
		fetch(sess.upstreamMessagesUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: finalBody,
		})
			.then(() => {
				res.status(200).end();
			})
			.catch(e => {
				res.status(502).json({ error: (e as Error).message });
			});
	});

	app.listen(opts.port, () => {
		console.log(`[${cfg.serverName}] listening :${opts.port} -> ${opts.upstreamUrl}`);
	});
}
