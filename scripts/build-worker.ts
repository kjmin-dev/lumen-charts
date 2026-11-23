/// <reference types="node" />
// Bundles `packages/engine/src/worker.ts` into a single, zero-import ESM module at
// `packages/engine/dist/worker.js` with a valid source map referencing `../src/**`.
// That lets downstream apps load `./worker` through Vite `?worker`, Vite `?url`,
// `new URL('lumen-charts/worker', import.meta.url)`, or static hosting without extra bundler rules.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const engineDir = join(root, 'packages/engine');
const entry = join(engineDir, 'src/worker.ts');
const outDir = join(engineDir, 'dist');
const outFile = join(outDir, 'worker.js');
const mapFile = join(outDir, 'worker.js.map');

await build({
	configFile: false,
	logLevel: 'warn',
	root: engineDir,
	build: {
		outDir,
		emptyOutDir: false,
		sourcemap: true,
		target: 'es2022',
		lib: {
			entry,
			formats: ['es'],
			fileName: () => 'worker.js',
		},
		rolldownOptions: {
			output: {
				// Keep a single self-contained file with no code-split chunks.
				codeSplitting: false,
				comments: {
					annotation: true,
				},
			},
		},
	},
});

let code = readFileSync(outFile, 'utf8');

// Ensure bundler-ignore directives survive minification on the dynamic indicator plugin import.
if (!code.includes('@vite-ignore') || !code.includes('webpackIgnore')) {
	code = code.replace(/import\(([^)]+)\)/g, 'import(/* @vite-ignore */ /* webpackIgnore: true */ $1)');
	writeFileSync(outFile, code);
}

// Sanity checks: must be a standalone module with valid in-package source map paths.
if (/^\s*import\s+/m.test(code)) {
	throw new Error('packages/engine/dist/worker.js still contains static import statements');
}
const map = JSON.parse(readFileSync(mapFile, 'utf8')) as { sources?: string[] };
for (const source of map.sources ?? []) {
	if (!source.startsWith('../src/')) {
		throw new Error(`packages/engine/dist/worker.js.map references out-of-package source: ${source}`);
	}
}
