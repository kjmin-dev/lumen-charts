import {
	type MarksUpdate,
	SCATTER_LEVEL_ROWS,
	SCATTER_LEVEL_THRESHOLD,
	SCATTER_PRICE_BINS,
	ScatterStore,
} from '@lumen-charts/engine';
import { describe, expect, it } from 'vitest';
import { blankUpdate, drain, random, request, rows, trades } from './marks-helpers';

function readAll(store: ScatterStore, level: number): MarksUpdate {
	const update = blankUpdate();
	store.read(level, 0, store.total(level), update);
	return update;
}

/** The cells a level must hold for `points`, on the grid the level reports: largest value per cell. */
function expectedCells(points: MarksUpdate, level: MarksUpdate): Map<string, number> {
	const cells = new Map<string, number>();
	for (let i = 0; i < points.count; i++) {
		const key = `${Math.floor(points.time[i]! / level.timeStep)}:${Math.floor(points.price[i]! / level.priceStep)}`;
		const value = points.values[i]!;
		const held = cells.get(key);
		cells.set(key, held === undefined || !(held >= value) ? value : held);
	}
	return cells;
}

/** The cells of a level by their place in its grid; a cell held twice fails. */
function cellsOf(level: MarksUpdate): Map<string, number> {
	const cells = new Map<string, number>();
	for (let i = 0; i < level.count; i++) {
		cells.set(
			`${Math.floor(level.time[i]! / level.timeStep)}:${Math.floor(level.price[i]! / level.priceStep)}`,
			level.values[i]!,
		);
	}
	expect(cells.size).toBe(level.count);
	return cells;
}

/** Fails unless `level` holds exactly the cells its grid has for `points`. */
function expectCells(points: MarksUpdate, level: MarksUpdate): void {
	const expected = expectedCells(points, level);
	const cells = cellsOf(level);
	expect(cells.size).toBe(expected.size);
	let wrong = 0;
	for (const [key, value] of expected) {
		if (cells.get(key) !== value) {
			wrong++;
		}
	}
	expect(wrong).toBe(0);
}

