/**
 * Marks: series that are not bars on the main timeline. A scatter series holds points at any time
 * and price, many per bar; a heatmap holds columns of cells on a price grid. Both live in the engine
 * like the bars do, in chunked typed arrays with levels of detail, and the main thread holds a
 * window of one level around the view, kept current by patches.
 *
 * Rows are numbered like bars: indexes are signed and stay where they are when rows are prepended.
 * A level holds rows `[first, first + total)`.
 */
export type MarksKind = 'scatter' | 'heatmap';

/**
 * Points of a scatter series, in time order (UTC milliseconds, not decreasing). `value` colors a
 * point; null gives every point no value (NaN). `size` is the width of a point's mark in CSS
 * pixels; null, or NaN for a point, draws it at the series' `pointSize`.
 */
export interface ScatterRows {
	kind: 'scatter';
	count: number;
	time: Float64Array;
	price: Float64Array;
	value: Float32Array | null;
	size?: Float32Array | null;
}

/**
 * Columns of a heatmap, in time order (strictly increasing). Every column has `rows` cells on a grid
 * of prices `priceStep` high whose row 0 starts at `priceStart`. Cell `r` of column `c` is the grid's
 * row `offsets[c] + r`: it covers prices `[priceStart + (offsets[c] + r) * priceStep, ... + priceStep)`.
 * Without `offsets` every column starts at row 0, so the columns share one range of prices; with
 * them a column can follow the price (an order book around its mid price). `values` is
 * column-major: column `c` occupies `values[c * rows, (c + 1) * rows)`. NaN is a cell without a value.
 */
export interface HeatmapColumns {
	kind: 'heatmap';
	count: number;
	rows: number;
	priceStart: number;
	priceStep: number;
	offsets?: Int32Array | null;
	time: Float64Array;
	values: Float32Array;
}

export type MarksData = ScatterRows | HeatmapColumns;

/**
 * A change of a marks series. `set` replaces everything it holds. `append` adds points at or after
 * the last time (scatter), or columns after the last one, where a column at the last column's time
 * replaces it (heatmap, on the grid the series has). `prepend` adds points at or before the first
 * time (scatter) or columns before the first one (heatmap). `delete` removes the points or columns
 * with times in `[from, to]` (UTC milliseconds, inclusive). The typed arrays are handed over.
 */
export type MarksChange =
	| { op: 'add'; kind: MarksKind; fetchable?: boolean }
	| { op: 'remove' }
	| { op: 'set' | 'append' | 'prepend'; data: MarksData; fetchable?: boolean }
	| { op: 'delete'; from: number; to: number };

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
 * (`request` is its `seq`), a patch of the rows an append changed in the window sent last, or a
 * notice (`notice`, without rows) that the series changed in a way no patch carries.
 *
 * A scatter row is a point (level 0) or a cell of the level's grid holding one or more points: its
 * time and price are the cell's center, its value the largest of its points, its count the number
 * of points and its size the largest of theirs. A heatmap row is a column of cells; at a coarse
 * level it merges `4^level` columns, each cell the largest of its members.
 */
