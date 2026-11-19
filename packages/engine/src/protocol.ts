import type { IndicatorInfo } from './indicators/definition';
import type { MarksChange, MarksRequest, MarksUpdate } from './marks/protocol';

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
 * exactly one event carrying the same number in `ack`. Work the engine finishes between commands
 * (indicator values recomputed, a plugin module loaded) comes with a notice: an extra event whose
 * `ack` repeats the last command answered.
 *
 * Bulk data is column-major with time first: column `c` occupies `data[c * count, (c + 1) * count)`.
 */
/** The first command may request packed buffers for subsequent patch events. */
export type Command = EngineOperation & { packedPatches?: true };

type EngineOperation =
	/** `fetchable`: rows of this series can be fetched again, so they may be let go under a memory limit. */
	| { type: 'add'; seq: number; series: number; kind: SeriesKind; fetchable?: boolean }
	| { type: 'remove'; seq: number; series: number }
	/**
	 * Replaces the rows of a series: a new history, for example at another resolution. Requests out
	 * for the old rows are cancelled. `fetchable` changes whether rows may be let go (unchanged when
	 * absent).
	 */
	| { type: 'set'; seq: number; series: number; count: number; data: Float64Array; fetchable?: boolean }
	| { type: 'prepend'; seq: number; series: number; count: number; data: Float64Array }
	| { type: 'ticks'; seq: number; count: number; data: Float64Array }
	/** Removes the bars of a series with times in `[from, to]` (UTC milliseconds, inclusive). */
	| { type: 'delete'; seq: number; series: number; from: number; to: number }
	/** Rows (level 0) or buckets (level >= 1) `[start, start + count)` of one level. */
	| { type: 'window'; seq: number; level: number; start: number; count: number; capacity: number }
	/** Memory the engine aims to stay under, in bytes; `Infinity` for no limit. */
	| { type: 'limit'; seq: number; bytes: number }
	/**
	 * Rows fetched again for the `FetchRequest` with id `request`, column-major with time first, or
	 * null when fetching failed.
	 */
	| { type: 'rows'; seq: number; request: number; count: number; data: Float64Array | null }
	/**
	 * Adds an indicator instance, or changes one (same `id`): its outputs become derived series with
	 * the ids in `outputs`. `params` follow the definition's order.
	 */
	| {
			type: 'indicator';
			seq: number;
			id: number;
			name: string;
			params: number[];
			inputs: IndicatorInputRef[];
			outputs: number[];
	  }
	| { type: 'removeIndicator'; seq: number; id: number }
	/** Loads a plugin module of indicators; the outcome comes with a later event's `plugins`. */
	| { type: 'plugin'; seq: number; url: string }
	/**
	 * Logical positions of `times` on the main timeline, answered in the event's `resolved`. Reads
	 * only: it changes nothing and waits for no rows.
	 */
	| { type: 'resolve'; seq: number; times: Float64Array }
	/** Adds, removes or changes a marks series (a scatter or a heatmap; see `marks/protocol.ts`). */
	| { type: 'marks'; seq: number; series: number; change: MarksChange }
	/** Rows of a marks series for a view, answered in the event's `marks`. Reads only. */
	| { type: 'marksWindow'; seq: number; series: number; request: MarksRequest };

/**
 * Where times fall on the main timeline, as of the event that carries it.
 *
 * A bar's time maps to its index. A time between two bars maps to the fraction of the way between
 * their indexes that it is between their times. A time before the first bar or after the last maps
 * beyond them at the typical spacing of the bars there (`headInterval`, `tailInterval`: the median
 * of the last 64 gaps), so an anchor in the future stays put while bars arrive at that spacing.
 * Inside history the memory limit let go, only every 16th time is known, and a time between two of
 * them is interpolated the same way.
 */
export interface TimelineResolution {
	/** One logical position per time asked for; NaN for a time that is NaN or when there are no bars. */
	positions: Float64Array;
	/** Time of the first and last bar, NaN without bars. */
	firstTime: number;
	lastTime: number;
	/** Typical gap between bars at the start and the end of the timeline, in milliseconds. */
	headInterval: number;
	tailInterval: number;
}

/**
 * Where an indicator input reads from: column `column` of series `series` (column 0 is the main
 * timeline's time, then open, high, low, close, volume; a line's value is column 1), or, when
 * `series` is an indicator output, that output's values.
 */
export interface IndicatorInputRef {
	series: number;
	column: number;
}

