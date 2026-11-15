import { CHUNK_MASK, CHUNK_ROWS, TIME } from './chunk';
import {
	type Command,
	type EngineEvent,
	type Patch,
	type SeriesKind,
	TICK_STRIDE,
	TIME_PATCH,
	type WindowSnapshot,
	levelColumnCount,
	levelCount,
	levelShift,
	valueColumnCount,
} from './protocol';
import { LINE_AGGREGATES, OHLCV_AGGREGATES, Pyramid, TIME_AGGREGATES, aggregate, storeBuckets } from './pyramid';
import { ChunkedStore } from './store';

/** Rows of the main timeline a bulk level-of-detail build handles between two yields. */
const BUILD_SLICE = 65_536;

/** Value column (counted from the first value column) each level column of a kind is built from. */
const LINE_SOURCES: readonly number[] = [0, 0, 0, 0];
const OHLCV_SOURCES: readonly number[] = [0, 1, 2, 3, 4];

interface SeriesState {
	readonly id: number;
	readonly kind: SeriesKind;
	readonly store: ChunkedStore;
	readonly valueColumns: number;
	/** Level-of-detail buckets of this series' values on the main timeline. */
	readonly pyramid: Pyramid;
	readonly sources: readonly number[];
	/**
	 * Main-timeline rows changed by the command being run, as `[from, to)` pairs. Rows far apart
	 * (a correction of an old bar and an update of the last one) stay separate runs, so a patch
	 * never has to carry the untouched rows between them.
	 */
	runs: number[];
	/** Position in `runs` of the run touched last. */
	run: number;
}

/** Patch layout collected before one buffer is allocated for all patches of an event. */
const SPEC_SERIES = 0;
const SPEC_LEVEL = 1;
const SPEC_START = 2;
const SPEC_COUNT = 3;
const SPEC_COLUMNS = 4;
const SPEC_STRIDE = 5;

/**
 * The data engine: the only owner of history.
 *
 * It is synchronous and knows nothing about threads. A host feeds it commands and forwards the
 * events; `run` yields between slices of bulk work so a host on the main thread can time-slice it.
 *
 * Every series is exposed on the main timeline, which is the timeline of the first series (in
 * creation order) that has data. A bar of another series belongs to the main bar at or before its
 * time; bars sharing a main bar are merged, and bars before the first main bar are not shown.
 *
 * Level of detail: every series keeps a pyramid of buckets over the main timeline (16, 64, 256, ...
 * rows), and the main timeline keeps one for the time of each bucket's first row. Bulk loads leave
 * the pyramids to be built in the background (`backgroundStep`), so a load is answered as soon as
 * the rows are stored; the first command that needs them finishes the build first. Prepends and
 * ticks update only the buckets that hold changed rows, always from all of their members.
 */
export class EngineCore {
	private readonly _series = new Map<number, SeriesState>();
	private _main: SeriesState | null = null;
	private _epoch = 0;
	private _scratch = new Float64Array(0);

	/** Bucket time of the main timeline. */
	private readonly _time = new Pyramid(TIME_AGGREGATES);
	/** Levels every built pyramid has: `levelCount` of the main timeline. */
	private _levels = 0;
	/** Pyramids waiting for a full build, in the order they are built. */
	private readonly _pending = new Set<Pyramid>();
	private _build: Generator<undefined, void, undefined> | null = null;
	/** Reused buffers: buckets being computed, aligned values of a secondary series, kernel arguments. */
	private _block = new Float64Array(0);
	private _values = new Float64Array(0);
	private readonly _sources: Float64Array[] = [];
	private readonly _bases: number[] = [];
	/** Reused patch bookkeeping. */
	private readonly _specs: number[] = [];
	private readonly _ranges: number[] = [];

