// Ticks on the last bar of line series drawn solid, dashed or dotted, a frame per tick: what the
// frame of a tick costs when the lines have a dash pattern, which is counted along the whole path.

import { supports } from '../adapter.ts';
import { generateSeries, generateTicks } from '../data.ts';
import { ms } from '../format.ts';
import { countDrawCalls } from '../harness/draw-calls.ts';
import { frameJsTotal } from '../harness/frames.ts';
import { markMeasured } from '../harness/marks.ts';
import { LATEST_VIEW_BARS, createSettled, overBudget, prepare } from '../harness/steps.ts';
import { type DatasetSpec, type JobBase, type JobCase, K, M, datasetLabel } from '../jobs.ts';
import { MS, type Report, casesOf, cell, eachCase, hostIdle, runsNote, table } from '../report.ts';
import { type RunContext, defineScenario } from '../scenario.ts';
import { type Distribution, summarize } from '../stats.ts';
import type { TickView } from './tick.ts';

export type LineTickStyle = 'solid' | 'dashed' | 'dotted';
export const LINE_TICK_STYLES: readonly LineTickStyle[] = ['solid', 'dashed', 'dotted'];
const LINE_TICK_VIEWS: readonly TickView[] = ['latest', 'all'];

/** An adapter that can style its line series. */
export interface LineStyleAdapter {
	/**
	 * Draws the line series the next `setData` creates with `style`, and adds `copies` further line
	 * series of the same style with the same data at other prices, which ticks do not change. Called
	 * before `setData`.
	 */
	withLineStyle(style: LineTickStyle, copies: number): void;
}

export interface LineTicksJob extends JobBase {
	readonly scenario: 'line-ticks';
	readonly style: LineTickStyle;
	/** Line series on the chart: the one the ticks change, and copies of it. */
	readonly lines: number;
	readonly view: TickView;
	/** Measured ticks, each followed by its frame: the most a run measures. */
	readonly ticks: number;
	/** Measuring stops after `budgetMs` once at least `minTicks` ticks are measured; 0 measures all. */
	readonly minTicks: number;
	readonly budgetMs: number;
	readonly warmupTicks: number;
	readonly warmupBudgetMs: number;
	/** Ticks of the untimed pass that counts drawing calls. */
	readonly countedTicks: number;
}

export interface LineTicksRun {
	/** JavaScript in animation-frame callbacks per tick: the frame that draws it. */
	frameJs: Distribution;
	/** Wall time from the update call until the frame is drawn, which includes waiting for it. */
	settle: Distribution;
	/** Canvas calls per tick in the untimed pass: the work of a frame. */
	lineToPerTick: number;
	strokePerTick: number;
	fillRectPerTick: number;
	visibleBars: number;
	warmupTicks: number;
}

const LINE_TICK_DATASETS: readonly DatasetSpec[] = [{ kind: 'line', size: M }];
const QUICK_LINE_TICK_DATASETS: readonly DatasetSpec[] = [{ kind: 'line', size: 10 * K }];
const LINES = 5;

