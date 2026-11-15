import { fileURLToPath } from 'node:url';
import { defaultClientConditions, defineConfig } from 'vite';

/**
 * Cross-origin isolation raises the resolution of `performance.now()` in Chromium from 100 µs to
 * 5 µs and enables `performance.measureUserAgentSpecificMemory`.
 */
export const isolationHeaders = {
	'Cross-Origin-Opener-Policy': 'same-origin',
	'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
	root: fileURLToPath(new URL('.', import.meta.url)),
	resolve: {
		// Always resolve the "production" export condition, also on the dev server, so libraries
		// that ship a development build with extra checks (Lightweight Charts does) are measured
		// in their production form.
		conditions: defaultClientConditions.map(c => (c === 'development|production' ? 'production' : c)),
	},
	server: { headers: isolationHeaders },
	preview: { headers: isolationHeaders },
	build: {
		target: 'es2022',
		sourcemap: true,
	},
});
