import {
	MARK_COLUMNS,
	type MarksChunk,
	type MarksData,
	type MarksRequest,
	type MarksSelection,
	type MarksStore,
	type MarksUpdate,
} from './protocol';
import { Checksum, MARKS_SUMMARY_BYTES } from './summary';

/** Rows per chunk of a scatter column store. */
export const SCATTER_CHUNK_SHIFT = 16;
const CHUNK_ROWS = 1 << SCATTER_CHUNK_SHIFT;
const CHUNK_MASK = CHUNK_ROWS - 1;

/** Points a scatter series holds before it gets levels of detail. */
export const SCATTER_LEVEL_THRESHOLD = 65_536;
/** A level gets a coarser one above it while it has more cells than this. */
export const SCATTER_LEVEL_ROWS = 16_384;
/** Points per time bucket of level 1, on average, when the levels are made. */
const POINTS_PER_BUCKET = 64;
/** Price bins the levels divide the price range into, when they are made. */
export const SCATTER_PRICE_BINS = 4096;
const MAX_LEVELS = 12;
/** Points between two yields of a bulk operation. */
const SLICE = 32_768;
/** A level is kept when it has at most this share of the rows it was built from. */
const MERGE_RATIO = 0.75;

interface ScatterChunk {
	time: Float64Array;
	price: Float64Array;
	value: Float32Array;
	/** Points per row; null in a store of points, where every row is one. */
	count: Float32Array | null;
	/** Size of each row's mark in CSS pixels, NaN for the series' size; null while no row has one. */
	size: Float32Array | null;
	/** Exact point bounds `[tMin, tMax, pMin, pMax]` per coarse cell; null in a store of points. */
	tMin: Float64Array | null;
	tMax: Float64Array | null;
	pMin: Float64Array | null;
	pMax: Float64Array | null;
	/** Set while the chunk is let go under the memory limit: what checks the rows that come back. */
	summary: ScatterSummary | null;
}

/**
 * What is kept of a chunk of points let go: its number of points, the first and last time, how many
 * of its points share each of those times (points at one time may lie in two chunks), and a
 * checksum of every point.
 */
interface ScatterSummary {
	count: number;
	/** Whether the checksum takes the sizes in: the store had sizes when the chunk was let go. */
	sized: boolean;
	firstTime: number;
	lastTime: number;
	headTies: number;
	tailTies: number;
	high: number;
	low: number;
}

const NO_TIME = new Float64Array(0);
const NO_VALUE = new Float32Array(0);

/**
 * Time, price and value of points or cells in time order, in chunks so growing at either end never
 * copies. Rows are `[first, end)`: indexes are signed, and stay put when rows are added in front.
 * Cells of a level also count the points they hold; a store whose points have sizes keeps those.
 */
export class ScatterColumns {
	public first = 0;
	public end = 0;
	private readonly _chunks: ScatterChunk[] = [];
	/** Chunk number (`row >> SCATTER_CHUNK_SHIFT`) of `_chunks[0]`. */
	private _base = 0;
	private readonly _counted: boolean;
	private _sized = false;
	/** Chunks let go under the memory limit. */
	private _evicted = 0;

	public constructor(counted = false) {
		this._counted = counted;
	}

	public get count(): number {
		return this.end - this.first;
	}

	/** Whether rows have a size of their own. */
	public get sized(): boolean {
		return this._sized;
	}

	public get counted(): boolean {
		return this._counted;
	}

	public get byteLength(): number {
		const resident = this._chunks.length - this._evicted;
		return (
			resident * CHUNK_ROWS * (20 + (this._counted ? 36 : 0) + (this._sized ? 4 : 0)) +
			this._evicted * MARKS_SUMMARY_BYTES
		);
	}

	/** Bytes of one chunk held, which letting it go frees but for its summary. */
	public get chunkBytes(): number {
		return CHUNK_ROWS * (20 + (this._counted ? 36 : 0) + (this._sized ? 4 : 0)) - MARKS_SUMMARY_BYTES;
	}

	public clear(): void {
		this.first = 0;
		this.end = 0;
		this._chunks.length = 0;
		this._base = 0;
		this._sized = false;
		this._evicted = 0;
	}

	/** Chunks let go under the memory limit. */
	public get evictedCount(): number {
		return this._evicted;
	}

	/** Numbers of the first and last chunk holding rows (`row >> SCATTER_CHUNK_SHIFT`). */
	public get firstChunk(): number {
		return this.first >> SCATTER_CHUNK_SHIFT;
	}

	public get lastChunk(): number {
		return (this.end - 1) >> SCATTER_CHUNK_SHIFT;
	}

	/** Rows of chunk `n`: `[chunkStart(n), chunkEnd(n))`. */
	public chunkStart(n: number): number {
		return Math.max(this.first, n << SCATTER_CHUNK_SHIFT);
	}

	public chunkEnd(n: number): number {
		return Math.min(this.end, (n + 1) << SCATTER_CHUNK_SHIFT);
	}

	public isEvicted(n: number): boolean {
		return this._chunks[n - this._base]?.summary != null;
	}

	public chunkFirstTime(n: number): number {
		const chunk = this._chunks[n - this._base]!;
		return chunk.summary === null ? this.timeAt(this.chunkStart(n)) : chunk.summary.firstTime;
	}

	public chunkLastTime(n: number): number {
		const chunk = this._chunks[n - this._base]!;
		return chunk.summary === null ? this.timeAt(this.chunkEnd(n) - 1) : chunk.summary.lastTime;
	}

	/** Chunks let go that hold rows of `[from, to)`. */
	public missing(from: number, to: number, out: number[]): void {
		if (this._evicted === 0 || to <= from) {
			return;
		}
		const last = (Math.min(to, this.end) - 1) >> SCATTER_CHUNK_SHIFT;
		for (let n = Math.max(from, this.first) >> SCATTER_CHUNK_SHIFT; n <= last; n++) {
			if (this.isEvicted(n)) {
				out.push(n);
			}
		}
	}

	/** The summary of chunk `n` as it holds its rows now. */
	private _summarize(n: number): ScatterSummary {
		const from = this.chunkStart(n);
		const to = this.chunkEnd(n);
		const checksum = new Checksum();
		for (let row = from; row < to; row++) {
			feedPoint(checksum, this.timeAt(row), this.priceAt(row), this.valueAt(row), this.sizeAt(row), this._sized);
		}
		const firstTime = this.timeAt(from);
		const lastTime = this.timeAt(to - 1);
		let headTies = 1;
		while (from + headTies < to && this.timeAt(from + headTies) === firstTime) {
			headTies++;
		}
		let tailTies = 1;
		while (to - 1 - tailTies >= from && this.timeAt(to - 1 - tailTies) === lastTime) {
			tailTies++;
		}
		return {
			count: to - from,
			sized: this._sized,
			firstTime,
			lastTime,
			headTies,
			tailTies,
			high: checksum.high,
			low: checksum.low,
		};
	}

	/**
	 * Lets go of the rows of chunk `n`, keeping its summary; returns the bytes freed. A chunk whose
	 * points all share one time is kept: the points of that time in the chunks beside it could not
	 * be told from its own when they come back.
	 */
	public evict(n: number): number {
		const chunk = this._chunks[n - this._base];
		if (chunk === undefined || chunk.summary !== null) {
			return 0;
		}
		const summary = this._summarize(n);
		if (!(summary.firstTime < summary.lastTime)) {
			return 0;
		}
		chunk.summary = summary;
		chunk.time = NO_TIME;
		chunk.price = NO_TIME;
		chunk.value = NO_VALUE;
		chunk.count = null;
		chunk.size = null;
		chunk.tMin = null;
		chunk.tMax = null;
		chunk.pMin = null;
		chunk.pMax = null;
		this._evicted++;
		return this.chunkBytes;
	}

	/**
	 * What a datafeed must return for chunk `n` to come back: the points with times in
	 * `[firstTime, lastTime]`, of which the chunk holds the last `headTies` at the first time and the
	 * first `tailTies` at the last.
	 */
	public summaryOf(n: number): Readonly<ScatterSummary> | null {
		return this._chunks[n - this._base]?.summary ?? null;
	}

