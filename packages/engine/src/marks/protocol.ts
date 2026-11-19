/**
 * Marks: series that are not bars on the main timeline. A scatter series holds points at any time
 * and price, many per bar; a heatmap holds columns of cells on a price grid. Both live in the engine
 * like the bars do, in chunked typed arrays with levels of detail, and the main thread holds a
 * window of one level around the view, kept current by patches.
 */
export type MarksKind = 'scatter' | 'heatmap';

/**
 * Points of a scatter series, in time order (UTC milliseconds, not decreasing). `value` colors a
 * point; null gives every point no value (NaN).
 */
export interface ScatterRows {
	kind: 'scatter';
	count: number;
	time: Float64Array;
	price: Float64Array;
	value: Float32Array | null;
}

/**
 * Columns of a heatmap, in time order (strictly increasing). Every column has `rows` cells; cell
 * `r` covers prices `[priceStart + r * priceStep, priceStart + (r + 1) * priceStep)`. `values` is
 * column-major: column `c` occupies `values[c * rows, (c + 1) * rows)`. NaN is a cell without a value.
 */
export interface HeatmapColumns {
	kind: 'heatmap';
	count: number;
	rows: number;
	priceStart: number;
	priceStep: number;
	time: Float64Array;
	values: Float32Array;
}

export type MarksData = ScatterRows | HeatmapColumns;

/**
 * A change of a marks series. `set` replaces everything it holds. `append` adds points at or after
 * the last time (scatter), or columns after the last one, where a column at the last column's time
 * replaces it (heatmap, on the grid the series has). The typed arrays are handed over.
 */
export type MarksChange = { op: 'add'; kind: MarksKind } | { op: 'remove' } | { op: 'set' | 'append'; data: MarksData };

/** What a view needs of a marks series. */
export interface MarksRequest {
	/** Times in view, with whatever margin the client keeps: `[from, to]`, UTC milliseconds. */
	from: number;
	to: number;
	/** Milliseconds per device pixel: a level whose items are no wider than this loses nothing. */
	step: number;
	/** Price per device pixel, for a scatter: a level's price bins must not be taller. 0: any. */
	priceStep: number;
	/** Most rows (scatter points, heatmap cells) the client wants: beyond it a coarser level is sent. */
	limit: number;
	/** What the client holds: rows `[heldStart, heldEnd)` of `heldLevel` (-1: nothing) as of `generation`. */
	generation: number;
	heldLevel: number;
	heldStart: number;
	heldEnd: number;
}

/**
 * Rows `[start, start + count)` of one level of a marks series: the answer to a window request
 * (`request` is its `seq`), or a patch of the rows an append changed in the window sent last.
 *
 * A scatter row is a point (level 0) or a cell of the level's grid holding one or more points: its
 * time and price are the cell's center and its value the largest of its points. A heatmap row is a
 * column of `rows` cells; at a coarse level it merges `4^level` columns, each cell the largest of
 * its members.
 */
export interface MarksUpdate {
	series: number;
	request?: number;
	/** Changes with every `set`: rows of another generation do not belong together. */
	generation: number;
	level: number;
	start: number;
	count: number;
	/** Rows the level holds now. */
	total: number;
	/** The rows the client holds answer the request: none are sent. */
	kept?: boolean;
	/** Scatter: width of the level's time buckets in milliseconds, 0 for points. */
	timeStep: number;
	/** Scatter: height of the level's price bins, 0 for points. Heatmap: height of a cell. */
	priceStep: number;
	/** Heatmap: lower edge of cell 0. */
	priceStart: number;
	/** Heatmap: cells per column. */
	rows: number;
	/** Extremes of every value the series has taken since its last `set`; NaN without one. */
	valueMin: number;
	valueMax: number;
	time: Float64Array;
	/** Scatter only. */
	price: Float64Array;
	/** One per point, or `rows` per column. */
	values: Float32Array;
}

/** A level and rows of it, as a store picks them for a request. */
export interface MarksSelection {
	level: number;
	start: number;
	end: number;
}

/** What the marks engine needs of a store, whatever it holds. */
export interface MarksStore {
	readonly kind: MarksKind;
	readonly byteLength: number;
	/** Replaces the data. Yields between slices of work; returns the rows refused. */
	set(data: MarksData): Generator<undefined, number, undefined>;
	append(data: MarksData): Generator<undefined, number, undefined>;
	/** Rows of `level`; 0 for a level the store does not have. */
	total(level: number): number;
	/** First row of `level` changed since `clearChanges`, or Infinity. */
	changedFrom(level: number): number;
	clearChanges(): void;
	select(request: MarksRequest): MarksSelection;
	/** Copies rows `[start, end)` of `level` into `update`, with what describes the level. */
	read(level: number, start: number, end: number, update: MarksUpdate): void;
}
