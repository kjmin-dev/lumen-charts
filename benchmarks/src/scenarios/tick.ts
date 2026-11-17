// Live ticks on the tail of a series, in rounds, with the latest bars or all of them in view.

import { TICK_NEW_BAR, generateSeries, generateTicks } from '../data.ts';
import { ms } from '../format.ts';
import { frameJsTotal } from '../harness/frames.ts';
import { markMeasured } from '../harness/marks.ts';
import { LATEST_VIEW_BARS, createSettled, overBudget, prepare } from '../harness/steps.ts';
import { type DatasetSpec, type JobBase, type JobCase, K, M, datasetLabel } from '../jobs.ts';
import { MS, type Report, US, casesOf, cell, eachCase, hostIdle, median, number, runsNote, table } from '../report.ts';
import { type RunContext, defineScenario } from '../scenario.ts';
import { type Distribution, summarize } from '../stats.ts';

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

const TICK_DATASETS: readonly DatasetSpec[] = [
	{ kind: 'candles', size: 10 * K },
	{ kind: 'candles', size: 100 * K },
	{ kind: 'candles', size: 300 * K },
	{ kind: 'candles', size: M },
];
export const TICK_VIEWS: readonly TickView[] = ['latest', 'all'];
const QUICK_TICK_DATASETS: readonly DatasetSpec[] = [{ kind: 'candles', size: 10 * K }];

async function runTick(job: TickJob, { factory, container }: RunContext): Promise<TickRun> {
	const data = generateSeries(job.dataset.kind, { seed: job.seed, count: job.dataset.size });
	const ticks = generateTicks(data, {
		seed: job.seed + 1,
		count: job.warmupTicks + job.ticks,
		newBarEvery: job.newBarEvery,
	});
	const adapter = await createSettled(factory, container, job.chart);
	try {
		adapter.setData(prepare(adapter, data));
		await adapter.settle();
		const n = data.length;
		const visibleBars = job.view === 'all' ? n : Math.min(LATEST_VIEW_BARS, n);
		adapter.setVisibleLogicalRange({ from: n - visibleBars, to: n - 1 });
		await adapter.settle();

		const { roundSize } = job;
		const warmupStart = performance.now();
		let offset = 0;
		while (offset < job.warmupTicks) {
			const end = Math.min(offset + roundSize, job.warmupTicks);
			for (let i = offset; i < end; i++) {
				adapter.applyTick(ticks, i);
			}
			offset = end;
			await adapter.settle();
			if (overBudget(warmupStart, job.warmupBudgetMs)) {
				break;
			}
		}

		const maxRounds = Math.ceil(job.ticks / roundSize);
		const durations = new Float64Array(job.ticks);
		const syncPerRound = new Float64Array(maxRounds);
		const settle = new Float64Array(maxRounds);
		const settleJs = new Float64Array(maxRounds);
		const mainThreadPerTick = new Float64Array(maxRounds);
		markMeasured('start');
		const measureStart = performance.now();
		let count = 0;
		let rounds = 0;
		while (count < job.ticks) {
			const r = rounds++;
			const start = count;
			const end = Math.min(start + roundSize, job.ticks);
			count = end;
			const roundStart = performance.now();
			let last = roundStart;
			for (let i = start; i < end; i++) {
				adapter.applyTick(ticks, offset + i);
				const now = performance.now();
				durations[i] = now - last;
				last = now;
			}
			const js = frameJsTotal();
			await adapter.settle();
			const settled = performance.now();
			const paintJs = frameJsTotal() - js;
			syncPerRound[r] = (last - roundStart) / (end - start);
			settle[r] = settled - last;
			settleJs[r] = paintJs;
			mainThreadPerTick[r] = (last - roundStart + paintJs) / (end - start);
			if (count >= job.minTicks && overBudget(measureStart, job.budgetMs)) {
				break;
			}
		}
		markMeasured('end');

		const update: number[] = [];
		const newBar: number[] = [];
		for (let i = 0; i < count; i++) {
			(ticks.tickKind[offset + i] === TICK_NEW_BAR ? newBar : update).push(durations[i] ?? 0);
		}
		return {
			sync: summarize(durations.subarray(0, count)),
			syncUpdate: summarize(update),
			syncNewBar: summarize(newBar),
			syncPerRound: summarize(syncPerRound.subarray(0, rounds)),
			settle: summarize(settle.subarray(0, rounds)),
			settleJs: summarize(settleJs.subarray(0, rounds)),
			mainThreadPerTick: summarize(mainThreadPerTick.subarray(0, rounds)),
			visibleBars,
			warmupTicks: offset,
		};
	} finally {
		adapter.destroy();
	}
}

