import {
	type HeatmapColumns,
	MARK_COLUMNS,
	type MarksChange,
	type MarksChunk,
	type MarksData,
	type MarksProvisional,
	type MarksRequest,
	type MarksSelection,
	type MarksStore,
	type MarksUpdate,
} from './protocol';
import { Checksum, MARKS_SUMMARY_BYTES } from './summary';

/** Cells per chunk of a heatmap level, about: a chunk holds whole columns. */
const CHUNK_CELLS = 1 << 16;
/** A level gets a coarser one above it while it has more columns than this. */
export const HEATMAP_LEVEL_COLUMNS = 512;
const MAX_LEVELS = 12;
/** Cells between two yields of a bulk operation. */
const SLICE = 1 << 20;
/**
 * Faults of the store, which would otherwise read cells let go as NaN, or write a chunk let go in
 * part and leave its other columns without cells, without a word.
 */
const EVICTED_READ = 'lumen-ticks: cells of marks let go under the memory limit were read';
const EVICTED_WRITE = 'lumen-ticks: a chunk of marks let go under the memory limit was written in part';

/**
 * Up to `size` columns, each a time, the grid row of its first cell, its number of cells and the
 * cells, which follow one another in the order of the columns. A slot without a column has no cells.
 */
class HeatChunk {
	public readonly time: Float64Array;
	public readonly offset: Int32Array;
	public readonly length: Int32Array;
	/**
	 * Where the cells of each slot start, for slots up to `top`; slots after it have none yet, and
	 * `start[top]` is the end of the cells. Appending a column to a chunk is then constant work.
	 */
	public readonly start: Int32Array;
	public top = 0;
	public cells: Float32Array;
	/**
	 * Set while the cells are let go under the memory limit: their checksum. The times, rows and
	 * lengths of the columns stay.
	 */
	public summary: { high: number; low: number } | null = null;

	public constructor(size: number, rows: number) {
		this.time = new Float64Array(size);
		this.offset = new Int32Array(size);
		this.length = new Int32Array(size);
		this.start = new Int32Array(size + 1);
		this.cells = new Float32Array(size * rows);
	}

	public get used(): number {
		return this.start[this.top]!;
	}

	/** Checksum of the cells of the columns held, in their order. */
	public checksum(): { high: number; low: number } {
		const checksum = new Checksum();
		const cells = this.cells;
		for (let i = 0; i < this.used; i++) {
			checksum.single(cells[i]!);
		}
		return { high: checksum.high, low: checksum.low };
	}

	/**
	 * Replaces the cells of slots `[from, to)` with `n` cells of `source` from `at` on; the caller
	 * sets the starts of those slots from their lengths.
	 */
	public splice(from: number, to: number, source: Float32Array, at: number, n: number): void {
		if (this.summary !== null) {
			// Written anew: a chunk let go is written only where all of its columns are.
			this.summary = null;
			this.cells = new Float32Array(Math.max(n, this.start.length - 1));
			this.start.fill(0);
			this.top = 0;
			this.length.fill(0, 0, from);
			this.length.fill(0, to);
		}
		const start = this.start;
		const used = this.used;
		if (from > this.top) {
			// The slots between the last written and these have no cells.
			start.fill(used, this.top + 1, from + 1);
			this.top = from;
		}
		const a = start[from]!;
		const b = to <= this.top ? start[to]! : used;
		const delta = n - (b - a);
		if (delta !== 0) {
			if (used + delta > this.cells.length) {
				const grown = new Float32Array(Math.max(used + delta, Math.ceil(this.cells.length * 1.5)));
				grown.set(this.cells.subarray(0, used));
				this.cells = grown;
			}
			this.cells.copyWithin(b + delta, b, used);
			for (let slot = to + 1; slot <= this.top; slot++) {
				start[slot] = start[slot]! + delta;
			}
		}
		if (to > this.top) {
			this.top = to;
		}
		this.cells.set(source.subarray(at, at + n), a);
	}
}

/** Whether column `i` of `a` and column `j` of `b` (both `rows` cells) are the same: time, first row and cells. */
function sameColumn(a: HeatmapColumns, i: number, b: HeatmapColumns, j: number, rows: number): boolean {
	if (a.time[i] !== b.time[j] || (a.offsets?.[i] ?? 0) !== (b.offsets?.[j] ?? 0)) {
		return false;
	}
	for (let r = 0; r < rows; r++) {
		const x = a.values[i * rows + r]!;
		const y = b.values[j * rows + r]!;
		if (!(x === y || (x !== x && y !== y))) {
			return false;
		}
	}
	return true;
}

/** Cells `HeatmapStore.prepare` made for a chunk let go, and the checksum it had. */
interface HeatProvisional extends MarksProvisional {
	summary: { high: number; low: number };
	cells: Float32Array;
}

/**
 * One column as a level makes it: its time, first grid row and number of cells. Its cells go into
 * the level's scratch, from `HeatmapLevel.fill` on (see `HeatmapLevel.room`).
 */
interface ColumnOut {
	time: number;
	offset: number;
	length: number;
}

/**
 * The columns of one level, `[first, end)`, in chunks of whole columns. Indexes are signed and stay
 * put when columns are added in front; column `i` is slot `i - n * size` of chunk `n = floor(i / size)`.
 */
class HeatmapLevel {
	public first = 0;
	public end = 0;
	/** First column changed since `clearChanges`. */
	public changed = Infinity;
	/** Cells of the columns being made for one chunk, one after another; `fill` of them so far. */
	public fill = 0;
	private _scratch = new Float32Array(0);
	private readonly _chunks: HeatChunk[] = [];
	private _base = 0;
	private readonly _size: number;
	private readonly _rows: number;
	private readonly _out: ColumnOut = { time: 0, offset: 0, length: 0 };

	public constructor(rows: number) {
		this._rows = rows;
		this._size = Math.max(1, Math.floor(CHUNK_CELLS / rows));
	}

	public get count(): number {
		return this.end - this.first;
	}

	public get byteLength(): number {
		let bytes = 0;
		for (const chunk of this._chunks) {
			bytes += chunk.cells.byteLength + chunk.time.byteLength + chunk.offset.byteLength * 3;
			if (chunk.summary !== null) {
				bytes += MARKS_SUMMARY_BYTES;
			}
		}
		return bytes;
	}

	/** Chunks let go under the memory limit. */
	public evicted = 0;

	/** Numbers of the first and last chunk holding columns, and the columns of chunk `n`. */
	public get firstChunk(): number {
		return Math.floor(this.first / this._size);
	}

	public get lastChunk(): number {
		return Math.floor((this.end - 1) / this._size);
	}

	public chunkStart(n: number): number {
		return Math.max(this.first, n * this._size);
	}

	public chunkEnd(n: number): number {
		return Math.min(this.end, (n + 1) * this._size);
	}

	public chunkAt(n: number): HeatChunk | undefined {
		return this._chunks[n - this._base];
	}