	/**
	 * Gives chunk `n` its rows back from points `[from, from + count)` of the arrays, if they are the
	 * points it was let go with: the same number, times, prices, values and sizes. Returns whether
	 * they were taken.
	 */
	public restore(
		n: number,
		time: Float64Array,
		price: Float64Array,
		value: Float32Array | null,
		size: Float32Array | null,
		from: number,
		count: number,
	): boolean {
		const chunk = this._chunks[n - this._base];
		const summary = chunk?.summary ?? null;
		if (chunk === undefined || summary === null || count !== summary.count) {
			return false;
		}
		const checksum = new Checksum();
		for (let i = from; i < from + count; i++) {
			feedPoint(
				checksum,
				time[i]!,
				price[i]!,
				value === null ? Number.NaN : value[i]!,
				size === null ? Number.NaN : size[i]!,
				summary.sized,
			);
		}
		if (checksum.high !== summary.high || checksum.low !== summary.low) {
			return false;
		}
		// The first write gives the chunk its arrays back.
		const start = this.chunkStart(n);
		for (let i = 0; i < count; i++) {
			this.write(
				start + i,
				time[from + i]!,
				price[from + i]!,
				value === null ? Number.NaN : value[from + i]!,
				1,
				size === null ? Number.NaN : size[from + i]!,
			);
		}
		return true;
	}

	/** Gives every row a size, NaN (the series' size) for the rows there are. */
	public enableSize(): void {
		if (this._sized) {
			return;
		}
		this._sized = true;
		for (const chunk of this._chunks) {
			// A chunk let go keeps its checksum, which a size of NaN for each point leaves as it was.
			if (chunk.summary === null) {
				chunk.size = new Float32Array(CHUNK_ROWS).fill(Number.NaN);
			}
		}
	}

	private _newChunk(): ScatterChunk {
		return {
			time: new Float64Array(CHUNK_ROWS),
			price: new Float64Array(CHUNK_ROWS),
			value: new Float32Array(CHUNK_ROWS),
			count: this._counted ? new Float32Array(CHUNK_ROWS) : null,
			size: this._sized ? new Float32Array(CHUNK_ROWS).fill(Number.NaN) : null,
			tMin: this._counted ? new Float64Array(CHUNK_ROWS) : null,
			tMax: this._counted ? new Float64Array(CHUNK_ROWS) : null,
			pMin: this._counted ? new Float64Array(CHUNK_ROWS) : null,
			pMax: this._counted ? new Float64Array(CHUNK_ROWS) : null,
			summary: null,
		};
	}

	/** The chunk of `row`, made if need be, with those between it and the chunks there are. */
	private _chunkFor(row: number): ScatterChunk {
		const n = row >> SCATTER_CHUNK_SHIFT;
		const chunks = this._chunks;
		if (chunks.length === 0) {
			this._base = n;
		}
		while (n < this._base) {
			chunks.unshift(this._newChunk());
			this._base--;
		}
		while (n >= this._base + chunks.length) {
			chunks.push(this._newChunk());
		}
		return chunks[n - this._base]!;
	}

	private _chunk(row: number): ScatterChunk {
		return this._chunks[(row >> SCATTER_CHUNK_SHIFT) - this._base]!;
	}

	/**
	 * Writes row `row`, which must be `end` or `first - 1` or a row held. A row of a chunk let go is
	 * written only where every row of the chunk is written anew (a removal moving rows over it, or a
	 * coarse chunk materialized from below), so the chunk starts over, held.
	 */
	public write(
		row: number,
		time: number,
		price: number,
		value: number,
		count: number,
		size: number,
		tMin = time,
		tMax = time,
		pMin = price,
		pMax = price,
	): void {
		const chunk = this._chunkFor(row);
		if (chunk.summary !== null) {
			const fresh = this._newChunk();
			chunk.time = fresh.time;
			chunk.price = fresh.price;
			chunk.value = fresh.value;
			chunk.count = fresh.count;
			chunk.size = fresh.size;
			chunk.tMin = fresh.tMin;
			chunk.tMax = fresh.tMax;
			chunk.pMin = fresh.pMin;
			chunk.pMax = fresh.pMax;
			chunk.summary = null;
			this._evicted--;
		}
		const at = row & CHUNK_MASK;
		chunk.time[at] = time;
		chunk.price[at] = price;
		chunk.value[at] = value;
		if (chunk.count !== null) {
			chunk.count[at] = count;
		}
		if (chunk.size !== null) {
			chunk.size[at] = size;
		}
		if (chunk.tMin !== null) {
			chunk.tMin[at] = tMin;
			chunk.tMax![at] = tMax;
			chunk.pMin![at] = pMin;
			chunk.pMax![at] = pMax;
		}
	}

	public push(
		time: number,
		price: number,
		value: number,
		count = 1,
		size = Number.NaN,
		tMin = time,
		tMax = time,
		pMin = price,
		pMax = price,
	): void {
		this.write(this.end, time, price, value, count, size, tMin, tMax, pMin, pMax);
		this.end++;
	}

	public unshift(
		time: number,
		price: number,
		value: number,
		count = 1,
		size = Number.NaN,
		tMin = time,
		tMax = time,
		pMin = price,
		pMax = price,
	): void {
		if (this.end === this.first) {
			this.first = 0;
			this.end = 0;
			this.push(time, price, value, count, size, tMin, tMax, pMin, pMax);
			return;
		}
		this.write(this.first - 1, time, price, value, count, size, tMin, tMax, pMin, pMax);
		this.first--;
	}

	public timeAt(row: number): number {
		return this._chunk(row).time[row & CHUNK_MASK]!;
	}

	public priceAt(row: number): number {
		return this._chunk(row).price[row & CHUNK_MASK]!;
	}

	public valueAt(row: number): number {
		return this._chunk(row).value[row & CHUNK_MASK]!;
	}

	public countAt(row: number): number {
		const counts = this._chunk(row).count;
		return counts === null ? 1 : counts[row & CHUNK_MASK]!;
	}

	public sizeAt(row: number): number {
		const sizes = this._chunk(row).size;
		return sizes === null ? Number.NaN : sizes[row & CHUNK_MASK]!;
	}

	public tMinAt(row: number): number {
		const chunk = this._chunk(row);
		return chunk.tMin === null ? chunk.time[row & CHUNK_MASK]! : chunk.tMin[row & CHUNK_MASK]!;
	}

	public tMaxAt(row: number): number {
		const chunk = this._chunk(row);
		return chunk.tMax === null ? chunk.time[row & CHUNK_MASK]! : chunk.tMax[row & CHUNK_MASK]!;
	}

	public pMinAt(row: number): number {
		const chunk = this._chunk(row);
		return chunk.pMin === null ? chunk.price[row & CHUNK_MASK]! : chunk.pMin[row & CHUNK_MASK]!;
	}

	public pMaxAt(row: number): number {
		const chunk = this._chunk(row);
		return chunk.pMax === null ? chunk.price[row & CHUNK_MASK]! : chunk.pMax[row & CHUNK_MASK]!;
	}

	public setValue(row: number, value: number): void {
		this._chunk(row).value[row & CHUNK_MASK] = value;
	}

	public setCount(row: number, count: number): void {
		const counts = this._chunk(row).count;
		if (counts !== null) {
			counts[row & CHUNK_MASK] = count;
		}
	}

	public setSize(row: number, size: number): void {
		const sizes = this._chunk(row).size;
		if (sizes !== null) {
			sizes[row & CHUNK_MASK] = size;
		}
	}

	public setBounds(row: number, tMin: number, tMax: number, pMin: number, pMax: number): void {
		const chunk = this._chunk(row);
		if (chunk.tMin !== null) {
			const at = row & CHUNK_MASK;
			chunk.tMin[at] = tMin;
			chunk.tMax![at] = tMax;
			chunk.pMin![at] = pMin;
			chunk.pMax![at] = pMax;
		}
	}

	/**
	 * First row whose time is not before `time`. Where that row lies in a chunk let go, the first row
	 * of that chunk: a bound to ask for the chunk by, not the row itself.
	 */
	public lowerBound(time: number): number {
		return this._search(t => t < time, false);
	}

	/** First row whose time is after `time`; in a chunk let go, that chunk's end, so the chunk is in range. */
	public upperBound(time: number): number {
		return this._search(t => t <= time, true);
	}

	/** First row whose time falls in time bucket `bucket` of width `step` or a later one. */
	public lowerBucket(step: number, bucket: number): number {
		return this._search(t => Math.floor(t / step) < bucket, false);
	}