function tickSection(report: Report): string {
	const list = casesOf<TickJob>(report, 'tick');
	const rows: string[][] = [];
	for (const c of eachCase<TickJob>(report, 'tick')) {
		const { adapter } = c;
		rows.push([
			`${datasetLabel(c.job.dataset)} ${c.job.view}`,
			adapter,
			cell(c, 'sync.mean', US),
			cell(c, 'sync.p50', US),
			cell(c, 'sync.p99', US),
			cell(c, 'sync.max', MS),
			cell(c, 'syncPerRound.p99', US),
			cell(c, 'syncUpdate.mean', US),
			cell(c, 'syncNewBar.mean', US),
			cell(c, 'settleJs.mean', MS),
			cell(c, 'mainThreadPerTick.mean', US),
			cell(c, 'mainThreadPerTick.p99', US),
			cell(c, 'settle.p99', MS),
			cell(c, 'sync.count'),
			hostIdle(c),
		]);
	}
	return (
		table(
			[
				'Data set, view',
				'Adapter',
				'Sync avg (µs)',
				'Sync p50 (µs)',
				'Sync p99 (µs)',
				'Sync max (ms)',
				'Sub-batch p99 (µs)',
				'Update avg (µs)',
				'New bar avg (µs)',
				'Paint JS per round (ms)',
				'Main thread avg (µs)',
				'Main thread p99 (µs)',
				'Settle p99 (ms)',
				'Ticks measured',
				'Host CPU idle',
			],
			rows,
		) + `\n${runsNote(list)}\n`
	);
}

/** Tick cost against data set size, per adapter and view: the O(N) question. */
function scalingSection(report: Report): string {
	const list = casesOf<TickJob>(report, 'tick');
	const columns: { adapter: string; view: string }[] = [];
	for (const c of list) {
		const view = c.job.scenario === 'tick' ? c.job.view : null;
		if (view !== null && !columns.some(k => k.adapter === c.adapter && k.view === view)) {
			columns.push({ adapter: c.adapter, view });
		}
	}
	const datasets: DatasetSpec[] = [];
	for (const c of list) {
		if (!datasets.some(d => d.kind === c.job.dataset.kind && d.size === c.job.dataset.size)) {
			datasets.push(c.job.dataset);
		}
	}
	datasets.sort((a, b) => a.size - b.size);
	const smallest = datasets[0];
	const rows = datasets.map(d => {
		const row = [datasetLabel(d)];
		for (const { adapter, view } of columns) {
			const c = list.find(
				x => x.adapter === adapter && x.job.scenario === 'tick' && x.job.view === view && x.job.dataset.size === d.size,
			);
			const base = list.find(
				x =>
					x.adapter === adapter &&
					x.job.scenario === 'tick' &&
					x.job.view === view &&
					x.job.dataset.size === smallest?.size,
			);
			const value = median(c, 'sync.mean');
			const baseValue = median(base, 'sync.mean');
			row.push(
				value === undefined || baseValue === undefined
					? '–'
					: `${number(value * US)} µs (×${number(value / baseValue)})`,
			);
		}
		return row;
	});
	return table(['Data set', ...columns.map(k => `${k.adapter} ${k.view}`)], rows);
}

export const tick = defineScenario<TickJob, TickRun>({
	name: 'tick',
	order: 20,
	plan({ quick, chart, seed, budgetMs, warmupBudgetMs, keep }) {
		const cases: JobCase<TickJob>[] = [];
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
		return cases;
	},
	caseParts: job => [job.view],
	run: runTick,
	headline(m) {
		return (
			`tick avg ${ms(m('sync.mean'))} p99 ${ms(m('sync.p99'))}; ` +
			`main thread incl. paint avg ${ms(m('mainThreadPerTick.mean'))} p99 ${ms(m('mainThreadPerTick.p99'))}; ` +
			`settle p99 ${ms(m('settle.p99'))}`
		);
	},
	sections: [
		{ title: 'Tick', render: tickSection },
		{ title: 'Tick cost against data set size (sync avg, ratio to the smallest size)', render: scalingSection },
	],
});
