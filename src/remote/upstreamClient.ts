import { Client as MCPClient } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export interface UpstreamToolInfo {
	name: string;
	description?: string;
}

export interface UpstreamClientOptions {
	remoteUrl: string; // full /sse URL to upstream Atlassian MCP server
	retryDelayMs?: number;
	logger?: (line: string, ...rest: any[]) => void;
}

export class UpstreamClient {
	readonly options: UpstreamClientOptions;
	private client: MCPClient;
	private tools: UpstreamToolInfo[] = [];
	private connected = false;

	constructor(options: UpstreamClientOptions) {
		this.options = { retryDelayMs: 3000, ...options };
		this.client = new MCPClient(
			{ name: 'atlassian-upstream-proxy-client', version: '0.1.0' },
			{ capabilities: { experimental: {} } }
		);
	}

	isConnected() {
		return this.connected;
	}

	getTools() {
		return this.tools.slice();
	}

	async ensureConnected(): Promise<void> {
		if (this.connected) return;
		await this.connectLoop();
	}

	private log(msg: string, ...rest: any[]) {
		(this.options.logger || console.log)(msg, ...rest);
	}

	private async connectOnce() {
		const transport = new SSEClientTransport(new URL(this.options.remoteUrl));
		await (this.client as unknown as { connect: (t: unknown) => Promise<void> }).connect(transport);
		const list: unknown = await (this.client as unknown as { request: (schema: unknown, params: unknown) => Promise<unknown> }).request(
			ListToolsRequestSchema,
			{}
		);
		this.tools = (list as { tools?: UpstreamToolInfo[] } | undefined)?.tools || [];
		this.connected = true;
		this.log(`[upstream] connected: ${this.options.remoteUrl}; tools: ${this.tools.map(t => t.name).join(', ')}`);
	}

	private async connectLoop() {
		for (;;) {
			try {
				await this.connectOnce();
				return;
			} catch (e: any) {
				this.log(`[upstream] connect failed: ${e?.message || e}`);
				await new Promise(r => setTimeout(r, this.options.retryDelayMs));
			}
		}
	}

	findToolBy(predicate: (n: string) => boolean): string | null {
		const t = this.tools.find(t => predicate(t.name.toLowerCase()));
		return t ? t.name : null;
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<{ content?: unknown[] }> {
		const resp: unknown = await (this.client as unknown as { request: (schema: unknown, params: unknown) => Promise<unknown> }).request(
			CallToolRequestSchema,
			{ name, arguments: args }
		);
		return resp as { content?: unknown[] };
	}
}
