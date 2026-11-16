import { resolve } from 'node:path';
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

/**
 * The `packages` directory whose sources are measured: this workspace's, or another checkout's
 * (`pnpm bench --packages <dir>` sets the variable), to measure two versions of the library with
 * the same harness.
 */
const packages = process.env['LUMEN_BENCH_PACKAGES'] ?? fileURLToPath(new URL('../packages', import.meta.url));
const source = (name: string): string => resolve(packages, name, 'src/index.ts');

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
	root,
	resolve: {
		// Measure the workspace sources as they are, without building the packages first.
		alias: {
			'@lumen-charts/core': source('core'),
			'@lumen-charts/engine': source('engine'),
		},
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
		// The harness page, and the page of the pixel check (`pnpm bench:pixels`).
		rollupOptions: { input: [resolve(root, 'index.html'), resolve(root, 'pixels.html')] },
		// A profiled run (`pnpm bench --profile`) keeps function names, so CPU samples can be read.
		...(process.env['LUMEN_BENCH_PROFILE'] === undefined ? {} : { minify: false }),
	},
});
