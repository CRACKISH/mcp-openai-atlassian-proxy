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
		searchToolPredicate: n => n.includes('jira') && (n.includes('search') || n.includes('jql')),
		getToolPredicate: n => n.includes('jira') && (n.includes('get') || n.includes('issue')),
		buildSearchArgs: (query, topK) => ({ query: query as JsonValue, jql: query as JsonValue, maxResults: topK || 20 }),
		buildFetchArgs: id => ({ key: id, issueKey: id, idOrKey: id }),
		extractIds: content => extractJiraKeys(content as unknown as any[]),
		parseFetched: content => firstJson(content as unknown as any[])
	}, options);
}
