import { JsonObject } from './json.js';

export interface SearchResultItem {
	id: string;
	title: string;
	url: string;
}
export interface SearchResults {
	results: SearchResultItem[];
}
export interface FetchedDocument {
	id: string;
	title: string;
	text: string;
	url: string;
	metadata: JsonObject;
}