describe('ScatterStore', () => {
	it('keeps points in time order, several at one time, and reads them back', () => {
		const store = new ScatterStore();
		expect(drain(store.set(rows([10, 20, 20, 30], [1, 2, 3, 4], [5, 6, 7, 8])))).toBe(0);
		const all = readAll(store, 0);
		expect([...all.time]).toEqual([10, 20, 20, 30]);
		expect([...all.price]).toEqual([1, 2, 3, 4]);
		expect([...all.values]).toEqual([5, 6, 7, 8]);
		expect(all.total).toBe(4);
		expect(all.timeStep).toBe(0);
		expect(all.valueMin).toBe(5);
		expect(all.valueMax).toBe(8);
	});

	it('sorts an input that is out of order, keeping the order of points at one time', () => {
		const store = new ScatterStore();
		expect(drain(store.set(rows([30, 10, 20, 10], [1, 2, 3, 4])))).toBe(0);
		const all = readAll(store, 0);
		expect([...all.time]).toEqual([10, 10, 20, 30]);
		expect([...all.price]).toEqual([2, 4, 3, 1]);
		// Without values every point has none.
		expect(all.values.every(value => Number.isNaN(value))).toBe(true);
		expect(all.valueMin).toBeNaN();
	});

	it('refuses points without a finite time or price, and appended points before the last', () => {
		const store = new ScatterStore();
		expect(drain(store.set(rows([10, Number.NaN, 20, 30, Infinity], [1, 2, Number.NaN, 4, 5])))).toBe(3);
		expect(store.total(0)).toBe(2);
		expect(drain(store.append(rows([29, 30, 31], [1, 2, 3])))).toBe(1);
		expect([...readAll(store, 0).time]).toEqual([10, 30, 30, 31]);
		// Rows of another kind are refused whole.
		expect(
			drain(
				store.append({
					kind: 'heatmap',
					count: 2,
					rows: 1,
					priceStart: 0,
					priceStep: 1,
					time: new Float64Array(2),
					values: new Float32Array(2),
				}),
			),
		).toBe(2);
	});

	it('reports the first row an append changed, per level', () => {
		const store = new ScatterStore();
		drain(store.set(rows([10, 20], [1, 2])));
		store.clearChanges();
		expect(store.changedFrom(0)).toBe(Infinity);
		drain(store.append(rows([30, 40], [3, 4])));
		expect(store.changedFrom(0)).toBe(2);
		expect(store.changedFrom(1)).toBe(Infinity);
	});

	it('has no levels below the threshold and makes them once it is reached', () => {
		const store = new ScatterStore();
		drain(store.set(trades(SCATTER_LEVEL_THRESHOLD - 1)));
		expect(store.levels).toBe(0);
		drain(store.append(trades(1, 3, SCATTER_LEVEL_THRESHOLD * 1000)));
		expect(store.levels).toBeGreaterThan(0);
	});

	it('builds each level as the occupied cells of a grid, with the largest value of each cell', () => {
		const store = new ScatterStore();
		drain(store.set(trades(200_000, 7, 0, 0.05)));
		expect(store.levels).toBeGreaterThanOrEqual(2);
		const points = readAll(store, 0);
		let low = Infinity;
		let high = -Infinity;
		for (const price of points.price) {
			low = Math.min(low, price);
			high = Math.max(high, price);
		}
		let below = points.count;
		let step = 0;
		for (let l = 1; l <= store.levels; l++) {
			const level = readAll(store, l);
			// Coarser every time, and worth its memory.
			expect(level.count).toBeLessThanOrEqual(below * 0.75);
			expect(level.timeStep).toBeGreaterThanOrEqual(step * 4);
			expect(level.priceStep).toBeCloseTo((high - low) / SCATTER_PRICE_BINS, 12);
			below = level.count;
			step = level.timeStep;
			let unordered = 0;
			for (let i = 1; i < level.count; i++) {
				if (level.time[i]! < level.time[i - 1]!) {
					unordered++;
				}
			}
			expect(unordered).toBe(0);
			expectCells(points, level);
		}
		// The top level is small enough to need none above it.
		expect(below).toBeLessThanOrEqual(SCATTER_LEVEL_ROWS);
	});

	it('takes appended points into the last bucket of every level, as a build from all points would', () => {
		const store = new ScatterStore();
		const first = trades(120_000);
		drain(store.set(first));
		const levels = store.levels;
		expect(levels).toBeGreaterThan(0);
		store.clearChanges();
		const before = store.total(1);
		// One at a time, as ticks come, then a batch.
		const next = random(11);
		let time = 120_000 * 1000;
		for (let i = 0; i < 300; i++) {
			time += Math.floor(next() * 1500);
			drain(store.append(rows([time], [100 + (next() - 0.5) * 2], [next() * 500])));
		}
		expect(store.changedFrom(1)).toBeLessThanOrEqual(before);
		expect(store.changedFrom(1)).toBeGreaterThan(before - 200);
		drain(store.append(trades(5000, 5, time + 1000)));
		const points = readAll(store, 0);
		expect(points.count).toBe(125_300);
		for (let l = 1; l <= levels; l++) {
			expectCells(points, readAll(store, l));
		}
	});

	it('does not keep a level that merges next to nothing', () => {
		// Every point in a bin of its own until buckets are wide: prices spread over the whole range.
		const next = random(3);
		const count = 100_000;
		const time = new Float64Array(count);
		const price = new Float64Array(count);
		for (let i = 0; i < count; i++) {
			time[i] = i * 1000;
			price[i] = next() * 1000;
		}
		const store = new ScatterStore();
		drain(store.set({ kind: 'scatter', count, time, price, value: null }));
		for (let l = 1; l <= store.levels; l++) {
			expect(store.total(l)).toBeLessThanOrEqual(store.total(l - 1) * 0.75);
		}
	});

	it('selects the points for a narrow view and a level for a wide one', () => {
		const store = new ScatterStore();
		const count = 400_000;
		drain(store.set(trades(count, 7, 0, 0.01)));
		const span = count * 1000;
		// 300 points across 1,000 pixels: nothing to merge.
		const narrow = store.select(request(1_000_000, 1_300_000, 300));
		expect(narrow.level).toBe(0);
		expect(narrow.start).toBe(1000);
		expect(narrow.end).toBe(1301);
		// All of it across 1,000 pixels: the coarsest level whose buckets are no wider than a pixel.
		const wide = store.select(request(0, span, span / 1000));
		expect(wide.level).toBeGreaterThan(0);
		const level = readAll(store, wide.level);
		expect(level.timeStep).toBeLessThanOrEqual(span / 1000);
		// The next level, where there is one, has buckets wider than a pixel.
		const above = wide.level < store.levels ? readAll(store, wide.level + 1).timeStep : Infinity;
		expect(above).toBeGreaterThan(span / 1000);
		expect(wide.start).toBe(0);
		expect(wide.end).toBe(store.total(wide.level));
		// Part of it: the cells whose buckets reach into the times asked for.
		const part = store.select(request(span / 4, span / 2, span / 1000));
		expect(part.level).toBe(wide.level);
		expect(level.time[part.start]!).toBeGreaterThanOrEqual(span / 4 - level.timeStep / 2);
		expect(level.time[part.end - 1]!).toBeLessThanOrEqual(span / 2 + level.timeStep / 2);
		expect(level.time[part.start - 1]!).toBeLessThan(span / 4 - level.timeStep / 2);
	});

	it('selects no level whose price bins are taller than a pixel, unless the rows are too many', () => {
		const store = new ScatterStore();
		const count = 400_000;
		drain(store.set(trades(count, 7, 0, 0.01)));
		const span = count * 1000;
		const bin = readAll(store, 1).priceStep;
		expect(store.select(request(0, span, span / 1000, { priceStep: bin * 2 })).level).toBeGreaterThan(0);
		// Zoomed into the prices: the points themselves.
		expect(store.select(request(0, span, span / 1000, { priceStep: bin / 2 })).level).toBe(0);
		// More points than wanted: the finest level that fits, bins or not.
		const limited = store.select(request(0, span, span / 1000, { priceStep: bin / 2, limit: 100_000 }));
		expect(limited.level).toBeGreaterThan(0);
		expect(limited.end - limited.start).toBeLessThanOrEqual(100_000);
		expect(store.total(limited.level - 1)).toBeGreaterThan(100_000);
	});

	it('starts over on a new history', () => {
		const store = new ScatterStore();
		drain(store.set(trades(200_000)));
		const bytes = store.byteLength;
		expect(bytes).toBeGreaterThan(200_000 * 20);
		drain(store.set(rows([1, 2], [3, 4], [9, 1])));
		expect(store.levels).toBe(0);
		expect(store.total(0)).toBe(2);
		expect(store.byteLength).toBeLessThan(bytes);
		expect(readAll(store, 0).valueMax).toBe(9);
		expect(store.changedFrom(0)).toBe(0);
	});
});
