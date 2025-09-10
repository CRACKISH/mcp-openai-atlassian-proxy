interface LogRecordBase {
	t: string;
	lvl: string;
	evt: string;
	msg: string;
	shim?: string;
	sessionId?: string;
	port?: number;
	url?: string;
	upstreamUrl?: string;
	attempt?: number;
	delayMs?: number;
	reason?: string;
	transport?: string;
	durationMs?: number;
	ip?: string;
	prefix?: string;
	prefixReason?: string;
	version?: string;
}

function plain(r: LogRecordBase) {
	const parts: string[] = [r.t, r.lvl.toUpperCase(), r.evt];
	if (r.shim) parts.splice(2, 0, '[' + r.shim + ']');
	parts.push(r.msg);
	return parts.join(' ');
}

export function log(entry: Omit<LogRecordBase, 't' | 'lvl'> & { lvl?: string }) {
	const rec: LogRecordBase = {
		lvl: (entry.lvl || 'info').toLowerCase(),
		t: new Date().toISOString(),
		...entry,
	} as LogRecordBase;
	if (process.env.LOG_PRETTY) console.log(plain(rec));
	else console.log(JSON.stringify(rec));
}

export type Logger = typeof log;
