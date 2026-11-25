import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (name: string, entry = 'index.ts') =>
	fileURLToPath(new URL(`./packages/${name}/src/${entry}`, import.meta.url));

export default defineConfig({
	resolve: {
		// Tests run against sources, so no build step is needed first.
		alias: {
			'@lumen-ticks/core/worker': src('core', 'worker.ts'),
			'@lumen-ticks/core': src('core'),
			'@lumen-ticks/engine/worker': src('engine', 'worker.ts'),
			'@lumen-ticks/engine': src('engine'),
			'@lumen-ticks/react/worker': src('react', 'worker.ts'),
			'@lumen-ticks/react': src('react'),
			'@lumen-ticks/vue/worker': src('vue', 'worker.ts'),
			'@lumen-ticks/vue': src('vue'),
			'@lumen-ticks/svelte/worker': src('svelte', 'worker.ts'),
			'@lumen-ticks/svelte': src('svelte'),
			'@lumen-ticks/solid/worker': src('solid', 'worker.ts'),
			'@lumen-ticks/solid': src('solid'),
		},
	},
	test: {
		environment: 'happy-dom',
		include: ['packages/*/test/**/*.test.ts', 'benchmarks/test/**/*.test.ts'],
	},
});
