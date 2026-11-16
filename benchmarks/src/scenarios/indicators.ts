// The stage 3 scenarios: load, frames and prepend with indicators on the candles, and tick to
// applied patch.

import { type ChartAdapter, supports } from '../adapter.ts';
import { Random, TICK_NEW_BAR, generateSeries, generateTicks } from '../data.ts';
import { ms } from '../format.ts';
import { nextTask } from '../harness/frames.ts';
import { markMeasured } from '../harness/marks.ts';
import { LATEST_VIEW_BARS, createSettled, overBudget, prepare } from '../harness/steps.ts';
import { type DatasetSpec, type JobBase, type JobCase, K, M, datasetLabel, sizeLabel } from '../jobs.ts';
import { MS, type Report, US, casesOf, cell, eachCase, hostIdle, runsNote, table } from '../report.ts';
import { type PlanContext, type Requirement, type RunContext, defineScenario } from '../scenario.ts';
import { type Distribution, summarize } from '../stats.ts';
import {
	type FramesJob,
	type FramesRun,
	MOTIONS,
	QUICK_FRAME_ZOOMS,
	type ZoomLevel,
	framesHeadline,
	framesSection,
	motionLabel,
	runFrames,
} from './frames.ts';
import { type LoadJob, type LoadRun, loadHeadline, loadMemorySection, loadSection, runLoad } from './load.ts';
import {
	type PrependBatch,
	type PrependJob,
	type PrependRun,
	QUICK_PREPEND_BATCHES,
	prependHeadline,
	prependMemorySection,
	prependSection,
	runPrepend,
} from './prepend.ts';
import { TICK_VIEWS, type TickView } from './tick.ts';

/** An adapter that can put indicators on a series. */
export interface IndicatorAdapter {
	/**
	 * Puts the first `count` indicators of the stage 3 set (`INDICATOR_SET`) on the series the next
	 * `setData` creates, which then keeps the candles' volume; ticks and prepends update them. Called
	 * before `setData`.
	 */
	withIndicators(count: number): void;
}

/** An adapter that can tell when an update is applied. */
export interface AppliedAdapter {
	/**
	 * Resolves once everything submitted so far has been applied, indicator values included, without
	 * waiting for a frame. A library that applies updates synchronously resolves at once.
	 */
	applied(): Promise<void>;
}

const REQUIRES: Requirement = { capability: 'indicators', reason: 'the adapter cannot put indicators on a series' };

/**
 * The stage 3 scenarios run the load, frames and prepend scenarios with the first `indicators` of
 * the indicator set (`INDICATOR_SET`) on the candles. Their times include the indicators: a load or
 * prepend is settled once every indicator is computed and drawn.
 */
export interface IndicatorLoadJob extends Omit<LoadJob, 'scenario'> {
	readonly scenario: 'ind-load';
	readonly indicators: number;
}

export interface IndicatorFramesJob extends Omit<FramesJob, 'scenario'> {
	readonly scenario: 'ind-frames';
	readonly indicators: number;
}

export interface IndicatorPrependJob extends Omit<PrependJob, 'scenario'> {
	readonly scenario: 'ind-prepend';
	readonly indicators: number;
}

/**
 * Tick to applied patch: ticks one at a time, each timed from the update call until the library
 * has applied it, indicator values included (for lumen: the engine's answer has been applied on
 * the main thread; for a library that applies updates synchronously: the call itself). Ticks are
 * separated by random pauses of up to 2 ms, so they arrive at random points of the frame cycle, as
 * ticks from a socket would, and frames run whenever they are due.
 */
export interface ApplyJob extends JobBase {
	readonly scenario: 'ind-apply';
	readonly indicators: number;
	readonly view: TickView;
	/** Measured ticks: the most a run measures. */
	readonly ticks: number;
	/** Measuring stops after `budgetMs` once at least `minTicks` ticks are measured; 0 measures all. */
	readonly minTicks: number;
	readonly budgetMs: number;
	readonly warmupTicks: number;
	readonly warmupBudgetMs: number;
	/** Every Nth tick starts a new bar. */
	readonly newBarEvery: number;
}