	/**
	 * First row whose time `before` is false for, `before` being true up to some time and false from
	 * then on. With chunks let go, the chunk is found first by the times at its edges; in a chunk let
	 * go, the bound is its start, or its end with `end`.
	 */
	private _search(before: (time: number) => boolean, end: boolean): number {
		let lo = this.first;
		let hi = this.end;
		if (this._evicted > 0 && hi > lo) {
			let a = this.firstChunk;
			let b = this.lastChunk + 1;
			while (a < b) {
				const mid = (a + b) >>> 1;
				if (before(this.chunkLastTime(mid))) {
					a = mid + 1;
				} else {
					b = mid;
				}
			}
			if (a > this.lastChunk) {
				return this.end;
			}
			if (this.isEvicted(a)) {
				return end ? this.chunkEnd(a) : this.chunkStart(a);
			}
			lo = this.chunkStart(a);
			hi = this.chunkEnd(a);
		}
		while (lo < hi) {
			const mid = lo + ((hi - lo) >>> 1);
			if (before(this.timeAt(mid))) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		return lo;
	}

	/**
	 * Copies rows `[from, to)` into the start of the arrays given. `count`, `size` and `bounds` may
	 * be null, or filled with 1, NaN and `[t, t, p, p]` where the store has no such column.
	 */
	public copy(
		from: number,
		to: number,
		time: Float64Array,
		price: Float64Array,
		value: Float32Array,
		count: Float32Array | null,
		size: Float32Array | null,
		bounds: Float64Array | null = null,
	): void {
		let row = from;
		let out = 0;
		while (row < to) {
			const chunk = this._chunk(row);
			const at = row & CHUNK_MASK;
			const n = Math.min(CHUNK_ROWS - at, to - row);
			time.set(chunk.time.subarray(at, at + n), out);
			price.set(chunk.price.subarray(at, at + n), out);
			value.set(chunk.value.subarray(at, at + n), out);
			if (count !== null) {
				if (chunk.count === null) {
					count.fill(1, out, out + n);
				} else {
					count.set(chunk.count.subarray(at, at + n), out);
				}
			}
			if (size !== null) {
				if (chunk.size === null) {
					size.fill(Number.NaN, out, out + n);
				} else {
					size.set(chunk.size.subarray(at, at + n), out);
				}
			}
			if (bounds !== null) {
				if (chunk.tMin === null) {
					for (let k = 0; k < n; k++) {
						const t = chunk.time[at + k]!;
						const p = chunk.price[at + k]!;
						const b = (out + k) * 4;
						bounds[b] = t;
						bounds[b + 1] = t;
						bounds[b + 2] = p;
						bounds[b + 3] = p;
					}
				} else {
					const tMin = chunk.tMin;
					const tMax = chunk.tMax!;
					const pMin = chunk.pMin!;
					const pMax = chunk.pMax!;
					for (let k = 0; k < n; k++) {
						const b = (out + k) * 4;
						bounds[b] = tMin[at + k]!;
						bounds[b + 1] = tMax[at + k]!;
						bounds[b + 2] = pMin[at + k]!;
						bounds[b + 3] = pMax[at + k]!;
					}
				}
			}
			row += n;
			out += n;
		}
	}

	/**
	 * Replaces rows `[from, to)` with rows `[sourceFrom, sourceFrom + n)` of `source` (none when it is
	 * null). The rows on the shorter side of the change move over; the others keep their indexes.
	 */
	public splice(from: number, to: number, source: ScatterColumns | null, sourceFrom: number, n: number): void {
		const removed = to - from;
		const delta = n - removed;
		let at = from;
		if (delta !== 0) {
			if (from - this.first <= this.end - to) {
				// The rows before the change move: by `delta` to the left to make room, or to the right.
				this._move(this.first, this.first - delta, from - this.first);
				this.first -= delta;
				at = from - delta;
			} else {
				this._move(to, to + delta, this.end - to);
				this.end += delta;
			}
		}
		for (let i = 0; i < n; i++) {
			const row = sourceFrom + i;
			this.write(
				at + i,
				source!.timeAt(row),
				source!.priceAt(row),
				source!.valueAt(row),
				source!.countAt(row),
				source!.sizeAt(row),
				source!.tMinAt(row),
				source!.tMaxAt(row),
				source!.pMinAt(row),
				source!.pMaxAt(row),
			);
		}
		this._trim();
	}

	/** Copies `n` rows from `from` to `to`, in the order that leaves the source of each copy untouched. */
	private _move(from: number, to: number, n: number): void {
		if (n <= 0 || from === to) {
			return;
		}
		const one = (i: number): void => {
			this.write(
				to + i,
				this.timeAt(from + i),
				this.priceAt(from + i),
				this.valueAt(from + i),
				this.countAt(from + i),
				this.sizeAt(from + i),
				this.tMinAt(from + i),
				this.tMaxAt(from + i),
				this.pMinAt(from + i),
				this.pMaxAt(from + i),
			);
		};
		if (to < from) {
			for (let i = 0; i < n; i++) {
				one(i);
			}
		} else {
			for (let i = n - 1; i >= 0; i--) {
				one(i);
			}
		}
	}

	/** Lets go of the chunks that hold none of the rows. */
	private _trim(): void {
		const chunks = this._chunks;
		if (this.end <= this.first) {
			this.clear();
			return;
		}
		const firstChunk = this.first >> SCATTER_CHUNK_SHIFT;
		const lastChunk = (this.end - 1) >> SCATTER_CHUNK_SHIFT;
		const drop = (from: number, to: number): void => {
			for (let i = from; i < to; i++) {
				if (chunks[i]!.summary !== null) {
					this._evicted--;
				}
			}
		};
		if (lastChunk - this._base + 1 < chunks.length) {
			drop(lastChunk - this._base + 1, chunks.length);
			chunks.length = lastChunk - this._base + 1;
		}
		if (firstChunk > this._base) {
			drop(0, firstChunk - this._base);
			chunks.splice(0, firstChunk - this._base);
			this._base = firstChunk;
		}
	}
}

/** Column `column` (see `MARK_COLUMNS`) of points `[from, to)`, which are held. */
function pointsColumn(points: ScatterColumns, column: number, from: number, to: number): number {
	switch (column) {
		case MARK_COLUMNS.count:
			return to - from;
		case MARK_COLUMNS.open:
			return to > from ? points.priceAt(from) : Number.NaN;
		case MARK_COLUMNS.close:
			return to > from ? points.priceAt(to - 1) : Number.NaN;
		case MARK_COLUMNS.high:
		case MARK_COLUMNS.low: {
			let high = -Infinity;
			let low = Infinity;
			for (let row = from; row < to; row++) {
				const price = points.priceAt(row);
				high = Math.max(high, price);
				low = Math.min(low, price);
			}
			return to <= from ? Number.NaN : column === MARK_COLUMNS.high ? high : low;
		}
	}
	let sum = 0;
	let weighted = 0;
	let max = -Infinity;
	let min = Infinity;
	let values = 0;
	for (let row = from; row < to; row++) {
		const value = points.valueAt(row);
		if (value === value) {
			sum += value;
			weighted += value * points.priceAt(row);
			max = Math.max(max, value);
			min = Math.min(min, value);
			values++;
		}
	}
	switch (column) {
		case MARK_COLUMNS.sum:
			return sum;
		case MARK_COLUMNS.max:
			return values > 0 ? max : Number.NaN;
		case MARK_COLUMNS.min:
			return values > 0 ? min : Number.NaN;
		case MARK_COLUMNS.mean:
			return values > 0 ? sum / values : Number.NaN;
		case MARK_COLUMNS.vwap:
			return sum !== 0 ? weighted / sum : Number.NaN;
		default:
			return Number.NaN;
	}
}

/** Feeds one point to the checksum of a chunk: its time, price, value and, in a store with sizes, size. */
function feedPoint(checksum: Checksum, time: number, price: number, value: number, size: number, sized: boolean): void {
	checksum.double(time);
	checksum.double(price);
	checksum.single(value);
	if (sized) {
		checksum.single(size);
	}
}

/** The last time bucket a level was given points for, and the rows of its cells by price bin. */
interface CellCursor {
	bucket: number;
	readonly cells: Map<number, number>;
}

/**
 * One level of detail: the cells of a grid of time buckets (`step` wide) and price bins that hold
 * a point, in the order of their bucket.
 */
interface ScatterLevel extends CellCursor {
	readonly columns: ScatterColumns;
	readonly step: number;
	/** First row changed since `clearChanges`. */
	changed: number;
	/** Buckets whose bin order diverged from source scan order (prepend while source had evicted chunks). */
	readonly prependedBuckets: Set<number>;
}

/**
 * The points of a scatter series and their levels of detail.
 *
 * Level 0 is the points, in time order. Once there are `SCATTER_LEVEL_THRESHOLD` of them, coarse
 * levels are made on a grid fixed then: price bins a 4096th of the price range high, and time
 * buckets that hold 64 points on average at level 1 and are at least four times as wide at each
 * level above (wider where a level would merge next to nothing).
 * A level holds one row per cell with a point in it, at the cell's center, with the largest value
 * and size of its points and their number, so a level is itself a scatter with fewer points, drawn
 * by the same code. Levels above 1 are built from the level below, which gives the same cells as
 * the points would: buckets nest and bins are shared. A point appended later lands in the last
 * bucket of every level, found through the bucket's bins; a point prepended lands in the first.
 * The grid stays as it is until the next `set`: prices outside the first range get bins of the
 * same height.
 */
export class ScatterStore implements MarksStore {
	public readonly kind = 'scatter';
	private readonly _points = new ScatterColumns();
	private readonly _levels: ScatterLevel[] = [];
	private _changed = Infinity;
	private _binHeight = 0;
	/** Rows the source of the next level must have before it is tried (again). */
	private _growAt = 0;
	private _lastTime = -Infinity;
	private _priceMin = Infinity;
	private _priceMax = -Infinity;
	private _valueMin = Infinity;
	private _valueMax = -Infinity;

