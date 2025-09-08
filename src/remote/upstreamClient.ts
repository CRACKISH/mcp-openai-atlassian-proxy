// Previous implementation removed above. Clean implementation below ---------
import { ToolArguments, JsonValue } from '../types/index.js';

type JsonObject = { [k: string]: JsonValue };
interface ToolResponse { content?: JsonValue[] }

const PROTOCOL_VERSION = '2025-06-18';
const INIT_INFO = { name: 'atlassian-upstream-proxy', version: '0.2.0' } as const;
const ENDPOINT_WAIT_MS = 3000;
const ENDPOINT_INTERVAL_MS = 50;
const REQUEST_TIMEOUT_MS = 30_000; // increased to reduce spurious timeouts on slower networks
const RETRY_DELAY_DEFAULT_MS = 3000;

export interface UpstreamToolInfo { name: string; description?: string; inputSchema?: JsonObject }
export interface UpstreamClientOptions { remoteUrl: string; retryDelayMs?: number; logger?: (line: string, ...rest: string[]) => void; monitorTools?: string[] }

export class UpstreamClient {
	public readonly options: UpstreamClientOptions;
	private tools: UpstreamToolInfo[] = [];
	private connected = false;
	private sessionId = '';
	private messageTemplate: string | null = null; // contains {id}
	private nextId = 1;
	private pending = new Map<string, { resolve: (v: JsonObject) => void; timer: ReturnType<typeof setTimeout> }>();
	private sseAbort: AbortController | null = null;
	private base = '';
	private connectPromise: Promise<void> | null = null;
	private monitorSet: Set<string>;

	constructor(options: UpstreamClientOptions) {
		this.options = { retryDelayMs: RETRY_DELAY_DEFAULT_MS, ...options };
		this.monitorSet = new Set((options.monitorTools || []).map(t => t.toLowerCase()));
	}

	public isConnected(): boolean { return this.connected; }
	public listTools(): UpstreamToolInfo[] { return [...this.tools]; }

	public async connectIfNeeded(): Promise<void> {
		if (this.connected) return;
		if (this.connectPromise) return this.connectPromise;
		this.connectPromise = (async () => { try { await this.connectLoop(); } finally { this.connectPromise = null; } })();
		return this.connectPromise;
	}

	private log(msg: string, ...rest: string[]): void { (this.options.logger || console.log)(msg, ...rest); }

	private async connectOnce(): Promise<void> {
		this.base = this.options.remoteUrl.replace(/\/sse\/?$/, '');
		await this.openSse();
		await this.waitForEndpoint();
		if (!this.messageTemplate) throw new Error('No endpoint event from upstream');
		await this.request('initialize', { protocolVersion: PROTOCOL_VERSION as JsonValue, capabilities: {} as JsonValue, clientInfo: INIT_INFO as unknown as JsonValue } as JsonObject);
		try { await this.notify('notifications/initialized'); } catch (e) { this.log('[upstream] notify failed', (e as Error).message); }
		await this.loadTools();
		this.logWhitelistedTools();
		this.connected = true;
	}

	private async openSse(): Promise<void> {
		if (!this.sessionId) this.sessionId = `shim-${Math.random().toString(36).slice(2)}`;
		const sseUrl = this.base.endsWith('/sse') ? this.base : `${this.base}/sse`;
		this.sseAbort?.abort();
		const ac = new AbortController();
		this.sseAbort = ac;
		this.log(`[upstream] opening SSE ${sseUrl}`);
		const res = await fetch(sseUrl, { signal: ac.signal, headers: { Accept: 'text/event-stream' } });
		if (!res.ok || !res.body) throw new Error(`SSE connect failed (${res.status})`);
		void this.consumeSse(res.body.getReader()).catch(e => this.log('[upstream] SSE reader error', (e as Error).message));
	}

	private async waitForEndpoint(): Promise<void> {
		const start = Date.now();
		while (!this.messageTemplate && Date.now() - start < ENDPOINT_WAIT_MS) { await this.delay(ENDPOINT_INTERVAL_MS); }
	}

