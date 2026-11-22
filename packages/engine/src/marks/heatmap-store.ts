import type { HeatmapColumns, MarksData, MarksRequest, MarksSelection, MarksStore, MarksUpdate } from './protocol';

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
	/** Where the cells of each slot start; `start[size]` is the end of the last. */
	public readonly start: Int32Array;
	public cells: Float32Array;

	public constructor(size: number, rows: number) {
		this.time = new Float64Array(size);
		this.offset = new Int32Array(size);
		this.length = new Int32Array(size);
		this.start = new Int32Array(size + 1);
		this.cells = new Float32Array(size * rows);
	}

	public get used(): number {
		return this.start[this.start.length - 1]!;
	}

	/** Replaces the cells of slots `[from, to)` with `n` cells of `source` from `at` on. */
	public splice(from: number, to: number, source: Float32Array, at: number, n: number): void {
		const start = this.start;
		const a = start[from]!;
		const b = start[to]!;
		const delta = n - (b - a);
		const used = this.used;
		if (delta !== 0) {
			if (used + delta > this.cells.length) {
				const grown = new Float32Array(Math.max(used + delta, Math.ceil(this.cells.length * 1.5)));
				grown.set(this.cells.subarray(0, used));
				this.cells = grown;
			}
			this.cells.copyWithin(b + delta, b, used);
			for (let slot = to; slot < start.length; slot++) {
				start[slot] = start[slot]! + delta;
			}
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
		}
		return bytes;
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
			return;
		}
		this.first = first;
		this.end = end;
		const firstChunk = Math.floor(first / this._size);
		const lastChunk = Math.floor((end - 1) / this._size);
		if (lastChunk - this._base + 1 < chunks.length) {
			chunks.length = Math.max(0, lastChunk - this._base + 1);
		}
		if (firstChunk > this._base) {
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
	public select(request: MarksRequest): MarksSelection {
		const raw = this._levels[0]!;
		// The column before the first time asked for reaches into it.
		const start = Math.max(raw.first, raw.upperBound(request.from) - 1);
		const end = Math.max(start, raw.upperBound(request.to));
		let level = 0;
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
