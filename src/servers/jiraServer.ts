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

	const jiraSearchTool = findJiraSearchTool(upstream);
	const jiraGetTool = findJiraGetTool(upstream);

	const mcp = new MCPServer(
		{ name: 'jira-shim', version: '0.1.0' },
		{ capabilities: { tools: {} } }
	);

	registerListTools(mcp);
	registerCallHandler(mcp, upstream, jiraSearchTool, jiraGetTool);

	// Small startup delay to ensure upstream fully settled before accepting clients
	await delay(1000);
	startHttpServer(options, mcp, jiraSearchTool, jiraGetTool);
}

// --- discovery helpers ----------------------------------------------------
function findJiraSearchTool(upstream: UpstreamClient): string | null {
	return upstream.findToolName(n => n.includes('jira') && (n.includes('search') || n.includes('jql')));
}
function findJiraGetTool(upstream: UpstreamClient): string | null {
	return upstream.findToolName(n => n.includes('jira') && (n.includes('get') || n.includes('issue')));
}

// --- MCP handlers ---------------------------------------------------------
function registerListTools(mcp: MCPServer) {
	mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
			{
				name: 'search',
				description: 'Search Jira issues; returns { objectIds: ["jira:KEY"] }',
				inputSchema: {
					type: 'object',
					properties: { query: { type: 'string' }, topK: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
					required: ['query']
				}
			},
			{
				name: 'fetch',
				description: 'Fetch Jira issues by keys returned from search()',
				inputSchema: {
					type: 'object',
					properties: { objectIds: { type: 'array', items: { type: 'string' }, minItems: 1 } },
					required: ['objectIds']
				}
			}
		]
	}));
}

function registerCallHandler(
	mcp: MCPServer,
	upstream: UpstreamClient,
	jiraSearchTool: string | null,
	jiraGetTool: string | null
) {
	mcp.setRequestHandler(CallToolRequestSchema, async rawReq => {
		if (!upstream.isConnected()) return textContent('Upstream not connected');
		const { name, args } = normalizeToolCall(rawReq);
		try {
			if (name === 'search') return handleSearch(upstream, jiraSearchTool, args);
			if (name === 'fetch') return handleFetch(upstream, jiraGetTool, args);
			return textContent(`Unknown tool: ${name}`);
		} catch (e) {
			const message = (e as { message?: string })?.message || String(e);
			return textContent(`jira-shim error: ${message}`);
		}
	});
}

// --- tool implementations -------------------------------------------------
function normalizeToolCall(rawReq: object): { name: string; args: ToolArguments } {
	interface ToolCallLike { params?: { name?: string; arguments?: ToolArguments }; name?: string; arguments?: ToolArguments }
	const req = rawReq as ToolCallLike;
	return { name: req.params?.name || req.name || '', args: req.params?.arguments || req.arguments || {} };
}

function assertToolAvailable(toolName: string | null, label: string) {
	if (!toolName) throw new Error(`No upstream Jira ${label} tool`);
}

async function handleSearch(
	upstream: UpstreamClient,
	jiraSearchTool: string | null,
	args: ToolArguments
) {
	assertToolAvailable(jiraSearchTool, 'search');
	const searchResponse = await upstream.callTool(jiraSearchTool!, {
		query: args.query as JsonValue,
		jql: args.query as JsonValue,
		maxResults: (args.topK as number) || 20
	});
	const ids = extractJiraKeys((searchResponse as ToolResponse).content);
	return { content: [{ type: 'json', data: { objectIds: ids.map(k => `jira:${k}`) } }] };
}

async function handleFetch(
	upstream: UpstreamClient,
	jiraGetTool: string | null,
	args: ToolArguments
) {
	assertToolAvailable(jiraGetTool, 'get');
	const objectIds = parseObjectIds(args.objectIds as JsonValue);
	const resources = await Promise.all(objectIds.map(id => fetchJiraIssue(upstream, jiraGetTool!, id)));
	return { content: [{ type: 'json', data: { resources } }] };
}

function parseObjectIds(maybe: JsonValue): string[] {
	return Array.isArray(maybe) && maybe.every(v => typeof v === 'string') ? (maybe as string[]) : [];
}

async function fetchJiraIssue(upstream: UpstreamClient, tool: string, rawObjectId: string) {
	const key = rawObjectId.replace(/^jira:/i, '');
	const issueResponse = await upstream.callTool(tool, { key, issueKey: key, idOrKey: key });
	const parsed = firstJson(issueResponse.content || []);
	return { objectId: `jira:${key}`, type: 'jira_issue', contentType: 'application/json', content: parsed ?? null };
}

// --- http server ----------------------------------------------------------
function startHttpServer(
	options: JiraShimOptions,
	mcp: MCPServer,
	jiraSearchTool: string | null,
	jiraGetTool: string | null
) {
	const app = express();
	app.use(cors());

	let connectionSeq = 0; // incremental id for SSE clients
	app.get('/healthz', (_req, res) => {
		res.json({ ok: true, upstream: options.upstreamUrl, jiraSearchTool, jiraGetTool });
	});
	app.get('/sse', async (_req, res) => {
		const req = _req; // alias for clarity
		const id = ++connectionSeq;
		const ipHeader = (req.headers['x-forwarded-for'] as string | undefined) || req.socket.remoteAddress || 'unknown';
		const ip = ipHeader.split(',')[0].trim();
		const ua = (req.headers['user-agent'] as string | undefined) || '';
		console.log(`[jira-shim] connect #${id} ip=${ip} ua="${ua}"`);
		res.on('close', () => {
			console.log(`[jira-shim] disconnect #${id}`);
		});
		const transport = new SSEServerTransport('/sse', res);
		await mcp.connect(transport);
	});
	app.listen(options.port, () => {
		console.log(`[jira-shim] listening on :${options.port} -> upstream ${options.upstreamUrl}`);
	});
}

// --- small util -----------------------------------------------------------
function textContent(text: string): { content: ContentPart[] } { return { content: [{ type: 'text', text }] } as { content: ContentPart[] }; }

function delay(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }
