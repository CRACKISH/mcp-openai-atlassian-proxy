import { Request, Response } from 'express';

export function getClientIp(req: Request): string {
	return (req.headers['x-forwarded-for'] || req.ip || req.socket.remoteAddress || '')
		.toString()
		.split(',')[0]
		.trim();
}

export interface KeepAliveHandle {
	stop: () => void;
}

export function startKeepAlive(res: Response, intervalMs: number): KeepAliveHandle {
	const timer = setInterval(() => {
		try {
			if (res.writableEnded || res.destroyed) {
				clearInterval(timer);
				return;
			}
			res.write(`:ka ${Date.now()}\n\n`);
		} catch {
			clearInterval(timer);
		}
	}, intervalMs).unref?.() as unknown as NodeJS.Timeout;
	return {
		stop: () => {
			try {
				clearInterval(timer as unknown as NodeJS.Timeout);
			} catch {
				void 0;
			}
		},
	};
}
