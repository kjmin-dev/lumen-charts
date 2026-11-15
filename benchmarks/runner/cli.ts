/// <reference types="node" />
// Runs the benchmark matrix in Chromium through Playwright and writes a JSON results file.
// Usage: pnpm bench [options]; pnpm bench --help lists them.

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';
import { build, preview } from 'vite';
import { adapters } from '../src/adapters/index.ts';
import type { SeriesKind } from '../src/data.ts';
import type { PageEnvironment } from '../src/harness/environment.ts';
import { headline } from '../src/headline.ts';
import {
	type AdapterInfo,
	type HostLoad,
	type MemorySample,
	type PageRunResult,
	type PlannedJob,
	type RunOutcome,
	SCENARIOS,
	parseSize,
	planJobs,
} from '../src/jobs.ts';
import { type CompletedJob, RESULTS_SCHEMA_VERSION, type ResultsFile, aggregate } from '../src/results.ts';

const benchDir = fileURLToPath(new URL('..', import.meta.url));
const repoDir = resolve(benchDir, '..');
const require = createRequire(import.meta.url);

const HELP = `Usage: pnpm bench [options]

Selection
  --scenario <list>    load, tick, frames (default: all)
  --lib <list>         adapter ids (default: all): ${adapters.map(a => a.id).join(', ')}
  --size <list>        data set sizes to keep, e.g. 100k,1m (default: all)
  --kind <list>        candles, line (default: both)
  --repeats <n>        runs per case and adapter (default: 5, quick: 1)
  --quick              smoke test: small data sets, short runs, one repeat
  --list               print the jobs and exit

Browser
  --headless           run without a window (Chromium's new headless mode, which keeps GPU
                       rasterization; Playwright's default headless shell renders in software)
  --channel <name>     Playwright channel, e.g. chrome for the installed Google Chrome
                       (default: Playwright's bundled Chromium)
  --viewport <WxH>     page viewport in CSS pixels (default: 1280x720)
  --dpr <n>            device pixel ratio (default: 2)
  --chart <WxH>        chart size in CSS pixels (default: 1200x600)

Output
  --timeout <s>        per-run timeout in seconds (default: 900)
  --out <file>         results file (default: benchmarks/results/<time>.json)
`;

interface Size {
	width: number;
	height: number;
}

function parseDimensions(value: string, flag: string): Size {
	const match = /^(\d+)x(\d+)$/.exec(value);
	if (match === null) {
		throw new Error(`${flag} expects WxH, got "${value}"`);
	}
	return { width: Number(match[1]), height: Number(match[2]) };
}

function list(value: string | undefined): string[] {
	return value === undefined
		? []
		: value
				.split(',')
				.map(s => s.trim())
				.filter(s => s !== '');
}

function oneOf<T extends string>(values: readonly T[], value: string, flag: string): T {
	if (!(values as readonly string[]).includes(value)) {
		throw new Error(`${flag}: unknown value "${value}" (expected one of ${values.join(', ')})`);
	}
	return value as T;
}

const { values: args } = parseArgs({
	options: {
		scenario: { type: 'string' },
		lib: { type: 'string' },
		size: { type: 'string' },
		kind: { type: 'string' },
		repeats: { type: 'string' },
		quick: { type: 'boolean', default: false },
		list: { type: 'boolean', default: false },
		headless: { type: 'boolean', default: false },
		channel: { type: 'string' },
		viewport: { type: 'string', default: '1280x720' },
		dpr: { type: 'string', default: '2' },
		chart: { type: 'string', default: '1200x600' },
		timeout: { type: 'string', default: '900' },
		out: { type: 'string' },
		help: { type: 'boolean', default: false },
	},
	allowPositionals: false,
});

if (args.help) {
	process.stdout.write(HELP);
	process.exit(0);
}

