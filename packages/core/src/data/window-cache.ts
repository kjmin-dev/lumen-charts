import { type EngineEvent, MAX_LEVEL, TIME_PATCH, levelShift } from '@lumen-charts/engine';

export interface WindowRequest {
	level: number;
	start: number;
	count: number;
	capacity: number;
}

/** Spare rows kept after the last bar so ticks can append without requesting a new window. */
const TAIL_ROOM = 1024;

/** Column count of a series at a level, by series id. */
export type ColumnCount = (series: number, level: number) => number;

/** Versions are unique across all windows, so a view can tell any two sets of buffers apart. */
let versions = 0;

/** Last bucket (exclusive) of a timeline ending at `end` (exclusive), at a level with `shift`. */
function levelEnd(first: number, end: number, shift: number): number {
	return end <= first ? Math.floor(end / 2 ** shift) : Math.floor((end - 1) / 2 ** shift) + 1;
}

/**
 * The main thread's copy of one level around the visible range, for every series, addressed by
 * main-timeline index (level 0) or bucket index (coarse levels). It is filled by snapshots from
 * the engine and kept current by patches.
 */
export class LevelWindow {
	public readonly level: number;
	/** log2 of the rows per item: 0 for raw rows. */
	public readonly shift: number;
	/** Items `[start, start + count)` are valid; buffers hold `capacity` items. */
	public start = 0;
	public count = 0;
	public capacity = 0;
	/** Time per item; at a coarse level, the time of the bucket's first row. */
	public time: Float64Array = new Float64Array(0);
	/** Values per series, column-major with columns `capacity` long. */
	public readonly blocks = new Map<number, Float64Array>();
	/** Changes when the buffers are replaced, so views know to drop what they derived. */
	public version = ++versions;
	/** Items changed by patches since the last `clearDirty`: `[dirtyLo, dirtyHi)`. */
	public dirtyLo = Infinity;
	public dirtyHi = -Infinity;
	/** The last snapshot came back empty because its rows could not be fetched again. */
	public incomplete = false;

	private _stale = false;
	private _requested = false;
	/**
	 * After a snapshot came back incomplete, none over the same items is planned before `_retryAt`
	 * (`performance.now()`); `[_retryFrom, _retryTo)` are the items of that snapshot.
	 */
	private _retryAt = 0;
	private _retryFrom = 0;
	private _retryTo = 0;
	/** Items of the last snapshot planned. */
	private _plannedFrom = 0;
	private _plannedTo = 0;
	/**
	 * True while the last cached item is the last of the timeline. Only then does a new item
	 * directly follow the cached ones, with every series' values for it arriving as patches.
	 */
	private _atTail = false;

	public constructor(level: number) {
		this.level = level;
		this.shift = levelShift(level);
	}

	/** True while a snapshot has been requested and not received. */
	public get loading(): boolean {
		return this._requested;
	}

	public get stale(): boolean {
		return this._stale;
	}

	/** Main-timeline rows `[from, to)` the held items cover, within the timeline `[first, end)`. */
	public rowsFrom(first: number): number {
		return Math.max(this.start * 2 ** this.shift, first);
	}

	public rowsTo(end: number): number {
		return Math.min((this.start + this.count) * 2 ** this.shift, end);
	}

	/** Lets go of the buffers. A request in flight still lands here. */
	public release(): void {
		if (this.capacity === 0 && this.blocks.size === 0) {
			return;
		}
		this.start = 0;
		this.count = 0;
		this.capacity = 0;
		this.time = new Float64Array(0);
		this.blocks.clear();
		this.version = ++versions;
		this._atTail = false;
		this.clearDirty();
	}

	/** Forgets everything after the timeline was re-based. */
	public reset(): void {
		this.release();
		this._stale = true;
		this.incomplete = false;
	}

	public markStale(): void {
		this._stale = true;
	}

	public cancelRequest(): void {
		this._requested = false;
	}

	/** Plans no snapshot over the items of the last one planned before `time` (`performance.now()`). */
	public holdOff(time: number): void {
		this._retryAt = time;
		this._retryFrom = this._plannedFrom;
		this._retryTo = this._plannedTo;
	}

