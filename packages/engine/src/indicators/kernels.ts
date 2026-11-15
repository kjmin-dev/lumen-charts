// Built-in indicator kernels. Each follows the contract of `IndicatorKernel`: column-major
// buffer (inputs, then outputs), carry rows in front of `offset`, state that is all zeros on a
// fresh start. Only +, -, *, / and Math.sqrt are used, so results are the same bits everywhere.

/**
 * One step of an exponential moving average seeded with the simple average of its first `period`
 * values. State at `at`: count, sum, average. Returns the average, or NaN during the warm-up and for
 * a missing value (which leaves the state alone).
 */
function emaStep(state: Float64Array, at: number, value: number, period: number, alpha: number): number {
	if (value !== value) {
		return NaN;
	}
	const count = state[at]!;
	if (count < period) {
		const sum = state[at + 1]! + value;
		state[at + 1] = sum;
		state[at] = count + 1;
		if (count + 1 < period) {
			return NaN;
		}
		const average = sum / period;
		state[at + 2] = average;
		// The sum is not needed any more. Clearing it keeps in the state only what later rows depend
		// on, so a recomputation after a prepend can recognize the state it had before.
		state[at + 1] = 0;
		return average;
	}
	const average = state[at + 2]!;
	const next = average + alpha * (value - average);
	state[at + 2] = next;
	return next;
}

/** Wilder's smoothing (an EMA with alpha 1 / period), seeded like `emaStep`. Same state layout. */
function wilderStep(state: Float64Array, at: number, value: number, period: number): number {
	const count = state[at]!;
	if (count < period) {
		const sum = state[at + 1]! + value;
		state[at + 1] = sum;
		state[at] = count + 1;
		if (count + 1 < period) {
			return NaN;
		}
		const average = sum / period;
		state[at + 2] = average;
		state[at + 1] = 0;
		return average;
	}
	const next = (state[at + 2]! * (period - 1) + value) / period;
	state[at + 2] = next;
	return next;
}

/** Simple moving average. Inputs: value. Outputs: value. Params: period. Windowed. */
export function smaKernel(
	buffer: Float64Array,
	offset: number,
	length: number,
	state: Float64Array,
	carry: number,
	params: Float64Array,
): void {
	const period = params[0]!;
	const stride = buffer.length / 2;
	let sum = state[1]!;
	let missing = state[2]!;
	if (state[0] === 0) {
		// Fresh start: the window of the first row is the carry plus that row.
		sum = 0;
		missing = 0;
		for (let r = offset - carry; r < offset; r++) {
			const v = buffer[r]!;
			if (v === v) {
				sum += v;
			} else {
				missing++;
			}
		}
		state[0] = 1;
	}
	const back = period - 1;
	for (let r = offset, end = offset + length; r < end; r++) {
		const v = buffer[r]!;
		if (v === v) {
			sum += v;
		} else {
			missing++;
		}
		buffer[stride + r] = missing > 0 ? NaN : sum / period;
		const old = buffer[r - back]!;
		if (old === old) {
			sum -= old;
		} else {
			missing--;
		}
	}
	state[1] = sum;
	state[2] = missing;
}

/** Exponential moving average seeded with the simple average of the first `period` values. Cumulative. */
export function emaKernel(
	buffer: Float64Array,
	offset: number,
	length: number,
	state: Float64Array,
	_carry: number,
	params: Float64Array,
): void {
	const period = params[0]!;
	const alpha = 2 / (period + 1);
	const stride = buffer.length / 2;
	for (let r = offset, end = offset + length; r < end; r++) {
		buffer[stride + r] = emaStep(state, 0, buffer[r]!, period, alpha);
	}
}

/**
 * Linearly weighted moving average: the newest value weighs `period`, the oldest 1. Windowed.
 * State: started, sum and weighted sum of the `period - 1` values before the next row, missing count.
 */
export function wmaKernel(
	buffer: Float64Array,
	offset: number,
	length: number,
	state: Float64Array,
	carry: number,
	params: Float64Array,
): void {
	const period = params[0]!;
	const stride = buffer.length / 2;
	const denominator = (period * (period + 1)) / 2;
	let sum = state[1]!;
	let weighted = state[2]!;
	let missing = state[3]!;
	if (state[0] === 0) {
		sum = 0;
		weighted = 0;
		missing = 0;
		for (let r = offset - carry, weight = 1; r < offset; r++, weight++) {
			const v = buffer[r]!;
			if (v === v) {
				sum += v;
				weighted += weight * v;
			} else {
				missing++;
			}
		}
		state[0] = 1;
	}
	const back = period - 1;
	for (let r = offset, end = offset + length; r < end; r++) {
		let v = buffer[r]!;
		if (v !== v) {
			v = 0;
			missing++;
		}
		const windowSum = sum + v;
		const windowWeighted = weighted + period * v;
		buffer[stride + r] = missing > 0 ? NaN : windowWeighted / denominator;
		let old = buffer[r - back]!;
		if (old !== old) {
			old = 0;
			missing--;
		}
		// Every remaining value loses one unit of weight; the oldest one drops out.
		sum = windowSum - old;
		weighted = windowWeighted - windowSum;
	}
	state[1] = sum;
	state[2] = weighted;
	state[3] = missing;
}

