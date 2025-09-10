#!/usr/bin/env bash
# Simple curl tests to verify prefix + SSE handshake
set -euo pipefail
BASE=${BASE:-https://your-domain.example}

echo "Testing Jira SSE (should stream)...".
curl -v -H 'Accept: text/event-stream' "$BASE/jira/sse" --max-time 5 || true

echo "Posting message (dummy session)".
curl -v -X POST "$BASE/jira/messages?sessionId=NON_EXISTENT" -d '{"jsonrpc":"2.0","id":"1","method":"ping"}' \
  -H 'Content-Type: application/json' || true

echo "Check logs in container for session_open with prefixReason"