	public *run(command: Command): Generator<undefined, EngineEvent, undefined> {
		const event: EngineEvent = { ack: command.seq, epoch: 0, first: 0, end: 0, stale: false, rejected: 0 };
		switch (command.type) {
			case 'add': {
				const kind = command.kind;
				const valueColumns = valueColumnCount(kind);
				const state: SeriesState = {
					id: command.series,
					kind,
					store: new ChunkedStore(valueColumns + 1),
					valueColumns,
					pyramid: new Pyramid(kind === 'ohlcv' ? OHLCV_AGGREGATES : LINE_AGGREGATES),
					sources: kind === 'ohlcv' ? OHLCV_SOURCES : LINE_SOURCES,
					runs: [],
					run: 0,
				};
				this._series.set(command.series, state);
				if (this._main !== null) {
					// Its buckets have to span the main timeline like every other pyramid's.
					this._pending.add(state.pyramid);
				}
				break;
			}
			case 'remove': {
				const state = this._series.get(command.series);
				if (state !== undefined) {
					this._series.delete(command.series);
					this._pending.delete(state.pyramid);
					this._build = null;
					if (state === this._main) {
						this._main = null;
						if (this._electMain()) {
							this._rebuildAll();
						}
						event.stale = true;
					}
				}
				break;
			}
			case 'set': {
				const state = this._series.get(command.series);
				if (state === undefined) {
					event.rejected = command.count;
					break;
				}
				event.rejected = yield* this._set(state, command.data, command.count);
				event.stale = true;
				break;
			}
			case 'prepend': {
				const state = this._series.get(command.series);
				if (state === undefined) {
					event.rejected = command.count;
					break;
				}
				if (state.store.length === 0) {
					event.rejected = yield* this._set(state, command.data, command.count);
					event.stale = true;
					break;
				}
				yield* this._drain();
				const store = state.store;
				const oldFirst = store.first;
				const oldFirstTime = store.firstTime();
				event.rejected = yield* this._prepend(store, command.data, command.count);
				if (state === this._main) {
					// Prepending to the main series keeps every existing index, so the client's windows stay
					// valid, except for the first bucket of each level, which can gain rows.
					yield* this._extendLeft(oldFirst);
					this._boundaryPatches(oldFirst, event);
				} else {
					if (this._main !== null && store.first < oldFirst) {
						const main = this._main.store;
						const lo = Math.max(main.first, this._mainIndex(store.firstTime()));
						const hi = this._mainIndex(oldFirstTime) + 1;
						yield* this._refreshSliced(state.pyramid, state, lo, hi);
					}
					event.stale = true;
				}
				break;
			}
			case 'ticks':
				yield* this._drain();
				this._ticks(command.data, command.count, event);
				break;
			case 'window':
				if (command.level > 0) {
					yield* this._drain();
				}
				yield* this._window(command.level, command.start, command.count, command.capacity, event);
				break;
		}
		const main = this._main;
		event.epoch = this._epoch;
		if (main !== null) {
			event.first = main.store.first;
			event.end = main.store.end;
		}
		return event;
	}

	/** True while level-of-detail buckets are waiting to be built. */
	public get busy(): boolean {
		return this._pending.size > 0;
	}

	/**
	 * Runs one slice of the background build of level-of-detail buckets. Returns true while more
	 * remains. A host calls this when no command is waiting; commands that need the buckets finish
	 * the build themselves.
	 */
	public backgroundStep(): boolean {
		if (this._pending.size === 0) {
			return false;
		}
		this._build ??= this._buildAll();
		if (this._build.next().done === true) {
			this._build = null;
		}
		return this._pending.size > 0;
	}

	/** Event for a command that threw: it tells the client the command is over and what still holds. */
	public failure(command: Command): EngineEvent {
		const main = this._main;
		return {
			ack: command.seq,
			epoch: this._epoch,
			first: main === null ? 0 : main.store.first,
			end: main === null ? 0 : main.store.end,
			stale: true,
			rejected: 0,
			failed: true,
		};
	}

