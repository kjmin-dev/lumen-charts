// Older history added before the first bar, batch after batch.

import type { ChartAdapter } from '../adapter.ts';
import { DEFAULT_INTERVAL_MS, type SeriesColumns, generateSeries } from '../data.ts';
import { mb, ms } from '../format.ts';
import { afterLibraryFrame, frameJsTotal, libraryFrameRuns, recordFrameTimes } from '../harness/frames.ts';
import { markMeasured } from '../harness/marks.ts';
import { countRedraw, createSettled, overBudget, prepare } from '../harness/steps.ts';
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
	MS,
	type Report,
	casesOf,
	cell,
	eachCase,
	hostIdle,
	median,
	memoryTable,
	number,
	runsNote,
	seriesCall,
	table,
} from '../report.ts';
import type { CaseResult } from '../results.ts';
import { type Metric, type RunContext, defineScenario } from '../scenario.ts';
import { type Distribution, summarize } from '../stats.ts';
import { QUICK_FRAME_DATASETS } from './frames.ts';
import type { ChartSetup } from './load.ts';

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

/** The parameters of a prepend run, for the scenarios that run it on a chart set up their way. */
export type PrependParams = Omit<PrependJob, 'scenario'>;

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

const PREPEND_DATASETS: readonly DatasetSpec[] = [
	{ kind: 'candles', size: M },
	{ kind: 'line', size: 10 * M },
];

