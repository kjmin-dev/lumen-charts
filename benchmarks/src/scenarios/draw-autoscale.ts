// The stage 4 follow-up scenario: frames that compute price ranges with drawings that take part in autoscale.

import { supports } from '../adapter.ts';
import { type CandleColumns, generateSeries } from '../data.ts';
import { type BenchDrawing, generateDrawings } from '../drawings.ts';
import { ms } from '../format.ts';
import { requestTimedFrame, startFrameRecording, stopFrameRecording } from '../harness/frames.ts';
import { markMeasured } from '../harness/marks.ts';
import { MIN_WARMUP_FRAMES, createSettled, overBudget, prepare } from '../harness/steps.ts';
import { type JobBase, type JobCase, datasetLabel } from '../jobs.ts';
import { motionRanges } from '../motion.ts';
import { type Report, US, cell, eachCase, hostIdle, median, table } from '../report.ts';
import { type RunContext, defineScenario } from '../scenario.ts';
import { type Distribution, summarize } from '../stats.ts';
import { DRAWINGS_DATASET, QUICK_DRAWINGS_DATASET } from './drawings.ts';

/** A library whose drawings can take part in the autoscale of their price scale. */
export interface DrawingAutoscaleAdapter {
	/** Adds drawings to the chart; with `autoscale`, the price scale keeps them in view. */
	addDrawings(drawings: readonly BenchDrawing[], autoscale: boolean): void;
	/** The range of prices the main price scale shows, or null before it shows any. */
	priceRange(): { from: number; to: number } | null;
}

/**
 * What a case does in each frame: `pan` moves the view as the frames scenario does, so every layer
 * is drawn again; `still` sets the view it already has, a frame that computes the price ranges and
 * draws the series but leaves the drawings as they are, so the autoscale pass is a larger share of it.
 */
export type DrawAutoscaleVariant = 'pan' | 'still';

/**
 * Frames with `drawings` drawings on the chart (see `generateDrawings`: half of them in view), all
 * of them taking part in autoscale or none. The two differ by one pass over the drawings that
 * opted in, in every frame that computes price ranges.
 */
export interface DrawAutoscaleJob extends JobBase {
	readonly scenario: 'draw-autoscale';
	readonly variant: DrawAutoscaleVariant;
	readonly drawings: number;
	readonly autoscale: boolean;
	/** Bars in view: the last ones of the data set. */
	readonly visibleBars: number;
	readonly frames: number;
	readonly minFrames: number;
	readonly budgetMs: number;
	readonly warmupFrames: number;
	readonly warmupBudgetMs: number;
}

export interface DrawAutoscaleRun {
	/** JavaScript time of each frame: the view change and the chart's work for it in the animation frame. */
	frameJs: Distribution;
	frames: number;
	warmupFrames: number;
	drawings: number;
	/** Drawings whose time range overlaps the view at the start. */
	drawingsInView: number;
	/** Height of the price range in view at the start: larger when drawings take part in it. */
	priceSpan: number;
	visibleBars: number;
}

interface DrawAutoscaleCase {
	readonly drawings: number;
	readonly autoscale: boolean;
}

const CASES: readonly DrawAutoscaleCase[] = [
	{ drawings: 1000, autoscale: false },
	{ drawings: 100, autoscale: true },
	{ drawings: 1000, autoscale: true },
];
const QUICK_CASES: readonly DrawAutoscaleCase[] = [{ drawings: 100, autoscale: true }];
const VARIANTS: readonly DrawAutoscaleVariant[] = ['still', 'pan'];

