import express from 'express';
import cors from 'cors';
import { Server as MCPServer } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { UpstreamClient } from '../remote/upstreamClient.js';

export interface JiraShimOptions {
	port: number;
	upstreamUrl: string; // full /sse endpoint of upstream MCP Atlassian server
}

/**
 * Jira-only shim: exposes search + fetch restricted to Jira issues.
 */
export async function startJiraShim(options: JiraShimOptions) {
	const upstream = new UpstreamClient({ remoteUrl: options.upstreamUrl });
	await upstream.ensureConnected();

	const jiraSearchTool =
		upstream.findToolBy(n => n.includes('jira') && (n.includes('search') || n.includes('jql')));
	const jiraGetTool = upstream.findToolBy(
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
				description: 'Fetch Jira issues by keys from search()',
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

	mcp.setRequestHandler(CallToolRequestSchema, async req => {
		if (!upstream.isConnected()) {
			return { content: [{ type: 'text', text: 'Upstream not connected' }] } as any;
		}
		const name = (req as unknown as { params?: { name?: string; arguments?: Record<string, unknown> }; name?: string }).params?.name || (req as any).name;
		const args = (req as unknown as { params?: { arguments?: Record<string, unknown> }; arguments?: Record<string, unknown> }).params?.arguments || (req as any).arguments || {};
		try {
			if (name === 'search') {
				if (!jiraSearchTool) {
					return { content: [{ type: 'text', text: 'No upstream Jira search tool' }] } as any;
				}
				const r = await upstream.callTool(jiraSearchTool, {
					query: args.query,
					jql: args.query,
					maxResults: args.topK || 20
				});
				const ids = extractJiraKeysFromContent((r as { content?: unknown[] })?.content || []);
				return { content: [{ type: 'json', data: { objectIds: ids.map(k => `jira:${k}`) } }] } as any;
			}
			if (name === 'fetch') {
				if (!jiraGetTool) {
					return { content: [{ type: 'text', text: 'No upstream Jira get tool' }] } as any;
				}
				const objectIds: string[] = Array.isArray(args.objectIds) ? args.objectIds : [];
				const resources = [] as any[];
				for (const oid of objectIds) {
					const key = oid.replace(/^jira:/i, '');
					const r = await upstream.callTool(jiraGetTool, { key, issueKey: key, idOrKey: key });
					const parsed = firstJsonContent((r as { content?: unknown[] })?.content || []);
					resources.push({
						objectId: `jira:${key}`,
						type: 'jira_issue',
						contentType: 'application/json',
						content: parsed ?? null
					});
				}
				return { content: [{ type: 'json', data: { resources } }] } as any;
			}
			return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] } as any;
		} catch (e: any) {
			return { content: [{ type: 'text', text: `jira-shim error: ${e?.message || e}` }] } as any;
		}
	});

	const app = express();
	app.use(cors());
	app.get('/healthz', (_req, res) => {
		res.json({ ok: true, upstream: options.upstreamUrl, jiraSearchTool, jiraGetTool });
	});
	app.get('/sse', async (req, res) => {
		// SDK expects endpoint string + ServerResponse
		const transport = new SSEServerTransport('/sse', res);
		await mcp.connect(transport);
	});
	app.listen(options.port, () => {
		console.log(`[jira-shim] listening on :${options.port} -> upstream ${options.upstreamUrl}`);
	});
}

// Utilities
function extractJiraKeysFromContent(content: any[]): string[] {
	const keys = new Set<string>();
	for (const c of content) {
		if (c.type === 'json' && c.data) {
			collect(c.data);
		} else if (c.type === 'text' && typeof c.text === 'string') {
			const m = c.text.match(/[A-Z][A-Z0-9_]+-\d+/g);
			if (m) m.forEach((k: string) => keys.add(k));
		}
	}
	return [...keys];
	function collect(x: any) {
		if (!x) return;
		if (typeof x === 'string') {
			const m = x.match(/[A-Z][A-Z0-9_]+-\d+/g);
			if (m) m.forEach(k => keys.add(k));
			return;
		}
		if (Array.isArray(x)) return x.forEach(collect);
		if (typeof x === 'object') {
			if (typeof x.key === 'string') keys.add(x.key);
			for (const v of Object.values(x)) collect(v);
		}
	}
}

function firstJsonContent(content: any[]): any | null {
	for (const c of content) if (c.type === 'json') return c.data ?? null;
	for (const c of content)
		if (c.type === 'text' && typeof c.text === 'string') {
			try {
				return JSON.parse(c.text);
			} catch {}
		}
	return null;
}
