import {
	CHUNK_ROWS,
	type IndicatorDefinition,
	atr,
	bollinger,
	computeIndicator,
	ema,
	highest,
	lowest,
	macd,
	resolveParams,
	rsi,
	sma,
	stochastic,
	vwap,
	wma,
} from '@lumen-charts/engine';
import { describe, expect, it } from 'vitest';
import { random } from './helpers';

// Brute-force references: each value straight from its definition, with no running state.

const isNaN = (value: number): boolean => value !== value;

function window(values: ArrayLike<number>, i: number, n: number): number[] | null {
	if (i - n + 1 < 0) {
		return null;
	}
	const list: number[] = [];
	for (let k = i - n + 1; k <= i; k++) {
		if (isNaN(values[k]!)) {
			return null;
		}
		list.push(values[k]!);
	}
	return list;
}

function smaRef(x: ArrayLike<number>, n: number): number[] {
	return Array.from({ length: x.length }, (_, i) => {
		const w = window(x, i, n);
		return w === null ? NaN : w.reduce((a, b) => a + b, 0) / n;
	});
}

function wmaRef(x: ArrayLike<number>, n: number): number[] {
	return Array.from({ length: x.length }, (_, i) => {
		const w = window(x, i, n);
		return w === null ? NaN : w.reduce((a, b, k) => a + (k + 1) * b, 0) / ((n * (n + 1)) / 2);
	});
}

/** EMA over the non-missing values, seeded with the mean of the first `n` of them. */
function emaRef(x: ArrayLike<number>, n: number): number[] {
	const alpha = 2 / (n + 1);
	const out: number[] = [];
	const seen: number[] = [];
	let average = NaN;
	for (let i = 0; i < x.length; i++) {
		const v = x[i]!;
		if (isNaN(v)) {
			out.push(NaN);
			continue;
		}
		seen.push(v);
		if (seen.length < n) {
			out.push(NaN);
		} else if (seen.length === n) {
			average = seen.reduce((a, b) => a + b, 0) / n;
			out.push(average);
		} else {
			average = average + alpha * (v - average);
			out.push(average);
		}
	}
	return out;
}

/** Wilder's smoothing over a list of values, seeded with the mean of the first `n`. */
function wilder(values: number[], n: number): number[] {
	const out: number[] = [];
	let average = NaN;
	for (let k = 0; k < values.length; k++) {
		if (k < n - 1) {
			out.push(NaN);
		} else if (k === n - 1) {
			average = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
			out.push(average);
		} else {
			average = (average * (n - 1) + values[k]!) / n;
			out.push(average);
		}
	}
	return out;
}

function rsiRef(x: ArrayLike<number>, n: number): number[] {
	const gains: number[] = [];
	const losses: number[] = [];
	const rows: number[] = [];
	for (let i = 1; i < x.length; i++) {
		if (!isNaN(x[i]!) && !isNaN(x[i - 1]!)) {
			const change = x[i]! - x[i - 1]!;
			gains.push(Math.max(change, 0));
			losses.push(Math.max(-change, 0));
			rows.push(i);
		}
	}
	const g = wilder(gains, n);
	const l = wilder(losses, n);
	const out = Array.from({ length: x.length }, () => NaN);
	rows.forEach((row, k) => {
		const gain = g[k]!;
		const loss = l[k]!;
		out[row] = isNaN(gain) ? NaN : loss === 0 ? 100 : gain === 0 ? 0 : 100 - 100 / (1 + gain / loss);
	});
	return out;
}

function atrRef(h: ArrayLike<number>, l: ArrayLike<number>, c: ArrayLike<number>, n: number): number[] {
	const ranges: number[] = [];
	const rows: number[] = [];
	for (let i = 0; i < h.length; i++) {
		if (isNaN(h[i]!) || isNaN(l[i]!)) {
			continue;
		}
		const previous = i > 0 ? c[i - 1]! : NaN;
		const range = isNaN(previous)
			? h[i]! - l[i]!
			: Math.max(h[i]! - l[i]!, Math.abs(h[i]! - previous), Math.abs(l[i]! - previous));
		ranges.push(range);
		rows.push(i);
	}
	const smoothed = wilder(ranges, n);
	const out = Array.from({ length: h.length }, () => NaN);
	rows.forEach((row, k) => {
		out[row] = smoothed[k]!;
	});
	return out;
}

