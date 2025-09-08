import { startShim, ShimOptions } from './baseShim.js';
import { extractConfluenceIds, firstJson } from '../utils/index.js';
import { JsonValue } from '../types/index.js';

export interface ConfluenceShimOptions extends ShimOptions {}

export async function startConfluenceShim(options: ConfluenceShimOptions) {
	await startShim({
		name: 'confluence-shim',
		version: '0.1.0',
		objectIdPrefix: 'confluence',
		resourceType: 'confluence_page',
		searchDescription: 'Search Confluence pages; returns { objectIds: ["confluence:ID"] }',
		fetchDescription: 'Fetch Confluence pages by id',
		startupDelayMs: 1000,
		searchToolPredicate: n => (n.includes('confluence') || n.includes('conf')) && n.includes('search'),
		getToolPredicate: n => (n.includes('confluence') || n.includes('conf')) && (n.includes('get') || n.includes('page')),
		buildSearchArgs: (query, topK) => ({ query: query as JsonValue, cql: query as JsonValue, limit: topK || 20 }),
		buildFetchArgs: id => ({ id, pageId: id }),
		extractIds: content => extractConfluenceIds(content as unknown as any[]),
		parseFetched: content => firstJson(content as unknown as any[])
	}, options);
}

