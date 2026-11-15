import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const src = (name: string) => fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
	resolve: {
		// Use the package sources directly so edits show up without a build.
		alias: {
			'@lumen-charts/core': src('core'),
			'@lumen-charts/engine': src('engine'),
		},
	},
});
