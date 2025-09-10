import { JsonObject, JsonValue } from '../types/json.js';
import { FetchDelegate, SearchDelegate, ShimOptions } from '../types/shim.js';
import { FetchedDocument, SearchResults } from '../types/tools.js';
import {
	CONFLUENCE_DEFAULT_FETCH_DESCRIPTION,
	CONFLUENCE_DEFAULT_SEARCH_DESCRIPTION,
} from './descriptions.js';
import { startShimServer } from './shimFactory.js';

const CONFLUENCE_SEARCH_TOOL = 'confluence_search';
const CONFLUENCE_FETCH_TOOL = 'confluence_get_page';

function normalizeConfluenceUrl(urlVal: JsonValue, fallbackAbsolute?: string): string {
	const raw = typeof urlVal === 'string' ? urlVal : '';
	if (!raw) return '';
	if (/^https?:\/\//i.test(raw)) return raw;
	if (fallbackAbsolute && /^https?:\/\//i.test(fallbackAbsolute)) {
		try {
			const u = new URL(fallbackAbsolute);
			const rel = raw.startsWith('/') ? raw : `/${raw}`;
			return `${u.origin}${rel}`;
		} catch {
			return raw;
		}
	}
	return raw;
}

const rec = (v: JsonValue): Record<string, JsonValue> =>
	v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, JsonValue>) : {};

interface ConfluenceLitePage {
	id: string;
	title: string;
	url: string;
}

function toLitePage(v: JsonValue): ConfluenceLitePage | undefined {
	const r = rec(v);
	const id = (r['id'] ?? r['pageId'] ?? '') as string;
	const title = (r['title'] ?? 'Untitled') as string;
	const links = rec(r['_links']);
	const rawUrl = (r['url'] ?? links['webui'] ?? '') as string;
	const absolute = typeof r['url'] === 'string' ? (r['url'] as string) : undefined;
	const url = normalizeConfluenceUrl(rawUrl, absolute);
	return { id: String(id), title: String(title), url };
}

const confluenceSearchDelegate: SearchDelegate = {
	prepareSearchArguments(query: string): JsonObject {
		return { query, limit: 20 };
	},
	mapSearchResults(raw: JsonValue): SearchResults {
		const base: JsonValue = raw;
		let listSrc: JsonValue[] = [];
		if (Array.isArray(base)) listSrc = base as JsonValue[];
		else {
			const container = rec(base);
			const maybe = container['results'];
			if (Array.isArray(maybe)) listSrc = maybe as JsonValue[];
		}
		const results = listSrc
			.map(v => toLitePage(v))
			.filter((p): p is ConfluenceLitePage => Boolean(p));
		return { results };
	},
};

const confluenceFetchDelegate: FetchDelegate = {
	prepareFetchArguments(id: string): JsonObject {
		return { page_id: id, include_metadata: true, convert_to_markdown: true };
	},
	mapFetchResults(raw: JsonValue): FetchedDocument {
		const doc = rec(raw);
		const meta = Object.keys(rec(doc['metadata'])).length
			? rec(doc['metadata'])
			: Object.keys(rec(doc['page'])).length
				? rec(doc['page'])
				: doc;
		const id = (meta['id'] ?? meta['pageId'] ?? 'unknown') as string;
		const title = (meta['title'] ?? 'Untitled') as string;
		const links = rec(meta['_links']);
		const rawUrl = (meta['url'] ?? links['webui'] ?? '') as string;
		const absolute = typeof meta['url'] === 'string' ? (meta['url'] as string) : undefined;
		const url = normalizeConfluenceUrl(rawUrl, absolute);
		const contentObj = rec(doc['content']);
		const metaContent = rec(meta['content']);
		const textCandidate = (contentObj['value'] ||
			metaContent['value'] ||
			JSON.stringify(doc, null, 2)) as string;
		const text = String(textCandidate);

		// Metadata enrichment: copy remaining doc fields + refined meta subset
		const exclude = new Set<string>(['id', 'pageId', 'title', 'url', '_links']);
		const metadata: JsonObject = { source: 'confluence' };
		for (const [k, v] of Object.entries(doc)) if (!exclude.has(k)) metadata[k] = v as JsonValue;
		const metaCopy: Record<string, JsonValue> = {};
		for (const [k, v] of Object.entries(meta))
			if (!exclude.has(k)) metaCopy[k] = v as JsonValue;
		if (Object.keys(metaCopy).length) metadata['pageMeta'] = metaCopy as unknown as JsonValue;

		return { id: String(id), title: String(title), text, url: String(url), metadata };
	},
};

export async function startConfluenceShim(opts: ShimOptions) {
	return startShimServer(
		{ ...opts, publicPrefix: '/confluence' },
		{
			productKey: 'confluence',
			serverName: 'confluence-shim',
			upstreamSearchTool: CONFLUENCE_SEARCH_TOOL,
			upstreamFetchTool: CONFLUENCE_FETCH_TOOL,
			defaultSearchDescription: CONFLUENCE_DEFAULT_SEARCH_DESCRIPTION,
			defaultFetchDescription: CONFLUENCE_DEFAULT_FETCH_DESCRIPTION,
			searchDelegate: confluenceSearchDelegate,
			fetchDelegate: confluenceFetchDelegate,
		},
	).catch(err => {
		console.error('confluence-shim failed:', err);
		process.exit(1);
	});
}
