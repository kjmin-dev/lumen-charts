// Jobs the harness page runs, their results, and the default benchmark matrix.
// Shared by the page and the Node runner, so this module must stay free of DOM and Node APIs.

import type { ChartSize } from './adapter.ts';
import type { SeriesKind } from './data.ts';
import type { Distribution } from './stats.ts';

export type ScenarioName = 'load' | 'tick' | 'frames' | 'prepend' | 'refetch';
export const SCENARIOS: readonly ScenarioName[] = ['load', 'tick', 'frames', 'prepend', 'refetch'];

export interface DatasetSpec {
	readonly kind: SeriesKind;
	readonly size: number;
}

interface JobBase {
	/** Adapter id from the registry. */
	readonly adapter: string;
	readonly dataset: DatasetSpec;
	/** Seed of the data set. Ticks use `seed + 1`. */
	readonly seed: number;
	readonly chart: ChartSize;
}

/** Cold load, then warm load and memory of the same data set in the same page. */
export interface LoadJob extends JobBase {
	readonly scenario: 'load';
}

/** Which bars are in view while ticks arrive. */
export type TickView = 'latest' | 'all';

export interface TickJob extends JobBase {
	readonly scenario: 'tick';
	/** `latest`: the last 200 bars; `all`: every bar. */
	readonly view: TickView;
	/** Measured ticks: the most a run measures. */
	readonly ticks: number;
	/**
	 * Measuring stops after the first round that ends `budgetMs` or later after measuring started,
	 * once at least `minTicks` ticks are measured. A budget of 0 always measures `ticks`.
	 */
	readonly minTicks: number;
	readonly budgetMs: number;
	/** Ticks applied before measuring, taken from the same stream: the most a run applies. */
	readonly warmupTicks: number;
	/** Warm-up stops after the first round that ends this long after it started. 0: no limit. */
	readonly warmupBudgetMs: number;
	/** Ticks applied back to back between two `settle()` calls. */
	readonly roundSize: number;
	/** Every Nth tick starts a new bar. */
	readonly newBarEvery: number;
}

export type Motion = 'pan' | 'zoom';
/** Number of bars in view, or `all` for every bar of the data set. */
export type ZoomLevel = number | 'all';

export interface FramesJob extends JobBase {
	readonly scenario: 'frames';
	readonly zoom: ZoomLevel;
	readonly motion: Motion;
	/** Measured frames: the most a run measures. */
	readonly frames: number;
	/**
	 * Measuring stops after the first frame that starts `budgetMs` or later after measuring started,
	 * once at least `minFrames` frames are measured. A budget of 0 always measures `frames`.
	 */
	readonly minFrames: number;
	readonly budgetMs: number;
	/** Frames dropped before measuring: the most a run drops. */
	readonly warmupFrames: number;
	/** Warm-up stops after the first frame that starts this long after it started (at least 3 frames). 0: no limit. */
	readonly warmupBudgetMs: number;
}

/**
 * Older history added before the first bar while the view shows that first bar in its middle, so
 * every prepended batch fills the empty left half of the view. Batch `r` is generated older than
 * the series' current first bar; prepends follow each other like pages of history loaded while
 * the user keeps scrolling back.
 */
export interface PrependJob extends JobBase {
	readonly scenario: 'prepend';
	/** Rows per prepend. */
	readonly batch: number;
	/**
	 * Bars in view while prepending: twice the batch, so the batch fills the left half, but at most
	 * the base data set.
	 */
	readonly visibleBars: number;
	/** Measured prepends: the most a run measures. One more, unmeasured, comes first (`cold`). */
	readonly prepends: number;
	/**
	 * Measuring stops after the first prepend that ends `budgetMs` or later after measuring started,
	 * once at least `minPrepends` prepends are measured. A budget of 0 always measures `prepends`.
	 */
	readonly minPrepends: number;
	readonly budgetMs: number;
}

/**
 * A series with a datafeed under a memory limit, for libraries that can fetch history again. Once
 * the library has let rows go, the view jumps from one region of old history to the next at a
 * zoom that shows single bars, so a jump that lands on rows let go makes the library fetch them
 * from the datafeed. The datafeed is in the page and answers at once, so the latency is the
 * library's own.
 */
