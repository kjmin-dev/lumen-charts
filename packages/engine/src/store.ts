import { CHUNK_SHIFT, type Chunk, TIME, createChunk } from './chunk';

/** Below this many rows, columns are copied element by element: a typed-array view would cost more. */
const SMALL_COPY = 32;

/** Copies `n` values from `source[from...]` to `target[to...]`. */
function copy(target: Float64Array, to: number, source: Float64Array, from: number, n: number): void {
	if (n < SMALL_COPY) {
		for (let i = 0; i < n; i++) {
			target[to + i] = source[from + i]!;
		}
	} else {
		target.set(source.subarray(from, from + n), to);
	}
}

/**
 * Columnar store made of fixed-size chunks.
 *
 * Rows are addressed by a signed global index with a fixed origin: the first bar ever loaded is index 0,
 * and history prepended later gets negative indexes, so existing indexes never change.
 * Chunks sit on a fixed grid (`chunk = index >> shift`), which makes lookup a shift and a mask
 * and keeps level-of-detail bucket boundaries (`floor(index / size)`) aligned with chunk boundaries.
 *
 * Column 0 of a bar store is time and is strictly increasing. Bulk data is column-major: column `c`
 * of `total` rows occupies `data[c * total, (c + 1) * total)`.
 */
export class ChunkedStore {
	public readonly columnCount: number;
	/** Rows per chunk is `1 << shift`. */
	public readonly shift: number;
	public readonly rows: number;
	public readonly mask: number;
	private _chunks: Chunk[] = [];
	/** Grid number of `_chunks[0]`. */
	private _base = 0;
	private _first = 0;
	private _end = 0;
	/** Index the first row goes to while the store is empty. */
	private _origin = 0;
	private _bytes = 0;
	/** Chunks whose value columns were let go; only their time column is held. */
	private _evicted = 0;

	public constructor(columnCount: number, shift: number = CHUNK_SHIFT) {
		this.columnCount = columnCount;
		this.shift = shift;
		this.rows = 1 << shift;
		this.mask = this.rows - 1;
	}

	/** Global index of the first row. */
	public get first(): number {
		return this._first;
	}

	/** Global index one past the last row. */
	public get end(): number {
		return this._end;
	}

	public get length(): number {
		return this._end - this._first;
	}

	/** Bytes held by the chunks. */
	public get byteLength(): number {
		return this._bytes;
	}

	/** Bytes one chunk with every column takes. */
	public get chunkBytes(): number {
		return this.columnCount * this.rows * Float64Array.BYTES_PER_ELEMENT;
	}

	/** Number of chunks that hold only their time column. */
	public get evictedCount(): number {
		return this._evicted;
	}

	/** Grid number of the chunk holding `index`. */
	public gridOf(index: number): number {
		return index >> this.shift;
	}

	/** True when the chunk with grid number `grid` holds only its time column. */
	public isEvicted(grid: number): boolean {
		return this._chunks[grid - this._base]!.columns.length < this.columnCount;
	}

	/** Grid number of the first evicted chunk among rows `[from, to)`, or NaN if every one is held. */
	public firstEvicted(from: number, to: number): number {
		if (this._evicted === 0 || to <= from) {
			return NaN;
		}
		for (let grid = from >> this.shift, last = (to - 1) >> this.shift; grid <= last; grid++) {
			if (this.isEvicted(grid)) {
				return grid;
			}
		}
		return NaN;
	}

	/**
	 * Lets go of the value columns of one chunk and keeps its time column, so its rows can still be
	 * found by time and checked when they come back. Returns the bytes freed.
	 */
	public evict(grid: number): number {
		const slot = grid - this._base;
		const chunk = this._chunks[slot]!;
		if (chunk.columns.length < this.columnCount) {
			return 0;
		}
		const time = new Float64Array(this.rows);
		time.set(chunk.columns[TIME]!);
		this._chunks[slot] = { buffer: time.buffer, columns: [time], start: chunk.start, end: chunk.end };
		const freed = chunk.buffer.byteLength - time.buffer.byteLength;
		this._bytes -= freed;
		this._evicted++;
		return freed;
	}

	/**
	 * Gives an evicted chunk its value columns back from rows of column-major `data` (columns
	 * `total` long, time first), whose row `from` is the chunk's first row.
	 */
	public restore(grid: number, data: Float64Array, total: number, from: number): void {
		const slot = grid - this._base;
		const old = this._chunks[slot]!;
		if (old.columns.length === this.columnCount) {
			return;
		}
		const chunk = createChunk(this.columnCount, this.rows);
		chunk.start = old.start;
		chunk.end = old.end;
		chunk.columns[TIME]!.set(old.columns[TIME]!);
		const n = old.end - old.start;
		for (let c = 1; c < this.columnCount; c++) {
			copy(chunk.columns[c]!, old.start, data, c * total + from, n);
		}
		this._chunks[slot] = chunk;
		this._bytes += chunk.buffer.byteLength - old.buffer.byteLength;
		this._evicted--;
	}

	/** Drops every row. The next row appended or prepended gets index `origin`. */
	public clear(origin = 0): void {
		this._bytes = 0;
		this._evicted = 0;
		this._chunks = [];
		this._base = 0;
		this._origin = origin;
		this._first = origin;
		this._end = origin;
	}

	public value(column: number, index: number): number {
		return this._chunks[(index >> this.shift) - this._base]!.columns[column]![index & this.mask]!;
	}

