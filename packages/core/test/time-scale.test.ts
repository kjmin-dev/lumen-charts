import { describe, expect, it } from 'vitest';
import { TimeScale } from '../src/model/time-scale';

function scale(count: number, width = 600, spacing = 6): TimeScale {
	const ts = new TimeScale(spacing, 0);
	ts.setWidth(width);
	ts.setExtent(0, count);
	return ts;
}

describe('TimeScale', () => {
	it('puts the last bar at the right edge by default', () => {
		const ts = scale(1000);
		expect(ts.indexToX(999)).toBe(597);
		expect(ts.to).toBe(999.5);
		expect(ts.from).toBe(899.5);
		expect(ts.xToLogical(ts.indexToX(950))).toBeCloseTo(950, 9);
	});

	it('pans by pixels and stops with two bars left in view', () => {
		const ts = scale(1000);
		ts.scrollBy(60);
		expect(ts.to).toBe(989.5);
		ts.scrollBy(1e9);
		expect(ts.to).toBe(1.5);
		ts.scrollBy(-1e9);
		expect(ts.from).toBe(997.5);
	});

	it('zooms around the anchor', () => {
		const ts = scale(1000);
		const anchor = 200;
		const before = ts.xToLogical(anchor);
		ts.zoomAt(anchor, 2);
		expect(ts.barSpacing).toBe(12);
		expect(ts.xToLogical(anchor)).toBeCloseTo(before, 9);
		ts.zoomAt(anchor, 0.25);
		expect(ts.barSpacing).toBe(3);
		expect(ts.xToLogical(anchor)).toBeCloseTo(before, 9);
	});

	it('zooms out until all data fits and no further', () => {
		const ts = scale(1_000_000);
		ts.zoomAt(300, 1e-9);
		expect(ts.barSpacing).toBeCloseTo(600 / 1_000_000, 12);
		const few = scale(10);
		few.zoomAt(300, 1e-9);
		expect(few.barSpacing).toBe(0.5);
	});

	it('fits content and sets a logical range', () => {
		const ts = scale(1_000_000);
		ts.fitContent();
		expect(ts.from).toBeCloseTo(-0.5, 6);
		expect(ts.to).toBeCloseTo(999_999.5, 6);
		ts.setVisibleRange(100, 400);
		expect(ts.barSpacing).toBe(2);
		expect(ts.from).toBeCloseTo(100, 9);
		expect(ts.to).toBeCloseTo(400, 9);
	});

	it('follows new bars at the right edge but holds still when scrolled into history', () => {
		const live = scale(1000);
		live.setExtent(0, 1001);
		expect(live.to).toBe(1000.5);

		const history = scale(1000);
		history.scrollBy(300);
		const from = history.from;
		history.setExtent(0, 1003);
		expect(history.from).toBe(from);
	});

	it('keeps the view when history is prepended', () => {
		const ts = scale(1000);
		ts.scrollBy(120);
		const from = ts.from;
		const version = ts.version;
		ts.setExtent(-5000, 1000);
		expect(ts.from).toBe(from);
		expect(ts.version).toBeGreaterThan(version);
	});

	it('changes its version only when the mapping changes', () => {
		const ts = scale(1000);
		const version = ts.version;
		ts.setWidth(600);
		ts.setExtent(0, 1000);
		ts.scrollBy(0);
		ts.scrollToRealTime();
		expect(ts.version).toBe(version);
		ts.scrollBy(1);
		expect(ts.version).toBe(version + 1);
	});
});
