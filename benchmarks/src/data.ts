// Deterministic market data for benchmarks.
//
// Only integer operations, +, -, * and / are used, so the same seed and count give bit-identical
// output in every JavaScript engine (Math.log, Math.cos and friends are allowed to differ).

/** OHLCV bars as columns. `time` is UTC milliseconds and strictly increasing. */
export interface CandleColumns {
	readonly kind: 'candles';
	readonly length: number;
	readonly time: Float64Array;
	readonly open: Float64Array;
	readonly high: Float64Array;
	readonly low: Float64Array;
	readonly close: Float64Array;
	readonly volume: Float64Array;
}

/** Single-value points as columns. `time` is UTC milliseconds and strictly increasing. */
export interface LineColumns {
	readonly kind: 'line';
	readonly length: number;
	readonly time: Float64Array;
	readonly value: Float64Array;
}

export type SeriesColumns = CandleColumns | LineColumns;
export type SeriesKind = SeriesColumns['kind'];

/** Tick kinds stored in `TickColumns.kind`. */
export const TICK_UPDATE = 0;
export const TICK_NEW_BAR = 1;

/**
 * Updates against the tail of a series, as columns. Row `i` is the full state of the tail bar after
 * tick `i`: either the last bar modified in place (same time) or a new bar appended after it.
 */
export interface CandleTickColumns {
	readonly kind: 'candles';
	readonly length: number;
	/** `TICK_UPDATE` or `TICK_NEW_BAR` per tick. */
	readonly tickKind: Uint8Array;
	readonly time: Float64Array;
	readonly open: Float64Array;
	readonly high: Float64Array;
	readonly low: Float64Array;
	readonly close: Float64Array;
	readonly volume: Float64Array;
}

export interface LineTickColumns {
	readonly kind: 'line';
	readonly length: number;
	readonly tickKind: Uint8Array;
	readonly time: Float64Array;
	readonly value: Float64Array;
}

export type TickColumns = CandleTickColumns | LineTickColumns;

export interface SeriesOptions {
	/** Seed for the generator. Any 32-bit integer. */
	seed: number;
	/** Number of rows. */
	count: number;
	/** Time of the first row in UTC milliseconds. Default 2000-01-01T00:00:00Z. */
	startTime?: number;
	/** Time step in milliseconds. Default one minute. */
	intervalMs?: number;
	/** Price of the first row. Default 100. */
	startPrice?: number;
}

export interface TickOptions {
	seed: number;
	/** Number of ticks. */
	count: number;
	/** Every `newBarEvery`-th tick starts a new bar; all others modify the last bar. Default 10. */
	newBarEvery?: number;
	/** Time step between bars in milliseconds. Default one minute. */
	intervalMs?: number;
}

const DEFAULT_START_TIME = Date.UTC(2000, 0, 1);
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_START_PRICE = 100;
const DEFAULT_NEW_BAR_EVERY = 10;

// Random walk parameters. The pull towards the start price keeps a series of any length
// within roughly ±25% of it, so 10 million points do not drift to zero or infinity.
const VOLATILITY = 0.001;
const REVERSION = 0.0001;
const PRICE_STEP = 0.01;
const BASE_VOLUME = 1000;
// sqrt(3): scales the sum of four uniforms (variance 1/3) to unit variance.
const SQRT3 = 1.7320508075688772;

/**
 * Small, fast 32-bit PRNG (sfc32 seeded through splitmix32). Uses only integer arithmetic, so the
 * sequence is the same in every engine.
 */
export class Random {
	private _a: number;
	private _b: number;
	private _c: number;
	private _d: number;

	public constructor(seed: number) {
		let s = seed | 0;
		const next = (): number => {
			s = (s + 0x9e3779b9) | 0;
			let z = s;
			z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
			z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
			return (z ^ (z >>> 16)) >>> 0;
		};
		this._a = next();
		this._b = next();
		this._c = next();
		this._d = next();
		// Discard the first outputs, which correlate with the seed.
		for (let i = 0; i < 12; i++) {
			this.nextUint32();
		}
	}

	/** Uniform integer in [0, 2^32). */
	public nextUint32(): number {
		const t = (((this._a + this._b) | 0) + this._d) | 0;
		this._d = (this._d + 1) | 0;
		this._a = this._b ^ (this._b >>> 9);
		this._b = (this._c + (this._c << 3)) | 0;
		this._c = (this._c << 21) | (this._c >>> 11);
		this._c = (this._c + t) | 0;
		return t >>> 0;
	}

	/** Uniform float in [0, 1). */
	public next(): number {
		return this.nextUint32() / 4294967296;
	}

	/** Approximately standard normal value in [-2√3, 2√3]: sum of four uniforms, centered and scaled. */
	public nextNormal(): number {
		return (this.next() + this.next() + this.next() + this.next() - 2) * SQRT3;
	}
}

function roundPrice(value: number): number {
	return Math.round(value / PRICE_STEP) * PRICE_STEP;
}

