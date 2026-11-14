import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
	resolve: {
		// Use the core sources directly so edits show up without a build.
		alias: {
			'@lumen-charts/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
		},
	},
});
