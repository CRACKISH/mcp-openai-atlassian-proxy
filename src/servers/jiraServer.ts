import express from 'express';
import cors from 'cors';
import { Server as MCPServer } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { UpstreamClient } from '../remote/index.js';
import { extractJiraKeys, firstJson } from '../utils/index.js';
import { ContentPart, ToolArguments, ToolResponse, JsonValue } from '../types/index.js';

export interface JiraShimOptions {
	port: number;
	upstreamUrl: string; // full /sse endpoint of upstream MCP Atlassian server
}

/** Jira-only shim: exposes search + fetch restricted to Jira issues. */
export async function startJiraShim(options: JiraShimOptions) {
	const upstream = new UpstreamClient({ remoteUrl: options.upstreamUrl });
	await upstream.connectIfNeeded();

	const jiraSearchTool = upstream.findToolName(
		n => n.includes('jira') && (n.includes('search') || n.includes('jql'))
	);
	const jiraGetTool = upstream.findToolName(
		n => n.includes('jira') && (n.includes('get') || n.includes('issue'))
	);

	const mcp = new MCPServer(
		{ name: 'jira-shim', version: '0.1.0' },
		{ capabilities: { tools: {} } }
	);

	mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
			{
				name: 'search',
				description: 'Search Jira issues; returns { objectIds: ["jira:KEY"] }',
				inputSchema: {
					type: 'object',
					properties: {
						query: { type: 'string' },
						topK: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
					},
					required: ['query']
				}
			},
			{
				name: 'fetch',
				description: 'Fetch Jira issues by keys returned from search()',
				inputSchema: {
					type: 'object',
					properties: {
						objectIds: { type: 'array', items: { type: 'string' }, minItems: 1 }
					},
					required: ['objectIds']
				}
			}
		]
	}));

	mcp.setRequestHandler(CallToolRequestSchema, async rawReq => {
		if (!upstream.isConnected()) {
			return { content: [{ type: 'text', text: 'Upstream not connected' }] } as { content: ContentPart[] };
		}
		interface ToolCallLike { params?: { name?: string; arguments?: ToolArguments }; name?: string; arguments?: ToolArguments }
		const req = rawReq as unknown as ToolCallLike;
		const name = req.params?.name || req.name || '';
		const args: ToolArguments = req.params?.arguments || req.arguments || {};
		try {
			if (name === 'search') {
				if (!jiraSearchTool) {
					return { content: [{ type: 'text', text: 'No upstream Jira search tool' }] };
				}
				const searchResponse = await upstream.callTool(jiraSearchTool, {
					query: args.query as JsonValue,
					jql: args.query as JsonValue,
					maxResults: (args.topK as number) || 20
				});
				const ids = extractJiraKeys((searchResponse as ToolResponse).content);
				return { content: [{ type: 'json', data: { objectIds: ids.map(k => `jira:${k}`) } }] };
			}
			if (name === 'fetch') {
				if (!jiraGetTool) {
					return { content: [{ type: 'text', text: 'No upstream Jira get tool' }] };
				}
				const objectIds = ((): string[] => {
					const maybe = (args.objectIds as JsonValue);
					return Array.isArray(maybe) && maybe.every(v => typeof v === 'string') ? (maybe as string[]) : [];
				})();
				interface Resource { objectId: string; type: string; contentType: string; content: JsonValue | null }
				const resources: Resource[] = [];
				for (const rawObjectId of objectIds) {
					const key = rawObjectId.replace(/^jira:/i, '');
					const issueResponse = await upstream.callTool(jiraGetTool, { key, issueKey: key, idOrKey: key });
					const parsed = firstJson(issueResponse.content || []);
					resources.push({
						objectId: `jira:${key}`,
						type: 'jira_issue',
						contentType: 'application/json',
						content: parsed ?? null
					});
				}
				return { content: [{ type: 'json', data: { resources } }] };
			}
			return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
		} catch (e) {
			const message = (e as { message?: string })?.message || String(e);
			return { content: [{ type: 'text', text: `jira-shim error: ${message}` }] };
		}
	});

	const app = express();
	app.use(cors());
	app.get('/healthz', (_req, res) => {
		res.json({ ok: true, upstream: options.upstreamUrl, jiraSearchTool, jiraGetTool });
	});
	app.get('/sse', async (_req, res) => {
		const transport = new SSEServerTransport('/sse', res);
		await mcp.connect(transport);
	});
	app.listen(options.port, () => {
		console.log(`[jira-shim] listening on :${options.port} -> upstream ${options.upstreamUrl}`);
	});
}
