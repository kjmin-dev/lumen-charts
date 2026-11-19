import {
	CHUNK_ROWS,
	EngineCore,
	type EngineEvent,
	MAX,
	MIN,
	TIME_PATCH,
	aggregate,
	levelCount,
	levelFor,
	levelShift,
	unpackPatches,
} from '@lumen-charts/engine';
import { describe, expect, it } from 'vitest';
import { line, ohlcv, random, run, ticks } from './helpers';

/** The same bits (any NaN equals any NaN): +0 and -0 differ. */
const same = (a: number, b: number): boolean => (a !== a && b !== b) || Object.is(a, b);

/** Zeros of both signs with missing values between them, and now and then another value. */
function zeroish(next: () => number): number {
	const roll = next();
	return roll < 0.4 ? 0 : roll < 0.8 ? -0 : roll < 0.9 ? NaN : roll < 0.95 ? 1 : -1;
}

/** The four columns of a column-major block, `n` long each. */
const four = (a: Float64Array, n: number): Float64Array[] => [0, 1, 2, 3].map(c => a.subarray(c * n, (c + 1) * n));

/** Every level of an engine, column by column. */
function levelsOf(core: EngineCore): number[][] {
	const extent = run(core, { type: 'window', level: 0, start: 0, count: 0, capacity: 0 });
	const out: number[][] = [];
	for (let level = 1; level <= levelCount(extent.end - extent.first); level++) {
		const window = run(core, { type: 'window', level, start: -1e9, count: 2e9, capacity: 0 }).window!;
		for (const block of window.series) {
			for (let at = 0; at < block.data.length; at += window.capacity) {
				out.push([...block.data.subarray(at, at + window.count)]);
			}
		}
	}
	return out;
}

interface Raw {
	first: number;
	end: number;
	time: number[];
	/** Values per series id, column-major as the engine hands them out. */
	series: Map<number, number[][]>;
}

/** Every raw row of the main timeline, read back through a level-0 window. */
function rawOf(core: EngineCore): Raw {
	const extent = run(core, { type: 'window', level: 0, start: -1e9, count: 2e9, capacity: 0 });
	const window = extent.window!;
	const series = new Map<number, number[][]>();
	for (const block of window.series) {
		const columns = block.data.length / Math.max(1, window.capacity);
		const values: number[][] = [];
		for (let c = 0; c < columns; c++) {
			values.push([...block.data.subarray(c * window.capacity, c * window.capacity + window.count)]);
		}
		series.set(block.series, values);
	}
	return { first: extent.first, end: extent.end, time: [...window.time.subarray(0, window.count)], series };
}

/** Brute-force buckets of one level: per column, first / max / min / last of the non-missing members. */
function expectedLevel(raw: Raw, level: number): { start: number; time: number[]; series: Map<number, number[][]> } {
	const shift = levelShift(level);
	const start = raw.first >> shift;
	const end = ((raw.end - 1) >> shift) + 1;
	const time: number[] = [];
	const series = new Map<number, number[][]>();
	for (const [id, values] of raw.series) {
		const ohlc = values.length === 5;
		const out: number[][] = Array.from({ length: ohlc ? 5 : 4 }, () => []);
		for (let b = start; b < end; b++) {
			const lo = Math.max(b * 2 ** shift, raw.first) - raw.first;
			const hi = Math.min((b + 1) * 2 ** shift, raw.end) - raw.first;
			const column = (c: number) => values[c]!.slice(lo, hi).filter(v => v === v);
			const first = (c: number) => column(c)[0] ?? NaN;
			const last = (c: number) => column(c).at(-1) ?? NaN;
			const max = (c: number) => (column(c).length === 0 ? NaN : Math.max(...column(c)));
			const min = (c: number) => (column(c).length === 0 ? NaN : Math.min(...column(c)));
			if (ohlc) {
				out[0]!.push(first(0));
				out[1]!.push(max(1));
				out[2]!.push(min(2));
				out[3]!.push(last(3));
				out[4]!.push(max(4));
			} else {
				out[0]!.push(first(0));
				out[1]!.push(max(0));
				out[2]!.push(min(0));
				out[3]!.push(last(0));
			}
		}
		series.set(id, out);
	}
	for (let b = start; b < end; b++) {
		time.push(raw.time[Math.max(b * 2 ** shift, raw.first) - raw.first]!);
	}
	return { start, time, series };
}

