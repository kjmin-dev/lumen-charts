import {
	HeatmapStore,
	type HeatmapColumns,
	type MarksUpdate,
	ScatterStore,
	type ScatterRows,
} from '@lumen-ticks/engine';
import { describe, expect, it } from 'vitest';
import { blankUpdate, drain, heat, random, rows, trades } from './marks-helpers';

/** Every row of a level, from its first. */
function level(store: ScatterStore | HeatmapStore, l: number): MarksUpdate {
	const update = blankUpdate();
	store.read(l, store.first(l), store.first(l) + store.total(l), update);
	return update;
}

interface Cell {
	value: number;
	count: number;
	size: number;
}

/** The cells a scatter level must hold for the points of level 0, on the grid it reports. */
function expectedCells(points: MarksUpdate, grid: MarksUpdate): Map<string, Cell> {
	const cells = new Map<string, Cell>();
	for (let i = 0; i < points.count; i++) {
		const key = `${Math.floor(points.time[i]! / grid.timeStep)}:${Math.floor(points.price[i]! / grid.priceStep)}`;
		const value = points.values[i]!;
		const size = points.sizes.length > 0 ? points.sizes[i]! : Number.NaN;
		const held = cells.get(key);
		if (held === undefined) {
			cells.set(key, { value, count: 1, size });
		} else {
			if (value === value && !(held.value >= value)) {
				held.value = value;
			}
			if (size === size && !(held.size >= size)) {
				held.size = size;
			}
			held.count++;
		}
	}
	return cells;
}

/** Fails unless every level of a scatter store holds exactly the cells of its points, in time order. */
function expectScatterLevels(store: ScatterStore): void {
	const points = level(store, 0);
	for (let l = 1; l <= store.levels; l++) {
		const cells = level(store, l);
		const expected = expectedCells(points, cells);
		expect(cells.count).toBe(expected.size);
		let wrong = 0;
		let unordered = 0;
		for (let i = 0; i < cells.count; i++) {
			if (i > 0 && cells.time[i]! < cells.time[i - 1]!) {
				unordered++;
			}
			const key = `${Math.floor(cells.time[i]! / cells.timeStep)}:${Math.floor(cells.price[i]! / cells.priceStep)}`;
			const cell = expected.get(key);
			const size = cells.sizes.length > 0 ? cells.sizes[i]! : Number.NaN;
			if (
				cell === undefined ||
				!Object.is(cell.value, cells.values[i]!) ||
				cell.count !== cells.counts[i] ||
				!Object.is(cell.size, size)
			) {
				wrong++;
			}
			expected.delete(key);
		}
		expect(unordered).toBe(0);
		expect(wrong).toBe(0);
	}
}

/** How many of `got` differ from `source` at the rows `kept`, NaN equal to NaN. */
function mismatches(got: ArrayLike<number>, kept: readonly number[], source: ArrayLike<number>): number {
	let wrong = 0;
	for (let i = 0; i < kept.length; i++) {
		if (!Object.is(got[i], source[kept[i]!])) {
			wrong++;
		}
	}
	return wrong;
}

/** Points as plain arrays, to compare. */
function plainPoints(update: MarksUpdate): number[][] {
	return [[...update.time], [...update.price], [...update.values], [...update.sizes]];
}

function sliceRows(data: ScatterRows, from: number, to: number): ScatterRows {
	return {
		kind: 'scatter',
		count: to - from,
		time: data.time.slice(from, to),
		price: data.price.slice(from, to),
		value: data.value === null ? null : data.value.slice(from, to),
		size: data.size == null ? null : data.size.slice(from, to),
	};
}

function withSizes(data: ScatterRows, seed: number): ScatterRows {
	const next = random(seed);
	const size = new Float32Array(data.count);
	for (let i = 0; i < data.count; i++) {
		size[i] = next() < 0.1 ? Number.NaN : 1 + Math.floor(next() * 8);
	}
	return { ...data, size };
}

