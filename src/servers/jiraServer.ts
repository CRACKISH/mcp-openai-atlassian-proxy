import { JsonObject, JsonValue } from '../types/json.js';
import { FetchDelegate, SearchDelegate, ShimOptions } from '../types/shim.js';
import { FetchedDocument, SearchResults } from '../types/tools.js';
import { JIRA_DEFAULT_FETCH_DESCRIPTION, JIRA_DEFAULT_SEARCH_DESCRIPTION } from './descriptions.js';
import { startShimServer } from './shimFactory.js';

const JIRA_SEARCH_TOOL = 'jira_search';
const JIRA_FETCH_TOOL = 'jira_get_issue';

function toCanonicalIssueUrl(issueKey: string, rawUrl: string): string {
	if (!issueKey) return rawUrl;
	const browse = `/browse/${issueKey}`;
	if (!rawUrl) return browse;
	return rawUrl.replace(/^(https?:\/\/[^/]+)\/rest\/api\/\d+\/issue\/\d+.*$/i, `$1${browse}`);
}

function looksLikeJql(q: string): boolean {
	const s = String(q || '').toLowerCase();
	return /[=]|order by|project|status|assignee|labels|issue|parent|updated|created/.test(s);
}

const rec = (v: JsonValue): Record<string, JsonValue> =>
	v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, JsonValue>) : {};
const arr = (v: JsonValue): JsonValue[] => (Array.isArray(v) ? (v as JsonValue[]) : []);
const firstDefined = (...vals: JsonValue[]): JsonValue | undefined =>
	vals.find(v => v !== undefined && v !== null);

interface JiraIssueLite {
	id: string;
	key: string;
	summary?: string;
	rawUrl?: string;
}

function toLite(issue: JsonValue): JiraIssueLite | undefined {
	const r = rec(issue);
	const key = r['key'];
	const id = firstDefined(key, r['id'], '') as unknown as string;
	if (!id && !key) return undefined;
	const fields = rec(r['fields']);
	const summary = (fields['summary'] ?? r['summary']) as string | undefined;
	const rawUrl = (r['url'] ?? r['webUrl'] ?? r['self']) as string | undefined;
	return { id: String(id), key: typeof key === 'string' ? key : String(id), summary, rawUrl };
}

const jiraSearchDelegate: SearchDelegate = {
	prepareSearchArguments(query: string): JsonObject {
		const jql = looksLikeJql(query)
			? query
			: `text ~ "${query.replace(/"/g, '\\"')}" ORDER BY updated DESC`;
		return { jql, limit: 20 };
	},
	mapSearchResults(raw: JsonValue): SearchResults {
		const c = rec(raw);
		const issues = arr(
			(c['issues'] as JsonValue) ?? (c['results'] as JsonValue) ?? (c['data'] as JsonValue),
		);
		const results = issues
			.map(toLite)
			.filter(Boolean)
			.map(issue => {
				const i = issue as JiraIssueLite;
				const urlVal = toCanonicalIssueUrl(i.key, i.rawUrl || '');
				return {
					id: i.id,
					title: i.summary ? String(i.summary) : `Issue ${i.id || 'N/A'}`,
					url: String(urlVal),
				};
			});
		return { results };
	},
};

const jiraFetchDelegate: FetchDelegate = {
	prepareFetchArguments(id: string): JsonObject {
		return {
			issue_key: id,
		};
	},
	mapFetchResults(raw: JsonValue): FetchedDocument {
		const doc = rec(raw);
		const fields = rec(doc['fields']);
		const key = (doc['key'] as string) || (doc['id'] as string) || 'unknown';
		const issueKey =
			typeof doc['key'] === 'string' && /-/.test(String(doc['key']))
				? String(doc['key'])
				: String(key);
		const title = (fields['summary'] || doc['summary'] || `Issue ${issueKey}`) as string;
		const rawUrl = (doc['url'] ?? doc['webUrl'] ?? doc['self'] ?? '') as string;
		const url = toCanonicalIssueUrl(issueKey, rawUrl);

		// Text assembly
		const parts: string[] = [];
		if (typeof doc['summary'] === 'string') parts.push(`Summary: ${doc['summary']}`);
		if (typeof doc['description'] === 'string')
			parts.push(`Description:\n${doc['description']}`);
		const statusObj = rec(doc['status']);
		const statusObjFields = rec(fields['status']);
		const statusName = (statusObj['name'] || statusObjFields['name']) as string | undefined;
		if (statusName) parts.push(`Status: ${statusName}`);
		const commentsArr = arr(doc['comments']);
		if (commentsArr.length) {
			parts.push(`Comments (${commentsArr.length}):`);
			for (const c of commentsArr.slice(0, 5)) {
				const cRec = rec(c);
				const author = rec(cRec['author']);
				const body = typeof cRec['body'] === 'string' ? cRec['body'] : '';
				parts.push(
					`- ${(author['displayName'] as string) || author || 'user'}: ${body}`.trim(),
				);
			}
		}
		const text = parts.length ? parts.join('\n\n') : JSON.stringify(doc, null, 2);

		// Metadata enrichment
		const exclude = new Set<string>([
			'id',
			'key',
			'summary',
			'description',
			'status',
			'comments',
			'url',
			'webUrl',
			'self',
		]);
		const metadata: JsonObject = { source: 'jira' };
		for (const [k, v] of Object.entries(doc)) if (!exclude.has(k)) metadata[k] = v as JsonValue;
		if (Object.keys(statusObj).length)
			metadata['statusObject'] = statusObj as unknown as JsonValue;
		if (commentsArr.length)
			metadata['commentsExcerpt'] = commentsArr.slice(0, 5) as unknown as JsonValue;

		return { id: String(issueKey), title: String(title), text, url: String(url), metadata };
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
			defaultSearchDescription: JIRA_DEFAULT_SEARCH_DESCRIPTION,
			defaultFetchDescription: JIRA_DEFAULT_FETCH_DESCRIPTION,
			searchDelegate: jiraSearchDelegate,
			fetchDelegate: jiraFetchDelegate,
		},
	).catch(err => {
		console.error('jira-shim failed:', err);
		process.exit(1);
	});
}
