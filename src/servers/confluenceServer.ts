import { startShimServer, ShimOptions } from './shimFactory.js';

const CONFLUENCE_SEARCH_TOOL = 'confluence_search';
const CONFLUENCE_FETCH_TOOL = 'confluence_get_page';

export async function startConfluenceShim(opts: ShimOptions) {
	return startShimServer(opts, {
		productKey: 'confluence',
		serverName: 'confluence-shim',
		upstreamSearchTool: CONFLUENCE_SEARCH_TOOL,
		upstreamFetchTool: CONFLUENCE_FETCH_TOOL,
		defaultSearchDescription: 'Confluence search',
		defaultFetchDescription: 'Confluence page fetch',
	});
}