/** Relative strength index with Wilder's smoothing. Cumulative; reads one row back. */
export function rsiKernel(
	buffer: Float64Array,
	offset: number,
	length: number,
	state: Float64Array,
	_carry: number,
	params: Float64Array,
): void {
	const period = params[0]!;
	const stride = buffer.length / 2;
	for (let r = offset, end = offset + length; r < end; r++) {
		const previous = buffer[r - 1]!;
		const current = buffer[r]!;
		if (previous !== previous || current !== current) {
			buffer[stride + r] = NaN;
			continue;
		}
		const change = current - previous;
		// Gains at 0 and losses at 3, always stepped together.
		const gain = wilderStep(state, 0, change > 0 ? change : 0, period);
		const loss = wilderStep(state, 3, change < 0 ? -change : 0, period);
		if (gain !== gain) {
			buffer[stride + r] = NaN;
		} else if (loss === 0) {
			buffer[stride + r] = 100;
		} else if (gain === 0) {
			buffer[stride + r] = 0;
		} else {
			buffer[stride + r] = 100 - 100 / (1 + gain / loss);
		}
	}
}

/**
 * Moving average convergence divergence. Inputs: value. Outputs: macd (fast EMA minus slow EMA),
 * signal (EMA of macd), histogram (macd minus signal). Params: fast, slow, signal. Cumulative.
 */
export function macdKernel(
	buffer: Float64Array,
	offset: number,
	length: number,
	state: Float64Array,
	_carry: number,
	params: Float64Array,
): void {
	const fast = params[0]!;
	const slow = params[1]!;
	const signal = params[2]!;
	const fastAlpha = 2 / (fast + 1);
	const slowAlpha = 2 / (slow + 1);
	const signalAlpha = 2 / (signal + 1);
	const stride = buffer.length / 4;
	for (let r = offset, end = offset + length; r < end; r++) {
		const v = buffer[r]!;
		const macd = emaStep(state, 0, v, fast, fastAlpha) - emaStep(state, 3, v, slow, slowAlpha);
		const line = emaStep(state, 6, macd, signal, signalAlpha);
		buffer[stride + r] = macd;
		buffer[2 * stride + r] = line;
		buffer[3 * stride + r] = macd - line;
	}
}

/**
 * Bollinger bands: the simple average plus and minus `multiplier` population standard deviations.
 * Outputs: upper, middle, lower. Windowed. Sums are kept relative to a value of the window (the
 * first one seen after a fresh start), which keeps the variance accurate for large prices.
 * State: started, has shift, shift, sum, sum of squares, missing count.
 */
export function bollingerKernel(
	buffer: Float64Array,
	offset: number,
	length: number,
	state: Float64Array,
	carry: number,
	params: Float64Array,
): void {
	const period = params[0]!;
	const multiplier = params[1]!;
	const stride = buffer.length / 4;
	let hasShift = state[1]!;
	let shift = state[2]!;
	let sum = state[3]!;
	let squares = state[4]!;
	let missing = state[5]!;
	if (state[0] === 0) {
		hasShift = 0;
		shift = 0;
		sum = 0;
		squares = 0;
		missing = 0;
		for (let r = offset - carry; r < offset; r++) {
			const v = buffer[r]!;
			if (v !== v) {
				missing++;
				continue;
			}
			if (hasShift === 0) {
				hasShift = 1;
				shift = v;
			}
			const d = v - shift;
			sum += d;
			squares += d * d;
		}
		state[0] = 1;
	}
	const back = period - 1;
	for (let r = offset, end = offset + length; r < end; r++) {
		const v = buffer[r]!;
		if (v === v) {
			if (hasShift === 0) {
				hasShift = 1;
				shift = v;
			}
			const d = v - shift;
			sum += d;
			squares += d * d;
		} else {
			missing++;
		}
		if (missing > 0) {
			buffer[stride + r] = NaN;
			buffer[2 * stride + r] = NaN;
			buffer[3 * stride + r] = NaN;
		} else {
			const mean = sum / period;
			let variance = squares / period - mean * mean;
			if (variance < 0) {
				variance = 0;
			}
			const middle = shift + mean;
			const width = multiplier * Math.sqrt(variance);
			buffer[stride + r] = middle + width;
			buffer[2 * stride + r] = middle;
			buffer[3 * stride + r] = middle - width;
		}
		const old = buffer[r - back]!;
		if (old === old) {
			const d = old - shift;
			sum -= d;
			squares -= d * d;
		} else {
			missing--;
		}
	}
	state[1] = hasShift;
	state[2] = shift;
	state[3] = sum;
	state[4] = squares;
	state[5] = missing;
}

