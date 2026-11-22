import {
	type HeatmapColumns,
	MARK_COLUMNS,
	type MarksChunk,
	type MarksData,
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

	/** Lets go of the cells of chunk `n`, keeping their checksum; returns the bytes freed. */
	public evict(n: number): number {
		const chunk = this._chunks[n - this._base];
		if (chunk === undefined || chunk.summary !== null) {
			return 0;
		}
		const bytes = chunk.cells.byteLength;
		chunk.summary = chunk.checksum();
		chunk.cells = new Float32Array(0);
		this.evicted++;
		return bytes - MARKS_SUMMARY_BYTES;
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

	/** The chunk of a column held; its cells start at `cellsAt(column)` there. */
	public chunk(column: number): HeatChunk {
		return this._chunks[Math.floor(column / this._size) - this._base]!;
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
	 * take them in.
	 */
	public rewrite(from: number, to: number, make: (column: number, out: ColumnOut) => void): void {
		const out = this._out;
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
			for (let column = a - 1; column >= first; column--) {
				this._moveRaw(column, column + removed, rows);
			}
			raw.limit(first + removed, raw.end);
			lo = raw.first;
			hi = b + 1;
		} else {
			const end = raw.end;
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
		const source = raw.chunk(from);
		const at = raw.cellsAt(from);
		const cells = source.cells.slice(at, at + rows);
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
	 * one are made. Levels a shorter history no longer needs are let go.
	 */
	private *_rebuild(from: number, to: number): Generator<undefined, void, undefined> {
		const levels = this._levels;
		let cells = 0;
		let lo = from;
		let hi = to;
		for (let l = 1; ; l++) {
			const below = levels[l - 1]!;
			if (below.count <= HEATMAP_LEVEL_COLUMNS || l > MAX_LEVELS) {
				levels.length = l;
				return;
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
				into.rewrite(a, b, (bucket, out) => this._merge(below, into, bucket, out));
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

	/** Makes bucket `bucket` of `level` from its members on the level below. */
	private _merge(below: HeatmapLevel, level: HeatmapLevel, bucket: number, out: ColumnOut): void {
		const firstChild = Math.max(bucket * 4, below.first);
		const end = Math.min(bucket * 4 + 4, below.end);
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
			const source = below.chunk(child).cells;
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

	// Memory: under the engine's memory limit, the cells of chunks of columns far from the view are
	// let go and fetched back from the series' datafeed. The times and rows of every column, and the
	// levels, stay.

	/**
	 * Chunks of columns that may be let go, with the times they span: none of the first and last
	 * eight columns (appends and prepends rebuild the buckets there), none with columns in
	 * `[keepFrom, keepTo]`, and none before the series has a level to draw from in their place.
	 */
	public evictable(keepFrom: number, keepTo: number, out: MarksChunk[]): void {
		const raw = this._levels[0]!;
		if (this.levels === 0 || raw.count === 0) {
			return;
		}
		const first = Math.floor((raw.first + 8) / this._chunkColumns) + 1;
		const last = Math.floor((raw.end - 9) / this._chunkColumns) - 1;
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
			out.push({ chunk: n, from, to, bytes });
		}
	}

	private get _chunkColumns(): number {
		return Math.max(1, Math.floor(CHUNK_CELLS / this._rows));
	}

	public evict(chunk: number): number {
		return this._levels[0]!.evict(chunk);
	}

	public get evicted(): number {
		return this._levels[0]!.evicted;
	}

	/** Chunks let go that hold columns of level `level` rows `[start, end)`; none above level 0. */
	public missing(level: number, start: number, end: number, out: number[]): void {
		if (level === 0) {
			this._levels[0]!.missing(start, end, out);
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
	 * Chunks let go that removing the columns of `[from, to]` would read or move: those on the
	 * shorter side of them, and those of the buckets around the gap. Removing so many that no level
	 * is left needs every chunk: a level made again later is made from all columns.
	 */
	public needs(from: number, to: number, out: number[]): void {
		const raw = this._levels[0]!;
		if (raw.evicted === 0 || !(from <= to) || raw.count === 0) {
			return;
		}
		const a = raw.lowerBound(from);
		const b = raw.upperBound(to);
		if (b <= a) {
			return;
		}
		if (raw.count - (b - a) <= HEATMAP_LEVEL_COLUMNS) {
			raw.missing(raw.first, raw.end, out);
			return;
		}
		if (a > raw.first && b < raw.end) {
			if (a - raw.first <= raw.end - b) {
				raw.missing(raw.first, a, out);
			} else {
				raw.missing(b, raw.end, out);
			}
		}
		raw.missing(a - 8, a, out);
		raw.missing(b, b + 8, out);
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
				const cells = raw.chunk(c).cells;
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
		const cells = raw.chunk(last).cells;
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
			update.values.set(source!.chunk(column).cells.subarray(from, from + n), at);
			at += n;
		}
	}
}
