/// <reference types="node" />
// Runs the benchmark matrix in Chromium (or Firefox, or Chrome on an Android device) through
// Playwright and writes a JSON results file. Usage: pnpm bench [options]; pnpm bench --help lists them.

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { type Browser, type CDPSession, type Page, chromium, firefox } from 'playwright';
import { build } from 'vite';
import { adapters, knownFailure } from '../src/adapters/index.ts';
import { ALLOCATION_TRACE_CATEGORIES, type SamplingNode, allocationsHeadline } from '../src/allocations.ts';
import type { SeriesKind } from '../src/data.ts';
import type { PageEnvironment } from '../src/harness/environment.ts';
import { headline } from '../src/headline.ts';
import { planJobs } from '../src/plan.ts';
import { TRACE_CATEGORIES } from '../src/profile.ts';
import { installMarkPassTimer } from '../src/marks/pass-timer.ts';
import { redactLocalPaths } from '../src/redact.ts';
import {
	type AdapterInfo,
	DEFAULT_BUDGET_MS,
	type HeapUsage,
	type HostLoad,
	type MainThreadTimes,
	type MemorySample,
	type PageRunResult,
	type PlannedJob,
	type RunOutcome,
	type WorkerHeapUsage,
	parseSize,
} from '../src/jobs.ts';
import { type CdpHeapUsage, cdpHeapUsage, memorySample, sumWorkers } from '../src/memory.ts';
import { type CompletedJob, RESULTS_SCHEMA_VERSION, type ResultsFile, aggregate } from '../src/results.ts';
import { SCENARIOS } from '../src/scenarios/index.ts';
import {
	type RunAllocations,
	type RunProfile,
	sourceResolver,
	writeAllocations,
	writeAllocationsSummary,
	writeProfile,
	writeSummary,
} from './profile.ts';
import { type AndroidConnection, connectAndroid } from './android.ts';
import { servePreview } from './serve.ts';

const benchDir = fileURLToPath(new URL('..', import.meta.url));
const repoDir = resolve(benchDir, '..');
const require = createRequire(import.meta.url);

