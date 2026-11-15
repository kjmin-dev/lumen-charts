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
		const geometry: Geometry = { origin: 3.5 - 100 * 4, spacing: 4, from: 100, to: 200 };
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
		const geometry: Geometry = { origin: 0, spacing: 2, from: 5100, to: 5200 };
		view.update(geometry, data.open, data.high, data.low, data.close, 5000, 1, Infinity, -Infinity);
		expect(view.open[0]).toBe(data.open[100]);
		expect(view.low[99]).toBe(data.low[199]);
	});

	it('merges bars that share a pixel column, keeping the extremes', () => {
		const count = 100_000;
		const data = randomWalk(count);
		const view = new SeriesView();
		const spacing = 800 / count;
		const geometry: Geometry = { origin: 0.37, spacing, from: 0, to: count };
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
		const geometry: Geometry = { origin: 0, spacing: 0.1, from: 0, to: count };
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

	it('rebuilds only the items touched by a tick, with the same result as a full rebuild', () => {
		for (const spacing of [4, 0.013]) {
			const count = 50_000;
			const data = randomWalk(count, 3);
			const from = spacing >= 1 ? count - 300 : 0;
			const geometry: Geometry = { origin: 0.2 - from * spacing, spacing, from, to: count };
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
		const geometry: Geometry = { origin: 0, spacing: 0.5, from: 0, to: 1000 };
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
		view.update({ origin: 0, spacing: 5, from: 0, to: 2 }, open, high, low, close, 0, 1, Infinity, -Infinity);
		view.project(100, 2, true);
		expect([...view.yHigh.subarray(0, 2)]).toEqual([69, 58]);
		expect([...view.yLow.subarray(0, 2)]).toEqual([82, 72]);
		expect([...view.up.subarray(0, 2)]).toEqual([1, 0]);
		view.project(100, 2, false);
		expect(view.yHigh[0]).toBeCloseTo(69.4, 4);
	});

	it('is empty for an empty range', () => {
		const view = new SeriesView();
		const empty = new Float64Array(0);
		view.update({ origin: 0, spacing: 5, from: 10, to: 10 }, empty, empty, empty, empty, 0, 1, Infinity, -Infinity);
		expect(view.count).toBe(0);
		expect(view.min).toBeGreaterThan(view.max);
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
