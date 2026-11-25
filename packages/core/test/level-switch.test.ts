import { type Command, EngineCore, type EngineEvent, levelCount, levelFor, levelShift } from '@lumen-ticks/engine';
import { describe, expect, it } from 'vitest';
import { type Geometry, SeriesView, placeElements } from '../src/views/series-view';

type Kind = 'ohlcv' | 'line';

let seq = 0;
function run(core: EngineCore, body: Record<string, unknown>): EngineEvent {
	const generator = core.run({ ...body, seq: ++seq } as Command);
	let step = generator.next();
	while (step.done !== true) {
		step = generator.next();
	}
	return step.value;
}

function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface Source {
	start: number;
	capacity: number;
	open: Float64Array;
	high: Float64Array;
	low: Float64Array;
	close: Float64Array;
}

interface Fixture {
	first: number;
	end: number;
	/** Raw columns, row `i` at `i - first`. */
	high: Float64Array;
	low: Float64Array;
	level: (level: number) => Source;
}

/**
 * A random walk with gaps (missing values) loaded into a real engine, then extended to the left by
 * a prepend whose size is not a multiple of any bucket, so indexes are negative and the first
 * bucket of every level is partial.
 */
function fixture(kind: Kind, seed: number, zeros = false): Fixture {
	const next = random(seed);
	// With `zeros`, every price is a zero of either sign instead (or, now and then, 1 or -1).
	const price = (value: number): number => {
		if (!zeros || value !== value) {
			return value;
		}
		const roll = next();
		return roll < 0.46 ? 0 : roll < 0.92 ? -0 : roll < 0.96 ? 1 : -1;
	};
	const count = 90_000;
	const older = 12_345;
	const total = count + older;
	const columns = kind === 'ohlcv' ? 5 : 1;
	const data = new Float64Array(total * (columns + 1));
	let last = 100;
	for (let i = 0; i < total; i++) {
		data[i] = i * 60_000;
		const close = last + (next() - 0.5) * 2;
		const missing = next() < 0.02;
		if (kind === 'ohlcv') {
			data[total + i] = price(missing ? NaN : last);
			data[2 * total + i] = price(missing ? NaN : Math.max(last, close) + next() * (next() < 0.001 ? 50 : 1));
			data[3 * total + i] = price(missing ? NaN : Math.min(last, close) - next());
			data[4 * total + i] = price(missing ? NaN : close);
			data[5 * total + i] = next() * 1000;
		} else {
			data[total + i] = price(missing ? NaN : close + (next() < 0.001 ? 50 : 0));
		}
		last = close;
	}
	const slice = (from: number, to: number): Float64Array => {
		const n = to - from;
		const out = new Float64Array(n * (columns + 1));
		for (let c = 0; c <= columns; c++) {
			out.set(data.subarray(c * total + from, c * total + to), c * n);
		}
		return out;
	};
	const core = new EngineCore();
	run(core, { type: 'add', series: 1, kind });
	run(core, { type: 'set', series: 1, count, data: slice(older, total) });
	run(core, { type: 'prepend', series: 1, count: older, data: slice(0, older) });
	const highColumn = kind === 'ohlcv' ? 2 : 1;
	const lowColumn = kind === 'ohlcv' ? 3 : 1;
	return {
		first: -older,
		end: count,
		high: data.slice(highColumn * total, (highColumn + 1) * total),
		low: data.slice(lowColumn * total, (lowColumn + 1) * total),
		level: level => {
			const window = run(core, { type: 'window', level, start: -1e9, count: 2e9, capacity: 0 }).window!;
			const block = window.series[0]!.data;
			const n = window.capacity;
			const column = (c: number) => block.subarray(c * n, (c + 1) * n);
			// A raw line is one column standing in for all four prices.
			const single = level === 0 && kind === 'line';
			return {
				start: window.start,
				capacity: n,
				open: column(0),
				high: column(single ? 0 : 1),
				low: column(single ? 0 : 2),
				close: column(single ? 0 : 3),
			};
		},
	};
}

const WIDTH = 1000;

/** Geometry the chart uses for a view with an origin on a whole pixel and `barsPerPixel` bars per pixel. */
function geometryFor(f: Fixture, origin: number, barsPerPixel: number, shift: number): Geometry {
	const spacing = 1 / barsPerPixel;
	const geometry: Geometry = { origin, spacing, from: 0, to: 0, shift, firstRow: 0 };
	const rowFrom = Math.max(f.first, Math.ceil(-origin / spacing));
	const rowTo = Math.min(f.end, Math.ceil((WIDTH - origin) / spacing));
	placeElements(geometry, rowFrom, Math.max(rowFrom, rowTo), f.first);
	return geometry;
}

function items(f: Fixture, origin: number, barsPerPixel: number, level: number, snap: boolean) {
	const source = f.level(level);
	const geometry = geometryFor(f, origin, barsPerPixel, levelShift(level));
	const view = new SeriesView();
	view.update(geometry, source.open, source.high, source.low, source.close, source.start, 1, Infinity, -Infinity);
	view.project(400, 3.7, snap);
	const n = view.count;
	return {
		geometry,
		view,
		count: n,
		min: view.min,
		max: view.max,
		x: [...view.x.subarray(0, n)],
		prices: [
			...view.open.subarray(0, n),
			...view.high.subarray(0, n),
			...view.low.subarray(0, n),
			...view.close.subarray(0, n),
		],
		y: [
			...view.yOpen.subarray(0, n),
			...view.yHigh.subarray(0, n),
			...view.yLow.subarray(0, n),
			...view.yClose.subarray(0, n),
		],
	};
}