	public isEvicted(n: number): boolean {
		return this._chunks[n - this._base]?.summary != null;
	}

	/** Lets go of the cells of chunk `n`, keeping their checksum when requested; returns the bytes freed. */
	public evict(n: number, checksum = true): number {
		const chunk = this._chunks[n - this._base];
		if (chunk === undefined || chunk.summary !== null) {
			return 0;
		}
		const bytes = chunk.cells.byteLength;
		chunk.summary = checksum ? chunk.checksum() : { high: 0, low: 0 };
		chunk.cells = new Float32Array(0);
		this.evicted++;
		return bytes - MARKS_SUMMARY_BYTES;
	}

	/**
	 * Gives the chunks let go that columns `[from, to)` cover in full, of those the level keeps once it
	 * holds `[first, end)`, arrays of their own again, to be written column by column; throws, before
	 * anything changes, for one they cover in part.
	 */
	public reviveFor(from: number, to: number, first: number, end: number): void {
		if (this.evicted === 0 || to <= from) {
			return;
		}
		const evicted: number[] = [];
		this.missing(from, to, evicted);
		for (const n of evicted) {
			if (Math.max(first, n * this._size) < from || Math.min(end, (n + 1) * this._size) > to) {
				throw new Error(EVICTED_WRITE);
			}
		}
		for (const n of evicted) {
			const chunk = this._chunks[n - this._base]!;
			chunk.summary = null;
			chunk.cells = new Float32Array(this._size * this._rows);
			chunk.start.fill(0);
			chunk.length.fill(0);
			chunk.top = 0;
			this.evicted--;
		}
	}

	/** Chunks let go that hold columns of `[from, to)`. */
	public missing(from: number, to: number, out: number[]): void {
		if (this.evicted === 0) {
			return;
		}
		from = Math.max(from, this.first);
		to = Math.min(to, this.end);
		if (to <= from) {
			return;
		}
		for (let n = Math.floor(from / this._size); n <= Math.floor((to - 1) / this._size); n++) {
			if (this.isEvicted(n)) {
				out.push(n);
			}
		}
	}

	public mark(column: number): void {
		if (column < this.changed) {
			this.changed = column;
		}
	}

	private _chunkFor(column: number): HeatChunk {
		const n = Math.floor(column / this._size);
		const chunks = this._chunks;
		if (chunks.length === 0) {
			this._base = n;
		}
		while (n < this._base) {
			chunks.unshift(new HeatChunk(this._size, this._rows));
			this._base--;
		}
		while (n >= this._base + chunks.length) {
			chunks.push(new HeatChunk(this._size, this._rows));
		}
		return chunks[n - this._base]!;
	}

	/** The chunk of a column, cells let go or not; its cells start at `cellsAt(column)` there. */
	public chunk(column: number): HeatChunk {
		return this._chunks[Math.floor(column / this._size) - this._base]!;
	}

	/** The cells of the chunk of a column held. Reading cells let go is a fault of the caller, and throws. */
	public cells(column: number): Float32Array {
		const chunk = this._chunks[Math.floor(column / this._size) - this._base]!;
		if (chunk.summary !== null) {
			throw new Error(EVICTED_READ);
		}
		return chunk.cells;
	}

	private _slot(column: number): number {
		return column - Math.floor(column / this._size) * this._size;
	}

	public timeAt(column: number): number {
		return this.chunk(column).time[this._slot(column)]!;
	}

	public offsetAt(column: number): number {
		return this.chunk(column).offset[this._slot(column)]!;
	}

	public lengthAt(column: number): number {
		return this.chunk(column).length[this._slot(column)]!;
	}

	public cellsAt(column: number): number {
		return this.chunk(column).start[this._slot(column)]!;
	}

	/** Room in the scratch for `length` more cells, from `fill` on: the array to write them into. */
	public room(length: number): Float32Array {
		const need = this.fill + length;
		if (this._scratch.length < need) {
			const grown = new Float32Array(Math.max(need, this._scratch.length * 2, 1024));
			grown.set(this._scratch.subarray(0, this.fill));
			this._scratch = grown;
		}
		return this._scratch;
	}

	/**
	 * Writes columns `[from, to)` as `make` makes them, chunk by chunk, so the cells of a chunk move
	 * at most once. The columns must lie in `[first, end)` or join on to it; the range held grows to
	 * take them in. A chunk whose cells were let go is written only in full (its other columns would
	 * lose their cells): writing one in part is a fault of the caller, and throws before anything
	 * changes.
	 */
	public rewrite(from: number, to: number, make: (column: number, out: ColumnOut) => void): void {
		const out = this._out;
		if (this.evicted > 0) {
			const first = this.end === this.first ? from : Math.min(this.first, from);
			const end = this.end === this.first ? to : Math.max(this.end, to);
			for (let n = Math.floor(from / this._size); n <= Math.floor((to - 1) / this._size); n++) {
				const start = Math.max(first, n * this._size);
				const stop = Math.min(end, (n + 1) * this._size);
				if (this.isEvicted(n) && (start < from || stop > to)) {
					throw new Error(EVICTED_WRITE);
				}
			}
		}
		let column = from;
		while (column < to) {
			const chunk = this._chunkFor(column);
			const slot = this._slot(column);
			const slots = Math.min(to, column - slot + this._size) - column;
			this.fill = 0;
			for (let k = 0; k < slots; k++) {
				make(column + k, out);
				chunk.time[slot + k] = out.time;
				chunk.offset[slot + k] = out.offset;
				chunk.length[slot + k] = out.length;
				this.fill += out.length;
			}
			if (chunk.summary !== null) {
				// Written anew where its cells were let go (see `HeatChunk.splice`).
				this.evicted--;
			}
			chunk.splice(slot, slot + slots, this._scratch, 0, this.fill);
			for (let s = slot; s < slot + slots; s++) {
				chunk.start[s + 1] = chunk.start[s]! + chunk.length[s]!;
			}
			column += slots;
		}
		this.fill = 0;
		if (this.end === this.first) {
			this.first = from;
			this.end = to;
		} else {
			this.first = Math.min(this.first, from);
			this.end = Math.max(this.end, to);
		}
	}

	/** Keeps columns `[first, end)` and lets go of chunks that hold none of them. */
	public limit(first: number, end: number): void {
		const chunks = this._chunks;
		if (end <= first) {
			chunks.length = 0;
			this.first = this.end = 0;
			this.evicted = 0;
			return;
		}
		this.first = first;
		this.end = end;
		const firstChunk = Math.floor(first / this._size);
		const lastChunk = Math.floor((end - 1) / this._size);
		const drop = (from: number, to: number): void => {
			for (let i = from; i < to; i++) {
				if (chunks[i]!.summary !== null) {
					this.evicted--;
				}
			}
		};
		if (lastChunk - this._base + 1 < chunks.length) {
			drop(Math.max(0, lastChunk - this._base + 1), chunks.length);
			chunks.length = Math.max(0, lastChunk - this._base + 1);
		}
		if (firstChunk > this._base) {
			drop(0, firstChunk - this._base);
			chunks.splice(0, firstChunk - this._base);
			this._base = firstChunk;
		}
	}

