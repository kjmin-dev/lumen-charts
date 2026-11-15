import { describe, expect, it } from 'vitest';
import { PAN_STEP, motionRanges } from '../src/motion.ts';

const bars = (r: { from: number; to: number }): number => r.to - r.from + 1;

describe('motionRanges', () => {
	it('pans from the latest bar into history at a fixed fraction of the width', () => {
		const ranges = motionRanges('pan', 1_000_000, 2000, 301, 75);
		expect(ranges).toHaveLength(301);
		expect(ranges[0]).toEqual({ from: 998_000, to: 999_999 });
		for (let i = 1; i < ranges.length; i++) {
			const range = ranges[i];
			const previous = ranges[i - 1];
			expect(range && bars(range)).toBeCloseTo(2000, 6);
			expect(range && previous && previous.from - range.from).toBeCloseTo(2000 * PAN_STEP, 6);
		}
	});

	it('turns around at the data edges when every bar is in view', () => {
		const size = 1000;
		const ranges = motionRanges('pan', size, size, 400, 100);
		const froms = ranges.map(r => r.from);
		expect(Math.min(...froms)).toBeGreaterThanOrEqual(-size / 2 - 1e-9);
		expect(Math.max(...ranges.map(r => r.to))).toBeLessThanOrEqual(size - 1 + 1e-9);
		// Every step moves the view.
		expect(new Set(froms.map(f => f.toFixed(6))).size).toBeGreaterThan(50);
		expect(ranges.slice(1).every((r, i) => r.from !== ranges[i]?.from)).toBe(true);
	});

	it('zooms between half and twice the level with the latest bar pinned', () => {
		const ranges = motionRanges('zoom', 1_000_000, 20_000, 401, 100);
		const counts = ranges.map(bars);
		expect(ranges.every(r => r.to === 999_999)).toBe(true);
		expect(counts[0]).toBeCloseTo(20_000, 6);
		expect(counts[100]).toBeCloseTo(40_000, 6);
		expect(counts[200]).toBeCloseTo(20_000, 6);
		expect(counts[300]).toBeCloseTo(10_000, 6);
		expect(counts[400]).toBeCloseTo(20_000, 6);
		expect(Math.max(...counts)).toBeCloseTo(40_000, 6);
		expect(Math.min(...counts)).toBeCloseTo(10_000, 6);
	});
});