const HELP = `Usage: pnpm bench [options]

Selection
  --scenario <list>    ${SCENARIOS.join(', ')} (default: all)
  --lib <list>         adapter ids (default: all): ${adapters.map(a => a.id).join(', ')}
  --size <list>        data set sizes to keep, e.g. 100k,1m (default: all)
  --kind <list>        candles, line (default: both)
  --case <list>        keep only cases whose id begins with one of these /-separated parts,
                       e.g. frames/line-10m,prepend (default: all)
  --include-known-crashes
                       also run adapters on data sets they are known to fail on; by default such
                       runs are skipped and listed (Lightweight Charts on 10M line points)
  --repeats <n>        runs per case and adapter (default: 5, quick: 1)
  --budget <s>         measuring time after which a tick or frames run stops early, once it has
                       500 ticks or 30 frames; warm-up stops after 2 s (default: ${DEFAULT_BUDGET_MS / 1000};
                       0 measures all 10,000 ticks and 300 frames, as the stage 0 baseline did)
  --max-workers <list> worker limits to run the multi scenario with, one case each: numbers, or
                       default for the library's own limit (default: default)
  --mark-renderer <id>  run the chart mark workload with canvas2d, webgl2 or webgpu and a drawing
  --mark-gpu-timers     collect GPU time samples of the mark renderer in a separate run: the WebGPU
                       pass where timestamp queries are available, the WebGL2 clear and draw of a
                       series where EXT_disjoint_timer_query_webgl2 is
  --packages <dir>     measure the packages/ directory of another checkout instead of this
                       workspace's, with this harness: for comparing two versions of the library
  --quick              smoke test: small data sets, short runs, one repeat
  --list               print the jobs and exit

Browser
  --browser <name>     chromium or firefox (default: chromium). Firefox has no DevTools protocol, so
                       its runs record no heap, worker or renderer memory, no main-thread counters,
                       no garbage collections forced between runs, and no --profile or --allocations
  --android <serial>   run in Chrome on the Android device with this adb serial, over USB: the page
                       is served from this computer (adb reverse) and Chrome is driven over its
                       DevTools socket (adb forward). Pages open at the device's own viewport and
                       device pixel ratio, so --viewport, --dpr, --headed and --channel do not
                       apply; --chart still sets the chart's CSS size. The screen is kept on while
                       USB powers the device, and each run records the battery and thermal state
  --firefox-pref <list>
                       Firefox preferences for the run, name=value pairs separated by commas (true,
                       false and numbers as such), recorded in the results file. Headless Firefox
                       rasterizes Canvas 2D in software by default; gfx.canvas.accelerated=true,
                       gfx.canvas.accelerated.force-enabled=true has it draw through the GPU
  --cdp-port <n>       local port for the device's DevTools socket (default: 9222)
  --headed             open a browser window (stage 0 and 1 were measured headed). By default
                       runs are headless, in Chromium's new headless mode, which keeps GPU
                       rasterization (Playwright's default headless shell renders in software)
                       and opens no window that takes the focus. Frame JavaScript time and tick
                       cost match headed runs, but headless frame intervals stay at the refresh
                       interval and miss raster and presentation stalls: measure those headed
  --channel <name>     Playwright channel, e.g. chrome for the installed Google Chrome
                       (default: Playwright's bundled Chromium)
  --viewport <WxH>     page viewport in CSS pixels (default: 1280x720; not with --android)
  --dpr <n>            device pixel ratio (default: 2; not with --android)
  --chart <WxH>        chart size in CSS pixels (default: 1200x600)
  --cpu-throttle <rate>
                       slow the page's CPU down by this factor (Chromium on this computer only,
                       through the DevTools protocol's Emulation.setCPUThrottlingRate; 1 is none),
                       as a stand-in for a slower device. It slows the page's main thread and its
                       workers (Chromium throttles the renderer process), not the GPU process or
                       the rasterizer, and is recorded in the results file

Profiling
  --profile <dir>      trace every run (CPU samples of every thread, frames, tasks, GC) and write
                       <dir>/<run>.trace.json, a breakdown per run in <dir>/<run>.json and all of
                       them in <dir>/summary.json. The page is built without minification, so
                       samples carry function names. Tracing slows the runs: use the timings of a
                       run without it, and the breakdown for shares
  --allocations <dir>  record what the page's main thread allocates in the measured part of every
                       tick run (tick, ind-apply): a sampling heap profile by call site, library
                       or harness, and the garbage collections, in <dir>/<run>.json and all of
                       them in <dir>/summary.json. Bytes and counts hold on a busy machine, where
                       times do not; sampling slows the runs, so take timings from a run without

Output
  --timeout <s>        per-run timeout in seconds (default: 900)
  --port <n>           serve the page on 127.0.0.1 at this port, and fail if it is taken, rather
                       than on the first free port from 4173: another checkout's server there
                       cannot answer for this one
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
		case: { type: 'string' },
		'include-known-crashes': { type: 'boolean', default: false },
		repeats: { type: 'string' },
		budget: { type: 'string' },
		'max-workers': { type: 'string' },
		packages: { type: 'string' },
		'mark-renderer': { type: 'string' },
		'mark-gpu-timers': { type: 'boolean' },
		quick: { type: 'boolean', default: false },
		list: { type: 'boolean', default: false },
		headed: { type: 'boolean', default: false },
		channel: { type: 'string' },
		browser: { type: 'string', default: 'chromium' },
		android: { type: 'string' },
		'cdp-port': { type: 'string', default: '9222' },
		'firefox-pref': { type: 'string' },
		viewport: { type: 'string' },
		dpr: { type: 'string' },
		chart: { type: 'string', default: '1200x600' },
		'cpu-throttle': { type: 'string' },
		timeout: { type: 'string', default: '900' },
		port: { type: 'string' },
		out: { type: 'string' },
		profile: { type: 'string' },
		allocations: { type: 'string' },
		help: { type: 'boolean', default: false },
	},
	allowPositionals: false,
});

if (args.help) {
	process.stdout.write(HELP);
	process.exit(0);
}

const engine = oneOf(['chromium', 'firefox'], args.browser, '--browser');
const androidSerial = args.android ?? null;
if (androidSerial !== null) {
	for (const [flag, given] of [
		['--browser', engine !== 'chromium'],
		['--viewport', args.viewport !== undefined],
		['--dpr', args.dpr !== undefined],
		['--headed', args.headed],
		['--channel', args.channel !== undefined],
	] as const) {
		if (given) {
			throw new Error(`${flag} does not apply with --android: the device's own Chrome, viewport and ratio are used`);
		}
	}
}
/** Whether the browser speaks the DevTools protocol: Chromium on the desktop and Chrome on Android. */
const speaksCdp = engine === 'chromium';
/** Preferences of a Firefox run (`--firefox-pref`). */
const firefoxPrefs: Record<string, string | number | boolean> = {};
for (const pair of list(args['firefox-pref'])) {
	const at = pair.indexOf('=');
	if (at <= 0) {
		throw new Error(`--firefox-pref expects name=value, got "${pair}"`);
	}
	const value = pair.slice(at + 1);
	firefoxPrefs[pair.slice(0, at)] =
		value === 'true'
			? true
			: value === 'false'
				? false
				: value !== '' && Number.isFinite(Number(value))
					? Number(value)
					: value;
}
if (Object.keys(firefoxPrefs).length > 0 && engine !== 'firefox') {
	throw new Error('--firefox-pref applies to --browser firefox only');
}
/** Factor the page's CPU is slowed down by (`--cpu-throttle`), or null for none. */
const cpuThrottle = args['cpu-throttle'] === undefined ? null : Number(args['cpu-throttle']);
if (cpuThrottle !== null) {
	if (!(cpuThrottle >= 1) || !Number.isFinite(cpuThrottle)) {
		throw new Error(`--cpu-throttle expects a factor of at least 1, got "${args['cpu-throttle']}"`);
	}
	if (!speaksCdp) {
		throw new Error(`--cpu-throttle throttles through Chromium's DevTools protocol: it does not apply to ${engine}`);
	}
	if (androidSerial !== null) {
		// A phone is the slower device itself; throttling it further measures no device.
		throw new Error('--cpu-throttle stands in for a slower device on this computer: it does not apply with --android');
	}
}
const viewport = parseDimensions(args.viewport ?? '1280x720', '--viewport');
const chart = parseDimensions(args.chart, '--chart');
const dpr = Number(args.dpr ?? '2');
const cdpPort = Number(args['cdp-port']);
const timeoutMs = Number(args.timeout) * 1000;
const budgetMs = args.budget !== undefined ? Number(args.budget) * 1000 : DEFAULT_BUDGET_MS;
if (!(budgetMs >= 0)) {
	throw new Error(`--budget expects a number of seconds, got "${args.budget}"`);
}
const maxWorkers = list(args['max-workers']).map(value => {
	if (value === 'default') {
		return null;
	}
	const count = Number(value);
	if (!Number.isInteger(count) || count < 1) {
		throw new Error(`--max-workers expects numbers of at least 1 or "default", got "${value}"`);
	}
	return count;
});
// pnpm runs package scripts in the package directory; resolve paths against where they were typed.
const invokedFrom = process.env['INIT_CWD'] ?? process.cwd();
const profileDir = args.profile !== undefined ? resolve(invokedFrom, args.profile) : null;
const allocationsDir = args.allocations !== undefined ? resolve(invokedFrom, args.allocations) : null;
if (profileDir !== null && allocationsDir !== null) {
	throw new Error('--profile and --allocations each record a trace of their own: use one per run');
}
if (!speaksCdp && (profileDir !== null || allocationsDir !== null)) {
	throw new Error('--profile and --allocations record through the DevTools protocol, which Firefox lacks');
}
if (profileDir !== null || allocationsDir !== null) {
	// Read by the Vite configuration, which runs in this process.
	process.env['LUMEN_BENCH_PROFILE'] = '1';
}
if (args.packages !== undefined) {
	// Read by the Vite configuration, which runs in this process.
	process.env['LUMEN_BENCH_PACKAGES'] = resolve(invokedFrom, args.packages);
}
const scenarios = list(args.scenario).map(s => oneOf(SCENARIOS, s, '--scenario'));
const adapterIds = list(args.lib);
for (const id of adapterIds) {
	oneOf(
		adapters.map(a => a.id),
		id,
		'--lib',
	);
}
const { jobs: plan, skipped } = planJobs({
	scenarios: scenarios.length > 0 ? scenarios : SCENARIOS,
	adapters: adapterIds.length > 0 ? adapterIds : adapters.map(a => a.id),
	sizes: list(args.size).map(parseSize),
	kinds: list(args.kind).map(k => oneOf<SeriesKind>(['candles', 'line'], k, '--kind')),
	cases: list(args.case),
	repeats: args.repeats !== undefined ? Number(args.repeats) : args.quick ? 1 : 5,
	quick: args.quick,
	chart,
	seed: 1,
	budgetMs,
	...(maxWorkers.length > 0 ? { maxWorkers } : {}),
	...(args['include-known-crashes'] ? {} : { skip: knownFailure }),
});