export interface ApplyRun {
	/** From the update call until the tick is applied, indicator values included, all measured ticks. */
	applied: Distribution;
	/** Same, ticks that modify the last bar only. */
	appliedUpdate: Distribution;
	/** Same, ticks that start a new bar only. */
	appliedNewBar: Distribution;
	/** The synchronous update call alone. */
	sync: Distribution;
	visibleBars: number;
	warmupTicks: number;
}

// Stage 3: 20 indicators on candles. 100k is where Lightweight Charts, which takes one line series
// per output in user code, is compared; 1M is the gate's data set.
const INDICATOR_COUNT = 20;
const INDICATOR_DATASETS: readonly DatasetSpec[] = [
	{ kind: 'candles', size: 100 * K },
	{ kind: 'candles', size: M },
];
const INDICATOR_FRAME_ZOOMS: readonly ZoomLevel[] = [200, 2_000, 20_000, 200_000, 'all'];
const INDICATOR_PREPEND_BATCHES: readonly PrependBatch[] = [
	{ batch: 10 * K, prepends: 10, minPrepends: 3 },
	{ batch: M, prepends: 3, minPrepends: 2 },
];
export const QUICK_INDICATOR_DATASETS: readonly DatasetSpec[] = [{ kind: 'candles', size: 10 * K }];

/** Data sets and number of indicators of the stage 3 cases. */
function matrix({ quick, keep }: PlanContext): { indicatorDatasets: DatasetSpec[]; indicators: number } {
	return {
		indicatorDatasets: (quick ? QUICK_INDICATOR_DATASETS : INDICATOR_DATASETS).filter(keep),
		indicators: quick ? 5 : INDICATOR_COUNT,
	};
}

/** Puts the indicator set on the series the next `setData` creates, if `count` is not 0. */
export function withIndicators(adapter: ChartAdapter, count: number): void {
	if (count === 0) {
		return;
	}
	if (!supports<IndicatorAdapter>(adapter, 'withIndicators')) {
		throw new Error('This adapter cannot put indicators on a series');
	}
	adapter.withIndicators(count);
}

/** Longest pause between two ticks of the tick-to-applied scenario, in milliseconds. */
const MAX_TICK_GAP_MS = 2;

/** Waits `duration` milliseconds a task at a time, so frames run whenever they are due meanwhile. */
async function pause(duration: number): Promise<void> {
	const until = performance.now() + duration;
	while (performance.now() < until) {
		await nextTask();
	}
}

/**
 * Ticks one at a time, each from the update call until the library has applied it (indicator
 * values included), with the series' indicators computed beforehand. A random pause of up to
 * `MAX_TICK_GAP_MS` separates ticks, so they arrive at random points of the frame cycle as ticks from
 * a socket would: a tick that arrives during a frame waits for it, and with ticks back to back the
 * share of ticks that do would depend on how fast the library is.
 */