/** Outcome of loading a plugin module. */
export interface PluginResult {
	url: string;
	/** The indicators the module registered; absent when loading failed. */
	indicators?: IndicatorInfo[];
	error?: string;
}

/**
 * What a worker host receives. One worker can serve several engines:
 * - a command carries the id of its engine in `engine` (0 when absent), and the engine starts with
 *   its first command;
 * - `close` lets an engine go with everything it holds. It is not answered, and neither are
 *   commands of that engine still waiting.
 */
export type HostMessage = (Command & { engine?: number }) | { type: 'close'; engine: number };

/**
 * Rows `[start, end)` of a series that the engine let go under its memory limit and needs again,
 * with the times of the first and last of them (UTC milliseconds, inclusive). `start` and `end`
 * index the series' own rows; for the main series they are main-timeline indexes.
 */
export interface FetchRequest {
	/** Unique for the engine's lifetime; the rows are handed back under it, and `cancel` names it. */
	id: number;
	series: number;
	start: number;
	end: number;
	from: number;
	to: number;
	/**
	 * Times of bars that deletions waiting on the series remove, as `[from, to]` pairs: the answer
	 * may leave them out. Its other bars are checked against the times the engine kept (every 16th
	 * bar, and the first and last of each chunk) rather than a checksum of all of them.
	 */
	removing?: number[];
}

/** What became of rows handed back with a `rows` command. */
export interface RestoreResult {
	request: number;
	series: number;
	start: number;
	/**
	 * Rows expected; 0 for a request the engine no longer needs as it was made: cancelled, its rows
	 * replaced, or bars removed there by a deletion that waits (which asks for them again).
	 */
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
	/** `seq` of the `window` command this snapshot answers. */
	request?: number;
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
 * main timeline. `data` is column-major: `data.length / count` columns of `count` values.
 */
export interface Patch {
	series: number;
	level: number;
	start: number;
	count: number;
	data: Float64Array;
}

export const TIME_PATCH = -1;

/**
 * The patches of an event, packed into two buffers. A tick on a series with indicators changes a
 * few values in every level of every series: hundreds of patches, which as an object and a typed
 * array each would be allocated on the receiving thread for every tick and collected soon after.
 *
 * Patch `p` is the `PATCH_STRIDE` integers from `index[p * PATCH_STRIDE]` on: its series
 * (`TIME_PATCH` for the time column of the main timeline), level, first row or bucket, number of
 * them, number of columns, and where its values start in `data`. The values are column-major:
 * column `c` is `data[offset + c * count, offset + (c + 1) * count)`. `unpackPatches` gives them as
 * objects.
 */
export interface Patches {
	index: Int32Array;
	data: Float64Array;
}

export const PATCH_SERIES = 0;
export const PATCH_LEVEL = 1;
export const PATCH_START = 2;
export const PATCH_COUNT = 3;
export const PATCH_COLUMNS = 4;
export const PATCH_OFFSET = 5;
export const PATCH_STRIDE = 6;

/** Integers per patch in a `PatchSpecs`: series, level, first row or bucket, number of them, columns. */
export const SPEC_SERIES = 0;
export const SPEC_LEVEL = 1;
export const SPEC_START = 2;
export const SPEC_COUNT = 3;
export const SPEC_COLUMNS = 4;
export const SPEC_STRIDE = 5;

/**
 * The layout of the patches of an event, collected before their buffers are allocated. An engine
 * keeps one and clears it per event, so collecting allocates nothing once it has grown: an array
 * emptied with `length = 0` gives its storage back and grows again with every event.
 */
export class PatchSpecs {
	/** `SPEC_STRIDE` integers per patch; only the first `length` are meaningful. */
	public values = new Int32Array(SPEC_STRIDE * 64);
	public length = 0;

	public push(series: number, level: number, start: number, count: number, columns: number): void {
		let values = this.values;
		const at = this.length;
		if (at === values.length) {
			values = new Int32Array(values.length * 2);
			values.set(this.values);
			this.values = values;
		}
		values[at + SPEC_SERIES] = series;
		values[at + SPEC_LEVEL] = level;
		values[at + SPEC_START] = start;
		values[at + SPEC_COUNT] = count;
		values[at + SPEC_COLUMNS] = columns;
		this.length = at + SPEC_STRIDE;
	}

