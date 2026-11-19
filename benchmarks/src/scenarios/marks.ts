// Heatmap and scatter series, drawn through a pixel buffer: pan, zoom and live updates at a number
// of marks in view.

import { supports } from '../adapter.ts';
import { type CandleColumns, Random, generateSeries } from '../data.ts';
import { ms } from '../format.ts';
import { requestTimedFrame, startFrameRecording, stopFrameRecording } from '../harness/frames.ts';
import { markMeasured } from '../harness/marks.ts';
import { MIN_WARMUP_FRAMES, createSettled, overBudget, prepare } from '../harness/steps.ts';
import { type DatasetSpec, type JobBase, type JobCase, K, M, sizeLabel } from '../jobs.ts';
import { motionRanges } from '../motion.ts';
import { MS, type Report, cell, eachCase, hostIdle, table } from '../report.ts';
import { type Metric, type RunContext, defineScenario } from '../scenario.ts';
import { type Distribution, summarize } from '../stats.ts';

/** Points of a scatter series as parallel columns, in time order. */
export interface ScatterInput {
	time: Float64Array;
	price: Float64Array;
	value: Float32Array;
}

/** Columns of a heatmap on a price grid: `rows` values per column, one column after the other. */
export interface HeatmapInput {
	priceStart: number;
	priceStep: number;
	rows: number;
	time: Float64Array;
	values: Float32Array;
}

/** A library with scatter and heatmap series beside its bars. */
export interface MarksAdapter {
	/** Adds a scatter series to the chart and gives it its points. */
	setScatter(points: ScatterInput, pointSize: number): void;
	/** Adds a point at or after the last one. */
	appendScatter(time: number, price: number, value: number): void;
	/** Adds a heatmap to the chart and gives it its columns. */
	setHeatmap(data: HeatmapInput): void;
	/** Replaces the last column of the heatmap (at its time), or adds one after it. */
	updateHeatmap(time: number, values: Float32Array): void;
	/** The level of detail the series was last drawn from (0: as given) and the marks in view at it. */
	marksDrawn(): { level: number; marks: number };
	markBackend?(): { effective: string; path: string; bytes: number; reason: string | null } | undefined;
}

/**
 * What a case does, one step per animation frame: `pan` and `zoom` move the view as the frames
 * scenario does; `tick` leaves it and changes the data (a point added to the scatter, the last
 * column of the heatmap replaced).
 */
export type MarksVariant = 'pan' | 'zoom' | 'tick' | 'tick-redraw';

/**
 * How the points of a scatter lie. `cloud`: spread over a band of prices many times the candles'
 * range, so few points share a pixel: the worst case for the levels of detail, which then draw the
 * points themselves. `trades`: close to the price of their bar, as trades are.
 */
export type ScatterShape = 'cloud' | 'trades';

interface MarksJobBase extends JobBase {
	readonly variant: MarksVariant;
	/** Bars in view at the start; the data set holds twice as many. */
	readonly visibleBars: number;
	/** Measured frames: the most a run measures. */
	readonly frames: number;
	readonly minFrames: number;
	readonly budgetMs: number;
	readonly warmupFrames: number;
	readonly warmupBudgetMs: number;
}

export interface ScatterJob extends MarksJobBase {
	readonly scenario: 'scatter';
	/** Points in view at the start: the series holds twice as many, spread evenly over the bars. */
	readonly points: number;
	readonly shape: ScatterShape;
	/** Width and height of a point in CSS pixels. */
	readonly pointSize: number;
}

export interface HeatmapJob extends MarksJobBase {
	readonly scenario: 'heatmap';
	/** Cells per column. Columns are one per bar, so `visibleBars` of them are in view at the start. */
	readonly rows: number;
}

export interface MarksRun {
	backend?: string;
	gpuPass?: Distribution;
	rendererPath?: string;
	rendererBytes?: number;
	rendererReason?: string | null;
	/** JavaScript time of each frame: the step (a view change, or an update of the data) and the chart's draw for it. */
	jsTime: Distribution;
	interval: Distribution;
	frames: number;
	warmupFrames: number;
	/** Level of detail and marks in view the chart drew from, at the start and at the end of the run. */
	level: number;
	marks: number;
	levelEnd: number;
	marksEnd: number;
	/** Marks the series holds. */
	total: number;
	visibleBars: number;
}

