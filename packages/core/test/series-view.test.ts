import { describe, expect, it } from 'vitest';
import { type Geometry, SeriesView, candleWidths } from '../src/views/series-view';

function randomWalk(count: number, seed = 1) {
	let state = seed;
	const next = (): number => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 4294967296;
	};
	const open = new Float64Array(count);
	const high = new Float64Array(count);
	const low = new Float64Array(count);
	const close = new Float64Array(count);
	let price = 100;
	for (let i = 0; i < count; i++) {
		const c = price + (next() - 0.5) * 2;
		open[i] = price;
		close[i] = c;
		high[i] = Math.max(price, c) + next();
		low[i] = Math.min(price, c) - next();
		price = c;
	}
	return { open, high, low, close };
}

function items(view: SeriesView) {
	return {
		x: [...view.x.subarray(0, view.count)],
		open: [...view.open.subarray(0, view.count)],
		high: [...view.high.subarray(0, view.count)],
		low: [...view.low.subarray(0, view.count)],
		close: [...view.close.subarray(0, view.count)],
	};
}

describe('SeriesView', () => {
	it('makes one item per bar while bars are at least a pixel wide', () => {
		const data = randomWalk(1000);
		const view = new SeriesView();
		const geometry: Geometry = { origin: 3.5 - 100 * 4, spacing: 4, from: 100, to: 200, shift: 0, firstRow: 100 };
		view.update(geometry, data.open, data.high, data.low, data.close, 0, 1, Infinity, -Infinity);
		expect(view.merged).toBe(false);
		expect(view.count).toBe(100);
		expect(view.x[0]).toBe(4);
		expect(view.x[1]).toBe(8);
		expect(view.high[7]).toBe(data.high[107]);
		expect(view.close[99]).toBe(data.close[199]);
	});

	it('reads rows relative to the start of the cache', () => {
		const data = randomWalk(1000);
		const view = new SeriesView();
		const geometry: Geometry = { origin: 0, spacing: 2, from: 5100, to: 5200, shift: 0, firstRow: 5100 };
		view.update(geometry, data.open, data.high, data.low, data.close, 5000, 1, Infinity, -Infinity);
		expect(view.open[0]).toBe(data.open[100]);
		expect(view.low[99]).toBe(data.low[199]);
	});

	it('merges bars that share a pixel column, keeping the extremes', () => {
		const count = 100_000;
		const data = randomWalk(count);
		const view = new SeriesView();
		const spacing = 800 / count;
		const geometry: Geometry = { origin: 0.37, spacing, from: 0, to: count, shift: 0, firstRow: 0 };
		view.update(geometry, data.open, data.high, data.low, data.close, 0, 1, Infinity, -Infinity);
		expect(view.merged).toBe(true);
		expect(view.count).toBeLessThanOrEqual(801);

		// Reference: assign every bar to the column its center falls in.
		const reference = new Map<number, { open: number; high: number; low: number; close: number }>();
		for (let i = 0; i < count; i++) {
			const column = Math.floor(geometry.origin + i * spacing);
			const item = reference.get(column);
			if (item === undefined) {
				reference.set(column, { open: data.open[i]!, high: data.high[i]!, low: data.low[i]!, close: data.close[i]! });
			} else {
				item.high = Math.max(item.high, data.high[i]!);
				item.low = Math.min(item.low, data.low[i]!);
				item.close = data.close[i]!;
			}
		}
		let total = 0;
		let mismatched = 0;
		for (let k = 0; k < view.count; k++) {
			const item = reference.get(view.x[k]!)!;
			total++;
			// A bar exactly on a column boundary may land on either side; everything else must match.
			if (item.high !== view.high[k] || item.low !== view.low[k]) {
				mismatched++;
			}
		}
		expect(total).toBe(reference.size);
		expect(mismatched).toBeLessThanOrEqual(2);
		expect(view.max).toBe(Math.max(...data.high));
		expect(view.min).toBe(Math.min(...data.low));
		expect(view.open[0]).toBe(data.open[0]);
		expect(view.close[view.count - 1]).toBe(data.close[count - 1]);
	});

	it('skips rows without a value and marks empty columns', () => {
		const count = 1000;
		const value = new Float64Array(count).fill(NaN);
		value[500] = 5;
		value[503] = 9;
		value[506] = 7;
		const view = new SeriesView();
		const geometry: Geometry = { origin: 0, spacing: 0.1, from: 0, to: count, shift: 0, firstRow: 0 };
		view.update(geometry, value, value, value, value, 0, 1, Infinity, -Infinity);
		expect(view.count).toBe(100);
		expect(view.open[50]).toBe(5);
		expect(view.high[50]).toBe(9);
		expect(view.low[50]).toBe(5);
		expect(view.close[50]).toBe(7);
		expect(view.open[49]).toBeNaN();
		expect(view.min).toBe(5);
		expect(view.max).toBe(9);
	});

	it('takes +0 as the highest and -0 as the lowest of both zeros, in a column and in the range', () => {
		const view = new SeriesView();
		const geometry: Geometry = { origin: 0, spacing: 0.25, from: 0, to: 16, shift: 0, firstRow: 0 };
		// Four rows per column, the zeros in either order and with gaps between them.
		const value = Float64Array.of(0, -0, NaN, NaN, -0, NaN, 0, 0, NaN, -0, -0, NaN, NaN, NaN, NaN, NaN);
		view.update(geometry, value, value, value, value, 0, 1, Infinity, -Infinity);
		expect(view.merged).toBe(true);
		expect([...view.high.subarray(0, 4)]).toEqual([0, 0, -0, NaN]);
		expect([...view.low.subarray(0, 4)]).toEqual([-0, -0, -0, NaN]);
		expect([...view.open.subarray(0, 4)]).toEqual([0, -0, -0, NaN]);
		expect([...view.close.subarray(0, 4)]).toEqual([-0, 0, -0, NaN]);
		expect([view.min, view.max]).toEqual([-0, 0]);

		// Candles: highs and lows from columns of their own.
		const high = Float64Array.of(-0, 0, NaN, -0, 0, NaN, -0, -0);
		const low = Float64Array.of(0, NaN, -0, 0, -0, 0, NaN, 0);
		const candles = new SeriesView();
		const half: Geometry = { origin: 0, spacing: 0.25, from: 0, to: 8, shift: 0, firstRow: 0 };
		candles.update(half, low, high, low, high, 0, 1, Infinity, -Infinity);
		expect([...candles.high.subarray(0, 2)]).toEqual([0, 0]);
		expect([...candles.low.subarray(0, 2)]).toEqual([-0, -0]);
		expect([candles.min, candles.max]).toEqual([-0, 0]);

		// One item per row: the range of the items follows the same rule, in either order.
		for (const rows of [
			[0, NaN, -0],
			[-0, NaN, 0],
		]) {
			const raw = new SeriesView();
			const wide: Geometry = { origin: 0, spacing: 4, from: 0, to: 3, shift: 0, firstRow: 0 };
			const column = Float64Array.from(rows);
			raw.update(wide, column, column, column, column, 0, 1, Infinity, -Infinity);
			expect(raw.merged).toBe(false);
			expect([raw.min, raw.max]).toEqual([-0, 0]);
		}
	});

	it('gives a tick the bits of a full rebuild where columns hold zeros of both signs', () => {
		let state = 7;
		const next = (): number => {
			state = (state * 1664525 + 1013904223) >>> 0;
			return state / 4294967296;
		};
		const pick = (): number => {
			const roll = next();
			return roll < 0.45 ? 0 : roll < 0.9 ? -0 : roll < 0.95 ? NaN : 1;
		};
		const count = 4000;
		const columns = [0, 1, 2, 3].map(() => Float64Array.from({ length: count }, pick));
		const [open, high, low, close] = columns as [Float64Array, Float64Array, Float64Array, Float64Array];
		const geometry: Geometry = { origin: 3, spacing: 0.21, from: 0, to: count, shift: 0, firstRow: 0 };
		const view = new SeriesView();
		view.update(geometry, open, high, low, close, 0, 1, Infinity, -Infinity);
		for (let round = 0; round < 200; round++) {
			const row = round % 3 === 0 ? count - 1 : Math.floor(next() * count);
			for (const column of columns) {
				column[row] = pick();
			}
			view.update(geometry, open, high, low, close, 0, 1, row, row + 1);
			const fresh = new SeriesView();
			fresh.update(geometry, open, high, low, close, 0, 1, Infinity, -Infinity);
			expect(items(view)).toEqual(items(fresh));
			expect([view.min, view.max]).toEqual([fresh.min, fresh.max]);
		}
	});

	it('rebuilds only the items touched by a tick, with the same result as a full rebuild', () => {
		for (const spacing of [4, 0.013]) {
			const count = 50_000;
			const data = randomWalk(count, 3);
			const from = spacing >= 1 ? count - 300 : 0;
			const geometry: Geometry = { origin: 0.2 - from * spacing, spacing, from, to: count, shift: 0, firstRow: from };
			const view = new SeriesView();
			view.update(geometry, data.open, data.high, data.low, data.close, 0, 1, Infinity, -Infinity);
			const before = items(view);

			// Nothing dirty: the items are kept as they are.
			data.high[count - 1] = 1e6;
			view.update(geometry, data.open, data.high, data.low, data.close, 0, 1, Infinity, -Infinity);
			expect(items(view)).toEqual(before);

			// The tail is dirty: only then does the new high show up.
			data.close[count - 1] = 555;
			view.update(geometry, data.open, data.high, data.low, data.close, 0, 1, count - 1, count);
			expect(view.max).toBe(1e6);

			const fresh = new SeriesView();
			fresh.update(geometry, data.open, data.high, data.low, data.close, 0, 1, Infinity, -Infinity);
			expect(items(view)).toEqual(items(fresh));
			expect(view.close[view.count - 1]).toBe(555);
		}
	});

	it('rebuilds everything when the columns are replaced or the geometry moves', () => {
		const data = randomWalk(1000);
		const view = new SeriesView();
		const geometry: Geometry = { origin: 0, spacing: 0.5, from: 0, to: 1000, shift: 0, firstRow: 0 };
		view.update(geometry, data.open, data.high, data.low, data.close, 0, 1, Infinity, -Infinity);
		data.high[10] = 1e6;
		view.update(geometry, data.open, data.high, data.low, data.close, 0, 2, Infinity, -Infinity);
		expect(view.max).toBe(1e6);
		data.high[10] = 2e6;
		view.update({ ...geometry, origin: 0.25 }, data.open, data.high, data.low, data.close, 0, 2, Infinity, -Infinity);
		expect(view.max).toBe(2e6);
	});

	it('projects prices to whole device pixels for candles and fractions for lines', () => {
		const view = new SeriesView();
		const open = Float64Array.of(10, 20);
		const high = Float64Array.of(15.3, 21);
		const low = Float64Array.of(9, 14);
		const close = Float64Array.of(12, 15);
		view.update(
			{ origin: 0, spacing: 5, from: 0, to: 2, shift: 0, firstRow: 0 },
			open,
			high,
			low,
			close,
			0,
			1,
			Infinity,
			-Infinity,
		);
		view.project(100, 2, true);
		expect([...view.yHigh.subarray(0, 2)]).toEqual([69, 58]);
		expect([...view.yLow.subarray(0, 2)]).toEqual([82, 72]);
		expect([...view.up.subarray(0, 2)]).toEqual([1, 0]);
		view.project(100, 2, false);
		expect(view.yHigh[0]).toBeCloseTo(69.4, 4);
	});

	it('projects logarithms of prices, leaves out prices at or below zero, and swaps rows when inverted', () => {
		const view = new SeriesView();
		const open = Float64Array.of(10, 100, 0.5);
		const high = Float64Array.of(1000, 100, 2);
		const low = Float64Array.of(1, 100, -1);
		const close = Float64Array.of(100, 10, 0);
		view.update(
			{ origin: 0, spacing: 5, from: 0, to: 3, shift: 0, firstRow: 0 },
			open,
			high,
			low,
			close,
			0,
			1,
			Infinity,
			-Infinity,
		);
		view.project(400, 100, false, true);
		expect([...view.yOpen.subarray(0, 2)]).toEqual([300, 200]);
		expect([...view.yHigh.subarray(0, 2)]).toEqual([100, 200]);
		expect([...view.yLow.subarray(0, 2)]).toEqual([400, 200]);
		expect(view.yLow[2]).toBeNaN();
		expect(view.yClose[2]).toBeNaN();
		view.project(400, 100, true, true);
		expect([...view.up.subarray(0, 3)]).toEqual([1, 0, 0]);
		expect(view.yHigh[2]).toBe(Math.round(400 - Math.log10(2) * 100));
		// Inverted: the low is the upper row, so yHigh keeps the upper one.
		view.project(0, -2, true);
		expect(view.yHigh[0]).toBe(2);
		expect(view.yLow[0]).toBe(2000);
		expect(view.yOpen[0]).toBe(20);
		expect(view.yClose[0]).toBe(200);
		expect(view.up[0]).toBe(1);
		expect(view.lowestPositive()).toBe(0.5);
	});

	it('is empty for an empty range', () => {
		const view = new SeriesView();
		const empty = new Float64Array(0);
		view.update(
			{ origin: 0, spacing: 5, from: 10, to: 10, shift: 0, firstRow: 10 },
			empty,
			empty,
			empty,
			empty,
			0,
			1,
			Infinity,
			-Infinity,
		);
		expect(view.count).toBe(0);
		expect(view.min).toBeGreaterThan(view.max);
	});
});

