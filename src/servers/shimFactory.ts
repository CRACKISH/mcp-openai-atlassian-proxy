import express from 'express';
import cors from 'cors';
export interface ShimOptions {
	port: number;
	upstreamUrl: string;
}
interface ProductShimConfig {
	productKey: string;
	serverName: string;
	upstreamSearchTool: string;
	upstreamFetchTool: string;
	defaultSearchDescription: string;
	defaultFetchDescription: string;
}

export async function startShimServer(opts: ShimOptions, cfg: ProductShimConfig): Promise<void> {
	const app = express();
	app.use(cors());

	app.get('/healthz', (_req, res) => {
		res.json({ ok: true, product: cfg.productKey, upstream: opts.upstreamUrl });
	});
}