function step(random: Random, price: number, anchor: number): number {
	return price + price * VOLATILITY * random.nextNormal() + REVERSION * (anchor - price);
}

/** Generates OHLCV bars. Each bar opens at the previous close. */
export function generateCandles(options: SeriesOptions): CandleColumns {
	const { seed, count } = options;
	const startTime = options.startTime ?? DEFAULT_START_TIME;
	const interval = options.intervalMs ?? DEFAULT_INTERVAL_MS;
	const anchor = options.startPrice ?? DEFAULT_START_PRICE;
	const random = new Random(seed);
	const time = new Float64Array(count);
	const open = new Float64Array(count);
	const high = new Float64Array(count);
	const low = new Float64Array(count);
	const close = new Float64Array(count);
	const volume = new Float64Array(count);
	let price = anchor;
	let previousClose = roundPrice(anchor);
	for (let i = 0; i < count; i++) {
		price = step(random, price, anchor);
		const o = previousClose;
		const c = roundPrice(price);
		const top = o > c ? o : c;
		const bottom = o < c ? o : c;
		time[i] = startTime + i * interval;
		open[i] = o;
		close[i] = c;
		high[i] = roundPrice(top + top * VOLATILITY * random.next());
		low[i] = roundPrice(bottom - bottom * VOLATILITY * random.next());
		volume[i] = Math.round(BASE_VOLUME * (0.2 + 1.8 * random.next()));
		previousClose = c;
	}
	return { kind: 'candles', length: count, time, open, high, low, close, volume };
}

/** Generates single-value points following the same random walk as the candle closes. */
export function generateLine(options: SeriesOptions): LineColumns {
	const { seed, count } = options;
	const startTime = options.startTime ?? DEFAULT_START_TIME;
	const interval = options.intervalMs ?? DEFAULT_INTERVAL_MS;
	const anchor = options.startPrice ?? DEFAULT_START_PRICE;
	const random = new Random(seed);
	const time = new Float64Array(count);
	const value = new Float64Array(count);
	let price = anchor;
	for (let i = 0; i < count; i++) {
		price = step(random, price, anchor);
		time[i] = startTime + i * interval;
		value[i] = roundPrice(price);
	}
	return { kind: 'line', length: count, time, value };
}

export function generateSeries(kind: SeriesKind, options: SeriesOptions): SeriesColumns {
	return kind === 'candles' ? generateCandles(options) : generateLine(options);
}

/**
 * Generates ticks that continue `series` from its last row. Tick `i` starts a new bar when
 * `(i + 1) % newBarEvery === 0`, so the first tick always updates the existing last bar.
 */
export function generateTicks(series: SeriesColumns, options: TickOptions): TickColumns {
	const { seed, count } = options;
	const interval = options.intervalMs ?? DEFAULT_INTERVAL_MS;
	const newBarEvery = options.newBarEvery ?? DEFAULT_NEW_BAR_EVERY;
	if (series.length === 0) {
		throw new Error('Ticks need a series with at least one row');
	}
	if (!(newBarEvery >= 1)) {
		throw new Error('newBarEvery must be at least 1');
	}
	const random = new Random(seed);
	const last = series.length - 1;
	const tickKind = new Uint8Array(count);
	const time = new Float64Array(count);
	let barTime = series.time[last] ?? 0;
	const isNewBar = (i: number): boolean => (i + 1) % newBarEvery === 0;

	if (series.kind === 'line') {
		const value = new Float64Array(count);
		let price = series.value[last] ?? DEFAULT_START_PRICE;
		const anchor = price;
		for (let i = 0; i < count; i++) {
			if (isNewBar(i)) {
				barTime += interval;
				tickKind[i] = TICK_NEW_BAR;
			}
			price = step(random, price, anchor);
			time[i] = barTime;
			value[i] = roundPrice(price);
		}
		return { kind: 'line', length: count, tickKind, time, value };
	}

	const open = new Float64Array(count);
	const high = new Float64Array(count);
	const low = new Float64Array(count);
	const close = new Float64Array(count);
	const volume = new Float64Array(count);
	let o = series.open[last] ?? DEFAULT_START_PRICE;
	let h = series.high[last] ?? o;
	let l = series.low[last] ?? o;
	let c = series.close[last] ?? o;
	let v = series.volume[last] ?? 0;
	let price = c;
	const anchor = c;
	for (let i = 0; i < count; i++) {
		price = step(random, price, anchor);
		const p = roundPrice(price);
		const size = Math.round(1 + 99 * random.next());
		if (isNewBar(i)) {
			barTime += interval;
			tickKind[i] = TICK_NEW_BAR;
			o = c;
			h = o > p ? o : p;
			l = o < p ? o : p;
			v = size;
		} else {
			h = h > p ? h : p;
			l = l < p ? l : p;
			v += size;
		}
		c = p;
		time[i] = barTime;
		open[i] = o;
		high[i] = h;
		low[i] = l;
		close[i] = c;
		volume[i] = v;
	}
	return { kind: 'candles', length: count, tickKind, time, open, high, low, close, volume };
}