	public get byteLength(): number {
		let bytes = this._points.byteLength;
		for (const level of this._levels) {
			bytes += level.columns.byteLength;
		}
		return bytes;
	}

	/** Number of coarse levels. */
	public get levels(): number {
		return this._levels.length;
	}

	/** The points themselves, for readers in the engine (indicators over the series). */
	public get points(): ScatterColumns {
		return this._points;
	}

	private _reset(): void {
		this._points.clear();
		this._levels.length = 0;
		this._binHeight = 0;
		this._growAt = 0;
		this._lastTime = -Infinity;
		this._priceMin = Infinity;
		this._priceMax = -Infinity;
		this._valueMin = Infinity;
		this._valueMax = -Infinity;
		this._changed = 0;
	}

	public *set(data: MarksData): Generator<undefined, number, undefined> {
		this._reset();
		if (data.kind !== 'scatter') {
			return data.count;
		}
		return yield* this._append(data, timeOrder(data.time, data.count));
	}

	public *append(data: MarksData): Generator<undefined, number, undefined> {
		if (data.kind !== 'scatter') {
			return data.count;
		}
		return yield* this._append(data, null);
	}

	private *_append(data: ScatterRowsLike, order: Uint32Array | null): Generator<undefined, number, undefined> {
		const { time, price, value, count } = data;
		const size = data.size ?? null;
		const points = this._points;
		const levels = this._levels;
		if (size !== null) {
			this._enableSize();
		}
		let rejected = 0;
		for (let k = 0; k < count; k++) {
			const i = order === null ? k : order[k]!;
			const t = time[i]!;
			const p = price[i]!;
			// A point needs a finite time and price, and cannot go before the points there are.
			if (!(t >= this._lastTime) || t - t !== 0 || p - p !== 0) {
				rejected++;
				continue;
			}
			const v = value === null ? Number.NaN : value[i]!;
			const s = size === null ? Number.NaN : size[i]!;
			this._lastTime = t;
			this._extremes(p, v);
			if (points.end < this._changed) {
				this._changed = points.end;
			}
			points.push(t, p, v, 1, s);
			for (let l = 0; l < levels.length; l++) {
				const level = levels[l]!;
				const row = addCell(level.columns, level, level.step, this._binHeight, t, p, v, 1, s);
				if (row < level.changed) {
					level.changed = row;
				}
			}
			if ((k & (SLICE - 1)) === SLICE - 1) {
				yield;
			}
		}
		yield* this._grow();
		return rejected;
	}

	/**
	 * Adds points at or before the time of the first one, which keep the order they have among
	 * themselves in front of the points there are. A point after the first time is refused.
	 */
	public *prepend(data: MarksData): Generator<undefined, number, undefined> {
		if (data.kind !== 'scatter') {
			return data.count;
		}
		const points = this._points;
		if (points.count === 0) {
			return yield* this._append(data, timeOrder(data.time, data.count));
		}
		const { time, price, value, count } = data;
		const size = data.size ?? null;
		if (size !== null) {
			this._enableSize();
		}
		const order = timeOrder(time, count);
		const firstTime = points.timeAt(points.first);
		const accepted: number[] = [];
		let rejected = 0;
		for (let k = 0; k < count; k++) {
			const i = order === null ? k : order[k]!;
			const t = time[i]!;
			const p = price[i]!;
			if (!(t <= firstTime) || t - t !== 0 || p - p !== 0) {
				rejected++;
				continue;
			}
			accepted.push(i);
			this._extremes(p, value === null ? Number.NaN : value[i]!);
		}
		if (accepted.length === 0) {
			return rejected;
		}
		for (let k = accepted.length - 1; k >= 0; k--) {
			const i = accepted[k]!;
			points.unshift(
				time[i]!,
				price[i]!,
				value === null ? Number.NaN : value[i]!,
				1,
				size === null ? Number.NaN : size[i]!,
			);
			if ((k & (SLICE - 1)) === 0) {
				yield;
			}
		}
		for (let l = 0; l < this._levels.length; l++) {
			this._prependLevel(l, this._levels[l]!, data, accepted);
			yield;
		}
		yield* this._grow();
		return rejected;
	}

	/**
	 * Takes prepended points into the first buckets of a level. When `head` is touched and resident in
	 * `source`, bucket `head` is rebuilt from `source` so its bin order stays canonical for coarse
	 * chunk eviction; otherwise it merges in place and marks `head` non-evictable.
	 */
	private _prependLevel(l: number, level: ScatterLevel, data: ScatterRowsLike, accepted: readonly number[]): void {
		const columns = level.columns;
		const step = level.step;
		const binHeight = this._binHeight;
		const head = Math.floor(columns.timeAt(columns.first) / step);
		const { time, price, value } = data;
		const size = data.size ?? null;
		const lastTime = time[accepted[accepted.length - 1]!]!;
		const touchesHead = Math.floor(lastTime / step) === head;
		const source = l === 0 ? this._points : this._levels[l - 1]!.columns;
		const missing: number[] = [];
		if (touchesHead) {
			source.missing(source.lowerBucket(step, head), source.lowerBucket(step, head + 1), missing);
		}
		const block = new ScatterColumns(true);
		if (columns.sized) {
			block.enableSize();
		}
		const cursor: CellCursor = { bucket: Number.NaN, cells: new Map() };
		if (!touchesHead) {
			for (const i of accepted) {
				const t = time[i]!;
				const p = price[i]!;
				addCell(
					block,
					cursor,
					step,
					binHeight,
					t,
					p,
					value === null ? Number.NaN : value[i]!,
					1,
					size === null ? Number.NaN : size[i]!,
					t,
					t,
					p,
					p,
				);
			}
			for (let row = block.end - 1; row >= block.first; row--) {
				columns.unshift(
					block.timeAt(row),
					block.priceAt(row),
					block.valueAt(row),
					block.countAt(row),
					block.sizeAt(row),
					block.tMinAt(row),
					block.tMaxAt(row),
					block.pMinAt(row),
					block.pMaxAt(row),
				);
			}
			if (columns.first < level.changed) {
				level.changed = columns.first;
			}
			return;
		}
		if (missing.length === 0) {
			for (const i of accepted) {
				const t = time[i]!;
				if (Math.floor(t / step) >= head) {
					break;
				}
				const p = price[i]!;
				addCell(
					block,
					cursor,
					step,
					binHeight,
					t,
					p,
					value === null ? Number.NaN : value[i]!,
					1,
					size === null ? Number.NaN : size[i]!,
					t,
					t,
					p,
					p,
				);
			}
			const sourceEnd = source.lowerBucket(step, head + 1);
			for (let row = source.lowerBucket(step, head); row < sourceEnd; row++) {
				addCell(
					block,
					cursor,
					step,
					binHeight,
					source.timeAt(row),
					source.priceAt(row),
					source.valueAt(row),
					source.countAt(row),
					source.sizeAt(row),
					source.tMinAt(row),
					source.tMaxAt(row),
					source.pMinAt(row),
					source.pMaxAt(row),
				);
			}
			const headEnd = columns.lowerBucket(step, head + 1);
			// `from === columns.first`: rows from `headEnd` on keep their indexes.
			columns.splice(columns.first, headEnd, block, block.first, block.count);
			let sourceNonCanonical = false;
			if (l > 0) {
				const below = this._levels[l - 1]!;
				for (const bucket of below.prependedBuckets) {
					if (Math.floor((bucket * below.step) / step) === head) {
						sourceNonCanonical = true;
						break;
					}
				}
			}
			if (sourceNonCanonical) {
				level.prependedBuckets.add(head);
			} else {
				level.prependedBuckets.delete(head);
			}
			if (level.bucket === head) {
				this._rebuildTailCells(level);
			}
			if (columns.first < level.changed) {
				level.changed = columns.first;
			}
			return;
		}
		for (const i of accepted) {
			const t = time[i]!;
			const p = price[i]!;
			addCell(
				block,
				cursor,
				step,
				binHeight,
				t,
				p,
				value === null ? Number.NaN : value[i]!,
				1,
				size === null ? Number.NaN : size[i]!,
				t,
				t,
				p,
				p,
			);
		}
		const shared = new Map<number, number>();
		for (let row = columns.first; row < columns.end && Math.floor(columns.timeAt(row) / step) === head; row++) {
			shared.set(Math.floor(columns.priceAt(row) / binHeight), row);
		}
		const merged = new Set<number>();
		for (let row = block.end - 1; row >= block.first && Math.floor(block.timeAt(row) / step) === head; row--) {
			const into = shared.get(Math.floor(block.priceAt(row) / binHeight));
			if (into !== undefined) {
				mergeInto(
					columns,
					into,
					block.valueAt(row),
					block.countAt(row),
					block.sizeAt(row),
					block.tMinAt(row),
					block.tMaxAt(row),
					block.pMinAt(row),
					block.pMaxAt(row),
				);
				merged.add(row);
				if (into < level.changed) {
					level.changed = into;
				}
			}
		}
		for (let row = block.end - 1; row >= block.first; row--) {
			if (merged.has(row)) {
				continue;
			}
			columns.unshift(
				block.timeAt(row),
				block.priceAt(row),
				block.valueAt(row),
				block.countAt(row),
				block.sizeAt(row),
				block.tMinAt(row),
				block.tMaxAt(row),
				block.pMinAt(row),
				block.pMaxAt(row),
			);
			if (level.bucket === head && Math.floor(block.timeAt(row) / step) === head) {
				level.cells.set(Math.floor(block.priceAt(row) / binHeight), columns.first);
			}
		}
		level.prependedBuckets.add(head);
		if (columns.first < level.changed) {
			level.changed = columns.first;
		}
	}

