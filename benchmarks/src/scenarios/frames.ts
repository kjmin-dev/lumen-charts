// Pan and zoom, one step per animation frame.

import { generateSeries } from '../data.ts';
import { ms } from '../format.ts';
import { requestTimedFrame, startFrameRecording, stopFrameRecording } from '../harness/frames.ts';
import { markMeasured } from '../harness/marks.ts';
import { MIN_WARMUP_FRAMES, countRedraw, createSettled, overBudget, prepare } from '../harness/steps.ts';
import { type DatasetSpec, type JobBase, type JobCase, K, M, datasetLabel, sizeLabel } from '../jobs.ts';
import { type Motion, motionRanges } from '../motion.ts';
import { MS, type Report, casesOf, cell, eachCase, hostIdle, runsNote, seriesCall, table } from '../report.ts';
import { type Metric, type RunContext, defineScenario } from '../scenario.ts';
import { type Distribution, summarize } from '../stats.ts';
import type { ChartSetup } from './load.ts';

/** Number of bars in view, or `all` for every bar of the data set. */
export type ZoomLevel = number | 'all';

export interface FramesJob extends JobBase {
	readonly scenario: 'frames';
	readonly zoom: ZoomLevel;
	readonly motion: Motion;
	/** Measured frames: the most a run measures. */
	readonly frames: number;
	/**
	 * Measuring stops after the first frame that starts `budgetMs` or later after measuring started,
	 * once at least `minFrames` frames are measured. A budget of 0 always measures `frames`.
	 */
	readonly minFrames: number;
	readonly budgetMs: number;
	/** Frames dropped before measuring: the most a run drops. */
	readonly warmupFrames: number;
	/** Warm-up stops after the first frame that starts this long after it started (at least 3 frames). 0: no limit. */
	readonly warmupBudgetMs: number;
}

/** The parameters of a frames run, for the scenarios that run it on a chart set up their way. */
export type FramesParams = Omit<FramesJob, 'scenario'>;

export interface FramesRun {
	/** JavaScript time spent in animation-frame callbacks, per frame. */
	jsTime: Distribution;
	/** Interval between consecutive frames' rAF timestamps. */
	interval: Distribution;
	/** Frames in which the library ran at least one animation-frame callback (expected: all). */
	framesWithLibraryWork: number;
	/** Visible bars at the start of the motion. */
	visibleBars: number;
	/** Warm-up frames dropped (fewer than the job's when its warm-up budget ran out). */
	warmupFrames: number;
	/**
	 * Canvas 2D calls in one redraw at the starting range, counted in a separate untimed pass after
	 * the measurement (the counting wrappers would slow the measured frames down). Shows how much the
	 * library draws, for example whether conflation merged bars. Empty for libraries that do not
	 * draw with Canvas 2D.
	 */
	drawCalls: Record<string, number>;
}

// 10M line points are the data set of the stage 2 gate (design section 9).
const FRAME_DATASETS: readonly DatasetSpec[] = [
	{ kind: 'candles', size: M },
	{ kind: 'line', size: 10 * M },
];
// Levels at or above the data set size are left out, so 2M only applies to 10M points.
const FRAME_ZOOMS: readonly ZoomLevel[] = [200, 2_000, 20_000, 200_000, 2 * M, 'all'];
export const MOTIONS: readonly Motion[] = ['pan', 'zoom'];
export const QUICK_FRAME_DATASETS: readonly DatasetSpec[] = [
	{ kind: 'candles', size: 10 * K },
	{ kind: 'line', size: 10 * K },
];
export const QUICK_FRAME_ZOOMS: readonly ZoomLevel[] = [200, 'all'];

/** A zoom level as case ids have it. */
export function zoomLabel(zoom: ZoomLevel): string {
	return zoom === 'all' ? 'all' : sizeLabel(zoom);
}

/** Motion and zoom level as case ids have them. */
export function motionLabel(job: FramesParams): string {
	return `${job.motion}-${zoomLabel(job.zoom)}`;
}

