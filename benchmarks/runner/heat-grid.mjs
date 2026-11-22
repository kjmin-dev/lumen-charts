// Run from any directory: node benchmarks/runner/heat-grid.mjs [--browser firefox] [--out <results.json>] [--dpr 1,2]
// Compares heatmaps whose grid follows the price, drawn by WebGL2 and WebGPU, with Canvas 2D,
// byte for byte, in a headless browser (benchmarks/src/marks/heat-grid.ts). A mode the browser
// cannot draw with (no WebGPU adapter) is reported and skipped.
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, firefox, webkit } from 'playwright';
import { build, preview } from 'vite';
const { values } = parseArgs({
	options: {
		out: { type: 'string' },
		browser: { type: 'string', default: 'chromium' },
		mode: { type: 'string', default: 'webgl2,webgpu' },
		dpr: { type: 'string', default: '1,1.5,2' },
	},
});
const configFile = new URL('../vite.config.ts', import.meta.url).pathname;
await build({ configFile, logLevel: 'warn' });
// A port of its own on IPv4: another harness's preview server may hold the default one.
const server = await preview({
	configFile,
	logLevel: 'warn',
	preview: { host: '127.0.0.1', port: 4391, strictPort: false },
});
let browser;
try {
	const engine = { chromium, firefox, webkit }[values.browser];
	browser = await engine.launch({ headless: true, ...(engine === chromium ? { channel: 'chromium' } : {}) });
	const runs = [];
	for (const mode of values.mode.split(','))
		for (const dpr of values.dpr.split(',').map(Number)) {
			const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: dpr });
			page.on('pageerror', error => console.error(error.message));
			try {
				await page.goto(server.resolvedUrls.local[0] + 'heat-grid.html');
				await page.waitForFunction(() => typeof window.checkHeatGrid === 'function');
				if (mode === 'webgpu' && !(await page.evaluate(async () => !!(await navigator.gpu?.requestAdapter())))) {
					console.log(values.browser, mode, dpr, 'skipped: no WebGPU adapter');
					continue;
				}
				const run = await page.evaluate(m => window.checkHeatGrid(m), mode);
				runs.push({ ...run, dpr });
				console.log(values.browser, mode, dpr, run.checks, 'checks passed');
			} finally {
				await page.close();
			}
		}
	if (values.out)
		await writeFile(
			resolve(values.out),
			JSON.stringify({ browser: values.browser, version: browser.version(), runs }, null, '\t') + '\n',
		);
} finally {
	await browser?.close();
	await server.close();
}