	/**
	 * Replaces the points in `[from, to]` (or spanning `data`'s finite times when absent) with the
	 * valid points of `data` inside that range. Refuses all when no existing points fall in the range.
	 */
	public *correct(data: MarksData, from?: number, to?: number): Generator<undefined, number, undefined> {
		if (data.kind !== 'scatter') {
			return data.count;
		}
		const points = this._points;
		const range = scatterCorrectRange(data, from, to);
		if (range === null || points.count === 0) {
			return data.count;
		}
		const a = points.lowerBound(range.from);
		const b = points.upperBound(range.to);
		if (b <= a) {
			return data.count;
		}
		const { time, price, value, count } = data;
		const size = data.size ?? null;
		const order = timeOrder(time, count);
		const accepted: number[] = [];
		let rejected = 0;
		for (let k = 0; k < count; k++) {
			const i = order === null ? k : order[k]!;
			const t = time[i]!;
			const p = price[i]!;
			if (!(t >= range.from && t <= range.to) || t - t !== 0 || p - p !== 0) {
				rejected++;
				continue;
			}
			accepted.push(i);
		}
		if (count > 0 && accepted.length === 0) {
			return rejected;
		}
		if (accepted.length === 0 && b - a === points.count) {
			this._reset();
			return rejected;
		}
		if (size !== null) {
			this._enableSize();
		}
		const replacement = new ScatterColumns();
		if (points.sized) {
			replacement.enableSize();
		}
		for (let k = 0; k < accepted.length; k++) {
			const i = accepted[k]!;
			const t = time[i]!;
			const p = price[i]!;
			const v = value === null ? Number.NaN : value[i]!;
			const s = size === null ? Number.NaN : size[i]!;
			this._extremes(p, v);
			replacement.push(t, p, v, 1, s);
			if ((k & (SLICE - 1)) === SLICE - 1) {
				yield;
			}
		}
		this._materializeForRange(range.from, range.to);
		points.splice(a, b, replacement, replacement.first, replacement.count);
		this._lastTime = points.timeAt(points.end - 1);
		this._changed = points.first;
		yield;
		yield* this._rebuildLevels(range.from, range.to);
		yield* this._grow();
		return rejected;
	}

	/**
	 * Removes the points with times in `[from, to]`. Points on the shorter side of them move over;
	 * the buckets of every level that held a removed point are made again from what is left.
	 */
	public *delete(from: number, to: number): Generator<undefined, number, undefined> {
		const points = this._points;
		if (!(from <= to) || points.count === 0) {
			return 0;
		}
		const a = points.lowerBound(from);
		const b = points.upperBound(to);
		const removed = b - a;
		if (removed <= 0) {
			return 0;
		}
		if (removed === points.count) {
			this._reset();
			return removed;
		}
		this._materializeForRange(from, to);
		points.splice(a, b, null, 0, 0);
		this._lastTime = points.timeAt(points.end - 1);
		this._changed = points.first;
		yield;
		yield* this._rebuildLevels(from, to);
		return removed;
	}

	/**
	 * Materializes every evicted coarse chunk that rebuilding `[from, to]` will read or splice, while
	 * every level is still consistent with its summaries (before level 0 mutates).
	 */
	private _materializeForRange(from: number, to: number): void {
		const levels = this._levels;
		for (let l = 0; l < levels.length; l++) {
			const level = levels[l]!;
			const step = level.step;
			const lowBucket = Math.floor(from / step);
			const highBucket = Math.floor(to / step) + 1;
			if (l > 0) {
				const source = levels[l - 1]!.columns;
				this.materialize(l, source.lowerBucket(step, lowBucket), source.lowerBucket(step, highBucket));
			}
			const columns = level.columns;
			if (columns.evictedCount === 0) {
				continue;
			}
			const lo = columns.lowerBucket(step, lowBucket);
			const hi = columns.lowerBucket(step, highBucket);
			this.materialize(l + 1, lo - 1, hi + 1);
			const exactLo = columns.lowerBucket(step, lowBucket);
			const exactHi = columns.lowerBucket(step, highBucket);
			const moved =
				exactLo - columns.first <= columns.end - exactHi ? [columns.first, exactLo] : [exactHi, columns.end];
			this.materialize(l + 1, moved[0]!, moved[1]!);
		}
	}

	/** Rebuilds the buckets spanning `[from, to]` on every coarse level. */
	private *_rebuildLevels(from: number, to: number): Generator<undefined, void, undefined> {
		const levels = this._levels;
		for (let l = 0; l < levels.length; l++) {
			const level = levels[l]!;
			const source = l === 0 ? this._points : levels[l - 1]!.columns;
			const columns = level.columns;
			const step = level.step;
			const lowBucket = Math.floor(from / step);
			const highBucket = Math.floor(to / step) + 1;
			const block = new ScatterColumns(true);
			if (columns.sized) {
				block.enableSize();
			}
			const cursor: CellCursor = { bucket: Number.NaN, cells: new Map() };
			const sourceEnd = source.lowerBucket(step, highBucket);
			for (let row = source.lowerBucket(step, lowBucket); row < sourceEnd; row++) {
				addCell(
					block,
					cursor,
					step,
					this._binHeight,
					source.timeAt(row),
					source.priceAt(row),
					source.valueAt(row),
					source.countAt(row),
					source.sizeAt(row),
					source.tMinAt(row),
					source.tMaxAt(row),
					source.pMinAt(row),
					source.pMaxAt(row),
				);
			}
			const exactLo = columns.lowerBucket(step, lowBucket);
			const exactHi = columns.lowerBucket(step, highBucket);
			columns.splice(exactLo, exactHi, block, block.first, block.count);
			for (const bucket of level.prependedBuckets) {
				if (bucket >= lowBucket && bucket < highBucket) {
					level.prependedBuckets.delete(bucket);
				}
			}
			level.changed = columns.first;
			this._rebuildTailCells(level);
			yield;
		}
	}

	private _rebuildTailCells(level: ScatterLevel): void {
		const columns = level.columns;
		level.cells.clear();
		if (columns.count === 0) {
			level.bucket = Number.NaN;
			return;
		}
		level.bucket = Math.floor(columns.timeAt(columns.end - 1) / level.step);
		for (
			let row = columns.end - 1;
			row >= columns.first && Math.floor(columns.timeAt(row) / level.step) === level.bucket;
			row--
		) {
			level.cells.set(Math.floor(columns.priceAt(row) / this._binHeight), row);
		}
	}

	private _enableSize(): void {
		this._points.enableSize();
		for (const level of this._levels) {
			level.columns.enableSize();
		}
	}

	private _extremes(price: number, value: number): void {
		this._priceMin = Math.min(this._priceMin, price);
		this._priceMax = Math.max(this._priceMax, price);
		if (value === value) {
			this._valueMin = Math.min(this._valueMin, value);
			this._valueMax = Math.max(this._valueMax, value);
		}
	}