function reportSkipped(): void {
	const groups = new Map<string, number>();
	for (const { adapter, reason } of skipped) {
		const key = `${adapter}: ${reason}`;
		groups.set(key, (groups.get(key) ?? 0) + 1);
	}
	for (const [key, count] of groups) {
		process.stdout.write(`Skipping ${key} (${count} cases; --include-known-crashes runs them)\n`);
	}
}

if (args.list || plan.length === 0) {
	for (const planned of plan) {
		process.stdout.write(`${planned.id}\n`);
	}
	reportSkipped();
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

/** Local directories that must not appear in a results file, each with what replaces it. */
function localPrefixes(): [string, string][] {
	const prefixes: [string, string][] = [[os.homedir(), '~']];
	const tmp = os.tmpdir();
	prefixes.push([tmp, '$TMPDIR']);
	try {
		// On macOS the temporary directory is reached through a symbolic link (/var -> /private/var).
		prefixes.push([realpathSync(tmp), '$TMPDIR']);
	} catch {
		// Not resolvable: the unresolved path is replaced.
	}
	return prefixes;
}

/** Text of a `chrome://` page, with local paths removed (see `redactLocalPaths`); null in Firefox. */
async function scrapeChromePage(session: Session, url: string, selector: string): Promise<string | null> {
	if (!speaksCdp) {
		return null;
	}
	let close: (() => Promise<void>) | null = null;
	try {
		let page: Page;
		if (session.android !== null) {
			page = await session.android.newPage();
			close = () => page.close();
		} else {
			const context = await session.browser.newContext();
			close = () => context.close();
			page = await context.newPage();
		}
		await page.goto(url, { timeout: 10_000 });
		await page.waitForTimeout(500);
		const text = await page.locator(selector).first().innerText({ timeout: 5_000 });
		return redactLocalPaths(text.trim(), localPrefixes());
	} catch {
		return null;
	} finally {
		await close?.().catch(() => undefined);
	}
}

// Runs ---------------------------------------------------------------------------------------------

interface Session {
	browser: Browser;
	baseUrl: string;
	/** The Android device the pages run on (`--android`), or null on this computer. */
	android: AndroidConnection | null;
}

/**
 * Headless by default: a headed window takes the focus on every new page, which makes the machine
 * unusable while a run lasts. Playwright's own headless browser is a separate "headless shell"
 * build that rasterizes with SwiftShader on the CPU; the `chromium` channel runs the full browser
 * in new headless mode instead, which rasterizes on the GPU like a window does.
 */
const headless = !args.headed && androidSerial === null;
const channel = engine === 'chromium' ? (args.channel ?? (headless ? 'chromium' : undefined)) : undefined;

/** Starts the browser, or connects to the device's Chrome again (`--android`). */
function launch(session?: Session): Promise<Browser> {
	if (session?.android) {
		return session.android.reconnect();
	}
	if (engine === 'firefox') {
		// Playwright's ratio override does not survive the process switch into a cross-origin
		// isolated page in Firefox 157, which then draws at 1; the preference sets it for every page.
		return firefox.launch({
			headless,
			firefoxUserPrefs: { 'layout.css.devPixelsPerPx': String(dpr), ...firefoxPrefs },
		});
	}
	return chromium.launch({ headless, ...(channel !== undefined ? { channel } : {}) });
}

/** Longest wait for a worker's reply; a worker that is shutting down may never answer. */
const WORKER_REPLY_TIMEOUT_MS = 10_000;

type ProtocolReply = { result?: unknown; error?: { message: string } };

/**
 * Heap usage of each dedicated worker of the page, each after a full garbage collection, summed.
 * Every worker has a heap of its own, which `Runtime.getHeapUsage` on the page does not include.
 *
 * Playwright's CDP sessions cannot address the flattened child sessions that `Target.setAutoAttach`
 * creates with `flatten: true`, so workers are attached in the older non-flat mode and spoken to
 * through `Target.sendMessageToTarget` (deprecated in the protocol, working in Chromium 156). They
 * are attached only while measuring, so no debugging session is attached while scenarios are timed.
 * Returns null when attaching fails.
 */
async function measureWorkers(cdp: CDPSession): Promise<WorkerHeapUsage | null> {
	const sessions: string[] = [];
	const replies = new Map<number, (reply: ProtocolReply) => void>();
	let nextId = 0;
	const onAttached = (event: { sessionId: string; targetInfo: { type: string } }): void => {
		if (event.targetInfo.type === 'worker') {
			sessions.push(event.sessionId);
		}
	};
	const onMessage = (event: { message: string }): void => {
		const message = JSON.parse(event.message) as ProtocolReply & { id?: number };
		if (message.id !== undefined) {
			replies.get(message.id)?.(message);
		}
	};
	const call = (sessionId: string, method: string): Promise<unknown> => {
		const id = ++nextId;
		return new Promise<unknown>((resolveCall, rejectCall) => {
			const finish = (reply: ProtocolReply): void => {
				clearTimeout(timer);
				replies.delete(id);
				if (reply.error === undefined) {
					resolveCall(reply.result);
				} else {
					rejectCall(new Error(reply.error.message));
				}
			};
			const timer = setTimeout(() => finish({ error: { message: `${method}: no reply` } }), WORKER_REPLY_TIMEOUT_MS);
			replies.set(id, finish);
			cdp
				.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params: {} }) })
				.catch((error: unknown) => finish({ error: { message: String(error) } }));
		});
	};
	cdp.on('Target.attachedToTarget', onAttached);
	cdp.on('Target.receivedMessageFromTarget', onMessage);
	try {
		// Workers that already run are reported before this command returns.
		await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: false });
		const heaps: HeapUsage[] = [];
		for (const sessionId of sessions) {
			try {
				await call(sessionId, 'HeapProfiler.collectGarbage');
				heaps.push(cdpHeapUsage((await call(sessionId, 'Runtime.getHeapUsage')) as CdpHeapUsage));
			} catch {
				// A worker that is shutting down (the one of a destroyed chart) has nothing left to count.
			}
		}
		return sumWorkers(heaps);
	} catch {
		return null;
	} finally {
		// Turning auto-attach off detaches from the workers again.
		await cdp
			.send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: false })
			.catch(() => undefined);
		cdp.off('Target.attachedToTarget', onAttached);
		cdp.off('Target.receivedMessageFromTarget', onMessage);
	}
}

