import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { log } from '../log.js';
import { VERSION } from '../version.js';

interface TransportType {
	constructor: { name: string };
	close?: () => Promise<void> | void;
	onclose?: (() => void) | null;
	onerror?: ((err: Error) => void) | null;
}
export interface UpstreamRetryOptions {
	heartbeatMs?: number;
	maxConsecutiveHeartbeatFailures?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	jitterMs?: number;
	label?: string;
}

export class UpstreamClient {
	private readonly url: URL;
	private readonly opts: Required<Omit<UpstreamRetryOptions, 'label'>> & { label?: string };
	private client?: Client;
	private transport?: {
		close?: () => Promise<void> | void;
		onclose?: (() => void) | null;
		onerror?: ((err: Error) => void) | null;
	} | null;
	private closed = false;
	private heartbeatTimer?: NodeJS.Timeout;
	private consecutiveFailures = 0;
	private attempt = 0;
	private label?: string;

	constructor(upstreamUrl: string, opts: UpstreamRetryOptions = {}) {
		this.url = new URL(upstreamUrl);
		this.opts = {
			heartbeatMs: 30_000,
			maxConsecutiveHeartbeatFailures: 2,
			baseDelayMs: 500,
			maxDelayMs: 15_000,
			jitterMs: 250,
			...opts,
		};
		this.label = opts.label;
	}

	async connect(): Promise<Client> {
		if (this.client) return this.client;
		while (!this.closed) {
			try {
				this.logConnectAttempt();
				const client = new Client({ name: 'openai-shim-upstream', version: VERSION });
				const transport = await this.createTransportAndConnect(client);
				this.setupTransportEvents(transport);
				this.client = client;
				this.startHeartbeat();
				this.attempt = 0;
				this.logConnected(transport);
				return client;
			} catch {
				const delay = this.backoff();
				this.logBackoff(delay);
				await this.sleep(delay);
			}
		}
		throw new Error('UpstreamClient closed');
	}

	private async createTransportAndConnect(client: Client) {
		const urlStr = this.url.toString();
		if (urlStr.endsWith('/mcp') || urlStr.endsWith('.mcp')) {
			const transport = new StreamableHTTPClientTransport(new URL(this.url));
			await client.connect(transport);
			return transport;
		} else if (urlStr.endsWith('/sse') || urlStr.endsWith('.sse')) {
			const transport = new SSEClientTransport(new URL(this.url));
			await client.connect(transport);
			return transport;
		} else {
			try {
				const transport = new StreamableHTTPClientTransport(new URL(this.url));
				await client.connect(transport);
				return transport;
			} catch {
				const transport = new SSEClientTransport(new URL(this.url));
				await client.connect(transport);
				return transport;
			}
		}
	}

	private setupTransportEvents(transport: TransportType) {
		this.transport = transport;
		if (this.transport) {
			this.transport.onclose = () => this.scheduleReconnect(true);
			this.transport.onerror = () => this.scheduleReconnect(true);
		}
	}

	private logConnectAttempt() {
		log({
			evt: 'upstream_connect_attempt',
			msg: 'attempt',
			shim: this.label,
			attempt: this.attempt,
		});
	}

	private logConnected(transport: TransportType) {
		const name = transport?.constructor?.name;
		log({
			evt: 'upstream_connected',
			msg: 'connected',
			shim: this.label,
			transport: name,
		});
	}

	private logBackoff(delay: number) {
		log({
			evt: 'upstream_backoff',
			msg: 'backoff',
			shim: this.label,
			delayMs: delay,
			attempt: this.attempt,
		});
	}

	private reconnecting = false;
	private scheduleReconnect(fromEvent = false) {
		if (this.closed) return;
		if (this.reconnecting) return;
		this.reconnecting = true;
		this.stopHeartbeat();
		this.client = undefined;
		const t = this.transport;
		if (t) {
			t.onclose = null;
			t.onerror = null;
			if (!fromEvent) {
				try {
					t.close?.();
				} catch {
					void 0;
				}
			}
		}
		this.transport = null;
		log({ evt: 'upstream_reconnect', msg: 'reconnect', shim: this.label });
		void this.connect().finally(() => {
			this.reconnecting = false;
		});
	}

	private startHeartbeat() {
		const { heartbeatMs, maxConsecutiveHeartbeatFailures } = this.opts;
		this.heartbeatTimer?.unref?.();
		this.heartbeatTimer = setInterval(async () => {
			if (!this.client) return;
			try {
				const possible = this.client as
					| { ping?: () => Promise<unknown> }
					| Record<string, unknown>;
				const maybePing = possible.ping;
				if (typeof maybePing === 'function') {
					await maybePing();
				} else if (typeof this.client.listTools === 'function') {
					await this.client.listTools();
				} else if (typeof this.client.listResources === 'function') {
					await this.client.listResources();
				}
				this.consecutiveFailures = 0;
			} catch {
				if (++this.consecutiveFailures >= maxConsecutiveHeartbeatFailures) {
					log({
						evt: 'upstream_heartbeat_fail',
						msg: 'heartbeat_fail',
						shim: this.label,
					});
					this.scheduleReconnect();
				}
			}
		}, heartbeatMs);
	}

	private stopHeartbeat() {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
		}
		this.consecutiveFailures = 0;
	}

	private backoff() {
		const { baseDelayMs, maxDelayMs, jitterMs } = this.opts;
		const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** this.attempt++);
		return delay + Math.floor(Math.random() * jitterMs);
	}

	private sleep(ms: number) {
		return new Promise(res => setTimeout(res, ms));
	}

	async callTool(args: Parameters<Client['callTool']>[0]) {
		const c = await this.connect();
		try {
			return await c.callTool(args);
		} catch {
			log({ evt: 'upstream_call_error', msg: 'call_error', shim: this.label });
			this.scheduleReconnect();
			const c2 = await this.connect();
			return await c2.callTool(args);
		}
	}

	async close() {
		this.closed = true;
		this.stopHeartbeat();
		log({ evt: 'upstream_close', msg: 'close', shim: this.label });
		try {
			await this.transport?.close?.();
		} catch {
			void 0;
		}
		try {
			await (this.client as { close?: () => Promise<void> })?.close?.();
		} catch {
			void 0;
		}
	}
}

export async function createUpstreamClient(upstreamUrl: string, opts?: UpstreamRetryOptions) {
	const u = new UpstreamClient(upstreamUrl, {
		heartbeatMs: 45_000,
		maxConsecutiveHeartbeatFailures: 2,
		baseDelayMs: 500,
		maxDelayMs: 15_000,
		jitterMs: 300,
		...opts,
	});
	await u.connect();
	return u;
}

export type UpstreamCallable = Pick<UpstreamClient, 'callTool' | 'close'>;
