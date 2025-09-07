import { ToolResponse, ToolArguments, JsonObject, JsonValue } from '../types/index.js';

export interface UpstreamToolInfo {
	name: string;
	description?: string;
}

export interface UpstreamClientOptions {
	remoteUrl: string;
	retryDelayMs?: number;
	logger?: (line: string, ...rest: string[]) => void;
}

export class UpstreamClient {
	public readonly options: UpstreamClientOptions;
	private tools: UpstreamToolInfo[] = [];
	private connected = false;
	private sessionId = '';
	private messageTemplate: string | null = null; // contains {id}
	private nextId = 1;
	private pending: Record<string, (value: JsonObject) => void> = {};
	private sseAbort: AbortController | null = null;
	private base = '';

	/**
	 * Create a new upstream client.
	 * @param options configuration including upstream SSE URL and optional retry / logger.
	 */
	constructor(options: UpstreamClientOptions) { this.options = { retryDelayMs: 3000, ...options }; }

	/**
	 * Whether a successful connection has been established.
	 */
	public isConnected(): boolean {
		return this.connected;
	}

	/**
	 * Return a shallow copy of the discovered upstream tools.
	 */
	public listTools(): UpstreamToolInfo[] {
		return this.tools.slice();
	}

	/**
	 * Ensure there is an active connection, retrying until success.
	 */
	public async connectIfNeeded(): Promise<void> {
		if (this.connected) return;
		await this.connectLoop();
	}

	private log(msg: string, ...rest: string[]): void { (this.options.logger || console.log)(msg, ...rest); }

private async connectOnce(): Promise<void> {
	const base = this.options.remoteUrl.replace(/\/sse\/?$/, '');
	this.base = base;
	await this.openSse(base);
	await this.waitForEndpoint(10000);
	if (!this.messageTemplate) throw new Error('No endpoint event from upstream');
	await this.request('initialize', {
		protocolVersion: '2025-06-18' as JsonValue,
		capabilities: {} as JsonValue,
		clientInfo: { name: 'atlassian-upstream-proxy', version: '0.1.0' } as JsonValue
	} as JsonObject);
	try {
		await this.notify('notifications/initialized');
	} catch (e) {
		this.log('[upstream] notify failed', (e as Error).message);
	}
	const list = await this.request('tools/list', {});
	const toolsField = (list.result as JsonObject | undefined)?.tools;
	const toolsArr = Array.isArray(toolsField) ? toolsField : [];
	this.tools = toolsArr.filter(v => typeof v === 'object' && v !== null && 'name' in (v as JsonObject)).map(v => ({ name: String((v as JsonObject).name) }));
	this.connected = true;
}

private async openSse(base: string): Promise<void> {
	if (!this.sessionId) this.sessionId = `shim-${Math.random().toString(36).slice(2)}`;
	const sseUrl = base.endsWith('/sse') ? base : `${base}/sse`;
	this.sseAbort?.abort();
	const ac = new AbortController();
	this.sseAbort = ac;
	const res = await fetch(sseUrl, { signal: ac.signal, headers: { Accept: 'text/event-stream' } });
	if (!res.ok || !res.body) throw new Error(`SSE connect failed (${res.status})`);
	void this.consumeSse(res.body.getReader());
}

// legacy probing removed; upstream provides endpoint event

private async waitForEndpoint(ms: number): Promise<void> { if (this.messageTemplate) return; await new Promise(resolve => setTimeout(resolve, ms)); }