/**
 * Resident memory of the browser's renderer processes, summed, in bytes: what `ps` reports for
 * them. Null where the processes cannot be listed or `ps` is missing (Windows).
 */
async function rendererResidentBytes(session: Session): Promise<number | null> {
	try {
		const browserCdp = await session.browser.newBrowserCDPSession();
		let pids: string[];
		try {
			const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo');
			pids = processInfo.filter(process => process.type === 'renderer').map(process => String(process.id));
		} finally {
			await browserCdp.detach().catch(() => undefined);
		}
		if (session.android !== null) {
			// The processes run on the device: its `ps` reports them.
			return session.android.residentBytes(pids.map(Number));
		}
		const output = pids.length === 0 ? null : command('ps', ['-o', 'rss=', '-p', pids.join(',')]);
		if (output === null) {
			return null;
		}
		let kibibytes = 0;
		for (const line of output.split('\n')) {
			const value = Number(line.trim());
			if (line.trim() !== '' && Number.isFinite(value)) {
				kibibytes += value;
			}
		}
		return kibibytes * 1024;
	} catch {
		return null;
	}
}

/** Bytes between two samples of the heap profiler: small, so a few megabytes give a steady share per call site. */
const ALLOCATION_SAMPLING_BYTES = 1024;

/** The sampling heap profile of the measured part of a run and the ticks it applied. */
interface Sampled {
	head: SamplingNode;
	ticks: number;
}

