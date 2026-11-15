// Jobs the harness page runs, their results, and the default benchmark matrix.
// Shared by the page and the Node runner, so this module must stay free of DOM and Node APIs.

import type { ChartSize } from './adapter.ts';
import type { SeriesKind } from './data.ts';
import type { Distribution } from './stats.ts';

export type ScenarioName = 'load' | 'tick' | 'frames';
export const SCENARIOS: readonly ScenarioName[] = ['load', 'tick', 'frames'];

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
	/** Measured ticks. */
	readonly ticks: number;
	/** Ticks applied before measuring, taken from the same stream. */
	readonly warmupTicks: number;
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
	/** Measured frames. */
	readonly frames: number;
	readonly warmupFrames: number;
}

export type Job = LoadJob | TickJob | FramesJob;

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

export interface MemorySample {
	/** How the numbers were obtained. */
	method: string;
	/** V8 heap in use (JavaScript objects). */
	jsHeapBytes: number;
	/** ArrayBuffer backing stores and external strings, or null when the method cannot see them. */
	backingStoreBytes: number | null;
	/** Blink's heap (DOM and other embedder objects), or null when the method cannot see it. */
	embedderHeapBytes: number | null;
	/** Sum of the parts above that are known. */
	totalBytes: number;
}

export interface MemoryResult {
	/** Before the measured chart is created, data already generated, after a full GC. */
	before: MemorySample;
	/** After the measured load has settled, after a full GC. */
	after: MemorySample;
	/** after.totalBytes - before.totalBytes: what the chart retains. */
	retainedBytes: number;
	/** after.jsHeapBytes - before.jsHeapBytes. */
	retainedJsHeapBytes: number;
	/** Same for backing stores, or null when the method cannot see them. */
	retainedBackingStoreBytes: number | null;
	/** Same for the embedder heap, or null when the method cannot see it. */
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
	/**
	 * Canvas 2D calls in one redraw at the starting range, counted in a separate untimed pass after
	 * the measurement (the counting wrappers would slow the measured frames down). Shows how much the
	 * library draws, for example whether conflation merged bars. Empty for libraries that do not
	 * draw with Canvas 2D.
	 */
	drawCalls: Record<string, number>;
}

export type RunResult = LoadRun | TickRun | FramesRun;

export type FailureReason = 'error' | 'timeout' | 'crash';

export type RunOutcome =
	| { readonly status: 'ok'; readonly result: RunResult; readonly durationMs: number }
	| {
			readonly status: 'failed';
			readonly reason: FailureReason;
			readonly message: string;
			readonly durationMs: number;
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
	}
}

export interface PlanOptions {
	scenarios: readonly ScenarioName[];
	adapters: readonly string[];
	/** Keep only data sets with one of these sizes (empty: all). */
	sizes: readonly number[];
	/** Keep only data sets of these kinds (empty: all). */
	kinds: readonly SeriesKind[];
	repeats: number;
	/** Small sizes and short runs that only check that everything works. */
	quick: boolean;
	chart: ChartSize;
	seed: number;
}

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
const FRAME_DATASETS: readonly DatasetSpec[] = [{ kind: 'candles', size: M }];
const FRAME_ZOOMS: readonly ZoomLevel[] = [200, 2_000, 20_000, 200_000, 'all'];
const MOTIONS: readonly Motion[] = ['pan', 'zoom'];

const QUICK_LOAD_DATASETS: readonly DatasetSpec[] = [
	{ kind: 'candles', size: 10 * K },
	{ kind: 'line', size: 10 * K },
];
const QUICK_TICK_DATASETS: readonly DatasetSpec[] = [{ kind: 'candles', size: 10 * K }];
const QUICK_FRAME_DATASETS: readonly DatasetSpec[] = [{ kind: 'candles', size: 10 * K }];
const QUICK_FRAME_ZOOMS: readonly ZoomLevel[] = [200, 'all'];

/**
 * Builds the job list. Cases run one after another; within a case the repeats run in order and
 * each repeat runs every adapter back to back, so slow drift of the machine affects all adapters
 * alike.
 */
export function planJobs(options: PlanOptions): PlannedJob[] {
	const { quick, chart, seed } = options;
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
					warmupTicks: quick ? 100 : 500,
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
						warmupFrames: quick ? 10 : 30,
					});
				}
			}
		}
	}

	const planned: PlannedJob[] = [];
	for (const c of cases) {
		for (let repeat = 0; repeat < options.repeats; repeat++) {
			for (const adapter of options.adapters) {
				const job: Job = { ...c, adapter };
				const id = caseId(job);
				planned.push({ id: `${id}/${adapter}#${repeat + 1}`, caseId: id, repeat, job });
			}
		}
	}
	return planned;
}
