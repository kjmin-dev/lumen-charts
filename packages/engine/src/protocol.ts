/** Kind of a series store: OHLCV keeps six columns, a line keeps time and one value. */
export type SeriesKind = 'ohlcv' | 'line';

/** Number of value columns (every column except time) for a series kind. */
export function valueColumnCount(kind: SeriesKind): number {
	return kind === 'ohlcv' ? 5 : 1;
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
	| { type: 'add'; seq: number; series: number; kind: SeriesKind }
	| { type: 'remove'; seq: number; series: number }
	| { type: 'set'; seq: number; series: number; count: number; data: Float64Array }
	| { type: 'prepend'; seq: number; series: number; count: number; data: Float64Array }
	| { type: 'ticks'; seq: number; count: number; data: Float64Array }
	| { type: 'window'; seq: number; start: number; count: number; capacity: number };

/**
 * Values of one series over a range of main-timeline indexes, column-major without the time column.
 * Columns are `stride` long; only the first `count` rows of each are meaningful.
 */
export interface SeriesBlock {
	series: number;
	data: Float64Array;
}

/** Snapshot of every series over `[start, start + count)`, in buffers with room for `capacity` rows. */
export interface WindowSnapshot {
	start: number;
	count: number;
	capacity: number;
	time: Float64Array;
	series: SeriesBlock[];
}

/** Rows that changed. `series` is `TIME_PATCH` for the time column of the main timeline. */
export interface Patch {
	series: number;
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
	window?: WindowSnapshot;
	patches?: Patch[];
}

/** First message a worker host sends, before any event. */
export interface ReadyMessage {
	ready: true;
}

/** Buffers of an event that can be transferred instead of copied. */
export function transferables(event: EngineEvent): ArrayBuffer[] {
	const list: ArrayBuffer[] = [];
	const window = event.window;
	if (window !== undefined) {
		list.push(window.time.buffer as ArrayBuffer);
		for (const block of window.series) {
			list.push(block.data.buffer as ArrayBuffer);
		}
	}
	if (event.patches !== undefined) {
		for (const patch of event.patches) {
			list.push(patch.data.buffer as ArrayBuffer);
		}
	}
	return list;
}