/** `up` is written for snapped items only (candles and bars). */
function coordinates(view: SeriesView, snap = true) {
	return {
		x: [...view.x.subarray(0, view.count)],
		yOpen: [...view.yOpen.subarray(0, view.count)],
		yHigh: [...view.yHigh.subarray(0, view.count)],
		yLow: [...view.yLow.subarray(0, view.count)],
		yClose: [...view.yClose.subarray(0, view.count)],
		up: snap ? [...view.up.subarray(0, view.count)] : [],
	};
}

describe('SeriesView between frames', () => {
	const geometries: [string, Geometry][] = [
		['a bar per item', { origin: 2.5 - 200 * 3, spacing: 3, from: 200, to: 500, shift: 0, firstRow: 200 }],
		['merged columns', { origin: 0, spacing: 0.02, from: 0, to: 40_000, shift: 0, firstRow: 0 }],
	];

	it.each(geometries)('tells which items a tick rebuilt, until they are drawn (%s)', (_, geometry) => {
		const data = randomWalk(40_000);
		const view = new SeriesView();
		view.update(geometry, data.open, data.high, data.low, data.close, 0, 1, Infinity, -Infinity);
		const generation = view.generation;
		view.drawn();
		expect(view.dirtyTo).toBeLessThanOrEqual(view.dirtyFrom);

		// Nothing changed: nothing dirty.
		view.update(geometry, data.open, data.high, data.low, data.close, 0, 1, Infinity, -Infinity);
		expect(view.dirtyTo).toBeLessThanOrEqual(view.dirtyFrom);
		// A change outside the elements in view.
		view.update(geometry, data.open, data.high, data.low, data.close, 0, 1, geometry.to, geometry.to + 5);
		expect(view.dirtyTo).toBeLessThanOrEqual(view.dirtyFrom);

		const row = geometry.to - 1;
		data.close[row] = data.close[row]! + 0.25;
		view.update(geometry, data.open, data.high, data.low, data.close, 0, 1, row, row + 1);
		expect(view.generation).toBe(generation);
		expect(view.dirtyFrom).toBeLessThan(view.dirtyTo);
		expect(view.dirtyTo).toBe(view.count);
		// The dirty items hold every item that differs from before.
		expect(view.dirtyFrom).toBeGreaterThanOrEqual(view.count - 3);
		const last = view.dirtyFrom;

		// A second change before the frame: the range grows to hold both.
		const earlier = geometry.from + Math.floor((geometry.to - geometry.from) / 2);
		data.high[earlier] = data.high[earlier]! + 0.5;
		view.update(geometry, data.open, data.high, data.low, data.close, 0, 1, earlier, earlier + 1);
		expect(view.dirtyFrom).toBeLessThan(last);
		expect(view.dirtyFrom).toBeGreaterThan(0);
		expect(view.dirtyTo).toBe(view.count);
		const fresh = new SeriesView();
		fresh.update(geometry, data.open, data.high, data.low, data.close, 0, 1, Infinity, -Infinity);
		expect(items(view)).toEqual(items(fresh));

		view.drawn();
		expect(view.dirtyTo).toBeLessThanOrEqual(view.dirtyFrom);
	});

	it('counts a generation when the items are replaced as a whole, not while it stays empty', () => {
		const data = randomWalk(1000);
		const view = new SeriesView();
		const geometry: Geometry = { origin: 0, spacing: 4, from: 100, to: 200, shift: 0, firstRow: 100 };
		const empty = view.generation;
		view.reset();
		view.update({ ...geometry, to: 100 }, data.open, data.high, data.low, data.close, 0, 1, Infinity, -Infinity);
		expect(view.generation).toBe(empty);

		view.update(geometry, data.open, data.high, data.low, data.close, 0, 1, Infinity, -Infinity);
		const first = view.generation;
		expect(first).not.toBe(empty);
		view.update(geometry, data.open, data.high, data.low, data.close, 0, 1, 150, 151);
		expect(view.generation).toBe(first);
		// Another window, another geometry, no elements, a reset: each replaces the items.
		view.update(geometry, data.open, data.high, data.low, data.close, 0, 2, Infinity, -Infinity);
		const second = view.generation;
		expect(second).not.toBe(first);
		view.update({ ...geometry, origin: 1 }, data.open, data.high, data.low, data.close, 0, 2, Infinity, -Infinity);
		const third = view.generation;
		expect(third).not.toBe(second);
		view.update({ ...geometry, to: 100 }, data.open, data.high, data.low, data.close, 0, 2, Infinity, -Infinity);
		const fourth = view.generation;
		expect(fourth).not.toBe(third);
		view.update(geometry, data.open, data.high, data.low, data.close, 0, 2, Infinity, -Infinity);
		view.reset();
		expect(view.generation).not.toBe(fourth + 1);
		expect(view.count).toBe(0);
	});

	it.each(geometries)('projects only rebuilt items, to the coordinates of a full projection (%s)', (_, geometry) => {
		const data = randomWalk(40_000, 5);
		const view = new SeriesView();
		const check = (offset: number, scale: number, snap: boolean, log: boolean): void => {
			view.project(offset, scale, snap, log);
			const fresh = new SeriesView();
			fresh.update(geometry, data.open, data.high, data.low, data.close, 0, 1, Infinity, -Infinity);
			fresh.project(offset, scale, snap, log);
			expect(coordinates(view, snap)).toEqual(coordinates(fresh, snap));
		};
		const tick = (row: number, move: number): void => {
			data.close[row] = data.close[row]! + move;
			data.high[row] = Math.max(data.high[row]!, data.close[row]!);
			data.low[row] = Math.min(data.low[row]!, data.close[row]!);
			view.update(geometry, data.open, data.high, data.low, data.close, 0, 1, row, row + 1);
		};
		view.update(geometry, data.open, data.high, data.low, data.close, 0, 1, Infinity, -Infinity);
		check(300, 2, true, false);
		for (const [snap, log] of [
			[true, false],
			[false, false],
			[true, true],
			[false, true],
		] as const) {
			// The first projection of a kind covers every item, later ones the rebuilt items.
			check(300, 2, snap, log);
			tick(geometry.to - 1, 0.5);
			check(300, 2, snap, log);
			// Two ticks before one projection, one of them far from the last bar.
			tick(geometry.from + 7, -0.75);
			tick(geometry.to - 1, -1.5);
			check(300, 2, snap, log);
			// Projected without a change, then with another mapping: every item moves.
			check(300, 2, snap, log);
			tick(geometry.to - 2, 0.25);
			check(310, 2, snap, log);
			tick(geometry.to - 2, 0.25);
			check(310, -2.5, snap, log);
		}
		// The window is replaced between a tick and the projection.
		tick(geometry.to - 1, 0.5);
		view.update(geometry, data.open, data.high, data.low, data.close, 0, 2, Infinity, -Infinity);
		view.project(310, -2.5, false, true);
		const fresh = new SeriesView();
		fresh.update(geometry, data.open, data.high, data.low, data.close, 0, 1, Infinity, -Infinity);
		fresh.project(310, -2.5, false, true);
		expect(coordinates(view, false)).toEqual(coordinates(fresh, false));
	});

	it('finds the first item right of a column', () => {
		const data = randomWalk(1000);
		const view = new SeriesView();
		expect(view.firstAfter(10)).toBe(0);
		// Items at x = 4, 8, ..., 400.
		const geometry: Geometry = { origin: 3.5 - 100 * 4, spacing: 4, from: 100, to: 200, shift: 0, firstRow: 100 };
		view.update(geometry, data.open, data.high, data.low, data.close, 0, 1, Infinity, -Infinity);
		expect(view.firstAfter(-5)).toBe(0);
		expect(view.firstAfter(3.9)).toBe(0);
		expect(view.firstAfter(4)).toBe(1);
		expect(view.firstAfter(9)).toBe(2);
		expect(view.firstAfter(399)).toBe(99);
		expect(view.firstAfter(400)).toBe(100);
		expect(view.firstAfter(1e9)).toBe(100);
		for (let limit = -2; limit < 410; limit += 0.5) {
			const k = view.firstAfter(limit);
			expect(k === 100 || view.x[k]! > limit).toBe(true);
			expect(k === 0 || view.x[k - 1]! <= limit).toBe(true);
		}
	});
});

describe('candleWidths', () => {
	it('keeps body and wick centered on the same pixel and leaves a gap', () => {
		const out = { body: 0, wick: 0 };
		for (const ratio of [1, 1.5, 2, 3]) {
			for (let spacing = 0.2; spacing < 80; spacing += 0.37) {
				candleWidths(spacing, ratio, out);
				expect(out.body).toBeGreaterThanOrEqual(1);
				expect(out.wick).toBeGreaterThanOrEqual(1);
				expect(out.wick).toBeLessThanOrEqual(out.body);
				expect((out.body - out.wick) % 2).toBe(0);
				// From two pixels per bar on, a gap of at least one pixel separates the bodies.
				expect(out.body).toBeLessThanOrEqual(spacing >= 2 ? spacing - 1 : 1);
			}
		}
	});
});