/** Highest high and lowest low of raw rows `[from, to)`, missing values skipped. */
function bruteForce(f: Fixture, from: number, to: number): { min: number; max: number } {
	let min = Infinity;
	let max = -Infinity;
	for (let i = from; i < to; i++) {
		const h = f.high[i - f.first]!;
		const l = f.low[i - f.first]!;
		if (h > max) {
			max = h;
		}
		if (l < min) {
			min = l;
		}
	}
	return { min, max };
}

describe('switching between raw rows and levels of detail', () => {
	for (const kind of ['ohlcv', 'line'] as const) {
		it(`draws the same pixels from either side of every switch (${kind})`, () => {
			const f = fixture(kind, kind === 'ohlcv' ? 3 : 4);
			const levels = levelCount(f.end - f.first);
			expect(levels).toBeGreaterThanOrEqual(4);
			for (let level = 1; level <= 4; level++) {
				// At the switch to `level` there are exactly 2^shift bars per pixel. The finer side is
				// raw rows for level 1 and the level below otherwise.
				const barsPerPixel = 2 ** levelShift(level);
				expect(levelFor(barsPerPixel, f.end - f.first)).toBe(level);
				expect(levelFor(barsPerPixel - 0.01, f.end - f.first)).toBe(level - 1);
				// Views in the middle of the data, at its start (first bucket partial) and past its end.
				for (const origin of [
					-37,
					0,
					3,
					517,
					771 + Math.floor(f.first / barsPerPixel),
					-Math.floor(f.end / barsPerPixel) + 600,
				]) {
					const coarse = items(f, origin, barsPerPixel, level, kind === 'ohlcv');
					const fine = items(f, origin, barsPerPixel, level - 1, kind === 'ohlcv');
					expect(coarse.count).toBeGreaterThan(0);
					expect(coarse.count).toBeLessThanOrEqual(WIDTH);
					expect(coarse.x).toEqual(fine.x);
					expect(coarse.y).toEqual(fine.y);
					expect([coarse.min, coarse.max]).toEqual([fine.min, fine.max]);
				}
			}
			// Off a whole pixel, pixel columns cut buckets and the two sides differ: that is why the
			// chart puts the origin on a whole pixel below one pixel per bar.
			const coarse = items(f, 3.5, 16, 1, kind === 'ohlcv');
			const fine = items(f, 3.5, 16, 0, kind === 'ohlcv');
			expect(coarse.y).not.toEqual(fine.y);
		});
	}

	for (const kind of ['ohlcv', 'line'] as const) {
		it(`gives the same bits from either side of every switch where columns hold both zeros (${kind})`, () => {
			// Pixels cannot tell +0 from -0, so the item prices are compared: a column merged from raw
			// rows, from buckets, and from the buckets of buckets takes +0 as its highest and -0 as
			// its lowest value alike, whatever the order of its rows.
			const f = fixture(kind, kind === 'ohlcv' ? 13 : 14, true);
			for (let level = 1; level <= 4; level++) {
				const barsPerPixel = 2 ** levelShift(level);
				for (const origin of [-37, 0, 517, 771 + Math.floor(f.first / barsPerPixel)]) {
					const coarse = items(f, origin, barsPerPixel, level, false);
					const fine = items(f, origin, barsPerPixel, level - 1, false);
					expect(coarse.count).toBeGreaterThan(0);
					expect(coarse.prices).toEqual(fine.prices);
					expect([coarse.min, coarse.max]).toEqual([fine.min, fine.max]);
					expect(coarse.prices.some(v => Object.is(v, 0)) && coarse.prices.some(v => Object.is(v, -0))).toBe(true);
				}
			}
		});
	}

	it('keeps the price range equal to brute force over the rows drawn', () => {
		const next = random(9);
		for (const kind of ['ohlcv', 'line'] as const) {
			const f = fixture(kind, 20);
			for (let trial = 0; trial < 60; trial++) {
				// From just above the first switch to fully zoomed out, at any whole-pixel origin.
				const barsPerPixel = 16 + next() * ((f.end - f.first) / WIDTH);
				const level = levelFor(barsPerPixel, f.end - f.first);
				const shift = levelShift(level);
				const span = (f.end - f.first) / barsPerPixel;
				const origin = Math.round(-f.first / barsPerPixel - next() * span + next() * WIDTH);
				const { geometry, view } = items(f, origin, barsPerPixel, level, false);
				const spacing = geometry.spacing;
				const rawFrom = Math.max(f.first, Math.ceil(-origin / spacing));
				const rawTo = Math.min(f.end, Math.ceil((WIDTH - origin) / spacing));
				if (rawTo <= rawFrom) {
					// The view is past the data.
					continue;
				}
				// The rows drawn: every row of the visible buckets.
				const drawnFrom = geometry.firstRow;
				const drawnTo = Math.min(f.end, geometry.to * 2 ** shift);
				expect(bruteForce(f, drawnFrom, drawnTo)).toEqual({ min: view.min, max: view.max });
				// They differ from the rows inside the pane by less than one bucket, which is less than a
				// pixel column, at either end.
				expect(Math.abs(drawnFrom - rawFrom)).toBeLessThan(2 ** shift);
				expect(Math.abs(drawnTo - rawTo)).toBeLessThan(2 ** shift);
				expect(view.count).toBeLessThanOrEqual(WIDTH + 1);
			}
		}
	});

	it('draws a coarse level wider than a pixel as one item per bucket', () => {
		const f = fixture('ohlcv', 5);
		// Level 2 (64 rows per bucket) shown at 16 bars per pixel: a bucket is four pixels wide.
		const { view, geometry } = items(f, 3, 16, 2, true);
		expect(view.merged).toBe(false);
		expect(view.count).toBe(geometry.to - geometry.from);
		expect(view.x[1]! - view.x[0]!).toBe(4);
	});
});