describe('scatter history: sizes, counts, prepend and removal', () => {
	it('keeps a size per point and, per cell of a level, the largest size and the number of points', () => {
		const store = new ScatterStore();
		drain(store.set(withSizes(trades(150_000), 3)));
		expect(store.levels).toBeGreaterThan(0);
		const points = level(store, 0);
		expect(points.sizes.length).toBe(points.count);
		// Points are single rows: no counts are sent for them.
		expect(points.counts.length).toBe(0);
		expectScatterLevels(store);
		let sum = 0;
		const top = level(store, store.levels);
		for (const count of top.counts) {
			sum += count;
		}
		expect(sum).toBe(150_000);
	});

	it('takes sizes in once a later point has one, the earlier points keeping the series size', () => {
		const store = new ScatterStore();
		drain(store.set(rows([1, 2], [10, 11])));
		expect(level(store, 0).sizes.length).toBe(0);
		drain(store.append({ ...rows([3], [12]), size: Float32Array.of(5) }));
		expect([...level(store, 0).sizes]).toEqual([Number.NaN, Number.NaN, 5]);
	});

	it('puts prepended points in front, keeping the indexes of the points there are', () => {
		const store = new ScatterStore();
		drain(store.set(rows([10, 20, 30], [1, 2, 3], [4, 5, 6])));
		expect(drain(store.prepend(rows([5, 1, 10, 11], [7, 8, 9, 0], [1, 2, 3, 4])))).toBe(1);
		expect(store.first(0)).toBe(-3);
		const all = level(store, 0);
		expect([...all.time]).toEqual([1, 5, 10, 10, 20, 30]);
		expect([...all.price]).toEqual([8, 7, 9, 1, 2, 3]);
		// The rows held before keep their indexes.
		const part = blankUpdate();
		store.read(0, 0, 1, part);
		expect([...part.time]).toEqual([10]);
		expect(all.valueMin).toBe(1);
	});

	it('builds the same points and cells from a prepend as from one set', () => {
		const data = withSizes(trades(200_000, 9, 0, 0.05), 5);
		const whole = new ScatterStore();
		drain(whole.set(data));
		const store = new ScatterStore();
		drain(store.set(sliceRows(data, 120_000, 200_000)));
		drain(store.prepend(sliceRows(data, 60_000, 120_000)));
		drain(store.prepend(sliceRows(data, 0, 60_000)));
		expect(plainPoints(level(store, 0))).toEqual(plainPoints(level(whole, 0)));
		expect(store.first(0)).toBe(-120_000);
		expect(store.levels).toBeGreaterThan(0);
		expectScatterLevels(store);
	}, 20_000);

	it('makes the levels once a prepend reaches the threshold', () => {
		const data = trades(100_000);
		const store = new ScatterStore();
		drain(store.set(sliceRows(data, 90_000, 100_000)));
		expect(store.levels).toBe(0);
		drain(store.prepend(sliceRows(data, 0, 90_000)));
		expect(store.levels).toBeGreaterThan(0);
		expectScatterLevels(store);
	});

	it('removes points at either end and in the middle, and rebuilds the cells they were in', () => {
		const data = withSizes(trades(120_000, 4, 0, 0.05), 8);
		for (const [from, to] of [
			[0, 20_000_000],
			[110_000_000, 1e12],
			[30_000_500, 50_000_000],
			[80_000_000, 81_000_000],
		] as const) {
			const store = new ScatterStore();
			drain(store.set(data));
			const before = level(store, 0);
			const removed = drain(store.delete(from, to));
			const kept: number[] = [];
			for (let i = 0; i < before.count; i++) {
				if (!(before.time[i]! >= from && before.time[i]! <= to)) {
					kept.push(i);
				}
			}
			expect(removed).toBe(before.count - kept.length);
			const after = level(store, 0);
			expect(after.count).toBe(kept.length);
			expect(mismatches(after.time, kept, before.time) + mismatches(after.sizes, kept, before.sizes)).toBe(0);
			expectScatterLevels(store);
			// Appends land in the right cells after the change.
			drain(store.append(trades(3000, 12, 121_000_000, 0.05)));
			expectScatterLevels(store);
		}
	}, 30_000);

	it('empties on removing every point', () => {
		const store = new ScatterStore();
		drain(store.set(trades(1000)));
		expect(drain(store.delete(-Infinity, Infinity))).toBe(1000);
		expect(store.total(0)).toBe(0);
		expect(drain(store.delete(0, 1))).toBe(0);
		drain(store.append(rows([5], [1])));
		expect(store.total(0)).toBe(1);
	});

	it('keeps every level the cells of its points through random appends, prepends and removals', () => {
		const next = random(21);
		const store = new ScatterStore();
		let head = 50_000_000;
		let tail = 50_000_000;
		drain(store.set(trades(70_000, 1, head, 0.05)));
		tail = head + 70_000 * 1000;
		for (let step = 0; step < 40; step++) {
			const choice = next();
			if (choice < 0.35) {
				const n = 1 + Math.floor(next() * 4000);
				drain(store.append(withSizes(trades(n, step, tail, 0.05), step)));
				tail += n * 1000;
			} else if (choice < 0.65) {
				const n = 1 + Math.floor(next() * 4000);
				head -= n * 1000;
				drain(store.prepend(withSizes(trades(n, step + 100, head, 0.05), step)));
			} else {
				const from = head + next() * (tail - head);
				drain(store.delete(from, from + next() * 3_000_000));
			}
			if (step % 8 === 7) {
				expectScatterLevels(store);
			}
		}
		expect(store.total(0)).toBeGreaterThan(0);
		expectScatterLevels(store);
	}, 30_000);
});

