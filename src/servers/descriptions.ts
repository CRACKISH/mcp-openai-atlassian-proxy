export const JIRA_DEFAULT_SEARCH_DESCRIPTION = `
Search Jira issues (limit 20). Input can be natural language (auto converted to JQL: text ~ "<query>" ORDER BY updated DESC) OR raw JQL (detected via JQL keywords like project, status, =, ORDER BY, etc.). If the user explicitly gives an issue key (e.g. RND-123) you can fetch directly; otherwise search first to narrow scope.

Examples (JQL):
- Find Epics: issuetype = Epic
- Issues in Epic / parent: parent = PROJ-123
- By status: status = 'In Progress'
- By assignee: assignee = currentUser()
- Recently updated: updated >= -7d
- By label: labels = frontend
- Multiple labels: labels in (frontend, ui)
- By priority: priority = High
- By component (team): component = Backend   ("component" often maps to team)
- Multiple components: component in (Backend, API)
- Exact phrase in summary: summary ~ '"payment failure"'
- Free text content: text ~ "authentication timeout" ORDER BY updated DESC

Notes:
- Use labels or components when user asks "by label", or "by team" (map team -> component).
- Quote values with spaces or special characters.

Returns up to 20 issues: id=issue key, title=summary, url=citation URL. Use before fetch unless an exact key is already provided.`;

export const JIRA_DEFAULT_FETCH_DESCRIPTION =
	'Fetch a Jira issue by key (id) (for example RND-12345). Returns id, title, text (summary, description, status, top 5 comments) and url plus enriched metadata (source=jira, statusObject, commentsExcerpt, all other raw fields except those promoted). Use if you are asked to immediately find a task by its key (id) or search for detailed context or citation.';

export const CONFLUENCE_DEFAULT_SEARCH_DESCRIPTION = `
Search Confluence pages (limit 20). Query may be simple text (e.g. "project documentation") OR full CQL.

Simple text queries behave like: siteSearch ~ "<text>" (mimicking WebUI) with automatic fallback to text ~ "<text>" if siteSearch unsupported.

Examples (CQL):
- Basic: type=page AND space=DEV
- Personal space: space="~username"   (personal space keys starting with ~ must be quoted)
- Search by title: title~"Meeting Notes"
- Use siteSearch: siteSearch ~ "important concept"
- Use text search: text ~ "important concept"
- Recent content: created >= "2023-01-01"
- With label: label=documentation
- Multiple labels: label in ("howto","runbook")
- Recently modified: lastModified > startOfMonth("-1M")
- Modified this year: creator = currentUser() AND lastModified > startOfYear()
- You contributed recently: contributor = currentUser() AND lastModified > startOfWeek()
- Watched by user: watcher = "user@domain.com" AND type=page
- Exact phrase & label: text ~ '"Urgent Review Required"' AND label = "pending-approval"
- Title wildcard: title ~ "Minutes*" AND (space = "HR" OR space = "Marketing")

Note: Quote personal space keys (~username), reserved words, numeric IDs, and identifiers with special characters.

Returns up to 20 pages with id=page id, title=page title, url=citation URL for follow-up fetch. Use search before fetch for context narrowing.`;

export const CONFLUENCE_DEFAULT_FETCH_DESCRIPTION =
	'Fetch a Confluence page by id. Returns id, title, text (markdown if available) and url plus enriched metadata (source=confluence, pageMeta, original raw fields except those promoted). Use after search for detailed context or citation.';