/** Compares every level of the engine with brute force over its raw rows. */
function checkLevels(core: EngineCore): void {
	const raw = rawOf(core);
	const levels = levelCount(raw.end - raw.first);
	for (let level = 1; level <= levels; level++) {
		const expected = expectedLevel(raw, level);
		const window = run(core, { type: 'window', level, start: -1e9, count: 2e9, capacity: 0 }).window!;
		expect(window.level).toBe(level);
		expect(window.start).toBe(expected.start);
		expect([...window.time.subarray(0, window.count)]).toEqual(expected.time);
		for (const block of window.series) {
			const columns = expected.series.get(block.series)!;
			for (let c = 0; c < columns.length; c++) {
				const got = [...block.data.subarray(c * window.capacity, c * window.capacity + window.count)];
				const want = columns[c]!;
				const mismatch = got.findIndex((value, i) => !same(value, want[i]!));
				expect(mismatch, `level ${level} series ${block.series} column ${c}`).toBe(-1);
			}
		}
	}
}

/** Column-major OHLCV with random prices and some missing values. */
function noisy(count: number, t0: number, next: () => number): Float64Array {
	const data = ohlcv(count, t0, 1);
	for (let c = 1; c < 6; c++) {
		for (let i = 0; i < count; i++) {
			data[c * count + i] = next() < 0.04 ? NaN : Math.round(next() * 10_000) / 100;
		}
	}
	return data;
}

/** High of the level-1 patch of series 1 in an event. */
function levelHigh(event: EngineEvent): number {
	const patch = unpackPatches(event.patches).find(entry => entry.level === 1 && entry.series === 1)!;
	return patch.data[1]!;
}

describe('aggregate', () => {
	it('groups rows on a fixed grid, also below index zero, and skips missing values', () => {
		const values = Float64Array.of(NaN, 4, 2, NaN, 9, NaN, NaN, NaN, 1);
		const out = new Float64Array(4 * 3);
		// Rows -5 to 3 in groups of four: [-5], [-4, -1], [0, 3].
		const groups = aggregate([values, values, values, values], [-5, -5, -5, -5], -5, 4, 2, [0, MAX, MIN, 3], out, 3, 0);
		expect(groups).toBe(3);
		expect([...out.subarray(0, 3)]).toEqual([NaN, 4, 1]); // first
		expect([...out.subarray(3, 6)]).toEqual([NaN, 9, 1]); // highest
		expect([...out.subarray(6, 9)]).toEqual([NaN, 2, 1]); // lowest
		expect([...out.subarray(9, 12)]).toEqual([NaN, 9, 1]); // last
	});
});

