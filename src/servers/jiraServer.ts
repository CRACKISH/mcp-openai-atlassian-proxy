import { JsonObject, JsonValue } from '../types/json.js';
import { FetchedDocument, SearchResults } from '../types/tools.js';
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
	mapSearchResults(raw: JsonValue): SearchResults {
		const container = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
		const issuesSrc = container['issues'] ?? container['results'] ?? container['data'] ?? [];
		const arr = Array.isArray(issuesSrc) ? issuesSrc : [];
		const list = arr.map(item => {
			const rec = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
			const idVal = rec['key'] ?? rec['id'] ?? '';
			const fields =
				rec['fields'] && typeof rec['fields'] === 'object'
					? (rec['fields'] as Record<string, unknown>)
					: undefined;
			const summary = fields?.['summary'] ?? rec['summary'];
			const urlVal = rec['url'] ?? rec['webUrl'] ?? rec['self'] ?? '';
			return {
				id: String(idVal),
				title: String(summary ?? `Issue ${idVal || 'N/A'}`),
				url: String(urlVal),
			};
		});
		return { results: list };
	},
};

const jiraFetchDelegate: FetchDelegate = {
	prepareFetchArguments(id: string): JsonObject {
		return { issue_key: id };
	},
	mapFetchResults(raw: JsonValue): FetchedDocument {
		const doc = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
		const idVal = doc['key'] ?? doc['id'] ?? 'unknown';
		const fields =
			doc['fields'] && typeof doc['fields'] === 'object'
				? (doc['fields'] as Record<string, unknown>)
				: undefined;
		const titleVal = fields?.['summary'] ?? doc['summary'] ?? `Issue ${idVal}`;
		const urlVal = doc['url'] ?? doc['webUrl'] ?? doc['self'] ?? '';
		const parts: string[] = [];
		if (typeof doc['summary'] === 'string') parts.push(`Summary: ${doc['summary']}`);
		if (typeof doc['description'] === 'string')
			parts.push(`Description:\n${doc['description']}`);
		const statusObj =
			doc['status'] && typeof doc['status'] === 'object'
				? (doc['status'] as Record<string, unknown>)
				: undefined;
		const fieldsStatus =
			fields?.['status'] && typeof fields['status'] === 'object'
				? (fields['status'] as Record<string, unknown>)
				: undefined;
		const statusName = statusObj?.['name'] ?? fieldsStatus?.['name'];
		if (statusName) parts.push(`Status: ${statusName}`);
		const commentsArr =
			doc['comments'] && Array.isArray(doc['comments']) ? (doc['comments'] as unknown[]) : [];
		if (commentsArr.length) {
			parts.push(`Comments (${commentsArr.length}):`);
			for (const c of commentsArr.slice(0, 5)) {
				const cRec = c && typeof c === 'object' ? (c as Record<string, unknown>) : {};
				const author =
					cRec['author'] && typeof cRec['author'] === 'object'
						? (cRec['author'] as Record<string, unknown>)
						: undefined;
				const au = author?.['displayName'] ?? author;
				const body = cRec['body'];
				parts.push(`- ${au ?? 'user'}: ${typeof body === 'string' ? body : ''}`.trim());
			}
		}
		const text = parts.length ? parts.join('\n\n') : JSON.stringify(doc, null, 2);
		return {
			id: String(idVal),
			title: String(titleVal),
			text,
			url: String(urlVal),
			metadata: { source: 'jira' } as JsonObject,
		};
	},
};

export async function startJiraShim(opts: ShimOptions) {
	return startShimServer(
		{ ...opts, publicPrefix: '/jira' },
		{
			productKey: 'jira',
			serverName: 'jira-shim',
			upstreamSearchTool: JIRA_SEARCH_TOOL,
			upstreamFetchTool: JIRA_FETCH_TOOL,
			defaultSearchDescription:
				'Search Jira issues. Input may be a natural language phrase (converted to JQL text ~ "..." ORDER BY updated DESC) or raw JQL (detected if it contains JQL keywords like project,status,=,ORDER BY). Returns up to 10 most recently updated issues with id=issue key, title=summary, url=citation URL.',
			defaultFetchDescription:
				'Fetch a Jira issue by key (id). Returns id, title (summary), text (summary, description, status and up to 5 recent comments), url (issue URL) and metadata.source=jira. Use after search when deeper issue context is needed.',
			searchDelegate: jiraSearchDelegate,
			fetchDelegate: jiraFetchDelegate,
		},
	).catch(err => {
		console.error('jira-shim failed:', err);
		process.exit(1);
	});
}
