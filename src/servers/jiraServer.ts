import { startShimServer, ShimOptions } from './shimFactory.js';
const JIRA_SEARCH_TOOL = 'jira_search';
const JIRA_FETCH_TOOL = 'jira_get_issue';

export async function startJiraShim(opts: ShimOptions) {
	return startShimServer(opts, {
		productKey: 'jira',
		serverName: 'jira-shim',
		upstreamSearchTool: JIRA_SEARCH_TOOL,
		upstreamFetchTool: JIRA_FETCH_TOOL,
		defaultSearchDescription: 'Jira search',
		defaultFetchDescription: 'Jira issue fetch',
	});
}
