// The indicator set of the stage 3 scenarios. Shared by the page and the Node runner, so this module
// must stay free of DOM and Node APIs.

/** Where an indicator input reads: a column of the candles, or the first output of an earlier entry. */
export type BenchInput = 'open' | 'high' | 'low' | 'close' | 'volume' | 'time' | { from: number };

export interface BenchIndicator {
	/** Name of the built-in definition. */
	readonly name: string;
	readonly params: Readonly<Record<string, number>>;
	/** One per input of the definition; omitted inputs read the definition's default column. */
	readonly inputs?: readonly BenchInput[];
}

/**
 * Twenty indicators as a trading screen might show them: moving averages of several lengths, the
 * usual oscillators and bands, and chains (an average of an oscillator). Ten are windowed (SMA, WMA,
 * Bollinger, Stochastic, highest, lowest), ten cumulative (EMA, RSI, MACD, ATR, VWAP and what reads
 * them). They have 25 outputs in all, one of them a histogram (MACD).
 */
export const INDICATOR_SET: readonly BenchIndicator[] = [
	{ name: 'sma', params: { period: 20 } },
	{ name: 'sma', params: { period: 50 } },
	{ name: 'sma', params: { period: 200 } },
	{ name: 'ema', params: { period: 12 } },
	{ name: 'ema', params: { period: 26 } },
	{ name: 'ema', params: { period: 100 } },
	{ name: 'wma', params: { period: 20 } },
	{ name: 'rsi', params: { period: 14 } },
	{ name: 'macd', params: {} },
	{ name: 'bollinger', params: { period: 20, multiplier: 2 } },
	{ name: 'atr', params: { period: 14 } },
	{ name: 'stochastic', params: { kPeriod: 14, kSmooth: 1, dPeriod: 3 } },
	{ name: 'vwap', params: {} },
	{ name: 'highest', params: { period: 20 } },
	{ name: 'lowest', params: { period: 20 } },
	{ name: 'sma', params: { period: 9 }, inputs: [{ from: 7 }] },
	{ name: 'ema', params: { period: 9 }, inputs: [{ from: 10 }] },
	{ name: 'wma', params: { period: 9 }, inputs: [{ from: 8 }] },
	{ name: 'ema', params: { period: 50 }, inputs: ['high'] },
	{ name: 'rsi', params: { period: 7 } },
];