	/** Picks the main series. Returns true (and starts a new epoch) if it changed. */
	private _electMain(): boolean {
		let next: SeriesState | null = null;
		for (const state of this._series.values()) {
			if (state.store.length > 0) {
				next = state;
				break;
			}
		}
		if (next === this._main) {
			return false;
		}
		this._main = next;
		this._epoch++;
		return true;
	}

	/** The main timeline changed: every pyramid is built again. */
	private _rebuildAll(): void {
		this._pending.clear();
		this._pending.add(this._time);
		for (const state of this._series.values()) {
			this._pending.add(state.pyramid);
		}
		this._build = null;
	}

	private *_set(state: SeriesState, data: Float64Array, count: number): Generator<undefined, number, undefined> {
		const wasMain = state === this._main;
		state.store.clear();
		const rejected = yield* this._append(state.store, data, count);
		if (this._electMain()) {
			this._rebuildAll();
		} else if (wasMain) {
			// Same main series, but its indexes now mean different bars.
			this._epoch++;
			this._rebuildAll();
		} else if (this._main !== null) {
			this._pending.add(state.pyramid);
			this._build = null;
		}
		return rejected;
	}

	/** Appends rows while their times keep increasing. Returns the number of rows left out. */
	private *_append(store: ChunkedStore, data: Float64Array, count: number): Generator<undefined, number, undefined> {
		let previous = store.length > 0 ? store.lastTime() : -Infinity;
		for (let from = 0; from < count; from += CHUNK_ROWS) {
			const to = Math.min(count, from + CHUNK_ROWS);
			let valid = to;
			for (let i = from; i < to; i++) {
				const time = data[i]!;
				// Written this way so a NaN time fails too.
				if (!(time > previous)) {
					valid = i;
					break;
				}
				previous = time;
			}
			store.append(data, count, from, valid);
			if (valid < to) {
				return count - valid;
			}
			yield;
		}
		return 0;
	}

	/** Prepends rows, walking backward from the newest. Returns the number of rows left out. */
	private *_prepend(store: ChunkedStore, data: Float64Array, count: number): Generator<undefined, number, undefined> {
		let next = store.firstTime();
		for (let to = count; to > 0; to -= CHUNK_ROWS) {
			const from = Math.max(0, to - CHUNK_ROWS);
			let valid = from;
			for (let i = to - 1; i >= from; i--) {
				const time = data[i]!;
				if (!(time < next)) {
					valid = i + 1;
					break;
				}
				next = time;
			}
			store.prepend(data, count, valid, to);
			if (valid > from) {
				return valid;
			}
			yield;
		}
		return 0;
	}

