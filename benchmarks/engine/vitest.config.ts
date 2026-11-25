import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (name: string) => fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));

/**
 * Measurements of engine operations outside a browser (`*.measure.ts`), run apart from the tests:
 * `npx vitest run --config benchmarks/engine/vitest.config.ts`. `LUMEN_MEASURE_OUT` names a JSON file
 * for the results.
 */
export default defineConfig({
	root: fileURLToPath(new URL('../..', import.meta.url)),
	resolve: { alias: { '@lumen-ticks/engine': src('engine') } },
	test: {
		environment: 'node',
		include: ['benchmarks/engine/**/*.measure.ts'],
		testTimeout: 600_000,
	},
});
