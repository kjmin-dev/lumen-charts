import { CHUNK_MASK, CHUNK_ROWS, TIME } from './chunk';
import {
	type Command,
	type EngineEvent,
	type Patch,
	type SeriesKind,
	TICK_STRIDE,
	TIME_PATCH,
	type WindowSnapshot,
	valueColumnCount,
} from './protocol';
import { ChunkedStore } from './store';

interface SeriesState {
	readonly id: number;
	readonly kind: SeriesKind;
	readonly store: ChunkedStore;
	readonly valueColumns: number;
	/** Main-timeline rows changed by the command being run: `[dirtyLo, dirtyHi)`. */
	dirtyLo: number;
	dirtyHi: number;
}

/**
 * The data engine: the only owner of history.
 *
 * It is synchronous and knows nothing about threads. A host feeds it commands and forwards the
 * events; `run` yields between slices of bulk work so a host on the main thread can time-slice it.
 *
 * Every series is exposed on the main timeline, which is the timeline of the first series (in
 * creation order) that has data. A bar of another series belongs to the main bar at or before its
 * time; bars sharing a main bar are merged, and bars before the first main bar are not shown.
 */
export class EngineCore {
	private readonly _series = new Map<number, SeriesState>();
	private _main: SeriesState | null = null;
	private _epoch = 0;
	private _scratch = new Float64Array(0);

	public *run(command: Command): Generator<undefined, EngineEvent, undefined> {
		const event: EngineEvent = { ack: command.seq, epoch: 0, first: 0, end: 0, stale: false, rejected: 0 };
		switch (command.type) {
			case 'add': {
				const kind = command.kind;
				const valueColumns = valueColumnCount(kind);
				this._series.set(command.series, {
					id: command.series,
					kind,
					store: new ChunkedStore(valueColumns + 1),
					valueColumns,
					dirtyLo: Infinity,
					dirtyHi: -Infinity,
				});
				break;
			}
			case 'remove': {
				const state = this._series.get(command.series);
				if (state !== undefined) {
					this._series.delete(command.series);
					if (state === this._main) {
						this._main = null;
						this._electMain();
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
				event.rejected = yield* this._prepend(state.store, command.data, command.count);
				// Prepending to the main series keeps every existing index, so the client's window stays valid.
				event.stale = state !== this._main;
				break;
			}
			case 'ticks':
				this._ticks(command.data, command.count, event);
				break;
			case 'window':
				yield* this._window(command.start, command.count, command.capacity, event);
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

	private *_set(state: SeriesState, data: Float64Array, count: number): Generator<undefined, number, undefined> {
		const wasMain = state === this._main;
		state.store.clear();
		const rejected = yield* this._append(state.store, data, count);
		if (!this._electMain() && wasMain) {
			// Same main series, but its indexes now mean different bars.
			this._epoch++;
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
			state.dirtyLo = Infinity;
			state.dirtyHi = -Infinity;
		}
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
		const patches: Patch[] = [];
		for (const dirty of series.values()) {
			const start = dirty.dirtyLo;
			const rows = dirty.dirtyHi - start;
			if (!(rows > 0)) {
				continue;
			}
			const values = new Float64Array(rows * dirty.valueColumns);
			if (dirty === main) {
				const time = new Float64Array(rows);
				main.store.copyColumn(TIME, start, start + rows, time, 0);
				patches.push({ series: TIME_PATCH, start, count: rows, data: time });
				for (let c = 0; c < dirty.valueColumns; c++) {
					main.store.copyColumn(c + 1, start, start + rows, values, c * rows);
				}
			} else {
				this._aligned(dirty, start, start + rows, values, rows);
			}
			patches.push({ series: dirty.id, start, count: rows, data: values });
		}
		if (patches.length > 0) {
			event.patches = patches;
		}
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
		start: number,
		count: number,
		capacity: number,
		event: EngineEvent,
	): Generator<undefined, undefined, undefined> {
		const main = this._main;
		if (main === null) {
			event.window = { start: 0, count: 0, capacity: 0, time: new Float64Array(0), series: [] };
			return;
		}
		const from = Math.min(Math.max(start, main.store.first), main.store.end);
		const to = Math.max(from, Math.min(start + count, main.store.end));
		const rows = to - from;
		const stride = Math.max(capacity, rows);
		const time = new Float64Array(stride);
		main.store.copyColumn(TIME, from, to, time, 0);
		const window: WindowSnapshot = { start: from, count: rows, capacity: stride, time, series: [] };
		event.window = window;
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
			let volume = 0;
			do {
				if (valueColumns === 1) {
					close = columns[1]![row]!;
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
						volume += v;
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
	if (index < state.dirtyLo) {
		state.dirtyLo = index;
	}
	if (index >= state.dirtyHi) {
		state.dirtyHi = index + 1;
	}
}