async function runDrawAutoscale(job: DrawAutoscaleJob, { factory, container }: RunContext): Promise<DrawAutoscaleRun> {
	const data = generateSeries('candles', { seed: job.seed, count: job.dataset.size }) as CandleColumns;
	const adapter = await createSettled(factory, container, job.chart);
	if (!supports<DrawingAutoscaleAdapter>(adapter, 'addDrawings', 'priceRange')) {
		throw new Error('This adapter has no drawings that take part in autoscale');
	}
	const { addDrawings, priceRange } = adapter;
	try {
		adapter.setData(prepare(adapter, data));
		await adapter.settle();
		const n = data.length;
		const visibleBars = Math.min(job.visibleBars, n);
		const view = { from: n - visibleBars, to: n - 1 };
		adapter.setVisibleLogicalRange(view);
		await adapter.settle();
		const generated = generateDrawings(data, job.drawings, view.from, view.to, job.seed + 3);
		addDrawings.call(adapter, generated, job.autoscale);
		await adapter.settle();
		const range = priceRange.call(adapter);

		const steps = job.warmupFrames + job.frames + 2;
		const ranges = job.variant === 'pan' ? motionRanges('pan', n, visibleBars, steps, 1) : [];
		const step = (k: number): void => {
			adapter.setVisibleLogicalRange(ranges[k] ?? view);
		};
		step(0);
		await adapter.settle();

		let first = 0;
		let last = 0;
		startFrameRecording();
		let recording;
		try {
			await new Promise<void>((resolve, reject) => {
				const warmupStart = performance.now();
				let measureStart = 0;
				let frame = 0;
				const onFrame = (): void => {
					const now = performance.now();
					if (first === 0) {
						const warmedUp =
							frame >= job.warmupFrames ||
							(frame >= MIN_WARMUP_FRAMES && overBudget(warmupStart, job.warmupBudgetMs, now));
						if (warmedUp) {
							first = frame + 1;
							measureStart = now;
							markMeasured('start');
						}
					} else if (last === 0) {
						const measured = frame + 1 - first;
						if (measured >= job.frames || (measured >= job.minFrames && overBudget(measureStart, job.budgetMs, now))) {
							last = frame + 1;
						}
					} else if (frame === last) {
						markMeasured('end');
						resolve();
						return;
					}
					try {
						step(frame + 1);
					} catch (error) {
						reject(error);
						return;
					}
					frame++;
					requestTimedFrame(onFrame);
				};
				requestTimedFrame(onFrame);
			});
		} finally {
			recording = stopFrameRecording();
		}
		await adapter.settle();
		if (recording.timestamps.length < last) {
			throw new Error(`Recorded ${recording.timestamps.length} frames, expected at least ${last}`);
		}
		const frameJs: number[] = [];
		for (let k = first; k < last; k++) {
			frameJs.push(recording.jsTime[k] ?? 0);
		}
		return {
			frameJs: summarize(frameJs),
			frames: last - first,
			warmupFrames: first - 1,
			drawings: generated.length,
			drawingsInView: generated.filter(drawing => drawing.inView).length,
			priceSpan: range === null ? Number.NaN : range.to - range.from,
			visibleBars,
		};
	} finally {
		adapter.destroy();
	}
}

function drawAutoscaleSection(report: Report): string {
	const rows: string[][] = [];
	for (const c of eachCase<DrawAutoscaleJob>(report, 'draw-autoscale')) {
		rows.push([
			`${c.job.variant}, ${c.job.drawings} drawings (${median(c, 'drawingsInView') ?? '–'} in view), ` +
				`autoscale ${c.job.autoscale ? 'on' : 'off'}, ${datasetLabel(c.job.dataset)}, ${c.job.visibleBars} bars in view`,
			c.adapter,
			cell(c, 'frameJs.mean', US),
			cell(c, 'frameJs.p50', US),
			cell(c, 'frameJs.p95', US),
			cell(c, 'frameJs.p99', US),
			cell(c, 'frameJs.max', US),
			cell(c, 'priceSpan'),
			cell(c, 'frames'),
			hostIdle(c),
		]);
	}
	return table(
		[
			'Case',
			'Adapter',
			'Frame JS mean (µs)',
			'p50 (µs)',
			'p95 (µs)',
			'p99 (µs)',
			'max (µs)',
			'Price range in view',
			'Frames',
			'CPU idle',
		],
		rows,
	);
}

export const drawAutoscale = defineScenario<DrawAutoscaleJob, DrawAutoscaleRun>({
	name: 'draw-autoscale',
	order: 160,
	requires: { capability: 'drawingAutoscale', reason: 'the library has no drawings that take part in autoscale' },
	plan({ quick, chart, seed, budgetMs, warmupBudgetMs, keep }) {
		const cases: JobCase<DrawAutoscaleJob>[] = [];
		const dataset = quick ? QUICK_DRAWINGS_DATASET : DRAWINGS_DATASET;
		if (keep(dataset)) {
			for (const variant of VARIANTS) {
				for (const { drawings, autoscale } of quick ? QUICK_CASES : CASES) {
					cases.push({
						scenario: 'draw-autoscale',
						dataset,
						seed,
						chart,
						variant,
						drawings,
						autoscale,
						visibleBars: 300,
						frames: quick ? 60 : 600,
						minFrames: quick ? 20 : 120,
						budgetMs,
						warmupFrames: quick ? 10 : 60,
						warmupBudgetMs,
					});
				}
			}
		}
		return cases;
	},
	caseParts: job => [job.variant, job.drawings, job.autoscale ? 'on' : 'off'],
	run: runDrawAutoscale,
	headline(m) {
		return (
			`frame JS mean ${ms(m('frameJs.mean'))} p50 ${ms(m('frameJs.p50'))} p99 ${ms(m('frameJs.p99'))} ` +
			`max ${ms(m('frameJs.max'))}; price range ${m('priceSpan')?.toFixed(2) ?? '–'}; frames ${m('frames') ?? '–'}`
		);
	},
	sections: [{ title: 'Drawings in autoscale: frames that compute price ranges', render: drawAutoscaleSection }],
});
