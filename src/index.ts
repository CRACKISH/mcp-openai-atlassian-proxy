#!/usr/bin/env node

/**
 * Entry point for MCP OpenAI Atlassian Proxy.
 * Initially just a placeholder; will implement Atlassian client + MCP server wiring.
 */

export function main() {
	// Temporary startup banner
	console.log('[mcp-openai-atlassian-proxy] starting (placeholder)');
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	main();
}
