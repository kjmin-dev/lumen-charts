import { HIT_BODY, HIT_NONE, type PaneView, type PrimitiveBounds } from '@lumen-charts/core';
import { describe, expect, it } from 'vitest';
import { Drawing, type DrawingOwner } from '../src/drawings/drawing';
import { clipLine, segmentDistance2 } from '../src/drawings/geometry';
import type { DrawingType } from '../src/drawings/types';

/**
 * A pane 400 by 300 CSS pixels with bar `i` at x = 10 i (bars 0 to 40 in view) and price p at
 * y = 300 - 2 p (prices 0 to 150). Times are minutes: time `60_000 i` is bar `i`.
 */
function view(overrides: Partial<PaneView> = {}): PaneView {
	return {
		width: 400,
		height: 300,
		pixelRatio: 1,
		from: 0,
		to: 40,
		barSpacing: 10,
		firstBar: 0,
		lastBar: 1000,
		timelineVersion: 1,
		priceFormatVersion: 2,
		logicalToX: logical => logical * 10,
		xToLogical: x => x / 10,
		timeToLogical: time => time / 60_000,
		logicalToTime: logical => logical * 60_000,
		timeToX: time => (time / 60_000) * 10,
		xToTime: x => (x / 10) * 60_000,
		priceToY: price => 300 - 2 * price,
		yToPrice: y => (300 - y) / 2,
		formatPrice: price => price.toFixed(2),
		...overrides,
	};
}

const owner: DrawingOwner = {
	style: { handleFill: '#fff', fontFamily: 'sans-serif', measure: text => text.length * 7 },
	changed: () => {},
	reorder: () => {},
	remove: () => {},
	zRange: () => ({ min: 0, max: 0 }),
};

/** A drawing with points given as (bar, price), updated for `view`. */
function drawing(type: DrawingType, points: [number, number][], options = {}, pane = view()) {
	const d = new Drawing(
		owner,
		Drawing.stateOf({ type, points: points.map(([bar, price]) => ({ time: bar * 60_000, price })), options }),
	);
	const bounds: PrimitiveBounds = { left: 0, top: 0, right: 400, bottom: 300 };
	d.update(pane, bounds);
	return { d, bounds };
}

/** Pane position of bar `bar` at `price`. */
const xy = (bar: number, price: number): [number, number] => [bar * 10, 300 - 2 * price];

