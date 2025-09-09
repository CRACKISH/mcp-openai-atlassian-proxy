import { JsonObject, JsonValue } from '../types/json.js';
import { FetchDelegate, SearchDelegate, ShimOptions, startShimServer } from './shimFactory.js';

const JIRA_SEARCH_TOOL = 'jira_search';
const JIRA_FETCH_TOOL = 'jira_get_issue';

function looksLikeJql(q: string): boolean {
	const s = String(q || '').toLowerCase();
	return /[=]|order by|project|status|assignee|labels|issue|parent|updated|created/.test(s);
}

const jiraSearchDelegate: SearchDelegate = {
	prepareSearchArguments(query: string): JsonObject {
		const jql = looksLikeJql(query)
			? query
			: `text ~ "${query.replace(/"/g, '\\"')}" ORDER BY updated DESC`;
		return { jql, limit: 10 };
	},
	mapSearchResults(raw: JsonValue) {
		const r: any = raw as any;
		const issues = r?.issues ?? r?.results ?? r?.data ?? [];
		const list = (Array.isArray(issues) ? issues : []).map((it: any) => {
			const id = it?.key ?? it?.id ?? '';
			const title = it?.fields?.summary ?? it?.summary ?? `Issue ${id || 'N/A'}`;
			const url = it?.url ?? it?.webUrl ?? it?.self ?? '';
			return { id: String(id), title: String(title), url: String(url) };
		});
		return { results: list };
	},
};

const jiraFetchDelegate: FetchDelegate = {
	prepareFetchArguments(id: string): JsonObject {
		return { issue_key: id };
	},
	mapFetchResults(raw: JsonValue) {
		const doc: any = raw as any;
		const id = String(doc?.key ?? doc?.id ?? 'unknown');
		const title = String(doc?.fields?.summary ?? doc?.summary ?? `Issue ${id}`);
		const url = String(doc?.url ?? doc?.webUrl ?? doc?.self ?? '');

		const parts: string[] = [];
		if (doc?.summary) parts.push(`Summary: ${doc.summary}`);
		if (doc?.description) parts.push(`Description:\n${doc.description}`);
		const status = doc?.status?.name ?? doc?.fields?.status?.name;
		if (status) parts.push(`Status: ${status}`);

		if (Array.isArray(doc?.comments) && doc.comments.length) {
			parts.push(`Comments (${doc.comments.length}):`);
			for (const c of doc.comments.slice(0, 5)) {
				const au = c?.author?.displayName ?? c?.author;
				parts.push(`- ${au ?? 'user'}: ${c?.body ?? ''}`.trim());
			}
		}

		const text = parts.length ? parts.join('\n\n') : JSON.stringify(doc, null, 2);
		return { id, title, text, url, metadata: { source: 'jira' } as JsonObject };
	},
};

export async function startJiraShim(opts: ShimOptions) {
	return startShimServer(opts, {
		productKey: 'jira',
		serverName: 'jira-shim',
		upstreamSearchTool: JIRA_SEARCH_TOOL,
		upstreamFetchTool: JIRA_FETCH_TOOL,
		defaultSearchDescription: 'Jira search',
		defaultFetchDescription: 'Jira issue fetch',
		searchDelegate: jiraSearchDelegate,
		fetchDelegate: jiraFetchDelegate,
	}).catch(err => {
		console.error('jira-shim failed:', err);
		process.exit(1);
	});
}
