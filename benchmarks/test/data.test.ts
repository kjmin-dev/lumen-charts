import { describe, expect, it } from 'vitest';
import {
	type CandleColumns,
	type CandleTickColumns,
	type LineTickColumns,
	Random,
	TICK_NEW_BAR,
	TICK_UPDATE,
	generateCandles,
	generateLine,
	generateTicks,
} from '../src/data.ts';

/** FNV-1a over the bytes of the given arrays, as an unsigned 32-bit hex string. */
function hash(...arrays: (Float64Array | Uint8Array)[]): string {
	let h = 0x811c9dc5;
	for (const array of arrays) {
		const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
		for (const byte of bytes) {
			h = Math.imul(h ^ byte, 0x01000193);
		}
	}
	return (h >>> 0).toString(16).padStart(8, '0');
}

function candleHash(c: CandleColumns): string {
	return hash(c.time, c.open, c.high, c.low, c.close, c.volume);
}

const onPriceGrid = (value: number): boolean => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;

/** Element `i`, or NaN past the end, so checks on missing rows fail instead of passing silently. */
const at = (array: Float64Array, i: number): number => array[i] ?? Number.NaN;

describe('Random', () => {
	it('repeats the same sequence for the same seed', () => {
		const a = new Random(42);
		const b = new Random(42);
		for (let i = 0; i < 1000; i++) {
			expect(a.nextUint32()).toBe(b.nextUint32());
		}
	});

	it('gives different sequences for different seeds', () => {
		const a = new Random(1);
		const b = new Random(2);
		const same = Array.from({ length: 100 }, () => a.nextUint32() === b.nextUint32()).filter(Boolean).length;
		expect(same).toBeLessThan(3);
	});

	it('keeps uniform values in [0, 1) and normal values in [-2√3, 2√3] with mean near 0', () => {
		const random = new Random(7);
		let sum = 0;
		let outOfRange = 0;
		for (let i = 0; i < 100_000; i++) {
			const u = random.next();
			const z = random.nextNormal();
			if (u < 0 || u >= 1 || Math.abs(z) > 2 * Math.sqrt(3)) {
				outOfRange++;
			}
			sum += z;
		}
		expect(outOfRange).toBe(0);
		expect(Math.abs(sum / 100_000)).toBeLessThan(0.02);
	});
});

describe('generateCandles', () => {
	it('is bit-identical for the same seed and count', () => {
		const a = generateCandles({ seed: 1, count: 5000 });
		const b = generateCandles({ seed: 1, count: 5000 });
		expect(candleHash(a)).toBe(candleHash(b));
		expect(candleHash(generateCandles({ seed: 2, count: 5000 }))).not.toBe(candleHash(a));
	});

	it('matches the recorded output, so generator changes are noticed', () => {
		// Changing this value changes every benchmark data set; record why in the commit.
		expect(candleHash(generateCandles({ seed: 1, count: 1000 }))).toBe('619840cd');
	});

	it('extends a shorter series with the same seed', () => {
		const short = generateCandles({ seed: 3, count: 500 });
		const long = generateCandles({ seed: 3, count: 1000 });
		expect(long.close.subarray(0, 500)).toEqual(short.close);
		expect(long.high.subarray(0, 500)).toEqual(short.high);
	});

	it('produces valid bars on a strictly increasing millisecond time axis', () => {
		const c = generateCandles({ seed: 5, count: 20_000, startTime: Date.UTC(2020, 0, 1), intervalMs: 60_000 });
		expect(c.kind).toBe('candles');
		expect(c.length).toBe(20_000);
		expect(c.time[0]).toBe(Date.UTC(2020, 0, 1));
		const invalid: number[] = [];
		for (let i = 0; i < c.length; i++) {
			const [o, h, l, cl, v] = [at(c.open, i), at(c.high, i), at(c.low, i), at(c.close, i), at(c.volume, i)];
			const valid =
				l <= Math.min(o, cl) &&
				h >= Math.max(o, cl) &&
				l > 0 &&
				Number.isInteger(v) &&
				v > 0 &&
				onPriceGrid(o) &&
				onPriceGrid(h) &&
				onPriceGrid(l) &&
				onPriceGrid(cl) &&
				(i === 0 || (at(c.time, i) - at(c.time, i - 1) === 60_000 && o === at(c.close, i - 1)));
			if (!valid) {
				invalid.push(i);
			}
		}
		expect(invalid).toEqual([]);
	});
});