/** `total` points over the bars of `candles`, the same number in each, in time order. */
export function generateScatter(
	candles: CandleColumns,
	total: number,
	shape: ScatterShape,
	seed: number,
): ScatterInput {
	const random = new Random(seed);
	const bars = candles.length;
	const time = new Float64Array(total);
	const price = new Float64Array(total);
	const value = new Float32Array(total);
	let low = Infinity;
	let high = -Infinity;
	for (let i = 0; i < bars; i++) {
		low = Math.min(low, candles.low[i] ?? 0);
		high = Math.max(high, candles.high[i] ?? 0);
	}
	const interval = bars > 1 ? (candles.time[1] ?? 0) - (candles.time[0] ?? 0) : 60_000;
	const stamps = new Float64Array(Math.ceil(total / bars) + 1);
	let at = 0;
	for (let bar = 0; bar < bars; bar++) {
		const count = Math.floor(((bar + 1) * total) / bars) - at;
		for (let k = 0; k < count; k++) {
			stamps[k] = random.next() * interval;
		}
		const sorted = stamps.subarray(0, count);
		sorted.sort();
		const open = candles.open[bar] ?? 0;
		const close = candles.close[bar] ?? 0;
		for (let k = 0; k < count; k++) {
			time[at] = (candles.time[bar] ?? 0) + (sorted[k] ?? 0);
			price[at] =
				shape === 'cloud'
					? low + random.next() * (high - low)
					: open + ((close - open) * (sorted[k] ?? 0)) / interval + (random.next() - 0.5) * close * 0.0004;
			value[at] = 1 + Math.floor(random.next() ** 3 * 500);
			at++;
		}
	}
	return { time, price, value };
}

/** One column of `rows` cells per bar of `candles`: resting size around the bar's close, on a grid over all prices. */
export function generateHeatmap(candles: CandleColumns, rows: number, seed: number): HeatmapInput {
	const random = new Random(seed);
	const bars = candles.length;
	let low = Infinity;
	let high = -Infinity;
	for (let i = 0; i < bars; i++) {
		low = Math.min(low, candles.low[i] ?? 0);
		high = Math.max(high, candles.high[i] ?? 0);
	}
	const pad = (high - low) * 0.1;
	const priceStart = low - pad;
	const priceStep = (high - low + 2 * pad) / rows;
	const values = new Float32Array(bars * rows);
	// Levels of resting size that persist over time, as in an order book.
	const depth = new Float32Array(rows);
	for (let r = 0; r < rows; r++) {
		depth[r] = random.next() ** 4 * 100;
	}
	for (let bar = 0; bar < bars; bar++) {
		const mid = ((candles.close[bar] ?? 0) - priceStart) / priceStep;
		for (let r = 0; r < rows; r++) {
			if (random.next() < 0.002) {
				depth[r] = random.next() ** 4 * 100;
			}
			const distance = Math.abs(r - mid) / rows;
			values[bar * rows + r] = (depth[r] ?? 0) * (0.3 + distance * 4) + random.next() * 3;
		}
	}
	return { priceStart, priceStep, rows, time: candles.time.slice(), values };
}

function marksAdapter(adapter: object): MarksAdapter {
	if (!supports<MarksAdapter>(adapter, 'setScatter', 'appendScatter', 'setHeatmap', 'updateHeatmap', 'marksDrawn')) {
		throw new Error('This adapter has no scatter and heatmap series');
	}
	return adapter;
}

/**
 * A scatter or a heatmap over candles, one step per animation frame. The data set holds twice the
 * bars in view, so a pan goes one screen into history and half a screen beyond the first bar, and a
 * zoom from half the bars in view to all of them. Frame JavaScript time is the step and the draw.
 */
