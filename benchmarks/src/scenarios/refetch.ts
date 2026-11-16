// A series with a datafeed under a memory limit: jumps to history the library let go, and
// corrections, deletions and a change of resolution on it.

import { type ChartAdapter, supports } from '../adapter.ts';
import { type LineColumns, type SeriesColumns, generateSeries } from '../data.ts';
import { mb, ms } from '../format.ts';
import { libraryFrameRuns } from '../harness/frames.ts';
import { createSettled, delay, overBudget, prepare } from '../harness/steps.ts';
import {
	type DatasetSpec,
	type JobBase,
	type JobCase,
	K,
	M,
	type MemoryResult,
	datasetLabel,
	sizeLabel,
} from '../jobs.ts';
import { memoryResult } from '../memory.ts';
import {
	MIB,
	MS,
	type Report,
	adaptersOf,
	caseIds,
	casesOf,
	cell,
	eachCase,
	find,
	hostIdle,
	number,
	table,
} from '../report.ts';
import { type RunContext, defineScenario } from '../scenario.ts';
import { type Distribution, summarize } from '../stats.ts';

/** Returns the rows with times in `[from, to]`. */
export type Datafeed = (from: number, to: number) => SeriesColumns;

/** A library that can fetch history again from a datafeed. `TPrepared` is the adapter's prepared data. */
export interface DatafeedAdapter<TPrepared = unknown> {
	/**
	 * Like `setData`, with a datafeed the library may fetch bars from again and a memory limit in
	 * bytes it may let bars go past.
	 */
	setDataWithDatafeed(data: TPrepared, datafeed: Datafeed, memoryLimit: number): void;
}

/** For the `several` variant. */
export interface SeveralDatafeedsAdapter<TPrepared = unknown> {
	/** Adds another line series on the same chart, with a datafeed or (null) without one. */
	addSeriesWithDatafeed(data: TPrepared, datafeed: Datafeed | null): void;
}

/** For the `ops` variant. */
export interface HistoryOperationsAdapter<TPrepared = unknown> {
	/** Replaces the history of the series with a datafeed, and the datafeed, as a change of resolution does. */
	reloadWithDatafeed(data: TPrepared, datafeed: Datafeed): void;
	/** Sets the value of the line point at `time`, which may be any existing one. */
	correctBar(time: number, value: number): void;
	/** Removes the bars with times in `[from, to]`. */
	removeBars(from: number, to: number): void;
}

/**
 * What a refetch case runs. `jumps`: one series with a datafeed, and the jumps. `several`: the same
 * series, a second one with a datafeed on the same times and a third without one over the last
 * tenth of them, and the jumps. `ops`: one series with a datafeed, a few jumps, then timed
 * corrections, deletions and a change of resolution.
 */
export type RefetchVariant = 'jumps' | 'several' | 'ops';

/**
 * A series with a datafeed under a memory limit, for libraries that can fetch history again. Once
 * the library has let rows go, the view jumps from one region of old history to the next at a
 * zoom that shows single bars, so a jump that lands on rows let go makes the library fetch them
 * from the datafeed. The datafeed is in the page and answers at once, so the latency is the
 * library's own.
 */
