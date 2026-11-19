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
}

/** Time, price and value of points or cells in time order, in chunks so growing never copies. */
export class ScatterColumns {
	public count = 0;
	private readonly _chunks: ScatterChunk[] = [];

	public get byteLength(): number {
		return this._chunks.length * CHUNK_ROWS * 20;
	}

	public clear(): void {
		this.count = 0;
		this._chunks.length = 0;
	}

	public push(time: number, price: number, value: number): void {
		const row = this.count++;
		const at = row & CHUNK_MASK;
		let chunk = this._chunks[row >> SCATTER_CHUNK_SHIFT];
		if (chunk === undefined) {
			chunk = {
				time: new Float64Array(CHUNK_ROWS),
				price: new Float64Array(CHUNK_ROWS),
				value: new Float32Array(CHUNK_ROWS),
			};
			this._chunks.push(chunk);
		}
		chunk.time[at] = time;
		chunk.price[at] = price;
		chunk.value[at] = value;
	}

	public timeAt(row: number): number {
		return this._chunks[row >> SCATTER_CHUNK_SHIFT]!.time[row & CHUNK_MASK]!;
	}

	public priceAt(row: number): number {
		return this._chunks[row >> SCATTER_CHUNK_SHIFT]!.price[row & CHUNK_MASK]!;
	}

	public valueAt(row: number): number {
		return this._chunks[row >> SCATTER_CHUNK_SHIFT]!.value[row & CHUNK_MASK]!;
	}

	public setValue(row: number, value: number): void {
		this._chunks[row >> SCATTER_CHUNK_SHIFT]!.value[row & CHUNK_MASK] = value;
	}

	/** First row whose time is not before `time`. */
	public lowerBound(time: number): number {
		let lo = 0;
		let hi = this.count;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
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
		let lo = 0;
		let hi = this.count;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (this.timeAt(mid) <= time) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		return lo;
	}

	/** Copies rows `[from, to)` into the start of the three arrays. */
	public copy(from: number, to: number, time: Float64Array, price: Float64Array, value: Float32Array): void {
		let row = from;
		let out = 0;
		while (row < to) {
			const chunk = this._chunks[row >> SCATTER_CHUNK_SHIFT]!;
			const at = row & CHUNK_MASK;
			const n = Math.min(CHUNK_ROWS - at, to - row);
			time.set(chunk.time.subarray(at, at + n), out);
			price.set(chunk.price.subarray(at, at + n), out);
			value.set(chunk.value.subarray(at, at + n), out);
			row += n;
			out += n;
		}
	}
}

/**
 * One level of detail: the cells of a grid of time buckets (`step` wide) and price bins that hold
 * a point, in the order of their bucket and, within a bucket, of their first point.
 */
interface ScatterLevel {
	readonly columns: ScatterColumns;
	readonly step: number;
	/** The last time bucket and the rows of its cells by price bin: where new points land. */
	bucket: number;
	readonly cells: Map<number, number>;
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
 * A level holds one row per cell with a point in it, at the cell's center and with the largest
 * value of its points, so a level is itself a scatter with fewer points, drawn by the same code.
 * Levels above 1 are built from the level below, which gives the same cells as the points would.
 * A point appended later lands in the last bucket of every level, found through the bucket's bins.
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

	public *set(data: MarksData): Generator<undefined, number, undefined> {
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
		if (data.kind !== 'scatter') {
			return data.count;
		}
		const { time, count } = data;
		let sorted = true;
		for (let i = 1; i < count; i++) {
			// Also false for a time that is not a number, which the append below refuses.
			if (time[i]! < time[i - 1]!) {
				sorted = false;
				break;
			}
		}
		let order: Uint32Array | null = null;
		if (!sorted) {
			// A stable order by time: points at the same time keep the order they came in.
			order = new Uint32Array(count);
			for (let i = 0; i < count; i++) {
				order[i] = i;
			}
			order.sort((a, b) => {
				const d = time[a]! - time[b]!;
				return d !== d ? (time[a]! !== time[a]! ? 1 : -1) : d || a - b;
			});
		}
		return yield* this._append(data.time, data.price, data.value, count, order);
	}

	public *append(data: MarksData): Generator<undefined, number, undefined> {
		if (data.kind !== 'scatter') {
			return data.count;
		}
		return yield* this._append(data.time, data.price, data.value, data.count, null);
	}

	private *_append(
		time: Float64Array,
		price: Float64Array,
		value: Float32Array | null,
		count: number,
		order: Uint32Array | null,
	): Generator<undefined, number, undefined> {
		const points = this._points;
		const levels = this._levels;
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
			this._lastTime = t;
			this._priceMin = Math.min(this._priceMin, p);
			this._priceMax = Math.max(this._priceMax, p);
			if (v === v) {
				this._valueMin = Math.min(this._valueMin, v);
				this._valueMax = Math.max(this._valueMax, v);
			}
			if (points.count < this._changed) {
				this._changed = points.count;
			}
			points.push(t, p, v);
			for (let l = 0; l < levels.length; l++) {
				this._add(levels[l]!, t, p, v);
			}
			if ((k & (SLICE - 1)) === SLICE - 1) {
				yield;
			}
		}
		yield* this._grow();
		return rejected;
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
				const span = this._lastTime - points.timeAt(0);
				step = span > 0 ? Math.max((span * POINTS_PER_BUCKET) / points.count, 1e-3) : 1;
			} else if (source.count <= SCATTER_LEVEL_ROWS || levels.length === MAX_LEVELS) {
				return;
			} else {
				step = top.step * 4;
			}
			let level: ScatterLevel;
			for (let attempt = 0; ; attempt++) {
				level = newLevel(step);
				for (let row = 0; row < source.count; row++) {
					this._add(level, source.timeAt(row), source.priceAt(row), source.valueAt(row));
					if ((row & (SLICE - 1)) === SLICE - 1) {
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
			level.changed = 0;
			levels.push(level);
		}
	}

	/** Takes a point (or a cell of the level below) into its cell of `level`. */
	private _add(level: ScatterLevel, time: number, price: number, value: number): void {
		const bucket = Math.floor(time / level.step);
		const bin = Math.floor(price / this._binHeight);
		const columns = level.columns;
		if (bucket !== level.bucket) {
			level.bucket = bucket;
			level.cells.clear();
		}
		let row = level.cells.get(bin);
		if (row === undefined) {
			row = columns.count;
			level.cells.set(bin, row);
			columns.push((bucket + 0.5) * level.step, (bin + 0.5) * this._binHeight, value);
		} else if (value === value && !(columns.valueAt(row) >= value)) {
			columns.setValue(row, value);
		} else {
			return;
		}
		if (row < level.changed) {
			level.changed = row;
		}
	}

	private _columns(level: number): ScatterColumns | undefined {
		return level === 0 ? this._points : this._levels[level - 1]?.columns;
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
		const count = columns === undefined ? 0 : Math.max(0, Math.min(end, columns.count) - start);
		update.level = level;
		update.start = start;
		update.count = count;
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
		if (count > 0) {
			columns!.copy(start, start + count, update.time, update.price, update.values);
		}
	}
}

function newLevel(step: number): ScatterLevel {
	return { columns: new ScatterColumns(), step, bucket: Number.NaN, cells: new Map(), changed: Infinity };
}