describe('drawing geometry and hit tests', () => {
	it('clips lines, rays and extended lines to the pane', () => {
		const out = new Float64Array(4);
		expect(clipLine(10, 10, 20, 20, false, false, 100, 100, out, 0)).toBe(true);
		expect([...out]).toEqual([10, 10, 20, 20]);
		expect(clipLine(10, 10, 20, 20, false, true, 100, 100, out, 0)).toBe(true);
		expect([...out]).toEqual([10, 10, 100, 100]);
		expect(clipLine(10, 10, 20, 20, true, true, 100, 100, out, 0)).toBe(true);
		expect([...out]).toEqual([0, 0, 100, 100]);
		expect(clipLine(-50, -50, -40, -10, false, false, 100, 100, out, 0)).toBe(false);
		expect(segmentDistance2(5, 5, 0, 0, 10, 0)).toBe(25);
		expect(segmentDistance2(15, 0, 0, 0, 10, 0)).toBe(25);
	});

	it('trend line: handles at the points, the body along the segment only', () => {
		const { d, bounds } = drawing('trendLine', [
			[5, 50],
			[25, 100],
		]);
		expect(d.onScreen).toBe(true);
		expect(bounds.left).toBeLessThanOrEqual(50);
		expect(bounds.right).toBeGreaterThanOrEqual(250);
		expect(d.hitTest(...xy(5, 50), 4)).toBe(1);
		expect(d.hitTest(...xy(25, 100), 4)).toBe(2);
		expect(d.hitTest(...xy(15, 75), 4)).toBe(HIT_BODY);
		expect(d.hitTest(...xy(15, 85), 4)).toBe(HIT_NONE);
		// Past the second point a segment ends, a ray goes on.
		expect(d.hitTest(...xy(35, 125), 4)).toBe(HIT_NONE);
		const ray = drawing('ray', [
			[5, 50],
			[25, 100],
		]).d;
		expect(ray.hitTest(...xy(35, 125), 4)).toBe(HIT_BODY);
		expect(ray.hitTest(...xy(1, 40), 4)).toBe(HIT_NONE);
		const extended = drawing('extendedLine', [
			[5, 50],
			[25, 100],
		]).d;
		expect(extended.hitTest(...xy(1, 40), 4)).toBe(HIT_BODY);
		expect(extended.hitTest(...xy(35, 125), 4)).toBe(HIT_BODY);
	});

	it('a wider tolerance (touch) reaches lines from further away', () => {
		const { d } = drawing('horizontalLine', [[10, 100]]);
		expect(d.hitTest(300, 100 - 9, 4)).toBe(HIT_NONE);
		expect(d.hitTest(300, 100 - 9, 12)).toBe(HIT_BODY);
	});

	it('horizontal and vertical lines span the pane wherever their point is', () => {
		const { d: horizontal, bounds } = drawing('horizontalLine', [[500, 100]]);
		expect(bounds.left).toBeLessThanOrEqual(0);
		expect(bounds.right).toBeGreaterThanOrEqual(400);
		expect(horizontal.hitTest(20, 100, 4)).toBe(HIT_BODY);
		// The handle stays in the pane although the point's bar is far right of it.
		expect(horizontal.hitTest(400 - 5, 100, 4)).toBe(1);
		const { d: vertical } = drawing('verticalLine', [[20, 500]]);
		expect(vertical.hitTest(200, 150, 4)).toBe(HIT_BODY);
		expect(vertical.hitTest(210, 150, 4)).toBe(HIT_NONE);
		// Its handle stays in the pane although its price is far above it.
		expect(vertical.hitTest(200, 5, 4)).toBe(1);
	});

	it('rectangle: filled hits inside, unfilled only on the border', () => {
		const points: [number, number][] = [
			[10, 40],
			[30, 80],
		];
		expect(drawing('rectangle', points).d.hitTest(...xy(20, 60), 4)).toBe(HIT_BODY);
		const hollow = drawing('rectangle', points, { fillColor: '' }).d;
		expect(hollow.hitTest(...xy(20, 60), 4)).toBe(HIT_NONE);
		expect(hollow.hitTest(...xy(20, 80), 4)).toBe(HIT_BODY);
		expect(hollow.hitTest(...xy(30, 60), 4)).toBe(HIT_BODY);
		expect(hollow.hitTest(...xy(30, 40), 4)).toBe(HIT_BODY);
		expect(hollow.hitTest(...xy(30, 80), 4)).toBe(2);
	});

	it('parallel channel: both lines and the fill between them', () => {
		const { d, bounds } = drawing('parallelChannel', [
			[10, 50],
			[30, 70],
			[20, 80],
		]);
		// The base line at bar 20 is at price 60, so the parallel one is 20 higher everywhere.
		expect(d.hitTest(...xy(15, 55), 4)).toBe(HIT_BODY);
		expect(d.hitTest(...xy(25, 85), 4)).toBe(HIT_BODY);
		expect(d.hitTest(...xy(25, 75), 4)).toBe(HIT_BODY);
		expect(d.hitTest(...xy(25, 95), 4)).toBe(HIT_NONE);
		expect(bounds.top).toBeLessThanOrEqual(300 - 2 * 90);
		const hollow = drawing(
			'parallelChannel',
			[
				[10, 50],
				[30, 70],
				[20, 80],
			],
			{ fillColor: '' },
		).d;
		expect(hollow.hitTest(...xy(25, 75), 4)).toBe(HIT_NONE);
	});

	it('Fibonacci retracement: a level line at each level between the points', () => {
		const { d } = drawing('fibRetracement', [
			[10, 100],
			[30, 50],
		]);
		// Level 0.5 of the move from 100 to 50 is at 75; 0.618 at 80.9. The dashed trend from one
		// point to the other is at 95 at bar 12.
		expect(d.hitTest(...xy(12, 75), 4)).toBe(HIT_BODY);
		expect(d.hitTest(...xy(12, 80.9), 4)).toBe(HIT_BODY);
		expect(d.hitTest(...xy(12, 78), 1)).toBe(HIT_NONE);
		expect(d.hitTest(...xy(12, 95), 1)).toBe(HIT_BODY);
		expect(d.hitTest(...xy(35, 75), 4)).toBe(HIT_NONE);
		const levels = drawing(
			'fibRetracement',
			[
				[10, 100],
				[30, 50],
			],
			{ levels: [0, 1] },
		).d;
		expect(levels.hitTest(...xy(12, 75), 4)).toBe(HIT_NONE);
	});

	it('text: the box around the text, measured', () => {
		const { d, bounds } = drawing('text', [[10, 50]], { text: 'Hello' });
		// 5 characters at 7 pixels, with padding.
		expect(bounds.right - bounds.left).toBeGreaterThanOrEqual(35);
		expect(d.hitTest(100 + 20, 200 - 8, 4)).toBe(HIT_BODY);
		expect(d.hitTest(100 + 20, 200 + 20, 4)).toBe(HIT_NONE);
	});

	it('price range: the box and its label', () => {
		const { d } = drawing('priceRange', [
			[10, 50],
			[30, 80],
		]);
		expect(d.hitTest(...xy(20, 65), 4)).toBe(HIT_BODY);
		expect(d.hitTest(...xy(35, 65), 4)).toBe(HIT_NONE);
	});

	it('filters by time first: out of view, nothing is computed or hit', () => {
		const { d, bounds } = drawing('trendLine', [
			[100, 50],
			[120, 60],
		]);
		expect(d.onScreen).toBe(false);
		expect(bounds.left > bounds.right).toBe(true);
		expect(d.hitTest(1000, 200, 4)).toBe(HIT_NONE);
		// A ray from there pointing back into view is still drawn.
		const ray = drawing('ray', [
			[100, 50],
			[90, 50],
		]);
		expect(ray.d.onScreen).toBe(true);
		expect(ray.d.hitTest(...xy(20, 50), 4)).toBe(HIT_BODY);
	});

	it('hides a drawing while a time is not resolved, or when it is not visible', () => {
		const pending = drawing(
			'trendLine',
			[
				[5, 50],
				[25, 100],
			],
			{},
			view({ timeToLogical: () => NaN }),
		);
		expect(pending.d.onScreen).toBe(false);
		const hidden = drawing(
			'trendLine',
			[
				[5, 50],
				[25, 100],
			],
			{ visible: false },
		);
		expect(hidden.d.onScreen).toBe(false);
	});

	it('locked drawings show no handles to grab', () => {
		const { d } = drawing(
			'trendLine',
			[
				[5, 50],
				[25, 100],
			],
			{ locked: true },
		);
		expect(d.hitTest(...xy(5, 50), 4)).toBe(HIT_BODY);
	});
});
