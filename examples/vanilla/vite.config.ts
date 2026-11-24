import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const src = (name: string, entry = 'index.ts') =>
	fileURLToPath(new URL(`../../packages/${name}/src/${entry}`, import.meta.url));

export default defineConfig({
	resolve: {
		// Use the package sources directly so edits show up without a build.
		alias: {
			'@lumen-charts/core/worker': src('core', 'worker.ts'),
			'@lumen-charts/core': src('core'),
			'@lumen-charts/engine/worker': src('engine', 'worker.ts'),
			'@lumen-charts/engine': src('engine'),
			'lumen-charts/worker': src('lumen-charts', 'worker.ts'),
			'lumen-charts': src('lumen-charts'),
		},
	},
});
