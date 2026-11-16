// Steps of the in-page runs that several scenarios share.

import type { AdapterFactory, ChartAdapter, ChartSize, LogicalRange } from '../adapter.ts';
import type { SeriesColumns } from '../data.ts';
import { type Distribution, summarize } from '../stats.ts';
import { countDrawCalls } from './draw-calls.ts';
import { frameJsTotal } from './frames.ts';

/** Bars in view in the `latest` tick view. */
export const LATEST_VIEW_BARS = 200;
/** Warm-up frames a frames run drops even when its warm-up budget is spent. */
export const MIN_WARMUP_FRAMES = 3;

/** Whether `budgetMs` (0: unlimited) has passed since `start`. */
export function overBudget(start: number, budgetMs: number, now = performance.now()): boolean {
	return budgetMs > 0 && now - start >= budgetMs;
}

export function prepare(adapter: ChartAdapter, data: SeriesColumns): unknown {
	return data.kind === 'candles' ? adapter.prepareCandles(data) : adapter.prepareLine(data);
}

/** Creates a chart and waits until its empty state is painted, so creation is not part of a load. */
export async function createSettled(
	factory: AdapterFactory,
	container: HTMLElement,
	size: ChartSize,
): Promise<ChartAdapter> {
	const adapter = await factory.create(container, size);
	await adapter.settle();
	return adapter;
}

/** Each change timed from the call until `settle()` resolves with it drawn. */
export interface ChangeTimings {
	/** The synchronous call. */
	callMs: Distribution;
	/** JavaScript in animation-frame callbacks until settled: the redraw. */
	frameJsMs: Distribution;
	/** callMs + frameJsMs: the main thread's work for the change. */
	workMs: Distribution;
	/** Wall time until settled, which includes waiting for the next frame. */
	shownMs: Distribution;
}

/** Times one change of options from the call until it is drawn. */
export async function timeChange(adapter: ChartAdapter, change: () => void): Promise<[number, number, number]> {
	const js = frameJsTotal();
	const t0 = performance.now();
	change();
	const t1 = performance.now();
	await adapter.settle();
	const t2 = performance.now();
	return [t1 - t0, frameJsTotal() - js, t2 - t0];
}

export function changeTimings(samples: readonly [number, number, number][]): ChangeTimings {
	return {
		callMs: summarize(samples.map(sample => sample[0])),
		frameJsMs: summarize(samples.map(sample => sample[1])),
		workMs: summarize(samples.map(sample => sample[0] + sample[1])),
		shownMs: summarize(samples.map(sample => sample[2])),
	};
}

/**
 * Counts the Canvas 2D calls of one redraw at `range`, untimed. The first move makes sure the
 * counted one changes the view, and lets a library fetch any rows the view needs beforehand.
 */
export async function countRedraw(adapter: ChartAdapter, range: LogicalRange): Promise<Record<string, number>> {
	adapter.setVisibleLogicalRange({ from: range.from + 0.5, to: range.to + 0.5 });
	await adapter.settle();
	return countDrawCalls(async () => {
		adapter.setVisibleLogicalRange(range);
		await adapter.settle();
	});
}

export function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
