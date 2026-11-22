import { describe, expect, it } from 'vitest';
import { MIN_UNPROJECTED_SHARE, startRows } from '../src/marks/gpu/renderer';

describe('WebGPU scatter rows projected when a column draw starts over', () => {
	it('projects the rows in view when they leave out enough of the rows held', () => {
		// A trade-history pan: about half of the held rows in view.
		expect(startRows(100_000, 280_000, 360_000)).toEqual([100_000, 280_000]);
		// Exactly the minimum share left out still projects the view only.
		const count = 1_000_000,
			left = MIN_UNPROJECTED_SHARE * count;
		expect(startRows(left, count, count)).toEqual([left, count]);
	});

	it('projects every row held when the view would leave out fewer than the minimum share', () => {
		const count = 2_000_000;
		const view = Math.ceil((1 - MIN_UNPROJECTED_SHARE) * count) + 1;
		expect(startRows(count - view, count, count)).toEqual([0, count]);
		expect(startRows(0, count, count)).toEqual([0, count]);
	});

	it('keeps an empty view and an empty window empty', () => {
		expect(startRows(5, 5, 10)).toEqual([5, 5]);
		expect(startRows(0, 0, 0)).toEqual([0, 0]);
	});
});
