import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const src = (name: string, entry = 'index.ts') =>
	fileURLToPath(new URL(`../../packages/${name}/src/${entry}`, import.meta.url));

export default defineConfig({
	resolve: {
		// Use the package sources directly so edits show up without a build.
		alias: {
			'@lumen-ticks/core/worker': src('core', 'worker.ts'),
			'@lumen-ticks/core': src('core'),
			'@lumen-ticks/engine/worker': src('engine', 'worker.ts'),
			'@lumen-ticks/engine': src('engine'),
		},
	},
});