	public clearDirty(): void {
		this.dirtyLo = Infinity;
		this.dirtyHi = -Infinity;
	}

	/** Takes over the buffers of a snapshot of this level. */
	public applySnapshot(window: NonNullable<EngineEvent['window']>): void {
		this._requested = false;
		this._stale = false;
		this.incomplete = window.incomplete === true;
		this.start = window.start;
		this.count = window.count;
		this.capacity = window.capacity;
		this.time = window.time;
		this.blocks.clear();
		for (const block of window.series) {
			const data = block.data;
			const columns = window.capacity === 0 ? 0 : data.length / window.capacity;
			// Items past the snapshot are filled in by patches; until then they must read as "no value".
			for (let c = 0; c < columns; c++) {
				data.fill(NaN, c * window.capacity + window.count, (c + 1) * window.capacity);
			}
			this.blocks.set(block.series, data);
		}
		this.version = ++versions;
		this.clearDirty();
	}

	/** Applies the patches of this level from an event whose timeline is `[first, end)` rows. */
	public applyPatches(event: EngineEvent, columnCount: ColumnCount): void {
		const level = this.level;
		const timelineEnd = levelEnd(event.first, event.end, this.shift);
		const patches = event.patches;
		if (patches === undefined || this.capacity === 0) {
			this._atTail = this.capacity > 0 && this.start + this.count === timelineEnd;
			return;
		}
		const start = this.start;
		const capacity = this.capacity;
		const cachedEnd = start + this.count;
		// The time patch comes first and tells how far the cached items may grow in this event. They
		// grow only from the tail of the timeline: otherwise the items in between were never delivered.
		let end = cachedEnd;
		if (this._atTail) {
			for (const patch of patches) {
				if (patch.level === level && patch.series === TIME_PATCH && patch.start <= cachedEnd) {
					end = Math.max(end, Math.min(patch.start + patch.count, start + capacity));
				}
			}
		}
		for (const patch of patches) {
			// A patch that leaves a gap after the cached items cannot be applied. The items it touches
			// are outside the window, and a new snapshot is requested when they come into view.
			if (patch.level !== level || patch.start > end) {
				continue;
			}
			const from = Math.max(patch.start, start);
			const to = Math.min(patch.start + patch.count, end);
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
					block = new Float64Array(columnCount(patch.series, level) * capacity).fill(NaN);
					this.blocks.set(patch.series, block);
					this.version = ++versions;
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
		}
		this.count = end - start;
		this._atTail = end === timelineEnd;
	}

	/**
	 * Decides whether a new snapshot is needed for the visible logical range `[from, to]` of a
	 * timeline with rows `[first, end)`. A snapshot covers two screens on each side; a new one is
	 * requested when less than half a screen is left, so scrolling does not request one per frame.
	 */
	public plan(from: number, to: number, first: number, end: number): WindowRequest | null {
		if (this._requested || end <= first) {
			return null;
		}
		const size = 2 ** this.shift;
		const visibleFrom = Math.floor(Math.floor(from) / size);
		const visibleTo = Math.floor(Math.ceil(to) / size) + 1;
		const lo = Math.floor(first / size);
		const hi = levelEnd(first, end, this.shift);
		const screen = Math.max(1, visibleTo - visibleFrom);
		const margin = Math.ceil(screen / 2);
		const needFrom = Math.max(lo, visibleFrom - margin);
		const needTo = Math.min(hi, visibleTo + margin);
		if (needTo <= needFrom) {
			return null;
		}
		if (!this._stale && needFrom >= this.start && needTo <= this.start + this.count) {
			return null;
		}
		// Rows that could not be fetched again are asked for only after a pause.
		if (needFrom < this._retryTo && needTo > this._retryFrom && performance.now() < this._retryAt) {
			return null;
		}
		const start = Math.max(lo, visibleFrom - 2 * screen);
		const stop = Math.min(hi, visibleTo + 2 * screen);
		const count = stop - start;
		this._requested = true;
		this._plannedFrom = start;
		this._plannedTo = stop;
		const room = this.shift === 0 ? TAIL_ROOM : Math.max(16, TAIL_ROOM >> this.shift);
		return { level: this.level, start, count, capacity: count + (stop === hi ? room : 0) };
	}
}