	/**
	 * Makes the first level once there are enough points, and a level above the top one while that is
	 * large. A level whose cells hold little more than one row of its source each is not worth its
	 * memory: its buckets are widened, by four at a time, until rows merge.
	 */
	private *_grow(): Generator<undefined, void, undefined> {
		const points = this._points;
		const levels = this._levels;
		if (levels.length === 0) {
			if (points.count < SCATTER_LEVEL_THRESHOLD) {
				return;
			}
			const range = this._priceMax - this._priceMin;
			this._binHeight = range > 0 ? range / SCATTER_PRICE_BINS : 1;
		}
		for (;;) {
			const top = levels[levels.length - 1];
			const source = top === undefined ? points : top.columns;
			if (source.count < this._growAt) {
				return;
			}
			let step: number;
			if (top === undefined) {
				const span = this._lastTime - points.timeAt(points.first);
				step = span > 0 ? Math.max((span * POINTS_PER_BUCKET) / points.count, 1e-3) : 1;
			} else if (source.count <= SCATTER_LEVEL_ROWS || levels.length === MAX_LEVELS) {
				return;
			} else {
				step = top.step * 4;
			}
			let level: ScatterLevel;
			for (let attempt = 0; ; attempt++) {
				level = newLevel(step, points.sized);
				for (let row = source.first; row < source.end; row++) {
					addCell(
						level.columns,
						level,
						step,
						this._binHeight,
						source.timeAt(row),
						source.priceAt(row),
						source.valueAt(row),
						source.countAt(row),
						source.sizeAt(row),
						source.tMinAt(row),
						source.tMaxAt(row),
						source.pMinAt(row),
						source.pMaxAt(row),
					);
					if (((row - source.first) & (SLICE - 1)) === SLICE - 1) {
						yield;
					}
				}
				if (level.columns.count <= source.count * MERGE_RATIO || attempt === 5) {
					break;
				}
				step *= 4;
			}
			if (level.columns.count > source.count * MERGE_RATIO) {
				// Nothing merges however wide the buckets: tried again once there are twice the rows.
				this._growAt = source.count * 2;
				return;
			}
			level.changed = level.columns.first;
			levels.push(level);
		}
	}

	private _columns(level: number): ScatterColumns | undefined {
		return level === 0 ? this._points : this._levels[level - 1]?.columns;
	}

	public first(level: number): number {
		return this._columns(level)?.first ?? 0;
	}

	public total(level: number): number {
		return this._columns(level)?.count ?? 0;
	}

	public changedFrom(level: number): number {
		return level === 0 ? this._changed : (this._levels[level - 1]?.changed ?? Infinity);
	}

	public clearChanges(): void {
		this._changed = Infinity;
		for (const level of this._levels) {
			level.changed = Infinity;
		}
	}

	// Memory: under the engine's memory limit, chunks of points and of intermediate coarse levels far
	// from the view are let go. Raw chunks are fetched back from the series' datafeed; coarse chunks
	// are rebuilt from the finest resident level below them (or from raw chunks once fetched). The
	// topmost level always stays so a wide or stand-in view can always draw.

	/**
	 * Chunks that may be let go, with the times they span: level 0 first, then intermediate coarse
	 * levels `1 .. levels - 1` (never the topmost level, never the first or last chunk of a level,
	 * none overlapping `[keepFrom, keepTo]`, and none before the series has a coarse level).
	 */
	public evictable(keepFrom: number, keepTo: number, out: MarksChunk[]): void {
		const points = this._points;
		if (this._levels.length === 0 || points.count === 0) {
			return;
		}
		for (let n = points.firstChunk + 1; n < points.lastChunk; n++) {
			if (points.isEvicted(n)) {
				continue;
			}
			const from = points.chunkFirstTime(n);
			const to = points.chunkLastTime(n);
			if (to >= keepFrom && from <= keepTo) {
				continue;
			}
			out.push({ chunk: n, level: 0, from, to, bytes: points.chunkBytes });
		}
		for (let l = 0; l < this._levels.length - 1; l++) {
			const level = this._levels[l]!;
			const columns = level.columns;
			const step = level.step;
			for (let n = columns.firstChunk + 1; n < columns.lastChunk; n++) {
				if (columns.isEvicted(n)) {
					continue;
				}
				const b0 = Math.floor(columns.chunkFirstTime(n) / step);
				const b1 = Math.floor(columns.chunkLastTime(n) / step);
				if (!(b0 < b1)) {
					continue;
				}
				let blocked = false;
				for (const bucket of level.prependedBuckets) {
					if (bucket >= b0 && bucket <= b1) {
						blocked = true;
						break;
					}
				}
				if (blocked) {
					continue;
				}
				const from = b0 * step;
				const to = (b1 + 1) * step;
				if (to >= keepFrom && from <= keepTo) {
					continue;
				}
				out.push({ chunk: n, level: l + 1, from, to, bytes: columns.chunkBytes });
			}
		}
	}

	public evict(chunk: number, level = 0): number {
		return this._columns(level)?.evict(chunk) ?? 0;
	}

	public get evicted(): number {
		let total = this._points.evictedCount;
		for (const level of this._levels) {
			total += level.columns.evictedCount;
		}
		return total;
	}

	/** Finest resident source below `levelIndex` covering buckets `[b0, b1]` of `step`, or null if level 0 misses chunks. */
	private _residentSource(levelIndex: number, step: number, b0: number, b1: number): ScatterColumns | null {
		const check: number[] = [];
		for (let s = levelIndex - 1; s >= -1; s--) {
			const source = s < 0 ? this._points : this._levels[s]!.columns;
			check.length = 0;
			source.missing(source.lowerBucket(step, b0), source.lowerBucket(step, b1 + 1), check);
			if (check.length === 0) {
				return source;
			}
		}
		return null;
	}

	/** Level-0 chunks missing to rebuild coarse chunk `chunk` of `this._levels[levelIndex]`. */
	private _missingCoarseChunk(levelIndex: number, chunk: number, out: number[]): void {
		const level = this._levels[levelIndex]!;
		const summary = level.columns.summaryOf(chunk);
		if (summary === null) {
			return;
		}
		const step = level.step;
		const b0 = Math.floor(summary.firstTime / step);
		const b1 = Math.floor(summary.lastTime / step);
		if (this._residentSource(levelIndex, step, b0, b1) !== null) {
			return;
		}
		const found: number[] = [];
		this._points.missing(this._points.lowerBucket(step, b0), this._points.lowerBucket(step, b1 + 1), found);
		for (const rawChunk of found) {
			if (!out.includes(rawChunk)) {
				out.push(rawChunk);
			}
		}
	}

	/** Rebuilds evicted chunk `chunk` of `this._levels[levelIndex]` from the finest resident level below it. */
	private _materializeChunk(levelIndex: number, chunk: number): boolean {
		const level = this._levels[levelIndex]!;
		const columns = level.columns;
		const summary = columns.summaryOf(chunk);
		if (summary === null) {
			return true;
		}
		const step = level.step;
		const b0 = Math.floor(summary.firstTime / step);
		const b1 = Math.floor(summary.lastTime / step);
		const source = this._residentSource(levelIndex, step, b0, b1);
		if (source === null) {
			return false;
		}
		const block = new ScatterColumns(true);
		if (columns.sized) {
			block.enableSize();
		}
		const cursor: CellCursor = { bucket: Number.NaN, cells: new Map() };
		const sourceEnd = source.lowerBucket(step, b1 + 1);
		for (let row = source.lowerBucket(step, b0); row < sourceEnd; row++) {
			addCell(
				block,
				cursor,
				step,
				this._binHeight,
				source.timeAt(row),
				source.priceAt(row),
				source.valueAt(row),
				source.countAt(row),
				source.sizeAt(row),
				source.tMinAt(row),
				source.tMaxAt(row),
				source.pMinAt(row),
				source.pMaxAt(row),
			);
		}
		let head = 0;
		while (block.first + head < block.end && Math.floor(block.timeAt(block.first + head) / step) === b0) {
			head++;
		}
		let tail = 0;
		while (block.end - 1 - tail >= block.first && Math.floor(block.timeAt(block.end - 1 - tail) / step) === b1) {
			tail++;
		}
		const from = head - summary.headTies;
		const to = block.count - (tail - summary.tailTies);
		if (from < 0 || to - from !== summary.count) {
			return false;
		}
		const start = columns.chunkStart(chunk);
		for (let i = 0; i < summary.count; i++) {
			const row = block.first + from + i;
			columns.write(
				start + i,
				block.timeAt(row),
				block.priceAt(row),
				block.valueAt(row),
				block.countAt(row),
				block.sizeAt(row),
				block.tMinAt(row),
				block.tMaxAt(row),
				block.pMinAt(row),
				block.pMaxAt(row),
			);
		}
		return true;
	}

