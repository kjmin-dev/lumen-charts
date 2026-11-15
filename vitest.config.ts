import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
	resolve: {
		// Tests run against sources, so no build step is needed first.
		alias: {
			'@lumen-charts/core': src('core'),
			'@lumen-charts/engine': src('engine'),
			'@lumen-charts/react': src('react'),
			'@lumen-charts/vue': src('vue'),
			'@lumen-charts/svelte': src('svelte'),
			'@lumen-charts/solid': src('solid'),
		},
	},
	test: {
		environment: 'happy-dom',
		include: ['packages/*/test/**/*.test.ts', 'benchmarks/test/**/*.test.ts'],
	},
});
