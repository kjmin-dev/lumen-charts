// Runs scan.ts (chunked store against contiguous columns) in Node and in headless Chromium, WebKit
// and Firefox, one engine after the other, and writes the medians as JSON.
// Usage: node benchmarks/prototypes/review-remeasure/scan-cost.mjs [--engines node,chromium,webkit,firefox] [--out file]

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import vm from 'node:vm';
import { chromium, firefox, webkit } from 'playwright';
import { build } from 'vite';
import { formatJson } from '../../src/json.ts';

const { values } = parseArgs({
	options: {
		engines: { type: 'string', default: 'node,chromium,webkit,firefox' },
		rows: { type: 'string', default: '1000000' },
		out: { type: 'string' },
	},
});
const rows = Number(values.rows);
const outDir = await mkdtemp(join(os.tmpdir(), 'lumen-scan-cost-'));
try {
	await build({
		configFile: false,
		logLevel: 'warn',
		build: {
			outDir,
			emptyOutDir: true,
			target: 'es2022',
			lib: { entry: fileURLToPath(new URL('./scan.ts', import.meta.url)), name: 'scanCost', formats: ['iife'] },
			rollupOptions: { output: { entryFileNames: 'scan.js' } },
		},
	});
	const code = await readFile(join(outDir, 'scan.js'), 'utf8');
	const runs = [];
	for (const engine of values.engines.split(',')) {
		const load = os.loadavg();
		let results, version;
		if (engine === 'node') {
			vm.runInThisContext(code);
			results = globalThis.scanCost.run(rows);
			version = `node ${process.version}, V8 ${process.versions.v8}`;
		} else {
			const type = { chromium, webkit, firefox }[engine];
			const browser = await type.launch({ headless: true, ...(engine === 'chromium' ? { channel: 'chromium' } : {}) });
			try {
				const page = await browser.newPage();
				await page.addScriptTag({ content: code });
				results = await page.evaluate(n => window.scanCost.run(n), rows);
				version = `${engine} ${browser.version()}`;
			} finally {
				await browser.close();
			}
		}
		runs.push({ engine, version, loadAverageStart: load, loadAverageEnd: os.loadavg(), results });
		for (const r of results)
			console.log(
				engine.padEnd(9),
				r.scan.padEnd(44),
				`chunked ${r.chunkedNsPerRow.toFixed(3)} ns/row, contiguous ${r.contiguousNsPerRow.toFixed(3)} ns/row,`,
				`ratio ${r.ratio.toFixed(2)}, ${r.chunkedUs.toFixed(1)} vs ${r.contiguousUs.toFixed(1)} µs per scan`,
			);
	}
	const file = {
		createdAt: new Date().toISOString(),
		machine: { platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, cores: os.cpus().length },
		rows,
		runs,
	};
	if (values.out) await writeFile(values.out, formatJson(file));
} finally {
	await rm(outDir, { recursive: true, force: true });
}
