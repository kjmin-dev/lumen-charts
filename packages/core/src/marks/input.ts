import type { HeatmapColumns, ScatterRows } from '@lumen-charts/engine';

/** One point of a scatter series. `time` is a UTC timestamp in milliseconds. */
export interface ScatterPoint {
	time: number;
	price: number;
	/** What the point's color shows (a trade's size, say); without one it takes the series' `color`. */
	value?: number;
}

/** Points as parallel columns: the fastest way to hand over many. */
export interface ScatterColumns {
	time: ArrayLike<number>;
	price: ArrayLike<number>;
	value?: ArrayLike<number>;
}

/** What `setData` of a scatter series takes: points in time order (several may share a time). */
export type ScatterData = readonly ScatterPoint[] | ScatterColumns;

/** One column of a heatmap: the cells of one time, from the lowest price up. NaN is a cell without a value. */
export interface HeatmapColumn {
	time: number;
	values: ArrayLike<number>;
}

/**
 * What `setData` of a heatmap takes: a price grid and columns on it. Cell `r` of a column covers
 * prices `[priceStart + r * priceStep, priceStart + (r + 1) * priceStep)`; a column covers the
 * time from its own to the next column's, and the last one as long as the one before it.
 */
export interface HeatmapData {
	/** Lower edge of the lowest cell. */
	priceStart: number;
	/** Height of a cell in price, above 0. */
	priceStep: number;
	/** Cells per column, at least 1. */
	rows: number;
	/** Time of each column, UTC milliseconds, strictly increasing. */
	time: ArrayLike<number>;
	/** The cells of all columns, one column after the other: `rows` values per column. */
	values: ArrayLike<number>;
}

function column(source: ArrayLike<number>, count: number, name: string): Float64Array {
	if (source.length < count) {
		throw new RangeError(`lumen-charts: the ${name} column must have the length of the time column`);
	}
	const target = new Float64Array(count);
	if (source.length === count) {
		target.set(source);
	} else {
		for (let i = 0; i < count; i++) {
			target[i] = source[i]!;
		}
	}
	return target;
}

/** Copies points into typed arrays of their own, which can be handed to the engine. */
export function packScatter(input: ScatterData): ScatterRows {
	if (Array.isArray(input)) {
		const points = input as readonly ScatterPoint[];
		const count = points.length;
		const time = new Float64Array(count);
		const price = new Float64Array(count);
		let value: Float32Array | null = null;
		for (let i = 0; i < count; i++) {
			const point = points[i]!;
			time[i] = point.time;
			price[i] = point.price;
			if (point.value !== undefined) {
				value ??= new Float32Array(count).fill(Number.NaN);
				value[i] = point.value;
			}
		}
		return { kind: 'scatter', count, time, price, value };
	}
	const columns = input as ScatterColumns;
	const count = columns.time.length;
	let value: Float32Array | null = null;
	if (columns.value !== undefined) {
		if (columns.value.length < count) {
			throw new RangeError('lumen-charts: the value column must have the length of the time column');
		}
		value = new Float32Array(count);
		for (let i = 0; i < count; i++) {
			value[i] = columns.value[i]!;
		}
	}
	return {
		kind: 'scatter',
		count,
		time: column(columns.time, count, 'time'),
		price: column(columns.price, count, 'price'),
		value,
	};
}

/** One point as rows for the engine. */
export function packScatterPoint(point: ScatterPoint): ScatterRows {
	return {
		kind: 'scatter',
		count: 1,
		time: Float64Array.of(point.time),
		price: Float64Array.of(point.price),
		value: point.value === undefined ? null : Float32Array.of(point.value),
	};
}

/** The grid of a heatmap: what its columns must agree on. */
export interface HeatmapGrid {
	rows: number;
	priceStart: number;
	priceStep: number;
}

/**
 * Copies a heatmap into typed arrays of their own. Throws a RangeError for a grid that is not one
 * (no rows, a step that is not above 0) or values that do not fill the columns.
 */
export function packHeatmap(input: HeatmapData): HeatmapColumns {
	const { rows, priceStart, priceStep } = input;
	if (!Number.isInteger(rows) || rows < 1) {
		throw new RangeError('lumen-charts: a heatmap needs `rows`, a whole number of at least 1');
	}
	if (!(priceStep > 0) || !Number.isFinite(priceStep) || !Number.isFinite(priceStart)) {
		throw new RangeError('lumen-charts: a heatmap needs a finite `priceStart` and a `priceStep` above 0');
	}
	const count = input.time.length;
	if (input.values.length < count * rows) {
		throw new RangeError('lumen-charts: a heatmap needs `rows` values for every column');
	}
	const values = new Float32Array(count * rows);
	if (input.values.length === values.length) {
		values.set(input.values);
	} else {
		for (let i = 0; i < values.length; i++) {
			values[i] = input.values[i]!;
		}
	}
	return { kind: 'heatmap', count, rows, priceStart, priceStep, time: column(input.time, count, 'time'), values };
}

/** One column on `grid` as columns for the engine. Cells the column leaves out have no value. */
export function packHeatmapColumn(grid: HeatmapGrid, input: HeatmapColumn): HeatmapColumns {
	const values = new Float32Array(grid.rows).fill(Number.NaN);
	const count = Math.min(grid.rows, input.values.length);
	for (let i = 0; i < count; i++) {
		values[i] = input.values[i]!;
	}
	return {
		kind: 'heatmap',
		count: 1,
		rows: grid.rows,
		priceStart: grid.priceStart,
		priceStep: grid.priceStep,
		time: Float64Array.of(input.time),
		values,
	};
}
