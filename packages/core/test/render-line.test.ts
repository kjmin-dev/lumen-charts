import { describe, expect, it } from 'vitest';
import { drawLine } from '../src/render/series';
import { SeriesView } from '../src/views/series-view';

/** A context that records path calls as [name, x, y]. */
function recorder(): { calls: [string, number, number][]; ctx: CanvasRenderingContext2D } {
	const calls: [string, number, number][] = [];
	const ctx = {
		beginPath() {},
		stroke() {},
		setLineDash() {},
		moveTo(x: number, y: number) {
			calls.push(['moveTo', x, y]);
		},
		lineTo(x: number, y: number) {
			calls.push(['lineTo', x, y]);
		},
	};
	return { calls, ctx: ctx as unknown as CanvasRenderingContext2D };
}

/** A view of merged pixel columns with the given rows (first, highest, lowest, last) per column. */
function merged(columns: [number, number, number, number][]): SeriesView {
	const view = new SeriesView();
	view.merged = true;
	view.count = columns.length;
	view.x = Float32Array.from(columns, (_, k) => k);
	view.yOpen = Float32Array.from(columns, c => c[0]);
	view.yHigh = Float32Array.from(columns, c => c[1]);
	view.yLow = Float32Array.from(columns, c => c[2]);
	view.yClose = Float32Array.from(columns, c => c[3]);
	return view;
}

describe('drawLine over merged pixel columns', () => {
	it('covers first, extremes and last value with as few points as it takes', () => {
		const { calls, ctx } = recorder();
		drawLine(
			ctx,
			merged([
				// Smooth: everything within a pixel, one point.
				[10, 10, 10.4, 10.2],
				// A spike up after entering low: down to the nearer extreme, up to the other, back to the last.
				[20, 5, 30, 25],
				// A trend: enter at the top, sweep to the bottom, which is the last value.
				[40, 40, 60, 60],
			]),
			'#000',
			1,
			[],
			false,
		);
		expect(calls).toEqual([
			['moveTo', 0.5, 10],
			['lineTo', 1.5, 20],
			['lineTo', 1.5, 30],
			['lineTo', 1.5, 5],
			['lineTo', 1.5, 25],
			['lineTo', 2.5, 40],
			['lineTo', 2.5, 60],
		]);
	});

	it('breaks the line at a column without a value', () => {
		const { calls, ctx } = recorder();
		drawLine(
			ctx,
			merged([
				[10, 10, 10, 10],
				[NaN, NaN, NaN, NaN],
				[12, 12, 12, 12],
			]),
			'#000',
			1,
			[],
			false,
		);
		expect(calls.map(call => call[0])).toEqual(['moveTo', 'moveTo']);
	});
});