function bollingerRef(x: ArrayLike<number>, n: number, k: number): number[][] {
	const upper: number[] = [];
	const middle: number[] = [];
	const lower: number[] = [];
	for (let i = 0; i < x.length; i++) {
		const w = window(x, i, n);
		if (w === null) {
			upper.push(NaN);
			middle.push(NaN);
			lower.push(NaN);
			continue;
		}
		const mean = w.reduce((a, b) => a + b, 0) / n;
		const variance = w.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
		const sd = Math.sqrt(variance);
		upper.push(mean + k * sd);
		middle.push(mean);
		lower.push(mean - k * sd);
	}
	return [upper, middle, lower];
}

function extremeRef(x: ArrayLike<number>, n: number, max: boolean): number[] {
	return Array.from({ length: x.length }, (_, i) => {
		const w = window(x, i, n);
		return w === null ? NaN : max ? Math.max(...w) : Math.min(...w);
	});
}

function stochasticRef(
	h: ArrayLike<number>,
	l: ArrayLike<number>,
	c: ArrayLike<number>,
	k: number,
	s: number,
	d: number,
) {
	const raw = Array.from({ length: h.length }, (_, i) => {
		const hw = window(h, i, k);
		const lw = window(l, i, k);
		if (hw === null || lw === null || isNaN(c[i]!)) {
			return NaN;
		}
		const value = (100 * (c[i]! - Math.min(...lw))) / (Math.max(...hw) - Math.min(...lw));
		return Number.isFinite(value) ? value : NaN;
	});
	const kLine = smaRef(raw, s);
	return [kLine, smaRef(kLine, d)];
}

function vwapRef(h: number[], l: number[], c: number[], v: number[], t: number[], anchor: number): number[] {
	const out: number[] = [];
	let period = NaN;
	let weighted = 0;
	let volume = 0;
	for (let i = 0; i < h.length; i++) {
		const current = anchor > 0 ? Math.floor(t[i]! / anchor) : 0;
		if (current !== period) {
			period = current;
			weighted = 0;
			volume = 0;
		}
		const typical = (h[i]! + l[i]! + c[i]!) / 3;
		if (isNaN(typical) || isNaN(v[i]!)) {
			out.push(NaN);
			continue;
		}
		weighted += typical * v[i]!;
		volume += v[i]!;
		out.push(volume > 0 ? weighted / volume : NaN);
	}
	return out;
}

// Data: a random walk long enough to cross several chunk boundaries, with gaps.

interface Bars {
	t: number[];
	o: number[];
	h: number[];
	l: number[];
	c: number[];
	v: number[];
}

function bars(count: number, seed: number, gaps = 0.002): Bars {
	const r = random(seed);
	const out: Bars = { t: [], o: [], h: [], l: [], c: [], v: [] };
	let price = 1000;
	for (let i = 0; i < count; i++) {
		const open = price;
		price = Math.max(1, price + (r() - 0.5) * 4);
		const missing = r() < gaps;
		out.t.push(1_600_000_000_000 + i * 3_600_000);
		out.o.push(missing ? NaN : open);
		out.h.push(missing ? NaN : Math.max(open, price) + r() * 2);
		out.l.push(missing ? NaN : Math.min(open, price) - r() * 2);
		out.c.push(missing ? NaN : price);
		out.v.push(missing ? NaN : Math.round(r() * 1000));
	}
	return out;
}

/**
 * The first row where `actual` is not within `tolerance` of the reference's magnitude or has NaN
 * elsewhere, described; null when they agree everywhere.
 */
