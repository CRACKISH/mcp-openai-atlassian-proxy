import { Client as MCPClient } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ListToolsResult, ToolResponse, ToolArguments, JsonObject, JsonValue } from '../types/json.js';

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
	private readonly client: MCPClient;
	private tools: UpstreamToolInfo[] = [];
	private connected = false;
	private readonly rawMode = process.env.RAW_JSONRPC === '1';
	private rawSessionId = '';
	private rawMessageTemplate: string | null = null; // placeholder {id}
	private rawNextId = 1;
	private rawPending: Record<string, (value: JsonObject) => void> = {};
	private rawSseAbort: AbortController | null = null;

	/**
	 * Create a new upstream client.
	 * @param options configuration including upstream SSE URL and optional retry / logger.
	 */
	constructor(options: UpstreamClientOptions) {
		this.options = { retryDelayMs: 3000, ...options };
		this.client = new MCPClient(
			{ name: 'atlassian-upstream-proxy-client', version: '0.1.0' },
			{ capabilities: { experimental: {} } }
		);
	}

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
		if (!this.rawMode) {
			const transport = new SSEClientTransport(new URL(this.options.remoteUrl));
			interface InternalMCPClient { connect(t: SSEClientTransport): Promise<void>; request<T>(schema: object, params: object): Promise<T>; }
			const internal = this.client as InternalMCPClient;
			await internal.connect(transport);
			const listToolsResult = await internal.request<ListToolsResult>(ListToolsRequestSchema, {});
			this.tools = listToolsResult.tools || [];
			this.connected = true;
			this.log(`[upstream] connected (sdk) ${this.options.remoteUrl}; tools: ${this.tools.map(t => t.name).join(', ')}`);
			return;
		}

		// RAW JSON-RPC MODE
		const base = this.options.remoteUrl.replace(/\/sse\/?$/, '');
		// 1. open SSE stream (receive side)
		await this.openRawSse(base);
		// 2. discover working messages endpoint
		await this.discoverMessagesEndpoint(base);
		// 3. list tools
		const list = await this.rawRequest('list_tools', {});
		const tools = (list.result && Array.isArray((list.result as JsonObject).tools) ? (list.result as JsonObject).tools : []) as JsonValue[];
		this.tools = tools.filter(v => typeof v === 'object' && v !== null && 'name' in (v as JsonObject)).map(v => ({ name: String((v as JsonObject).name) }));
		this.connected = true;
		this.log(`[upstream] connected (raw) ${base}; tools: ${this.tools.map(t => t.name).join(', ')}`);
	}

	private async openRawSse(base: string): Promise<void> {
		this.rawSessionId = `shim-${Math.random().toString(36).slice(2)}`;
		const sseUrl = base.endsWith('/sse') ? `${base}` : `${base}/sse`;
		this.rawSseAbort?.abort();
		const ac = new AbortController();
		this.rawSseAbort = ac;
		const res = await fetch(sseUrl, { signal: ac.signal, headers: { Accept: 'text/event-stream' } });
		if (!res.ok || !res.body) throw new Error(`SSE connect failed (${res.status})`);
		void this.consumeSse(res.body.getReader());
	}

	private async discoverMessagesEndpoint(base: string): Promise<void> {
		const id = `probe-${Date.now()}`;
		const candidateTemplates = [
			`${base}/messages/{id}`,
			`${base}/messages/{id}/`,
			`${base}/messages/session_id={id}`,
			`${base}/messages?session_id={id}`
		];
		for (const tmpl of candidateTemplates) {
			try {
				const url = tmpl.replace('{id}', this.rawSessionId);
				const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'list_tools' });
				const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
				if (res.status === 200 || res.status === 202) {
					this.rawMessageTemplate = tmpl;
					this.log(`[upstream] raw messages endpoint: ${tmpl}`);
					return;
				}
			} catch (e) {
				// ignore and try next
			}
		}
		throw new Error('Unable to discover messages endpoint');
	}

	private async consumeSse(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder('utf-8');
		let buffer = '';
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) return;
			buffer += decoder.decode(chunk.value, { stream: true });
			let idx: number;
			while ((idx = buffer.indexOf('\n\n')) !== -1) {
				const rawEvent = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 2);
				const dataLines = rawEvent.split('\n').filter(l => l.startsWith('data:'));
				if (!dataLines.length) continue;
				const payload = dataLines.map(l => l.slice(5).trimStart()).join('\n');
				if (!payload) continue;
				try {
					const json = JSON.parse(payload) as JsonObject;
					const idValue = json.id;
					if (idValue !== undefined) {
						const key = String(idValue);
						const resolver = this.rawPending[key];
						if (resolver) {
							delete this.rawPending[key];
							resolver(json);
						}
					}
				} catch {
					// ignore malformed
				}
			}
		}
	}

	private async rawRequest(method: string, params: JsonObject): Promise<JsonObject> {
		if (!this.rawMessageTemplate) throw new Error('raw upstream not ready');
		const id = this.rawNextId++;
		const url = this.rawMessageTemplate.replace('{id}', this.rawSessionId);
		const bodyObj: JsonObject = { jsonrpc: '2.0', id, method };
		if (Object.keys(params).length) bodyObj.params = params as JsonValue;
		const body = JSON.stringify(bodyObj);
		const p = new Promise<JsonObject>((resolve, reject) => {
			this.rawPending[String(id)] = resolve;
			// timeout
			setTimeout(() => {
				if (this.rawPending[String(id)]) {
					delete this.rawPending[String(id)];
					reject(new Error(`raw request timeout id=${id}`));
				}
			}, 15000);
		});
		await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
		return p;
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
		if (!this.rawMode) {
			interface InternalMCPClient { request<T>(schema: object, params: object): Promise<T>; }
			const internal = this.client as InternalMCPClient;
			return internal.request<ToolResponse>(CallToolRequestSchema, { name, arguments: args });
		}
		const response = await this.rawRequest('call_tool', { name: name as unknown as JsonValue, arguments: args as JsonValue });
		// Expect result.content like SDK. If structure differs, wrap gracefully.
		const result = response.result as JsonObject | undefined;
		if (result && Array.isArray((result as JsonObject).content)) {
			return { content: (result as JsonObject).content as JsonValue[] } as unknown as ToolResponse;
		}
		return { content: [] } as unknown as ToolResponse;
	}
}