	/** First column whose time is after `time`. */
	public upperBound(time: number): number {
		let lo = this.first;
		let hi = this.end;
		while (lo < hi) {
			const mid = lo + ((hi - lo) >>> 1);
			if (this.timeAt(mid) <= time) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		return lo;
	}

	/** First column whose time is not before `time`. */
	public lowerBound(time: number): number {
		let lo = this.first;
		let hi = this.end;
		while (lo < hi) {
			const mid = lo + ((hi - lo) >>> 1);
			if (this.timeAt(mid) < time) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		return lo;
	}
}

/**
 * The columns of a heatmap and their levels of detail.
 *
 * Level 0 holds the columns as given: a time and `rows` cells each, on one grid of prices for the
 * whole series. A column starts at a row of the grid of its own (`offsets`), 0 unless the series
 * follows the price. Level `k` merges `4^k` columns by index into one: its time is the first
 * member's, it spans the grid rows its members span, and each cell is the largest of the members'
 * cells there, skipping cells without a value (a sum would make a cell four times as bright at every
 * level change). A change of a column rebuilds the bucket that holds it at every level from all of
 * its members, so replacing the last column with lower values lowers the levels too.
 */
export class HeatmapStore implements MarksStore {
	public readonly kind = 'heatmap';
	private _rows = 1;
	private _priceStart = 0;
	private _priceStep = 1;
	/** Some column starts at another grid row than 0: columns are sent with their rows. */
	private _varying = false;
	/** Level 0 first. */
	private _levels: HeatmapLevel[] = [new HeatmapLevel(1)];
	private _valueMin = Infinity;
	private _valueMax = -Infinity;

	public get byteLength(): number {
		let bytes = 0;
		for (const level of this._levels) {
			bytes += level.byteLength;
		}
		return bytes;
	}

	/** Number of coarse levels. */
	public get levels(): number {
		return this._levels.length - 1;
	}

	/** Cells per column as given, and the grid. */
	public get rows(): number {
		return this._rows;
	}

	public get priceStart(): number {
		return this._priceStart;
	}

	public get priceStep(): number {
		return this._priceStep;
	}

	/** The columns as given, for readers in the engine (indicators over the series). */
	public get raw(): HeatmapLevel {
		return this._levels[0]!;
	}

	public *set(data: MarksData): Generator<undefined, number, undefined> {
		const valid =
			data.kind === 'heatmap' &&
			Number.isInteger(data.rows) &&
			data.rows >= 1 &&
			Number.isFinite(data.priceStart) &&
			data.priceStep > 0 &&
			Number.isFinite(data.priceStep);
		this._rows = valid ? data.rows : 1;
		this._priceStart = valid ? data.priceStart : 0;
		this._priceStep = valid ? data.priceStep : 1;
		this._varying = false;
		this._levels = [new HeatmapLevel(this._rows)];
		this._levels[0]!.changed = 0;
		this._valueMin = Infinity;
		this._valueMax = -Infinity;
		if (!valid) {
			return data.count;
		}
		return yield* this._append(data);
	}

	/** Whether columns are on the grid of the series. */
	private _onGrid(data: MarksData): data is HeatmapColumns {
		return (
			data.kind === 'heatmap' &&
			data.rows === this._rows &&
			data.priceStart === this._priceStart &&
			data.priceStep === this._priceStep
		);
	}

	public *append(data: MarksData): Generator<undefined, number, undefined> {
		if (!this._onGrid(data)) {
			// Columns on another grid: a `set` starts one.
			return data.count;
		}
		return yield* this._append(data);
	}

	private *_append(data: HeatmapColumns): Generator<undefined, number, undefined> {
		const raw = this._levels[0]!;
		const { time, values, count } = data;
		const rows = this._rows;
		const offsets = data.offsets ?? null;
		let rejected = 0;
		let first = Infinity;
		let cells = 0;
		for (let i = 0; i < count; i++) {
			const t = time[i]!;
			const last = raw.count === 0 ? -Infinity : raw.timeAt(raw.end - 1);
			const offset = offsets === null ? 0 : offsets[i]!;
			// A column at the last column's time replaces it; one before it, or without a time, is refused.
			if (!(t >= last) || t - t !== 0 || (i + 1) * rows > values.length || !Number.isInteger(offset)) {
				rejected++;
				continue;
			}
			const column = t === last ? raw.end - 1 : raw.end;
			this._writeRaw(column, t, offset, values, i * rows);
			if (column < first) {
				first = column;
			}
			cells += rows;
			if (cells >= SLICE) {
				cells = 0;
				yield;
			}
		}
		if (first !== Infinity) {
			raw.mark(first);
			yield* this._rebuild(first, raw.end);
		}
		return rejected;
	}

	/**
	 * Adds columns before the first one, in time order and each before the first column's time; a
	 * column that is not is refused.
	 */
	public *prepend(data: MarksData): Generator<undefined, number, undefined> {
		if (!this._onGrid(data)) {
			return data.count;
		}
		const raw = this._levels[0]!;
		if (raw.count === 0) {
			return yield* this._append(data);
		}
		const { time, values, count } = data;
		const rows = this._rows;
		const offsets = data.offsets ?? null;
		const firstTime = raw.timeAt(raw.first);
		const accepted: number[] = [];
		let previous = -Infinity;
		for (let i = 0; i < count; i++) {
			const t = time[i]!;
			const offset = offsets === null ? 0 : offsets[i]!;
			if (t < firstTime && t > previous && (i + 1) * rows <= values.length && Number.isInteger(offset)) {
				accepted.push(i);
				previous = t;
			}
		}
		const n = accepted.length;
		if (n === 0) {
			return count;
		}
		const oldFirst = raw.first;
		raw.rewrite(oldFirst - n, oldFirst, (column, out) => {
			const i = accepted[column - (oldFirst - n)]!;
			this._column(out, raw, time[i]!, offsets === null ? 0 : offsets[i]!, values, i * rows);
		});
		raw.mark(raw.first);
		yield;
		yield* this._rebuild(raw.first, oldFirst + 1);
		return count - n;
	}

	/**
	 * Replaces existing columns at their exact timestamps in place, rebuilding only the buckets of
	 * every level that hold them. Columns whose timestamp is not present, or off-grid, are refused.
	 */
	public *correct(data: MarksData): Generator<undefined, number, undefined> {
		const raw = this._levels[0]!;
		if (!this._onGrid(data) || raw.count === 0) {
			return data.count;
		}
		const { time, values, count } = data;
		const rows = this._rows;
		const offsets = data.offsets ?? null;
		let rejected = 0;
		const touched: number[] = [];
		let cells = 0;
		for (let i = 0; i < count; i++) {
			const t = time[i]!;
			const offset = offsets === null ? 0 : offsets[i]!;
			if (t - t !== 0 || (i + 1) * rows > values.length || !Number.isInteger(offset)) {
				rejected++;
				continue;
			}
			const col = raw.lowerBound(t);
			if (col >= raw.end || raw.timeAt(col) !== t) {
				rejected++;
				continue;
			}
			this._writeRaw(col, t, offset, values, i * rows);
			touched.push(col);
			cells += rows;
			if (cells >= SLICE) {
				cells = 0;
				yield;
			}
		}
		if (touched.length > 0) {
			touched.sort((a, b) => a - b);
			raw.mark(touched[0]!);
			let runStart = touched[0]!;
			let runEnd = runStart + 1;
			for (let k = 1; k < touched.length; k++) {
				const col = touched[k]!;
				if (col <= runEnd) {
					if (col + 1 > runEnd) {
						runEnd = col + 1;
					}
				} else {
					yield* this._rebuild(runStart, runEnd);
					runStart = col;
					runEnd = col + 1;
				}
			}
			yield* this._rebuild(runStart, runEnd);
		}
		return rejected;
	}

	/**
	 * Removes the columns with times in `[from, to]`. At either end the other columns keep their
	 * indexes; in the middle those on the shorter side move over. The buckets of every level that
	 * held a removed or moved column are made again.
	 */
	public *delete(from: number, to: number): Generator<undefined, number, undefined> {
		const raw = this._levels[0]!;
		if (!(from <= to) || raw.count === 0) {
			return 0;
		}
		const a = raw.lowerBound(from);
		const b = raw.upperBound(to);
		const removed = b - a;
		if (removed <= 0) {
			return 0;
		}
		if (removed === raw.count) {
			this._levels = [new HeatmapLevel(this._rows)];
			this._levels[0]!.changed = 0;
			return removed;
		}
		const rows = this._rows;
		let lo: number;
		let hi: number;
		if (a === raw.first) {
			raw.limit(b, raw.end);
			lo = b;
			hi = b + 1;
		} else if (b === raw.end) {
			raw.limit(raw.first, a);
			lo = a - 1;
			hi = a;
		} else if (a - raw.first <= raw.end - b) {
			// The columns before the gap move right, the last first.
			const first = raw.first;
			raw.reviveFor(first + removed, b, first + removed, raw.end);
			for (let column = a - 1; column >= first; column--) {
				this._moveRaw(column, column + removed, rows);
			}
			raw.limit(first + removed, raw.end);
			lo = raw.first;
			hi = b + 1;
		} else {
			const end = raw.end;
			raw.reviveFor(a, end - removed, raw.first, end - removed);
			for (let column = b; column < end; column++) {
				this._moveRaw(column, column - removed, rows);
			}
			raw.limit(raw.first, end - removed);
			lo = a - 1;
			hi = raw.end;
		}
		raw.mark(raw.first);
		yield;
		yield* this._rebuild(Math.max(lo, raw.first), Math.min(hi, raw.end));
		return removed;
	}

	/** Copies a column of level 0 to another index. */
	private _moveRaw(from: number, to: number, rows: number): void {
		const raw = this._levels[0]!;
		const at = raw.cellsAt(from);
		const cells = raw.cells(from).slice(at, at + rows);
		this._writeRaw(to, raw.timeAt(from), raw.offsetAt(from), cells, 0);
	}

	/** Writes one column of level 0 from `rows` values of `values` from `at` on. */
	private _writeRaw(column: number, time: number, offset: number, values: Float32Array, at: number): void {
		const raw = this._levels[0]!;
		raw.rewrite(column, column + 1, (_, out) => this._column(out, raw, time, offset, values, at));
	}

	/** Makes a column of level 0 from `rows` values from `at` on, and takes them into the extremes. */
	private _column(
		out: ColumnOut,
		level: HeatmapLevel,
		time: number,
		offset: number,
		values: Float32Array,
		at: number,
	): void {
		const rows = this._rows;
		const target = level.room(rows);
		const into = level.fill;
		for (let r = 0; r < rows; r++) {
			const value = values[at + r]!;
			target[into + r] = value;
			if (value === value) {
				this._valueMin = Math.min(this._valueMin, value);
				this._valueMax = Math.max(this._valueMax, value);
			}
		}
		if (offset !== 0) {
			this._varying = true;
		}
		out.time = time;
		out.offset = offset;
		out.length = rows;
	}

	/**
	 * Rebuilds, at every level, the buckets that hold columns `[from, to)` of level 0, and sets each
	 * level's range from the one below: buckets that no longer have a member go, those that now have
	 * one are made. A bucket of a chunk whose cells were let go is not made: the chunk is made again
	 * from the levels below when it is read. The others are made from the finest level below that holds
	 * their members (`_mergeFinest`). Levels a shorter history no longer needs go once the level below
	 * them is held in full, or can be made so from what is held; until then they stay and are rebuilt,
	 * so that a removal never waits for marks only to let go of a level.
	 */
	private *_rebuild(from: number, to: number): Generator<undefined, void, undefined> {
		const levels = this._levels;
		let cells = 0;
		let lo = from;
		let hi = to;
		for (let l = 1; ; l++) {
			const below = levels[l - 1]!;
			if (below.count <= HEATMAP_LEVEL_COLUMNS || l > MAX_LEVELS) {
				if (levels.length <= l) {
					return;
				}
				let held = below.evicted === 0;
				if (!held && l - 1 > 0) {
					// Made from what is held, or not at all: nothing is made only to be let go again.
					const missing: number[] = [];
					this.missing(l - 1, below.first, below.end, missing);
					held = missing.length === 0 && this.materialize(l - 1, below.first, below.end);
				}
				if (held || l > MAX_LEVELS) {
					levels.length = l;
					return;
				}
			}
			const first = Math.floor(below.first / 4);
			const end = Math.ceil(below.end / 4);
			let level = levels[l];
			let a = Math.max(first, Math.floor(lo / 4));
			let b = Math.min(end, Math.ceil(hi / 4));
			if (level === undefined) {
				level = new HeatmapLevel(this._rows);
				levels.push(level);
				a = first;
				b = end;
			} else {
				level.limit(Math.max(first, level.first), Math.min(end, level.end));
				if (level.count === 0) {
					a = first;
					b = end;
				} else {
					if (first < level.first) {
						a = Math.min(a, first);
						b = Math.max(b, level.first);
					}
					if (end > level.end) {
						a = Math.min(a, level.end);
						b = Math.max(b, end);
					}
				}
			}
			if (b > a) {
				const into = level;
				const size = this._chunkColumns;
				for (let bucket = a; bucket < b;) {
					const stop = Math.min(b, (Math.floor(bucket / size) + 1) * size);
					if (!into.isEvicted(Math.floor(bucket / size))) {
						into.rewrite(bucket, stop, (k, out) => this._mergeFinest(l, k, out));
					}
					bucket = stop;
				}
				into.mark(a);
			}
			level.limit(first, end);
			lo = a;
			hi = b;
			cells += (b - a) * this._rows * 4;
			if (cells >= SLICE) {
				cells = 0;
				yield;
			}
		}
	}

	/**
	 * The finest level below `l` that holds every member of bucket `bucket` of level `l`: the level
	 * just below, or a finer one where cells of the levels between were let go. -1 when level 0 does
	 * not hold them all.
	 */
	private _finest(l: number, bucket: number): number {
		const missing: number[] = [];
		for (let m = l - 1; m >= 0; m--) {
			const below = this._levels[m]!;
			if (below.evicted === 0) {
				return m;
			}
			const span = 4 ** (l - m);
			missing.length = 0;
			below.missing(bucket * span, bucket * span + span, missing);
			if (missing.length === 0) {
				return m;
			}
		}
		return -1;
	}

	/**
	 * Makes bucket `bucket` of level `l` from its members on the finest level below that holds them:
	 * the largest cell on each row, which is the same from any level, as buckets nest.
	 */
	private _mergeFinest(l: number, bucket: number, out: ColumnOut): void {
		const m = this._finest(l, bucket);
		if (m < 0) {
			throw new Error(EVICTED_READ);
		}
		this._merge(this._levels[m]!, this._levels[l]!, bucket, out, 4 ** (l - m));
	}

	/** Makes bucket `bucket` of `level` from its members on a level below, `span` of them per bucket. */
	private _merge(below: HeatmapLevel, level: HeatmapLevel, bucket: number, out: ColumnOut, span = 4): void {
		const firstChild = Math.max(bucket * span, below.first);
		const end = Math.min(bucket * span + span, below.end);
		let low = Infinity;
		let high = -Infinity;
		for (let child = firstChild; child < end; child++) {
			const offset = below.offsetAt(child);
			low = Math.min(low, offset);
			high = Math.max(high, offset + below.lengthAt(child));
		}
		const length = Math.max(0, high - low);
		const target = level.room(length);
		const into = level.fill;
		target.fill(Number.NaN, into, into + length);
		for (let child = firstChild; child < end; child++) {
			const source = below.cells(child);
			const at = below.cellsAt(child);
			const shift = into + below.offsetAt(child) - low;
			const n = below.lengthAt(child);
			for (let r = 0; r < n; r++) {
				const value = source[at + r]!;
				// Also takes a value over a cell that has none.
				if (value === value && !(target[shift + r]! >= value)) {
					target[shift + r] = value;
				}
			}
		}
		out.time = below.timeAt(firstChild);
		out.offset = length > 0 ? low : 0;
		out.length = length;
	}

	// Memory: under the engine's memory limit, the cells of chunks of columns at level 0 and
	// intermediate coarse levels far from the view are let go. Level-0 chunks are fetched back from
	// the series' datafeed; coarse chunks are rebuilt from the level below. The times and rows of
	// every column, and the topmost coarse level, always stay.

	/**
	 * Chunks of columns that may be let go, with the times they span: level 0 and intermediate coarse
	 * levels `1 .. levels - 1` (never the topmost level, none of the first and last eight columns of
	 * each level, nor at level 0 the columns of the first and last bucket of the topmost level, which
	 * an append or prepend makes those buckets from where the levels between were let go; none
	 * overlapping `[keepFrom, keepTo]`, and none before the series has a level to draw from in their
	 * place).
	 */
	public evictable(keepFrom: number, keepTo: number, out: MarksChunk[]): void {
		const raw = this._levels[0]!;
		if (this.levels === 0 || raw.count === 0) {
			return;
		}
		const chunkColumns = this._chunkColumns;
		const span = 4 ** this.levels;
		const head = Math.max(raw.first + 8, (Math.floor(raw.first / span) + 1) * span);
		const tail = Math.min(raw.end - 9, Math.floor((raw.end - 1) / span) * span - 1);
		const first = Math.floor(head / chunkColumns) + 1;
		const last = Math.floor(tail / chunkColumns) - 1;
		for (let n = Math.max(first, raw.firstChunk); n <= Math.min(last, raw.lastChunk); n++) {
			if (raw.isEvicted(n)) {
				continue;
			}
			const from = raw.timeAt(raw.chunkStart(n));
			const to = raw.timeAt(raw.chunkEnd(n) - 1);
			if (to >= keepFrom && from <= keepTo) {
				continue;
			}
			const bytes = raw.chunkAt(n)!.cells.byteLength - MARKS_SUMMARY_BYTES;
			out.push({ chunk: n, level: 0, from, to, bytes });
		}
		for (let l = 1; l < this.levels; l++) {
			const level = this._levels[l]!;
			const lFirst = Math.floor((level.first + 8) / chunkColumns) + 1;
			const lLast = Math.floor((level.end - 9) / chunkColumns) - 1;
			const stride = 4 ** l;
			for (let n = Math.max(lFirst, level.firstChunk); n <= Math.min(lLast, level.lastChunk); n++) {
				if (level.isEvicted(n)) {
					continue;
				}
				const rawStart = Math.max(raw.first, level.chunkStart(n) * stride);
				const rawEnd = Math.min(raw.end, level.chunkEnd(n) * stride);
				if (rawEnd <= rawStart) {
					continue;
				}
				const from = raw.timeAt(rawStart);
				const to = raw.timeAt(rawEnd - 1);
				if (to >= keepFrom && from <= keepTo) {
					continue;
				}
				const bytes = level.chunkAt(n)!.cells.byteLength - MARKS_SUMMARY_BYTES;
				if (bytes > 0) {
					out.push({ chunk: n, level: l, from, to, bytes });
				}
			}
		}
	}

	private get _chunkColumns(): number {
		return Math.max(1, Math.floor(CHUNK_CELLS / this._rows));
	}

	public evict(chunk: number, level = 0): number {
		return this._levels[level]?.evict(chunk, level === 0) ?? 0;
	}

	public get evicted(): number {
		let total = 0;
		for (const level of this._levels) {
			total += level.evicted;
		}
		return total;
	}

	/** Rebuilds evicted coarse chunks covering `[start, end)` of `level` when finer levels are resident. */
	public materialize(level: number, start: number, end: number): boolean {
		const cur = this._levels[level];
		if (cur === undefined || cur.evicted === 0 || end <= start) {
			return true;
		}
		const evicted: number[] = [];
		cur.missing(start, end, evicted);
		if (evicted.length === 0) {
			return true;
		}
		if (level === 0) {
			return false;
		}
		const below = this._levels[level - 1]!;
		for (const n of evicted) {
			const cStart = cur.chunkStart(n);
			const cEnd = cur.chunkEnd(n);
			const childStart = Math.max(below.first, cStart * 4);
			const childEnd = Math.min(below.end, cEnd * 4);
			if (!this.materialize(level - 1, childStart, childEnd)) {
				return false;
			}
			cur.rewrite(cStart, cEnd, (bucket, out) => this._merge(below, cur, bucket, out));
		}
		return true;
	}

	/** Level-0 chunks let go that must be fetched to serve `[start, end)` of `level`. */
	public missing(level: number, start: number, end: number, out: number[]): void {
		const cur = this._levels[level];
		if (cur === undefined || cur.evicted === 0 || end <= start) {
			return;
		}
		const evicted: number[] = [];
		cur.missing(start, end, evicted);
		if (evicted.length === 0) {
			return;
		}
		if (level === 0) {
			for (const n of evicted) {
				if (!out.includes(n)) {
					out.push(n);
				}
			}
			return;
		}
		const below = this._levels[level - 1]!;
		for (const n of evicted) {
			const childStart = Math.max(below.first, cur.chunkStart(n) * 4);
			const childEnd = Math.min(below.end, cur.chunkEnd(n) * 4);
			this.missing(level - 1, childStart, childEnd, out);
		}
	}

	public fetchRange(chunk: number): { from: number; to: number; count: number } | null {
		const raw = this._levels[0]!;
		if (!raw.isEvicted(chunk)) {
			return null;
		}
		const start = raw.chunkStart(chunk);
		const end = raw.chunkEnd(chunk);
		return { from: raw.timeAt(start), to: raw.timeAt(end - 1), count: end - start };
	}

	/**
	 * Gives chunk `chunk` its cells back from what a datafeed returned for its times: the columns of
	 * those times, on the series' grid, each on the rows it had. Returns whether they were the
	 * columns let go.
	 */
	public restore(chunk: number, data: MarksData): boolean {
		const raw = this._levels[0]!;
		const held = raw.chunkAt(chunk);
		if (held === undefined || held.summary === null || !this._onGrid(data)) {
			return false;
		}
		const start = raw.chunkStart(chunk);
		const end = raw.chunkEnd(chunk);
		const from = raw.timeAt(start);
		const to = raw.timeAt(end - 1);
		const rows = this._rows;
		const cells = new Float32Array((end - start) * rows);
		let column = start;
		for (let i = 0; i < data.count; i++) {
			const t = data.time[i]!;
			if (t < from || t > to) {
				continue;
			}
			const offset = data.offsets == null ? 0 : data.offsets[i]!;
			if (
				column >= end ||
				t !== raw.timeAt(column) ||
				offset !== raw.offsetAt(column) ||
				(i + 1) * rows > data.values.length
			) {
				return false;
			}
			cells.set(data.values.subarray(i * rows, (i + 1) * rows), (column - start) * rows);
			column++;
		}
		if (column !== end) {
			return false;
		}
		const checksum = new Checksum();
		for (const cell of cells) {
			checksum.single(cell);
		}
		if (checksum.high !== held.summary.high || checksum.low !== held.summary.low) {
			return false;
		}
		held.summary = null;
		held.cells = cells;
		raw.evicted--;
		return true;
	}

	/**
	 * Takes the columns a datafeed returned for chunk `chunk` as they are after the first of the
	 * waiting changes `changes`, or after it and some of those behind it: none at a time a removal
	 * took, a correction's own (cells and first row) at a time it corrected, and the others at the
	 * times and on the rows of those let go, their cells taken as returned. The columns the changes
	 * remove get cells without values, which they take with them; those corrected get the correction's
	 * cells. Returns what `commit` puts in, or null when they fit neither.
	 */
	public prepare(chunk: number, data: MarksData, changes: readonly MarksChange[]): MarksProvisional | null {
		const raw = this._levels[0]!;
		const held = raw.chunkAt(chunk);
		if (held === undefined || held.summary === null || !this._onGrid(data)) {
			return null;
		}
		const rows = this._rows;
		const start = raw.chunkStart(chunk);
		const end = raw.chunkEnd(chunk);
		const from = raw.timeAt(start);
		const to = raw.timeAt(end - 1);
		// The columns returned for the chunk's times, by time, in order; but those an append or prepend
		// waiting adds (after a removal took the end or the start up to them): they come with it.
		const added = new Map<number, { columns: HeatmapColumns; at: number }>();
		for (const change of changes) {
			if ((change.op === 'append' || change.op === 'prepend') && this._onGrid(change.data)) {
				for (let i = 0; i < change.data.count; i++) {
					const t = change.data.time[i]!;
					if (t >= from && t <= to) {
						added.set(t, { columns: change.data, at: i });
					}
				}
			}
		}
		const given = new Map<number, number>();
		let previous = -Infinity;
		for (let i = 0; i < data.count; i++) {
			const t = data.time[i]!;
			if (!(t >= from && t <= to)) {
				continue;
			}
			if (!(t > previous) || (i + 1) * rows > data.values.length) {
				return null;
			}
			previous = t;
			const add = added.get(t);
			if (add !== undefined && sameColumn(data, i, add.columns, add.at, rows)) {
				continue;
			}
			given.set(t, i);
		}
		const columns = end - start;
		const at = new Map<number, number>();
		for (let c = start; c < end; c++) {
			at.set(raw.timeAt(c), c - start);
		}
		// What each column is after the changes: held (-1), removed (-2), or the column of a correction.
		const state = new Int32Array(columns);
		const by = Array.from<HeatmapColumns | null>({ length: columns }).fill(null);
		state.fill(-1);
		let reached = false;
		for (let j = 0; j < changes.length; j++) {
			const change = changes[j]!;
			let touched = false;
			if (change.op === 'delete') {
				for (let k = 0; k < columns; k++) {
					const t = raw.timeAt(start + k);
					if (state[k] !== -2 && t >= change.from && t <= change.to) {
						state[k] = -2;
						touched = true;
					}
				}
			} else if (change.op === 'correct' && this._onGrid(change.data)) {
				const correction = change.data;
				const offsets = correction.offsets ?? null;
				for (let i = 0; i < correction.count; i++) {
					const k = at.get(correction.time[i]!);
					const offset = offsets === null ? 0 : offsets[i]!;
					if (
						k !== undefined &&
						state[k] !== -2 &&
						(i + 1) * rows <= correction.values.length &&
						Number.isInteger(offset)
					) {
						state[k] = i;
						by[k] = correction;
						touched = true;
					}
				}
			} else {
				// Appends and prepends add columns after the last and before the first.
				continue;
			}
			reached ||= touched;
			if (!reached) {
				// Up to here the changes leave the chunk as it went, which `restore` checks.
				continue;
			}
			const cells = this._changedCells(raw, start, columns, state, by, given, data);
			if (cells !== null) {
				const provisional: HeatProvisional = { chunk, summary: held.summary, cells };
				return provisional;
			}
		}
		return null;
	}

	/**
	 * The cells of a chunk's columns after changes leave them as `state` and `by` say (see `prepare`),
	 * when the columns `given` (by time) of `data` are those: null when they are not.
	 */
	private _changedCells(
		raw: HeatmapLevel,
		start: number,
		columns: number,
		state: Int32Array,
		by: readonly (HeatmapColumns | null)[],
		given: ReadonlyMap<number, number>,
		data: HeatmapColumns,
	): Float32Array | null {
		const rows = this._rows;
		const cells = new Float32Array(columns * rows);
		let present = 0;
		for (let k = 0; k < columns; k++) {
			const t = raw.timeAt(start + k);
			const i = given.get(t);
			const s = state[k]!;
			if (s === -2) {
				if (i !== undefined) {
					return null;
				}
				cells.fill(Number.NaN, k * rows, (k + 1) * rows);
				continue;
			}
			if (i === undefined) {
				return null;
			}
			present++;
			const offset = data.offsets == null ? 0 : data.offsets[i]!;
			if (s >= 0) {
				const correction = by[k]!;
				const want = correction.offsets == null ? 0 : correction.offsets[s]!;
				if (offset !== want) {
					return null;
				}
				for (let r = 0; r < rows; r++) {
					const value = data.values[i * rows + r]!;
					const expected = correction.values[s * rows + r]!;
					if (!(value === expected || (value !== value && expected !== expected))) {
						return null;
					}
				}
			} else if (offset !== raw.offsetAt(start + k)) {
				return null;
			}
			cells.set(data.values.subarray(i * rows, (i + 1) * rows), k * rows);
		}
		// No column at another time.
		return present === given.size ? cells : null;
	}

	/** Puts the cells `prepare` made into their chunk, unchecked: the waiting change runs next. */
	public commit(provisional: MarksProvisional): void {
		const raw = this._levels[0]!;
		const { chunk, cells } = provisional as HeatProvisional;
		const held = raw.chunkAt(chunk)!;
		if (held.summary !== null) {
			held.summary = null;
			held.cells = cells;
			raw.evicted--;
		}
	}

	/** Lets go again of a chunk `commit` put in, with the checksum it had. */
	public revert(provisional: MarksProvisional): void {
		const raw = this._levels[0]!;
		const { chunk, summary } = provisional as HeatProvisional;
		const held = raw.chunkAt(chunk);
		if (held !== undefined && held.summary === null) {
			held.summary = summary;
			held.cells = new Float32Array(0);
			raw.evicted++;
		}
	}

	/**
	 * Chunks let go that removing the columns of `[from, to]` would read, move or rebuild from: those
	 * on the shorter side of them, those beside the gap, and those the buckets around the gap and over
	 * the columns that move are made from where the levels between were let go (`_needsRebuild`).
	 */
	public needs(from: number, to: number, out: number[]): void {
		const raw = this._levels[0]!;
		if (this.evicted === 0 || !(from <= to) || raw.count === 0) {
			return;
		}
		const a = raw.lowerBound(from);
		const b = raw.upperBound(to);
		const removed = b - a;
		if (removed <= 0 || removed === raw.count) {
			return;
		}
		// The rebuild after the removal, in the indexes columns have then, and the columns that move.
		let first = raw.first;
		let end = raw.end;
		let lo: number;
		let hi: number;
		let moved: [number, number] | null = null;
		if (a === raw.first) {
			first = b;
			lo = b;
			hi = b + 1;
		} else if (b === raw.end) {
			end = a;
			lo = a - 1;
			hi = a;
		} else if (a - raw.first <= raw.end - b) {
			this.missing(0, raw.first, a, out);
			first = raw.first + removed;
			lo = first;
			hi = b + 1;
			moved = [first, b];
		} else {
			this.missing(0, b, raw.end, out);
			end = raw.end - removed;
			lo = a - 1;
			hi = end;
			moved = [a, end];
		}
		this.missing(0, a - 8, a, out);
		this.missing(0, b, b + 8, out);
		this._needsRebuild(Math.max(lo, first), Math.min(hi, end), first, end, moved, out);
	}

	/** Level-0 chunks let go that correcting existing columns of `data` reads or rebuilds from. */
	public needsCorrect(data: MarksData, _from: number | undefined, _to: number | undefined, out: number[]): void {
		const raw = this._levels[0]!;
		if (this.evicted === 0 || !this._onGrid(data) || raw.count === 0) {
			return;
		}
		const { time, values, count } = data;
		const rows = this._rows;
		const offsets = data.offsets ?? null;
		for (let i = 0; i < count; i++) {
			const t = time[i]!;
			const offset = offsets === null ? 0 : offsets[i]!;
			if (t - t !== 0 || (i + 1) * rows > values.length || !Number.isInteger(offset)) {
				continue;
			}
			const col = raw.lowerBound(t);
			if (col >= raw.end || raw.timeAt(col) !== t) {
				continue;
			}
			this.missing(0, col, col + 1, out);
			this._needsRebuild(col, col + 1, raw.first, raw.end, null, out);
		}
	}

	/**
	 * Level-0 chunks let go that `_rebuild(lo, hi)` reads after a change that leaves level 0 holding
	 * columns `[first, end)`, of which those of `moved` were written by the change (held): the members
	 * of the buckets it makes, in chunks held, where the levels between were let go (`_finest`). The
	 * indexes of the columns that did not move are those they have now.
	 */
	private _needsRebuild(
		lo: number,
		hi: number,
		first: number,
		end: number,
		moved: [number, number] | null,
		out: number[],
	): void {
		const levels = this._levels;
		const size = this._chunkColumns;
		const missing: number[] = [];
		let a = lo;
		let b = hi;
		let below = [first, end];
		for (let l = 1; l < levels.length; l++) {
			const level = levels[l]!;
			const lFirst = Math.floor(below[0]! / 4);
			const lEnd = Math.ceil(below[1]! / 4);
			below = [lFirst, lEnd];
			a = Math.max(lFirst, Math.floor(a / 4));
			b = Math.min(lEnd, Math.ceil(b / 4));
			if (b <= a) {
				return;
			}
			for (let bucket = a; bucket < b;) {
				const stop = Math.min(b, (Math.floor(bucket / size) + 1) * size);
				if (!level.isEvicted(Math.floor(bucket / size))) {
					for (let k = bucket; k < stop; k++) {
						this._needsBucket(l, k, first, end, moved, missing, out);
					}
				}
				bucket = stop;
			}
		}
	}

	/** Level-0 chunks let go that making bucket `k` of level `l` reads (see `_needsRebuild`). */
	private _needsBucket(
		l: number,
		k: number,
		first: number,
		end: number,
		moved: [number, number] | null,
		missing: number[],
		out: number[],
	): void {
		for (let m = l - 1; m >= 1; m--) {
			const below = this._levels[m]!;
			if (below.evicted === 0) {
				return;
			}
			const span = 4 ** (l - m);
			missing.length = 0;
			below.missing(k * span, k * span + span, missing);
			if (missing.length === 0) {
				return;
			}
		}
		const span = 4 ** l;
		const x = Math.max(first, k * span);
		const y = Math.min(end, k * span + span);
		if (moved === null || y <= moved[0] || x >= moved[1]) {
			this.missing(0, x, y, out);
			return;
		}
		this.missing(0, x, moved[0], out);
		this.missing(0, moved[1], y, out);
	}

	// A timeline made from the columns

	public bucketTimes(interval: number, from: number, to: number): number[] {
		const raw = this._levels[0]!;
		const times: number[] = [];
		const end = raw.lowerBound(to);
		let last = Number.NaN;
		for (let column = raw.lowerBound(from); column < end; column++) {
			const time = raw.timeAt(column);
			const start = interval > 0 ? Math.floor(time / interval) * interval : time;
			if (start !== last) {
				times.push(start);
				last = start;
			}
		}
		return times;
	}

	// Indicators over the columns

	public missingTimes(from: number, to: number, out: number[]): void {
		const raw = this._levels[0]!;
		if (raw.evicted > 0 && to > from) {
			// The column before the first time, which a bar without columns of its own reads.
			raw.missing(raw.lowerBound(from) - 1, raw.lowerBound(to), out);
		}
	}

	public aggregate(column: number, bounds: Float64Array, n: number, out: Float64Array, offset: number): void {
		const raw = this._levels[0]!;
		let a = raw.lowerBound(bounds[0]!);
		const missing: number[] = [];
		for (let k = 0; k < n; k++) {
			const low = bounds[k]!;
			const high = bounds[k + 1]!;
			if (!(low <= high)) {
				out[offset + k] = Number.NaN;
				if (high === high) {
					a = raw.lowerBound(high);
				}
				continue;
			}
			const b = raw.lowerBound(high);
			// The bar's columns, or the last one before it: the book as it stood.
			const from = b > a ? a : a - 1;
			missing.length = 0;
			raw.missing(from, b > a ? b : a, missing);
			out[offset + k] =
				from < raw.first || missing.length > 0 ? Number.NaN : this._aggregate(raw, column, from, Math.max(b, a));
			a = b;
		}
	}

	/** Column `column` (see `MARK_COLUMNS`) of held columns `[from, to)`, of which the last stands for the bar. */
	private _aggregate(raw: HeatmapLevel, column: number, from: number, to: number): number {
		if (column === MARK_COLUMNS.max || column === MARK_COLUMNS.min) {
			let max = -Infinity;
			let min = Infinity;
			for (let c = from; c < to; c++) {
				const cells = raw.cells(c);
				const at = raw.cellsAt(c);
				const end = at + raw.lengthAt(c);
				for (let i = at; i < end; i++) {
					const value = cells[i]!;
					if (value === value) {
						max = Math.max(max, value);
						min = Math.min(min, value);
					}
				}
			}
			if (!(max >= min)) {
				return Number.NaN;
			}
			return column === MARK_COLUMNS.max ? max : min;
		}
		const last = to - 1;
		const cells = raw.cells(last);
		const at = raw.cellsAt(last);
		const length = raw.lengthAt(last);
		const base = this._priceStart + (raw.offsetAt(last) + 0.5) * this._priceStep;
		let sum = 0;
		let weighted = 0;
		for (let r = 0; r < length; r++) {
			const value = cells[at + r]!;
			if (value === value) {
				sum += value;
				weighted += value * (base + r * this._priceStep);
			}
		}
		if (column === MARK_COLUMNS.sum) {
			return sum;
		}
		if (column === MARK_COLUMNS.center) {
			return sum !== 0 ? weighted / sum : Number.NaN;
		}
		return Number.NaN;
	}

	public first(level: number): number {
		return this._levels[level]?.first ?? 0;
	}

	public total(level: number): number {
		return this._levels[level]?.count ?? 0;
	}

	public changedFrom(level: number): number {
		return this._levels[level]?.changed ?? Infinity;
	}

	public clearChanges(): void {
		for (const level of this._levels) {
			level.changed = Infinity;
		}
	}

	/**
	 * The level a view draws from: the coarsest that still has a column per device pixel over the
	 * times asked for, and coarser ones while the cells are more than the client wants.
	 */
	public select(request: MarksRequest, minLevel = 0): MarksSelection {
		const raw = this._levels[0]!;
		// The column before the first time asked for reaches into it.
		const start = Math.max(raw.first, raw.upperBound(request.from) - 1);
		const end = Math.max(start, raw.upperBound(request.to));
		let level = Math.min(minLevel, this.levels);
		if (end > start && request.step > 0) {
			const from = Math.max(request.from, raw.timeAt(start));
			const to = Math.min(request.to, raw.timeAt(end - 1));
			const pixels = Math.max(1, (to - from) / request.step);
			while (level < this.levels && (end - start) / 4 ** (level + 1) >= pixels) {
				level++;
			}
		}
		while (level < this.levels && Math.ceil((end - start) / 4 ** level) * this._rows > request.limit) {
			level++;
		}
		const size = 4 ** level;
		const held = this._levels[level]!;
		const first = Math.max(held.first, Math.floor(start / size));
		return { level, start: first, end: Math.max(first, Math.min(held.end, Math.ceil(end / size))) };
	}

	public read(level: number, start: number, end: number, update: MarksUpdate): void {
		const source = this._levels[level];
		const rows = this._rows;
		const count = source === undefined ? 0 : Math.max(0, Math.min(end, source.end) - start);
		const varying = this._varying;
		update.level = level;
		update.start = start;
		update.count = count;
		update.first = source?.first ?? 0;
		update.total = source?.count ?? 0;
		update.timeStep = 0;
		update.priceStep = this._priceStep;
		update.priceStart = this._priceStart;
		update.rows = rows;
		update.valueMin = this._valueMin <= this._valueMax ? this._valueMin : Number.NaN;
		update.valueMax = this._valueMin <= this._valueMax ? this._valueMax : Number.NaN;
		update.time = new Float64Array(count);
		update.price = new Float64Array(0);
		update.counts = new Float32Array(0);
		update.sizes = new Float32Array(0);
		update.bounds = new Float64Array(0);
		update.offsets = new Int32Array(varying ? count : 0);
		update.lengths = new Int32Array(varying ? count : 0);
		let cells = 0;
		for (let i = 0; i < count; i++) {
			cells += varying ? source!.lengthAt(start + i) : rows;
		}
		update.values = new Float32Array(cells);
		let at = 0;
		for (let i = 0; i < count; i++) {
			const column = start + i;
			update.time[i] = source!.timeAt(column);
			const n = varying ? source!.lengthAt(column) : rows;
			if (varying) {
				update.offsets[i] = source!.offsetAt(column);
				update.lengths[i] = n;
			}
			const from = source!.cellsAt(column);
			update.values.set(source!.cells(column).subarray(from, from + n), at);
			at += n;
		}
	}
}
