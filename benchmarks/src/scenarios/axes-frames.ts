// The stage 4 price axes scenario: pan and zoom with three moving averages on price axes laid out
// four ways.

import { supports } from '../adapter.ts';
import { type DatasetSpec, type JobCase, M } from '../jobs.ts';
import { defineScenario } from '../scenario.ts';
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
import { QUICK_INDICATOR_DATASETS, withIndicators } from './indicators.ts';

/**
 * How the stage 4 price axes scenario lays out its series, candles and three moving averages (the
 * first three of the indicator set): all on one normal scale (`one`, the reference), the same on a
 * logarithmic (`log`) or a percentage scale (`percent`), or each average on an axis of its own, two
 * left of the pane and one right of the candles' axis (`four`).
 */
export type PriceAxesLayout = 'one' | 'log' | 'percent' | 'four';
export const PRICE_AXES_LAYOUTS: readonly PriceAxesLayout[] = ['one', 'log', 'percent', 'four'];

/** An adapter that can lay out price axes. */
export interface PriceAxesAdapter {
	/**
	 * Lays out the price axes of the series and indicators the next `setData` creates, as `layout`
	 * says (see `PriceAxesLayout`). Called before `setData`.
	 */
	withPriceAxes(layout: PriceAxesLayout): void;
}

/** Pan and zoom frames with the series on price axes laid out as `axes` says. */
export interface AxesFramesJob extends Omit<FramesJob, 'scenario'> {
	readonly scenario: 'axes-frames';
	readonly indicators: number;
	readonly axes: PriceAxesLayout;
}

// Stage 4: three moving averages on the candles, on price axes laid out four ways.
const AXES_DATASETS: readonly DatasetSpec[] = [{ kind: 'candles', size: M }];
const AXES_ZOOMS: readonly ZoomLevel[] = [200, 'all'];
const AXES_INDICATORS = 3;

export const axesFrames = defineScenario<AxesFramesJob, FramesRun>({
	name: 'axes-frames',
	order: 100,
	requires: { capability: 'priceAxes', reason: 'the adapter cannot lay out price axes' },
	plan({ quick, chart, seed, budgetMs, warmupBudgetMs, keep }) {
		const cases: JobCase<AxesFramesJob>[] = [];
		for (const dataset of (quick ? QUICK_INDICATOR_DATASETS : AXES_DATASETS).filter(keep)) {
			for (const zoom of quick ? QUICK_FRAME_ZOOMS : AXES_ZOOMS) {
				for (const motion of MOTIONS) {
					for (const axes of PRICE_AXES_LAYOUTS) {
						cases.push({
							scenario: 'axes-frames',
							dataset,
							seed,
							chart,
							indicators: AXES_INDICATORS,
							axes,
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
		}
		return cases;
	},
	caseParts: job => [motionLabel(job), job.axes],
	run: (job, context) =>
		runFrames(job, context, adapter => {
			withIndicators(adapter, job.indicators);
			if (!supports<PriceAxesAdapter>(adapter, 'withPriceAxes')) {
				throw new Error('This adapter cannot lay out price axes');
			}
			adapter.withPriceAxes(job.axes);
		}),
	headline: framesHeadline,
	sections: [
		{
			title: 'Price axes: pan and zoom frames (three averages on the candles)',
			render: report => framesSection<AxesFramesJob>(report, 'axes-frames', job => `, ${job.axes}`),
		},
	],
});
