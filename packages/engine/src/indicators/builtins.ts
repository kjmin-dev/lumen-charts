import type { IndicatorDefinition, IndicatorParam } from './definition';
import {
	atrKernel,
	bollingerKernel,
	emaKernel,
	highestKernel,
	lowestKernel,
	macdKernel,
	rsiKernel,
	smaKernel,
	stochasticKernel,
	vwapKernel,
	wmaKernel,
} from './kernels';

function period(value: number): IndicatorParam {
	return { name: 'period', default: value, min: 1, max: 100_000, integer: true };
}

const constant = (value: number) => (): number => value;
const window =
	(index: number) =>
	(params: Float64Array): number =>
		params[index]! - 1;

export const sma: IndicatorDefinition = {
	name: 'sma',
	inputs: ['close'],
	outputs: [{ name: 'value', color: '#f5b83d' }],
	params: [period(20)],
	windowed: true,
	kernel: smaKernel,
	stateSize: constant(3),
	lookback: window(0),
	warmup: window(0),
};

export const ema: IndicatorDefinition = {
	name: 'ema',
	inputs: ['close'],
	outputs: [{ name: 'value', color: '#7e57c2' }],
	params: [period(20)],
	kernel: emaKernel,
	stateSize: constant(3),
	lookback: constant(0),
	warmup: window(0),
};

export const wma: IndicatorDefinition = {
	name: 'wma',
	inputs: ['close'],
	outputs: [{ name: 'value', color: '#26c6da' }],
	params: [period(20)],
	windowed: true,
	kernel: wmaKernel,
	stateSize: constant(4),
	lookback: window(0),
	warmup: window(0),
};

export const rsi: IndicatorDefinition = {
	name: 'rsi',
	inputs: ['close'],
	outputs: [{ name: 'value', color: '#ab47bc' }],
	params: [period(14)],
	kernel: rsiKernel,
	stateSize: constant(6),
	lookback: constant(1),
	warmup: params => params[0]!,
};

export const macd: IndicatorDefinition = {
	name: 'macd',
	inputs: ['close'],
	outputs: [
		{ name: 'macd', color: '#2962ff' },
		{ name: 'signal', color: '#ff6d00' },
		{ name: 'histogram', style: 'histogram', color: '#26a69a' },
	],
	params: [
		{ name: 'fast', default: 12, min: 1, max: 100_000, integer: true },
		{ name: 'slow', default: 26, min: 1, max: 100_000, integer: true },
		{ name: 'signal', default: 9, min: 1, max: 100_000, integer: true },
	],
	kernel: macdKernel,
	stateSize: constant(9),
	lookback: constant(0),
	warmup: params => Math.max(params[0]!, params[1]!) + params[2]! - 2,
};

export const bollinger: IndicatorDefinition = {
	name: 'bollinger',
	inputs: ['close'],
	outputs: [
		{ name: 'upper', color: '#42a5f5' },
		{ name: 'middle', color: '#ffa726' },
		{ name: 'lower', color: '#42a5f5' },
	],
	params: [period(20), { name: 'multiplier', default: 2, min: 0, max: 1000 }],
	windowed: true,
	kernel: bollingerKernel,
	stateSize: constant(6),
	lookback: window(0),
	warmup: window(0),
};

export const atr: IndicatorDefinition = {
	name: 'atr',
	inputs: ['high', 'low', 'close'],
	outputs: [{ name: 'value', color: '#ef5350' }],
	params: [period(14)],
	kernel: atrKernel,
	stateSize: constant(3),
	lookback: constant(1),
	warmup: window(0),
};

export const stochastic: IndicatorDefinition = {
	name: 'stochastic',
	inputs: ['high', 'low', 'close'],
	outputs: [
		{ name: 'k', color: '#2962ff' },
		{ name: 'd', color: '#ff6d00' },
	],
	params: [
		{ name: 'kPeriod', default: 14, min: 1, max: 100_000, integer: true },
		{ name: 'kSmooth', default: 1, min: 1, max: 100_000, integer: true },
		{ name: 'dPeriod', default: 3, min: 1, max: 100_000, integer: true },
	],
	windowed: true,
	kernel: stochasticKernel,
	stateSize: constant(0),
	lookback: params => params[0]! + params[1]! + params[2]! - 3,
	warmup: params => params[0]! + params[1]! + params[2]! - 3,
};

export const vwap: IndicatorDefinition = {
	name: 'vwap',
	inputs: ['high', 'low', 'close', 'volume', 'time'],
	outputs: [{ name: 'value', color: '#ec407a' }],
	params: [{ name: 'anchor', default: 86_400_000, min: 0 }],
	kernel: vwapKernel,
	stateSize: constant(4),
	lookback: constant(0),
	warmup: constant(0),
};

export const highest: IndicatorDefinition = {
	name: 'highest',
	inputs: ['high'],
	outputs: [{ name: 'value', color: '#66bb6a' }],
	params: [period(20)],
	windowed: true,
	kernel: highestKernel,
	stateSize: constant(0),
	lookback: window(0),
	warmup: window(0),
};

export const lowest: IndicatorDefinition = {
	name: 'lowest',
	inputs: ['low'],
	outputs: [{ name: 'value', color: '#ef5350' }],
	params: [period(20)],
	windowed: true,
	kernel: lowestKernel,
	stateSize: constant(0),
	lookback: window(0),
	warmup: window(0),
};

/** Every built-in indicator, by name. */
export const BUILTIN_INDICATORS: readonly IndicatorDefinition[] = [
	sma,
	ema,
	wma,
	rsi,
	macd,
	bollinger,
	atr,
	stochastic,
	vwap,
	highest,
	lowest,
];
