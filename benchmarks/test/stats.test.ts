import { describe, expect, it } from 'vitest';
import { percentileSorted, spread, summarize } from '../src/stats.ts';

describe('percentileSorted', () => {
	const hundred = Float64Array.from({ length: 100 }, (_, i) => i + 1);

	it('uses the nearest rank without interpolation', () => {
		expect(percentileSorted(hundred, 50)).toBe(50);
		expect(percentileSorted(hundred, 95)).toBe(95);
		expect(percentileSorted(hundred, 99)).toBe(99);
		expect(percentileSorted(hundred, 100)).toBe(100);
		expect(percentileSorted([1, 2, 3, 4], 50)).toBe(2);
		expect(percentileSorted([1, 2, 3, 4], 51)).toBe(3);
	});

	it('returns the only sample, or NaN without samples', () => {
		expect(percentileSorted([7], 99)).toBe(7);
		expect(percentileSorted([], 50)).toBeNaN();
	});

	it('gives the maximum as p99 when fewer than 100 samples exist', () => {
		expect(percentileSorted([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 99)).toBe(10);
	});
});

describe('summarize', () => {
	it('summarizes without modifying the input', () => {
		const samples = [5, 1, 4, 2, 3];
		const summary = summarize(samples);
		expect(samples).toEqual([5, 1, 4, 2, 3]);
		expect(summary).toEqual({ count: 5, mean: 3, min: 1, p50: 3, p90: 5, p95: 5, p99: 5, max: 5 });
	});

	it('sorts numerically, not as strings', () => {
		expect(summarize([10, 9, 100]).p50).toBe(10);
	});

	it('returns NaN statistics for no samples', () => {
		const summary = summarize([]);
		expect(summary.count).toBe(0);
		expect(summary.mean).toBeNaN();
		expect(summary.max).toBeNaN();
	});
});

describe('spread', () => {
	it('reports median and relative range', () => {
		expect(spread([3, 1, 2])).toEqual({ median: 2, min: 1, max: 3, relativeRange: 1, runs: 3 });
		expect(spread([1, 2, 3, 4]).median).toBe(2.5);
	});

	it('ignores values that are not finite', () => {
		expect(spread([1, Number.NaN, 3]).runs).toBe(2);
		expect(spread([]).median).toBeNaN();
	});
});
