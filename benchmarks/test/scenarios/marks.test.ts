import { describe, expect, it } from 'vitest';
import { knownFailure } from '../../src/adapters/index.ts';
import { type CandleColumns, generateSeries } from '../../src/data.ts';
import type { PlanOptions } from '../../src/jobs.ts';
import { planJobs } from '../../src/plan.ts';
import { type HeatmapJob, generateHeatmap, generateScatter } from '../../src/scenarios/marks.ts';

const base: PlanOptions = {
	scenarios: [],
	adapters: ['a'],
	sizes: [],
	kinds: [],
	repeats: 1,
	quick: false,
	chart: { width: 1200, height: 600 },
	seed: 1,
};

/** The highest price less the lowest. */
function spread(prices: Float64Array): number {
	return Math.max(...prices) - Math.min(...prices);
}

describe('scatter and heatmap scenarios', () => {
	it('plans the scatter cases by points in view, and skips a library without such series', () => {
		const { jobs } = planJobs({ ...base, scenarios: ['scatter'] });
		expect(jobs.map(p => p.caseId)).toEqual([
			'scatter/candles-2k/cloud-10k/pan',
			'scatter/candles-2k/cloud-10k/zoom',
			'scatter/candles-2k/cloud-100k/pan',
			'scatter/candles-2k/cloud-100k/zoom',
			'scatter/candles-2k/cloud-300k/pan',
			'scatter/candles-2k/cloud-300k/zoom',
			'scatter/candles-2k/cloud-1m/pan',
			'scatter/candles-2k/cloud-1m/zoom',
			'scatter/candles-2k/cloud-3m/pan',
			'scatter/candles-2k/cloud-3m/zoom',
			'scatter/candles-2k/trades-1m/pan',
			'scatter/candles-2k/trades-5m/pan',
			'scatter/candles-2k/cloud-100k/tick',
			'scatter/candles-2k/cloud-1m/tick',
			'scatter/candles-2k/cloud-1m/tick-redraw',
		]);
		expect(knownFailure('lumen-worker', { kind: 'candles', size: 2000 }, 'scatter')).toBeNull();
		expect(knownFailure('lwc-conflation-on', { kind: 'candles', size: 2000 }, 'scatter')).toMatch(/scatter/);
	});

	it('plans the heatmap cases by cells in view, with twice the columns in the data set', () => {
		const { jobs } = planJobs({ ...base, scenarios: ['heatmap'] });
		expect(jobs.map(p => p.caseId)).toEqual([
			'heatmap/candles-480/240x60/pan',
			'heatmap/candles-480/240x60/zoom',
			'heatmap/candles-2400/1200x200/pan',
			'heatmap/candles-2400/1200x200/zoom',
			'heatmap/candles-4800/2400x600/pan',
			'heatmap/candles-4800/2400x600/zoom',
			'heatmap/candles-9600/4800x1200/pan',
			'heatmap/candles-9600/4800x1200/zoom',
			'heatmap/candles-2400/1200x200/tick',
			'heatmap/candles-4800/2400x600/tick',
			'heatmap/candles-4800/2400x600/tick-redraw',
			'heatmap/candles-4800/2400x600-fixed/pan',
			'heatmap/candles-4800/2400x600-fixed/zoom',
			'heatmap/candles-4800/2400x600-fixed/tick',
		]);
		const fixed = planJobs({ ...base, scenarios: ['heatmap'], cases: ['heatmap/candles-4800/2400x600-fixed'] }).jobs;
		expect(fixed.map(p => (p.job as HeatmapJob).valueRange)).toEqual([
			{ min: 0, max: 200 },
			{ min: 0, max: 200 },
			{ min: 0, max: 200 },
		]);
		expect(planJobs({ ...base, quick: true, scenarios: ['scatter', 'heatmap'] }).jobs.length).toBe(4);
	});

	it('generates scatter points in time order, the same number in every bar', () => {
		const candles = generateSeries('candles', { seed: 1, count: 50 }) as CandleColumns;
		const cloud = generateScatter(candles, 5000, 'cloud', 3);
		expect(cloud.time.length).toBe(5000);
		let ordered = true;
		for (let i = 1; i < 5000; i++) {
			ordered &&= cloud.time[i]! >= cloud.time[i - 1]!;
		}
		expect(ordered).toBe(true);
		// 100 per bar, each inside its bar's minute.
		expect(cloud.time[99]!).toBeLessThan(candles.time[1]!);
		expect(cloud.time[100]!).toBeGreaterThanOrEqual(candles.time[1]!);
		// Trades stay near the price of their bar; a cloud spans the range of all bars.
		const trades = generateScatter(candles, 5000, 'trades', 3);
		expect(spread(trades.price.subarray(0, 100))).toBeLessThan(spread(cloud.price.subarray(0, 100)));
		expect(generateScatter(candles, 5000, 'cloud', 3).price).toEqual(cloud.price);
	});

	it('generates a heatmap column per bar on a grid that holds every price', () => {
		const candles = generateSeries('candles', { seed: 1, count: 50 }) as CandleColumns;
		const heat = generateHeatmap(candles, 20, 3);
		expect(heat.rows).toBe(20);
		expect(heat.values.length).toBe(50 * 20);
		expect([...heat.time]).toEqual([...candles.time]);
		expect(heat.priceStart).toBeLessThan(Math.min(...candles.low));
		expect(heat.priceStart + heat.rows * heat.priceStep).toBeGreaterThan(Math.max(...candles.high));
		expect(heat.values.every(value => value >= 0)).toBe(true);
	});
});