export interface RefetchJob extends JobBase {
	readonly scenario: 'refetch';
	readonly variant: RefetchVariant;
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

/** Operations on history let go, each timed from the call until `settle()` resolves. */
export interface RefetchOperations {
	/** Correcting a bar in view, which is in memory. */
	correctHeldMs: Distribution;
	/** Correcting a bar far from the view, which was let go: its bars are fetched again first. */
	correctLetGoMs: Distribution;
	/** Removing 10 bars in the middle of history let go, which moves the bars on one side. */
	removeMs: Distribution;
	/** Switching to 5-minute bars: a new history of a fifth of the bars, with a datafeed for them. */
	resolutionMs: number;
	/** Calls of the old datafeed after the switch (none expected). */
	staleFetches: number;
}

export interface RefetchRun {
	/** The first jump, with code paths not yet compiled. Not part of the distributions. */
	coldShownMs: number;
	/** From `setVisibleLogicalRange` until `settle()` resolves with the region drawn. */
	shownMs: Distribution;
	/** Animation frames the library ran during a jump, up to the one that shows the region. */
	shownFrames: Distribution;
	/** Datafeed calls during one jump. */
	fetches: Distribution;
	/** Rows the datafeed returned during one jump. */
	fetchedRows: Distribution;
	/** Measured jumps that needed no fetch: their rows were still in memory. */
	jumpsWithoutFetch: number;
	visibleBars: number;
	memoryLimit: number;
	rows: number;
	/** Series on the chart. */
	series: number;
	/** Before the chart is created and once the library has let rows go, before the first jump. */
	memoryAfterLoad: MemoryResult | null;
	/** Before the chart is created and after the last jump. */
	memory: MemoryResult | null;
	/** The `ops` variant only. */
	operations: RefetchOperations | null;
}

interface RefetchCase {
	readonly dataset: DatasetSpec;
	readonly memoryLimit: number;
	readonly variant: RefetchVariant;
}

// The stage 2 gate's data set. 128 MiB is below what 10M points take with their levels (about
// 185 MiB), so most of the old history is let go before the first jump. 1 MiB is below anything a
// library can keep, so what it holds then is its floor. Three series at 256 MiB: the two with a
// datafeed take about 370 MiB with their levels.
const REFETCH_CASES: readonly RefetchCase[] = [
	{ dataset: { kind: 'line', size: 10 * M }, memoryLimit: 128 * 2 ** 20, variant: 'jumps' },
	{ dataset: { kind: 'line', size: 10 * M }, memoryLimit: 2 ** 20, variant: 'jumps' },
	{ dataset: { kind: 'line', size: 10 * M }, memoryLimit: 256 * 2 ** 20, variant: 'several' },
	{ dataset: { kind: 'line', size: 10 * M }, memoryLimit: 128 * 2 ** 20, variant: 'ops' },
];
const QUICK_REFETCH_CASES: readonly RefetchCase[] = [
	{ dataset: { kind: 'line', size: 100 * K }, memoryLimit: 1.5 * 2 ** 20, variant: 'jumps' },
	{ dataset: { kind: 'line', size: 100 * K }, memoryLimit: 3 * 2 ** 20, variant: 'several' },
	{ dataset: { kind: 'line', size: 100 * K }, memoryLimit: 1.5 * 2 ** 20, variant: 'ops' },
];

/** First position in sorted `time` whose value is not below `target`. */
function lowerBound(time: Float64Array, target: number): number {
	let lo = 0;
	let hi = time.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (time[mid]! < target) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo;
}

/** Rows `[from, to)` of a data set, as views on its columns. */
function sliceRows(data: SeriesColumns, from: number, to: number): SeriesColumns {
	const length = to - from;
	if (data.kind === 'line') {
		return { kind: 'line', length, time: data.time.subarray(from, to), value: data.value.subarray(from, to) };
	}
	return {
		kind: 'candles',
		length,
		time: data.time.subarray(from, to),
		open: data.open.subarray(from, to),
		high: data.high.subarray(from, to),
		low: data.low.subarray(from, to),
		close: data.close.subarray(from, to),
		volume: data.volume.subarray(from, to),
	};
}

/** A datafeed over a data set held by the page, like a server holds it, that can change as one does. */
class Source {
	public fetches = 0;
	public fetchedRows = 0;
	/** Values set at the source, by time. */
	public readonly corrected = new Map<number, number>();
	/** Times of bars removed at the source, as `[from, to]` pairs. */
	public readonly removed: number[] = [];
	public readonly data: LineColumns;

	public constructor(data: LineColumns) {
		this.data = data;
	}