	private _ticks(data: Float64Array, count: number, event: EngineEvent): void {
		const series = this._series;
		for (const state of series.values()) {
			state.runs.length = 0;
			state.run = 0;
		}
		const mainBefore = this._main;
		const endBefore = mainBefore === null ? 0 : mainBefore.store.end;
		let id = NaN;
		let state: SeriesState | undefined;
		for (let i = 0, offset = 0; i < count; i++, offset += TICK_STRIDE) {
			const tickSeries = data[offset]!;
			if (tickSeries !== id) {
				id = tickSeries;
				state = series.get(tickSeries);
			}
			const time = data[offset + 1]!;
			if (state === undefined || time !== time) {
				event.rejected++;
				continue;
			}
			const store = state.store;
			let index: number;
			let appended = false;
			if (store.length === 0) {
				store.appendRow(data, offset + 1);
				index = store.end - 1;
				appended = true;
				if (this._electMain()) {
					this._rebuildAll();
					event.stale = true;
				}
			} else {
				const last = store.lastTime();
				if (time === last) {
					index = store.end - 1;
					store.writeRow(index, data, offset + 1);
				} else if (time > last) {
					store.appendRow(data, offset + 1);
					index = store.end - 1;
					appended = true;
				} else {
					// A correction of an older bar. Inserting a bar in the middle would shift indexes, so it is refused.
					index = store.lowerBound(time);
					if (store.value(TIME, index) !== time) {
						event.rejected++;
						continue;
					}
					store.writeRow(index, data, offset + 1);
				}
			}
			const main = this._main!;
			if (state === main) {
				markDirty(main, index);
				if (appended && series.size > 1) {
					// Bars of other series at or after the new bar's time were merged into the previous
					// main bar and now belong to the new one.
					for (const other of series.values()) {
						if (other !== main && other.store.length > 0 && other.store.lastTime() >= time) {
							if (index > main.store.first) {
								markDirty(other, index - 1);
							}
							markDirty(other, index);
						}
					}
				}
			} else {
				const mainIndex = this._mainIndex(time);
				if (mainIndex >= main.store.first) {
					markDirty(state, mainIndex);
				}
			}
		}
		if (event.stale) {
			return;
		}
		const main = this._main;
		if (main === null) {
			return;
		}
		const end = main.store.end;
		this._refreshRuns(this._time, null, main.runs);
		this._refreshRuns(main.pyramid, main, main.runs);
		for (const other of series.values()) {
			if (other !== main) {
				this._refreshRuns(other.pyramid, other, other.runs);
				if (end > endBefore) {
					// New main bars open buckets in every pyramid, including the series that have no value there.
					this._refresh(other.pyramid, other, endBefore, end);
				}
			}
		}
		this._growLevels();

		const specs = this._specs;
		specs.length = 0;
		// The main series goes first: its time patches tell the client which rows exist.
		this._specRuns(main, true);
		for (const other of series.values()) {
			if (other !== main) {
				this._specRuns(other, false);
			}
		}
		for (let level = 1; level <= this._levels; level++) {
			this._specLevel(level, TIME_PATCH, main.runs, 0, 0);
			this._specLevel(level, main.id, main.runs, 0, 0);
			for (const other of series.values()) {
				if (other !== main) {
					this._specLevel(level, other.id, other.runs, endBefore, end);
				}
			}
		}
		this._emit(event);
	}

	/** Adds one raw patch spec per run of changed rows of a series (and the time column for the main series). */
	private _specRuns(state: SeriesState, main: boolean): void {
		const runs = state.runs;
		const specs = this._specs;
		for (let r = 0; r < runs.length; r += 2) {
			const start = runs[r]!;
			const rows = runs[r + 1]! - start;
			if (main) {
				specs.push(TIME_PATCH, 0, start, rows, 1);
			}
			specs.push(state.id, 0, start, rows, state.valueColumns);
		}
	}

	/**
	 * Adds the patch specs of one level for the buckets holding the rows of `runs`, plus rows
	 * `[extraFrom, extraTo)`. Ranges that meet in the same bucket become one patch.
	 */
	private _specLevel(level: number, series: number, runs: readonly number[], extraFrom: number, extraTo: number): void {
		const ranges = this._ranges;
		ranges.length = 0;
		for (let r = 0; r < runs.length; r += 2) {
			insertRange(ranges, runs[r]!, runs[r + 1]!);
		}
		if (extraTo > extraFrom) {
			insertRange(ranges, extraFrom, extraTo);
		}
		if (ranges.length === 0) {
			return;
		}
		const shift = levelShift(level);
		const columns = series === TIME_PATCH ? 1 : levelColumnCount(this._series.get(series)!.kind);
		const specs = this._specs;
		let lo = ranges[0]! >> shift;
		let hi = ((ranges[1]! - 1) >> shift) + 1;
		for (let r = 2; r < ranges.length; r += 2) {
			const from = ranges[r]! >> shift;
			const to = ((ranges[r + 1]! - 1) >> shift) + 1;
			if (from <= hi) {
				hi = Math.max(hi, to);
			} else {
				specs.push(series, level, lo, hi - lo, columns);
				lo = from;
				hi = to;
			}
		}
		specs.push(series, level, lo, hi - lo, columns);
	}

