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
} from '@lumen-charts/engine';
import { describe, expect, it } from 'vitest';
import { line, ohlcv, random, run, ticks } from './helpers';

const same = (a: number, b: number): boolean => (a !== a && b !== b) || a === b;

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
	const patch = event.patches!.find(entry => entry.level === 1 && entry.series === 1)!;
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
			more.patches!.map(patch => [
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
		expect(grown.patches!.some(patch => patch.level === 1)).toBe(true);
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
