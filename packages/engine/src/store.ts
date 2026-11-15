import { CHUNK_MASK, CHUNK_ROWS, CHUNK_SHIFT, type Chunk, TIME, createChunk } from './chunk';

/**
 * Columnar store made of fixed-size chunks.
 *
 * Rows are addressed by a signed global index with a fixed origin: the first bar ever loaded is index 0,
 * and history prepended later gets negative indexes, so existing indexes never change.
 * Chunks sit on a fixed grid (`chunk = index >> CHUNK_SHIFT`), which makes lookup a shift and a mask
 * and keeps level-of-detail bucket boundaries (`floor(index / size)`) aligned with chunk boundaries.
 *
 * Column 0 is time and is strictly increasing. Bulk data is column-major: column `c` of `total` rows
 * occupies `data[c * total, (c + 1) * total)`.
 */
export class ChunkedStore {
	public readonly columnCount: number;
	private _chunks: Chunk[] = [];
	/** Grid number of `_chunks[0]`. */
	private _base = 0;
	private _first = 0;
	private _end = 0;

	public constructor(columnCount: number) {
		this.columnCount = columnCount;
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

	public clear(): void {
		this._chunks = [];
		this._base = 0;
		this._first = 0;
		this._end = 0;
	}

	public value(column: number, index: number): number {
		return this._chunks[(index >> CHUNK_SHIFT) - this._base]!.columns[column]![index & CHUNK_MASK]!;
	}

	public firstTime(): number {
		return this.value(TIME, this._first);
	}

	public lastTime(): number {
		return this.value(TIME, this._end - 1);
	}

	/** Chunk holding `index`; the row inside it is `index & CHUNK_MASK`. */
	public chunkAt(index: number): Chunk {
		return this._chunks[(index >> CHUNK_SHIFT) - this._base]!;
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
			const n = Math.min(CHUNK_ROWS - row, to - src);
			for (let c = 0; c < columnCount; c++) {
				const offset = c * total + src;
				chunk.columns[c]!.set(data.subarray(offset, offset + n), row);
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
				const offset = c * total + src - n;
				chunk.columns[c]!.set(data.subarray(offset, offset + n), row);
			}
			chunk.start = row;
			this._first -= n;
			src -= n;
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
		const columns = this._chunks[(index >> CHUNK_SHIFT) - this._base]!.columns;
		const r = index & CHUNK_MASK;
		for (let c = 0; c < columns.length; c++) {
			columns[c]![r] = row[offset + c]!;
		}
	}

	/** Copies rows `[from, to)` of one column into `dest` starting at `destOffset`. */
	public copyColumn(column: number, from: number, to: number, dest: Float64Array, destOffset: number): void {
		let index = from;
		let out = destOffset;
		while (index < to) {
			const row = index & CHUNK_MASK;
			const n = Math.min(CHUNK_ROWS - row, to - index);
			const source = this._chunks[(index >> CHUNK_SHIFT) - this._base]!.columns[column]!;
			dest.set(source.subarray(row, row + n), out);
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
		if (last.end < CHUNK_ROWS) {
			return last;
		}
		const chunk = createChunk(this.columnCount);
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
		const chunk = createChunk(this.columnCount);
		chunk.start = CHUNK_ROWS;
		chunk.end = CHUNK_ROWS;
		// A store holds at most a few thousand chunk references, so shifting them costs far less than the copy.
		chunks.unshift(chunk);
		this._base--;
		return chunk;
	}

	private _seed(): Chunk {
		const chunk = createChunk(this.columnCount);
		this._chunks.push(chunk);
		this._base = 0;
		this._first = 0;
		this._end = 0;
		return chunk;
	}
}
