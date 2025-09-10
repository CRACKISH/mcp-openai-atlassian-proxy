import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { log } from '../log.js';
import { JsonValue } from '../types/json.js';
import { ProductShimConfig } from '../types/shim.js';
import { extractJsonFromContent } from '../utils/jsonExtract.js';
import { VERSION } from '../version.js';
import { UpstreamCallable } from './upstreamClient.js';

export interface McpServerBuildDeps {
	cfg: ProductShimConfig;
	upstream: UpstreamCallable;
}

export function buildMcpServer({ cfg, upstream }: McpServerBuildDeps) {
	const mcp = new McpServer({ name: cfg.serverName, version: VERSION });

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
			log({ evt: 'tool_search_map', msg: 'mapped', shim: cfg.productKey });
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
			log({ evt: 'tool_fetch_map', msg: 'mapped', shim: cfg.productKey });
			return { content: [{ type: 'text', text: JSON.stringify(mapped) }] };
		},
	);

	return mcp;
}
