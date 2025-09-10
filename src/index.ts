#!/usr/bin/env node
import 'dotenv/config';
import { log } from './log.js';
import { startConfluenceShim, startJiraShim } from './servers/index.js';

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
	const startTs = Date.now();
	log({ evt: 'proxy_start', msg: 'starting proxy', upstreamUrl: cfg.upstreamUrl });
	await Promise.all([
		startJiraShim({ port: cfg.jiraPort, upstreamUrl: cfg.upstreamUrl }),
		startConfluenceShim({ port: cfg.confluencePort, upstreamUrl: cfg.upstreamUrl }),
	]);
	log({
		evt: 'proxy_ready',
		msg: 'shims started',
		upstreamUrl: cfg.upstreamUrl,
		durationMs: Date.now() - startTs,
	});
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	main().catch(e => {
		log({
			evt: 'proxy_fatal',
			msg: 'fatal startup error',
			lvl: 'error',
			reason: e instanceof Error ? e.message : String(e),
		});
		process.exit(1);
	});
}