export interface RefetchJob extends JobBase {
	readonly scenario: 'refetch';
	/** Memory limit handed to the library, in bytes. */
	readonly memoryLimit: number;
	/** Bars in view at every jump. */
	readonly visibleBars: number;
	/** Measured jumps: the most a run measures. One more, unmeasured, comes first (`coldShownMs`). */
	readonly jumps: number;
	/**
	 * Measuring stops after the first jump that ends `budgetMs` or later after measuring started,
	 * once at least `minJumps` jumps are measured. A budget of 0 always measures `jumps`.
	 */
	readonly minJumps: number;
	readonly budgetMs: number;
}

export type Job = LoadJob | TickJob | FramesJob | PrependJob | RefetchJob;

/** All times start when `setData` is called, except `convertMs` and the `*WithConversionMs` sums. */
export interface LoadTimings {
	/** Converting columns to the library's input format (`prepare*`). */
	convertMs: number;
	/** The synchronous `setData` call. */
	setDataMs: number;
	/**
	 * Until the main thread has finished the first frame in which the library ran an animation-frame
	 * callback after `setData`: the first painted frame. This is the load time.
	 */
	firstFrameMs: number;
	/** convertMs + firstFrameMs. */
	firstFrameWithConversionMs: number;
	/** Until `settle()` resolves: every follow-up draw (layout passes, for example) is done too. */
	settledMs: number;
	/** JavaScript time in animation-frame callbacks between `setData` and settling. */
	frameJsMs: number;
}

/** Memory in use by one JavaScript heap, or by several summed. */
export interface HeapUsage {
	/** V8 heap in use (JavaScript objects). */
	jsHeapBytes: number;
	/** ArrayBuffer backing stores and external strings, or null when the method cannot see them. */
	backingStoreBytes: number | null;
	/** Blink's heap (DOM and other embedder objects), or null when the method cannot see it. */
	embedderHeapBytes: number | null;
	/** Sum of the parts above that are known. */
	totalBytes: number;
}

/** The page's dedicated workers, summed. Each worker has a heap of its own. */
export interface WorkerHeapUsage extends HeapUsage {
	/** Number of workers measured. */
	count: number;
}

/**
 * Memory in use. The `HeapUsage` fields describe the page's main thread, as in every results file;
 * `workers` adds the page's dedicated workers (results before schema 2 have no workers).
 */
export interface MemorySample extends HeapUsage {
	/** How the numbers were obtained. */
	method: string;
	/** The page's dedicated workers, or null when the method cannot see them. */
	workers: WorkerHeapUsage | null;
	/** Page and workers together: totalBytes + workers.totalBytes (the page alone without workers). */
	allTotalBytes: number;
}

export interface MemoryResult {
	/** Before the measured chart is created, data already generated, after a full GC. */
	before: MemorySample;
	/** After the measured work has settled, after a full GC. */
	after: MemorySample;
	/**
	 * after.allTotalBytes - before.allTotalBytes: what the chart retains in the page and its workers.
	 * Before schema 2 this was the page alone, which missed an engine running in a worker.
	 */
	retainedBytes: number;
	/** after.totalBytes - before.totalBytes: the page's main thread alone. */
	retainedPageBytes: number;
	/** Same for the workers' total, or null when they cannot be measured. */
	retainedWorkerBytes: number | null;
	/** after.jsHeapBytes - before.jsHeapBytes (page). */
	retainedJsHeapBytes: number;
	/** Same for the page's backing stores, or null when the method cannot see them. */
	retainedBackingStoreBytes: number | null;
	/** Same for the page's embedder heap, or null when the method cannot see it. */
	retainedEmbedderHeapBytes: number | null;
}

export interface LoadRun {
	/** Generating the data set in the page (not part of any load time). */
	generateMs: number;
	/** First load in a fresh page: includes compiling the library's code. */
	cold: LoadTimings;
	/** Second load of the same data set in the same page, into a new chart. */
	warm: LoadTimings;
	memory: MemoryResult | null;
}