async function runApply(job: ApplyJob, { factory, container }: RunContext): Promise<ApplyRun> {
	const data = generateSeries(job.dataset.kind, { seed: job.seed, count: job.dataset.size });
	const ticks = generateTicks(data, {
		seed: job.seed + 1,
		count: job.warmupTicks + job.ticks,
		newBarEvery: job.newBarEvery,
	});
	const adapter = await createSettled(factory, container, job.chart);
	if (!supports<AppliedAdapter>(adapter, 'applied')) {
		throw new Error('This adapter cannot tell when an update is applied');
	}
	try {
		withIndicators(adapter, job.indicators);
		adapter.setData(prepare(adapter, data));
		await adapter.settle();
		const n = data.length;
		const visibleBars = job.view === 'all' ? n : Math.min(LATEST_VIEW_BARS, n);
		adapter.setVisibleLogicalRange({ from: n - visibleBars, to: n - 1 });
		await adapter.settle();

		const warmupStart = performance.now();
		let offset = 0;
		while (offset < job.warmupTicks) {
			adapter.applyTick(ticks, offset++);
			await adapter.applied();
			if (overBudget(warmupStart, job.warmupBudgetMs)) {
				break;
			}
		}
		await adapter.settle();

		const applied = new Float64Array(job.ticks);
		const sync = new Float64Array(job.ticks);
		const gaps = new Random(job.seed + 2);
		markMeasured('start');
		const measureStart = performance.now();
		let count = 0;
		while (count < job.ticks) {
			await pause(gaps.next() * MAX_TICK_GAP_MS);
			const t0 = performance.now();
			adapter.applyTick(ticks, offset + count);
			const t1 = performance.now();
			await adapter.applied();
			const t2 = performance.now();
			sync[count] = t1 - t0;
			applied[count] = t2 - t0;
			count++;
			if (count >= job.minTicks && overBudget(measureStart, job.budgetMs, t2)) {
				break;
			}
		}
		markMeasured('end');
		await adapter.settle();

		const update: number[] = [];
		const newBar: number[] = [];
		for (let i = 0; i < count; i++) {
			(ticks.tickKind[offset + i] === TICK_NEW_BAR ? newBar : update).push(applied[i] ?? 0);
		}
		return {
			applied: summarize(applied.subarray(0, count)),
			appliedUpdate: summarize(update),
			appliedNewBar: summarize(newBar),
			sync: summarize(sync.subarray(0, count)),
			visibleBars,
			warmupTicks: offset,
		};
	} finally {
		adapter.destroy();
	}
}

/** Stage 3: tick to applied patch, ticks one at a time with indicators on the series. */
function applySection(report: Report): string {
	const list = casesOf(report, 'ind-apply');
	const rows: string[][] = [];
	for (const c of eachCase<ApplyJob>(report, 'ind-apply')) {
		const { adapter } = c;
		rows.push([
			`${datasetLabel(c.job.dataset)} ${c.job.view}, ${c.job.indicators} indicators`,
			adapter,
			cell(c, 'applied.mean', MS),
			cell(c, 'applied.p50', MS),
			cell(c, 'applied.p99', MS),
			cell(c, 'applied.max', MS),
			cell(c, 'appliedUpdate.p99', MS),
			cell(c, 'appliedNewBar.p99', MS),
			cell(c, 'sync.mean', US),
			cell(c, 'sync.p99', US),
			cell(c, 'applied.count'),
			hostIdle(c),
		]);
	}
	return (
		table(
			[
				'Data set, view',
				'Adapter',
				'Applied avg (ms)',
				'Applied p50 (ms)',
				'Applied p99 (ms)',
				'Applied max (ms)',
				'Update p99 (ms)',
				'New bar p99 (ms)',
				'Sync avg (µs)',
				'Sync p99 (µs)',
				'Ticks measured',
				'Host CPU idle',
			],
			rows,
		) + `\n${runsNote(list)}\n`
	);
}

export const indLoad = defineScenario<IndicatorLoadJob, LoadRun>({
	name: 'ind-load',
	order: 60,
	requires: REQUIRES,
	plan(context) {
		const { chart, seed } = context;
		const { indicatorDatasets, indicators } = matrix(context);
		const cases: JobCase<IndicatorLoadJob>[] = [];
		for (const dataset of indicatorDatasets) {
			cases.push({ scenario: 'ind-load', dataset, seed, chart, indicators });
		}
		return cases;
	},
	caseParts: job => [job.indicators],
	run: (job, context) => runLoad(job, context, adapter => withIndicators(adapter, job.indicators)),
	headline: loadHeadline,
	sections: [
		{
			title: 'Indicators: load (settled = every indicator computed and drawn)',
			render: report => loadSection(report, 'ind-load'),
		},
		{ title: 'Indicators: memory after load', render: report => loadMemorySection(report, 'ind-load') },
	],
});