	public readonly feed = (from: number, to: number): SeriesColumns => {
		const lo = lowerBound(this.data.time, from);
		const hi = lowerBound(this.data.time, to + 1);
		this.fetches++;
		let rows = sliceRows(this.data, lo, hi) as LineColumns;
		if (this.removed.length > 0 || this.corrected.size > 0) {
			const time: number[] = [];
			const value: number[] = [];
			for (let i = 0; i < rows.length; i++) {
				const t = rows.time[i]!;
				let gone = false;
				for (let r = 0; r < this.removed.length; r += 2) {
					gone ||= t >= this.removed[r]! && t <= this.removed[r + 1]!;
				}
				if (!gone) {
					time.push(t);
					value.push(this.corrected.get(t) ?? rows.value[i]!);
				}
			}
			rows = { kind: 'line', length: time.length, time: Float64Array.from(time), value: Float64Array.from(value) };
		}
		this.fetchedRows += rows.length;
		return rows;
	};
}

/** The same times with other values, for a second series. */
function shifted(data: LineColumns, from: number, scale: number): LineColumns {
	const time = data.time.subarray(from);
	const value = new Float64Array(time.length);
	for (let i = 0; i < time.length; i++) {
		value[i] = data.value[from + i]! * scale + 10;
	}
	return { kind: 'line', length: time.length, time, value };
}

/** Every `step`-th bar: a coarser resolution of the same history. */
function coarser(data: LineColumns, step: number): LineColumns {
	const length = Math.floor(data.length / step);
	const time = new Float64Array(length);
	const value = new Float64Array(length);
	for (let i = 0; i < length; i++) {
		time[i] = data.time[i * step]!;
		value[i] = data.value[i * step]!;
	}
	return { kind: 'line', length, time, value };
}

async function runRefetch(job: RefetchJob, { factory, container, probes }: RunContext): Promise<RefetchRun> {
	const data = generateSeries(job.dataset.kind, { seed: job.seed, count: job.dataset.size });
	if (data.kind !== 'line') {
		throw new Error('The refetch scenario runs on line points');
	}
	const several = job.variant === 'several';
	const main = new Source(data);
	const second = several ? new Source(shifted(data, 0, 0.5)) : null;
	const third = several ? shifted(data, Math.floor(data.length * 0.9), 2) : null;
	await probes.collectGarbage();
	const before = await probes.measureMemory();
	const adapter = await createSettled(factory, container, job.chart);
	try {
		if (!supports<DatafeedAdapter>(adapter, 'setDataWithDatafeed')) {
			throw new Error('This library cannot fetch history again from a datafeed');
		}
		adapter.setDataWithDatafeed(prepare(adapter, data), main.feed, job.memoryLimit);
		if (second !== null && third !== null) {
			if (!supports<SeveralDatafeedsAdapter>(adapter, 'addSeriesWithDatafeed')) {
				throw new Error('This library cannot draw several series with datafeeds');
			}
			adapter.addSeriesWithDatafeed(prepare(adapter, second.data), second.feed);
			adapter.addSeriesWithDatafeed(prepare(adapter, third), null);
		}
		await adapter.settle();
		// Untimed: the library summarizes the history and lets rows go in the background.
		await delay(several ? 3000 : 1500);
		await adapter.settle();
		await probes.collectGarbage();
		const loaded = await probes.measureMemory();

		const n = data.length;
		const half = job.visibleBars / 2;
		const fetched = (): { fetches: number; rows: number } => ({
			fetches: main.fetches + (second?.fetches ?? 0),
			rows: main.fetchedRows + (second?.fetchedRows ?? 0),
		});
		// Regions spread over the oldest 90% of the history, far enough apart that no jump lands in
		// rows the previous one brought back.
		const step = Math.floor((n * 0.9) / (job.jumps + 1));
		interface Jump {
			shownMs: number;
			frames: number;
			fetches: number;
			fetchedRows: number;
		}
		const jump = async (index: number): Promise<Jump> => {
			const center = Math.floor(n * 0.02) + index * step;
			const f0 = fetched();
			const runs = libraryFrameRuns();
			const t0 = performance.now();
			adapter.setVisibleLogicalRange({ from: center - half, to: center + half - 1 });
			await adapter.settle();
			const shownMs = performance.now() - t0;
			const f1 = fetched();
			return {
				shownMs,
				frames: libraryFrameRuns() - runs,
				fetches: f1.fetches - f0.fetches,
				fetchedRows: f1.rows - f0.rows,
			};
		};
		const cold = await jump(0);
		const samples: Jump[] = [];
		const measureStart = performance.now();
		while (samples.length < job.jumps) {
			samples.push(await jump(samples.length + 1));
			if (samples.length >= job.minJumps && overBudget(measureStart, job.budgetMs)) {
				break;
			}
		}
		await probes.collectGarbage();
		const after = await probes.measureMemory();
		const operations = job.variant === 'ops' ? await runOperations(adapter, main, data, samples.length) : null;
		return {
			coldShownMs: cold.shownMs,
			shownMs: summarize(samples.map(sample => sample.shownMs)),
			shownFrames: summarize(samples.map(sample => sample.frames)),
			fetches: summarize(samples.map(sample => sample.fetches)),
			fetchedRows: summarize(samples.map(sample => sample.fetchedRows)),
			jumpsWithoutFetch: samples.filter(sample => sample.fetches === 0).length,
			visibleBars: job.visibleBars,
			memoryLimit: job.memoryLimit,
			rows: n,
			series: several ? 3 : 1,
			memoryAfterLoad: memoryResult(before, loaded),
			memory: memoryResult(before, after),
			operations,
		};
	} finally {
		adapter.destroy();
	}
}

/**
 * Corrections, deletions and a change of resolution on a series whose history was mostly let go,
 * each timed from the call until the chart has settled. The source changes first, as it would.
 */
async function runOperations(
	adapter: ChartAdapter,
	source: Source,
	data: LineColumns,
	jumps: number,
): Promise<RefetchOperations> {
	if (!supports<HistoryOperationsAdapter>(adapter, 'correctBar', 'removeBars', 'reloadWithDatafeed')) {
		throw new Error('This library cannot correct or remove bars, or change resolution');
	}
	const n = data.length;
	const timed = async (action: () => void): Promise<number> => {
		const t0 = performance.now();
		action();
		await adapter.settle();
		return performance.now() - t0;
	};
	// The view is at the region of the last jump.
	const step = Math.floor((n * 0.9) / (jumps + 1));
	const inView = Math.floor(n * 0.02) + jumps * step;
	const held: number[] = [];
	const letGo: number[] = [];
	for (let k = 0; k < 5; k++) {
		const heldAt = inView - 500 + k * 200;
		const heldTime = data.time[heldAt]!;
		source.corrected.set(heldTime, 1);
		held.push(await timed(() => adapter.correctBar(heldTime, 1)));
		// Far from the view: history let go.
		const far = Math.floor(n * (0.07 + k * 0.17));
		const farTime = data.time[far]!;
		source.corrected.set(farTime, 2);
		letGo.push(await timed(() => adapter.correctBar(farTime, 2)));
	}
	const removes: number[] = [];
	for (const at of [0.15, 0.5, 0.8]) {
		const index = Math.floor(n * at);
		const from = data.time[index]!;
		const to = data.time[index + 9]!;
		source.removed.push(from, to);
		removes.push(await timed(() => adapter.removeBars(from, to)));
	}
	// Five-minute bars from a datafeed that serves them.
	const five = new Source(coarser(data, 5));
	const prepared = adapter.prepareLine(five.data);
	const fetchesBefore = source.fetches;
	const resolutionMs = await timed(() => adapter.reloadWithDatafeed(prepared, five.feed));

	await delay(500);
	await adapter.settle();
	return {
		correctHeldMs: summarize(held),
		correctLetGoMs: summarize(letGo),
		removeMs: summarize(removes),
		resolutionMs,
		staleFetches: source.fetches - fetchesBefore,
	};
}

function refetchSection(report: Report): string {
	const rows: string[][] = [];
	for (const c of eachCase<RefetchJob>(report, 'refetch')) {
		const { adapter } = c;
		rows.push([
			`${datasetLabel(c.job.dataset)}, limit ${number(c.job.memoryLimit * MIB)} MiB, ${sizeLabel(c.job.visibleBars)} in view, ${c.job.variant ?? 'jumps'}`,
			adapter,
			cell(c, 'shownMs.p50', MS),
			cell(c, 'shownMs.p95', MS),
			cell(c, 'shownMs.max', MS),
			cell(c, 'shownFrames.p50'),
			cell(c, 'shownFrames.max'),
			cell(c, 'coldShownMs', MS),
			cell(c, 'fetches.p50'),
			cell(c, 'fetchedRows.p50'),
			cell(c, 'jumpsWithoutFetch'),
			cell(c, 'shownMs.count'),
			cell(c, 'memoryAfterLoad.retainedBytes', MIB),
			cell(c, 'memoryAfterLoad.retainedPageBytes', MIB),
			cell(c, 'memoryAfterLoad.retainedWorkerBytes', MIB),
			cell(c, 'memory.retainedBytes', MIB),
			cell(c, 'memory.retainedPageBytes', MIB),
			cell(c, 'memory.retainedWorkerBytes', MIB),
			hostIdle(c),
		]);
	}
	return table(
		[
			'Case',
			'Adapter',
			'Shown p50 (ms)',
			'Shown p95 (ms)',
			'Shown max (ms)',
			'Frames p50',
			'Frames max',
			'Cold shown (ms)',
			'Fetches per jump p50',
			'Rows fetched per jump p50',
			'Jumps without fetch',
			'Jumps',
			'Retained after load (MiB)',
			'Page (MiB)',
			'Workers (MiB)',
			'Retained after jumps (MiB)',
			'Page (MiB)',
			'Workers (MiB)',
			'CPU idle',
		],
		rows,
	);
}

function operationsSection(report: Report): string {
	const list = casesOf<RefetchJob>(report, 'refetch').filter(c => c.job.variant === 'ops');
	const rows: string[][] = [];
	for (const id of caseIds(report, 'refetch')) {
		for (const adapter of adaptersOf(list)) {
			const c = find<RefetchJob>(report, id, adapter);
			if (c === undefined || c.job.variant !== 'ops') {
				continue;
			}
			rows.push([
				`${datasetLabel(c.job.dataset)}, limit ${number(c.job.memoryLimit * MIB)} MiB`,
				adapter,
				cell(c, 'operations.correctHeldMs.p50', MS),
				cell(c, 'operations.correctLetGoMs.p50', MS),
				cell(c, 'operations.correctLetGoMs.max', MS),
				cell(c, 'operations.removeMs.p50', MS),
				cell(c, 'operations.removeMs.max', MS),
				cell(c, 'operations.resolutionMs', MS),
				cell(c, 'operations.staleFetches'),
				hostIdle(c),
			]);
		}
	}
	return table(
		[
			'Case',
			'Adapter',
			'Correct held p50 (ms)',
			'Correct let go p50 (ms)',
			'Correct let go max (ms)',
			'Remove 10 p50 (ms)',
			'Remove 10 max (ms)',
			'Resolution change (ms)',
			'Old datafeed calls after',
			'CPU idle',
		],
		rows,
	);
}

export const refetch = defineScenario<RefetchJob, RefetchRun>({
	name: 'refetch',
	order: 50,
	requires: { capability: 'datafeed', reason: 'the library cannot fetch history again from a datafeed' },
	plan({ quick, chart, seed, budgetMs, keep }) {
		const cases: JobCase<RefetchJob>[] = [];
		for (const { dataset, memoryLimit, variant } of quick ? QUICK_REFETCH_CASES : REFETCH_CASES) {
			if (keep(dataset)) {
				const ops = variant === 'ops';
				cases.push({
					scenario: 'refetch',
					variant,
					dataset,
					seed,
					chart,
					memoryLimit,
					visibleBars: 2_000,
					jumps: quick || ops ? 3 : 20,
					minJumps: quick || ops ? 2 : 5,
					budgetMs,
				});
			}
		}
		return cases;
	},
	caseParts: job => [`${job.memoryLimit / 2 ** 20}mib`, job.variant],
	run: runRefetch,
	headline(m) {
		return (
			`shown p50 ${ms(m('shownMs.p50'))} p95 ${ms(m('shownMs.p95'))} max ${ms(m('shownMs.max'))} ` +
			`(frames p50 ${m('shownFrames.p50') ?? '–'}); ` +
			`fetches per jump p50 ${m('fetches.p50') ?? '–'}; retained after load ${mb(m('memoryAfterLoad.retainedBytes'))}, ` +
			`after the jumps ${mb(m('memory.retainedBytes'))}` +
			(m('operations.resolutionMs') === undefined
				? ''
				: `; correct let go p50 ${ms(m('operations.correctLetGoMs.p50'))}, remove p50 ${ms(m('operations.removeMs.p50'))}, ` +
					`resolution ${ms(m('operations.resolutionMs'))}`)
		);
	},
	sections: [
		{ title: 'Refetch under a memory limit', render: refetchSection },
		// After the section of the multi-chart scenario, where it has always been.
		{ title: 'Operations on history let go', order: 115, render: operationsSection },
	],
});
