import { HEATMAP_LEVEL_COLUMNS, HeatmapStore, type MarksUpdate } from '@lumen-ticks/engine';
import { describe, expect, it } from 'vitest';
import { blankUpdate, drain, heat, request } from './marks-helpers';

function readAll(store: HeatmapStore, level: number): MarksUpdate {
	const update = blankUpdate();
	store.read(level, 0, store.total(level), update);
	return update;
}

/** Level `level` of raw columns `raw`, computed the plain way: the largest of every `4^level` columns per cell. */
function merged(raw: MarksUpdate, level: number): { time: number[]; values: number[] } {
	const size = 4 ** level;
	const rows = raw.rows;
	const time: number[] = [];
	const values: number[] = [];
	for (let start = 0; start < raw.count; start += size) {
		time.push(raw.time[start]!);
		for (let r = 0; r < rows; r++) {
			let max = Number.NaN;
			for (let c = start; c < Math.min(raw.count, start + size); c++) {
				const value = raw.values[c * rows + r]!;
				if (value === value && !(max >= value)) {
					max = value;
				}
			}
			values.push(max);
		}
	}
	return { time, values };
}

function expectLevels(store: HeatmapStore): void {
	const raw = readAll(store, 0);
	for (let l = 1; l <= store.levels; l++) {
		const level = readAll(store, l);
		const expected = merged(raw, l);
		expect([...level.time]).toEqual(expected.time);
		expect([...level.values]).toEqual(expected.values);
	}
}

