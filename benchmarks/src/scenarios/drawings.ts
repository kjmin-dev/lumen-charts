// The stage 4 drawings scenario: hover, drag and pan with drawings on the chart.

import { supports } from '../adapter.ts';
import { type CandleColumns, generateSeries } from '../data.ts';
import { type BenchDrawing, generateDrawings } from '../drawings.ts';
import { ms } from '../format.ts';
import { requestTimedFrame, startFrameRecording, stopFrameRecording } from '../harness/frames.ts';
import { markMeasured } from '../harness/marks.ts';
import { MIN_WARMUP_FRAMES, createSettled, overBudget, prepare } from '../harness/steps.ts';
import { type DatasetSpec, type JobBase, type JobCase, K, M, datasetLabel } from '../jobs.ts';
import { motionRanges } from '../motion.ts';
import { type Report, US, cell, eachCase, hostIdle, median, table } from '../report.ts';
import { type RunContext, defineScenario } from '../scenario.ts';
import { type Distribution, summarize } from '../stats.ts';

/** A library with drawings. */
export interface DrawingsAdapter {
	/** Adds drawings to the chart. */
	addDrawings(drawings: readonly BenchDrawing[]): void;
	/** The element pointer events go to, to hover and drag drawings. */
	pointerTarget(): HTMLElement;
	/**
	 * The library's public hit test of drawings at `(x, y)`, CSS pixels from the top left corner of
	 * `pointerTarget`: whether a drawing is there.
	 */
	hitTestDrawing(x: number, y: number): boolean;
}

/**
 * What a drawings case does, one step per frame with `drawings` drawings on the chart (see
 * `generateDrawings`): `hover` moves the pointer over the pane along a fixed path, `drag` drags one
 * drawing in view along the same path, `pan` pans as the frames scenario does.
 */
export type DrawingsVariant = 'hover' | 'drag' | 'pan';

/**
 * The stage 4 gate: with 1,000 drawings, hover handling p99 within 1 ms (design section 9). Half the
 * drawings are in view and half in older history; the pointer moves once per frame.
 */
export interface DrawingsJob extends JobBase {
	readonly scenario: 'drawings';
	readonly variant: DrawingsVariant;
	readonly drawings: number;
	/** Bars in view: the last ones of the data set. */
	readonly visibleBars: number;
	/** Measured frames: the most a run measures. */
	readonly frames: number;
	readonly minFrames: number;
	readonly budgetMs: number;
	readonly warmupFrames: number;
	readonly warmupBudgetMs: number;
}

export interface DrawingsRun {
	/**
	 * JavaScript time of each frame: the pointer event (`hover`, `drag`) or the view change (`pan`),
	 * and the chart's work for it in the animation frame: hit testing and the overlay for a hover,
	 * the edited drawing for a drag, every layer for a pan.
	 */
	frameJs: Distribution;
	/**
	 * `hover` only: one hit test at each position of the path through the library's public hit test,
	 * timed alone after the frames, on the same drawings and view. This is the hit test the hover
	 * does.
	 */
	hitTest: Distribution | null;
	/** `hover` only: mean of a hit test over 20 passes of the whole path, which timer resolution does not limit. */
	hitTestMean: number | null;
	/**
	 * `hover` only: the frame's time minus the hit test at its position: the overlay redraw and the
	 * rest of the frame (pointer event, layout read).
	 */
	redraw: Distribution | null;
	/** `hover` only: positions of the path where a drawing was hit. */
	hits: number | null;
	interval: Distribution;
	frames: number;
	warmupFrames: number;
	drawings: number;
	/** Drawings whose time range overlaps the view at the start. */
	drawingsInView: number;
	visibleBars: number;
}

interface DrawingsCase {
	readonly drawings: number;
	readonly variant: DrawingsVariant;
}

// 1,000 drawings is the gate; hovering a chart without drawings is the crosshair alone, for scale.
export const DRAWINGS_DATASET: DatasetSpec = { kind: 'candles', size: M };
const DRAWINGS_CASES: readonly DrawingsCase[] = [
	{ drawings: 1000, variant: 'hover' },
	{ drawings: 0, variant: 'hover' },
	{ drawings: 1000, variant: 'drag' },
	{ drawings: 1000, variant: 'pan' },
];
export const QUICK_DRAWINGS_DATASET: DatasetSpec = { kind: 'candles', size: 10 * K };
const QUICK_DRAWINGS_CASES: readonly DrawingsCase[] = [
	{ drawings: 100, variant: 'hover' },
	{ drawings: 100, variant: 'drag' },
];

