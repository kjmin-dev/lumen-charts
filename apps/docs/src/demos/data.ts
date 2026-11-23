// Deterministic synthetic market datasets for the documentation's live chart demos.
// All generators use a seeded PRNG so builds, screenshots and browser checks stay reproducible.

export interface CandleDataset {
	time: Float64Array;
	open: Float64Array;
	high: Float64Array;
	low: Float64Array;
	close: Float64Array;
	volume: Float64Array;
}

export interface OrderBookDataset {
	time: Float64Array;
	priceStart: Float64Array;
	priceStep: number;
	rows: number;
	values: Float32Array;
}

export interface TradeScatterDataset {
	time: Float64Array;
	price: Float64Array;
	value: Float32Array;
	size: Float32Array;
}

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Realistic OHLCV bars with gentle regime swings and volatility clustering. */
export function generateCandles(options: {
	count: number;
	stepMs: number;
	startTime: number;
	startPrice?: number;
	volatility?: number;
	seed?: number;
}): CandleDataset {
	const { count, stepMs, startTime, startPrice = 180, volatility = 0.0045, seed = 42 } = options;
	const rand = mulberry32(seed);
	const time = new Float64Array(count);
	const open = new Float64Array(count);
	const high = new Float64Array(count);
	const low = new Float64Array(count);
	const close = new Float64Array(count);
	const volume = new Float64Array(count);

	let price = startPrice;
	let vol = volatility;
	let drift = 0.00018;

	for (let i = 0; i < count; i++) {
		if (i % 70 === 0) {
			drift = (rand() - 0.46) * 0.0012;
		}
		// Box-Muller approximate normal from two uniforms.
		const shock = rand() + rand() + rand() - 1.5;
		vol = vol * 0.92 + volatility * (0.65 + Math.abs(shock) * 0.7) * 0.08;
		const change = price * (drift + shock * vol);
		const next = Math.max(price * 0.25, price + change);
		const body = Math.abs(next - price);
		const wickUp = (0.15 + rand() * 0.9) * (body + price * vol * 0.35);
		const wickDown = (0.15 + rand() * 0.9) * (body + price * vol * 0.35);

		time[i] = startTime + i * stepMs;
		open[i] = price;
		close[i] = next;
		high[i] = Math.max(price, next) + wickUp;
		low[i] = Math.max(0.01, Math.min(price, next) - wickDown);
		volume[i] = Math.round((120 + rand() * 340) * (1 + (body / (price * volatility)) * 1.4));
		price = next;
	}

	return { time, open, high, low, close, volume };
}

/** Intraday bars across several US equity sessions (04:00-20:00 America/New_York, 5-minute steps). */
export function generateSessionCandles(days = 5, seed = 108): CandleDataset {
	const rand = mulberry32(seed);
	const stepMs = 5 * 60_000;
	// Monday 2025-05-05 in EDT (UTC-4): 04:00 EDT = 08:00 UTC, 20:00 EDT = 24:00 UTC (192 bars/day).
	const barsPerDay = (16 * 60) / 5;
	const count = days * barsPerDay;
	const time = new Float64Array(count);
	const open = new Float64Array(count);
	const high = new Float64Array(count);
	const low = new Float64Array(count);
	const close = new Float64Array(count);
	const volume = new Float64Array(count);

	let price = 524;
	let index = 0;
	for (let day = 0; day < days; day++) {
		const dayOpenUtc = Date.UTC(2025, 4, 5 + day, 8, 0);
		for (let slot = 0; slot < barsPerDay; slot++) {
			const hourLocal = 4 + (slot * 5) / 60;
			const isRegular = hourLocal >= 9.5 && hourLocal < 16;
			const scale = isRegular ? 0.0018 : 0.00075;
			const shock = rand() + rand() + rand() - 1.5;
			const next = Math.max(100, price + price * (0.00004 + shock * scale));
			const spread = Math.abs(next - price) + price * scale * 0.4;
			time[index] = dayOpenUtc + slot * stepMs;
			open[index] = price;
			close[index] = next;
			high[index] = Math.max(price, next) + rand() * spread;
			low[index] = Math.min(price, next) - rand() * spread;
			volume[index] = Math.round((isRegular ? 950 : 160) * (0.5 + rand() * 1.5));
			price = next;
			index++;
		}
	}

	return { time, open, high, low, close, volume };
}

/** Order-book heatmap grid that follows the candle mid-price, plus trade prints on top. */
export function generateOrderBookAndTrades(
	candles: CandleDataset,
	stepMs: number,
	seed = 77,
): { book: OrderBookDataset; trades: TradeScatterDataset } {
	const rand = mulberry32(seed);
	const cols = candles.time.length;
	const rows = 44;
	const priceStep = 0.25;
	const priceStart = new Float64Array(cols);
	const values = new Float32Array(cols * rows);

	// Two persistent liquidity walls that drift slowly with the book.
	let bidWallOffset = 10;
	let askWallOffset = 33;

	for (let c = 0; c < cols; c++) {
		const mid = (candles.open[c]! + candles.close[c]!) * 0.5;
		const baseRow = Math.round((mid - (rows * priceStep) / 2) / priceStep);
		priceStart[c] = baseRow * priceStep;
		if (c % 25 === 0) {
			bidWallOffset = 8 + Math.floor(rand() * 8);
			askWallOffset = 28 + Math.floor(rand() * 9);
		}
		const base = c * rows;
		for (let r = 0; r < rows; r++) {
			const cellPrice = priceStart[c]! + (r + 0.5) * priceStep;
			const dist = Math.abs(cellPrice - mid);
			if (dist < priceStep * 1.2) {
				values[base + r] = Number.NaN;
				continue;
			}
			const nearMid = Math.exp(-dist * 0.35) * 45;
			const bidWall = Math.exp(-((r - bidWallOffset) ** 2) / 3.2) * 190;
			const askWall = Math.exp(-((r - askWallOffset) ** 2) / 3.2) * 180;
			const noise = rand() * 24;
			const size = nearMid + bidWall + askWall + noise;
			values[base + r] = size > 14 ? size : Number.NaN;
		}
	}

	// ~5 trades per bar distributed inside each candle's time and price range.
	const tradesPerBar = 5;
	const totalTrades = cols * tradesPerBar;
	const tradeTime = new Float64Array(totalTrades);
	const tradePrice = new Float64Array(totalTrades);
	const tradeValue = new Float32Array(totalTrades);
	const tradeSize = new Float32Array(totalTrades);

	let cursor = 0;
	for (let c = 0; c < cols; c++) {
		const t0 = candles.time[c]!;
		const lo = candles.low[c]!;
		const hi = candles.high[c]!;
		const offsets = Array.from({ length: tradesPerBar }, () => rand()).toSorted((a, b) => a - b);
		for (let k = 0; k < tradesPerBar; k++) {
			const frac = offsets[k]!;
			const notional = Math.pow(10, 0.8 + rand() * 2.1);
			tradeTime[cursor] = t0 + Math.floor(frac * (stepMs - 1));
			tradePrice[cursor] = lo + rand() * (hi - lo);
			tradeValue[cursor] = notional;
			tradeSize[cursor] = 2 + Math.min(7, Math.log10(notional) * 2.1);
			cursor++;
		}
	}

	return {
		book: { time: candles.time, priceStart, priceStep, rows, values },
		trades: { time: tradeTime, price: tradePrice, value: tradeValue, size: tradeSize },
	};
}
