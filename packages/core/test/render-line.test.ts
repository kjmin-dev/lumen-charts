import { describe, expect, it } from 'vitest';
import { drawLine, lineLengths } from '../src/render/series';
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

/** Columns of a noisy line, with gaps at the items of `gaps`. */
function noisy(count: number, gaps: readonly number[]): [number, number, number, number][] {
	const columns: [number, number, number, number][] = [];
	for (let k = 0; k < count; k++) {
		const first = 100 + Math.sin(k * 0.7) * 40 + Math.sin(k * 3.1) * 7;
		const last = first + Math.sin(k * 1.3) * 9;
		const high = Math.min(first, last) - Math.abs(Math.sin(k * 2.3)) * 3;
		const low = Math.max(first, last) + Math.abs(Math.sin(k * 1.9)) * 3;
		columns.push(gaps.includes(k) ? [NaN, NaN, NaN, NaN] : [first, high, low, last]);
	}
	return columns;
}

describe('drawLine with dashes over a range of items', () => {
	type Point = [number, number];

	/** A context that keeps the subpaths of the path stroked last. */
	function dashes(): { lines: Point[][]; ctx: CanvasRenderingContext2D } {
		const lines: Point[][] = [];
		const ctx = {
			beginPath() {
				lines.length = 0;
			},
			stroke() {},
			setLineDash() {},
			moveTo(x: number, y: number) {
				lines.push([[x, y]]);
			},
			lineTo(x: number, y: number) {
				lines.at(-1)!.push([x, y]);
			},
		};
		return { lines, ctx: ctx as unknown as CanvasRenderingContext2D };
	}

	/** Lengths as a canvas sums them: in single precision, operation by operation. */
	function add(length: number, a: Point, b: Point): number {
		const dx = Math.fround(b[0] - a[0]);
		const dy = Math.fround(b[1] - a[1]);
		return Math.fround(length + Math.fround(Math.sqrt(Math.fround(Math.fround(dx * dx) + Math.fround(dy * dy)))));
	}

	/** Every segment of the lines right of `from` with the length of its line before it, as a text. */
	function phases(lines: Point[][], from = -Infinity): string[] {
		const out: string[] = [];
		for (const line of lines) {
			let length = 0;
			for (let i = 0; i + 1 < line.length; i++) {
				if (line[i]![0] >= from) {
					out.push(`${line[i]!.join(',')} ${line[i + 1]!.join(',')} at ${length}`);
				}
				length = add(length, line[i]!, line[i + 1]!);
			}
		}
		return out;
	}

	const single = (columns: [number, number, number, number][]): SeriesView => {
		const view = merged(columns);
		view.merged = false;
		return view;
	};

	it.each([
		['merged columns', merged, false],
		['merged columns, stepped', merged, true],
		['a point per item', single, false],
		['a point per item, stepped', single, true],
	] as const)('continues the dashes of the whole line where its path starts (%s)', (_, make, step) => {
		const count = 40;
		const columns = noisy(count, [0, 11, 12, 30]);
		const whole = dashes();
		drawLine(whole.ctx, make(columns), '#000', 1, [3, 3], step);
		const expected = new Set(phases(whole.lines));
		const starts = new Set(whole.lines.map(line => line[0]!.join(',')));
		const wrong: string[] = [];
		let led = 0;
		for (let from = 0; from < count; from++) {
			for (let to = from + 1; to <= count; to++) {
				const part = dashes();
				// A view of its own for every range, and one that has measured other ranges before.
				const view = make(columns);
				if ((from + to) % 3 === 0) {
					lineLengths(view, step, (from * 7) % count);
				}
				drawLine(part.ctx, view, '#000', 1, [3, 3], step, from, to);
				const [a, b, c] = part.lines[0] ?? [];
				if (a === undefined) {
					continue;
				}
				// Every segment drawn, the lead aside, is one of the whole line with the same length of
				// path before it; so the dashes fall on it as they do there.
				wrong.push(...phases(part.lines, Math.max(a[0], 0)).filter(phase => !expected.has(phase)));
				if (a[0] >= 0) {
					// No lead: the path starts where a piece of the whole line starts.
					wrong.push(...(starts.has(a.join(',')) ? [] : [`${from}-${to} starts at ${a.join(',')}`]));
					continue;
				}
				// A lead: one level segment to where the whole path arrives at the first item drawn, as
				// long as the whole path is before that point.
				led++;
				const next = c === undefined || expected.has(`${b!.join(',')} ${c.join(',')} at ${b![0] - a[0]}`);
				wrong.push(...(a[1] === b![1] && next ? [] : [`${from}-${to} leads from ${a.join(',')}`]));
			}
		}
		expect(wrong).toEqual([]);
		expect(led).toBeGreaterThan(400);
	});

	it('draws the line from its first item when no lead has the exact length', () => {
		// A short piece after a gap, far from the left edge: the path before item 36 is a few pixels
		// long, with more digits than the difference of two coordinates near 36 can have.
		const columns = noisy(40, [30]).map(([first, high, low, last], k): [number, number, number, number] =>
			k > 30
				? [100 + (k - 30) * 0.1, 100 + (k - 30) * 0.1, 100 + (k - 30) * 0.1, 100 + (k - 30) * 0.1]
				: [first, high, low, last],
		);
		const whole = dashes();
		drawLine(whole.ctx, single(columns), '#000', 1, [3, 3], false);
		const expected = new Set(phases(whole.lines));
		const wrong: string[] = [];
		let fromFirst = 0;
		for (let from = 32; from < 38; from++) {
			const part = dashes();
			drawLine(part.ctx, single(columns), '#000', 1, [3, 3], false, from, 40);
			const [a, b, c] = part.lines[0]!;
			if (part.lines.length === whole.lines.length) {
				fromFirst++;
				wrong.push(
					...(JSON.stringify(part.lines) === JSON.stringify(whole.lines) ? [] : [`${from}: not the whole line`]),
				);
			} else {
				// Where a lead is drawn, the canvas measures it as long as the path before the item.
				const led = b![0] === from && expected.has(`${b!.join(',')} ${c!.join(',')} at ${add(0, a!, b!)}`);
				wrong.push(...(led ? [] : [`${from}: leads from ${a!.join(',')}`]));
			}
			// The same range of a solid line starts at its first item.
			const solid = dashes();
			drawLine(solid.ctx, single(columns), '#000', 1, [], false, from, 40);
			wrong.push(...(solid.lines.length === 1 && solid.lines[0]![0]![0] === from ? [] : [`${from}: solid`]));
		}
		expect(wrong).toEqual([]);
		expect(fromFirst).toBeGreaterThan(0);
		expect(fromFirst).toBeLessThan(6);
	});

	it('keeps the lengths of the items before a rebuilt one', () => {
		const view = new SeriesView();
		const count = 300;
		const value = Float64Array.from({ length: count }, (_, i) => 100 + Math.sin(i / 9) * 10 + Math.sin(i * 1.7));
		const geometry = { origin: 0, spacing: 4, from: 0, to: count, shift: 0, firstRow: 0 };
		const fresh = (): Float32Array => {
			const other = new SeriesView();
			other.update(geometry, value, value, value, value, 0, 1, 0, 0);
			other.project(400, 2, false);
			return lineLengths(other, false, count - 1).slice(0, count);
		};
		view.update(geometry, value, value, value, value, 0, 1, 0, 0);
		view.project(400, 2, false);
		expect(view.pathLengthCount).toBe(0);
		lineLengths(view, false, 250);
		expect(view.pathLengthCount).toBe(251);
		expect(lineLengths(view, false, 100)).toBe(view.pathLength);
		expect(view.pathLengthCount).toBe(251);
		// A tick on the last bar leaves the lengths before it; a correction drops those after it.
		value[count - 1] = 95;
		view.update(geometry, value, value, value, value, 0, 1, count - 1, count);
		view.project(400, 2, false);
		expect(view.pathLengthCount).toBe(251);
		lineLengths(view, false, count - 1);
		expect(view.pathLengthCount).toBe(count);
		value[120] = 130;
		view.update(geometry, value, value, value, value, 0, 1, 120, 121);
		view.project(400, 2, false);
		expect(view.pathLengthCount).toBe(120);
		expect([...lineLengths(view, false, count - 1).subarray(0, count)]).toEqual([...fresh()]);
		// Another price mapping, a stepped path or other items: all lengths are computed again.
		view.project(400, 3, false);
		expect(view.pathLengthCount).toBe(0);
		lineLengths(view, false, 10);
		lineLengths(view, true, 5);
		expect(view.pathLengthCount).toBe(6);
		view.update({ ...geometry, to: count - 1 }, value, value, value, value, 0, 1, 0, 0);
		expect(view.pathLengthCount).toBe(0);
	});
});