export interface TickRun {
	/** Duration of each `applyTick` call, all measured ticks. */
	sync: Distribution;
	/** Same, ticks that modify the last bar only. */
	syncUpdate: Distribution;
	/** Same, ticks that start a new bar only. */
	syncNewBar: Distribution;
	/** Mean per-tick sync cost of each round (round sync time / round size). */
	syncPerRound: Distribution;
	/**
	 * Wall time from the end of each round's last update call until `settle()` resolves: the latency
	 * until the round is painted. Includes waiting for the next frame (up to one refresh interval).
	 */
	settle: Distribution;
	/** JavaScript time in animation-frame callbacks during each round's `settle()`: the paint work. */
	settleJs: Distribution;
	/**
	 * Main-thread JavaScript per tick including the paint it causes, per round:
	 * (round sync time + round settleJs) / round size. Excludes idle time and work off the main thread.
	 */
	mainThreadPerTick: Distribution;
	/** Visible bars when measuring started. */
	visibleBars: number;
	/** Warm-up ticks applied (fewer than the job's when its warm-up budget ran out). */
	warmupTicks: number;
}

export interface FramesRun {
	/** JavaScript time spent in animation-frame callbacks, per frame. */
	jsTime: Distribution;
	/** Interval between consecutive frames' rAF timestamps. */
	interval: Distribution;
	/** Frames in which the library ran at least one animation-frame callback (expected: all). */
	framesWithLibraryWork: number;
	/** Visible bars at the start of the motion. */
	visibleBars: number;
	/** Warm-up frames dropped (fewer than the job's when its warm-up budget ran out). */
	warmupFrames: number;
	/**
	 * Canvas 2D calls in one redraw at the starting range, counted in a separate untimed pass after
	 * the measurement (the counting wrappers would slow the measured frames down). Shows how much the
	 * library draws, for example whether conflation merged bars. Empty for libraries that do not
	 * draw with Canvas 2D.
	 */
	drawCalls: Record<string, number>;
}

/** One prepend. All times start when `prepend` is called, except `prepareMs`. */
export interface PrependTimings {
	/** Building the batch in the library's input format (`preparePrepend`), before the call. */
	prepareMs: number;
	/** The synchronous `prepend` call. */
	callMs: number;
	/**
	 * Until the main thread has finished the first frame in which the library ran an animation-frame
	 * callback after the call. That frame does not necessarily show the new bars yet.
	 */
	firstFrameMs: number;
	/**
	 * Until `settle()`, called right after `prepend`, resolves: the bars are applied and the main
	 * thread has finished rendering the frame that shows them. This is the prepend-to-screen latency.
	 */
	shownMs: number;
	/** JavaScript time in animation-frame callbacks between the call and `shownMs`. */
	frameJsMs: number;
	/**
	 * Longest gap between the call, every frame that began before `shownMs`, and `shownMs`: how long
	 * the screen could not be updated (about one refresh interval when nothing blocks).
	 */
	longestFrameMs: number;
}

export interface PrependRun {
	/** The first prepend of the run, with code paths not yet compiled. Not part of the distributions. */
	cold: PrependTimings;
	/** Each field of `PrependTimings` over the measured prepends. */
	prepareMs: Distribution;
	callMs: Distribution;
	firstFrameMs: Distribution;
	shownMs: Distribution;
	frameJsMs: Distribution;
	longestFrameMs: Distribution;
	/** Bars in view while prepending. */
	visibleBars: number;
	/** Rows of the series after the last prepend: the base, the cold batch and the measured ones. */
	finalRows: number;
	/**
	 * Canvas 2D calls in one redraw, counted in untimed passes after the measurement: `shown` with
	 * the last batch in the left half of the view, `leftEmpty` at the new left edge with the left
	 * half empty. Shows that the prepended bars are drawn; empty for libraries without Canvas 2D.
	 */
	drawCalls: { shown: Record<string, number>; leftEmpty: Record<string, number> };
	/** Before the chart is created and after the last prepend: what the history and caches hold. */
	memory: MemoryResult | null;
}

export interface RefetchRun {
	/** The first jump, with code paths not yet compiled. Not part of the distributions. */
	coldShownMs: number;
	/** From `setVisibleLogicalRange` until `settle()` resolves with the region drawn. */
	shownMs: Distribution;
	/** Datafeed calls during one jump. */
	fetches: Distribution;
	/** Rows the datafeed returned during one jump. */
	fetchedRows: Distribution;
	/** Measured jumps that needed no fetch: their rows were still in memory. */
	jumpsWithoutFetch: number;
	visibleBars: number;
	memoryLimit: number;
	rows: number;
	/** Before the chart is created and once the library has let rows go, before the first jump. */
	memoryAfterLoad: MemoryResult | null;
	/** Before the chart is created and after the last jump. */
	memory: MemoryResult | null;
}