describe('generateLine', () => {
	it('is bit-identical for the same seed and count', () => {
		const a = generateLine({ seed: 1, count: 5000 });
		const b = generateLine({ seed: 1, count: 5000 });
		expect(hash(a.time, a.value)).toBe(hash(b.time, b.value));
		expect(hash(a.time, a.value)).toBe('d74b13b6');
	});

	it('generates 10 million points quickly and keeps prices near the start price', () => {
		const started = performance.now();
		const line = generateLine({ seed: 1, count: 10_000_000 });
		const elapsed = performance.now() - started;
		expect(line.length).toBe(10_000_000);
		expect(line.time.length).toBe(10_000_000);
		// Generous bound for slow CI machines; locally this takes a few hundred milliseconds.
		expect(elapsed).toBeLessThan(10_000);
		let min = Infinity;
		let max = -Infinity;
		let previous = -Infinity;
		let unordered = 0;
		for (let i = 0; i < line.length; i++) {
			const v = line.value[i] ?? 0;
			const t = line.time[i] ?? 0;
			min = Math.min(min, v);
			max = Math.max(max, v);
			if (!(t > previous)) {
				unordered++;
			}
			previous = t;
		}
		expect(unordered).toBe(0);
		expect(min).toBeGreaterThan(50);
		expect(max).toBeLessThan(150);
	}, 60_000);
});

describe('generateTicks', () => {
	const series = generateCandles({ seed: 9, count: 1000 });
	const last = series.length - 1;

	it('is bit-identical for the same seed and count', () => {
		const a = generateTicks(series, { seed: 10, count: 2000 }) as CandleTickColumns;
		const b = generateTicks(series, { seed: 10, count: 2000 }) as CandleTickColumns;
		expect(hash(a.tickKind, a.time, a.open, a.high, a.low, a.close, a.volume)).toBe(
			hash(b.tickKind, b.time, b.open, b.high, b.low, b.close, b.volume),
		);
	});

	it('updates the last bar and starts a new bar every Nth tick', () => {
		const ticks = generateTicks(series, { seed: 10, count: 1000, newBarEvery: 10 }) as CandleTickColumns;
		expect(ticks.kind).toBe('candles');
		expect(ticks.time[0]).toBe(series.time[last]);
		expect(ticks.open[0]).toBe(series.open[last]);
		let barTime = at(series.time, last);
		let newBars = 0;
		const invalid: number[] = [];
		for (let i = 0; i < ticks.length; i++) {
			const isNew = (i + 1) % 10 === 0;
			if (isNew) {
				barTime += 60_000;
				newBars++;
			}
			const [o, h, l, c] = [at(ticks.open, i), at(ticks.high, i), at(ticks.low, i), at(ticks.close, i)];
			const sameBar =
				i === 0 ||
				(o === at(ticks.open, i - 1) &&
					h >= at(ticks.high, i - 1) &&
					l <= at(ticks.low, i - 1) &&
					at(ticks.volume, i) > at(ticks.volume, i - 1));
			const valid =
				ticks.tickKind[i] === (isNew ? TICK_NEW_BAR : TICK_UPDATE) &&
				at(ticks.time, i) === barTime &&
				l <= Math.min(o, c) &&
				h >= Math.max(o, c) &&
				(isNew ? o === at(ticks.close, i - 1) : sameBar);
			if (!valid) {
				invalid.push(i);
			}
		}
		expect(invalid).toEqual([]);
		expect(newBars).toBe(100);
	});

	it('continues a line series', () => {
		const line = generateLine({ seed: 4, count: 100 });
		const ticks = generateTicks(line, { seed: 5, count: 30, newBarEvery: 3 }) as LineTickColumns;
		expect(ticks.kind).toBe('line');
		expect(ticks.time[0]).toBe(line.time[99]);
		expect(ticks.time[2]).toBe((line.time[99] ?? 0) + 60_000);
		expect([...ticks.tickKind].filter(k => k === TICK_NEW_BAR)).toHaveLength(10);
	});

	it('rejects an empty series', () => {
		expect(() => generateTicks(generateLine({ seed: 1, count: 0 }), { seed: 1, count: 1 })).toThrow(/at least one row/);
	});
});
