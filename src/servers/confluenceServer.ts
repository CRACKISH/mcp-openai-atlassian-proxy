import express from 'express';
import cors from 'cors';
import { Server as MCPServer } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { UpstreamClient } from '../remote/index.js';
import { extractConfluenceIds, firstJson } from '../utils/index.js';
import { ContentPart, ToolArguments, JsonValue } from '../types/index.js';

export interface ConfluenceShimOptions {
	port: number;
	upstreamUrl: string;
}

export async function startConfluenceShim(options: ConfluenceShimOptions) {
	const upstream = new UpstreamClient({ remoteUrl: options.upstreamUrl });
	await upstream.connectIfNeeded();

	const confSearchTool = findConfSearchTool(upstream);
	const confGetTool = findConfGetTool(upstream);

	const mcp = new MCPServer(
		{ name: 'confluence-shim', version: '0.1.0' },
		{ capabilities: { tools: {} } }
	);

	registerListTools(mcp);
	registerCallHandler(mcp, upstream, confSearchTool, confGetTool);

	await delay(1000); // allow upstream client to stabilize before serving
	startHttpServer(options, mcp, confSearchTool, confGetTool);
}

// --- discovery helpers ----------------------------------------------------
function findConfSearchTool(upstream: UpstreamClient) {
	return upstream.findToolName(n => (n.includes('confluence') || n.includes('conf')) && n.includes('search'));
}
function findConfGetTool(upstream: UpstreamClient) {
	return upstream.findToolName(n => (n.includes('confluence') || n.includes('conf')) && (n.includes('get') || n.includes('page')));
}

// --- MCP handlers ---------------------------------------------------------
function registerListTools(mcp: MCPServer) {
	mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
			{
				name: 'search',
				description: 'Search Confluence pages; returns { objectIds: ["confluence:ID"] }',
				inputSchema: {
					type: 'object',
					properties: { query: { type: 'string' }, topK: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
					required: ['query']
				}
			},
			{
				name: 'fetch',
				description: 'Fetch Confluence pages by id',
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
	confSearchTool: string | null,
	confGetTool: string | null
) {
	mcp.setRequestHandler(CallToolRequestSchema, async rawReq => {
		if (!upstream.isConnected()) return textContent('Upstream not connected');
		const { name, args } = normalizeToolCall(rawReq);
		try {
			if (name === 'search') return handleSearch(upstream, confSearchTool, args);
			if (name === 'fetch') return handleFetch(upstream, confGetTool, args);
			return textContent(`Unknown tool: ${name}`);
		} catch (e) {
			const message = (e as { message?: string })?.message || String(e);
			return textContent(`confluence-shim error: ${message}`);
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
	if (!toolName) throw new Error(`No upstream Confluence ${label} tool`);
}

async function handleSearch(
	upstream: UpstreamClient,
	confSearchTool: string | null,
	args: ToolArguments
) {
	assertToolAvailable(confSearchTool, 'search');
	const searchResponse = await upstream.callTool(confSearchTool!, {
		query: args.query as JsonValue,
		cql: args.query as JsonValue,
		limit: (args.topK as number) || 20
	});
	const ids = extractConfluenceIds(searchResponse.content);
	return { content: [{ type: 'json', data: { objectIds: ids.map(id => `confluence:${id}`) } }] };
}

async function handleFetch(
	upstream: UpstreamClient,
	confGetTool: string | null,
	args: ToolArguments
) {
	assertToolAvailable(confGetTool, 'get');
	const objectIds = parseObjectIds(args.objectIds as JsonValue);
	const resources = await Promise.all(objectIds.map(id => fetchPage(upstream, confGetTool!, id)));
	return { content: [{ type: 'json', data: { resources } }] };
}

function parseObjectIds(maybe: JsonValue): string[] {
	return Array.isArray(maybe) && maybe.every(v => typeof v === 'string') ? (maybe as string[]) : [];
}

async function fetchPage(upstream: UpstreamClient, tool: string, rawObjectId: string) {
	const id = rawObjectId.replace(/^confluence:/i, '');
	const pageResponse = await upstream.callTool(tool, { id, pageId: id });
	const parsed = firstJson(pageResponse.content || []);
	return { objectId: `confluence:${id}`, type: 'confluence_page', contentType: 'application/json', content: parsed ?? null };
}

// --- http server ----------------------------------------------------------
function startHttpServer(
	options: ConfluenceShimOptions,
	mcp: MCPServer,
	confSearchTool: string | null,
	confGetTool: string | null
) {
	const app = express();
	app.use(cors());
	let connectionSeq = 0;
	app.get('/healthz', (_req, res) => {
		res.json({ ok: true, upstream: options.upstreamUrl, confSearchTool, confGetTool });
	});
	app.get('/sse', async (_req, res) => {
		const req = _req;
		const id = ++connectionSeq;
		const ipHeader = (req.headers['x-forwarded-for'] as string | undefined) || req.socket.remoteAddress || 'unknown';
		const ip = ipHeader.split(',')[0].trim();
		const ua = (req.headers['user-agent'] as string | undefined) || '';
		console.log(`[confluence-shim] connect #${id} ip=${ip} ua="${ua}"`);
		res.on('close', () => {
			console.log(`[confluence-shim] disconnect #${id}`);
		});
		const transport = new SSEServerTransport('/sse', res);
		await mcp.connect(transport);
	});
	app.listen(options.port, () => {
		console.log(`[confluence-shim] listening on :${options.port} -> upstream ${options.upstreamUrl}`);
	});
}

// --- small util -----------------------------------------------------------
function textContent(text: string): { content: ContentPart[] } { return { content: [{ type: 'text', text }] } as { content: ContentPart[] }; }

function delay(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