function mismatch(actual: ArrayLike<number>, expected: ArrayLike<number>, tolerance: number): string | null {
	if (actual.length !== expected.length) {
		return `${actual.length} rows instead of ${expected.length}`;
	}
	for (let i = 0; i < expected.length; i++) {
		const a = actual[i]!;
		const e = expected[i]!;
		if (isNaN(a) !== isNaN(e) || (!isNaN(e) && Math.abs(a - e) > tolerance * Math.max(1, Math.abs(e)))) {
			return `row ${i}: ${a} instead of ${e}`;
		}
	}
	return null;
}

function run(definition: IndicatorDefinition, values: Record<string, number>, inputs: ArrayLike<number>[], first = 0) {
	return computeIndicator(definition, resolveParams(definition.params, values), inputs, first);
}

// Crossing chunk boundaries matters for windowed kernels, which restart at every boundary.
const COUNT = 2 * CHUNK_ROWS + 3000;
// A global index that puts the data on both sides of zero, as prepended history is.
const FIRST = -CHUNK_ROWS - 1234;
const data = bars(COUNT, 7);

describe('indicator kernels against brute force', () => {
	for (const first of [0, FIRST]) {
		describe(`first row at global index ${first}`, () => {
			it('sma', () => {
				for (const period of [1, 2, 20, 200]) {
					expect(mismatch(run(sma, { period }, [data.c], first)[0]!, smaRef(data.c, period), 1e-9)).toBeNull();
				}
			});

			it('ema', () => {
				for (const period of [1, 12, 100]) {
					expect(mismatch(run(ema, { period }, [data.c], first)[0]!, emaRef(data.c, period), 1e-12)).toBeNull();
				}
			});

			it('wma', () => {
				for (const period of [1, 2, 9, 50]) {
					expect(mismatch(run(wma, { period }, [data.c], first)[0]!, wmaRef(data.c, period), 1e-9)).toBeNull();
				}
			});

			it('rsi', () => {
				for (const period of [1, 14]) {
					expect(mismatch(run(rsi, { period }, [data.c], first)[0]!, rsiRef(data.c, period), 1e-9)).toBeNull();
				}
			});

			it('macd', () => {
				const [line, signal, histogram] = run(macd, {}, [data.c], first);
				const fast = emaRef(data.c, 12);
				const slow = emaRef(data.c, 26);
				const expectedLine = fast.map((f, i) => f - slow[i]!);
				const expectedSignal = emaRef(expectedLine, 9);
				expect(mismatch(line!, expectedLine, 1e-9)).toBeNull();
				expect(mismatch(signal!, expectedSignal, 1e-9)).toBeNull();
				expect(
					mismatch(
						histogram!,
						expectedLine.map((m, i) => m - expectedSignal[i]!),
						1e-9,
					),
				).toBeNull();
			});

			it('bollinger', () => {
				const outputs = run(bollinger, { period: 20, multiplier: 2.5 }, [data.c], first);
				const expected = bollingerRef(data.c, 20, 2.5);
				for (let o = 0; o < 3; o++) {
					expect(mismatch(outputs[o]!, expected[o]!, 1e-9)).toBeNull();
				}
			});

			it('atr', () => {
				expect(
					mismatch(run(atr, {}, [data.h, data.l, data.c], first)[0]!, atrRef(data.h, data.l, data.c, 14), 1e-9),
				).toBeNull();
			});

			it('stochastic', () => {
				for (const [k, s, d] of [
					[14, 1, 3],
					[5, 3, 4],
				] as const) {
					const outputs = run(stochastic, { kPeriod: k, kSmooth: s, dPeriod: d }, [data.h, data.l, data.c], first);
					const expected = stochasticRef(data.h, data.l, data.c, k, s, d);
					expect(mismatch(outputs[0]!, expected[0]!, 1e-9)).toBeNull();
					expect(mismatch(outputs[1]!, expected[1]!, 1e-9)).toBeNull();
				}
			});

			it('vwap, by day and over everything', () => {
				for (const anchor of [86_400_000, 0]) {
					const output = run(vwap, { anchor }, [data.h, data.l, data.c, data.v, data.t], first)[0]!;
					expect(mismatch(output, vwapRef(data.h, data.l, data.c, data.v, data.t, anchor), 1e-9)).toBeNull();
				}
			});

			it('highest and lowest, exactly', () => {
				for (const period of [1, 3, 20, 300]) {
					expect([...run(highest, { period }, [data.h], first)[0]!]).toEqual(extremeRef(data.h, period, true));
					expect([...run(lowest, { period }, [data.l], first)[0]!]).toEqual(extremeRef(data.l, period, false));
				}
			});
		});
	}

	it('chains: an SMA of an RSI is the SMA of the RSI values', () => {
		const values = run(rsi, {}, [data.c])[0]!;
		expect(mismatch(run(sma, { period: 9 }, [values])[0]!, smaRef(values, 9), 1e-9)).toBeNull();
	});

	it('warm-up: outputs are NaN for exactly `warmup` rows on data without gaps', () => {
		const clean = bars(500, 3, 0);
		const cases: [IndicatorDefinition, Record<string, number>, number[][]][] = [
			[sma, { period: 20 }, [clean.c]],
			[ema, { period: 20 }, [clean.c]],
			[wma, { period: 20 }, [clean.c]],
			[rsi, { period: 14 }, [clean.c]],
			[macd, {}, [clean.c]],
			[bollinger, {}, [clean.c]],
			[atr, {}, [clean.h, clean.l, clean.c]],
			[stochastic, { kPeriod: 14, kSmooth: 3, dPeriod: 3 }, [clean.h, clean.l, clean.c]],
			[vwap, {}, [clean.h, clean.l, clean.c, clean.v, clean.t]],
			[highest, { period: 20 }, [clean.h]],
			[lowest, { period: 20 }, [clean.l]],
		];
		for (const [definition, values, inputs] of cases) {
			const params = resolveParams(definition.params, values);
			const warmup = definition.warmup(params);
			const outputs = computeIndicator(definition, params, inputs);
			// Some output is undefined during the warm-up (the MACD line comes before its signal).
			for (let i = 0; i < warmup; i++) {
				expect(
					outputs.some(output => isNaN(output[i]!)),
					`${definition.name} row ${i}`,
				).toBe(true);
			}
			// Every output is defined from the warm-up on.
			for (const output of outputs) {
				expect(output[warmup]).not.toBeNaN();
			}
		}
	});

	it('windowed values do not depend on where the computation started', () => {
		// The same rows computed as part of a longer history and on their own give the same bits from
		// the first chunk boundary whose window lies inside both.
		const offset = 5000;
		const tail = { h: data.h.slice(offset), l: data.l.slice(offset), c: data.c.slice(offset) };
		const boundary = CHUNK_ROWS - FIRST - offset;
		const cases: [IndicatorDefinition, Record<string, number>, (b: typeof tail) => number[][]][] = [
			[sma, { period: 50 }, b => [b.c]],
			[wma, { period: 50 }, b => [b.c]],
			[bollinger, {}, b => [b.c]],
			[stochastic, {}, b => [b.h, b.l, b.c]],
			[highest, { period: 50 }, b => [b.h]],
		];
		for (const [definition, values, pick] of cases) {
			const whole = run(definition, values, pick(data), FIRST);
			const part = run(definition, values, pick(tail), FIRST + offset);
			for (let o = 0; o < whole.length; o++) {
				const a = whole[o]!.subarray(offset + boundary);
				const b = part[o]!.subarray(boundary);
				expect(Array.from(b)).toEqual(Array.from(a));
			}
		}
	});

	it('rejects parameters out of range', () => {
		expect(() => resolveParams(sma.params, { period: 0 })).toThrow(RangeError);
		expect(() => resolveParams(sma.params, { period: 2.5 })).toThrow(RangeError);
		expect(() => resolveParams(sma.params, { period: Number.NaN })).toThrow(RangeError);
		expect([...resolveParams(macd.params, { slow: 30 })]).toEqual([12, 30, 9]);
	});
});