	public materialize(level: number, start: number, end: number): boolean {
		const columns = this._columns(level);
		if (columns === undefined || columns.evictedCount === 0 || end <= start) {
			return true;
		}
		const evicted: number[] = [];
		columns.missing(start, end, evicted);
		if (evicted.length === 0) {
			return true;
		}
		if (level === 0) {
			return false;
		}
		for (const chunk of evicted) {
			if (!this._materializeChunk(level - 1, chunk)) {
				return false;
			}
		}
		return true;
	}

	/** Level-0 chunks let go that must be fetched to serve rows `[start, end)` of `level`. */
	public missing(level: number, start: number, end: number, out: number[]): void {
		if (level === 0) {
			const found: number[] = [];
			this._points.missing(start, end, found);
			for (const chunk of found) {
				if (!out.includes(chunk)) {
					out.push(chunk);
				}
			}
			return;
		}
		const columns = this._levels[level - 1]?.columns;
		if (columns === undefined || columns.evictedCount === 0) {
			return;
		}
		const evicted: number[] = [];
		columns.missing(start, end, evicted);
		for (const chunk of evicted) {
			this._missingCoarseChunk(level - 1, chunk, out);
		}
	}

	/** The times a datafeed is asked for to give chunk `chunk` back, and the points it holds. */
	public fetchRange(chunk: number): { from: number; to: number; count: number } | null {
		const summary = this._points.summaryOf(chunk);
		return summary === null ? null : { from: summary.firstTime, to: summary.lastTime, count: summary.count };
	}

	/**
	 * Gives chunk `chunk` its points back from what a datafeed returned for its times: the points of
	 * those times in time order, of which those it held are taken (at the first and last time, points
	 * of the chunks beside it may come too). Returns whether they were the points let go.
	 */
	public restore(chunk: number, data: MarksData): boolean {
		const summary = this._points.summaryOf(chunk);
		if (summary === null || data.kind !== 'scatter') {
			return false;
		}
		const order = timeOrder(data.time, data.count);
		const at = (k: number): number => (order === null ? k : order[k]!);
		const { firstTime, lastTime } = summary;
		// The points of the chunk's times, in order, and how many at each end belong to other chunks.
		const picked: number[] = [];
		let head = 0;
		let tail = 0;
		for (let k = 0; k < data.count; k++) {
			const i = at(k);
			const t = data.time[i]!;
			if (t >= firstTime && t <= lastTime) {
				picked.push(i);
				if (t === firstTime) {
					head++;
				}
				if (t === lastTime) {
					tail++;
				}
			}
		}
		const from = head - summary.headTies;
		const to = picked.length - (tail - summary.tailTies);
		if (from < 0 || to - from !== summary.count) {
			return false;
		}
		const count = summary.count;
		const time = new Float64Array(count);
		const price = new Float64Array(count);
		const value = data.value === null ? null : new Float32Array(count);
		const sizes = data.size ?? null;
		const size = sizes === null ? null : new Float32Array(count);
		for (let k = 0; k < count; k++) {
			const i = picked[from + k]!;
			time[k] = data.time[i]!;
			price[k] = data.price[i]!;
			if (value !== null) {
				value[k] = data.value![i]!;
			}
			if (size !== null) {
				size[k] = sizes![i]!;
			}
		}
		return this._points.restore(chunk, time, price, value, size, 0, count);
	}

	/**
	 * Chunks let go that removing the points of `[from, to]` would read or move: the points on the
	 * shorter side of them, those of the level-1 buckets the removal touches, and any evicted coarse
	 * chunks that splicing or rebuilding those buckets touches or moves.
	 */
	public needs(from: number, to: number, out: number[]): void {
		const points = this._points;
		if (this.evicted === 0 || !(from <= to) || points.count === 0) {
			return;
		}
		const a = points.lowerBound(from);
		const b = points.upperBound(to);
		if (b <= a) {
			return;
		}
		const moved = a - points.first <= points.end - b ? [points.first, a] : [b, points.end];
		this.missing(0, moved[0]!, moved[1]!, out);
		// The removal's edges and the points beside them, which bounds in a chunk let go only find once
		// it is back.
		this.missing(0, a - 1, a + 1, out);
		this.missing(0, b - 1, b + 1, out);
		this._needsCoarseForRange(from, to, a, b, out);
	}

	/** Chunks let go that correcting points with `data` over `[from, to]` would read, move or rebuild from. */
	public needsCorrect(data: MarksData, from: number | undefined, to: number | undefined, out: number[]): void {
		const points = this._points;
		if (this.evicted === 0 || points.count === 0) {
			return;
		}
		const range = scatterCorrectRange(data, from, to);
		if (range === null) {
			return;
		}
		const a = points.lowerBound(range.from);
		const b = points.upperBound(range.to);
		if (b <= a) {
			return;
		}
		const inRange: number[] = [];
		points.missing(a, b, inRange);
		// `[a, b)` itself and its boundary neighbors must be held.
		this.missing(0, a - 1, b + 1, out);
		// If row count might change (or `[a, b)` had evicted chunks so its exact count is not known yet),
		// splicing moves the shorter side.
		if (inRange.length > 0 || data.count !== b - a) {
			const moved = a - points.first <= points.end - b ? [points.first, a] : [b, points.end];
			this.missing(0, moved[0]!, moved[1]!, out);
		}
		this._needsCoarseForRange(range.from, range.to, a, b, out);
	}

	private _needsCoarseForRange(from: number, to: number, a: number, b: number, out: number[]): void {
		const points = this._points;
		const levels = this._levels;
		const level1 = levels[0];
		if (level1 !== undefined) {
			const low = points.lowerBucket(level1.step, Math.floor(from / level1.step));
			const high = points.lowerBucket(level1.step, Math.floor(to / level1.step) + 1);
			this.missing(0, low, a, out);
			this.missing(0, b, high, out);
		}
		for (let l = 0; l < levels.length; l++) {
			const level = levels[l]!;
			const step = level.step;
			const lowBucket = Math.floor(from / step);
			const highBucket = Math.floor(to / step) + 1;
			if (l > 0) {
				const source = levels[l - 1]!.columns;
				this.missing(l, source.lowerBucket(step, lowBucket), source.lowerBucket(step, highBucket), out);
			}
			const columns = level.columns;
			if (columns.evictedCount > 0) {
				const lo = columns.lowerBucket(step, lowBucket);
				const hi = columns.lowerBucket(step, highBucket);
				this.missing(l + 1, lo - 1, hi + 1, out);
				const maxLo =
					lo < columns.end && columns.isEvicted(lo >> SCATTER_CHUNK_SHIFT)
						? columns.chunkEnd(lo >> SCATTER_CHUNK_SHIFT)
						: lo;
				const maxHi =
					hi < columns.end && columns.isEvicted(hi >> SCATTER_CHUNK_SHIFT)
						? columns.chunkEnd(hi >> SCATTER_CHUNK_SHIFT)
						: hi;
				if (lo - columns.first <= columns.end - hi) {
					this.missing(l + 1, columns.first, maxLo, out);
				}
				if (maxLo - columns.first > columns.end - maxHi) {
					this.missing(l + 1, hi, columns.end, out);
				}
			}
		}
	}

	// A timeline made from the points

	public bucketTimes(interval: number, from: number, to: number): number[] {
		const points = this._points;
		const times: number[] = [];
		if (!(interval > 0) || points.count === 0) {
			return times;
		}
		const start = points.lowerBound(from);
		const end = points.lowerBound(to);
		let last = Number.NaN;
		const push = (t: number): void => {
			if (t >= from && t < to) {
				const bucket = Math.floor(t / interval) * interval;
				if (bucket !== last) {
					times.push(bucket);
					last = bucket;
				}
			}
		};
		if (points.evictedCount === 0) {
			for (let row = start; row < end; row++) {
				push(points.timeAt(row));
			}
			return times;
		}
		if (end <= start) {
			return times;
		}
		const firstChunk = start >> SCATTER_CHUNK_SHIFT;
		const lastChunk = (end - 1) >> SCATTER_CHUNK_SHIFT;
		for (let n = firstChunk; n <= lastChunk; n++) {
			const lo = Math.max(start, points.chunkStart(n));
			const hi = Math.min(end, points.chunkEnd(n));
			if (hi <= lo) {
				continue;
			}
			if (!points.isEvicted(n)) {
				for (let row = lo; row < hi; row++) {
					push(points.timeAt(row));
				}
				continue;
			}
			// Chunk let go: read bucket starts from the finest resident coarse level covering its times.
			const cFrom = Math.max(from, points.chunkFirstTime(n));
			const cTo = Math.min(to, points.chunkLastTime(n) + 1);
			for (let l = 0; l < this._levels.length; l++) {
				const level = this._levels[l]!;
				const cols = level.columns;
				const half = level.step * 0.5;
				const r0 = cols.lowerBound(cFrom - half);
				const r1 = cols.upperBound(cTo + half);
				const ev: number[] = [];
				cols.missing(r0, r1, ev);
				if (ev.length > 0) {
					continue;
				}
				const found: number[] = [];
				for (let r = r0; r < r1; r++) {
					const t0 = cols.tMinAt(r);
					const t1 = cols.tMaxAt(r);
					if (t1 >= cFrom && t0 < cTo) {
						if (t0 >= from && t0 < to) {
							found.push(Math.floor(t0 / interval) * interval);
						}
						if (t1 >= from && t1 < to) {
							found.push(Math.floor(t1 / interval) * interval);
						}
					}
				}
				found.sort((a, b) => a - b);
				for (const bucket of found) {
					if (bucket !== last && !(bucket < last)) {
						times.push(bucket);
						last = bucket;
					}
				}
				break;
			}
		}
		return times;
	}