interface BenchPage {
	page: Page;
	/** Closes the page, and its browser context where it has one of its own. */
	close: () => Promise<void>;
	/** What the page recorded, once it has stopped the record (`--allocations`). */
	sampled: () => Sampled | null;
}

async function newPage(session: Session): Promise<BenchPage> {
	let page: Page;
	let close: () => Promise<void>;
	if (session.android !== null) {
		page = await session.android.newPage();
		close = () => page.close();
	} else {
		const context = await session.browser.newContext({ viewport, deviceScaleFactor: dpr });
		page = await context.newPage();
		close = () => context.close();
	}
	if (args['mark-gpu-timers']) await page.addInitScript(installMarkPassTimer);
	let sampled: Sampled | null = null;
	if (speaksCdp) {
		await exposeProtocolProbes(session, page, record => {
			sampled = record;
		});
	}
	if (cpuThrottle !== null) {
		// For the whole life of the page, set up and measurement alike, as on a slower device. The
		// session stays attached until the page closes; the rate holds across its navigation.
		const cdp = await page.context().newCDPSession(page);
		await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle });
	}
	const query = new URLSearchParams({ auto: '', width: String(chart.width), height: String(chart.height) });
	if (args['mark-renderer'])
		query.set('markRenderer', oneOf(['canvas2d', 'webgl2', 'webgpu'], args['mark-renderer'], '--mark-renderer'));
	await page.goto(`${session.baseUrl}?${query.toString()}`);
	await page.waitForFunction(() => window.bench !== undefined);
	return { page, close, sampled: () => sampled };
}