/** Path of the pointer over the pane at step `k`: two sines of different periods, so it sweeps the pane. */
function pathPoint(k: number, rect: DOMRect, out: { x: number; y: number }): void {
	// The pane is the chart without its axes, which take the right and bottom edge.
	out.x = rect.left + rect.width * (0.45 + 0.4 * Math.sin((2 * Math.PI * k) / 97));
	out.y = rect.top + rect.height * (0.45 + 0.4 * Math.sin((2 * Math.PI * k) / 61));
}

function pointerEvent(type: string, x: number, y: number, pressed: boolean): PointerEvent {
	return new PointerEvent(type, {
		clientX: x,
		clientY: y,
		pointerId: 1,
		pointerType: 'mouse',
		isPrimary: true,
		button: type === 'pointermove' ? -1 : 0,
		buttons: pressed ? 1 : 0,
		bubbles: true,
		cancelable: true,
	});
}

/**
 * Drawings on a 1M-candle chart, one step per animation frame: the pointer hovering along a path
 * (the stage 4 gate), dragging a drawing along it, or a pan. Frame JavaScript time includes the
 * pointer event, which the harness dispatches in a timed frame callback, and the chart's draw for
 * it. For hovers, the library's public hit test is then timed alone at every position of the path.
 */
async function runDrawings(job: DrawingsJob, { factory, container }: RunContext): Promise<DrawingsRun> {
	const data = generateSeries('candles', { seed: job.seed, count: job.dataset.size }) as CandleColumns;
	const adapter = await createSettled(factory, container, job.chart);
	if (!supports<DrawingsAdapter>(adapter, 'addDrawings', 'pointerTarget', 'hitTestDrawing')) {
		throw new Error('This adapter has no drawings');
	}
	const { addDrawings, pointerTarget, hitTestDrawing } = adapter;
	try {
		adapter.setData(prepare(adapter, data));
		await adapter.settle();
		const n = data.length;
		const visibleBars = Math.min(job.visibleBars, n);
		const view = { from: n - visibleBars, to: n - 1 };
		adapter.setVisibleLogicalRange(view);
		await adapter.settle();
		const generated = generateDrawings(data, job.drawings, view.from, view.to, job.seed + 3);
		addDrawings.call(adapter, generated);
		await adapter.settle();

		const target = pointerTarget.call(adapter);
		// Read once, before measuring: the page does not scroll during the run.
		const rect = target.getBoundingClientRect();
		const point = { x: 0, y: 0 };
		const steps = job.warmupFrames + job.frames + 2;
		const ranges = job.variant === 'pan' ? motionRanges('pan', n, visibleBars, steps, 1) : [];
		// A drag starts on a drawing in view: the first point of the path where the hit test finds one.
		let pressAt = 0;
		if (job.variant === 'drag') {
			while (pressAt < 2000) {
				pathPoint(pressAt, rect, point);
				if (hitTestDrawing.call(adapter, point.x - rect.left, point.y - rect.top)) {
					break;
				}
				pressAt++;
			}
			if (pressAt === 2000) {
				throw new Error('No drawing on the path to drag');
			}
			target.dispatchEvent(pointerEvent('pointerdown', point.x, point.y, true));
			await adapter.settle();
		}
		const step = (k: number): void => {
			if (job.variant === 'pan') {
				adapter.setVisibleLogicalRange(ranges[k] ?? view);
				return;
			}
			pathPoint(pressAt + k, rect, point);
			target.dispatchEvent(pointerEvent('pointermove', point.x, point.y, job.variant === 'drag'));
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
		if (job.variant === 'drag') {
			target.dispatchEvent(pointerEvent('pointerup', point.x, point.y, false));
			await adapter.settle();
		}
		if (recording.timestamps.length < last) {
			throw new Error(`Recorded ${recording.timestamps.length} frames, expected at least ${last}`);
		}
		const frameJs: number[] = [];
		const interval: number[] = [];
		for (let k = first; k < last; k++) {
			frameJs.push(recording.jsTime[k] ?? 0);
			interval.push((recording.timestamps[k] ?? 0) - (recording.timestamps[k - 1] ?? 0));
		}

		let hitTest: DrawingsRun['hitTest'] = null;
		let hitTestMean: number | null = null;
		let redraw: DrawingsRun['redraw'] = null;
		let hits: number | null = null;
		if (job.variant === 'hover') {
			// Frame k drew the hover of step k: the same positions, hit-tested alone.
			const single: number[] = [];
			const rest: number[] = [];
			hits = 0;
			for (let k = first; k < last; k++) {
				pathPoint(k, rect, point);
				const x = point.x - rect.left;
				const y = point.y - rect.top;
				const t0 = performance.now();
				const hit = hitTestDrawing.call(adapter, x, y);
				const time = performance.now() - t0;
				single.push(time);
				rest.push(Math.max(0, (recording.jsTime[k] ?? 0) - time));
				if (hit) {
					hits++;
				}
			}
			const passes = 20;
			const t0 = performance.now();
			for (let pass = 0; pass < passes; pass++) {
				for (let k = first; k < last; k++) {
					pathPoint(k, rect, point);
					hitTestDrawing.call(adapter, point.x - rect.left, point.y - rect.top);
				}
			}
			hitTestMean = (performance.now() - t0) / (passes * (last - first));
			hitTest = summarize(single);
			redraw = summarize(rest);
		}
		return {
			frameJs: summarize(frameJs),
			hitTest,
			hitTestMean,
			redraw,
			hits,
			interval: summarize(interval),
			frames: last - first,
			warmupFrames: first - 1,
			drawings: generated.length,
			drawingsInView: generated.filter(drawing => drawing.inView).length,
			visibleBars,
		};
	} finally {
		adapter.destroy();
	}
}

function drawingsSection(report: Report): string {
	const rows: string[][] = [];
	for (const c of eachCase<DrawingsJob>(report, 'drawings')) {
		const { adapter } = c;
		rows.push([
			`${c.job.variant}, ${c.job.drawings} drawings (${median(c, 'drawingsInView') ?? '–'} in view), ` +
				`${datasetLabel(c.job.dataset)}, ${c.job.visibleBars} bars in view`,
			adapter,
			cell(c, 'frameJs.p50', US),
			cell(c, 'frameJs.p95', US),
			cell(c, 'frameJs.p99', US),
			cell(c, 'frameJs.max', US),
			cell(c, 'hitTestMean', US),
			cell(c, 'hitTest.p99', US),
			cell(c, 'redraw.p50', US),
			cell(c, 'redraw.p99', US),
			cell(c, 'hits'),
			cell(c, 'frames'),
			hostIdle(c),
		]);
	}
	return table(
		[
			'Case',
			'Adapter',
			'Frame JS p50 (µs)',
			'p95 (µs)',
			'p99 (µs)',
			'max (µs)',
			'Hit test mean (µs)',
			'Hit test p99 (µs)',
			'Rest of frame p50 (µs)',
			'p99 (µs)',
			'Hits',
			'Frames',
			'CPU idle',
		],
		rows,
	);
}

export const drawings = defineScenario<DrawingsJob, DrawingsRun>({
	name: 'drawings',
	order: 120,
	requires: { capability: 'drawings', reason: 'the library has no drawings' },
	plan({ quick, chart, seed, budgetMs, warmupBudgetMs, keep }) {
		const cases: JobCase<DrawingsJob>[] = [];
		const dataset = quick ? QUICK_DRAWINGS_DATASET : DRAWINGS_DATASET;
		if (keep(dataset)) {
			for (const { drawings: count, variant } of quick ? QUICK_DRAWINGS_CASES : DRAWINGS_CASES) {
				cases.push({
					scenario: 'drawings',
					dataset,
					seed,
					chart,
					variant,
					drawings: count,
					visibleBars: 300,
					frames: quick ? 60 : 600,
					minFrames: quick ? 20 : 120,
					budgetMs,
					warmupFrames: quick ? 10 : 60,
					warmupBudgetMs,
				});
			}
		}
		return cases;
	},
	caseParts: job => [job.drawings, job.variant],
	run: runDrawings,
	headline(m) {
		return (
			`frame JS p50 ${ms(m('frameJs.p50'))} p99 ${ms(m('frameJs.p99'))} max ${ms(m('frameJs.max'))}` +
			(m('hitTest.p99') === undefined
				? ''
				: `; hit test mean ${ms(m('hitTestMean'))} p99 ${ms(m('hitTest.p99'))}; ` +
					`redraw p50 ${ms(m('redraw.p50'))} p99 ${ms(m('redraw.p99'))}; hits ${m('hits') ?? '–'}`) +
			`; frames ${m('frames') ?? '–'}`
		);
	},
	sections: [{ title: 'Drawings: hover, drag and pan with drawings on the chart', render: drawingsSection }],
});
