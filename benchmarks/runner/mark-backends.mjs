// Run from any directory: node benchmarks/runner/mark-backends.mjs --out <results.json>
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { formatJson } from '../src/json.ts';
import { summarize } from '../src/stats.ts';
import { selectStudy } from '../prototypes/mark-backends/studies.js';

const { values } = parseArgs({
	options: {
		out: { type: 'string' },
		repeats: { type: 'string', default: '3' },
		frames: { type: 'string', default: '60' },
		'check-only': { type: 'boolean' },
		'gpu-timers': { type: 'boolean' },
		'scatter-paths': { type: 'boolean' },
		'heat-paths': { type: 'boolean' },
		study: { type: 'string' },
	},
});
const gpuTimers = values['gpu-timers'] ?? false;
const repeats = Number(values.repeats);
const frames = Number(values.frames);
if (!Number.isSafeInteger(repeats) || repeats < 1 || !Number.isSafeInteger(frames) || frames < 2)
	throw new Error('Expected positive repeats and at least two frames');

const scatterPaths = values['scatter-paths'] ?? false;
const heatPaths = values['heat-paths'] ?? false;
const study = values.study;
const { backends, cases } = selectStudy(study, scatterPaths, heatPaths, gpuTimers);
const routes = new Map();
for (const name of [
	'run-page',
	'scene',
	'timers',
	'canvas2d',
	'webgl2',
	'webgpu',
	'webgpu-columns',
	'webgpu-mesh',
	'webgpu-tiles',
	'webgpu-transfer',
	'mark-layer',
	'webgpu-view',
]) {
	routes.set(
		'/' + name + '.js',
		await readFile(new URL('../prototypes/mark-backends/' + name + '.js', import.meta.url), 'utf8'),
	);
}
const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
const browser = await chromium.launch({ headless: true, channel: 'chromium' });
const context = await browser.newContext({ viewport: { width: 1200, height: 600 }, deviceScaleFactor: 2 });
const errors = [];
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
const origin = 'http://localhost:39421';
await context.route(origin + '/**', route => {
	const path = new URL(route.request().url()).pathname;
	if (path === '/')
		return route.fulfill({
			headers,
			contentType: 'text/html',
			body: '<!doctype html><body style="margin:0;overflow:hidden"><script type="module">import {run} from "/run-page.js"; window.run = run;</script>',
		});
	const body = routes.get(path);
	return route.fulfill({
		headers,
		status: body === undefined ? 404 : 200,
		contentType: 'text/javascript',
		body: body ?? '',
	});
});

async function newPage() {
	const page = await context.newPage();
	await page.goto(origin);
	await page.waitForFunction(() => typeof window.run === 'function');
	return page;
}

function gaps(timestamps) {
	return timestamps.slice(1).map((time, i) => time - timestamps[i]);
}

function summarizeTrace(trace) {
	const mark = name => trace.find(e => e.name === name)?.ts;
	const start = mark('marks:start');
	const end = mark('marks:end');
	if (!(end > start)) throw new Error('Missing trace measurement marks');
	const displayed = trace
		.filter(e => e.name === 'Display::FrameDisplayed' && e.ts >= start && e.ts < end)
		.map(e => e.ts / 1000)
		.toSorted((a, b) => a - b);
	if (displayed.length < 2) throw new Error('Missing compositor display events');
	return { displayed: displayed.length, windowMs: (end - start) / 1000, displayInterval: summarize(gaps(displayed)) };
}

try {
	const probe = await newPage();
	const adapter = await probe.evaluate(async () => {
		const gpu = await navigator.gpu?.requestAdapter();
		const gl = document.createElement('canvas').getContext('webgl2');
		const info = gl?.getExtension('WEBGL_debug_renderer_info');
		return {
			webgpuVendor: gpu?.info.vendor,
			webgpuArchitecture: gpu?.info.architecture,
			softwareWebGPU: gpu?.info.isFallbackAdapter,
			immediateAddressSpace: navigator.gpu?.wgslLanguageFeatures.has('immediate_address_space'),
			preferredCanvasFormat: navigator.gpu?.getPreferredCanvasFormat(),
			bgraStorage: gpu?.features.has('bgra8unorm-storage'),
			webglRenderer: info && gl.getParameter(info.UNMASKED_RENDERER_WEBGL),
		};
	});
	await probe.close();
	if (
		!adapter.webgpuVendor ||
		adapter.softwareWebGPU ||
		!adapter.webglRenderer ||
		/swiftshader|llvmpipe|software/i.test(adapter.webglRenderer)
	) {
		throw new Error('Hardware WebGPU and WebGL2 required: ' + JSON.stringify(adapter));
	}
	const report = {
		createdAt: new Date().toISOString(),
		chromium: browser.version(),
		cpu: os.cpus()[0].model,
		adapter,
		gpuTimers,
		scatterPaths,
		heatPaths,
		study,
		repeats,
		frames,
		loadStart: os.loadavg(),
		checks: [],
		results: [],
	};
	for (const entry of cases) {
		let reference;
		for (const backend of backends) {
			const page = await newPage();
			const output = await page.evaluate(config => window.run(config), {
				...entry,
				backend,
				frames,
				check: true,
				mixedCheck: Boolean(study),
				checkSequence: Boolean(study) || scatterPaths || heatPaths,
			});
			await page.close();
			if (reference && JSON.stringify(output) !== JSON.stringify(reference))
				throw new Error('Pixel mismatch: ' + JSON.stringify({ entry, backend, output, reference }));
			reference = output;
		}
		report.checks.push({ ...entry, ...reference });
	}
	console.log('Pixel checks passed for', cases.length, 'workloads');
	if (!values['check-only']) {
		const measured = gpuTimers ? backends.slice(1) : backends;
		for (let round = 0; round < repeats; round++) {
			for (const entry of cases) {
				for (let i = 0; i < measured.length; i++) {
					const backend = measured[(i + round) % measured.length];
					const page = await newPage();
					await browser.startTracing(page, { categories: ['viz', 'benchmark', 'blink.user_timing'] });
					const result = await page.evaluate(config => window.run(config), { ...entry, backend, frames, gpuTimers });
					const events = JSON.parse((await browser.stopTracing()).toString()).traceEvents;
					const trace = summarizeTrace(events);
					await page.close();
					const js = summarize(result.js);
					report.results.push({
						round: round + 1,
						...entry,
						backend,
						setupMs: result.setupMs,
						...(result.preparation ? { preparation: result.preparation } : {}),
						...(result.flushJs?.length ? { flushJs: summarize(result.flushJs) } : {}),
						js,
						...(result.gpuPass ? { gpuPass: summarize(result.gpuPass) } : {}),
						rafInterval: summarize(gaps(result.stamps)),
						...trace,
					});
					console.log(
						round + 1,
						entry.type,
						entry.count,
						entry.action,
						backend,
						entry.varyRange === undefined
							? (entry.shape ?? 'cloud/grid')
							: entry.varyRange
								? 'changing range'
								: 'fixed range',
						'JS p95',
						js.p95.toFixed(3),
						'ms, display p95',
						trace.displayInterval.p95.toFixed(2),
						...(result.gpuPass ? ['GPU p95', summarize(result.gpuPass).p95.toFixed(3)] : []),
						'ms',
					);
				}
			}
		}
	}
	if (errors.length) throw new Error(errors.join('\n'));
	report.loadEnd = os.loadavg();
	if (values.out) await writeFile(values.out, formatJson(report));
} finally {
	await browser.close();
}
