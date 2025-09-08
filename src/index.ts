#!/usr/bin/env node
import 'dotenv/config';
import { startJiraShim, startConfluenceShim } from './servers/index.js';
import { UpstreamClient } from './remote/index.js';

export interface LaunchConfig {
	upstreamUrl: string; // full /sse endpoint of original Atlassian MCP
	jiraPort: number;
	confluencePort: number;
}

function readConfig(): LaunchConfig {
	let upstreamUrl = process.env.UPSTREAM_MCP_URL || '';
	if (!upstreamUrl) {
		console.error('UPSTREAM_MCP_URL env var required (e.g. https://host:7000/sse)');
		process.exit(1);
	}
	// Accept either full /sse endpoint or base origin; normalize to .../sse
	if (!/\/sse\/?$/.test(upstreamUrl)) {
		upstreamUrl = upstreamUrl.replace(/\/+$/, '') + '/sse';
	}
	return {
		upstreamUrl,
		jiraPort: Number(process.env.JIRA_SHIM_PORT || 7100),
		confluencePort: Number(process.env.CONFLUENCE_SHIM_PORT || 7200)
	};
}

export async function main() {
	const cfg = readConfig();
	console.log('[proxy] starting dual shims');
	console.log('[proxy] upstream:', cfg.upstreamUrl);
	// Shared upstream client to avoid duplicate connections & logs
	const sharedUpstream = new UpstreamClient({ remoteUrl: cfg.upstreamUrl, logger: (l,...r)=>console.log('[upstream-shared]', l, ...r) });
	await sharedUpstream.connectIfNeeded();
	await Promise.all([
		startJiraShim({ port: cfg.jiraPort, upstreamUrl: cfg.upstreamUrl, upstreamClient: sharedUpstream }),
		startConfluenceShim({ port: cfg.confluencePort, upstreamUrl: cfg.upstreamUrl, upstreamClient: sharedUpstream })
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
