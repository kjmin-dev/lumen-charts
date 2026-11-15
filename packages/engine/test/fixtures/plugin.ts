// A plugin module of indicators, as an application would ship one: definitions only.
import { type IndicatorDefinition, defineIndicator } from '@lumen-charts/engine';

/** Rows each kernel has computed, so tests can tell a partial recomputation from a full one. */
export const counts = { momentum: 0, range: 0, decay: 0 };

/** Difference between the value and the value `period` rows back. Windowed. */
const momentum: IndicatorDefinition = defineIndicator({
	name: 'test-momentum',
	inputs: ['close'],
	outputs: [{ name: 'value', style: 'histogram' }],
	params: [{ name: 'period', default: 10, min: 1, integer: true }],
	windowed: true,
	stateSize: () => 0,
	lookback: params => params[0]!,
	warmup: params => params[0]!,
	kernel(buffer, offset, length, _state, _carry, params) {
		const period = params[0]!;
		const stride = buffer.length / 2;
		for (let r = offset; r < offset + length; r++) {
			buffer[stride + r] = buffer[r]! - buffer[r - period]!;
		}
		counts.momentum += length;
	},
});

/** Running sum of high minus low since the first bar. Cumulative. */
const range: IndicatorDefinition = defineIndicator({
	name: 'test-range',
	inputs: ['high', 'low'],
	outputs: [{ name: 'value' }],
	params: [],
	stateSize: () => 1,
	lookback: () => 0,
	warmup: () => 0,
	kernel(buffer, offset, length, state) {
		const stride = buffer.length / 3;
		let sum = state[0]!;
		for (let r = offset; r < offset + length; r++) {
			const value = buffer[r]! - buffer[stride + r]!;
			if (value === value) {
				sum += value;
			}
			buffer[2 * stride + r] = sum;
		}
		state[0] = sum;
		counts.range += length;
	},
});

/** Exponential average with weight one half, starting at the first value. Cumulative, forgets fast. */
const decay: IndicatorDefinition = defineIndicator({
	name: 'test-decay',
	inputs: ['close'],
	outputs: [{ name: 'value' }],
	params: [],
	stateSize: () => 2,
	lookback: () => 0,
	warmup: () => 0,
	kernel(buffer, offset, length, state) {
		const stride = buffer.length / 2;
		for (let r = offset; r < offset + length; r++) {
			const value = buffer[r]!;
			if (value === value) {
				state[1] = state[0] === 0 ? value : (state[1]! + value) / 2;
				state[0] = 1;
			}
			buffer[stride + r] = state[0] === 0 ? NaN : state[1]!;
		}
		counts.decay += length;
	},
});

export default [momentum, range, decay];