export interface PrependBatch {
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
const QUICK_PREPEND_DATASETS: readonly DatasetSpec[] = QUICK_FRAME_DATASETS;
export const QUICK_PREPEND_BATCHES: readonly PrependBatch[] = [{ batch: K, prepends: 3, minPrepends: 2 }];

/** Prepends `batch` and times it until the frame that shows it. The view is already set. */
async function measurePrepend(adapter: ChartAdapter, batch: SeriesColumns): Promise<PrependTimings> {
	const t0 = performance.now();
	const prepared = adapter.preparePrepend(batch);
	const t1 = performance.now();
	const runs = libraryFrameRuns();
	const js = frameJsTotal();
	const frames = recordFrameTimes();
	// Watched alongside `settle()` rather than awaited before it: `settle()` must start right after
	// the call, or a library that applies data synchronously would be timed a frame late.
	let firstFrame = Number.NaN;
	const firstFrameSeen = afterLibraryFrame(runs).then(
		() => {
			firstFrame = performance.now();
		},
		// Only reached when the chart never draws, which fails the run below anyway.
		() => undefined,
	);
	adapter.prepend(prepared);
	const t2 = performance.now();
	await adapter.settle();
	const t3 = performance.now();
	const frameJsMs = frameJsTotal() - js;
	const stamps = frames.stop();
	if (libraryFrameRuns() === runs) {
		// Every prepend in this scenario reaches the screen, so a chart that did not draw lost the data.
		throw new Error('The chart settled without drawing after prepend');
	}
	await firstFrameSeen;
	const points = [t1, ...stamps.filter(stamp => stamp > t1 && stamp < t3), t3];
	let longestFrameMs = 0;
	for (let i = 1; i < points.length; i++) {
		longestFrameMs = Math.max(longestFrameMs, (points[i] ?? 0) - (points[i - 1] ?? 0));
	}
	return {
		prepareMs: t1 - t0,
		callMs: t2 - t1,
		firstFrameMs: firstFrame - t1,
		shownMs: t3 - t1,
		frameJsMs,
		longestFrameMs,
	};
}

export async function runPrepend(
	job: PrependParams,
	{ factory, container, probes }: RunContext,
	setup?: ChartSetup,
): Promise<PrependRun> {
	const { kind } = job.dataset;
	const data = generateSeries(kind, { seed: job.seed, count: job.dataset.size });
	await probes.collectGarbage();
	const before = await probes.measureMemory();
	const adapter = await createSettled(factory, container, job.chart);
	try {
		setup?.(adapter);
		adapter.setData(prepare(adapter, data));
		await adapter.settle();

		const half = job.visibleBars / 2;
		// Logical index and time of the series' first row. Prepends move both back.
		let first = 0;
		let firstTime = data.time[0] ?? 0;
		const prependNext = async (index: number): Promise<PrependTimings> => {
			// Untimed: a batch that ends one step before the first bar, and the view with the first
			// bar in its middle, so the left half is empty until the batch arrives.
			const batch = generateSeries(kind, {
				seed: job.seed + 2 + index,
				count: job.batch,
				startTime: firstTime - job.batch * DEFAULT_INTERVAL_MS,
			});
			adapter.setVisibleLogicalRange({ from: first - half, to: first + half - 1 });
			await adapter.settle();
			const timings = await measurePrepend(adapter, batch);
			first -= job.batch;
			firstTime = batch.time[0] ?? firstTime;
			return timings;
		};

		const cold = await prependNext(0);
		const samples: PrependTimings[] = [];
		markMeasured('start');
		const measureStart = performance.now();
		while (samples.length < job.prepends) {
			samples.push(await prependNext(samples.length + 1));
			if (samples.length >= job.minPrepends && overBudget(measureStart, job.budgetMs)) {
				break;
			}
		}
		markMeasured('end');

		// Untimed: the view of the last prepend, whose left half now holds the last batch, and the view
		// at the new first bar, whose left half is empty.
		const last = first + job.batch;
		const shown = await countRedraw(adapter, { from: last - half, to: last + half - 1 });
		const leftEmpty = await countRedraw(adapter, { from: first - half, to: first + half - 1 });

		await probes.collectGarbage();
		const after = await probes.measureMemory();
		const distribution = (key: keyof PrependTimings) => summarize(samples.map(sample => sample[key]));
		return {
			cold,
			prepareMs: distribution('prepareMs'),
			callMs: distribution('callMs'),
			firstFrameMs: distribution('firstFrameMs'),
			shownMs: distribution('shownMs'),
			frameJsMs: distribution('frameJsMs'),
			longestFrameMs: distribution('longestFrameMs'),
			visibleBars: job.visibleBars,
			finalRows: data.length - first,
			drawCalls: { shown, leftEmpty },
			memory: memoryResult(before, after),
		};
	} finally {
		adapter.destroy();
	}
}

export function prependHeadline(m: Metric): string {
	return (
		`shown p50 ${ms(m('shownMs.p50'))} p95 ${ms(m('shownMs.p95'))} max ${ms(m('shownMs.max'))}; ` +
		`first frame p50 ${ms(m('firstFrameMs.p50'))}; call p50 ${ms(m('callMs.p50'))}; ` +
		`longest frame ${ms(m('longestFrameMs.max'))}; retained ${mb(m('memory.retainedBytes'))}`
	);
}

function prependLabel(c: CaseResult<PrependParams & { scenario: string }>): string {
	return `${datasetLabel(c.job.dataset)} + ${sizeLabel(c.job.batch)}, ${sizeLabel(c.job.visibleBars)} in view`;
}

export function prependSection(report: Report, scenario: string): string {
	const list = casesOf(report, scenario);
	const rows: string[][] = [];
	for (const c of eachCase<PrependJob>(report, scenario)) {
		const { adapter } = c;
		const call = seriesCall(c);
		const shown = median(c, `drawCalls.shown.${call}`);
		const empty = median(c, `drawCalls.leftEmpty.${call}`);
		rows.push([
			prependLabel(c),
			adapter,
			cell(c, 'shownMs.p50', MS),
			cell(c, 'shownMs.p95', MS),
			cell(c, 'shownMs.max', MS),
			cell(c, 'firstFrameMs.p50', MS),
			cell(c, 'firstFrameMs.p95', MS),
			cell(c, 'callMs.p50', MS),
			cell(c, 'callMs.max', MS),
			cell(c, 'frameJsMs.p50', MS),
			cell(c, 'longestFrameMs.p50', MS),
			cell(c, 'longestFrameMs.max', MS),
			cell(c, 'prepareMs.p50', MS),
			cell(c, 'cold.shownMs', MS),
			cell(c, 'shownMs.count'),
			shown === undefined || empty === undefined ? '–' : `${call} ${number(shown)} / ${number(empty)}`,
			hostIdle(c),
		]);
	}
	return (
		table(
			[
				'Data set + batch, view',
				'Adapter',
				'Shown p50',
				'Shown p95',
				'Shown max',
				'First frame p50',
				'First frame p95',
				'Call p50',
				'Call max',
				'Frame JS p50',
				'Longest frame p50',
				'Longest frame max',
				'Prepare p50',
				'Cold shown',
				'Prepends measured',
				'Series calls, shown / left empty',
				'Host CPU idle',
			],
			rows,
		) + `\nAll times in ms. ${runsNote(list)}\n`
	);
}

export function prependMemorySection(report: Report, scenario: string): string {
	return memoryTable(report, scenario, prependLabel, c => median(c, 'finalRows') ?? Number.NaN);
}

export const prepend = defineScenario<PrependJob, PrependRun>({
	name: 'prepend',
	order: 40,
	plan({ quick, chart, seed, budgetMs, keep }) {
		const cases: JobCase<PrependJob>[] = [];
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
		return cases;
	},
	caseParts: job => [sizeLabel(job.batch)],
	run: (job, context) => runPrepend(job, context),
	headline: prependHeadline,
	sections: [
		{ title: 'Prepend', render: report => prependSection(report, 'prepend') },
		{ title: 'Memory after the prepends', render: report => prependMemorySection(report, 'prepend') },
	],
});