	private async consumeSse(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder('utf-8');
		let buffer = '';
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) return;
				buffer += decoder.decode(chunk.value, { stream: true });
				buffer = buffer.replace(/\r/g, '');
				buffer = this.extractEvents(buffer);
			}
		} finally {
			this.connected = false;
			this.log('[upstream] SSE closed');
		}
	}

	private extractEvents(buffer: string): string {
		let idx: number;
		while ((idx = buffer.indexOf('\n\n')) !== -1) {
			const raw = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 2);
			this.handleEvent(raw);
		}
		return buffer;
	}

	private handleEvent(raw: string): void {
		const lines = raw.split('\n');
		let eventName: string | null = null;
		const dataLines: string[] = [];
		for (const l of lines) {
			if (l.startsWith('event:')) eventName = l.slice(6).trim();
			else if (l.startsWith('data:')) dataLines.push(l.slice(5).trimStart());
		}
		if (!dataLines.length) return;
		const payload = dataLines.join('\n');
		if (eventName === 'endpoint') { this.handleEndpoint(payload); return; }
		this.dispatchJsonRpc(payload);
	}

	private handleEndpoint(payload: string): void {
		let path = payload.trim();
		if (!path.startsWith('/')) path = '/' + path;
		if (/^\/sse\?/i.test(path)) { const original = path; path = path.replace(/^\/sse\?/i, '/messages?'); this.log(`[upstream] rewrote endpoint '${original}' -> '${path}'`); }
		const m = path.match(/(?:session[_-]?id|sessionId)=([A-Za-z0-9_-]+)/);
		if (m) { this.sessionId = m[1]; const templPath = path.replace(this.sessionId, '{id}'); this.messageTemplate = this.base + templPath; }
	}

	private dispatchJsonRpc(payload: string): void {
		try {
			const json = JSON.parse(payload) as JsonObject;
			const idValue = (json as { id?: number | string }).id;
			if (idValue === undefined) return;
			const key = String(idValue);
			const pending = this.pending.get(key);
			if (!pending) return;
			this.pending.delete(key);
			clearTimeout(pending.timer);
			pending.resolve(json);
		} catch (e) { this.log('[upstream] sse parse error', (e as Error).message); }
	}

	private async loadTools(): Promise<void> {
		const list = await this.request('tools/list', {});
		const toolsField = (list.result as JsonObject | undefined)?.tools;
		const arr = Array.isArray(toolsField) ? toolsField : [];
		this.tools = arr.filter(v => typeof v === 'object' && v !== null && 'name' in (v as JsonObject)).map(v => ({
			name: String((v as JsonObject).name),
			description: typeof (v as JsonObject).description === 'string' ? this.cleanDescription(String((v as JsonObject).description)) : undefined,
			inputSchema: (v as JsonObject).inputSchema as JsonObject | undefined
		}));
	}

	private logWhitelistedTools(): void {
		if (!this.monitorSet.size) return; // nothing requested
		for (const t of this.tools) {
			if (!this.monitorSet.has(t.name.toLowerCase())) continue;
			try {
				const schemaKeys = t.inputSchema ? Object.keys(t.inputSchema).slice(0, 10) : [];
				this.log(`[upstream] tool ${t.name}${t.description ? ' - ' + t.description : ''} schemaKeys=${schemaKeys.join(',')}`);
			} catch { /* ignore */ }
		}
	}

	private async request(method: string, params: JsonObject): Promise<JsonObject> {
		if (!this.messageTemplate) throw new Error('upstream not ready');
		const id = this.nextId++;
		const url = this.messageTemplate.replace('{id}', this.sessionId);
		const body: JsonObject = { jsonrpc: '2.0', id, method, params: (Object.keys(params).length ? params : {}) as JsonValue } as JsonObject;
		const promise = new Promise<JsonObject>((resolve, reject) => {
			const timer = setTimeout(() => { if (this.pending.has(String(id))) { this.pending.delete(String(id)); reject(new Error('upstream request timeout')); } }, REQUEST_TIMEOUT_MS);
			this.pending.set(String(id), { resolve, timer });
		});
		await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
		return promise;
	}

	private async notify(method: string, params?: JsonObject): Promise<void> {
		if (!this.messageTemplate) throw new Error('upstream not ready');
		const url = this.messageTemplate.replace('{id}', this.sessionId);
		const body: JsonObject = params && Object.keys(params).length ? { jsonrpc: '2.0', method, params: params as JsonValue } as JsonObject : { jsonrpc: '2.0', method } as JsonObject;
		await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
	}

	private async connectLoop(): Promise<void> {
		for (;;) {
			try { await this.connectOnce(); return; }
			catch (e) { this.log(`[upstream] connect failed: ${(e as { message?: string }).message || String(e)}`); await this.delay(this.options.retryDelayMs!); }
		}
	}

	public findToolName(predicate: (toolName: string) => boolean): string | null {
		const m = this.tools.find(t => predicate(t.name.toLowerCase()));
		return m ? m.name : null;
	}

	public async callTool(name: string, args: ToolArguments): Promise<ToolResponse> {
		const response = await this.callToolRaw(name, args);
		if ((response as { error?: JsonObject }).error) { const err = (response as { error: { message?: string } }).error; throw new Error(err.message || 'upstream tool error'); }
		const result = (response as { result?: JsonObject }).result;
		if (result && Array.isArray((result as JsonObject).content)) { return { content: (result as JsonObject).content as JsonValue[] }; }
		return { content: [] };
	}

	public async callToolRaw(name: string, args: ToolArguments): Promise<JsonObject> {
		return this.request('tools/call', { name: name as unknown as JsonValue, arguments: args as JsonValue });
	}

	private cleanDescription(desc: string): string {
		if (!desc) return '';
		let s = desc.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, ' ');
		s = s.split(/\n\s*\n/)[0].split(/\n/)[0].replace(/\s+/g, ' ').trim();
		if (s.length > 140) s = s.slice(0, 137).trimEnd() + '...';
		return s;
	}

	private delay(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
}

// End refactored file