export const indApply = defineScenario<ApplyJob, ApplyRun>({
	name: 'ind-apply',
	order: 70,
	requires: REQUIRES,
	plan(context) {
		const { quick, chart, seed, budgetMs, warmupBudgetMs } = context;
		const { indicatorDatasets, indicators } = matrix(context);
		const cases: JobCase<ApplyJob>[] = [];
		for (const dataset of indicatorDatasets) {
			for (const view of TICK_VIEWS) {
				cases.push({
					scenario: 'ind-apply',
					dataset,
					seed,
					chart,
					indicators,
					view,
					ticks: quick ? 500 : 10_000,
					minTicks: quick ? 100 : 1_000,
					budgetMs,
					warmupTicks: quick ? 50 : 200,
					warmupBudgetMs,
					newBarEvery: 10,
				});
			}
		}
		return cases;
	},
	caseParts: job => [job.view, job.indicators],
	run: runApply,
	headline(m) {
		return (
			`tick to applied avg ${ms(m('applied.mean'))} p99 ${ms(m('applied.p99'))} max ${ms(m('applied.max'))}; ` +
			`sync avg ${ms(m('sync.mean'))} p99 ${ms(m('sync.p99'))}; ticks ${m('applied.count') ?? '–'}`
		);
	},
	sections: [{ title: 'Indicators: tick to applied patch', render: applySection }],
});

export const indFrames = defineScenario<IndicatorFramesJob, FramesRun>({
	name: 'ind-frames',
	order: 80,
	requires: REQUIRES,
	plan(context) {
		const { quick, chart, seed, budgetMs, warmupBudgetMs } = context;
		const { indicatorDatasets, indicators } = matrix(context);
		const cases: JobCase<IndicatorFramesJob>[] = [];
		for (const dataset of indicatorDatasets) {
			for (const zoom of quick ? QUICK_FRAME_ZOOMS : INDICATOR_FRAME_ZOOMS) {
				if (zoom !== 'all' && zoom >= dataset.size) {
					continue;
				}
				for (const motion of MOTIONS) {
					cases.push({
						scenario: 'ind-frames',
						dataset,
						seed,
						chart,
						indicators,
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
		return cases;
	},
	caseParts: job => [motionLabel(job), job.indicators],
	run: (job, context) => runFrames(job, context, adapter => withIndicators(adapter, job.indicators)),
	headline: framesHeadline,
	sections: [{ title: 'Indicators: pan and zoom frames', render: report => framesSection(report, 'ind-frames') }],
});

export const indPrepend = defineScenario<IndicatorPrependJob, PrependRun>({
	name: 'ind-prepend',
	order: 90,
	requires: REQUIRES,
	plan(context) {
		const { quick, chart, seed, budgetMs } = context;
		const { indicatorDatasets, indicators } = matrix(context);
		const cases: JobCase<IndicatorPrependJob>[] = [];
		for (const dataset of indicatorDatasets) {
			for (const { batch, prepends, minPrepends } of quick ? QUICK_PREPEND_BATCHES : INDICATOR_PREPEND_BATCHES) {
				if (batch > dataset.size) {
					continue;
				}
				cases.push({
					scenario: 'ind-prepend',
					dataset,
					seed,
					chart,
					indicators,
					batch,
					visibleBars: Math.min(2 * batch, dataset.size),
					prepends,
					minPrepends,
					budgetMs,
				});
			}
		}
		return cases;
	},
	caseParts: job => [sizeLabel(job.batch), job.indicators],
	run: (job, context) => runPrepend(job, context, adapter => withIndicators(adapter, job.indicators)),
	headline: prependHeadline,
	sections: [
		{
			title: 'Indicators: prepend (shown = indicators recomputed and drawn)',
			render: report => prependSection(report, 'ind-prepend'),
		},
		{
			title: 'Indicators: memory after the prepends',
			render: report => prependMemorySection(report, 'ind-prepend'),
		},
	],
});
