import { JsonObject, JsonValue } from './json.js';
import { FetchedDocument, SearchResults } from './tools.js';

export interface ShimOptions {
	port: number;
	upstreamUrl: string;
	publicPrefix?: string;
}

export interface SearchDelegate {
	prepareSearchArguments(query: string): JsonObject;
	mapSearchResults(rawResults: JsonValue): SearchResults;
}

export interface FetchDelegate {
	prepareFetchArguments(id: string): JsonObject;
	mapFetchResults(rawResults: JsonValue): FetchedDocument;
}

export interface ProductShimConfig {
	productKey: string;
	serverName: string;
	upstreamSearchTool: string;
	upstreamFetchTool: string;
	defaultSearchDescription: string;
	defaultFetchDescription: string;
	searchDelegate: SearchDelegate;
	fetchDelegate: FetchDelegate;
}

export type { FetchedDocument, SearchResults };
