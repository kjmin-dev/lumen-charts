/** Kind of a series store: OHLCV keeps six columns, a line keeps time and one value. */
export type SeriesKind = 'ohlcv' | 'line';

/** Number of value columns (every column except time) for a series kind. */
export function valueColumnCount(kind: SeriesKind): number {
	return kind === 'ohlcv' ? 5 : 1;
}

/**
 * Level of detail. Level 0 is the raw rows. Level `k >= 1` holds buckets of `16 * 4^(k - 1)` rows
 * (16, 64, 256, ...); bucket `b` of a level with shift `s` covers main-timeline indexes
 * `[b << s, (b + 1) << s)`, so a bucket is `index >> s` (a floor, also for negative indexes).
 */
export const MAX_LEVEL = 13;

/** log2 of the rows per bucket of a level; 0 for the raw rows. */
export function levelShift(level: number): number {
	return level === 0 ? 0 : 2 * level + 2;
}

/**
 * Number of coarse levels kept for a timeline of `length` rows: every level whose buckets are no
 * larger than the timeline. A view never has more bars per pixel than that, so none is missing.
 */
export function levelCount(length: number): number {
	let levels = 0;
	while (levels < MAX_LEVEL && 2 ** levelShift(levels + 1) <= length) {
		levels++;
	}
	return levels;
}

/**
 * Level a view draws from: raw rows below 16 bars per device pixel, else the coarsest level whose
 * buckets are not wider than a pixel column, so a column merges at most a few buckets.
 */
export function levelFor(barsPerPixel: number, length: number): number {
	const levels = levelCount(length);
	let level = 0;
	while (level < levels && 2 ** levelShift(level + 1) <= barsPerPixel) {
		level++;
	}
	return level;
}

/**
 * Value columns per bucket of a coarse level. OHLCV: first open, highest high, lowest low, last
 * close and the largest volume. Line: first, highest, lowest and last value, which line up with
 * open, high, low and close.
 */
export function levelColumnCount(kind: SeriesKind): number {
	return kind === 'ohlcv' ? 5 : 4;
}

/** Value columns of a series in a window or patch at `level`. */
export function columnCount(kind: SeriesKind, level: number): number {
	return level === 0 ? valueColumnCount(kind) : levelColumnCount(kind);
}

/**
 * Layout of one tick inside a `ticks` command: series id, time, then up to five values
 * (open, high, low, close, volume for OHLCV; the value alone for a line).
 */
export const TICK_STRIDE = 7;

/**
 * Commands sent to the engine. `seq` increases by one per command; every command is answered by
 * exactly one event carrying the same number in `ack`.
 *
 * Bulk data is column-major with time first: column `c` occupies `data[c * count, (c + 1) * count)`.
 */
export type Command =
	/** `fetchable`: rows of this series can be fetched again, so they may be let go under a memory limit. */
	| { type: 'add'; seq: number; series: number; kind: SeriesKind; fetchable?: boolean }
	| { type: 'remove'; seq: number; series: number }
	| { type: 'set'; seq: number; series: number; count: number; data: Float64Array }
	| { type: 'prepend'; seq: number; series: number; count: number; data: Float64Array }
	| { type: 'ticks'; seq: number; count: number; data: Float64Array }
	/** Rows (level 0) or buckets (level >= 1) `[start, start + count)` of one level. */
	| { type: 'window'; seq: number; level: number; start: number; count: number; capacity: number }
	/** Memory the engine aims to stay under, in bytes; `Infinity` for no limit. */
	| { type: 'limit'; seq: number; bytes: number }
	/**
	 * Rows fetched again for a `FetchRequest` starting at `start`, column-major with time first, or
	 * null when fetching failed.
	 */
	| { type: 'rows'; seq: number; series: number; start: number; count: number; data: Float64Array | null };

/**
 * Rows `[start, end)` of a series that the engine let go under its memory limit and needs again,
 * with the times of the first and last of them (UTC milliseconds, inclusive).
 */
export interface FetchRequest {
	series: number;
	start: number;
	end: number;
	from: number;
	to: number;
}

/** What became of rows handed back with a `rows` command. */
export interface RestoreResult {
	series: number;
	start: number;
	/** Rows expected. */
	expected: number;
	/** Rows received. */
	received: number;
	/** `restored`: the rows are back; `failed`: fetching failed; `mismatch`: the rows were not the ones let go. */
	outcome: 'restored' | 'failed' | 'mismatch';
}

/**
 * Values of one series over a range of main-timeline rows or buckets, column-major without the
 * time column. Columns are `stride` long; only the first `count` rows of each are meaningful.
 */
export interface SeriesBlock {
	series: number;
	data: Float64Array;
}

/**
 * Snapshot of every series over rows or buckets `[start, start + count)` of one level, in buffers
 * with room for `capacity` of them. At a coarse level, `time` holds the time of each bucket's first row.
 */
export interface WindowSnapshot {
	level: number;
	/**
	 * Set on an empty raw window whose rows are not in memory and could not be fetched again. The
	 * client should draw a coarse level meanwhile and ask again later.
	 */
	incomplete?: boolean;
	start: number;
	count: number;
	capacity: number;
	time: Float64Array;
	series: SeriesBlock[];
}

/**
 * Rows or buckets of one level that changed. `series` is `TIME_PATCH` for the time column of the
 * main timeline. Patches of one event may share a buffer.
 */
export interface Patch {
	series: number;
	level: number;
	start: number;
	count: number;
	data: Float64Array;
}

export const TIME_PATCH = -1;

export interface EngineEvent {
	/** `seq` of the command this event answers. */
	ack: number;
	/** Changes whenever main-timeline indexes are re-based; data from an older epoch must be dropped. */
	epoch: number;
	/** Extent of the main timeline: `[first, end)`. */
	first: number;
	end: number;
	/** The window held by the client no longer matches the engine and has to be requested again. */
	stale: boolean;
	/** Rows the command could not apply (out-of-order times, unknown series). */
	rejected: number;
	/** The engine failed while running the command; nothing else in this event can be relied on. */
	failed?: boolean;
	window?: WindowSnapshot;
	/** Changed rows of the raw level and the changed buckets of every coarse level. */
	patches?: Patch[];
	/**
	 * Rows the engine needs fetched again: a raw window over them waits until they are back (or
	 * fetching failed) and comes with a later event.
	 */
	fetch?: FetchRequest[];
	/** Outcome of the rows handed back by the command this event answers. */
	restored?: RestoreResult;
}

/** First message a worker host sends, before any event. */
export interface ReadyMessage {
	ready: true;
}

/** Buffers of an event that can be transferred instead of copied, each listed once. */
export function transferables(event: EngineEvent): ArrayBuffer[] {
	const list: ArrayBuffer[] = [];
	const add = (buffer: ArrayBuffer): void => {
		// Patches share buffers, and a buffer listed twice makes `postMessage` throw.
		if (!list.includes(buffer)) {
			list.push(buffer);
		}
	};
	const window = event.window;
	if (window !== undefined) {
		add(window.time.buffer as ArrayBuffer);
		for (const block of window.series) {
			add(block.data.buffer as ArrayBuffer);
		}
	}
	if (event.patches !== undefined) {
		for (const patch of event.patches) {
			add(patch.data.buffer as ArrayBuffer);
		}
	}
	return list;
}
