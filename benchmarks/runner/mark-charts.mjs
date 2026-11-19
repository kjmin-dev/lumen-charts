import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, firefox, webkit } from 'playwright';
import { build, preview } from 'vite';
const { values } = parseArgs({
	options: {
		out: { type: 'string' },
		browser: { type: 'string', default: 'chromium' },
		mode: { type: 'string', default: 'native,unavailable,rejected' },
		dpr: { type: 'string', default: '1,1.5,2' },
	},
});
const configFile = new URL('../vite.config.ts', import.meta.url).pathname;
await build({ configFile, logLevel: 'warn' });
const server = await preview({ configFile, logLevel: 'warn' });
let browser;
try {
	const engine = { chromium, firefox, webkit }[values.browser];
	browser = await engine.launch({ headless: true, ...(engine === chromium ? { channel: 'chromium' } : {}) });
	const runs = [];
	for (const mode of values.mode.split(','))
		for (const dpr of values.dpr.split(',').map(Number)) {
			const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: dpr });
			page.on('console', m => {
				if (m.type() === 'error' || m.type() === 'warning') console.error(m.text().slice(0, 850));
			});
			page.on('pageerror', e => console.error(e.message));
			try {
				await page.addInitScript(fault => {
					window.testMarkDevices = [];
					if (fault === 'unavailable') Object.defineProperty(navigator, 'gpu', { value: undefined });
					else if (fault === 'rejected')
						Object.defineProperty(navigator, 'gpu', {
							value: { requestAdapter: () => Promise.reject(new Error('test')) },
						});
					else if (typeof GPUAdapter !== 'undefined') {
						const original = GPUAdapter.prototype.requestDevice;
						GPUAdapter.prototype.requestDevice = async function (...args) {
							const dev = await original.apply(this, args);
							window.testMarkDevices.push(dev);
							return dev;
						};
					}
				}, mode);
				await page.goto(server.resolvedUrls.local[0] + 'mark-renderers.html');
				await page.waitForFunction(() => typeof window.checkMarkRenderers === 'function');
				const actual =
					mode === 'native'
						? await page.evaluate(async () => {
								const adapter = await navigator.gpu?.requestAdapter();
								return adapter && !adapter.info?.isFallbackAdapter ? 'hardware' : 'native-fallback';
							})
						: mode;
				const run = await page.evaluate(config => window.checkMarkRenderers(config.actual, config.worker), {
					actual,
					worker: dpr !== 1.5,
				});
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
