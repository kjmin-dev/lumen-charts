import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { build } from 'vite';
import { connectAndroid } from '../../runner/android.ts';
import { servePreview } from '../../runner/serve.ts';
import { formatJson } from '../../src/json.ts';

const { values } = parseArgs({
	options: {
		packages: { type: 'string' },
		out: { type: 'string' },
		sizes: { type: 'string', default: '1,3,9' },
		// Chrome on an Android device over USB (see runner/android.ts), at the device's own ratio.
		android: { type: 'string' },
	},
});
const sizes = values.sizes.split(',').map(Number);
if (!sizes.length || !sizes.every(size => Number.isInteger(size) && size >= 1 && size <= 9))
	throw new Error('Expected marker sizes from 1 to 9 device pixels');
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const packages = resolve(values.packages ?? join(repo, 'packages'));
const outDir = await mkdtemp(join(tmpdir(), 'lumen-mark-transitions-'));
const config = {
	configFile: false,
	logLevel: 'warn',
	root: repo,
	resolve: {
		alias: {
			'@lumen-charts/core': join(packages, 'core/src/index.ts'),
			'@lumen-charts/engine': join(packages, 'engine/src/index.ts'),
		},
	},
	build: {
		outDir,
		emptyOutDir: true,
		target: 'es2022',
		rollupOptions: {
			input: { study: fileURLToPath(new URL('./page.js', import.meta.url)) },
			preserveEntrySignatures: 'strict',
			output: { entryFileNames: '[name].js' },
		},
	},
	preview: {
		headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
	},
};

let browser, server, android;
try {
	await build(config);
	await writeFile(join(outDir, 'index.html'), '<!doctype html><body style="margin:0"></body>');
	const served = await servePreview(config);
	server = served.server;
	let page,
		base = served.url;
	if (values.android) {
		const port = served.port;
		android = await connectAndroid(values.android, port);
		browser = android.browser;
		page = await android.newPage();
		base = `http://localhost:${port}/`;
	} else {
		browser = await chromium.launch({ headless: true, channel: 'chromium' });
		page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
	}
	await page.goto(base);
	const before = android?.state();
	const result = {
		chromium: browser.version(),
		...(android ? { device: android.device } : {}),
		dpr: await page.evaluate(() => window.devicePixelRatio),
		...(await page.evaluate(async widths => (await import('/study.js')).study(widths), sizes)),
		...(android ? { deviceState: { before, after: android.state() } } : {}),
	};
	if (values.out) await writeFile(values.out, formatJson(result));
	for (const [key, samples] of Object.entries(result.probes)) {
		const sorted = samples.map(s => s.jsMs).toSorted((a, b) => a - b);
		console.log(key, 'JS p95', sorted[Math.ceil(sorted.length * 0.95) - 1], 'upload bytes', samples.at(-1).bytes);
	}
	console.log(result.checks.length, 'whole-chart comparisons passed');
} finally {
	if (android) await android.close();
	else await browser?.close();
	await server?.close();
	await rm(outDir, { recursive: true, force: true });
}
