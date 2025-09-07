#!/usr/bin/env node
import 'dotenv/config';
import { startJiraShim } from './servers/jiraServer.js';
import { startConfluenceShim } from './servers/confluenceServer.js';

export interface LaunchConfig {
	upstreamUrl: string; // full /sse endpoint of original Atlassian MCP
	jiraPort: number;
	confluencePort: number;
}

function readConfig(): LaunchConfig {
	const upstreamUrl = process.env.UPSTREAM_MCP_URL || '';
	if (!upstreamUrl) {
		console.error('UPSTREAM_MCP_URL env var required (e.g. https://host:7000/sse)');
		process.exit(1);
	}
	return {
		upstreamUrl,
		jiraPort: Number(process.env.JIRA_SHIM_PORT || 7101),
		confluencePort: Number(process.env.CONFLUENCE_SHIM_PORT || 7102)
	};
}

export async function main() {
	const cfg = readConfig();
	console.log('[proxy] starting dual shims');
	console.log('[proxy] upstream:', cfg.upstreamUrl);
	await Promise.all([
		startJiraShim({ port: cfg.jiraPort, upstreamUrl: cfg.upstreamUrl }),
		startConfluenceShim({ port: cfg.confluencePort, upstreamUrl: cfg.upstreamUrl })
	]);
	console.log('[proxy] both shims launched');
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	// Fire and forget; each shim keeps its own express server running
	main().catch(e => {
		console.error('[proxy] fatal startup error:', e);
		process.exit(1);
	});
}
