#!/usr/bin/env node
import 'dotenv/config';
import { startJiraShim, startConfluenceShim } from './servers/index.js';

interface LaunchConfig {
	upstreamUrl: string;
	jiraPort: number;
	confluencePort: number;
}

function readConfig(): LaunchConfig {
	let upstreamUrl = process.env.UPSTREAM_MCP_URL || '';
	if (!upstreamUrl) {
		console.error('UPSTREAM_MCP_URL env var required (e.g. https://host:7000/sse)');
		process.exit(1);
	}
	if (!/\/sse\/?$/.test(upstreamUrl)) upstreamUrl = upstreamUrl.replace(/\/+$/, '') + '/sse';
	return {
		upstreamUrl,
		jiraPort: Number(process.env.JIRA_SHIM_PORT || 7100),
		confluencePort: Number(process.env.CONFLUENCE_SHIM_PORT || 7200),
	};
}

export async function main() {
	const cfg = readConfig();
	console.log('[proxy] upstream:', cfg.upstreamUrl);
	await Promise.all([
		startJiraShim({ port: cfg.jiraPort, upstreamUrl: cfg.upstreamUrl }),
		startConfluenceShim({ port: cfg.confluencePort, upstreamUrl: cfg.upstreamUrl }),
	]);
	console.log('[proxy] jira=:' + cfg.jiraPort + ' confluence=:' + cfg.confluencePort);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	main().catch(e => {
		console.error('[proxy] fatal startup error:', e);
		process.exit(1);
	});
}
