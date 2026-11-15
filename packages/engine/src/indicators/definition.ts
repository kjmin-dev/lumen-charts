/**
 * Computes rows `[offset, offset + length)` of one slice of an indicator.
 *
 * - `buffer` is column-major: the definition's inputs, then its outputs, each column
 *   `buffer.length / (inputs + outputs)` rows long (the stride).
 * - Input rows `[offset - carry, offset)` hold the `carry` input rows that come before the slice:
 *   the tail of the previous slice, or NaN before the first row of the data. A kernel can read up
 *   to `carry` rows back without checking where the slice starts. `carry` is `lookback(params)`.
 * - `state` holds the kernel's running values between slices (`stateSize(params)` numbers). It is
 *   all zeros when the kernel starts fresh: at the first row of the data and, for a windowed
 *   definition, at every chunk boundary (global index a multiple of 8,192), where the kernel
 *   rebuilds its state from the carry rows alone.
 * - `params` holds the parameters in the order the definition lists them.
 *
 * Missing input values are NaN, and so is every output that is not defined (warm-up, gaps). A
 * kernel must be deterministic: the same buffer, state and params give the same bits. Kernels take
 * only numbers and typed arrays, so a WebAssembly build can replace one without other changes.
 */
export type IndicatorKernel = (
	buffer: Float64Array,
	offset: number,
	length: number,
	state: Float64Array,
	carry: number,
	params: Float64Array,
) => void;

/** One numeric parameter of an indicator. */
export interface IndicatorParam {
	name: string;
	default: number;
	/** Smallest value allowed (inclusive). */
	min?: number;
	/** Largest value allowed (inclusive). */
	max?: number;
	/** Whether the value must be a whole number. */
	integer?: boolean;
}

/** One output of an indicator: a series on the main timeline. */
export interface IndicatorOutputInfo {
	name: string;
	/** How the chart draws it by default. */
	style?: 'line' | 'histogram';
	/** Default color (any CSS color). */
	color?: string;
}

/** What the main thread needs to know about an indicator: plain data, so it can cross to a worker and back. */
export interface IndicatorInfo {
	/** Unique name, used to add the indicator. */
	name: string;
	/**
	 * One entry per input: the column of the source series it reads by default (`time`, `open`,
	 * `high`, `low`, `close`, `volume` or `value`). Any input can be pointed at another column, another
	 * series or another indicator's output instead.
	 */
	inputs: readonly string[];
	outputs: readonly IndicatorOutputInfo[];
	params: readonly IndicatorParam[];
	/**
	 * Every output depends only on the current input row and the `lookback` rows before it, and the
	 * kernel rebuilds its state from those rows after a reset. The engine then restarts the kernel at
	 * every chunk boundary, which makes each value a function of its window alone, and after a
	 * prepend recomputes only the rows near the old first bar. Without it (the default), the
	 * indicator is cumulative: its state runs from the first bar, and a prepend recomputes it from the
	 * new first bar until the state matches, bit for bit, the one it had at a chunk boundary (from
	 * there on nothing can differ), or in full if it never does. A kernel should therefore keep in its
	 * state only what later rows depend on: an average that forgets its start converges quickly.
	 */
	windowed?: boolean;
}

/** An indicator: its metadata, its kernel, and how much state and history the kernel needs. */
export interface IndicatorDefinition extends IndicatorInfo {
	kernel: IndicatorKernel;
	/** Numbers of running state the kernel keeps between slices. */
	stateSize(params: Float64Array): number;
	/** Input rows before the current one that the kernel reads (the carry). */
	lookback(params: Float64Array): number;
	/**
	 * Rows at the start of the data (without gaps) before every output is defined: the kernel has not
	 * seen enough input yet, and outputs are NaN.
	 */
	warmup(params: Float64Array): number;
}

/** Plain-data part of a definition, for sending it to the main thread. */
export function indicatorInfo(definition: IndicatorDefinition): IndicatorInfo {
	return {
		name: definition.name,
		inputs: [...definition.inputs],
		outputs: definition.outputs.map(output => ({ ...output })),
		params: definition.params.map(param => ({ ...param })),
		windowed: definition.windowed === true,
	};
}

/** Identity function that gives a definition its type, for plugin modules. */
export function defineIndicator(definition: IndicatorDefinition): IndicatorDefinition {
	return definition;
}

/**
 * Source columns an input can read, by name: column numbers of an OHLCV store (`value` reads the
 * close). A line series has one value column, which every price name reads.
 */
export const SOURCE_COLUMNS: Readonly<Record<string, number>> = {
	time: 0,
	open: 1,
	high: 2,
	low: 3,
	close: 4,
	volume: 5,
	value: 4,
};

/**
 * Parameters in definition order, defaults where `values` has none. Throws a `RangeError` for a
 * value that is not a finite number within the parameter's bounds.
 */
export function resolveParams(
	params: readonly IndicatorParam[],
	values: Readonly<Record<string, number | undefined>> = {},
): Float64Array {
	const out = new Float64Array(params.length);
	for (let i = 0; i < params.length; i++) {
		const param = params[i]!;
		const value = values[param.name] ?? param.default;
		const valid =
			Number.isFinite(value) &&
			(param.min === undefined || value >= param.min) &&
			(param.max === undefined || value <= param.max) &&
			(param.integer !== true || Number.isInteger(value));
		if (!valid) {
			throw new RangeError(`Invalid value ${value} for parameter "${param.name}"`);
		}
		out[i] = value;
	}
	return out;
}

/** Checks that a value from a plugin module has the shape of a definition. Returns the reason it does not, or null. */
export function definitionError(value: unknown): string | null {
	if (typeof value !== 'object' || value === null) {
		return 'not an object';
	}
	const definition = value as Partial<IndicatorDefinition>;
	if (typeof definition.name !== 'string' || definition.name === '') {
		return 'missing name';
	}
	const fields: (keyof IndicatorDefinition)[] = ['kernel', 'stateSize', 'lookback', 'warmup'];
	for (const field of fields) {
		if (typeof definition[field] !== 'function') {
			return `${definition.name}: ${field} is not a function`;
		}
	}
	if (!Array.isArray(definition.inputs) || !definition.inputs.every(input => input in SOURCE_COLUMNS)) {
		return `${definition.name}: inputs must name source columns`;
	}
	if (!Array.isArray(definition.outputs) || definition.outputs.length === 0) {
		return `${definition.name}: needs at least one output`;
	}
	if (!Array.isArray(definition.params)) {
		return `${definition.name}: params must be an array`;
	}
	for (const param of definition.params) {
		if (typeof param?.name !== 'string' || !Number.isFinite(param.default)) {
			return `${definition.name}: every parameter needs a name and a finite default`;
		}
	}
	return null;
}
