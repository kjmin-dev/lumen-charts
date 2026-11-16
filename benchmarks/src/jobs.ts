// Jobs the harness page runs and their results, as the code shared by every scenario sees them. What
// a scenario adds (its parameters, its result, its part of the matrix) is in its module in
// `scenarios/`. Shared by the page and the Node runner, so this module must stay free of DOM and
// Node APIs.

import type { ChartSize } from './adapter.ts';
import type { SeriesKind } from './data.ts';

/** Name of a scenario: one of those found in `scenarios/` (see `scenarios/index.ts`). */
export type ScenarioName = string;

export interface DatasetSpec {
	readonly kind: SeriesKind;
	readonly size: number;
}

/** What every job has. A scenario's job type extends it with the scenario's name and parameters. */
export interface JobBase {
	/** Adapter id from the registry. */
	readonly adapter: string;
	readonly dataset: DatasetSpec;
	/** Seed of the data set. Ticks use `seed + 1`. */
	readonly seed: number;
	readonly chart: ChartSize;
}

/** A job of any scenario. The scenario's module knows its parameters. */
export interface Job extends JobBase {
	readonly scenario: ScenarioName;
}

/** A job without its adapter: a case of the matrix. */
export type JobCase<J extends Job = Job> = Omit<J, 'adapter'>;

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

/**
 * Time the page's main thread spent, from the browser's own counters (CDP `Performance.getMetrics`).
 * Unlike the frame probe it counts everything: message and observer callbacks, layout and style.
 */
export interface MainThreadTimes {
	/** All tasks of the main thread. */
	taskMs: number;
	/** JavaScript, wherever it ran. */
	scriptMs: number;
	/** Layout, including layouts forced by a script reading the layout. */
	layoutMs: number;
	/** Style recalculation. */
	styleMs: number;
}

/** What a run of a scenario measured: an object of numbers, distributions and objects of them. */
export type RunResult = object;

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
	/**
	 * Worker limits to run the multi-chart scenario with, one case each (see `MultiJob.maxWorkers`;
	 * default: the library's own limit only).
	 */
	maxWorkers?: readonly (number | null)[];
}

export const DEFAULT_BUDGET_MS = 10_000;
/** Warm-up time limit of a run with a budget. */
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