describe('aggregate', () => {
	it('takes +0 as the highest and -0 as the lowest of both zeros, wherever they are in the group', () => {
		for (const group of [
			[0, -0, NaN, NaN],
			[-0, 0, NaN, NaN],
			[NaN, -0, NaN, 0],
			[0, NaN, -0, -0],
			[-0, -0, 0, -1],
			[1, 0, NaN, -0],
		]) {
			const values = Float64Array.from(group);
			const present = group.filter(v => v === v);
			const highest = Math.max(...present);
			const lowest = Math.min(...present);
			// Highest and lowest of one source in one pass, as a line has them.
			const fused = new Float64Array(4);
			aggregate([values, values, values, values], [0, 0, 0, 0], 0, 4, 2, [0, MAX, MIN, 3], fused, 1, 0);
			expect([...fused], `${group}`).toEqual([present[0], highest, lowest, present.at(-1)]);
			// Each on its own, as the high and the low of a candle are.
			const alone = new Float64Array(2);
			aggregate([values, values.slice()], [0, 0], 0, 4, 2, [MAX, MIN], alone, 1, 0);
			expect([...alone], `${group}`).toEqual([highest, lowest]);
			const reversed = new Float64Array(2);
			aggregate([values, values.slice()], [0, 0], 0, 4, 2, [MIN, MAX], reversed, 1, 0);
			expect([...reversed], `${group}`).toEqual([lowest, highest]);
		}
		expect(Object.is(Math.max(-0, 0), 0) && Object.is(Math.min(0, -0), -0)).toBe(true);
	});

	it('gives a bucket the same bits from its rows as from the buckets below it', () => {
		const next = random(31);
		const rows = 4096;
		const values = Float64Array.from({ length: rows }, () => zeroish(next));
		const kinds = [0, MAX, MIN, 3];
		// Rows -1000 to 3096: the first and the last group of every level are partial.
		const lo = -1000;
		const hi = lo + rows;
		const groups = (g: number) => ((hi - 1) >> g) - (lo >> g) + 1;
		let below = new Float64Array(4 * groups(4));
		aggregate([values, values, values, values], [lo, lo, lo, lo], lo, hi, 4, kinds, below, groups(4), 0);
		for (let g = 6; g <= 10; g += 2) {
			const direct = new Float64Array(4 * groups(g));
			aggregate([values, values, values, values], [lo, lo, lo, lo], lo, hi, g, kinds, direct, groups(g), 0);
			const stacked = new Float64Array(4 * groups(g));
			const base = lo >> (g - 2);
			aggregate(
				four(below, groups(g - 2)),
				[base, base, base, base],
				base,
				base + groups(g - 2),
				2,
				kinds,
				stacked,
				groups(g),
				0,
			);
			expect([...stacked]).toEqual([...direct]);
			below = stacked;
		}
	});
});

