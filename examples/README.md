# Examples

This folder contains a sample deployment stack (Docker + nginx) showing how to run:

- Upstream MCP Atlassian server (jira + confluence tools)
- Two shim servers (prefix-aware) under `/jira` and `/confluence`
- nginx reverse proxy that preserves path prefixes so dynamic prefix detection works
- Optional certbot container for TLS (Let\'s Encrypt)

## Files

- `docker-compose.yml` – sample stack (uses environment variables for secrets)
- `nginx.conf` – anonymized example nginx configuration with prefix preservation (use as a template)

## Dynamic Prefix Notes

The shim tries to determine the public prefix in this order:

1. Static `publicPrefix` passed by the shim start function (in code: `/jira`, `/confluence`).
2. `X-Forwarded-Prefix` header (first value, comma-split) if present.
3. `X-Forwarded-Uri` header (first value) – trimmed.
4. Derivation from `originalUrl` when it ends with `/sse` (it removes the tail and uses the preceding part as prefix).
5. Falls back to empty string.

To let the dynamic inference work when you do NOT rely on the static hard‑coded prefix, you must ensure that either:

- The upstream (Node) receives the full original path (e.g. `/jira/sse`), OR
- You send `X-Forwarded-Prefix: /jira` (and similarly for `/confluence`).

The provided `nginx.conf` does both: it keeps the original path and also sets forwarding headers.

## Secrets

Create a `.env` file next to `docker-compose.yml`:

```
JIRA_API_TOKEN=your_jira_api_token_here
CONFLUENCE_API_TOKEN=your_confluence_api_token_here
```

Never commit real tokens.

## Running

```
# pull latest images
 docker compose pull

# launch
 docker compose up -d

# view logs for shim
 docker compose logs -f mcp-shim
```

## Verifying Prefix Detection

1. Open logs for the shim container and look for `session_open` events.
2. You should see `prefix: "/jira"` (or `/confluence`) and `prefixReason` either `static` or `x-forwarded`.
3. If you purposely remove the hard-coded static setting in code, headers + path should still allow `prefixReason` = `x-forwarded` or `derived`.

## Adjusting Domain

Replace `example.com` in `nginx.conf` and certbot command with your real domain before deploying.

## TLS

The sample uses a certbot webroot challenge. Ensure the volume paths exist:

```
mkdir -p certbot/www certbot/conf
```

## Hardening Ideas (Not Included)

- Restrict IPs for `/upstream/` if not needed publicly.
- Add rate limiting (nginx `limit_req_zone`).
- Separate network for internal containers.

## Disclaimer

These examples are for reference and should be reviewed & hardened before production use.
