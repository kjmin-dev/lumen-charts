import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (name: string, entry = 'index.ts') =>
	fileURLToPath(new URL(`./packages/${name}/src/${entry}`, import.meta.url));

export default defineConfig({
	resolve: {
		// Tests run against sources, so no build step is needed first.
		alias: {
			'@lumen-charts/core/worker': src('core', 'worker.ts'),
			'@lumen-charts/core': src('core'),
			'@lumen-charts/engine/worker': src('engine', 'worker.ts'),
			'@lumen-charts/engine': src('engine'),
			'@lumen-charts/react/worker': src('react', 'worker.ts'),
			'@lumen-charts/react': src('react'),
			'@lumen-charts/vue/worker': src('vue', 'worker.ts'),
			'@lumen-charts/vue': src('vue'),
			'@lumen-charts/svelte/worker': src('svelte', 'worker.ts'),
			'@lumen-charts/svelte': src('svelte'),
			'@lumen-charts/solid/worker': src('solid', 'worker.ts'),
			'@lumen-charts/solid': src('solid'),
			'lumen-charts/worker': src('lumen-charts', 'worker.ts'),
			'lumen-charts': src('lumen-charts'),
		},
	},
	test: {
		environment: 'happy-dom',
		include: ['packages/*/test/**/*.test.ts', 'benchmarks/test/**/*.test.ts'],
	},
});