	public clear(): void {
		this.length = 0;
	}
}

/** Packs patches given as objects, in their order. */
export function packPatches(list: readonly Patch[]): Patches {
	let total = 0;
	for (const patch of list) {
		total += patch.data.length;
	}
	const index = new Int32Array(list.length * PATCH_STRIDE);
	const data = new Float64Array(total);
	let offset = 0;
	for (let i = 0; i < list.length; i++) {
		const patch = list[i]!;
		const p = i * PATCH_STRIDE;
		index[p + PATCH_SERIES] = patch.series;
		index[p + PATCH_LEVEL] = patch.level;
		index[p + PATCH_START] = patch.start;
		index[p + PATCH_COUNT] = patch.count;
		index[p + PATCH_COLUMNS] = patch.count === 0 ? 0 : patch.data.length / patch.count;
		index[p + PATCH_OFFSET] = offset;
		data.set(patch.data, offset);
		offset += patch.data.length;
	}
	return { index, data };
}

/** The patches of an event as objects, each with a view of its values; none for `undefined`. */
export function unpackPatches(patches: Patches | undefined): Patch[] {
	const list: Patch[] = [];
	if (patches === undefined) {
		return list;
	}
	const { index, data } = patches;
	for (let p = 0; p < index.length; p += PATCH_STRIDE) {
		const count = index[p + PATCH_COUNT]!;
		const offset = index[p + PATCH_OFFSET]!;
		list.push({
			series: index[p + PATCH_SERIES]!,
			level: index[p + PATCH_LEVEL]!,
			start: index[p + PATCH_START]!,
			count,
			data: data.subarray(offset, offset + count * index[p + PATCH_COLUMNS]!),
		});
	}
	return list;
}

export interface EngineEvent {
	/** Id of the engine the event comes from, set by a worker host (see `HostMessage`). */
	engine?: number;
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
	/** Packed representation when requested by the client. */
	packedPatches?: Patches;
	/**
	 * Rows the engine needs fetched again: a raw window over them, or an operation that needs them,
	 * waits until they are back (or fetching failed) and comes with a later event.
	 */
	fetch?: FetchRequest[];
	/** Ids of fetch requests whose rows are no longer needed: the view moved away, or they were replaced. */
	cancel?: number[];
	/** Outcome of the rows handed back by the command this event answers. */
	restored?: RestoreResult;
	/**
	 * Indicators whose values are being recomputed in the background; absent when none. Their old
	 * values stay until the new ones are swapped in, which an event with `stale` reports.
	 */
	computing?: number;
	/** Plugin modules that finished loading, or failed to, since the last event. */
	plugins?: PluginResult[];
	/**
	 * Operations of this command that wait for rows let go and take effect in a later event: rows of
	 * a batch of ticks, or 0 for a `set`, `prepend` or `delete`.
	 */
	waiting?: number[];
	/**
	 * Operations that waited and took effect in this event, as pairs of the `seq` of their command
	 * and their row. A `set` or `remove` of a series drops its waiting operations.
	 */
	applied?: number[];
	/** Operations that waited and were refused in this event (a correction of a bar that is gone), as in `applied`. */
	refused?: number[];
	/** Answer to a `resolve` command. */
	resolved?: TimelineResolution;
	/** Rows of marks series: the answer to a `marksWindow` command, or what an append changed in the window sent last. */
	marks?: MarksUpdate[];
}

/** First message a worker host sends, before any event. */
export interface ReadyMessage {
	ready: true;
}

/** Buffers of an event that can be transferred instead of copied, each listed once. */
export function transferables(event: EngineEvent): ArrayBuffer[] {
	const list: ArrayBuffer[] = [];
	const add = (buffer: ArrayBuffer): void => {
		// A buffer listed twice makes `postMessage` throw.
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
	if (event.packedPatches !== undefined) {
		add(event.packedPatches.index.buffer as ArrayBuffer);
		add(event.packedPatches.data.buffer as ArrayBuffer);
	}
	if (event.patches !== undefined) {
		for (const patch of event.patches) {
			add(patch.data.buffer as ArrayBuffer);
		}
	}
	if (event.resolved !== undefined) {
		add(event.resolved.positions.buffer as ArrayBuffer);
	}
	if (event.marks !== undefined) {
		for (const update of event.marks) {
			add(update.time.buffer as ArrayBuffer);
			add(update.price.buffer as ArrayBuffer);
			add(update.values.buffer as ArrayBuffer);
		}
	}
	return list;
}