export type RunResult = LoadRun | TickRun | FramesRun | PrependRun | RefetchRun;

export type FailureReason = 'error' | 'timeout' | 'crash';

/** How busy the machine was during a run, measured by the runner. */
export interface HostLoad {
	/** Share of all cores' time that was idle during the run (0 to 1), including the browser's own use. */
	cpuIdle: number;
	/** One-minute load average at the end of the run. */
	loadAverage: number;
}

export type RunOutcome =
	| { readonly status: 'ok'; readonly result: RunResult; readonly durationMs: number; readonly host?: HostLoad }
	| {
			readonly status: 'failed';
			readonly reason: FailureReason;
			readonly message: string;
			readonly durationMs: number;
			readonly host?: HostLoad;
	  };

/** Library and options reported by an adapter. */
export interface AdapterInfo {
	library: { name: string; version: string };
	options: Record<string, unknown>;
}

/** What `bench.run` returns from the page. */
export type PageRunResult =
	| { readonly status: 'ok'; readonly adapter: AdapterInfo; readonly result: RunResult }
	| { readonly status: 'failed'; readonly adapter: AdapterInfo | null; readonly message: string };

// Matrix -------------------------------------------------------------------------------------------

export const K = 1_000;
export const M = 1_000_000;

export function sizeLabel(size: number): string {
	if (size >= M && size % M === 0) {
		return `${size / M}m`;
	}
	if (size >= K && size % K === 0) {
		return `${size / K}k`;
	}
	return String(size);
}

export function parseSize(label: string): number {
	const match = /^(\d+(?:\.\d+)?)([km]?)$/i.exec(label.trim());
	if (match === null) {
		throw new Error(`Invalid size "${label}" (expected for example 100k or 1m)`);
	}
	const unit = (match[2] ?? '').toLowerCase();
	const scale = unit === 'm' ? M : unit === 'k' ? K : 1;
	return Math.round(Number(match[1]) * scale);
}

export function datasetLabel(dataset: DatasetSpec): string {
	return `${dataset.kind}-${sizeLabel(dataset.size)}`;
}

/** Identifies a case: everything about a job except the adapter. */
export function caseId(job: Job): string {
	const base = `${job.scenario}/${datasetLabel(job.dataset)}`;
	switch (job.scenario) {
		case 'load':
			return base;
		case 'tick':
			return `${base}/${job.view}`;
		case 'frames':
			return `${base}/${job.motion}-${job.zoom === 'all' ? 'all' : sizeLabel(job.zoom)}`;
		case 'prepend':
			return `${base}/${sizeLabel(job.batch)}`;
		case 'refetch':
			return `${base}/${job.memoryLimit / 2 ** 20}mib`;
	}
}

/**
 * Whether case `id` is selected by `pattern`: every `/`-separated part of the pattern equals the
 * id's part at the same position, so `frames/line-10m` selects `frames/line-10m/pan-200` but
 * `frames/candles-1m/pan-200` does not select `frames/candles-1m/pan-2000`.
 */
export function matchesCase(id: string, pattern: string): boolean {
	const idParts = id.split('/');
	const parts = pattern.split('/').filter(part => part !== '');
	return parts.length > 0 && parts.length <= idParts.length && parts.every((part, i) => part === idParts[i]);
}

/** Why an adapter is left out of a data set in a scenario, or null to run it. */
export type SkipRule = (adapter: string, dataset: DatasetSpec, scenario: ScenarioName) => string | null;

export interface PlanOptions {
	scenarios: readonly ScenarioName[];
	adapters: readonly string[];
	/** Keep only data sets with one of these sizes (empty: all). */
	sizes: readonly number[];
	/** Keep only data sets of these kinds (empty: all). */
	kinds: readonly SeriesKind[];
	/** Keep only cases selected by one of these patterns (see `matchesCase`; empty or absent: all). */
	cases?: readonly string[];
	/** Leaves out adapter and data set pairs known to fail, for example a renderer that runs out of memory. */
	skip?: SkipRule;
	repeats: number;
	/** Small sizes and short runs that only check that everything works. */
	quick: boolean;
	chart: ChartSize;
	seed: number;
	/**
	 * Measuring time after which a tick or frames run stops early, once it has its minimum number of
	 * samples (default `DEFAULT_BUDGET_MS`). 0 measures every tick and frame. Fast libraries finish
	 * before the budget; it only shortens runs of slow ones, whose distribution is clear long before.
	 */
	budgetMs?: number;
}