	// Indicators over the points

	public missingTimes(from: number, to: number, out: number[]): void {
		const points = this._points;
		if (points.evictedCount > 0 && to > from) {
			// From the chunk that holds `from` to the one that holds `to`: a bound in a chunk let go is
			// that chunk's start (`lowerBound`) or end (`upperBound`), which takes the chunk in.
			points.missing(points.lowerBound(from), points.upperBound(to), out);
		}
	}

	public aggregate(column: number, bounds: Float64Array, n: number, out: Float64Array, offset: number): void {
		const points = this._points;
		const missing: number[] = [];
		const evicted = points.evictedCount > 0;
		for (let k = 0; k < n; k++) {
			const low = bounds[k]!;
			const high = bounds[k + 1]!;
			if (!(low <= high)) {
				// A bar whose time is not known (let go with its chunk of the main series).
				out[offset + k] = Number.NaN;
				continue;
			}
			if (evicted) {
				// Only exact where every chunk the bar's times reach into is held.
				missing.length = 0;
				points.missing(points.lowerBound(low), points.upperBound(high), missing);
				if (missing.length > 0) {
					out[offset + k] = Number.NaN;
					continue;
				}
			}
			out[offset + k] = pointsColumn(points, column, points.lowerBound(low), points.lowerBound(high));
		}
	}

	/** Rows of `level` whose point or cell can show in `[from, to]`. */
	private _range(level: number, from: number, to: number, out: MarksSelection): void {
		const columns = this._columns(level)!;
		// A cell is at the center of its bucket, half a step from the times it holds.
		const half = level === 0 ? 0 : this._levels[level - 1]!.step / 2;
		out.level = level;
		out.start = columns.lowerBound(from - half);
		out.end = Math.max(out.start, columns.upperBound(to + half));
	}

	/**
	 * The level a view draws from: the coarsest whose time buckets are no wider than a device pixel
	 * and whose price bins are no taller, so nothing visible is lost; the points themselves when no
	 * level is that fine. If that is more rows than the client wants, the next coarser levels are
	 * tried: then cells are wider than a pixel, and the frame keeps its budget.
	 */
	public select(request: MarksRequest, minLevel = 0): MarksSelection {
		const levels = this._levels;
		let level = Math.min(minLevel, levels.length);
		for (let l = level + 1; l <= levels.length; l++) {
			if (levels[l - 1]!.step <= request.step && (request.priceStep <= 0 || this._binHeight <= request.priceStep)) {
				level = l;
			}
		}
		const selection: MarksSelection = { level, start: 0, end: 0 };
		this._range(level, request.from, request.to, selection);
		while (selection.end - selection.start > request.limit && selection.level < levels.length) {
			this._range(selection.level + 1, request.from, request.to, selection);
		}
		return selection;
	}

	public read(level: number, start: number, end: number, update: MarksUpdate): void {
		const columns = this._columns(level);
		const count = columns === undefined ? 0 : Math.max(0, Math.min(end, columns.end) - start);
		update.level = level;
		update.start = start;
		update.count = count;
		update.first = columns?.first ?? 0;
		update.total = columns?.count ?? 0;
		update.timeStep = level === 0 ? 0 : (this._levels[level - 1]?.step ?? 0);
		update.priceStep = level === 0 ? 0 : this._binHeight;
		update.priceStart = 0;
		update.rows = 1;
		update.valueMin = this._valueMin <= this._valueMax ? this._valueMin : Number.NaN;
		update.valueMax = this._valueMin <= this._valueMax ? this._valueMax : Number.NaN;
		update.time = new Float64Array(count);
		update.price = new Float64Array(count);
		update.values = new Float32Array(count);
		update.counts = new Float32Array(level > 0 ? count : 0);
		update.sizes = new Float32Array(columns?.sized === true ? count : 0);
		update.bounds = new Float64Array(level > 0 ? count * 4 : 0);
		update.offsets = new Int32Array(0);
		update.lengths = new Int32Array(0);
		if (count > 0) {
			columns!.copy(
				start,
				start + count,
				update.time,
				update.price,
				update.values,
				level > 0 ? update.counts : null,
				columns!.sized ? update.sizes : null,
				level > 0 ? update.bounds : null,
			);
		}
	}
}

type ScatterRowsLike = Pick<Extract<MarksData, { kind: 'scatter' }>, 'time' | 'price' | 'value' | 'size' | 'count'>;

/** Resolves the inclusive time range a scatter correction covers, or null when invalid. */
function scatterCorrectRange(
	data: MarksData,
	from: number | undefined,
	to: number | undefined,
): { from: number; to: number } | null {
	if (data.kind !== 'scatter') {
		return null;
	}
	if (from !== undefined && to !== undefined) {
		return from <= to ? { from, to } : null;
	}
	let low = Infinity;
	let high = -Infinity;
	for (let i = 0; i < data.count; i++) {
		const t = data.time[i]!;
		if (t - t === 0) {
			if (t < low) low = t;
			if (t > high) high = t;
		}
	}
	return low <= high ? { from: low, to: high } : null;
}

/** A stable order of points by time, or null when they are in order. NaN times go last. */
function timeOrder(time: Float64Array, count: number): Uint32Array | null {
	let sorted = true;
	for (let i = 1; i < count; i++) {
		// Also false for a time that is not a number, which the caller refuses.
		if (time[i]! < time[i - 1]!) {
			sorted = false;
			break;
		}
	}
	if (sorted) {
		return null;
	}
	// Points at the same time keep the order they came in.
	const order = new Uint32Array(count);
	for (let i = 0; i < count; i++) {
		order[i] = i;
	}
	order.sort((a, b) => {
		const d = time[a]! - time[b]!;
		return d !== d ? (time[a]! !== time[a]! ? 1 : -1) : d || a - b;
	});
	return order;
}

/**
 * Takes a point, or a cell of the level below, into its cell of a level whose last bucket `cursor`
 * describes. Returns the row of that cell.
 */
function addCell(
	columns: ScatterColumns,
	cursor: CellCursor,
	step: number,
	binHeight: number,
	time: number,
	price: number,
	value: number,
	count: number,
	size: number,
	tMin = time,
	tMax = time,
	pMin = price,
	pMax = price,
): number {
	// A cell of the level below is at the center of its bucket and bin, which nest in these.
	const bucket = Math.floor(time / step);
	const bin = Math.floor(price / binHeight);
	if (bucket !== cursor.bucket) {
		cursor.bucket = bucket;
		cursor.cells.clear();
	}
	let row = cursor.cells.get(bin);
	if (row === undefined) {
		row = columns.end;
		cursor.cells.set(bin, row);
		columns.push((bucket + 0.5) * step, (bin + 0.5) * binHeight, value, count, size, tMin, tMax, pMin, pMax);
	} else {
		mergeInto(columns, row, value, count, size, tMin, tMax, pMin, pMax);
	}
	return row;
}

/** Takes the value, count, size and bounds of points into the cell at `row`. */
function mergeInto(
	columns: ScatterColumns,
	row: number,
	value: number,
	count: number,
	size: number,
	tMin: number,
	tMax: number,
	pMin: number,
	pMax: number,
): void {
	if (value === value && !(columns.valueAt(row) >= value)) {
		columns.setValue(row, value);
	}
	columns.setCount(row, columns.countAt(row) + count);
	if (size === size && !(columns.sizeAt(row) >= size)) {
		columns.setSize(row, size);
	}
	columns.setBounds(
		row,
		Math.min(columns.tMinAt(row), tMin),
		Math.max(columns.tMaxAt(row), tMax),
		Math.min(columns.pMinAt(row), pMin),
		Math.max(columns.pMaxAt(row), pMax),
	);
}

function newLevel(step: number, sized: boolean): ScatterLevel {
	const columns = new ScatterColumns(true);
	if (sized) {
		columns.enableSize();
	}
	return { columns, step, bucket: Number.NaN, cells: new Map(), changed: Infinity, prependedBuckets: new Set() };
}
