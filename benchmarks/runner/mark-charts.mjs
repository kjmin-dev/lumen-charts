import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, firefox, webkit } from 'playwright';
import { build } from 'vite';
import { connectAndroid } from './android.ts';
import { formatJson } from '../src/json.ts';
import { servePreview } from './serve.ts';
const { values } = parseArgs({
	options: {
		out: { type: 'string' },
		'software-gl': { type: 'boolean', default: false },
		browser: { type: 'string', default: 'chromium' },
		mode: { type: 'string', default: 'webgl2,native,unavailable,rejected,pending,canvas-only' },
		dpr: { type: 'string', default: '1,1.5,2' },
		// A port of its own on 127.0.0.1 (one the system hands out by default).
		port: { type: 'string' },
		// Chrome on an Android device over USB (see runner/android.ts): the page runs at the device's
		// own ratio, once with the worker engine and once with the local one, instead of --dpr.
		android: { type: 'string' },
		'cdp-port': { type: 'string', default: '9222' },
		// The largest difference of a channel value a comparison accepts (default 0: byte for byte).
		tolerance: { type: 'string', default: '0' },
	},
});
/** Waits at most ten seconds: a page whose DevTools connection went silent never answers. */
const within = promise => Promise.race([promise.catch(() => undefined), new Promise(done => setTimeout(done, 10_000))]);
const tolerance = Number(values.tolerance);
if (!Number.isInteger(tolerance) || tolerance < 0) throw new Error('--tolerance expects a whole number of at least 0');
if (values.android && (values.browser !== 'chromium' || values['software-gl']))
	throw new Error('--android drives the device Chrome: --browser and --software-gl do not apply');
const configFile = new URL('../vite.config.ts', import.meta.url).pathname;
await build({ configFile, logLevel: 'warn' });
// On 127.0.0.1 at a port of its own, which `adb reverse` also reaches from a device.
const { server, port, url } = await servePreview(
	{ configFile, logLevel: 'warn' },
	values.port ? Number(values.port) : undefined,
);
let browser, android;
try {
	let base = url;
	/** One run per mode and entry: a ratio to emulate and the engine to use. */
	let variants;
	if (values.android) {
		android = await connectAndroid(values.android, port, Number(values['cdp-port']));
		browser = android.browser;
		base = `http://localhost:${port}/`;
		variants = [
			{ dpr: null, worker: true },
			{ dpr: null, worker: false },
		];
		const { device } = android;
		console.log(
			`${device.manufacturer} ${device.model} (${device.soc}), Android ${device.android}, Chrome ${device.chrome}`,
		);
	} else {
		const engine = { chromium, firefox, webkit }[values.browser];
		// The desktop runs use the local engine at 1.5 and the worker otherwise.
		variants = values.dpr
			.split(',')
			.map(Number)
			.map(dpr => ({ dpr, worker: dpr !== 1.5 }));
		browser = await engine.launch({
			headless: true,
			...(engine === chromium
				? {
						channel: 'chromium',
						args: values['software-gl'] ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [],
					}
				: {}),
		});
	}
	const runs = [];
	for (const mode of values.mode.split(','))
		for (const variant of variants)
			for (let attempt = 0; attempt < 2; attempt++) {
				let page, context;
				if (android && !android.mapped()) browser = await android.reconnect();
				if (android) page = await android.newPage();
				else if (values.browser === 'firefox') {
					// Playwright's ratio override does not survive the process switch into this cross-origin
					// isolated page in Firefox, which then draws at 1: a browser per ratio sets it by preference.
					context = await (
						await firefox.launch({
							headless: true,
							firefoxUserPrefs: { 'layout.css.devPixelsPerPx': String(variant.dpr) },
						})
					).newContext({ viewport: { width: 1000, height: 800 } });
					page = await context.newPage();
				} else page = await browser.newPage({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: variant.dpr });
				page.on('console', m => {
					if (m.type() === 'error' || m.type() === 'warning') console.error(m.text().slice(0, 850));
				});
				page.on('pageerror', e => console.error(e.message));
				const before = android?.state();
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
					await page.goto(base + 'mark-renderers.html');
					await page.waitForFunction(() => typeof window.checkMarkRenderers === 'function');
					const actual =
						mode === 'native'
							? await page.evaluate(async () => {
									const adapter = await navigator.gpu?.requestAdapter();
									return adapter && !adapter.info?.isFallbackAdapter ? 'hardware' : 'native-fallback';
								})
							: mode;
					const run = await page.evaluate(
						config => window.checkMarkRenderers(config.actual, config.worker, config.tolerance),
						{ actual, worker: variant.worker, tolerance },
					);
					// The ratio the page drew at, which an emulated one may not be.
					const dpr = await page.evaluate(() => window.devicePixelRatio);
					if (variant.dpr !== null && dpr !== variant.dpr)
						throw new Error(`The page drew at a device pixel ratio of ${dpr}, not ${variant.dpr}`);
					runs.push({ ...run, dpr, ...(android ? { device: { before, after: android.state() } } : {}) });
					console.log(
						android ? 'android' : values.browser,
						mode,
						dpr,
						variant.worker ? 'worker' : 'local',
						run.checks,
						'checks passed',
						...(run.inexact ? [`(${run.inexact} within ${tolerance} of a channel value, largest ${run.largest})`] : []),
					);
					break;
				} catch (error) {
					const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
					if (android && attempt === 0 && /has been closed/.test(message)) {
						// Another adb client restarted the adb server: run the mode again, reconnected.
						console.error('android', mode, 'connection to the device lost; running it again');
						continue;
					}
					// The other modes still run; the runner exits with an error at the end.
					const dpr = (await within(page.evaluate(() => window.devicePixelRatio))) ?? variant.dpr;
					runs.push({
						mode,
						worker: variant.worker,
						dpr,
						failed: message,
						...(android ? { device: { before, after: android.state() } } : {}),
					});
					console.error(
						android ? 'android' : values.browser,
						mode,
						dpr,
						variant.worker ? 'worker' : 'local',
						'FAILED',
						message,
					);
					break;
				} finally {
					await within(page.close());
					if (context) await context.browser()?.close();
				}
			}
	if (values.out)
		await writeFile(
			resolve(values.out),
			formatJson({
				browser: android ? 'android-chrome' : values.browser,
				version: browser.version(),
				...(android ? { device: android.device } : {}),
				runs,
			}),
		);
	if (runs.some(run => run.failed)) process.exitCode = 1;
} finally {
	if (android) await android.close();
	else await browser?.close();
	await server.close();
}