/** Level 0 of a heatmap as columns: time, first grid row, cells. */
interface Column {
	time: number;
	offset: number;
	cells: number[];
}

function columns(update: MarksUpdate): Column[] {
	const list: Column[] = [];
	let at = 0;
	for (let c = 0; c < update.count; c++) {
		const length = update.lengths.length > 0 ? update.lengths[c]! : update.rows;
		list.push({
			time: update.time[c]!,
			offset: update.offsets.length > 0 ? update.offsets[c]! : 0,
			cells: [...update.values.subarray(at, at + length)],
		});
		at += length;
	}
	return list;
}

/** Level `l` merged the plain way from level 0's columns, by signed index: the largest per grid row. */
function mergedColumns(raw: Column[], first: number, l: number): Column[] {
	const size = 4 ** l;
	const buckets = new Map<number, Column[]>();
	raw.forEach((column, i) => {
		const bucket = Math.floor((first + i) / size);
		const list = buckets.get(bucket) ?? [];
		list.push(column);
		buckets.set(bucket, list);
	});
	const out: Column[] = [];
	// Buckets follow one another from the first column's on.
	const last = Math.floor((first + raw.length - 1) / size);
	for (let bucket = Math.floor(first / size); bucket <= last; bucket++) {
		const members = buckets.get(bucket)!;
		let low = Infinity;
		let high = -Infinity;
		for (const member of members) {
			low = Math.min(low, member.offset);
			high = Math.max(high, member.offset + member.cells.length);
		}
		const cells = Array.from({ length: high - low }, () => Number.NaN);
		for (const member of members) {
			member.cells.forEach((value, r) => {
				const at = member.offset - low + r;
				if (value === value && !(cells[at]! >= value)) {
					cells[at] = value;
				}
			});
		}
		out.push({ time: members[0]!.time, offset: low, cells });
	}
	return out;
}

/** Cells as Float32, as the store keeps them. */
function float32(list: Column[]): Column[] {
	return list.map(column => ({ ...column, cells: [...Float32Array.from(column.cells)] }));
}

function expectHeatLevels(store: HeatmapStore): void {
	const raw = level(store, 0);
	const base = columns(raw);
	for (let l = 1; l <= store.levels; l++) {
		const expected = mergedColumns(base, raw.first, l);
		const got = level(store, l);
		expect(got.first).toBe(Math.floor(raw.first / 4 ** l));
		expect(columns(got)).toEqual(float32(expected));
	}
}

function sliceHeat(data: HeatmapColumns, from: number, to: number): HeatmapColumns {
	return {
		...data,
		count: to - from,
		time: data.time.slice(from, to),
		values: data.values.slice(from * data.rows, to * data.rows),
		offsets: data.offsets == null ? null : data.offsets.slice(from, to),
	};
}