describe('HeatmapStore', () => {
	it('keeps columns on a price grid and reads them back', () => {
		const store = new HeatmapStore();
		expect(drain(store.set(heat(3, 4)))).toBe(0);
		const all = readAll(store, 0);
		expect(all.rows).toBe(4);
		expect(all.priceStart).toBe(90);
		expect(all.priceStep).toBe(0.5);
		expect([...all.time]).toEqual([0, 60_000, 120_000]);
		expect([...all.values]).toEqual([0, 1, 2, 3, 10, 11, 12, 13, 20, 21, 22, 23]);
		expect(all.valueMin).toBe(0);
		expect(all.valueMax).toBe(23);
		expect(all.price.length).toBe(0);
		const part = blankUpdate();
		store.read(0, 1, 2, part);
		expect(part.start).toBe(1);
		expect([...part.values]).toEqual([10, 11, 12, 13]);
	});

	it('refuses a grid that is not one, and columns that do not follow the last', () => {
		const store = new HeatmapStore();
		expect(drain(store.set({ ...heat(3, 4), priceStep: 0 }))).toBe(3);
		expect(store.total(0)).toBe(0);
		expect(drain(store.set({ ...heat(3, 4), rows: 1.5 }))).toBe(3);
		const columns = heat(4, 2);
		columns.time[2] = columns.time[0]!;
		expect(drain(store.set(columns))).toBe(1);
		expect([...readAll(store, 0).time]).toEqual([0, 60_000, 180_000]);
		// Another grid: a `set` starts one, an append does not.
		expect(drain(store.append(heat(1, 3, undefined, 0, 9)))).toBe(1);
		expect(drain(store.append({ ...heat(1, 2, undefined, 0, 9), priceStart: 91 }))).toBe(1);
		expect(store.total(0)).toBe(3);
	});

	it('replaces the last column at its time and appends later ones', () => {
		const store = new HeatmapStore();
		drain(store.set(heat(3, 2)));
		store.clearChanges();
		expect(drain(store.append(heat(1, 2, () => 99, 0, 2)))).toBe(0);
		expect(store.total(0)).toBe(3);
		expect(store.changedFrom(0)).toBe(2);
		expect([...readAll(store, 0).values]).toEqual([0, 1, 10, 11, 99, 99]);
		store.clearChanges();
		expect(drain(store.append(heat(2, 2, undefined, 0, 3)))).toBe(0);
		expect(store.total(0)).toBe(5);
		expect(store.changedFrom(0)).toBe(3);
		expect(drain(store.append(heat(1, 2, undefined, 0, 1)))).toBe(1);
	});

	it('merges four columns per level, each cell the largest of its members', () => {
		const store = new HeatmapStore();
		const count = HEATMAP_LEVEL_COLUMNS * 20 + 3;
		// A wave with cells without a value, and a column without any.
		drain(store.set(heat(count, 5, (c, r) => (c % 7 === r || c === 9 ? Number.NaN : Math.sin(c * 0.37 + r) * 100))));
		expect(store.levels).toBe(3);
		expect(store.total(1)).toBe(Math.ceil(count / 4));
		expect(store.total(3)).toBe(Math.ceil(count / 64));
		expect(store.total(3)).toBeLessThanOrEqual(HEATMAP_LEVEL_COLUMNS);
		expectLevels(store);
		// A cell none of whose members has a value has none.
		const one = new HeatmapStore();
		drain(one.set(heat(HEATMAP_LEVEL_COLUMNS + 1, 2, (c, r) => (r === 0 ? Number.NaN : c))));
		expect(readAll(one, 1).values[0]).toBeNaN();
		expect(readAll(one, 1).values[1]).toBe(3);
	});

	it('rebuilds the last bucket of every level from all members when the last column changes', () => {
		const store = new HeatmapStore();
		const count = HEATMAP_LEVEL_COLUMNS * 5 + 2;
		drain(store.set(heat(count, 3, (c, r) => c + r)));
		store.clearChanges();
		// A lower value in the last column lowers the levels, which the highest value alone could not.
		drain(store.append(heat(1, 3, () => -5, 0, count - 1)));
		expectLevels(store);
		expect(store.changedFrom(1)).toBe(Math.floor((count - 1) / 4));
		expect(store.changedFrom(2)).toBe(Math.floor((count - 1) / 16));
		// Columns arriving one by one give the levels a build of all of them would.
		for (let c = count; c < count + 70; c++) {
			drain(store.append(heat(1, 3, (column, r) => ((column * 31) % 17) + r, 0, c)));
		}
		expectLevels(store);
		const whole = new HeatmapStore();
		const raw = readAll(store, 0);
		drain(
			whole.set({
				kind: 'heatmap',
				count: raw.count,
				rows: 3,
				priceStart: 90,
				priceStep: 0.5,
				time: raw.time,
				values: raw.values,
			}),
		);
		for (let l = 1; l <= store.levels; l++) {
			expect([...readAll(store, l).values]).toEqual([...readAll(whole, l).values]);
		}
	});

	it('gets a level once there are enough columns, and lets levels go with a shorter history', () => {
		const store = new HeatmapStore();
		drain(store.set(heat(HEATMAP_LEVEL_COLUMNS, 2)));
		expect(store.levels).toBe(0);
		drain(store.append(heat(1, 2, undefined, 0, HEATMAP_LEVEL_COLUMNS)));
		expect(store.levels).toBe(1);
		expect(store.changedFrom(1)).toBe(0);
		expectLevels(store);
		drain(store.set(heat(10, 2)));
		expect(store.levels).toBe(0);
		expect(store.total(1)).toBe(0);
	});

	it('selects the coarsest level that still has a column per pixel', () => {
		const store = new HeatmapStore();
		const count = 40_000;
		drain(store.set(heat(count, 2)));
		const span = (count - 1) * 60_000;
		// 100 columns across 400 pixels: the columns themselves, with the one that reaches into the view.
		const narrow = store.select(request(60_000 * 1000 + 1, 60_000 * 1100, 15_000));
		expect(narrow).toEqual({ level: 0, start: 1000, end: 1101 });
		// 40,000 columns across 1,000 pixels: 16 per bucket leaves 2.5 per pixel, 64 would leave fewer than one.
		const wide = store.select(request(0, span, span / 1000));
		expect(wide).toEqual({ level: 2, start: 0, end: 2500 });
		// A view beyond the data counts the pixels the data covers.
		const beyond = store.select(request(-span, 2 * span, (3 * span) / 1000));
		expect(beyond.level).toBe(3);
		expect(beyond.end).toBe(store.total(3));
		// More cells than wanted: coarser.
		const limited = store.select(request(0, span, span / 1000, { limit: 2000 }));
		expect(limited.level).toBe(3);
		expect((limited.end - limited.start) * 2).toBeLessThanOrEqual(2000);
	});
});