	private async consumeSse(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder('utf-8');
		let buffer = '';
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) return;
			buffer += decoder.decode(chunk.value, { stream: true });
			buffer = buffer.replace(/\r/g, ''); // normalize CRLF
			buffer = await this.extractAndProcessEvents(buffer);
		}
	}

	/**
	 * Pull complete SSE events from the buffer and process them. Returns any leftover (partial) buffer.
	 */
	private async extractAndProcessEvents(buffer: string): Promise<string> {
		let idx: number;
		while ((idx = buffer.indexOf('\n\n')) !== -1) {
			const rawEvent = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 2);
			this.handleRawSseEvent(rawEvent);
		}
		return buffer;
	}

	/** Parse a raw SSE event block (without trailing blank line). */
	private handleRawSseEvent(raw: string): void {
		const lines = raw.split('\n');
		let eventName: string | null = null;
		const dataLines: string[] = [];
		for (const l of lines) {
			if (l.startsWith('event:')) eventName = l.slice(6).trim();
			else if (l.startsWith('data:')) dataLines.push(l.slice(5).trimStart());
		}
		if (!dataLines.length) return;
		const payload = dataLines.join('\n');
		if (!payload) return;
		if (eventName === 'endpoint') { this.handleEndpointEvent(payload); return; }
		this.dispatchJsonRpc(payload);
	}

	/** Extract session + template from endpoint notification. */
	private handleEndpointEvent(payload: string): void {
		let path = payload.trim();
		if (!path.startsWith('/')) path = '/' + path;
		const m = path.match(/session_id=([A-Za-z0-9_-]+)/);
		if (m) {
			this.sessionId = m[1];
			const templPath = path.replace(this.sessionId, '{id}');
			this.messageTemplate = this.base + templPath;
		}
	}

	/** Attempt to parse JSON-RPC response and resolve matching pending promise. */
	private dispatchJsonRpc(payload: string): void {
		try {
			const json = JSON.parse(payload) as JsonObject;
			const idValue = (json as { id?: number | string }).id;
			if (idValue !== undefined) {
				const key = String(idValue);
				const resolver = this.pending[key];
				if (resolver) { delete this.pending[key]; resolver(json); }
			}
		} catch (e) {
			this.log('[upstream] sse parse error', (e as Error).message);
		}
	}

private async request(method: string, params: JsonObject): Promise<JsonObject> {
	if (!this.messageTemplate) throw new Error('upstream not ready');
	const id = this.nextId++;
	const url = this.messageTemplate.replace('{id}', this.sessionId);
	const preparedParams = Object.keys(params).length ? params : ({} as JsonObject);
	const bodyObj: JsonObject = { jsonrpc: '2.0', id, method, params: preparedParams as JsonValue } as JsonObject;
	const body = JSON.stringify(bodyObj);
	const p = new Promise<JsonObject>((resolve, reject) => {
		this.pending[String(id)] = resolve;
		setTimeout(() => {
			if (this.pending[String(id)]) {
				delete this.pending[String(id)];
				reject(new Error('upstream request timeout'));
			}
		}, 15000);
	});
	await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
	return p;
}

private async notify(method: string, params?: JsonObject): Promise<void> {
	if (!this.messageTemplate) throw new Error('upstream not ready');
	const url = this.messageTemplate.replace('{id}', this.sessionId);
	const preparedParams = params && Object.keys(params).length ? params : params ? ({} as JsonObject) : undefined;
	const bodyObj: JsonObject = preparedParams ? { jsonrpc: '2.0', method, params: preparedParams as JsonValue } as JsonObject : { jsonrpc: '2.0', method } as JsonObject;
	await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyObj) });
}

	private async connectLoop(): Promise<void> {
		for (;;) {
			try {
				await this.connectOnce();
				return;
			} catch (e) {
				const msg = (e && (e as { message?: string }).message) ? (e as { message: string }).message : String(e);
				this.log(`[upstream] connect failed: ${msg}`);
				await new Promise(resolve => setTimeout(resolve, this.options.retryDelayMs));
			}
		}
	}

	/**
	 * Find the first tool whose name satisfies the provided predicate.
	 * @param predicate case-insensitive predicate on the tool name.
	 */
	public findToolName(predicate: (toolName: string) => boolean): string | null {
		const matchedTool = this.tools.find(tool => predicate(tool.name.toLowerCase()));
		return matchedTool ? matchedTool.name : null;
	}

	/**
	 * Call an upstream tool by name with raw argument object.
	 * @param name tool name
	 * @param args arguments passed to upstream
	 * @returns upstream tool response content array wrapper
	 */
	public async callTool(name: string, args: ToolArguments): Promise<ToolResponse> {
		const response = await this.request('tools/call', { name: name as unknown as JsonValue, arguments: args as JsonValue });
		// Expect result.content like SDK. If structure differs, wrap gracefully.
		const result = response.result as JsonObject | undefined;
		if (result && Array.isArray((result as JsonObject).content)) {
			return { content: (result as JsonObject).content as JsonValue[] } as unknown as ToolResponse;
		}
		return { content: [] } as unknown as ToolResponse;
	}
}