	/** Patches of the first bucket of every level after history was prepended in front of `oldFirst`. */
	private _boundaryPatches(oldFirst: number, event: EngineEvent): void {
		const specs = this._specs;
		specs.length = 0;
		for (let level = 1; level <= this._levels; level++) {
			const shift = levelShift(level);
			// A prepend that is a multiple of the bucket size only adds whole buckets.
			if ((oldFirst & ((1 << shift) - 1)) === 0) {
				continue;
			}
			const bucket = oldFirst >> shift;
			specs.push(TIME_PATCH, level, bucket, 1, 1);
			for (const state of this._series.values()) {
				specs.push(state.id, level, bucket, 1, levelColumnCount(state.kind));
			}
		}
		this._emit(event);
	}

	/** Turns the collected specs into patches that share one buffer. */
	private _emit(event: EngineEvent): void {
		const specs = this._specs;
		if (specs.length === 0) {
			return;
		}
		let total = 0;
		for (let s = 0; s < specs.length; s += SPEC_STRIDE) {
			total += specs[s + SPEC_COUNT]! * specs[s + SPEC_COLUMNS]!;
		}
		const buffer = new Float64Array(total);
		const patches: Patch[] = [];
		const main = this._main!;
		let offset = 0;
		for (let s = 0; s < specs.length; s += SPEC_STRIDE) {
			const series = specs[s + SPEC_SERIES]!;
			const level = specs[s + SPEC_LEVEL]!;
			const start = specs[s + SPEC_START]!;
			const count = specs[s + SPEC_COUNT]!;
			const columns = specs[s + SPEC_COLUMNS]!;
			const data = buffer.subarray(offset, offset + count * columns);
			if (level === 0) {
				if (series === TIME_PATCH) {
					main.store.copyColumn(TIME, start, start + count, data, 0);
				} else {
					const state = this._series.get(series)!;
					if (state === main) {
						for (let c = 0; c < columns; c++) {
							main.store.copyColumn(c + 1, start, start + count, data, c * count);
						}
					} else {
						this._aligned(state, start, start + count, data, count);
					}
				}
			} else {
				const pyramid = series === TIME_PATCH ? this._time : this._series.get(series)!.pyramid;
				const store = pyramid.levels[level - 1]!;
				for (let c = 0; c < columns; c++) {
					store.copyColumn(c, start, start + count, data, c * count);
				}
			}
			patches.push({ series, level, start, count, data });
			offset += count * columns;
		}
		event.patches = patches;
	}

	/** Index of the main bar a time belongs to: the last bar at or before it. */
	private _mainIndex(time: number): number {
		const store = this._main!.store;
		if (time >= store.lastTime()) {
			return store.end - 1;
		}
		const index = store.lowerBound(time);
		return store.value(TIME, index) === time ? index : index - 1;
	}

	private *_window(
		level: number,
		start: number,
		count: number,
		capacity: number,
		event: EngineEvent,
	): Generator<undefined, undefined, undefined> {
		const main = this._main;
		if (main === null || level > this._levels) {
			// A level that does not exist (yet) is answered with an empty window, which ends the request.
			event.window = { level, start: 0, count: 0, capacity: 0, time: new Float64Array(0), series: [] };
			return;
		}
		const shift = levelShift(level);
		const first = main.store.first >> shift;
		const end = ((main.store.end - 1) >> shift) + 1;
		const from = Math.min(Math.max(start, first), end);
		const to = Math.max(from, Math.min(start + count, end));
		const rows = to - from;
		const stride = Math.max(capacity, rows);
		const time = new Float64Array(stride);
		const window: WindowSnapshot = { level, start: from, count: rows, capacity: stride, time, series: [] };
		event.window = window;
		if (level > 0) {
			this._time.levels[level - 1]!.copyColumn(0, from, to, time, 0);
			for (const state of this._series.values()) {
				const store = state.pyramid.levels[level - 1]!;
				const data = new Float64Array(stride * store.columnCount);
				for (let c = 0; c < store.columnCount; c++) {
					store.copyColumn(c, from, to, data, c * stride);
				}
				window.series.push({ series: state.id, data });
				yield;
			}
			return;
		}
		main.store.copyColumn(TIME, from, to, time, 0);
		for (const state of this._series.values()) {
			const data = new Float64Array(stride * state.valueColumns);
			if (state === main) {
				for (let c = 0; c < state.valueColumns; c++) {
					main.store.copyColumn(c + 1, from, to, data, c * stride);
					yield;
				}
			} else {
				this._aligned(state, from, to, data, stride);
				yield;
			}
			window.series.push({ series: state.id, data });
		}
	}

