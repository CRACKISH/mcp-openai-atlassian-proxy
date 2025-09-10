import { log } from '../log.js';
import { ProductShimConfig, ShimOptions } from '../types/shim.js';
import { createHttpServer } from './httpServer.js';

export async function startShimServer(opts: ShimOptions, cfg: ProductShimConfig) {
	await new Promise(r => setTimeout(r, 1000));
	const initTs = Date.now();
	log({
		evt: 'shim_init',
		msg: 'init',
		shim: cfg.productKey,
		port: opts.port,
		upstreamUrl: opts.upstreamUrl,
	});
	const staticPrefix = (opts.publicPrefix ?? '').replace(/\/+$/, '');
	const { server, sessions, closeUpstream } = createHttpServer({
		opts,
		cfg,
		upstreamUrl: opts.upstreamUrl,
		staticPrefix,
		initTs,
	});

	const shutdown = () => {
		const shutdownLog = {
			evt: 'shim_shutdown',
			msg: 'shutdown',
			shim: cfg.productKey,
		} as const;
		log(shutdownLog);
		server.close(() => process.exit(0));
		void closeUpstream();
		for (const [sid, t] of Object.entries(sessions) as [string, { close?: () => void }][]) {
			try {
				t.close?.();
				delete sessions[sid];
			} catch {
				void 0;
			}
		}
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
	return server;
}