/**
 * Average true range with Wilder's smoothing. Inputs: high, low, close. Cumulative; reads the
 * previous close. Without one (the first bar, or after a gap) the range is high minus low.
 */
export function atrKernel(
	buffer: Float64Array,
	offset: number,
	length: number,
	state: Float64Array,
	_carry: number,
	params: Float64Array,
): void {
	const period = params[0]!;
	const stride = buffer.length / 4;
	const out = 3 * stride;
	for (let r = offset, end = offset + length; r < end; r++) {
		const high = buffer[r]!;
		const low = buffer[stride + r]!;
		if (high !== high || low !== low) {
			buffer[out + r] = NaN;
			continue;
		}
		const previous = buffer[2 * stride + r - 1]!;
		let range = high - low;
		if (previous === previous) {
			const up = high > previous ? high - previous : previous - high;
			const down = low > previous ? low - previous : previous - low;
			if (up > range) {
				range = up;
			}
			if (down > range) {
				range = down;
			}
		}
		buffer[out + r] = wilderStep(state, 0, range, period);
	}
}

// Rolling extremes with the van Herk/Gil-Werman algorithm: rows are cut into blocks of the window
// length, and the extreme of a window is the larger of the suffix extreme of the block where it
// starts and the prefix extreme of the block where it ends. Three passes, O(1) per row and O(window)
// for a single row; maxima and minima are exact, so the result does not depend on how rows are
// sliced, and the kernels need no state.

/** Scratch reused across calls (the engine runs one kernel at a time). */
let prefixScratch: Float64Array = new Float64Array(0);
let suffixScratch: Float64Array = new Float64Array(0);
let rawScratch: Float64Array = new Float64Array(0);
let lineScratch: Float64Array = new Float64Array(0);

function scratch(array: Float64Array, size: number): Float64Array {
	return array.length >= size ? array : new Float64Array(Math.max(size, array.length * 2, 1024));
}

/**
 * Writes the highest (or lowest) of `buffer[base + j]` over `j` in `[i - window + 1, i]` to
 * `out[target + i - from]`, for every `i` in `[from, to)`. Rows from `from - window + 1` on must be in
 * the buffer. Missing values are skipped: a window of only missing values gives an infinity, and
 * callers that output NaN for windows with missing values check for them themselves.
 */
function rollingExtreme(
	buffer: Float64Array,
	base: number,
	from: number,
	to: number,
	window: number,
	max: boolean,
	out: Float64Array,
	target: number,
): void {
	const start = from - window + 1;
	const size = to - start;
	prefixScratch = scratch(prefixScratch, size);
	suffixScratch = scratch(suffixScratch, size);
	const prefix = prefixScratch;
	const suffix = suffixScratch;
	// Minima are the maxima of the negated values (negation is exact), so one loop serves both.
	const sign = max ? 1 : -1;
	const at = base + start;
	for (let block = 0; block < size; block += window) {
		const end = block + window < size ? block + window : size;
		let running = -Infinity;
		for (let j = block; j < end; j++) {
			const v = sign * buffer[at + j]!;
			if (v > running) {
				running = v;
			}
			prefix[j] = running;
		}
		running = -Infinity;
		for (let j = end - 1; j >= block; j--) {
			const v = sign * buffer[at + j]!;
			if (v > running) {
				running = v;
			}
			suffix[j] = running;
		}
	}
	const lag = window - 1;
	for (let i = from - start, k = target, end = to - start; i < end; i++, k++) {
		const a = suffix[i - lag]!;
		const b = prefix[i]!;
		out[k] = sign * (a > b ? a : b);
	}
}

/**
 * Highest or lowest value over the last `period` rows, NaN while any of them is missing (and in
 * the warm-up, whose carry rows are NaN). Stateless.
 */
function extremeKernel(
	buffer: Float64Array,
	offset: number,
	length: number,
	carry: number,
	params: Float64Array,
	max: boolean,
): void {
	const period = params[0]!;
	const stride = buffer.length / 2;
	const end = offset + length;
	rollingExtreme(buffer, 0, offset, end, period, max, buffer, stride + offset);
	let missing = -Infinity;
	for (let r = offset - carry; r < end; r++) {
		if (buffer[r] !== buffer[r]) {
			missing = r;
		}
		if (r >= offset && missing > r - period) {
			buffer[stride + r] = NaN;
		}
	}
}