export const DEFAULT_BUDGET_MS = 10_000;
/** Warm-up time limit of a run with a budget. */
const WARMUP_BUDGET_MS = 2_000;

/** `Omit` applied to each member of a union. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A job without its adapter. */
type JobCase = DistributiveOmit<Job, 'adapter'>;

export interface PlannedJob {
	readonly id: string;
	readonly caseId: string;
	readonly repeat: number;
	readonly job: Job;
}

/** A case an adapter is left out of, and why. */
export interface SkippedCase {
	readonly caseId: string;
	readonly adapter: string;
	readonly reason: string;
}

export interface Plan {
	readonly jobs: PlannedJob[];
	readonly skipped: SkippedCase[];
}

const LOAD_DATASETS: readonly DatasetSpec[] = [
	{ kind: 'candles', size: 100 * K },
	{ kind: 'candles', size: M },
	{ kind: 'line', size: M },
	{ kind: 'line', size: 10 * M },
];
const TICK_DATASETS: readonly DatasetSpec[] = [
	{ kind: 'candles', size: 10 * K },
	{ kind: 'candles', size: 100 * K },
	{ kind: 'candles', size: 300 * K },
	{ kind: 'candles', size: M },
];
const TICK_VIEWS: readonly TickView[] = ['latest', 'all'];
// 10M line points are the data set of the stage 2 gate (design section 9).
const FRAME_DATASETS: readonly DatasetSpec[] = [
	{ kind: 'candles', size: M },
	{ kind: 'line', size: 10 * M },
];
// Levels at or above the data set size are left out, so 2M only applies to 10M points.
const FRAME_ZOOMS: readonly ZoomLevel[] = [200, 2_000, 20_000, 200_000, 2 * M, 'all'];
const MOTIONS: readonly Motion[] = ['pan', 'zoom'];
const PREPEND_DATASETS: readonly DatasetSpec[] = [
	{ kind: 'candles', size: M },
	{ kind: 'line', size: 10 * M },
];

interface PrependBatch {
	readonly batch: number;
	readonly prepends: number;
	readonly minPrepends: number;
}

// 10k: a page of history as a datafeed delivers it while the user scrolls. 1M: a bulk load, where
// the cost proportional to the batch shows. Every measured 1M prepend adds 1M rows, hence fewer.
const PREPEND_BATCHES: readonly PrependBatch[] = [
	{ batch: 10 * K, prepends: 20, minPrepends: 5 },
	{ batch: M, prepends: 5, minPrepends: 3 },
];

// The stage 2 gate's data set. 128 MiB is below what 10M points take with their levels (about
// 185 MiB), so most of the old history is let go before the first jump.
const REFETCH_CASES: readonly { dataset: DatasetSpec; memoryLimit: number }[] = [
	{ dataset: { kind: 'line', size: 10 * M }, memoryLimit: 128 * 2 ** 20 },
];
const QUICK_REFETCH_CASES: readonly { dataset: DatasetSpec; memoryLimit: number }[] = [
	{ dataset: { kind: 'line', size: 100 * K }, memoryLimit: 1.5 * 2 ** 20 },
];

const QUICK_LOAD_DATASETS: readonly DatasetSpec[] = [
	{ kind: 'candles', size: 10 * K },
	{ kind: 'line', size: 10 * K },
];
const QUICK_TICK_DATASETS: readonly DatasetSpec[] = [{ kind: 'candles', size: 10 * K }];
const QUICK_FRAME_DATASETS: readonly DatasetSpec[] = [
	{ kind: 'candles', size: 10 * K },
	{ kind: 'line', size: 10 * K },
];
const QUICK_FRAME_ZOOMS: readonly ZoomLevel[] = [200, 'all'];
const QUICK_PREPEND_DATASETS: readonly DatasetSpec[] = QUICK_FRAME_DATASETS;
const QUICK_PREPEND_BATCHES: readonly PrependBatch[] = [{ batch: K, prepends: 3, minPrepends: 2 }];

