import { Client as MCPClient } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ListToolsResult, ToolResponse, ToolArguments } from '../types/json.js';

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
		const transport = new SSEClientTransport(new URL(this.options.remoteUrl));
		interface InternalMCPClient { connect(t: SSEClientTransport): Promise<void>; request<T>(schema: object, params: object): Promise<T>; }
		const internal = this.client as InternalMCPClient;
		await internal.connect(transport);
		const listToolsResult = await internal.request<ListToolsResult>(ListToolsRequestSchema, {});
		this.tools = listToolsResult.tools || [];
		this.connected = true;
		this.log(`[upstream] connected: ${this.options.remoteUrl}; tools: ${this.tools.map(t => t.name).join(', ')}`);
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
		interface InternalMCPClient { request<T>(schema: object, params: object): Promise<T>; }
		const internal = this.client as InternalMCPClient;
		return internal.request<ToolResponse>(CallToolRequestSchema, { name, arguments: args });
	}
}