async function runMarks(job: ScatterJob | HeatmapJob, { factory, container }: RunContext): Promise<MarksRun> {
	const candles = generateSeries('candles', { seed: job.seed, count: job.dataset.size }) as CandleColumns;
	const adapter = await createSettled(factory, container, job.chart);
	const marks = marksAdapter(adapter);
	try {
		adapter.setData(prepare(adapter, candles));
		const n = candles.length;
		const visibleBars = Math.min(job.visibleBars, n);
		const interval = (candles.time[1] ?? 60_000) - (candles.time[0] ?? 0);
		let lastPointTime = 0;
		let total: number;
		let heat: HeatmapInput | null = null;
		if (job.scenario === 'scatter') {
			total = Math.round((job.points * n) / visibleBars);
			const points = generateScatter(candles, total, job.shape, job.seed + 5);
			lastPointTime = points.time[points.time.length - 1]!;
			marks.setScatter(points, job.pointSize);
		} else {
			heat = generateHeatmap(candles, job.rows, job.seed + 5);
			total = n * job.rows;
			marks.setHeatmap(heat);
		}
		await adapter.settle();
		const start = { from: n - visibleBars, to: n - 1 };
		adapter.setVisibleLogicalRange(start);
		await adapter.settle();
		const before = marks.marksDrawn();

		const steps = job.warmupFrames + job.frames + 2;
		const ranges =
			job.variant === 'tick' || job.variant === 'tick-redraw'
				? []
				: motionRanges(job.variant, n, visibleBars, steps, Math.max(1, job.frames / 4));
		const random = new Random(job.seed + 9);
		const lastTime = candles.time[n - 1] ?? 0;
		const lastClose = candles.close[n - 1] ?? 0;
		const column = heat === null ? null : heat.values.slice((n - 1) * heat.rows, n * heat.rows);
		const step = (k: number): void => {
			if (job.variant === 'tick-redraw' && k % 8 === 0) {
				const shift = (k / 8) % 2;
				adapter.setVisibleLogicalRange({ from: start.from - shift, to: start.to - shift });
			} else if (job.variant === 'pan' || job.variant === 'zoom') {
				adapter.setVisibleLogicalRange(ranges[k] ?? start);
			} else if (column === null) {
				// A trade inside the last bar, after the ones there are.
				marks.appendScatter(
					lastPointTime + interval * (k / 20_000),
					lastClose * (1 + (random.next() - 0.5) * 0.002),
					1 + Math.floor(random.next() * 500),
				);
			} else {
				// The last column again, with a few of its sizes changed.
				for (let i = 0; i < 8; i++) {
					column[Math.floor(random.next() * column.length)] = random.next() * 100;
				}
				marks.updateHeatmap(lastTime, column);
			}
		};

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
							window.markPassTimer?.start();
						}
					} else if (last === 0) {
						const measured = frame + 1 - first;
						if (measured >= job.frames || (measured >= job.minFrames && overBudget(measureStart, job.budgetMs, now))) {
							last = frame + 1;
						}
					} else if (frame === last) {
						markMeasured('end');
						window.markPassTimer?.stop();
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
		const gpuSamples = await window.markPassTimer?.read();
		const after = marks.marksDrawn();
		const backend = marks.markBackend?.();
		await adapter.settle();
		if (recording.timestamps.length < last) {
			throw new Error(`Recorded ${recording.timestamps.length} frames, expected at least ${last}`);
		}
		const jsTime: number[] = [];
		const intervals: number[] = [];
		for (let k = first; k < last; k++) {
			jsTime.push(recording.jsTime[k] ?? 0);
			intervals.push((recording.timestamps[k] ?? 0) - (recording.timestamps[k - 1] ?? 0));
		}
		return {
			...(backend
				? {
						backend: backend.effective,
						rendererPath: backend.path,
						rendererBytes: backend.bytes,
						rendererReason: backend.reason,
					}
				: {}),
			...(gpuSamples?.length ? { gpuPass: summarize(gpuSamples) } : {}),
			jsTime: summarize(jsTime),
			interval: summarize(intervals),
			frames: last - first,
			warmupFrames: first - 1,
			level: before.level,
			marks: before.marks,
			levelEnd: after.level,
			marksEnd: after.marks,
			total,
			visibleBars,
		};
	} finally {
		adapter.destroy();
	}
}

function marksHeadline(m: Metric): string {
	return (
		`JS mean ${ms(m('jsTime.mean'))} p50 ${ms(m('jsTime.p50'))} p95 ${ms(m('jsTime.p95'))}; ` +
		`${m('marks') ?? '–'} marks at level ${m('level') ?? '–'}; frames ${m('frames') ?? '–'}`
	);
}

function marksSection<J extends ScatterJob | HeatmapJob>(
	report: Report,
	scenario: string,
	label: (job: J) => string,
): string {
	const rows: string[][] = [];
	for (const c of eachCase<J>(report, scenario)) {
		rows.push([
			label(c.job),
			c.adapter,
			cell(c, 'jsTime.mean', MS),
			cell(c, 'jsTime.p50', MS),
			cell(c, 'jsTime.p95', MS),
			cell(c, 'jsTime.max', MS),
			cell(c, 'marks'),
			cell(c, 'level'),
			cell(c, 'total'),
			cell(c, 'frames'),
			hostIdle(c),
		]);
	}
	return table(
		[
			'Case',
			'Adapter',
			'JS mean (ms)',
			'p50',
			'p95',
			'max',
			'Marks in view',
			'Level',
			'Marks held',
			'Frames',
			'CPU idle',
		],
		rows,
	);
}

const REQUIRES = { capability: 'marks', reason: 'the library has no scatter and heatmap series' };

/** Bars in view of the scatter cases: about one per CSS pixel of the pane. */
const SCATTER_BARS = 1000;