	// Level of detail

	/** Finishes the background build, yielding between slices. */
	private *_drain(): Generator<undefined, void, undefined> {
		while (this.backgroundStep()) {
			yield;
		}
	}

	private *_buildAll(): Generator<undefined, void, undefined> {
		// A Set visits entries added while it is iterated, so pyramids queued meanwhile are built too.
		for (const pyramid of this._pending) {
			yield* this._buildPyramid(pyramid);
			this._pending.delete(pyramid);
		}
	}

	/** Builds every level of a pyramid from scratch, over the whole main timeline. */
	private *_buildPyramid(pyramid: Pyramid): Generator<undefined, void, undefined> {
		const main = this._main;
		if (main === null) {
			pyramid.reset(0, 0);
			return;
		}
		const first = main.store.first;
		const end = main.store.end;
		this._levels = levelCount(end - first);
		pyramid.reset(this._levels, first);
		const owner = this._owner(pyramid);
		for (let lo = first; lo < end; lo += BUILD_SLICE) {
			this._refresh(pyramid, owner, lo, Math.min(end, lo + BUILD_SLICE));
			yield;
		}
	}

	/** Series a pyramid belongs to; null for the time pyramid. */
	private _owner(pyramid: Pyramid): SeriesState | null {
		if (pyramid === this._time) {
			return null;
		}
		for (const state of this._series.values()) {
			if (state.pyramid === pyramid) {
				return state;
			}
		}
		return null;
	}

	/** Recomputes the buckets of every pyramid that hold rows prepended in front of `oldFirst`. */
	private *_extendLeft(oldFirst: number): Generator<undefined, void, undefined> {
		const first = this._main!.store.first;
		for (let hi = oldFirst; hi > first; hi -= BUILD_SLICE) {
			const lo = Math.max(first, hi - BUILD_SLICE);
			this._refresh(this._time, null, lo, hi);
			for (const state of this._series.values()) {
				this._refresh(state.pyramid, state, lo, hi);
			}
			yield;
		}
		this._growLevels();
	}

	private *_refreshSliced(
		pyramid: Pyramid,
		owner: SeriesState,
		lo: number,
		hi: number,
	): Generator<undefined, void, undefined> {
		for (let from = lo; from < hi; from += BUILD_SLICE) {
			this._refresh(pyramid, owner, from, Math.min(hi, from + BUILD_SLICE));
			yield;
		}
	}

	private _refreshRuns(pyramid: Pyramid, owner: SeriesState | null, runs: readonly number[]): void {
		for (let r = 0; r < runs.length; r += 2) {
			this._refresh(pyramid, owner, runs[r]!, runs[r + 1]!);
		}
	}

	/**
	 * Recomputes, at every level from the finest up, the buckets that hold main rows `[lo, hi)`.
	 * Each bucket is rebuilt from all of its members (rows at the finest level, four buckets above
	 * it), never by merging in a changed value: a correction can lower a high.
	 */
	private _refresh(pyramid: Pyramid, owner: SeriesState | null, lo: number, hi: number): void {
		const main = this._main!.store;
		const from = Math.max(lo, main.first);
		const to = Math.min(hi, main.end);
		if (to <= from) {
			return;
		}
		for (let level = 1; level <= pyramid.levels.length; level++) {
			this._refreshLevel(pyramid, owner, level, from, to);
		}
	}

