import type { JsonObject } from '../types/index.js';
export { JsonObject } from '../types/index.js';


export interface UpstreamToolInfo {
	name: string;
	description?: string;
	inputSchema?: JsonObject;
}
export interface UpstreamClientOptions {
	remoteUrl: string;
	retryDelayMs?: number;
	logger?: (line: string, ...rest: string[]) => void;
	monitorTools?: string[];
	logPrefix?: string;
}

export class UpstreamClient {
	public readonly options: UpstreamClientOptions;
	private monitorSet: Set<string>;

	constructor(options: UpstreamClientOptions) {
		this.options = { ...options };
		this.monitorSet = new Set((options.monitorTools || []).map(t => t.toLowerCase()));
	}
}

