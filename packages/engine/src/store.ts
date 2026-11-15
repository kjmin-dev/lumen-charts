import { CHUNK_SHIFT, type Chunk, type ChunkSummary, TIME, createChunk } from './chunk';

/** Below this many rows, columns are copied element by element: a typed-array view would cost more. */
const SMALL_COPY = 32;

/**
 * Bytes a chunk let go of entirely is counted as: its summary and the object holding it. The
 * real cost depends on the JavaScript engine; this is a round upper estimate.
 */
export const SUMMARY_BYTES = 128;

/** A chunk let go of may keep the time of every row whose index is a multiple of `1 << ANCHOR_SHIFT`. */
export const ANCHOR_SHIFT = 4;

const NO_BUFFER = new ArrayBuffer(0);
const NO_COLUMNS: readonly Float64Array[] = [];

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

// Checksums. Two lanes of MurmurHash3 (x86, 32 bits) over the bit patterns of the times give a
// 64-bit checksum; one lane over the values tells whether bars that come back differ from the ones
// let go. Not cryptographic: they catch a datafeed that answers with other bars, not an attacker.

const SEED_A = 0x2545f491;
const SEED_B = 0x9e3779b9;

function round(h: number, k: number): number {
	let x = Math.imul(k, 0xcc9e2d51);
	x = (x << 15) | (x >>> 17);
	x = Math.imul(x, 0x1b873593);
	const y = h ^ x;
	return (Math.imul((y << 13) | (y >>> 19), 5) + 0xe6546b64) | 0;
}

function finish(h: number, length: number): number {
	let x = h ^ length;
	x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
	x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
	return (x ^ (x >>> 16)) >>> 0;
}

/**
 * Feeds `n` doubles to a hash, read as pairs of 32-bit words starting at word `at` of `words`.
 * `swap` feeds the high word of each double first, which makes a second, independent lane.
 */
function feed(h: number, words: Uint32Array, at: number, n: number, swap: boolean): number {
	let x = h;
	const end = at + 2 * n;
	if (swap) {
		for (let w = at; w < end; w += 2) {
			x = round(round(x, words[w + 1]!), words[w]!);
		}
	} else {
		for (let w = at; w < end; w += 2) {
			x = round(round(x, words[w]!), words[w + 1]!);
		}
	}
	return x;
}