	public firstTime(): number {
		return this.value(TIME, this._first);
	}

	public lastTime(): number {
		return this.value(TIME, this._end - 1);
	}

	/** Chunk holding `index`; the row inside it is `index & mask`. */
	public chunkAt(index: number): Chunk {
		return this._chunks[(index >> this.shift) - this._base]!;
	}

	/**
	 * Appends rows `[from, to)` of column-major `data` (whose columns are `total` long).
	 * The caller guarantees that times continue the strictly increasing order.
	 */
	public append(data: Float64Array, total: number, from: number, to: number): void {
		const columnCount = this.columnCount;
		let src = from;
		while (src < to) {
			const chunk = this._tailChunk();
			const row = chunk.end;
			const n = Math.min(this.rows - row, to - src);
			for (let c = 0; c < columnCount; c++) {
				copy(chunk.columns[c]!, row, data, c * total + src, n);
			}
			chunk.end = row + n;
			this._end += n;
			src += n;
		}
	}

	/**
	 * Prepends rows `[from, to)` of column-major `data` directly before the first row.
	 * To prepend a large block in slices, pass the slices from last to first.
	 */
	public prepend(data: Float64Array, total: number, from: number, to: number): void {
		const columnCount = this.columnCount;
		let src = to;
		while (src > from) {
			const chunk = this._headChunk();
			const n = Math.min(chunk.start, src - from);
			const row = chunk.start - n;
			for (let c = 0; c < columnCount; c++) {
				copy(chunk.columns[c]!, row, data, c * total + src - n, n);
			}
			chunk.start = row;
			this._first -= n;
			src -= n;
		}
	}

	/** Overwrites existing rows `[index, index + to - from)` with rows `[from, to)` of column-major `data`. */
	public write(data: Float64Array, total: number, from: number, to: number, index: number): void {
		const columnCount = this.columnCount;
		let src = from;
		let target = index;
		while (src < to) {
			const columns = this._chunks[(target >> this.shift) - this._base]!.columns;
			const row = target & this.mask;
			const n = Math.min(this.rows - row, to - src);
			for (let c = 0; c < columnCount; c++) {
				copy(columns[c]!, row, data, c * total + src, n);
			}
			src += n;
			target += n;
		}
	}

	/** Appends one row read from `row[offset, offset + columnCount)`. */
	public appendRow(row: Float64Array, offset: number): void {
		const chunk = this._tailChunk();
		const r = chunk.end;
		const columns = chunk.columns;
		for (let c = 0; c < columns.length; c++) {
			columns[c]![r] = row[offset + c]!;
		}
		chunk.end = r + 1;
		this._end++;
	}

	/** Overwrites the row at `index` with `row[offset, offset + columnCount)`. */
	public writeRow(index: number, row: Float64Array, offset: number): void {
		const columns = this._chunks[(index >> this.shift) - this._base]!.columns;
		const r = index & this.mask;
		for (let c = 0; c < columns.length; c++) {
			columns[c]![r] = row[offset + c]!;
		}
	}

	/** Copies rows `[from, to)` of one column into `dest` starting at `destOffset`. */
	public copyColumn(column: number, from: number, to: number, dest: Float64Array, destOffset: number): void {
		let index = from;
		let out = destOffset;
		while (index < to) {
			const row = index & this.mask;
			const n = Math.min(this.rows - row, to - index);
			copy(dest, out, this._chunks[(index >> this.shift) - this._base]!.columns[column]!, row, n);
			index += n;
			out += n;
		}
	}

	/** Index of the first row whose time is not less than `time`; `end` if there is none. */
	public lowerBound(time: number): number {
		let lo = this._first;
		let hi = this._end;
		while (lo < hi) {
			const mid = lo + ((hi - lo) >> 1);
			if (this.value(TIME, mid) < time) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		return lo;
	}

	/** Chunk with free rows after the last row, linking a new one when the tail is full. */
	private _tailChunk(): Chunk {
		const chunks = this._chunks;
		if (chunks.length === 0) {
			return this._seed();
		}
		const last = chunks[chunks.length - 1]!;
		if (last.end < this.rows) {
			return last;
		}
		const chunk = createChunk(this.columnCount, this.rows);
		this._bytes += chunk.buffer.byteLength;
		chunks.push(chunk);
		return chunk;
	}

	/** Chunk with free rows before the first row, linking a new one when the head is full. */
	private _headChunk(): Chunk {
		const chunks = this._chunks;
		if (chunks.length === 0) {
			this._seed();
		}
		const head = chunks[0]!;
		if (head.start > 0) {
			return head;
		}
		const chunk = createChunk(this.columnCount, this.rows);
		this._bytes += chunk.buffer.byteLength;
		chunk.start = this.rows;
		chunk.end = this.rows;
		// A store holds at most a few thousand chunk references, so shifting them costs far less than the copy.
		chunks.unshift(chunk);
		this._base--;
		return chunk;
	}

	/** Links the first chunk, placed on the grid so that its next free row is the origin. */
	private _seed(): Chunk {
		const chunk = createChunk(this.columnCount, this.rows);
		this._bytes += chunk.buffer.byteLength;
		const origin = this._origin;
		const row = origin & this.mask;
		chunk.start = row;
		chunk.end = row;
		this._chunks.push(chunk);
		this._base = origin >> this.shift;
		this._first = origin;
		this._end = origin;
		return chunk;
	}
}