async function runLineTicks(job: LineTicksJob, { factory, container }: RunContext): Promise<LineTicksRun> {
	const data = generateSeries(job.dataset.kind, { seed: job.seed, count: job.dataset.size });
	const total = job.warmupTicks + job.countedTicks + job.ticks;
	// Every tick moves the last bar: a new bar is another frame (see the `tick` scenario).
	const ticks = generateTicks(data, { seed: job.seed + 1, count: total, newBarEvery: total + 1 });
	const adapter = await createSettled(factory, container, job.chart);
	try {
		if (!supports<LineStyleAdapter>(adapter, 'withLineStyle')) {
			throw new Error('This adapter cannot style line series');
		}
		adapter.withLineStyle(job.style, job.lines - 1);
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
			await adapter.settle();
			if (overBudget(warmupStart, job.warmupBudgetMs)) {
				break;
			}
		}
		const counts = await countDrawCalls(async () => {
			for (let i = 0; i < job.countedTicks; i++) {
				adapter.applyTick(ticks, offset++);
				await adapter.settle();
			}
		});

		const frameJs = new Float64Array(job.ticks);
		const settle = new Float64Array(job.ticks);
		markMeasured('start');
		const measureStart = performance.now();
		let count = 0;
		while (count < job.ticks) {
			const js = frameJsTotal();
			const start = performance.now();
			adapter.applyTick(ticks, offset + count);
			await adapter.settle();
			settle[count] = performance.now() - start;
			frameJs[count] = frameJsTotal() - js;
			count++;
			if (count >= job.minTicks && overBudget(measureStart, job.budgetMs)) {
				break;
			}
		}
		markMeasured('end');
		const perTick = (name: string): number => (counts[name] ?? 0) / Math.max(1, job.countedTicks);
		return {
			frameJs: summarize(frameJs.subarray(0, count)),
			settle: summarize(settle.subarray(0, count)),
			lineToPerTick: perTick('lineTo'),
			strokePerTick: perTick('stroke'),
			fillRectPerTick: perTick('fillRect'),
			visibleBars,
			warmupTicks: offset - job.countedTicks,
		};
	} finally {
		adapter.destroy();
	}
}

function lineTicksSection(report: Report): string {
	const list = casesOf<LineTicksJob>(report, 'line-ticks');
	const rows: string[][] = [];
	for (const c of eachCase<LineTicksJob>(report, 'line-ticks')) {
		rows.push([
			`${datasetLabel(c.job.dataset)} ${c.job.view}, ${c.job.lines} ${c.job.style} lines`,
			c.adapter,
			cell(c, 'frameJs.mean', MS),
			cell(c, 'frameJs.p50', MS),
			cell(c, 'lineToPerTick'),
			cell(c, 'strokePerTick'),
			cell(c, 'fillRectPerTick'),
			cell(c, 'frameJs.count'),
			hostIdle(c),
		]);
	}
	return (
		table(
			[
				'Data set, view, lines',
				'Adapter',
				'Frame JS avg (ms)',
				'Frame JS p50 (ms)',
				'lineTo per tick',
				'stroke per tick',
				'fillRect per tick',
				'Ticks measured',
				'Host CPU idle',
			],
			rows,
		) + `\n${runsNote(list)}\n`
	);
}

export const lineTicks = defineScenario<LineTicksJob, LineTicksRun>({
	name: 'line-ticks',
	order: 140,
	requires: { capability: 'lineStyle', reason: 'the adapter cannot style line series' },
	plan({ quick, chart, seed, budgetMs, warmupBudgetMs, keep }) {
		const cases: JobCase<LineTicksJob>[] = [];
		for (const dataset of (quick ? QUICK_LINE_TICK_DATASETS : LINE_TICK_DATASETS).filter(keep)) {
			for (const view of LINE_TICK_VIEWS) {
				for (const style of LINE_TICK_STYLES) {
					cases.push({
						scenario: 'line-ticks',
						dataset,
						seed,
						chart,
						style,
						lines: LINES,
						view,
						ticks: quick ? 60 : 600,
						minTicks: quick ? 20 : 60,
						budgetMs,
						warmupTicks: quick ? 10 : 30,
						warmupBudgetMs,
						countedTicks: quick ? 5 : 20,
					});
				}
			}
		}
		return cases;
	},
	caseParts: job => [job.view, job.style],
	run: runLineTicks,
	headline(m) {
		return `frame JS avg ${ms(m('frameJs.mean'))} p50 ${ms(m('frameJs.p50'))}; ${m('lineToPerTick')?.toFixed(0) ?? '–'} lineTo per tick`;
	},
	sections: [{ title: 'Ticks on dashed and dotted lines: the frame of a tick', render: lineTicksSection }],
});