/**
 * Builds the job list. Cases run one after another; within a case the repeats run in order and
 * each repeat runs every adapter back to back, so slow drift of the machine affects all adapters
 * alike.
 */
export function planJobs(options: PlanOptions): Plan {
	const { quick, chart, seed } = options;
	const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
	const warmupBudgetMs = budgetMs > 0 ? Math.min(WARMUP_BUDGET_MS, budgetMs) : 0;
	const keep = (dataset: DatasetSpec): boolean =>
		(options.sizes.length === 0 || options.sizes.includes(dataset.size)) &&
		(options.kinds.length === 0 || options.kinds.includes(dataset.kind));
	const cases: JobCase[] = [];

	if (options.scenarios.includes('load')) {
		for (const dataset of (quick ? QUICK_LOAD_DATASETS : LOAD_DATASETS).filter(keep)) {
			cases.push({ scenario: 'load', dataset, seed, chart });
		}
	}
	if (options.scenarios.includes('tick')) {
		for (const dataset of (quick ? QUICK_TICK_DATASETS : TICK_DATASETS).filter(keep)) {
			for (const view of TICK_VIEWS) {
				cases.push({
					scenario: 'tick',
					dataset,
					seed,
					chart,
					view,
					ticks: quick ? 1_000 : 10_000,
					minTicks: quick ? 200 : 500,
					budgetMs,
					warmupTicks: quick ? 100 : 500,
					warmupBudgetMs,
					roundSize: 100,
					newBarEvery: 10,
				});
			}
		}
	}
	if (options.scenarios.includes('frames')) {
		for (const dataset of (quick ? QUICK_FRAME_DATASETS : FRAME_DATASETS).filter(keep)) {
			for (const zoom of quick ? QUICK_FRAME_ZOOMS : FRAME_ZOOMS) {
				if (zoom !== 'all' && zoom >= dataset.size) {
					continue;
				}
				for (const motion of MOTIONS) {
					cases.push({
						scenario: 'frames',
						dataset,
						seed,
						chart,
						zoom,
						motion,
						frames: quick ? 60 : 300,
						minFrames: quick ? 20 : 30,
						budgetMs,
						warmupFrames: quick ? 10 : 30,
						warmupBudgetMs,
					});
				}
			}
		}
	}
	if (options.scenarios.includes('prepend')) {
		for (const dataset of (quick ? QUICK_PREPEND_DATASETS : PREPEND_DATASETS).filter(keep)) {
			for (const { batch, prepends, minPrepends } of quick ? QUICK_PREPEND_BATCHES : PREPEND_BATCHES) {
				cases.push({
					scenario: 'prepend',
					dataset,
					seed,
					chart,
					batch,
					// A view wider than the data cannot be shown: lumen stops zooming out where all of it fits.
					visibleBars: Math.min(2 * batch, dataset.size),
					prepends,
					minPrepends,
					budgetMs,
				});
			}
		}
	}

	if (options.scenarios.includes('refetch')) {
		for (const { dataset, memoryLimit } of quick ? QUICK_REFETCH_CASES : REFETCH_CASES) {
			if (keep(dataset)) {
				cases.push({
					scenario: 'refetch',
					dataset,
					seed,
					chart,
					memoryLimit,
					visibleBars: 2_000,
					jumps: quick ? 3 : 20,
					minJumps: quick ? 2 : 5,
					budgetMs,
				});
			}
		}
	}

	const patterns = options.cases ?? [];
	const jobs: PlannedJob[] = [];
	const skipped: SkippedCase[] = [];
	for (const c of cases) {
		const id = caseId({ ...c, adapter: '' });
		if (patterns.length > 0 && !patterns.some(pattern => matchesCase(id, pattern))) {
			continue;
		}
		const adapters: string[] = [];
		for (const adapter of options.adapters) {
			const reason = options.skip?.(adapter, c.dataset, c.scenario) ?? null;
			if (reason === null) {
				adapters.push(adapter);
			} else {
				skipped.push({ caseId: id, adapter, reason });
			}
		}
		for (let repeat = 0; repeat < options.repeats; repeat++) {
			for (const adapter of adapters) {
				const job: Job = { ...c, adapter };
				jobs.push({ id: `${id}/${adapter}#${repeat + 1}`, caseId: id, repeat, job });
			}
		}
	}
	return { jobs, skipped };
}
