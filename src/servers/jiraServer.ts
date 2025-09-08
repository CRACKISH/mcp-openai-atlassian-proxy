import { startShim, ShimOptions } from './baseShim.js';
import { extractJiraKeys, firstJson } from '../utils/index.js';
import { JsonValue } from '../types/index.js';

export interface JiraShimOptions extends ShimOptions { }

export async function startJiraShim(options: JiraShimOptions) {
	await startShim({
		name: 'jira-shim',
		version: '0.1.0',
		objectIdPrefix: 'jira',
		resourceType: 'jira_issue',
		searchDescription: 'Search Jira issues; returns { objectIds: ["jira:KEY"] }',
		fetchDescription: 'Fetch Jira issues by keys returned from search()',
		startupDelayMs: 1000,
		// Static upstream tool names (no discovery)
		upstreamSearchTool: 'jira_search', // static upstream name
		upstreamGetTool: 'jira_get_issue',
		// Dummy predicates retained only to satisfy typing (never used because static names provided)
		searchToolPredicate: () => false,
		getToolPredicate: () => false,
		buildSearchArgs: (query, topK) => ({ jql: (query || '') as JsonValue, limit: (topK || 20) as JsonValue }),
		buildFetchArgs: id => ({ issue_key: id }),
		extractIds: content => extractJiraKeys(content as unknown as any[]),
		parseFetched: content => firstJson(content as unknown as any[])
	}, options);
}