/** 32-bit words of a column-major block (columns `total` doubles long), shared by the checksums. */
function wordsOf(data: Float64Array): Uint32Array {
	return new Uint32Array(data.buffer, data.byteOffset, data.length * 2);
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
 *
 * Under a memory limit a chunk can be let go of in two steps. Without its values it keeps its time
 * column; without its time column too it keeps only a summary (first and last time, a checksum of
 * the times and one of the values). Rows of such a chunk must not be read until it is restored.
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
	/** Chunks whose value columns were let go. */
	private _evicted = 0;
	/** Of those, chunks whose time column was let go too. */
	private _timeless = 0;

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

	/** Bytes held by the chunks, summaries of chunks let go included. */
	public get byteLength(): number {
		return this._bytes;
	}

	/** Bytes one chunk with every column takes. */
	public get chunkBytes(): number {
		return this.columnCount * this.rows * Float64Array.BYTES_PER_ELEMENT;
	}

	/** Bytes the time column of one chunk takes. */
	public get timeBytes(): number {
		return this.rows * Float64Array.BYTES_PER_ELEMENT;
	}

	/** Number of chunks whose values were let go. */
	public get evictedCount(): number {
		return this._evicted;
	}

	/** Number of chunks whose time column was let go too. */
	public get timelessCount(): number {
		return this._timeless;
	}

	/** Grid number of the first and the last chunk; `firstGrid > lastGrid` while the store is empty. */
	public get firstGrid(): number {
		return this._base;
	}

	public get lastGrid(): number {
		return this._base + this._chunks.length - 1;
	}

	/** Grid number of the chunk holding `index`. */
	public gridOf(index: number): number {
		return index >> this.shift;
	}

	/** True when the values of the chunk with grid number `grid` were let go. */
	public isEvicted(grid: number): boolean {
		return this._chunks[grid - this._base]!.columns.length < this.columnCount;
	}

	/** True when the chunk with grid number `grid` still has its time column. */
	public hasTime(grid: number): boolean {
		return this._chunks[grid - this._base]!.columns.length > 0;
	}

	/** Time of the first row of a chunk, also when it was let go. */
	public chunkFirstTime(grid: number): number {
		const chunk = this._chunks[grid - this._base]!;
		return chunk.columns.length > 0 ? chunk.columns[TIME]![chunk.start]! : chunk.summary!.firstTime;
	}

	/** Time of the last row of a chunk, also when it was let go. */
	public chunkLastTime(grid: number): number {
		const chunk = this._chunks[grid - this._base]!;
		return chunk.columns.length > 0 ? chunk.columns[TIME]![chunk.end - 1]! : chunk.summary!.lastTime;
	}

	/** Grid number of the first chunk among rows `[from, to)` whose values were let go, or NaN. */
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
	 * Lets go of the values of one chunk, and of its time column too unless `keepTime`. Its summary
	 * is taken first, so rows that come back can be checked against the ones let go; with `anchors`
	 * it keeps the time of every 16th row too (see `anchors`). Returns the bytes freed.
	 */
	public evict(grid: number, keepTime = true, anchors = false): number {
		const slot = grid - this._base;
		const chunk = this._chunks[slot]!;
		const held = chunk.columns.length;
		if (held === 0 || (keepTime && held === 1)) {
			return 0;
		}
		let summary = chunk.summary ?? this._summarize(chunk);
		if (!keepTime && anchors && summary.anchors === undefined) {
			summary = { ...summary, anchors: this._anchors(grid, chunk) };
		}
		const before = bytesOf(chunk);
		let next: Chunk;
		if (keepTime) {
			const time = new Float64Array(this.rows);
			time.set(chunk.columns[TIME]!);
			next = { buffer: time.buffer, columns: [time], start: chunk.start, end: chunk.end, summary };
		} else {
			next = { buffer: NO_BUFFER, columns: NO_COLUMNS, start: chunk.start, end: chunk.end, summary };
			this._timeless++;
		}
		if (held === this.columnCount) {
			this._evicted++;
		}
		this._chunks[slot] = next;
		const after = bytesOf(next);
		this._bytes -= before - after;
		return before - after;
	}

	/**
	 * Times a chunk let go of kept of the rows whose index is a multiple of `1 << ANCHOR_SHIFT`, the
	 * first of them at `firstAnchor(grid)`; null when it kept none.
	 */
	public anchors(grid: number): Float64Array | null {
		return this._chunks[grid - this._base]!.summary?.anchors ?? null;
	}

	/** Index of the first row of a chunk whose index is a multiple of `1 << ANCHOR_SHIFT`. */
	public firstAnchor(grid: number): number {
		const chunk = this._chunks[grid - this._base]!;
		const size = 1 << ANCHOR_SHIFT;
		return (((grid << this.shift) + chunk.start + size - 1) >> ANCHOR_SHIFT) << ANCHOR_SHIFT;
	}

	/**
	 * True when rows `[from, from + n)` of column-major `data` (columns `total` long, time first) have
	 * exactly the times of the chunk let go with grid number `grid`: as many rows, and the same times
	 * bar by bar while its time column is held, or else the same first and last time and checksum.
	 */
	public matches(grid: number, data: Float64Array, total: number, from: number, n: number): boolean {
		const chunk = this._chunks[grid - this._base]!;
		if (n !== chunk.end - chunk.start) {
			return false;
		}
		if (chunk.columns.length > 0) {
			const time = chunk.columns[TIME]!;
			const offset = from - chunk.start;
			for (let r = chunk.start; r < chunk.end; r++) {
				if (time[r] !== data[offset + r]) {
					return false;
				}
			}
			return true;
		}
		const summary = chunk.summary!;
		if (data[from] !== summary.firstTime || data[from + n - 1] !== summary.lastTime) {
			return false;
		}
		const anchors = summary.anchors;
		if (anchors !== undefined) {
			const offset = this.firstAnchor(grid) - ((grid << this.shift) + chunk.start);
			for (let k = 0; k < anchors.length; k++) {
				if (data[from + offset + (k << ANCHOR_SHIFT)] !== anchors[k]) {
					return false;
				}
			}
		}
		const words = wordsOf(data);
		return (
			finish(feed(SEED_A, words, 2 * from, n, false), n) === summary.timeHash &&
			finish(feed(SEED_B, words, 2 * from, n, true), n) === summary.timeHash2
		);
	}

	/**
	 * Gives an evicted chunk its columns back from rows of column-major `data` (columns `total` long,
	 * time first), whose row `from` is the chunk's first row; `matches` must have accepted them.
	 * Returns true when the values differ from the ones let go.
	 */
	public restore(grid: number, data: Float64Array, total: number, from: number): boolean {
		const slot = grid - this._base;
		const old = this._chunks[slot]!;
		if (old.columns.length === this.columnCount) {
			return false;
		}
		const n = old.end - old.start;
		const chunk = createChunk(this.columnCount, this.rows);
		chunk.start = old.start;
		chunk.end = old.end;
		for (let c = 0; c < this.columnCount; c++) {
			copy(chunk.columns[c]!, old.start, data, c * total + from, n);
		}
		const changed = valueHash(chunk, this.rows, this.columnCount) !== old.summary!.valueHash;
		this._chunks[slot] = chunk;
		this._bytes += chunk.buffer.byteLength - bytesOf(old);
		this._evicted--;
		if (old.columns.length === 0) {
			this._timeless--;
		}
		return changed;
	}

	/** Drops every row. The next row appended or prepended gets index `origin`. */
	public clear(origin = 0): void {
		this._bytes = 0;
		this._evicted = 0;
		this._timeless = 0;
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

	/**
	 * Index of the first row whose time is not less than `time`; `end` if there is none. NaN when
	 * the answer lies inside a chunk whose time column was let go: the chunk's first and last time
	 * place a time before, inside or after it, but not which of its rows it falls on.
	 */
	public lowerBound(time: number): number {
		return this._search(time, false);
	}

	/** Index of the first row whose time is greater than `time`; `end` if there is none. NaN as in `lowerBound`. */
	public upperBound(time: number): number {
		return this._search(time, true);
	}

	/**
	 * Grid number of the chunk whose first and last time enclose `time`, or NaN when `time` falls
	 * before the first row, after the last one or between two chunks: then no row has that time.
	 */
	public chunkOf(time: number): number {
		const grid = this.chunkAtOrAfter(time);
		return grid <= this.lastGrid && this.chunkFirstTime(grid) <= time ? grid : NaN;
	}

	/** Grid number of the first chunk whose last time is at least `time`; `lastGrid + 1` if there is none. */
	public chunkAtOrAfter(time: number): number {
		return this._base + this._slotAtOrAfter(time, false);
	}

	/**
	 * Time of the row at `index`, also when it is the first row of a chunk let go; NaN for any other
	 * row of a chunk whose time column was let go.
	 */
	public timeAt(index: number): number {
		const chunk = this._chunks[(index >> this.shift) - this._base]!;
		if (chunk.columns.length > 0) {
			return chunk.columns[TIME]![index & this.mask]!;
		}
		return (index & this.mask) === chunk.start ? chunk.summary!.firstTime : NaN;
	}

	/**
	 * Keeps only rows `[first, end)`, dropping the chunks outside. The chunks that end up holding the
	 * new first and last row must be held, since their row ranges change.
	 */
	public truncate(first: number, end: number): void {
		if (end <= first) {
			this.clear(first);
			return;
		}
		const firstGrid = first >> this.shift;
		const lastGrid = (end - 1) >> this.shift;
		const chunks = this._chunks;
		let from = firstGrid - this._base;
		let to = lastGrid - this._base + 1;
		for (let slot = 0; slot < chunks.length; slot++) {
			if (slot < from || slot >= to) {
				this._drop(chunks[slot]!);
			}
		}
		from = Math.max(0, from);
		to = Math.min(chunks.length, to);
		this._chunks = chunks.slice(from, to);
		this._base += from;
		this._chunks[0]!.start = Math.max(this._chunks[0]!.start, first & this.mask);
		const tail = this._chunks[this._chunks.length - 1]!;
		tail.end = Math.min(tail.end, ((end - 1) & this.mask) + 1);
		this._first = first;
		this._end = end;
	}

	/**
	 * Removes rows `[from, to)` from the middle by moving one side next to the other: the rows before
	 * `from` move up when `moveHead`, else the rows from `to` on move down. Every chunk the moving
	 * rows pass through must be held. Indexes of the moved rows change by `to - from`.
	 */
	public removeRows(from: number, to: number, moveHead: boolean): void {
		const n = to - from;
		if (n <= 0) {
			return;
		}
		if (moveHead) {
			this._move(this._first, this._first + n, from - this._first);
			this.truncate(this._first + n, this._end);
		} else {
			this._move(to, from, this._end - to);
			this.truncate(this._first, this._end - n);
		}
	}

	/** Moves `n` rows from `src` to `dst` (overlapping ranges included), chunk piece by chunk piece. */
	private _move(src: number, dst: number, n: number): void {
		const columnCount = this.columnCount;
		const rows = this.rows;
		// Rows that move up are moved last first, so none is overwritten before it has moved.
		const up = dst > src;
		let left = n;
		while (left > 0) {
			let piece: number;
			let s: number;
			let d: number;
			if (up) {
				const srcEnd = src + left;
				const dstEnd = dst + left;
				piece = Math.min(left, ((srcEnd - 1) & this.mask) + 1, ((dstEnd - 1) & this.mask) + 1);
				s = srcEnd - piece;
				d = dstEnd - piece;
			} else {
				s = src + n - left;
				d = dst + n - left;
				piece = Math.min(left, rows - (s & this.mask), rows - (d & this.mask));
			}
			const from = this._chunks[(s >> this.shift) - this._base]!;
			const into = this._chunks[(d >> this.shift) - this._base]!;
			const sr = s & this.mask;
			const dr = d & this.mask;
			for (let c = 0; c < columnCount; c++) {
				const target = into.columns[c]!;
				if (from === into) {
					target.copyWithin(dr, sr, sr + piece);
				} else {
					target.set(from.columns[c]!.subarray(sr, sr + piece), dr);
				}
			}
			if (dr < into.start) {
				into.start = dr;
			}
			if (dr + piece > into.end) {
				into.end = dr + piece;
			}
			left -= piece;
		}
	}

	/** Forgets a chunk's bytes and counts. */
	private _drop(chunk: Chunk): void {
		this._bytes -= bytesOf(chunk);
		if (chunk.columns.length < this.columnCount) {
			this._evicted--;
			if (chunk.columns.length === 0) {
				this._timeless--;
			}
		}
	}

	private _anchors(grid: number, chunk: Chunk): Float64Array {
		const time = chunk.columns[TIME]!;
		const base = grid << this.shift;
		const first = this.firstAnchor(grid) - base;
		const out = new Float64Array(Math.max(0, ((chunk.end - first - 1) >> ANCHOR_SHIFT) + 1));
		for (let k = 0; k < out.length; k++) {
			out[k] = time[first + (k << ANCHOR_SHIFT)]!;
		}
		return out;
	}

	private _summarize(chunk: Chunk): ChunkSummary {
		const n = chunk.end - chunk.start;
		const words = new Uint32Array(chunk.buffer);
		const time = chunk.columns[TIME]!;
		return {
			firstTime: time[chunk.start]!,
			lastTime: time[chunk.end - 1]!,
			timeHash: finish(feed(SEED_A, words, 2 * chunk.start, n, false), n),
			timeHash2: finish(feed(SEED_B, words, 2 * chunk.start, n, true), n),
			valueHash: valueHash(chunk, this.rows, this.columnCount),
		};
	}

	/** First chunk slot whose last time is at least `time` (more than `time` when `after`). */
	private _slotAtOrAfter(time: number, after: boolean): number {
		const chunks = this._chunks;
		let lo = 0;
		let hi = chunks.length;
		while (lo < hi) {
			const mid = lo + ((hi - lo) >> 1);
			const chunk = chunks[mid]!;
			const last = chunk.columns.length > 0 ? chunk.columns[TIME]![chunk.end - 1]! : chunk.summary!.lastTime;
			if (after ? last <= time : last < time) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		return lo;
	}

	private _search(time: number, after: boolean): number {
		if (this._timeless === 0) {
			let lo = this._first;
			let hi = this._end;
			while (lo < hi) {
				const mid = lo + ((hi - lo) >> 1);
				const value = this.value(TIME, mid);
				if (after ? value <= time : value < time) {
					lo = mid + 1;
				} else {
					hi = mid;
				}
			}
			return lo;
		}
		// Chunk by chunk first, by their last times: they are known even for chunks let go.
		const slot = this._slotAtOrAfter(time, after);
		if (slot === this._chunks.length) {
			return this._end;
		}
		const chunk = this._chunks[slot]!;
		const base = (this._base + slot) << this.shift;
		if (chunk.columns.length === 0) {
			const first = chunk.summary!.firstTime;
			return (after ? time < first : time <= first) ? base + chunk.start : NaN;
		}
		const column = chunk.columns[TIME]!;
		let lo = chunk.start;
		let hi = chunk.end;
		while (lo < hi) {
			const mid = lo + ((hi - lo) >> 1);
			const value = column[mid]!;
			if (after ? value <= time : value < time) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		return base + lo;
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

/** Bytes a chunk takes: its buffer, and for one let go of entirely its summary. */
function bytesOf(chunk: Chunk): number {
	return (
		chunk.buffer.byteLength +
		(chunk.columns.length === 0 ? SUMMARY_BYTES + (chunk.summary!.anchors?.byteLength ?? 0) : 0)
	);
}

/** Checksum of the value columns of a held chunk's rows. */
function valueHash(chunk: Chunk, rows: number, columnCount: number): number {
	const words = new Uint32Array(chunk.buffer);
	const n = chunk.end - chunk.start;
	let h = SEED_A;
	for (let c = 1; c < columnCount; c++) {
		h = feed(h, words, 2 * (c * rows + chunk.start), n, false);
	}
	return finish(h, n * (columnCount - 1));
}