export function highestKernel(
	buffer: Float64Array,
	offset: number,
	length: number,
	_state: Float64Array,
	carry: number,
	params: Float64Array,
): void {
	extremeKernel(buffer, offset, length, carry, params, true);
}

export function lowestKernel(
	buffer: Float64Array,
	offset: number,
	length: number,
	_state: Float64Array,
	carry: number,
	params: Float64Array,
): void {
	extremeKernel(buffer, offset, length, carry, params, false);
}

/**
 * Stochastic oscillator. Inputs: high, low, close. Outputs: k (the close's position in the range of
 * the last `kPeriod` bars, 0 to 100, averaged over `kSmooth` bars) and d (k averaged over `dPeriod`
 * bars). A range of zero leaves k undefined. Windowed and stateless: the averages are summed from
 * their window in order every row, so their bits do not depend on how rows are sliced.
 */
export function stochasticKernel(
	buffer: Float64Array,
	offset: number,
	length: number,
	_state: Float64Array,
	_carry: number,
	params: Float64Array,
): void {
	const kPeriod = params[0]!;
	const kSmooth = params[1]!;
	const dPeriod = params[2]!;
	const stride = buffer.length / 5;
	const end = offset + length;
	// Raw values are needed from here on, for the averages of the first rows.
	const from = offset - (kSmooth - 1) - (dPeriod - 1);
	const rows = end - from;
	rawScratch = scratch(rawScratch, 2 * rows);
	lineScratch = scratch(lineScratch, rows);
	const raw = rawScratch;
	const line = lineScratch;
	rollingExtreme(buffer, 0, from, end, kPeriod, true, raw, 0);
	rollingExtreme(buffer, stride, from, end, kPeriod, false, raw, rows);
	let missing = -Infinity;
	for (let r = from - kPeriod + 1; r < end; r++) {
		if (buffer[r] !== buffer[r] || buffer[stride + r] !== buffer[stride + r]) {
			missing = r;
		}
		if (r >= from) {
			const k = r - from;
			const close = buffer[2 * stride + r]!;
			const highest = raw[k]!;
			const lowest = raw[rows + k]!;
			let value = (100 * (close - lowest)) / (highest - lowest);
			if (missing > r - kPeriod || value !== value || value === Infinity || value === -Infinity) {
				value = NaN;
			}
			raw[k] = value;
		}
	}
	// k from the raw values, d from k: each a mean of its window, NaN if any value in it is.
	const kFrom = from + kSmooth - 1;
	for (let r = kFrom; r < end; r++) {
		let sum = 0;
		for (let j = r - kSmooth + 1; j <= r; j++) {
			sum += raw[j - from]!;
		}
		line[r - from] = sum / kSmooth;
	}
	for (let r = offset; r < end; r++) {
		let sum = 0;
		for (let j = r - dPeriod + 1; j <= r; j++) {
			sum += line[j - from]!;
		}
		buffer[3 * stride + r] = line[r - from]!;
		buffer[4 * stride + r] = sum / dPeriod;
	}
}

/**
 * Volume-weighted average price of the typical price (high + low + close) / 3, restarting at every
 * multiple of `anchor` milliseconds of bar time (UTC days by default; 0 never restarts). Inputs:
 * high, low, close, volume, time. Cumulative. State: started, period, price times volume, volume.
 */
export function vwapKernel(
	buffer: Float64Array,
	offset: number,
	length: number,
	state: Float64Array,
	_carry: number,
	params: Float64Array,
): void {
	const anchor = params[0]!;
	const stride = buffer.length / 6;
	let period = state[1]!;
	let weighted = state[2]!;
	let volume = state[3]!;
	for (let r = offset, end = offset + length; r < end; r++) {
		const time = buffer[4 * stride + r]!;
		const current = anchor > 0 ? Math.floor(time / anchor) : 0;
		if (state[0] === 0 || current !== period) {
			state[0] = 1;
			period = current;
			weighted = 0;
			volume = 0;
		}
		const typical = (buffer[r]! + buffer[stride + r]! + buffer[2 * stride + r]!) / 3;
		const v = buffer[3 * stride + r]!;
		if (typical === typical && v === v) {
			weighted += typical * v;
			volume += v;
			buffer[5 * stride + r] = volume > 0 ? weighted / volume : NaN;
		} else {
			buffer[5 * stride + r] = NaN;
		}
	}
	state[1] = period;
	state[2] = weighted;
	state[3] = volume;
}