/**
 * Gives the page the probes that need the DevTools protocol: garbage collection, heap and worker
 * memory, main-thread counters, renderer memory and allocation sampling. Without them (Firefox)
 * the page falls back to what it can do itself (see `harness/probes.ts`).
 */
async function exposeProtocolProbes(session: Session, page: Page, onSampled: (record: Sampled) => void): Promise<void> {
	const cdp = await page.context().newCDPSession(page);
	await page.exposeFunction('__benchCollectGarbage', async () => {
		await cdp.send('HeapProfiler.collectGarbage');
	});
	await page.exposeFunction('__benchMeasureMemory', async (): Promise<MemorySample> => {
		// The page's heap first: scenarios collect its garbage right before measuring.
		const pageHeap = cdpHeapUsage(await cdp.send('Runtime.getHeapUsage'));
		const workers = await measureWorkers(cdp);
		return memorySample(
			workers === null
				? 'CDP Runtime.getHeapUsage of the page (workers could not be attached)'
				: 'CDP Runtime.getHeapUsage of the page and of each dedicated worker (after a GC in each worker)',
			pageHeap,
			workers,
		);
	});
	let performanceEnabled = false;
	await page.exposeFunction('__benchMainThread', async (): Promise<MainThreadTimes> => {
		if (!performanceEnabled) {
			// The counters run from the start of the page; enabling the domain only makes them readable.
			await cdp.send('Performance.enable');
			performanceEnabled = true;
		}
		const { metrics } = await cdp.send('Performance.getMetrics');
		// Seconds in the protocol.
		const ms = (name: string): number => (metrics.find(metric => metric.name === name)?.value ?? 0) * 1000;
		return {
			taskMs: ms('TaskDuration'),
			scriptMs: ms('ScriptDuration'),
			layoutMs: ms('LayoutDuration'),
			styleMs: ms('RecalcStyleDuration'),
		};
	});
	await page.exposeFunction('__benchRendererMemory', () => rendererResidentBytes(session));
	if (allocationsDir !== null) {
		await cdp.send('HeapProfiler.enable');
		await page.exposeFunction('__benchAllocations', async (edge: 'start' | 'end', ticks: number) => {
			if (edge === 'start') {
				// Collected objects stay in the profile: it counts what was allocated, not what is left.
				await cdp.send('HeapProfiler.startSampling', {
					samplingInterval: ALLOCATION_SAMPLING_BYTES,
					includeObjectsCollectedByMajorGC: true,
					includeObjectsCollectedByMinorGC: true,
				});
			} else {
				onSampled({ head: (await cdp.send('HeapProfiler.stopSampling')).profile.head, ticks });
			}
		});
	}
}

function delay<T>(ms: number, value: T): { promise: Promise<T>; cancel: () => void } {
	let timer: NodeJS.Timeout | undefined;
	const promise = new Promise<T>(resolveDelay => {
		timer = setTimeout(() => resolveDelay(value), ms);
	});
	return { promise, cancel: () => clearTimeout(timer) };
}

