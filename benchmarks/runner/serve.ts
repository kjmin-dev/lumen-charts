/// <reference types="node" />
// The preview server of a run: the production build of the harness pages, on a port of its own.

import { createServer } from 'node:net';
import { type InlineConfig, type PreviewServer, preview } from 'vite';

/** A TCP port on the IPv4 loopback that is free now, as the system hands one out. */
export function freePort(): Promise<number> {
	return new Promise((resolvePort, rejectPort) => {
		const probe = createServer();
		probe.once('error', rejectPort);
		probe.listen(0, '127.0.0.1', () => {
			const address = probe.address();
			probe.close(() =>
				typeof address === 'object' && address !== null
					? resolvePort(address.port)
					: rejectPort(new Error('No port from the system')),
			);
		});
	});
}

export interface Served {
	server: PreviewServer;
	port: number;
	/** `http://127.0.0.1:<port>/`. */
	url: string;
}

/**
 * Serves a build with `vite preview` on 127.0.0.1 at a port the system hands out, and fails rather
 * than move to another port. Several checkouts of the repository can serve at once: Vite's default
 * port 4173 can then be taken on one address family and free on the other, and a browser that
 * opens `localhost` reaches another checkout's build. A port of its own on the IPv4 loopback
 * belongs to this run, and `adb reverse` reaches it from a device as its localhost.
 */
export async function servePreview(options: InlineConfig): Promise<Served> {
	const port = await freePort();
	const server = await preview({
		...options,
		preview: { ...options.preview, host: '127.0.0.1', port, strictPort: true },
	});
	return { server, port, url: `http://127.0.0.1:${port}/` };
}
