import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

declare module 'express-serve-static-core' {
  interface Request {
    oauthAccessToken?: string;
  }
}

export interface OAuth2Config {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scope: string;
  authorizeUrl: string;
  tokenUrl: string;
  audience?: string;
}

interface TokenRecord {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // epoch ms
  scope?: string;
}

const stateStore = new Map<string, number>(); // state -> ts
const sessionTokens = new Map<string, TokenRecord>(); // sid -> token record

export function loadOAuth2Config(): OAuth2Config {
  const enabled = process.env.OAUTH2_ENABLED === '1' || !!process.env.OAUTH2_CLIENT_ID;
  return {
    enabled,
    clientId: process.env.OAUTH2_CLIENT_ID || '',
    clientSecret: process.env.OAUTH2_CLIENT_SECRET || '',
    redirectUri: process.env.OAUTH2_REDIRECT_URI || 'http://localhost:7100/oauth/callback',
    scope: process.env.OAUTH2_SCOPE || 'read:jira-work read:confluence-space.summary',
    authorizeUrl: process.env.OAUTH2_AUTHORIZE_URL || 'https://auth.atlassian.com/authorize',
    tokenUrl: process.env.OAUTH2_TOKEN_URL || 'https://auth.atlassian.com/oauth/token',
    audience: process.env.OAUTH2_AUDIENCE || 'api.atlassian.com',
  };
}

export function oauthLoginHandler(cfg: OAuth2Config) {
  return (req: Request, res: Response) => {
    const state = crypto.randomUUID();
    stateStore.set(state, Date.now());
    const params = new URLSearchParams({
      audience: cfg.audience || '',
      client_id: cfg.clientId,
      scope: cfg.scope,
      redirect_uri: cfg.redirectUri,
      state,
      response_type: 'code',
      prompt: 'consent',
    });
    res.redirect(`${cfg.authorizeUrl}?${params.toString()}`);
  };
}

export async function exchangeCodeForToken(cfg: OAuth2Config, code: string) {
  const body = {
    grant_type: 'authorization_code',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code,
    redirect_uri: cfg.redirectUri,
  } as Record<string, string>;
  const resp = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`token_exchange_failed ${resp.status}`);
  return (await resp.json()) as {
    access_token: string; expires_in: number; refresh_token?: string; scope?: string;
  };
}

export async function refreshToken(cfg: OAuth2Config, refreshToken: string) {
  const body = {
    grant_type: 'refresh_token',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: refreshToken,
  } as Record<string, string>;
  const resp = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`refresh_failed ${resp.status}`);
  return (await resp.json()) as { access_token: string; expires_in: number; refresh_token?: string; scope?: string; };
}

export function oauthCallbackHandler(cfg: OAuth2Config) {
  return async (req: Request, res: Response) => {
    try {
      const { state, code, error } = req.query as Record<string, string>;
      if (error) return res.status(400).send(error);
      if (!code || !state || !stateStore.has(state)) return res.status(400).send('invalid_state');
      stateStore.delete(state);
      const token = await exchangeCodeForToken(cfg, code);
      const sid = crypto.randomUUID();
      sessionTokens.set(sid, {
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: Date.now() + (token.expires_in - 30) * 1000,
        scope: token.scope,
      });
      res.cookie('sid', sid, { httpOnly: true, sameSite: 'lax' });
      res.status(200).send('OAuth2 login OK. You can close this tab.');
  } catch {
      res.status(500).send('oauth_callback_error');
    }
  };
}

export function oauthGuard(cfg: OAuth2Config) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!cfg.enabled) return next();
    // Allow public endpoints
    if (/^\/oauth\//.test(req.path) || req.path === '/healthz') return next();
    const sid = (req.cookies?.sid || '') as string;
    const rec = sid ? sessionTokens.get(sid) : undefined;
    if (!rec) return res.status(401).send('auth_required');
    // Refresh if expiring
    if (rec.expiresAt < Date.now()) {
      if (rec.refreshToken) {
        try {
          const t = await refreshToken(cfg, rec.refreshToken);
            rec.accessToken = t.access_token;
            rec.refreshToken = t.refresh_token || rec.refreshToken;
            rec.expiresAt = Date.now() + (t.expires_in - 30) * 1000;
            rec.scope = t.scope || rec.scope;
        } catch {
          sessionTokens.delete(sid);
          return res.status(401).send('auth_expired');
        }
      } else {
        sessionTokens.delete(sid);
        return res.status(401).send('auth_expired');
      }
    }
    // Attach bearer for downstream use if needed later
    req.oauthAccessToken = rec.accessToken;
    return next();
  };
}

export function getAccessTokenForRequest(req: Request): string | undefined {
  return req.oauthAccessToken;
}
