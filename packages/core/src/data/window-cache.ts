import { type EngineEvent, TIME_PATCH } from '@lumen-charts/engine';

export interface WindowRequest {
	start: number;
	count: number;
	capacity: number;
}

/** Spare rows kept after the last bar so ticks can append without requesting a new window. */
const TAIL_ROOM = 1024;

/**
 * The main thread's copy of the bars around the visible range, for every series, addressed by
 * main-timeline index. It is filled by snapshots from the engine and kept current by patches.
 */
export class WindowCache {
	public epoch = -1;
	/** Rows `[start, start + count)` are valid; buffers hold `capacity` rows. */
	public start = 0;
	public count = 0;
	public capacity = 0;
	public time: Float64Array = new Float64Array(0);
	/** Values per series, column-major with columns `capacity` long. */
	public readonly blocks = new Map<number, Float64Array>();
	/** Increases when the buffers are replaced, so views know to drop what they derived. */
	public version = 0;
	/** Rows changed by patches since the last `clearDirty`: `[dirtyLo, dirtyHi)`. */
	public dirtyLo = Infinity;
	public dirtyHi = -Infinity;

	private _stale = false;
	private _requested = false;

	/** True while a snapshot has been requested and not received. */
	public get loading(): boolean {
		return this._requested;
	}

	/** Applies an engine event. `valueColumns` gives the column count of a series by id. */
	public apply(event: EngineEvent, valueColumns: (series: number) => number): void {
		if (event.epoch !== this.epoch) {
			// Indexes mean different bars now; nothing held here can be shown.
			this.epoch = event.epoch;
			this.start = 0;
			this.count = 0;
			this.capacity = 0;
			this.time = new Float64Array(0);
			this.blocks.clear();
			this.version++;
			this._stale = true;
		}
		if (event.stale) {
			this._stale = true;
		}
		const window = event.window;
		if (window !== undefined) {
			this._requested = false;
			this._stale = false;
			this.start = window.start;
			this.count = window.count;
			this.capacity = window.capacity;
			this.time = window.time;
			this.blocks.clear();
			for (const block of window.series) {
				const data = block.data;
				const columns = data.length / window.capacity;
				// Rows past the snapshot are filled in by patches; until then they must read as "no value".
				for (let c = 0; c < columns; c++) {
					data.fill(NaN, c * window.capacity + window.count, (c + 1) * window.capacity);
				}
				this.blocks.set(block.series, data);
			}
			this.version++;
			this.dirtyLo = Infinity;
			this.dirtyHi = -Infinity;
		}
		const patches = event.patches;
		if (patches === undefined || this.capacity === 0) {
			return;
		}
		const start = this.start;
		const capacity = this.capacity;
		let end = start + this.count;
		for (const patch of patches) {
			// A patch that leaves a gap after the cached rows cannot be applied. The rows it touches
			// are outside the window, and a new snapshot is requested when they come into view.
			if (patch.start > start + this.count) {
				continue;
			}
			const from = Math.max(patch.start, start);
			const to = Math.min(patch.start + patch.count, start + capacity);
			if (to <= from) {
				continue;
			}
			let target: Float64Array;
			let columns = 1;
			if (patch.series === TIME_PATCH) {
				target = this.time;
			} else {
				columns = patch.data.length / patch.count;
				let block = this.blocks.get(patch.series);
				if (block === undefined) {
					// A series that got its first data through ticks, after the snapshot was taken.
					block = new Float64Array(valueColumns(patch.series) * capacity).fill(NaN);
					this.blocks.set(patch.series, block);
					this.version++;
				}
				target = block;
			}
			const rows = to - from;
			const sourceRow = from - patch.start;
			const targetRow = from - start;
			if (rows === 1) {
				for (let c = 0; c < columns; c++) {
					target[c * capacity + targetRow] = patch.data[c * patch.count + sourceRow]!;
				}
			} else {
				for (let c = 0; c < columns; c++) {
					const offset = c * patch.count + sourceRow;
					target.set(patch.data.subarray(offset, offset + rows), c * capacity + targetRow);
				}
			}
			if (from < this.dirtyLo) {
				this.dirtyLo = from;
			}
			if (to > this.dirtyHi) {
				this.dirtyHi = to;
			}
			if (patch.series === TIME_PATCH && to > end) {
				end = to;
			}
		}
		// Only the time column extends the window: a row exists once the main series has it.
		this.count = end - start;
	}

	public clearDirty(): void {
		this.dirtyLo = Infinity;
		this.dirtyHi = -Infinity;
	}

	/**
	 * Decides whether a new snapshot is needed for the visible logical range `[from, to]` of a
	 * timeline with extent `[first, end)`. A snapshot covers two screens on each side; a new one is
	 * requested when less than half a screen is left, so scrolling does not request one per frame.
	 */
	public plan(from: number, to: number, first: number, end: number): WindowRequest | null {
		if (this._requested || end <= first) {
			return null;
		}
		const visibleFrom = Math.floor(from);
		const visibleTo = Math.ceil(to) + 1;
		const screen = Math.max(1, visibleTo - visibleFrom);
		const margin = Math.ceil(screen / 2);
		const needFrom = Math.max(first, visibleFrom - margin);
		const needTo = Math.min(end, visibleTo + margin);
		if (needTo <= needFrom) {
			return null;
		}
		if (!this._stale && needFrom >= this.start && needTo <= this.start + this.count) {
			return null;
		}
		const start = Math.max(first, visibleFrom - 2 * screen);
		const stop = Math.min(end, visibleTo + 2 * screen);
		const count = stop - start;
		this._requested = true;
		return { start, count, capacity: count + (stop === end ? Math.max(TAIL_ROOM, screen) : 0) };
	}
}
