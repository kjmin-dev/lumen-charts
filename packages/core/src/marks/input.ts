import type { HeatmapColumns, ScatterRows } from '@lumen-ticks/engine';

/** One point of a scatter series. `time` is a UTC timestamp in milliseconds. */
export interface ScatterPoint {
	time: number;
	price: number;
	/** What the point's color shows (a trade's size, say); without one it takes the series' `color`. */
	value?: number;
	/** Width of the point's mark in CSS pixels; without one (or NaN) it takes the series' `pointSize`. */
	size?: number;
}

/** Points as parallel columns: the fastest way to hand over many. */
export interface ScatterColumns {
	time: ArrayLike<number>;
	price: ArrayLike<number>;
	value?: ArrayLike<number>;
	size?: ArrayLike<number>;
}

/** What `setData` of a scatter series takes: points in time order (several may share a time). */
export type ScatterData = readonly ScatterPoint[] | ScatterColumns;

/** One column of a heatmap: the cells of one time, from the lowest price up. NaN is a cell without a value. */
export interface HeatmapColumn {
	time: number;
	values: ArrayLike<number>;
	/**
	 * Lower edge of the column's lowest cell, for a grid that follows the price: on the series' grid,
	 * a whole number of `priceStep` from its `priceStart`. Without it the column starts where the
	 * grid of the last `setData` does.
	 */
	priceStart?: number;
}

/**
 * What `setData` of a heatmap takes: a price grid and columns on it. Cell `r` of a column covers
 * prices `[priceStart + r * priceStep, priceStart + (r + 1) * priceStep)`; a column covers the
 * time from its own to the next column's, and the last one as long as the one before it.
 */
export interface HeatmapData {
	/**
	 * Lower edge of the lowest cell: of every column, or of each column (an array, one per column) for
	 * a grid that follows the price, such as a book around its mid price. Columns' lower edges must lie
	 * a whole number of `priceStep` apart; the first column's sets the grid.
	 */
	priceStart: number | ArrayLike<number>;
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
		throw new RangeError(`lumen-ticks: the ${name} column must have the length of the time column`);
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

function floats(source: ArrayLike<number> | undefined, count: number, name: string): Float32Array | null {
	if (source === undefined) {
		return null;
	}
	if (source.length < count) {
		throw new RangeError(`lumen-ticks: the ${name} column must have the length of the time column`);
	}
	const target = new Float32Array(count);
	for (let i = 0; i < count; i++) {
		target[i] = source[i]!;
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
		let size: Float32Array | null = null;
		for (let i = 0; i < count; i++) {
			const point = points[i]!;
			time[i] = point.time;
			price[i] = point.price;
			if (point.value !== undefined) {
				value ??= new Float32Array(count).fill(Number.NaN);
				value[i] = point.value;
			}
			if (point.size !== undefined) {
				size ??= new Float32Array(count).fill(Number.NaN);
				size[i] = point.size;
			}
		}
		return { kind: 'scatter', count, time, price, value, size };
	}
	const columns = input as ScatterColumns;
	const count = columns.time.length;
	return {
		kind: 'scatter',
		count,
		time: column(columns.time, count, 'time'),
		price: column(columns.price, count, 'price'),
		value: floats(columns.value, count, 'value'),
		size: floats(columns.size, count, 'size'),
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
		size: point.size === undefined ? null : Float32Array.of(point.size),
	};
}

/** The grid of a heatmap: what its columns must agree on. */
export interface HeatmapGrid {
	rows: number;
	priceStart: number;
	priceStep: number;
}

/** Grid rows a column's lower edge may be off a whole row by, as a share of a row, for rounding. */
const GRID_TOLERANCE = 1e-6;

/**
 * The grid row a column's lower edge falls on, on the grid whose row 0 starts at `base`. Throws a
 * RangeError for an edge between two rows.
 */
function gridRow(priceStart: number, base: number, step: number): number {
	const row = (priceStart - base) / step;
	const whole = Math.round(row);
	if (!Number.isFinite(priceStart) || !(Math.abs(row - whole) <= GRID_TOLERANCE) || Math.abs(whole) > 0x3fffffff) {
		throw new RangeError(
			`lumen-ticks: a heatmap column's priceStart ${priceStart} is not a whole number of priceStep (${step}) from the grid's ${base}`,
		);
	}
	return whole;
}

/**
 * Copies a heatmap into typed arrays of their own. Throws a RangeError for a grid that is not one
 * (no rows, a step that is not above 0), values that do not fill the columns, or columns whose
 * lower edges are not on one grid. `grid` is the series' grid, which `priceStart` must keep to;
 * without it the first column's lower edge starts the grid.
 */
export function packHeatmap(input: HeatmapData, grid?: HeatmapGrid | null): HeatmapColumns {
	const { rows, priceStep } = input;
	const starts = typeof input.priceStart === 'number' ? null : input.priceStart;
	const count = input.time.length;
	if (starts !== null && starts.length < count) {
		throw new RangeError('lumen-ticks: a heatmap needs a `priceStart` for every column');
	}
	const priceStart =
		grid?.priceStart ?? (starts === null ? (input.priceStart as number) : count > 0 ? starts[0]! : Number.NaN);
	if (!Number.isInteger(rows) || rows < 1) {
		throw new RangeError('lumen-ticks: a heatmap needs `rows`, a whole number of at least 1');
	}
	if (!(priceStep > 0) || !Number.isFinite(priceStep) || !Number.isFinite(priceStart)) {
		throw new RangeError('lumen-ticks: a heatmap needs a finite `priceStart` and a `priceStep` above 0');
	}
	let offsets: Int32Array | null = null;
	if (starts !== null) {
		offsets = new Int32Array(count);
		for (let i = 0; i < count; i++) {
			offsets[i] = gridRow(starts[i]!, priceStart, priceStep);
		}
	} else if (input.priceStart !== priceStart) {
		// One lower edge for all columns, on the grid of the series but not at its row 0.
		const row = gridRow(input.priceStart as number, priceStart, priceStep);
		if (row !== 0) {
			offsets = new Int32Array(count).fill(row);
		}
	}
	if (input.values.length < count * rows) {
		throw new RangeError('lumen-ticks: a heatmap needs `rows` values for every column');
	}
	const values = new Float32Array(count * rows);
	if (input.values.length === values.length) {
		values.set(input.values);
	} else {
		for (let i = 0; i < values.length; i++) {
			values[i] = input.values[i]!;
		}
	}
	return {
		kind: 'heatmap',
		count,
		rows,
		priceStart,
		priceStep,
		offsets,
		time: column(input.time, count, 'time'),
		values,
	};
}

/** One column on `grid` as columns for the engine. Cells the column leaves out have no value. */
export function packHeatmapColumn(grid: HeatmapGrid, input: HeatmapColumn): HeatmapColumns {
	const values = new Float32Array(grid.rows).fill(Number.NaN);
	const count = Math.min(grid.rows, input.values.length);
	for (let i = 0; i < count; i++) {
		values[i] = input.values[i]!;
	}
	const row = input.priceStart === undefined ? 0 : gridRow(input.priceStart, grid.priceStart, grid.priceStep);
	return {
		kind: 'heatmap',
		count: 1,
		rows: grid.rows,
		priceStart: grid.priceStart,
		priceStep: grid.priceStep,
		offsets: row === 0 ? null : Int32Array.of(row),
		time: Float64Array.of(input.time),
		values,
	};
}
