import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, firefox, webkit } from 'playwright';
import { build, preview } from 'vite';
const { values } = parseArgs({
	options: {
		out: { type: 'string' },
		'software-gl': { type: 'boolean', default: false },
		browser: { type: 'string', default: 'chromium' },
		mode: { type: 'string', default: 'webgl2,native,unavailable,rejected,pending,canvas-only' },
		dpr: { type: 'string', default: '1,1.5,2' },
		// A port of its own on 127.0.0.1, so another checkout's preview server cannot answer.
		port: { type: 'string' },
	},
});
const configFile = new URL('../vite.config.ts', import.meta.url).pathname;
await build({ configFile, logLevel: 'warn' });
const server = await preview({
	configFile,
	logLevel: 'warn',
	...(values.port ? { preview: { host: '127.0.0.1', port: Number(values.port), strictPort: true } } : {}),
});
let browser;
try {
	const engine = { chromium, firefox, webkit }[values.browser];
	browser = await engine.launch({
		headless: true,
		...(engine === chromium
			? {
					channel: 'chromium',
					args: values['software-gl'] ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [],
				}
			: {}),
	});
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
					window.testMarkContexts = [];
					window.testMarkGlAvailable = false;
					const get = HTMLCanvasElement.prototype.getContext;
					HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
						if (kind === 'webgl2' && fault === 'canvas-only') return null;
						const ctx = get.call(this, kind, ...args);
						if (kind === 'webgl2' && ctx) {
							window.testMarkGlAvailable = true;
							window.testMarkContexts.push(ctx);
						}
						return ctx;
					};
					if (fault === 'unavailable' || fault === 'canvas-only')
						Object.defineProperty(navigator, 'gpu', { value: undefined });
					else if (fault === 'pending')
						Object.defineProperty(navigator, 'gpu', {
							value: {
								requestAdapter: () =>
									new Promise(finish => {
										window.finishMarkAdapter = () => finish(null);
									}),
							},
						});
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
