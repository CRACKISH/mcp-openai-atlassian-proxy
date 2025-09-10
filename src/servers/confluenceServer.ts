import { JsonObject, JsonValue } from '../types/json.js';
import { FetchDelegate, SearchDelegate, ShimOptions } from '../types/shim.js';
import { FetchedDocument, SearchResults } from '../types/tools.js';
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

const confluenceSearchDelegate: SearchDelegate = {
	prepareSearchArguments(query: string): JsonObject {
		return { query, limit: 10 };
	},
	mapSearchResults(raw: JsonValue): SearchResults {
		const itemsSrc = Array.isArray(raw)
			? raw
			: raw &&
				  typeof raw === 'object' &&
				  Array.isArray((raw as Record<string, unknown>)['results'])
				? ((raw as Record<string, unknown>)['results'] as unknown[])
				: [];
		const list = itemsSrc.map(p => {
			const rec = p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
			const idVal = rec['id'] ?? rec['pageId'] ?? '';
			const titleVal = rec['title'] ?? 'Untitled';
			const links =
				rec['_links'] && typeof rec['_links'] === 'object'
					? (rec['_links'] as Record<string, unknown>)
					: undefined;
			const rawUrl = rec['url'] ?? links?.['webui'] ?? '';
			const absolute = typeof rec['url'] === 'string' ? rec['url'] : undefined;
			const urlVal = normalizeConfluenceUrl(rawUrl as JsonValue, absolute);
			return { id: String(idVal), title: String(titleVal), url: urlVal };
		});
		return { results: list };
	},
};

const confluenceFetchDelegate: FetchDelegate = {
	prepareFetchArguments(id: string): JsonObject {
		return { page_id: id, include_metadata: true, convert_to_markdown: true };
	},
	mapFetchResults(raw: JsonValue): FetchedDocument {
		const doc = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
		const meta =
			doc['metadata'] && typeof doc['metadata'] === 'object'
				? (doc['metadata'] as Record<string, unknown>)
				: doc['page'] && typeof doc['page'] === 'object'
					? (doc['page'] as Record<string, unknown>)
					: doc;
		const idVal = meta['id'] ?? meta['pageId'] ?? 'unknown';
		const titleVal = meta['title'] ?? 'Untitled';
		const links =
			meta['_links'] && typeof meta['_links'] === 'object'
				? (meta['_links'] as Record<string, unknown>)
				: undefined;
		const rawUrl = meta['url'] ?? links?.['webui'] ?? '';
		const absolute = typeof meta['url'] === 'string' ? (meta['url'] as string) : undefined;
		const urlVal = normalizeConfluenceUrl(rawUrl as JsonValue, absolute);
		const contentObj =
			doc['content'] && typeof doc['content'] === 'object'
				? (doc['content'] as Record<string, unknown>)
				: undefined;
		const metaContent =
			meta['content'] && typeof meta['content'] === 'object'
				? (meta['content'] as Record<string, unknown>)
				: undefined;
		const textCandidate =
			(contentObj?.['value'] && String(contentObj['value'])) ||
			(metaContent?.['value'] && String(metaContent['value'])) ||
			JSON.stringify(doc, null, 2);
		const textVal = String(textCandidate);
		const metadata: JsonObject = { source: 'confluence' };
		return {
			id: String(idVal),
			title: String(titleVal),
			text: textVal,
			url: String(urlVal),
			metadata,
		};
	},
};

export async function startConfluenceShim(opts: ShimOptions) {
	return startShimServer(
		{ ...opts },
		{
			productKey: 'confluence',
			serverName: 'confluence-shim',
			upstreamSearchTool: CONFLUENCE_SEARCH_TOOL,
			upstreamFetchTool: CONFLUENCE_FETCH_TOOL,
			defaultSearchDescription:
				'Search Confluence pages by keyword phrase. Returns up to 10 pages with id=page id, title=page title, url=citation URL suitable for follow‑up fetch. Use concise topical queries (e.g. release notes Q2, architecture overview).',
			defaultFetchDescription:
				'Fetch a Confluence page by id to get full page text (markdown if available) plus metadata.source=confluence. Use after search to retrieve detailed content for reasoning or citation.',
			searchDelegate: confluenceSearchDelegate,
			fetchDelegate: confluenceFetchDelegate,
		},
	).catch(err => {
		console.error('confluence-shim failed:', err);
		process.exit(1);
	});
}
