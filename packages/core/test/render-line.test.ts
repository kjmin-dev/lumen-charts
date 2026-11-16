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

describe('drawLine over a range of items', () => {
	type PathCall = [string, number, number];

	/** A context that keeps the calls of every path begun, the last one being the one stroked. */
	function paths(): { traced: PathCall[][]; ctx: CanvasRenderingContext2D } {
		const traced: PathCall[][] = [];
		const ctx = {
			beginPath() {
				traced.push([]);
			},
			stroke() {},
			setLineDash() {},
			moveTo(x: number, y: number) {
				traced.at(-1)!.push(['moveTo', x, y]);
			},
			lineTo(x: number, y: number) {
				traced.at(-1)!.push(['lineTo', x, y]);
			},
		};
		return { traced, ctx: ctx as unknown as CanvasRenderingContext2D };
	}

	/** Whether `part` starts with the pen set down on a point of `whole` and goes on like it from there. */
	function continues(whole: PathCall[], part: PathCall[]): boolean {
		const [name, x, y] = part[0]!;
		const rest = part.slice(1);
		return (
			name === 'moveTo' &&
			whole.some(
				(call, i) =>
					call[1] === x &&
					call[2] === y &&
					rest.every((next, k) => {
						const other = whole[i + 1 + k];
						return other !== undefined && other[0] === next[0] && other[1] === next[1] && other[2] === next[2];
					}),
			)
		);
	}

	const segments = (path: PathCall[]): number => path.filter(call => call[0] === 'lineTo').length;

	const columns: [number, number, number, number][] = [
		[10, 10, 10.4, 10.2],
		[20, 5, 30, 25],
		[NaN, NaN, NaN, NaN],
		[40, 40, 60, 60],
		[61, 58, 70, 59],
		[55, 50, 56, 52],
		[53, 53, 53.2, 53.1],
		[54, 54, 54.2, 54.1],
	];
	const single = (): SeriesView => {
		const view = merged(columns);
		view.merged = false;
		return view;
	};

	it.each([
		['merged columns', () => merged(columns), false, true],
		['merged columns, stepped', () => merged(columns), true, true],
		['a point per item', single, false, true],
		// Two segments from every point to the next: never one alone.
		['a point per item, stepped', single, true, false],
	] as const)('draws the path of the whole line from the first item of the range on (%s)', (_, make, step, widens) => {
		const whole = paths();
		drawLine(whole.ctx, make(), '#000', 1, [], step);
		expect(whole.traced).toHaveLength(1);
		const line = whole.traced[0]!;
		let widened = 0;
		for (let from = 0; from < columns.length; from++) {
			for (let to = from + 1; to <= columns.length; to++) {
				const part = paths();
				drawLine(part.ctx, make(), '#000', 1, [], step, from, to);
				// The range as asked for: the pen is set down where the whole path arrives at its first
				// item, and from there on the calls are those of the whole path, up to the last point of
				// its last item. Nothing for the item without a value alone.
				const asked = part.traced[0]!;
				expect(asked.length === 0).toBe(from === 2 && to === 3);
				expect(asked.length === 0 || continues(line, asked)).toBe(true);
				const xs = asked.map(call => Math.floor(call[1]));
				expect(Math.min(from, ...xs)).toBe(from);
				expect(Math.max(to - 1, ...xs)).toBe(to - 1);
				// A range of one segment is not stroked: it is widened until it has more, and is still
				// a piece of the whole path.
				const stroked = part.traced.at(-1)!;
				expect(part.traced.length > 1).toBe(segments(asked) === 1);
				expect(segments(stroked)).not.toBe(1);
				expect(stroked.length === 0 || continues(line, stroked)).toBe(true);
				widened += part.traced.length > 1 ? 1 : 0;
			}
		}
		expect(widened > 0).toBe(widens);
	});

	it('strokes a line of one segment as it is', () => {
		const view = merged([
			[10, 10, 10.2, 10.1],
			[20, 20, 20.2, 20.1],
		]);
		const whole = paths();
		drawLine(whole.ctx, view, '#000', 1, [], false);
		expect(whole.traced).toEqual([
			[
				['moveTo', 0.5, 10],
				['lineTo', 1.5, 20],
			],
		]);
	});
});