export interface MarksUpdate {
	series: number;
	request?: number;
	/**
	 * Changes with every `set` and `delete`: rows of another generation do not belong together. A
	 * `prepend` keeps it, since the rows held keep their indexes.
	 */
	generation: number;
	level: number;
	start: number;
	count: number;
	/** First row of the level, and the number of rows it holds now: rows `[first, first + total)`. */
	first: number;
	total: number;
	/** The rows the client holds answer the request: none are sent. */
	kept?: boolean;
	/**
	 * The series changed in a way patches do not carry: rows were added in front (a prepend) or
	 * removed, or rows let go under the memory limit came back. The client asks for its view again;
	 * with another `generation` the rows it holds are no longer the engine's.
	 */
	notice?: boolean;
	/**
	 * The rows this answer holds are a stand-in: the finer level the view needs has rows the memory
	 * limit let go, which are being fetched again. The rows that are back come with a notice.
	 */
	partial?: boolean;
	/** Scatter: width of the level's time buckets in milliseconds, 0 for points. */
	timeStep: number;
	/** Scatter: height of the level's price bins, 0 for points. Heatmap: height of a cell. */
	priceStep: number;
	/** Heatmap: lower edge of row 0 of the grid. */
	priceStart: number;
	/** Heatmap: cells per column as given. */
	rows: number;
	/** Extremes of every value the series has taken since its last `set`; NaN without one. */
	valueMin: number;
	valueMax: number;
	time: Float64Array;
	/** Scatter only. */
	price: Float64Array;
	/** One per point, or the cells of the columns one column after the other. */
	values: Float32Array;
	/** Scatter: points per row, empty where each row is one point (level 0). */
	counts: Float32Array;
	/** Scatter: size of each row's mark in CSS pixels (NaN: the series' size); empty when no point has one. */
	sizes: Float32Array;
	/**
	 * Heatmap: grid row of each column's first cell, and its number of cells; both empty when every
	 * column has `rows` cells from row 0 (a grid that does not follow the price). Column `c`'s cells
	 * then are `values[c * rows, (c + 1) * rows)`; otherwise they follow one another, `lengths[c]`
	 * each.
	 */
	offsets: Int32Array;
	lengths: Int32Array;
}

/**
 * Marks of a series with a datafeed that the engine let go under its memory limit and needs again:
 * those with times in `[from, to]` (UTC milliseconds, inclusive), `count` of them, in time order.
 */
export interface MarksFetchRequest {
	/** Unique for the engine's lifetime; the marks are handed back under it, and `marksCancel` names it. */
	id: number;
	series: number;
	from: number;
	to: number;
	count: number;
}

/** What became of marks handed back with a `marksRows` command. */
export interface MarksRestoreResult {
	request: number;
	series: number;
	/** `restored`: the marks are back; `failed`: fetching failed; `mismatch`: they were not the ones let go. */
	outcome: 'restored' | 'failed' | 'mismatch';
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
	prepend(data: MarksData): Generator<undefined, number, undefined>;
	/** Removes the rows with times in `[from, to]`; returns how many of the given rows were removed. */
	delete(from: number, to: number): Generator<undefined, number, undefined>;
	/** First row of `level`, and the number of rows it holds; 0 for a level the store does not have. */
	first(level: number): number;
	total(level: number): number;
	/** First row of `level` changed since `clearChanges`, or Infinity. */
	changedFrom(level: number): number;
	clearChanges(): void;
	/** The level and rows a view needs; `minLevel` keeps finer levels out. */
	select(request: MarksRequest, minLevel?: number): MarksSelection;
	/** Copies rows `[start, end)` of `level` into `update`, with what describes the level. */
	read(level: number, start: number, end: number, update: MarksUpdate): void;

	// Memory: chunks of level 0 let go under the memory limit and fetched back.

	/** Chunks let go so far. */
	readonly evicted: number;
	/** Chunks that may be let go now, none with marks in `[keepFrom, keepTo]`. */
	evictable(keepFrom: number, keepTo: number, out: MarksChunk[]): void;
	/** Lets go of a chunk; returns the bytes freed. */
	evict(chunk: number): number;
	/** Chunks let go that hold rows `[start, end)` of `level`. */
	missing(level: number, start: number, end: number, out: number[]): void;
	/** Chunks let go that removing the marks of `[from, to]` reads or moves. */
	needs(from: number, to: number, out: number[]): void;
	/** The times to fetch a chunk let go by, and its marks; null for a chunk held. */
	fetchRange(chunk: number): { from: number; to: number; count: number } | null;
	/** Gives a chunk its marks back from what a datafeed returned; false when they are not those let go. */
	restore(chunk: number, data: MarksData): boolean;
}

/** A chunk of level 0 that could be let go: its number, the times it spans and the bytes it would free. */
export interface MarksChunk {
	chunk: number;
	from: number;
	to: number;
	bytes: number;
}
