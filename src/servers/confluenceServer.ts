import { JsonObject, JsonValue } from '../types/json.js';
import { FetchDelegate, SearchDelegate, ShimOptions, startShimServer } from './shimFactory.js';

const CONFLUENCE_SEARCH_TOOL = 'confluence_search';
const CONFLUENCE_FETCH_TOOL = 'confluence_get_page';

const confluenceSearchDelegate: SearchDelegate = {
	prepareSearchArguments(query: string): JsonObject {
		return { query, limit: 10 };
	},
	mapSearchResults(raw: JsonValue) {
		const r: any = raw as any;
		const items = Array.isArray(r) ? r : (r?.results ?? []);
		const list = items.map((p: any) => ({
			id: String(p?.id ?? p?.pageId ?? ''),
			title: String(p?.title ?? 'Untitled'),
			url: String(p?.url ?? p?._links?.webui ?? ''),
		}));
		return { results: list };
	},
};

const confluenceFetchDelegate: FetchDelegate = {
	prepareFetchArguments(id: string): JsonObject {
		return { page_id: id, include_metadata: true, convert_to_markdown: true };
	},
	mapFetchResults(raw: JsonValue) {
		const doc: any = raw as any;
		const meta = doc?.metadata ?? doc?.page ?? doc ?? {};
		const id = String(meta?.id ?? meta?.pageId ?? 'unknown');
		const title = String(meta?.title ?? 'Untitled');
		const url = String(meta?.url ?? meta?._links?.webui ?? '');
		const text =
			(doc?.content?.value && String(doc.content.value)) ||
			(meta?.content?.value && String(meta.content.value)) ||
			JSON.stringify(doc, null, 2);

		return { id, title, text, url, metadata: { source: 'confluence' } as JsonObject };
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
			defaultSearchDescription: 'Confluence search',
			defaultFetchDescription: 'Confluence page fetch',
			searchDelegate: confluenceSearchDelegate,
			fetchDelegate: confluenceFetchDelegate,
		},
	).catch(err => {
		console.error('confluence-shim failed:', err);
		process.exit(1);
	});
}