export async function runFrames(
	job: FramesParams,
	{ factory, container }: RunContext,
	setup?: ChartSetup,
): Promise<FramesRun> {
	const data = generateSeries(job.dataset.kind, { seed: job.seed, count: job.dataset.size });
	const adapter = await createSettled(factory, container, job.chart);
	try {
		setup?.(adapter);
		adapter.setData(prepare(adapter, data));
		await adapter.settle();
		const n = data.length;
		const visibleBars = job.zoom === 'all' ? n : Math.min(job.zoom, n);
		// Step 0 is applied before recording; each later step runs in its own animation frame.
		const steps = job.warmupFrames + job.frames + 2;
		const ranges = motionRanges(job.motion, n, visibleBars, steps, Math.max(1, Math.round(job.frames / 4)));
		adapter.setVisibleLogicalRange(ranges[0] ?? { from: 0, to: n - 1 });
		await adapter.settle();

		// Recorded frame k holds the library's draw for step k and the harness call for step k + 1.
		// Frame 0 has no draw yet and the final frame no harness call; both are dropped together with
		// the warm-up frames. Measured frames are [first, last); both are decided while running.
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
						// The library has drawn in this frame already: its callbacks were requested first.
						const measured = frame + 1 - first;
						if (measured >= job.frames || (measured >= job.minFrames && overBudget(measureStart, job.budgetMs, now))) {
							last = frame + 1;
						}
					} else if (frame === last) {
						markMeasured('end');
						resolve();
						return;
					}
					const range = ranges[frame + 1];
					if (range === undefined) {
						reject(new Error(`No motion step for frame ${frame + 1}`));
						return;
					}
					try {
						adapter.setVisibleLogicalRange(range);
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
		const jsTime: number[] = [];
		const interval: number[] = [];
		let framesWithLibraryWork = 0;
		for (let k = first; k < last; k++) {
			jsTime.push(recording.jsTime[k] ?? 0);
			interval.push((recording.timestamps[k] ?? 0) - (recording.timestamps[k - 1] ?? 0));
			if ((recording.libraryCallbacks[k] ?? 0) > 0) {
				framesWithLibraryWork++;
			}
		}

		// Untimed: one redraw at the starting range, with drawing calls counted.
		const drawCalls = await countRedraw(adapter, ranges[0] ?? { from: 0, to: n - 1 });

		return {
			jsTime: summarize(jsTime),
			interval: summarize(interval),
			framesWithLibraryWork,
			visibleBars,
			warmupFrames: first - 1,
			drawCalls,
		};
	} finally {
		adapter.destroy();
	}
}

export function framesHeadline(m: Metric): string {
	return (
		`JS p50 ${ms(m('jsTime.p50'))} p95 ${ms(m('jsTime.p95'))}; ` +
		`interval p50 ${ms(m('interval.p50'))} p95 ${ms(m('interval.p95'))}`
	);
}

/** The table of a frames scenario. `detail` adds what tells its cases apart to the motion and zoom level. */
export function framesSection<J extends FramesParams & { scenario: string } = FramesJob>(
	report: Report,
	scenario: string,
	detail: (job: J) => string = () => '',
): string {
	const list = casesOf(report, scenario);
	const rows: string[][] = [];
	for (const c of eachCase<J>(report, scenario)) {
		const { adapter } = c;
		const zoom = c.job.zoom === 'all' ? `all ${datasetLabel(c.job.dataset)}` : String(c.job.zoom);
		rows.push([
			`${c.job.motion} ${zoom}${detail(c.job)}`,
			adapter,
			cell(c, 'jsTime.mean', MS),
			cell(c, 'jsTime.p50', MS),
			cell(c, 'jsTime.p95', MS),
			cell(c, 'jsTime.p99', MS),
			cell(c, 'jsTime.max', MS),
			cell(c, 'interval.mean', MS),
			cell(c, 'interval.p50', MS),
			cell(c, 'interval.p95', MS),
			cell(c, 'interval.p99', MS),
			cell(c, 'interval.max', MS),
			`${seriesCall(c)} ${cell(c, `drawCalls.${seriesCall(c)}`)}`,
			cell(c, 'jsTime.count'),
			hostIdle(c),
		]);
	}
	return (
		table(
			[
				'Motion, bars in view',
				'Adapter',
				'JS avg',
				'JS p50',
				'JS p95',
				'JS p99',
				'JS max',
				'Interval avg',
				'Interval p50',
				'Interval p95',
				'Interval p99',
				'Interval max',
				'Series calls per redraw',
				'Frames measured',
				'Host CPU idle',
			],
			rows,
		) + `\nAll times in ms. ${runsNote(list)}\n`
	);
}

export const frames = defineScenario<FramesJob, FramesRun>({
	name: 'frames',
	order: 30,
	plan({ quick, chart, seed, budgetMs, warmupBudgetMs, keep }) {
		const cases: JobCase<FramesJob>[] = [];
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
	caseParts: job => [motionLabel(job)],
	run: (job, context) => runFrames(job, context),
	headline: framesHeadline,
	sections: [{ title: 'Pan and zoom frames', render: report => framesSection(report, 'frames') }],
});