async function closePage(session: Session, benchPage: BenchPage): Promise<void> {
	const closing = delay(20_000, 'stuck' as const);
	// Closing fails when the browser has gone away, which leaves nothing to close.
	const close = benchPage.close().then(
		() => 'closed' as const,
		() => 'closed' as const,
	);
	const result = await Promise.race([close, closing.promise]);
	closing.cancel();
	if (result === 'stuck') {
		// A renderer busy in a long synchronous call can keep the context from closing.
		process.stdout.write('  context did not close; restarting the browser\n');
		if (session.android === null) {
			await session.browser.close().catch(() => undefined);
		}
		session.browser = await launch(session);
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

const profiles: RunProfile[] = [];
const allocations: RunAllocations[] = [];
const resolveSource = sourceResolver();

async function runOne(session: Session, planned: PlannedJob): Promise<CompletedJob> {
	const started = performance.now();
	const cpuStart = cpuTimes();
	if (!session.browser.isConnected() || session.android?.mapped() === false) {
		// The browser process is gone (it crashed or was killed during the previous run), or the adb
		// server restarted and dropped the device's port mappings. Starting a new one costs that run,
		// not the rest of the matrix.
		process.stdout.write('  browser disconnected; restarting it\n');
		session.browser = await launch(session);
	}
	const deviceBefore = session.android?.state() ?? null;
	const benchPage = await newPage(session);
	const { page, sampled } = benchPage;
	let library: AdapterInfo | null = null;
	let outcome: RunOutcome;
	try {
		const crashed = new Promise<'crash'>(resolveCrash => page.once('crash', () => resolveCrash('crash')));
		const timer = delay(timeoutMs, 'timeout' as const);
		if (profileDir !== null) {
			// A run that failed may have left its trace recording.
			await session.browser.stopTracing().catch(() => undefined);
			await session.browser.startTracing(page, { categories: TRACE_CATEGORIES });
		} else if (allocationsDir !== null) {
			await session.browser.stopTracing().catch(() => undefined);
			await session.browser.startTracing(page, { categories: ALLOCATION_TRACE_CATEGORIES });
		}
		const run = page
			.evaluate(job => window.bench?.run(job) ?? Promise.reject(new Error('bench API missing')), planned.job)
			.catch((error: unknown) => (/crash/i.test(String(error)) ? ('crash' as const) : Promise.reject(error)));
		const result: PageRunResult | 'crash' | 'timeout' = await Promise.race([run, crashed, timer.promise]);
		timer.cancel();
		if (profileDir !== null && typeof result !== 'string') {
			try {
				profiles.push(writeProfile(profileDir, planned.id, await session.browser.stopTracing(), resolveSource));
			} catch (error) {
				process.stdout.write(`  no profile: ${error instanceof Error ? error.message : String(error)}\n`);
			}
		}
		if (allocationsDir !== null && typeof result !== 'string') {
			const trace = await session.browser.stopTracing();
			const record = sampled();
			if (record !== null) {
				try {
					const written = writeAllocations(allocationsDir, planned.id, record.head, record.ticks, trace, resolveSource);
					allocations.push(written);
					process.stdout.write(`  ${allocationsHeadline(written.summary)}\n`);
				} catch (error) {
					process.stdout.write(`  no allocations: ${error instanceof Error ? error.message : String(error)}\n`);
				}
			}
		}
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
		await closePage(session, benchPage);
	}
	const host = hostLoad(cpuStart);
	if (session.android !== null && deviceBefore !== null) {
		host.device = { before: deviceBefore, after: session.android.state() };
	}
	return { planned, outcome: { ...outcome, host }, library };
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
	const out =
		args.out !== undefined
			? resolve(invokedFrom, args.out)
			: resolve(benchDir, 'results', `${createdAt.toISOString().replace(/[:.]/g, '-')}.json`);
	process.stdout.write(`Building the harness page…\n`);
	// Isolate the served files from concurrent browser checks and baseline checkouts.
	const buildDir = mkdtempSync(resolve(os.tmpdir(), 'lumen-bench-'));
	process.once('exit', () => rmSync(buildDir, { recursive: true, force: true }));
	const viteOptions = {
		configFile: resolve(benchDir, 'vite.config.ts'),
		logLevel: 'warn' as const,
		build: { outDir: buildDir, emptyOutDir: true },
	};
	await build(viteOptions);
	const requested = args.port === undefined ? undefined : Number(args.port);
	if (requested !== undefined && !(Number.isInteger(requested) && requested > 0 && requested < 65536)) {
		throw new Error(`--port expects a port number, got "${args.port}"`);
	}
	// On 127.0.0.1 at a port of its own (`--port`, or one the system hands out), which `adb reverse`
	// also reaches from a device.
	const { server, port, url: localUrl } = await servePreview(viteOptions, requested);
	const caffeinate = keepAwake();
	let session: Session;
	if (androidSerial !== null) {
		const android = await connectAndroid(androidSerial, port, cdpPort);
		// localhost on the device is a secure context, as on the desktop: WebGPU and isolation work.
		session = { browser: android.browser, baseUrl: `http://localhost:${port}/`, android };
		const { device } = android;
		process.stdout.write(
			`Device: ${device.manufacturer} ${device.model} (${device.soc}), Android ${device.android}, ` +
				`Chrome ${device.chrome}, ${device.display}\n`,
		);
	} else {
		session = { browser: await launch(), baseUrl: localUrl, android: null };
	}
	const loadStart = os.loadavg();
	reportSkipped();

	try {
		const commandLine = await scrapeChromePage(session, 'chrome://version', '#command_line');
		const gpuStatus = await scrapeChromePage(session, 'chrome://gpu', 'body');
		const probe = await newPage(session);
		const page = await probe.page.evaluate(() => window.bench?.environment() ?? null);
		await closePage(session, probe);
		if (page === null) {
			throw new Error('Harness page did not expose its environment');
		}
		reportEnvironment(page);

		const completed: CompletedJob[] = [];
		const runStart = performance.now();
		for (const [index, planned] of plan.entries()) {
			let result = await runOne(session, planned);
			if (
				session.android !== null &&
				result.outcome.status === 'failed' &&
				/has been closed|disconnected/i.test(result.outcome.message)
			) {
				// The DevTools connection to the device dropped (another adb client restarted the adb
				// server): the run says nothing about the chart, so it runs again once, reconnected.
				process.stdout.write(`  ${planned.id}: connection to the device lost; running it again\n`);
				result = await runOne(session, planned);
			}
			completed.push(result);
			const elapsed = (performance.now() - runStart) / 1000;
			const eta = (elapsed / (index + 1)) * (plan.length - index - 1);
			const one = aggregate([result])[0];
			const summary = one === undefined ? '' : headline(one);
			const host = result.outcome.host;
			const thermal = host?.device?.after;
			const idle =
				host === undefined
					? ''
					: thermal !== undefined
						? `battery ${thermal.battery.temperatureC ?? '–'} °C, thermal status ${thermal.thermal.status ?? '–'}, `
						: `cpu idle ${Math.round(host.cpuIdle * 100)}%, `;
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
					arguments: process.argv.slice(2).map(arg => redactLocalPaths(arg, localPrefixes())),
					node: process.version,
					durationSeconds: (performance.now() - runStart) / 1000,
					skipped,
				},
				machine: { ...machineEnvironment(), loadAverageStart: loadStart, loadAverageEnd: os.loadavg() },
				browser: {
					engine,
					version: session.browser.version(),
					channel: session.android !== null ? 'android' : (channel ?? 'playwright-bundled'),
					headless,
					commandLine,
					gpuStatus,
					...(engine === 'firefox' ? { firefoxPrefs } : {}),
				},
				// The factor the page's CPU was slowed down by (`--cpu-throttle`); 1 for none.
				cpuThrottlingRate: cpuThrottle ?? 1,
				// On a device, the page's own viewport and ratio, as it reported them.
				viewport: session.android !== null ? page.viewport : viewport,
				deviceScaleFactor: session.android !== null ? page.devicePixelRatio : dpr,
				...(session.android !== null ? { device: session.android.device } : {}),
				chart,
				page,
				git: {
					commit: command('git', ['-C', repoDir, 'rev-parse', 'HEAD']),
					dirty: (command('git', ['-C', repoDir, 'status', '--porcelain']) ?? '') !== '',
				},
				// Which library sources the workspace adapters were built from: the workspace's (the commit
				// above), or the directory given with --packages, as it was typed.
				sources: args.packages ? redactLocalPaths(args.packages, localPrefixes()) : 'workspace',
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

		if (profileDir !== null) {
			writeSummary(profileDir, profiles);
		}
		if (allocationsDir !== null) {
			writeAllocationsSummary(allocationsDir, allocations);
		}

		process.stdout.write('\nMedian over runs:\n');
		for (const c of file.cases) {
			process.stdout.write(`  ${c.caseId} ${c.adapter} [${c.status}] ${headline(c)}\n`);
		}
		process.stdout.write(`\nWrote ${relative(process.cwd(), out)}\n`);
	} finally {
		if (session.android !== null) {
			await session.android.close();
		} else {
			await session.browser.close().catch(() => undefined);
		}
		await server.close();
		caffeinate?.kill();
	}
}

function reportEnvironment(page: PageEnvironment): void {
	process.stdout.write(
		`Page: DPR ${page.devicePixelRatio}, chart ${page.chart.width}x${page.chart.height}, ` +
			(cpuThrottle === null ? '' : `CPU throttled ${cpuThrottle}x, `) +
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