describe('level of detail', () => {
	it('picks raw rows below 16 bars per pixel and the coarsest level that fits a pixel above', () => {
		expect(levelCount(15)).toBe(0);
		expect(levelCount(16)).toBe(1);
		expect(levelCount(10_000_000)).toBe(10);
		expect(levelFor(15.9, 1e7)).toBe(0);
		expect(levelFor(16, 1e7)).toBe(1);
		expect(levelFor(63.9, 1e7)).toBe(1);
		expect(levelFor(64, 1e7)).toBe(2);
		expect(levelFor(4348, 1e7)).toBe(5);
		// Never a level the timeline does not have.
		expect(levelFor(1e9, 100)).toBe(levelCount(100));
	});

	it('builds the pyramid in the background after a load and on demand', () => {
		const core = new EngineCore();
		run(core, { type: 'add', series: 1, kind: 'ohlcv' });
		const count = CHUNK_ROWS * 3 + 77;
		const loaded = run(core, { type: 'set', series: 1, count, data: noisy(count, 0, random(1)) });
		expect(loaded.end).toBe(count);
		expect(core.busy).toBe(true);
		let steps = 0;
		while (core.backgroundStep()) {
			steps++;
		}
		expect(steps).toBeGreaterThan(0);
		expect(core.busy).toBe(false);
		checkLevels(core);

		// A level window finishes a pending build by itself.
		run(core, { type: 'set', series: 1, count, data: noisy(count, 0, random(2)) });
		expect(core.busy).toBe(true);
		checkLevels(core);
		expect(core.busy).toBe(false);
	});

	it('keeps every level equal to brute force through prepends, ticks and corrections', () => {
		const next = random(11);
		const core = new EngineCore();
		run(core, { type: 'add', series: 1, kind: 'ohlcv' });
		run(core, { type: 'add', series: 2, kind: 'line' });
		const count = 5000;
		run(core, { type: 'set', series: 1, count, data: noisy(count, 1_000_000, next) });
		// The line has its own times: several points share a main bar, some bars have none.
		const times: number[] = [];
		const values: number[] = [];
		for (let t = 999_990; t < 1_000_000 + count + 5; t += 1 + Math.floor(next() * 3)) {
			times.push(t + 0.5);
			values.push(next() < 0.05 ? NaN : next() * 100);
		}
		run(core, { type: 'set', series: 2, count: times.length, data: line(times, values) });
		checkLevels(core);

		let firstTime = 1_000_000;
		let lastTime = 1_000_000 + count - 1;
		for (let round = 0; round < 12; round++) {
			// Prepends of sizes that are rarely a multiple of any bucket size.
			const older = 1 + Math.floor(next() * 3000);
			firstTime -= older;
			run(core, { type: 'prepend', series: 1, count: older, data: noisy(older, firstTime, next) });
			// A batch of ticks: updates of the last bar (with highs that go down), new bars, a
			// correction of an old bar, and points of the line.
			const batch: number[][] = [];
			for (let k = 0; k < 20; k++) {
				const roll = next();
				if (roll < 0.3) {
					lastTime++;
					batch.push([1, lastTime, next() * 90, next() * 100, next() * 10, next() * 90, next() * 1000]);
				} else if (roll < 0.6) {
					batch.push([1, lastTime, 1, next() * 2, 0, 1, next() < 0.2 ? NaN : 5]);
				} else if (roll < 0.8) {
					const old = firstTime + Math.floor(next() * (lastTime - firstTime));
					batch.push([1, old, 2, 3, 1, 2, 7]);
				} else {
					batch.push([2, lastTime + next(), next() * 100]);
				}
			}
			const event = run(core, ticks(...batch));
			expect(event.end - event.first).toBe(lastTime - firstTime + 1);
			checkLevels(core);
		}
	});

	it('settles the sign of a zero the same way however a bucket came to be built', () => {
		// Prices that are zeros of both signs, with gaps: every bucket holds both. Its highest value is
		// then +0 and its lowest -0, whichever came first, so a level built at once, one grown by ticks
		// and prepends, and the buckets of a level built from the level below all hold the same bits.
		const next = random(23);
		const zeros = (count: number, t0: number): Float64Array => {
			const data = ohlcv(count, t0, 1);
			for (let at = count; at < 6 * count; at++) {
				data[at] = zeroish(next);
			}
			return data;
		};
		const core = new EngineCore();
		run(core, { type: 'add', series: 1, kind: 'ohlcv' });
		run(core, { type: 'add', series: 2, kind: 'line' });
		const count = 3000;
		let firstTime = 1_000_000;
		let lastTime = firstTime + count - 1;
		run(core, { type: 'set', series: 1, count, data: zeros(count, firstTime) });
		// Several points of the line share a main bar: the bar gets the last of them.
		const times: number[] = [];
		for (let t = firstTime; t < firstTime + count; t += 0.25 + Math.floor(next() * 3)) {
			times.push(t);
		}
		const points = times.map(() => zeroish(next));
		run(core, { type: 'set', series: 2, count: times.length, data: line(times, points) });
		checkLevels(core);
		for (let round = 0; round < 8; round++) {
			const older = 1 + Math.floor(next() * 1500);
			firstTime -= older;
			run(core, { type: 'prepend', series: 1, count: older, data: zeros(older, firstTime) });
			const batch: number[][] = [];
			for (let k = 0; k < 30; k++) {
				const roll = next();
				// A new bar, a change of the last one, or a correction of an old one.
				const time =
					roll < 0.3 ? ++lastTime : roll < 0.7 ? lastTime : firstTime + Math.floor(next() * (lastTime - firstTime));
				batch.push([1, time, zeroish(next), zeroish(next), zeroish(next), zeroish(next), zeroish(next)]);
			}
			run(core, ticks(...batch));
			checkLevels(core);
		}
		// The same rows in two steps: the bars from index 0 on, then all the older ones (bucket
		// boundaries are fixed by the global index, so index 0 has to be the same bar).
		const raw = rawOf(core);
		const total = raw.end - raw.first;
		const main = raw.series.get(1)!;
		const slice = (from: number, to: number): Float64Array => {
			const data = new Float64Array(6 * (to - from));
			data.set(raw.time.slice(from, to), 0);
			main.forEach((column, c) => data.set(column.slice(from, to), (c + 1) * (to - from)));
			return data;
		};
		const fresh = new EngineCore();
		run(fresh, { type: 'add', series: 1, kind: 'ohlcv' });
		run(fresh, { type: 'add', series: 2, kind: 'line' });
		run(fresh, { type: 'set', series: 1, count: raw.end, data: slice(-raw.first, total) });
		run(fresh, { type: 'set', series: 2, count: times.length, data: line(times, points) });
		run(fresh, { type: 'prepend', series: 1, count: -raw.first, data: slice(0, -raw.first) });
		const grown = levelsOf(core);
		const atOnce = levelsOf(fresh);
		expect(grown.length).toBeGreaterThan(8);
		expect(atOnce).toEqual(grown);
		// Both zeros are there to be told apart.
		const flat = grown.flat();
		expect(flat.some(v => Object.is(v, 0)) && flat.some(v => Object.is(v, -0))).toBe(true);
	});

	it('merges the bars of a secondary series that share a main bar by the same rule', () => {
		const core = new EngineCore();
		run(core, { type: 'add', series: 1, kind: 'ohlcv' });
		run(core, { type: 'add', series: 2, kind: 'ohlcv' });
		run(core, { type: 'set', series: 1, count: 3, data: ohlcv(3, 0, 10) });
		// Two bars in each of the first two main bars, with the zeros in either order; one in the third.
		const bars = [
			[0, 0, -0, 0, 0, 1],
			[5, 0, 0, -0, 0, 1],
			[10, 0, 0, -0, 0, 1],
			[15, 0, -0, 0, 0, 1],
			[20, 0, -0, -0, 0, 1],
		];
		const data = new Float64Array(6 * bars.length);
		bars.forEach((bar, i) => bar.forEach((value, c) => (data[c * bars.length + i] = value)));
		run(core, { type: 'set', series: 2, count: bars.length, data });
		const values = rawOf(core).series.get(2)!;
		expect(values[1]).toEqual([0, 0, -0]);
		expect(values[2]).toEqual([-0, -0, -0]);
	});

	it('changes only the first bucket of each level when a prepend is not a multiple of its size', () => {
		const core = new EngineCore();
		run(core, { type: 'add', series: 1, kind: 'line' });
		const count = 10_000;
		const times = Array.from({ length: count }, (_, i) => 1000 + i);
		const values = Array.from({ length: count }, (_, i) => Math.sin(i / 7) * 50);
		run(core, { type: 'set', series: 1, count, data: line(times, values) });
		const before = new Map<number, Float64Array>();
		for (let level = 1; level <= levelCount(count); level++) {
			const window = run(core, { type: 'window', level, start: -1e9, count: 2e9, capacity: 0 }).window!;
			before.set(level, window.series[0]!.data.slice(0, window.count * 4));
		}
		// 21 rows: index -21 to -1. Bucket -1 of every level gains rows; nothing at or after 0 changes.
		const older = line(
			Array.from({ length: 21 }, (_, i) => 979 + i),
			Array.from({ length: 21 }, () => 1e6),
		);
		const event = run(core, { type: 'prepend', series: 1, count: 21, data: older });
		expect(event.first).toBe(-21);
		expect(event.stale).toBe(false);
		// Index 0 starts a bucket at every level, so no existing bucket changed and no patch is needed.
		expect(event.patches).toBeUndefined();
		for (let level = 1; level <= levelCount(count); level++) {
			const window = run(core, { type: 'window', level, start: 0, count: 1e9, capacity: 0 }).window!;
			const columns = before.get(level)!;
			const rows = columns.length / 4;
			for (let c = 0; c < 4; c++) {
				expect([...window.series[0]!.data.subarray(c * window.capacity, c * window.capacity + rows)]).toEqual([
					...columns.subarray(c * rows, (c + 1) * rows),
				]);
			}
		}

		// Now index -21 is the first row: a prepend of 5 lands in bucket -2 at level 1 (rows -32..-17)
		// and bucket -1 above, which already hold rows, and patches exactly those.
		const more = run(core, {
			type: 'prepend',
			series: 1,
			count: 5,
			data: line([974, 975, 976, 977, 978], [-1e6, 0, 0, 0, 0]),
		});
		const levels = levelCount(count + 26);
		// Per level: the bucket's time is the new first row's, and its lowest value is the new one.
		const expected = Array.from({ length: levels }, (_, k) => [
			[TIME_PATCH, k + 1, k === 0 ? -2 : -1, 1, 974],
			[1, k + 1, k === 0 ? -2 : -1, 1, -1e6],
		]).flat();
		expect(
			unpackPatches(more.patches).map(patch => [
				patch.series,
				patch.level,
				patch.start,
				patch.count,
				patch.data[patch.series === TIME_PATCH ? 0 : 2],
			]),
		).toEqual(expected);
		checkLevels(core);
	});

	it('rebuilds the last bucket from its members when a tick lowers the high', () => {
		const core = new EngineCore();
		run(core, { type: 'add', series: 1, kind: 'ohlcv' });
		run(core, { type: 'set', series: 1, count: 40, data: ohlcv(40, 0, 1) });
		// Bucket 2 of level 1 holds rows 32 to 39, whose highs are 134 to 141.
		expect(levelHigh(run(core, ticks([1, 39, 1, 500, 0, 1, 1])))).toBe(500);
		expect(levelHigh(run(core, ticks([1, 39, 1, 2, 0, 1, 1])))).toBe(140);
		checkLevels(core);
	});

	it('adds levels as the timeline grows and answers a missing level with an empty window', () => {
		const core = new EngineCore();
		run(core, { type: 'add', series: 1, kind: 'line' });
		run(core, { type: 'set', series: 1, count: 15, data: line([...Array(15).keys()], Array(15).fill(1)) });
		const missing = run(core, { type: 'window', level: 1, start: 0, count: 10, capacity: 10 }).window!;
		expect(missing).toMatchObject({ level: 1, count: 0 });
		const grown = run(core, ticks([1, 15, 7]));
		expect(unpackPatches(grown.patches).some(patch => patch.level === 1)).toBe(true);
		const window = run(core, { type: 'window', level: 1, start: 0, count: 10, capacity: 10 }).window!;
		expect(window.count).toBe(1);
		expect(window.series[0]!.data[window.capacity]).toBe(7);
		checkLevels(core);
	});

	it('gives a series added later buckets over the whole main timeline', () => {
		const core = new EngineCore();
		run(core, { type: 'add', series: 1, kind: 'ohlcv' });
		run(core, { type: 'set', series: 1, count: 1000, data: ohlcv(1000, 0, 10) });
		run(core, { type: 'add', series: 2, kind: 'line' });
		checkLevels(core);
		run(core, ticks([2, 505, 3], [1, 10_000, 1, 1, 1, 1, 1]));
		checkLevels(core);
		const removed = run(core, { type: 'remove', series: 1 });
		// The line is the main series now, with a timeline of one point.
		expect(removed.end - removed.first).toBe(1);
		checkLevels(core);
	});
});