	private _refreshLevel(pyramid: Pyramid, owner: SeriesState | null, level: number, lo: number, hi: number): void {
		const shift = levelShift(level);
		const bucketFrom = lo >> shift;
		const bucketTo = ((hi - 1) >> shift) + 1;
		const buckets = bucketTo - bucketFrom;
		const columns = pyramid.columnCount;
		if (this._block.length < buckets * columns) {
			this._block = new Float64Array(Math.max(buckets * columns, this._block.length * 2, 256));
		}
		const block = this._block;
		if (level === 1) {
			const main = this._main!.store;
			this._aggregateRows(
				pyramid,
				owner,
				Math.max(bucketFrom << shift, main.first),
				Math.min(bucketTo << shift, main.end),
				shift,
				block,
				buckets,
			);
		} else {
			const child = pyramid.levels[level - 2]!;
			const sources = this._sources;
			const bases = this._bases;
			const aggregates = pyramid.aggregates;
			const end = Math.min(bucketTo << 2, child.end);
			let at = 0;
			let i = Math.max(bucketFrom << 2, child.first);
			while (i < end) {
				const chunk = child.chunkAt(i);
				const row = i & child.mask;
				const n = Math.min(child.rows - row, end - i);
				for (let c = 0; c < columns; c++) {
					sources[c] = chunk.columns[c]!;
					bases[c] = i - row;
				}
				at += aggregate(sources, bases, i, i + n, 2, aggregates, block, buckets, at);
				i += n;
			}
		}
		storeBuckets(pyramid.levels[level - 1]!, block, buckets, bucketFrom, bucketTo);
	}

	/** Aggregates main rows `[lo, hi)` (whole buckets of `2^shift` rows, cut only at the data's ends) into `block`. */
	private _aggregateRows(
		pyramid: Pyramid,
		owner: SeriesState | null,
		lo: number,
		hi: number,
		shift: number,
		block: Float64Array,
		stride: number,
	): void {
		const sources = this._sources;
		const bases = this._bases;
		const aggregates = pyramid.aggregates;
		const columns = aggregates.length;
		const main = this._main!;
		if (owner === null || owner === main) {
			const store = main.store;
			let at = 0;
			let r = lo;
			while (r < hi) {
				const chunk = store.chunkAt(r);
				const row = r & CHUNK_MASK;
				const n = Math.min(CHUNK_ROWS - row, hi - r);
				for (let c = 0; c < columns; c++) {
					sources[c] = chunk.columns[owner === null ? TIME : owner.sources[c]! + 1]!;
					bases[c] = r - row;
				}
				at += aggregate(sources, bases, r, r + n, shift, aggregates, block, stride, at);
				r += n;
			}
			return;
		}
		if (owner.store.length === 0) {
			const buckets = ((hi - 1) >> shift) - (lo >> shift) + 1;
			for (let c = 0; c < columns; c++) {
				block.fill(NaN, c * stride, c * stride + buckets);
			}
			return;
		}
		const rows = hi - lo;
		if (this._values.length < rows * owner.valueColumns) {
			this._values = new Float64Array(Math.max(rows * owner.valueColumns, this._values.length * 2, 256));
		}
		const values = this._values;
		this._aligned(owner, lo, hi, values, rows);
		for (let c = 0; c < columns; c++) {
			sources[c] = values;
			bases[c] = lo - owner.sources[c]! * rows;
		}
		aggregate(sources, bases, lo, hi, shift, aggregates, block, stride, 0);
	}

	/** Adds the levels a grown main timeline needs to every pyramid, each built from the level below. */
	private _growLevels(): void {
		const main = this._main!.store;
		const first = main.first;
		const end = main.end;
		const levels = levelCount(end - first);
		while (this._levels < levels) {
			this._levels++;
			const level = this._levels;
			this._time.addLevel(first);
			this._refreshLevel(this._time, null, level, first, end);
			for (const state of this._series.values()) {
				state.pyramid.addLevel(first);
				this._refreshLevel(state.pyramid, state, level, first, end);
			}
		}
	}