interface ScatterCase {
	readonly points: number;
	readonly shape: ScatterShape;
	readonly variant: MarksVariant;
}

const SCATTER_CASES: readonly ScatterCase[] = [
	...[10 * K, 100 * K, 300 * K, M, 3 * M].flatMap(points =>
		(['pan', 'zoom'] as const).map(variant => ({ points, shape: 'cloud' as const, variant })),
	),
	{ points: M, shape: 'trades', variant: 'pan' },
	{ points: 5 * M, shape: 'trades', variant: 'pan' },
	{ points: 100 * K, shape: 'cloud', variant: 'tick' },
	{ points: M, shape: 'cloud', variant: 'tick' },
	{ points: M, shape: 'cloud', variant: 'tick-redraw' },
];
const QUICK_SCATTER_CASES: readonly ScatterCase[] = [
	{ points: 10 * K, shape: 'cloud', variant: 'pan' },
	{ points: 10 * K, shape: 'trades', variant: 'tick' },
];

function frameBudgets(quick: boolean): Pick<MarksJobBase, 'frames' | 'minFrames' | 'warmupFrames'> {
	return { frames: quick ? 40 : 240, minFrames: quick ? 15 : 30, warmupFrames: quick ? 8 : 30 };
}

export const scatter = defineScenario<ScatterJob, MarksRun>({
	name: 'scatter',
	order: 170,
	requires: REQUIRES,
	plan({ quick, chart, seed, budgetMs, warmupBudgetMs, keep }) {
		const dataset: DatasetSpec = { kind: 'candles', size: 2 * SCATTER_BARS };
		if (!keep(dataset)) {
			return [];
		}
		const cases: JobCase<ScatterJob>[] = [];
		for (const { points, shape, variant } of quick ? QUICK_SCATTER_CASES : SCATTER_CASES) {
			cases.push({
				scenario: 'scatter',
				dataset,
				seed,
				chart,
				points,
				shape,
				variant,
				pointSize: 1.5,
				visibleBars: SCATTER_BARS,
				budgetMs,
				warmupBudgetMs,
				...frameBudgets(quick),
			});
		}
		return cases;
	},
	caseParts: job => [`${job.shape}-${sizeLabel(job.points)}`, job.variant],
	run: runMarks,
	headline: marksHeadline,
	sections: [
		{
			title: 'Scatter series: pan, zoom and appended points',
			render: report =>
				marksSection<ScatterJob>(
					report,
					'scatter',
					job => `${job.variant}, ${sizeLabel(job.points)} points in view (${job.shape})`,
				),
		},
	],
});

interface HeatmapCase {
	readonly columns: number;
	readonly rows: number;
	readonly variant: MarksVariant;
}

const HEATMAP_CASES: readonly HeatmapCase[] = [
	...(
		[
			[240, 60],
			[1200, 200],
			[2400, 600],
			[4800, 1200],
		] as const
	).flatMap(([columns, rows]) => (['pan', 'zoom'] as const).map(variant => ({ columns, rows, variant }))),
	{ columns: 1200, rows: 200, variant: 'tick' },
	{ columns: 2400, rows: 600, variant: 'tick' },
	{ columns: 2400, rows: 600, variant: 'tick-redraw' },
];
const QUICK_HEATMAP_CASES: readonly HeatmapCase[] = [
	{ columns: 240, rows: 60, variant: 'pan' },
	{ columns: 240, rows: 60, variant: 'tick' },
];

export const heatmap = defineScenario<HeatmapJob, MarksRun>({
	name: 'heatmap',
	order: 171,
	requires: REQUIRES,
	plan({ quick, chart, seed, budgetMs, warmupBudgetMs, keep }) {
		const cases: JobCase<HeatmapJob>[] = [];
		for (const { columns, rows, variant } of quick ? QUICK_HEATMAP_CASES : HEATMAP_CASES) {
			const dataset: DatasetSpec = { kind: 'candles', size: 2 * columns };
			if (keep(dataset)) {
				cases.push({
					scenario: 'heatmap',
					dataset,
					seed,
					chart,
					variant,
					rows,
					visibleBars: columns,
					budgetMs,
					warmupBudgetMs,
					...frameBudgets(quick),
				});
			}
		}
		return cases;
	},
	caseParts: job => [`${job.visibleBars}x${job.rows}`, job.variant],
	run: runMarks,
	headline: marksHeadline,
	sections: [
		{
			title: 'Heatmap series: pan, zoom and a changing last column',
			render: report =>
				marksSection<HeatmapJob>(
					report,
					'heatmap',
					job => `${job.variant}, ${job.visibleBars} x ${job.rows} cells in view`,
				),
		},
	],
});
