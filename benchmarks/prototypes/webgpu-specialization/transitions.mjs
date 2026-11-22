import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { build, preview } from 'vite';

const { values } = parseArgs({
	options: { packages: { type: 'string' }, out: { type: 'string' }, sizes: { type: 'string', default: '1,3,9' } },
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
		host: '127.0.0.1',
		port: 0,
		headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
	},
};

let browser, server;
try {
	await build(config);
	await writeFile(join(outDir, 'index.html'), '<!doctype html><body style="margin:0"></body>');
	server = await preview(config);
	browser = await chromium.launch({ headless: true, channel: 'chromium' });
	const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
	await page.goto(server.resolvedUrls.local[0]);
	const result = {
		chromium: browser.version(),
		...(await page.evaluate(async widths => (await import('/study.js')).study(widths), sizes)),
	};
	if (values.out) await writeFile(values.out, JSON.stringify(result, null, '\t') + '\n');
	for (const [key, samples] of Object.entries(result.probes)) {
		const sorted = samples.map(s => s.jsMs).toSorted((a, b) => a - b);
		console.log(key, 'JS p95', sorted[Math.ceil(sorted.length * 0.95) - 1], 'upload bytes', samples.at(-1).bytes);
	}
	console.log(result.checks.length, 'whole-chart comparisons passed');
} finally {
	await browser?.close();
	await server?.close();
	await rm(outDir, { recursive: true, force: true });
}