/** A book whose columns follow a wandering mid price on a grid of `rowCount` rows. */
function book(count: number, rowCount: number, seed: number, t0 = 0): HeatmapColumns {
	const data = heat(count, rowCount, (c, r) => ((c * 7 + r * 3) % 50) + (r === 0 ? Number.NaN : 0), t0);
	const next = random(seed);
	const offsets = new Int32Array(count);
	let mid = 0;
	for (let c = 0; c < count; c++) {
		mid += Math.round((next() - 0.5) * 4);
		offsets[c] = mid;
	}
	return { ...data, offsets };
}

describe('heatmap history: prepend, removal and a grid that follows the price', () => {
	it('puts prepended columns in front, keeping the indexes of the columns there are', () => {
		const data = heat(3000, 4);
		const store = new HeatmapStore();
		drain(store.set(sliceHeat(data, 2000, 3000)));
		// Columns at or after the first column's time are refused.
		const refused = sliceHeat(data, 1990, 2010);
		expect(drain(store.prepend(refused))).toBe(10);
		expect(store.first(0)).toBe(-10);
		drain(store.prepend(sliceHeat(data, 0, 1990)));
		expect(store.first(0)).toBe(-2000);
		const whole = new HeatmapStore();
		drain(whole.set(data));
		expect(columns(level(store, 0))).toEqual(columns(level(whole, 0)));
		expectHeatLevels(store);
	});

	it('removes columns at either end and in the middle, and rebuilds the buckets they touched', () => {
		const data = heat(4000, 3, (c, r) => (c * 13 + r * 5) % 97);
		for (const [from, to] of [
			[0, 300 * 60_000],
			[3700 * 60_000, Infinity],
			[1000 * 60_000, 1500 * 60_000],
			[2500 * 60_000, 3600 * 60_000],
		] as const) {
			const store = new HeatmapStore();
			drain(store.set(data));
			const before = columns(level(store, 0));
			const removed = drain(store.delete(from, to));
			const kept = before.filter(column => !(column.time >= from && column.time <= to));
			expect(removed).toBe(before.length - kept.length);
			expect(columns(level(store, 0))).toEqual(kept);
			expectHeatLevels(store);
			drain(store.append(heat(700, 3, (c, r) => c + r, 5000 * 60_000)));
			expectHeatLevels(store);
		}
	});

	it('keeps columns on rows of their own, and merges them into columns that span their members', () => {
		const data = book(3000, 6, 4);
		const store = new HeatmapStore();
		drain(store.set(data));
		const raw = level(store, 0);
		expect(raw.offsets.length).toBe(3000);
		expect(raw.lengths.every(length => length === 6)).toBe(true);
		expect(store.levels).toBeGreaterThan(0);
		expectHeatLevels(store);
		// A column at the last time replaces it, on rows of its own.
		const last = sliceHeat(book(1, 6, 9, 2999 * 60_000), 0, 1);
		last.offsets = Int32Array.of(40);
		drain(store.append(last));
		expect(level(store, 0).offsets.at(-1)).toBe(40);
		expectHeatLevels(store);
	});

	it('sends no grid rows for a grid that does not follow the price', () => {
		const store = new HeatmapStore();
		drain(store.set(heat(10, 4)));
		const raw = level(store, 0);
		expect(raw.offsets.length).toBe(0);
		expect(raw.lengths.length).toBe(0);
		expect(raw.values.length).toBe(40);
	});

	it('keeps every level the merge of its columns through random appends, prepends and removals', () => {
		const next = random(5);
		const store = new HeatmapStore();
		const rowCount = 5;
		let head = 100_000;
		let tail = head + 1500;
		drain(store.set(book(1500, rowCount, 1, head * 60_000)));
		for (let step = 0; step < 40; step++) {
			const choice = next();
			if (choice < 0.35) {
				const n = 1 + Math.floor(next() * 400);
				drain(store.append(book(n, rowCount, step, tail * 60_000)));
				tail += n;
			} else if (choice < 0.65) {
				const n = 1 + Math.floor(next() * 400);
				head -= n;
				drain(store.prepend(book(n, rowCount, step + 50, head * 60_000)));
			} else {
				const from = head + Math.floor(next() * (tail - head));
				drain(store.delete(from * 60_000, (from + Math.floor(next() * 300)) * 60_000));
			}
			if (step % 8 === 7) {
				expectHeatLevels(store);
			}
		}
		expect(store.levels).toBeGreaterThan(0);
		expectHeatLevels(store);
	});
});
