import { Request } from 'express';

export interface ResolvePrefixOptions {
	staticPrefix?: string;
}

export interface ResolvedPrefix {
	prefix: string;
	reason: string;
}

export function resolveDynamicPrefix(
	req: Request,
	{ staticPrefix }: ResolvePrefixOptions,
): ResolvedPrefix {
	const dynamicPrefix = (staticPrefix || '').replace(/\/+$/, '');
	if (dynamicPrefix) return { prefix: dynamicPrefix, reason: 'static' };
	const xfwd = (req.headers['x-forwarded-prefix'] || req.headers['x-forwarded-uri'] || '')
		.toString()
		.split(',')[0]
		.trim();
	if (xfwd) return { prefix: xfwd.replace(/\/+$/, ''), reason: 'x-forwarded' };
	const original = (req.originalUrl || '').split('?')[0];
	if (original && original !== '/')
		return { prefix: original.replace(/\/+$/, ''), reason: 'original' };
	return { prefix: '', reason: 'empty' };
}

export function normalizePrefix(p: string): string {
	if (!p) return '';
	return p.startsWith('/') ? p : `/${p}`;
}