	/**
	 * Writes the values of a secondary series for main bars `[from, to)` into column-major `out`
	 * (columns `stride` long). Main bars without a matching bar get NaN.
	 */
	private _aligned(state: SeriesState, from: number, to: number, out: Float64Array, stride: number): void {
		const rows = to - from;
		if (rows <= 0) {
			return;
		}
		const valueColumns = state.valueColumns;
		for (let c = 0; c < valueColumns; c++) {
			out.fill(NaN, c * stride, c * stride + rows);
		}
		const store = state.store;
		if (store.length === 0) {
			return;
		}
		// times[k] is the time of main bar `from + k`; one extra entry bounds the last bar.
		const main = this._main!.store;
		let times = this._scratch;
		if (times.length < rows + 1) {
			times = new Float64Array(Math.max(rows + 1, times.length * 2));
			this._scratch = times;
		}
		const upper = Math.min(to + 1, main.end);
		main.copyColumn(TIME, from, upper, times, 0);
		if (upper === to) {
			times[rows] = Infinity;
		}

		const end = store.end;
		let j = store.lowerBound(times[0]!);
		if (j >= end) {
			return;
		}
		let columns = store.chunkAt(j).columns;
		let timeColumn = columns[TIME]!;
		let row = j & CHUNK_MASK;
		for (let k = 0; k < rows && j < end; k++) {
			const next = times[k + 1]!;
			if (timeColumn[row]! >= next) {
				continue;
			}
			let open = NaN;
			let high = -Infinity;
			let low = Infinity;
			let close = NaN;
			let volume = NaN;
			// As in every other aggregation, rows without a value are skipped, and a group made only
			// of such rows has no value.
			do {
				if (valueColumns === 1) {
					const value = columns[1]![row]!;
					if (value === value) {
						close = value;
					}
				} else {
					const o = columns[1]![row]!;
					const h = columns[2]![row]!;
					const l = columns[3]![row]!;
					const c = columns[4]![row]!;
					const v = columns[5]![row]!;
					if (open !== open) {
						open = o;
					}
					if (h > high) {
						high = h;
					}
					if (l < low) {
						low = l;
					}
					if (c === c) {
						close = c;
					}
					if (v === v) {
						volume = volume === volume ? volume + v : v;
					}
				}
				j++;
				row++;
				if (row === CHUNK_ROWS && j < end) {
					columns = store.chunkAt(j).columns;
					timeColumn = columns[TIME]!;
					row = 0;
				}
			} while (j < end && timeColumn[row]! < next);
			if (valueColumns === 1) {
				out[k] = close;
			} else {
				out[k] = open;
				out[stride + k] = high === -Infinity ? NaN : high;
				out[2 * stride + k] = low === Infinity ? NaN : low;
				out[3 * stride + k] = close;
				out[4 * stride + k] = volume;
			}
		}
	}
}

function markDirty(state: SeriesState, index: number): void {
	const runs = state.runs;
	// Ticks nearly always touch the run touched last, so that one is tried first.
	let r = state.run;
	if (r >= runs.length || index < runs[r]! - 1 || index > runs[r + 1]!) {
		for (r = 0; r < runs.length; r += 2) {
			if (index >= runs[r]! - 1 && index <= runs[r + 1]!) {
				break;
			}
		}
		if (r >= runs.length) {
			runs.push(index, index + 1);
			state.run = r;
			return;
		}
		state.run = r;
	}
	if (index < runs[r]!) {
		runs[r] = index;
	} else if (index >= runs[r + 1]!) {
		runs[r + 1] = index + 1;
	}
}

/** Inserts `[from, to)` into a list of ranges kept sorted by start (lists hold a few entries). */
function insertRange(ranges: number[], from: number, to: number): void {
	let i = ranges.length;
	ranges.push(from, to);
	while (i > 0 && ranges[i - 2]! > from) {
		ranges[i] = ranges[i - 2]!;
		ranges[i + 1] = ranges[i - 1]!;
		i -= 2;
	}
	ranges[i] = from;
	ranges[i + 1] = to;
}