const viewport = parseDimensions(args.viewport, '--viewport');
const chart = parseDimensions(args.chart, '--chart');
const dpr = Number(args.dpr);
const timeoutMs = Number(args.timeout) * 1000;
const scenarios = list(args.scenario).map(s => oneOf(SCENARIOS, s, '--scenario'));
const adapterIds = list(args.lib);
for (const id of adapterIds) {
	oneOf(
		adapters.map(a => a.id),
		id,
		'--lib',
	);
}
const plan = planJobs({
	scenarios: scenarios.length > 0 ? scenarios : SCENARIOS,
	adapters: adapterIds.length > 0 ? adapterIds : adapters.map(a => a.id),
	sizes: list(args.size).map(parseSize),
	kinds: list(args.kind).map(k => oneOf<SeriesKind>(['candles', 'line'], k, '--kind')),
	repeats: args.repeats !== undefined ? Number(args.repeats) : args.quick ? 1 : 5,
	quick: args.quick,
	chart,
	seed: 1,
});

if (args.list || plan.length === 0) {
	for (const planned of plan) {
		process.stdout.write(`${planned.id}\n`);
	}
	process.stdout.write(`${plan.length} runs\n`);
	process.exit(0);
}

// Environment --------------------------------------------------------------------------------------

function command(file: string, commandArgs: string[]): string | null {
	try {
		return execFileSync(file, commandArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
	} catch {
		return null;
	}
}

function packageVersion(name: string): string | null {
	try {
		const path = require.resolve(`${name}/package.json`, { paths: [benchDir] });
		return (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version;
	} catch {
		return null;
	}
}

function machineEnvironment(): Record<string, unknown> {
	const cpus = os.cpus();
	return {
		platform: os.platform(),
		release: os.release(),
		arch: os.arch(),
		cpuModel: cpus[0]?.model ?? null,
		cpuCores: cpus.length,
		totalMemoryBytes: os.totalmem(),
		power: os.platform() === 'darwin' ? command('pmset', ['-g', 'batt'])?.split('\n')[0] : null,
	};
}

async function scrapeChromePage(browser: Browser, url: string, selector: string): Promise<string | null> {
	const context = await browser.newContext();
	try {
		const page = await context.newPage();
		await page.goto(url, { timeout: 10_000 });
		await page.waitForTimeout(500);
		const text = await page.locator(selector).first().innerText({ timeout: 5_000 });
		return text.trim();
	} catch {
		return null;
	} finally {
		await context.close();
	}
}

// Runs ---------------------------------------------------------------------------------------------

interface Session {
	browser: Browser;
	baseUrl: string;
}

/**
 * Playwright's own headless browser is a separate "headless shell" build that rasterizes with
 * SwiftShader on the CPU. The `chromium` channel runs the full browser in new headless mode instead.
 */
const channel = args.channel ?? (args.headless ? 'chromium' : undefined);

function launch(): Promise<Browser> {
	return chromium.launch({ headless: args.headless, ...(channel !== undefined ? { channel } : {}) });
}

async function newPage(session: Session): Promise<{ context: BrowserContext; page: Page }> {
	const context = await session.browser.newContext({ viewport, deviceScaleFactor: dpr });
	const page = await context.newPage();
	const cdp = await context.newCDPSession(page);
	await page.exposeFunction('__benchCollectGarbage', async () => {
		await cdp.send('HeapProfiler.collectGarbage');
	});
	await page.exposeFunction('__benchMeasureMemory', async (): Promise<MemorySample> => {
		const usage = await cdp.send('Runtime.getHeapUsage');
		const backing = usage.backingStorageSize;
		const embedder = usage.embedderHeapUsedSize;
		return {
			method: 'CDP Runtime.getHeapUsage',
			jsHeapBytes: usage.usedSize,
			backingStoreBytes: backing,
			embedderHeapBytes: embedder,
			totalBytes: usage.usedSize + backing + embedder,
		};
	});
	const query = new URLSearchParams({ auto: '', width: String(chart.width), height: String(chart.height) });
	await page.goto(`${session.baseUrl}?${query.toString()}`);
	await page.waitForFunction(() => window.bench !== undefined);
	return { context, page };
}

function delay<T>(ms: number, value: T): { promise: Promise<T>; cancel: () => void } {
	let timer: NodeJS.Timeout | undefined;
	const promise = new Promise<T>(resolveDelay => {
		timer = setTimeout(() => resolveDelay(value), ms);
	});
	return { promise, cancel: () => clearTimeout(timer) };
}

async function closeContext(session: Session, context: BrowserContext): Promise<void> {
	const closing = delay(20_000, 'stuck' as const);
	const result = await Promise.race([context.close().then(() => 'closed' as const), closing.promise]);
	closing.cancel();
	if (result === 'stuck') {
		// A renderer busy in a long synchronous call can keep the context from closing.
		process.stdout.write('  context did not close; restarting the browser\n');
		await session.browser.close().catch(() => undefined);
		session.browser = await launch();
	}
}

/** Idle and total CPU time summed over all cores, in milliseconds since boot. */
function cpuTimes(): { idle: number; total: number } {
	let idle = 0;
	let total = 0;
	for (const cpu of os.cpus()) {
		const { user, nice, sys, idle: cpuIdle, irq } = cpu.times;
		idle += cpuIdle;
		total += user + nice + sys + cpuIdle + irq;
	}
	return { idle, total };
}

function hostLoad(since: { idle: number; total: number }): HostLoad {
	const now = cpuTimes();
	const total = now.total - since.total;
	return { cpuIdle: total > 0 ? (now.idle - since.idle) / total : 0, loadAverage: os.loadavg()[0] ?? 0 };
}

async function runOne(session: Session, planned: PlannedJob): Promise<CompletedJob> {
	const started = performance.now();
	const cpuStart = cpuTimes();
	const { context, page } = await newPage(session);
	let library: AdapterInfo | null = null;
	let outcome: RunOutcome;
	try {
		const crashed = new Promise<'crash'>(resolveCrash => page.once('crash', () => resolveCrash('crash')));
		const timer = delay(timeoutMs, 'timeout' as const);
		const run = page
			.evaluate(job => window.bench?.run(job) ?? Promise.reject(new Error('bench API missing')), planned.job)
			.catch((error: unknown) => (/crash/i.test(String(error)) ? ('crash' as const) : Promise.reject(error)));
		const result: PageRunResult | 'crash' | 'timeout' = await Promise.race([run, crashed, timer.promise]);
		timer.cancel();
		const durationMs = performance.now() - started;
		if (result === 'crash') {
			outcome = {
				status: 'failed',
				reason: 'crash',
				message: 'Renderer process crashed (often out of memory)',
				durationMs,
			};
		} else if (result === 'timeout') {
			outcome = { status: 'failed', reason: 'timeout', message: `No result within ${timeoutMs / 1000} s`, durationMs };
		} else if (result.status === 'ok') {
			library = result.adapter;
			outcome = { status: 'ok', result: result.result, durationMs };
		} else {
			library = result.adapter;
			outcome = { status: 'failed', reason: 'error', message: result.message, durationMs };
		}
	} catch (error) {
		outcome = {
			status: 'failed',
			reason: 'error',
			message: error instanceof Error ? error.message : String(error),
			durationMs: performance.now() - started,
		};
	} finally {
		await closeContext(session, context);
	}
	return { planned, outcome: { ...outcome, host: hostLoad(cpuStart) }, library };
}

// Main ---------------------------------------------------------------------------------------------

function keepAwake(): ChildProcess | null {
	if (os.platform() !== 'darwin') {
		return null;
	}
	// Keeps the display and the machine awake while the runner lives; headed frames stop otherwise.
	return spawn('caffeinate', ['-di', '-w', String(process.pid)], { stdio: 'ignore' });
}

function format(seconds: number): string {
	return seconds >= 60 ? `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s` : `${seconds.toFixed(1)}s`;
}

async function main(): Promise<void> {
	const createdAt = new Date();
	// pnpm runs package scripts in the package directory; resolve --out against where it was typed.
	const out =
		args.out !== undefined
			? resolve(process.env['INIT_CWD'] ?? process.cwd(), args.out)
			: resolve(benchDir, 'results', `${createdAt.toISOString().replace(/[:.]/g, '-')}.json`);
	process.stdout.write(`Building the harness page…\n`);
	await build({ configFile: resolve(benchDir, 'vite.config.ts'), logLevel: 'warn' });
	const server = await preview({ configFile: resolve(benchDir, 'vite.config.ts'), logLevel: 'warn' });
	const baseUrl = server.resolvedUrls?.local[0];
	if (baseUrl === undefined) {
		throw new Error('Preview server has no local URL');
	}
	const caffeinate = keepAwake();
	const session: Session = { browser: await launch(), baseUrl };
	const loadStart = os.loadavg();

	try {
		const commandLine = await scrapeChromePage(session.browser, 'chrome://version', '#command_line');
		const gpuStatus = await scrapeChromePage(session.browser, 'chrome://gpu', 'body');
		const probe = await newPage(session);
		const page = await probe.page.evaluate(() => window.bench?.environment() ?? null);
		await closeContext(session, probe.context);
		if (page === null) {
			throw new Error('Harness page did not expose its environment');
		}
		reportEnvironment(page);

		const completed: CompletedJob[] = [];
		const runStart = performance.now();
		for (const [index, planned] of plan.entries()) {
			const result = await runOne(session, planned);
			completed.push(result);
			const elapsed = (performance.now() - runStart) / 1000;
			const eta = (elapsed / (index + 1)) * (plan.length - index - 1);
			const one = aggregate([result])[0];
			const summary = one === undefined ? '' : headline(one);
			const host = result.outcome.host;
			const idle = host === undefined ? '' : `cpu idle ${Math.round(host.cpuIdle * 100)}%, `;
			process.stdout.write(
				`[${index + 1}/${plan.length}] ${planned.id} ${result.outcome.status} ` +
					`${format(result.outcome.durationMs / 1000)}  ${summary}  (${idle}eta ${format(eta)})\n`,
			);
		}

		const file: ResultsFile = {
			schema: RESULTS_SCHEMA_VERSION,
			createdAt: createdAt.toISOString(),
			environment: {
				runner: {
					arguments: process.argv.slice(2),
					node: process.version,
					durationSeconds: (performance.now() - runStart) / 1000,
				},
				machine: { ...machineEnvironment(), loadAverageStart: loadStart, loadAverageEnd: os.loadavg() },
				browser: {
					engine: 'chromium',
					version: session.browser.version(),
					channel: channel ?? 'playwright-bundled',
					headless: args.headless,
					commandLine,
					gpuStatus,
				},
				viewport,
				deviceScaleFactor: dpr,
				chart,
				page,
				git: {
					commit: command('git', ['-C', repoDir, 'rev-parse', 'HEAD']),
					dirty: (command('git', ['-C', repoDir, 'status', '--porcelain']) ?? '') !== '',
				},
				packages: {
					'lightweight-charts': packageVersion('lightweight-charts'),
					playwright: packageVersion('playwright'),
					vite: packageVersion('vite'),
				},
			},
			cases: aggregate(completed),
		};
		mkdirSync(dirname(out), { recursive: true });
		writeFileSync(out, `${JSON.stringify(file, null, '\t')}\n`);

		process.stdout.write('\nMedian over runs:\n');
		for (const c of file.cases) {
			process.stdout.write(`  ${c.caseId} ${c.adapter} [${c.status}] ${headline(c)}\n`);
		}
		process.stdout.write(`\nWrote ${relative(process.cwd(), out)}\n`);
	} finally {
		await session.browser.close().catch(() => undefined);
		await server.close();
		caffeinate?.kill();
	}
}

function reportEnvironment(page: PageEnvironment): void {
	process.stdout.write(
		`Page: DPR ${page.devicePixelRatio}, chart ${page.chart.width}x${page.chart.height}, ` +
			`isolated ${page.crossOriginIsolated}, timer step ${(page.timer.minStepMs * 1000).toFixed(1)} µs, ` +
			`idle frame interval p50 ${page.idleFrameInterval.p50.toFixed(2)} ms, ` +
			`WebGL ${page.webgl?.renderer ?? 'none'}, build ${page.buildMode}\n` +
			`Memory: ${page.probes.memory}; GC: ${page.probes.garbageCollection}\n` +
			`${plan.length} runs\n`,
	);
	if (/swiftshader|llvmpipe|software/i.test(page.webgl?.renderer ?? '')) {
		process.stdout.write('Warning: the browser renders in software; frame numbers will not match a GPU browser.\n');
	}
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	process.exit(1);
});