/**
 * The main thread's windows by level of detail: raw rows for narrow views and buckets of a coarse
 * level for wide ones, each around the visible range and kept current by patches. The chart draws
 * from one of them per frame and keeps only the windows next to the level it needs, so a wide view
 * never holds raw rows.
 */
export class WindowCache {
	public epoch = -1;
	private readonly _windows: (LevelWindow | undefined)[] = [];

	/** Window of a level, created empty on first use. */
	public level(level: number): LevelWindow {
		let window = this._windows[level];
		if (window === undefined) {
			window = new LevelWindow(level);
			this._windows[level] = window;
		}
		return window;
	}

	/** The raw rows. */
	public get raw(): LevelWindow {
		return this.level(0);
	}

	/** Window of a level if it holds anything. */
	public held(level: number): LevelWindow | null {
		const window = this._windows[level];
		return window !== undefined && window.capacity > 0 ? window : null;
	}

	/** Applies an engine event to every window. */
	public apply(event: EngineEvent, columnCount: ColumnCount): void {
		const windows = this._windows;
		if (event.epoch !== this.epoch) {
			// Indexes mean different rows now; nothing held here can be shown.
			this.epoch = event.epoch;
			for (const window of windows) {
				window?.reset();
			}
		}
		for (const window of windows) {
			if (window === undefined) {
				continue;
			}
			if (event.stale) {
				window.markStale();
			}
			if (event.failed === true) {
				// The engine could not answer; whatever was requested is not coming.
				window.cancelRequest();
			}
		}
		if (event.window !== undefined) {
			this.level(event.window.level).applySnapshot(event.window);
		}
		for (const window of windows) {
			window?.applyPatches(event, columnCount);
		}
	}

	/** Plans a snapshot of `level` for the visible logical range `[from, to]`; see `LevelWindow.plan`. */
	public plan(level: number, from: number, to: number, first: number, end: number): WindowRequest | null {
		return this.level(level).plan(from, to, first, end);
	}

	/**
	 * Window to draw rows `[from, to)` from (clamped to the timeline `[first, end)`): the one of
	 * `level` if it covers them, else the nearest level that does (the coarser one on a tie), else
	 * the window that shows the most of them, preferring `level`.
	 */
	public source(level: number, from: number, to: number, first: number, end: number): LevelWindow | null {
		const windows = this._windows;
		const desired = this.held(level);
		if (to <= from) {
			return desired;
		}
		if (desired !== null && covers(desired, from, to, first, end)) {
			return desired;
		}
		for (let distance = 1; distance <= MAX_LEVEL; distance++) {
			const coarser = windows[level + distance];
			if (coarser !== undefined && covers(coarser, from, to, first, end)) {
				return coarser;
			}
			const finer = level >= distance ? windows[level - distance] : undefined;
			if (finer !== undefined && covers(finer, from, to, first, end)) {
				return finer;
			}
		}
		let best = desired;
		let shown = desired === null ? 0 : overlap(desired, from, to, first, end);
		for (const window of windows) {
			if (window === undefined || window.capacity === 0 || window === desired) {
				continue;
			}
			const rows = overlap(window, from, to, first, end);
			if (rows > shown) {
				best = window;
				shown = rows;
			}
		}
		return shown > 0 ? best : null;
	}

	/** Releases windows more than one level away from both the level wanted and the one drawn. */
	public retain(level: number, drawn: number): void {
		const windows = this._windows;
		for (let k = 0; k < windows.length; k++) {
			if (Math.abs(k - level) > 1 && k !== drawn) {
				windows[k]?.release();
			}
		}
	}

	public removeSeries(series: number): void {
		for (const window of this._windows) {
			window?.blocks.delete(series);
		}
	}

	public clearDirty(): void {
		for (const window of this._windows) {
			window?.clearDirty();
		}
	}
}

function covers(window: LevelWindow, from: number, to: number, first: number, end: number): boolean {
	return window.capacity > 0 && window.rowsFrom(first) <= from && window.rowsTo(end) >= to;
}

function overlap(window: LevelWindow, from: number, to: number, first: number, end: number): number {
	return Math.max(0, Math.min(to, window.rowsTo(end)) - Math.max(from, window.rowsFrom(first)));
}
