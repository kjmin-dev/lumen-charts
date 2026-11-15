/** One candle. `time` is a UTC timestamp in milliseconds. */
export interface OhlcBar {
	time: number;
	open: number;
	high: number;
	low: number;
	close: number;
	volume?: number;
}

/** Candles as parallel columns: the fastest way to hand over a large history. */
export interface OhlcColumns {
	time: ArrayLike<number>;
	open: ArrayLike<number>;
	high: ArrayLike<number>;
	low: ArrayLike<number>;
	close: ArrayLike<number>;
	volume?: ArrayLike<number>;
}

/** One point of a line. `time` is a UTC timestamp in milliseconds. */
export interface LinePoint {
	time: number;
	value: number;
}

export interface LineColumns {
	time: ArrayLike<number>;
	value: ArrayLike<number>;
}

export interface Packed {
	/** Column-major block with time first, in a buffer of its own that can be handed to the engine. */
	data: Float64Array;
	count: number;
}

function put(target: Float64Array, source: ArrayLike<number>, offset: number, count: number): void {
	if (source.length < count) {
		throw new RangeError('Columns must all have the length of the time column');
	}
	if (source.length === count) {
		target.set(source, offset);
	} else {
		for (let i = 0; i < count; i++) {
			target[offset + i] = source[i]!;
		}
	}
}

export function packCandles(input: readonly OhlcBar[] | OhlcColumns): Packed {
	if (Array.isArray(input)) {
		const bars = input as readonly OhlcBar[];
		const count = bars.length;
		const data = new Float64Array(count * 6);
		for (let i = 0; i < count; i++) {
			const bar = bars[i]!;
			data[i] = bar.time;
			data[count + i] = bar.open;
			data[2 * count + i] = bar.high;
			data[3 * count + i] = bar.low;
			data[4 * count + i] = bar.close;
			data[5 * count + i] = bar.volume ?? NaN;
		}
		return { data, count };
	}
	const columns = input as OhlcColumns;
	const count = columns.time.length;
	const data = new Float64Array(count * 6);
	put(data, columns.time, 0, count);
	put(data, columns.open, count, count);
	put(data, columns.high, 2 * count, count);
	put(data, columns.low, 3 * count, count);
	put(data, columns.close, 4 * count, count);
	if (columns.volume === undefined) {
		data.fill(NaN, 5 * count);
	} else {
		put(data, columns.volume, 5 * count, count);
	}
	return { data, count };
}

export function packLine(input: readonly LinePoint[] | LineColumns): Packed {
	if (Array.isArray(input)) {
		const points = input as readonly LinePoint[];
		const count = points.length;
		const data = new Float64Array(count * 2);
		for (let i = 0; i < count; i++) {
			const point = points[i]!;
			data[i] = point.time;
			data[count + i] = point.value;
		}
		return { data, count };
	}
	const columns = input as LineColumns;
	const count = columns.time.length;
	const data = new Float64Array(count * 2);
	put(data, columns.time, 0, count);
	put(data, columns.value, count, count);
	return { data, count };
}
