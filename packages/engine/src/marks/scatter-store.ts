import type { MarksData, MarksRequest, MarksSelection, MarksStore, MarksUpdate } from './protocol';

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
}

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
		return this._chunks.length * CHUNK_ROWS * (20 + (this._counted ? 4 : 0) + (this._sized ? 4 : 0));
	}

	public clear(): void {
		this.first = 0;
		this.end = 0;
		this._chunks.length = 0;
		this._base = 0;
		this._sized = false;
	}

	/** Gives every row a size, NaN (the series' size) for the rows there are. */
	public enableSize(): void {
		if (this._sized) {
			return;
		}
		this._sized = true;
		for (const chunk of this._chunks) {
			chunk.size = new Float32Array(CHUNK_ROWS).fill(Number.NaN);
		}
	}

	private _newChunk(): ScatterChunk {
		return {
			time: new Float64Array(CHUNK_ROWS),
			price: new Float64Array(CHUNK_ROWS),
			value: new Float32Array(CHUNK_ROWS),
			count: this._counted ? new Float32Array(CHUNK_ROWS) : null,
			size: this._sized ? new Float32Array(CHUNK_ROWS).fill(Number.NaN) : null,
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

	/** Writes row `row`, which must be `end` or `first - 1` or a row held. */
	public write(row: number, time: number, price: number, value: number, count: number, size: number): void {
		const chunk = this._chunkFor(row);
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
	}

	public push(time: number, price: number, value: number, count = 1, size = Number.NaN): void {
		this.write(this.end, time, price, value, count, size);
		this.end++;
	}

	public unshift(time: number, price: number, value: number, count = 1, size = Number.NaN): void {
		if (this.end === this.first) {
			this.first = 0;
			this.end = 0;
			this.push(time, price, value, count, size);
			return;
		}
		this.write(this.first - 1, time, price, value, count, size);
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

	/** First row whose time is not before `time`. */
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

	/** First row whose time is after `time`. */
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

	/** First row whose time falls in time bucket `bucket` of width `step` or a later one. */
	public lowerBucket(step: number, bucket: number): number {
		let lo = this.first;
		let hi = this.end;
		while (lo < hi) {
			const mid = lo + ((hi - lo) >>> 1);
			if (Math.floor(this.timeAt(mid) / step) < bucket) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		return lo;
	}

	/**
	 * Copies rows `[from, to)` into the start of the arrays given. `count` and `size` may be null, or
	 * filled with 1 and NaN where the store has no such column.
	 */
	public copy(
		from: number,
		to: number,
		time: Float64Array,
		price: Float64Array,
		value: Float32Array,
		count: Float32Array | null,
		size: Float32Array | null,
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
		if (lastChunk - this._base + 1 < chunks.length) {
			chunks.length = lastChunk - this._base + 1;
		}
		if (firstChunk > this._base) {
			chunks.splice(0, firstChunk - this._base);
			this._base = firstChunk;
		}
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
		for (const level of this._levels) {
			this._prependLevel(level, data, accepted);
			yield;
		}
		yield* this._grow();
		return rejected;
	}

	/**
	 * Takes prepended points into the first buckets of a level. Their cells are made on their own,
	 * in time order; the cells of the level's first bucket that they share a bin with take them in,
	 * and the others go in front.
	 */
	private _prependLevel(level: ScatterLevel, data: ScatterRowsLike, accepted: readonly number[]): void {
		const columns = level.columns;
		const step = level.step;
		const binHeight = this._binHeight;
		const block = new ScatterColumns(true);
		if (columns.sized) {
			block.enableSize();
		}
		const cursor: CellCursor = { bucket: Number.NaN, cells: new Map() };
		const { time, price, value } = data;
		const size = data.size ?? null;
		for (const i of accepted) {
			addCell(
				block,
				cursor,
				step,
				binHeight,
				time[i]!,
				price[i]!,
				value === null ? Number.NaN : value[i]!,
				1,
				size === null ? Number.NaN : size[i]!,
			);
		}
		const head = Math.floor(columns.timeAt(columns.first) / step);
		const shared = new Map<number, number>();
		for (let row = columns.first; row < columns.end && Math.floor(columns.timeAt(row) / step) === head; row++) {
			shared.set(Math.floor(columns.priceAt(row) / binHeight), row);
		}
		const merged = new Set<number>();
		for (let row = block.end - 1; row >= block.first && Math.floor(block.timeAt(row) / step) === head; row--) {
			const into = shared.get(Math.floor(block.priceAt(row) / binHeight));
			if (into !== undefined) {
				mergeInto(columns, into, block.valueAt(row), block.countAt(row), block.sizeAt(row));
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
			columns.unshift(block.timeAt(row), block.priceAt(row), block.valueAt(row), block.countAt(row), block.sizeAt(row));
			if (level.bucket === head && Math.floor(block.timeAt(row) / step) === head) {
				// The level's last bucket is its first: appends find the new cells too.
				level.cells.set(Math.floor(block.priceAt(row) / binHeight), columns.first);
			}
		}
		if (columns.first < level.changed) {
			level.changed = columns.first;
		}
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
		points.splice(a, b, null, 0, 0);
		this._lastTime = points.timeAt(points.end - 1);
		this._changed = points.first;
		yield;
		const levels = this._levels;
		for (let l = 0; l < levels.length; l++) {
			const level = levels[l]!;
			const source = l === 0 ? points : levels[l - 1]!.columns;
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
				);
			}
			columns.splice(
				columns.lowerBucket(step, lowBucket),
				columns.lowerBucket(step, highBucket),
				block,
				block.first,
				block.count,
			);
			level.changed = columns.first;
			// The last bucket's cells, which appends land in, by bin.
			level.cells.clear();
			level.bucket = Math.floor(columns.timeAt(columns.end - 1) / step);
			for (
				let row = columns.end - 1;
				row >= columns.first && Math.floor(columns.timeAt(row) / step) === level.bucket;
				row--
			) {
				level.cells.set(Math.floor(columns.priceAt(row) / this._binHeight), row);
			}
			yield;
		}
		return removed;
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
	public select(request: MarksRequest): MarksSelection {
		const levels = this._levels;
		let level = 0;
		for (let l = 1; l <= levels.length; l++) {
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
			);
		}
	}
}

type ScatterRowsLike = Pick<Extract<MarksData, { kind: 'scatter' }>, 'time' | 'price' | 'value' | 'size' | 'count'>;

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
		columns.push((bucket + 0.5) * step, (bin + 0.5) * binHeight, value, count, size);
	} else {
		mergeInto(columns, row, value, count, size);
	}
	return row;
}

/** Takes the value, count and size of points into the cell at `row`: the largest, the sum, the largest. */
function mergeInto(columns: ScatterColumns, row: number, value: number, count: number, size: number): void {
	if (value === value && !(columns.valueAt(row) >= value)) {
		columns.setValue(row, value);
	}
	columns.setCount(row, columns.countAt(row) + count);
	if (size === size && !(columns.sizeAt(row) >= size)) {
		columns.setSize(row, size);
	}
}

function newLevel(step: number, sized: boolean): ScatterLevel {
	const columns = new ScatterColumns(true);
	if (sized) {
		columns.enableSize();
	}
	return { columns, step, bucket: Number.NaN, cells: new Map(), changed: Infinity };
}
