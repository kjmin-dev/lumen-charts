import type { MarksData, MarksRequest, MarksSelection, MarksStore, MarksUpdate } from './protocol';

/** Cells per chunk of a heatmap level, about: a chunk holds whole columns. */
const CHUNK_CELLS = 1 << 16;
/** A level gets a coarser one above it while it has more columns than this. */
export const HEATMAP_LEVEL_COLUMNS = 512;
const MAX_LEVELS = 12;
/** Cells between two yields of a bulk operation. */
const SLICE = 1 << 20;

/** The columns of one level: a time and `rows` cells each, in chunks of whole columns. */
class HeatmapLevel {
	public count = 0;
	public time = new Float64Array(64);
	public readonly chunks: Float32Array[] = [];
	/** First column changed since `clearChanges`. */
	public changed = Infinity;
	private readonly _rows: number;
	private readonly _columnsPerChunk: number;

	public constructor(rows: number) {
		this._rows = rows;
		this._columnsPerChunk = Math.max(1, Math.floor(CHUNK_CELLS / rows));
	}

	public get byteLength(): number {
		return this.time.byteLength + this.chunks.length * this._columnsPerChunk * this._rows * 4;
	}

	/** Makes room for `count` columns and sets the count; the caller writes the cells of new columns. */
	public resize(count: number): void {
		if (count > this.time.length) {
			const grown = new Float64Array(Math.max(count, this.time.length * 2));
			grown.set(this.time.subarray(0, this.count));
			this.time = grown;
		}
		const chunks = Math.ceil(count / this._columnsPerChunk);
		while (this.chunks.length < chunks) {
			this.chunks.push(new Float32Array(this._columnsPerChunk * this._rows));
		}
		this.chunks.length = chunks;
		this.count = count;
	}

	/** The chunk that holds `column`; its cells start at `offset(column)`. */
	public chunk(column: number): Float32Array {
		return this.chunks[Math.floor(column / this._columnsPerChunk)]!;
	}

	public offset(column: number): number {
		return (column % this._columnsPerChunk) * this._rows;
	}

	public mark(column: number): void {
		if (column < this.changed) {
			this.changed = column;
		}
	}
}

/**
 * The columns of a heatmap and their levels of detail.
 *
 * Level 0 holds the columns as given, each with its time and `rows` cells on one price grid for the
 * whole series. Level `k` merges `4^k` columns by index into one: its time is the first member's and
 * each cell the largest of the members' cells, skipping cells without a value (a sum would make a
 * cell four times as bright at every level change). A change of a column rebuilds the bucket that
 * holds it at every level from all of its members, so replacing the last column with lower values
 * lowers the levels too.
 */
export class HeatmapStore implements MarksStore {
	public readonly kind = 'heatmap';
	private _rows = 1;
	private _priceStart = 0;
	private _priceStep = 1;
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
		this._levels = [new HeatmapLevel(this._rows)];
		this._levels[0]!.changed = 0;
		this._valueMin = Infinity;
		this._valueMax = -Infinity;
		if (!valid) {
			return data.count;
		}
		return yield* this._append(data.time, data.values, data.count);
	}

	public *append(data: MarksData): Generator<undefined, number, undefined> {
		if (
			data.kind !== 'heatmap' ||
			data.rows !== this._rows ||
			data.priceStart !== this._priceStart ||
			data.priceStep !== this._priceStep
		) {
			// Columns on another grid: a `set` starts one.
			return data.count;
		}
		return yield* this._append(data.time, data.values, data.count);
	}

	private *_append(time: Float64Array, values: Float32Array, count: number): Generator<undefined, number, undefined> {
		const raw = this._levels[0]!;
		const rows = this._rows;
		let rejected = 0;
		let first = Infinity;
		let cells = 0;
		for (let i = 0; i < count; i++) {
			const t = time[i]!;
			const last = raw.count === 0 ? -Infinity : raw.time[raw.count - 1]!;
			// A column at the last column's time replaces it; one before it, or without a time, is refused.
			if (!(t >= last) || t - t !== 0 || (i + 1) * rows > values.length) {
				rejected++;
				continue;
			}
			const column = t === last ? raw.count - 1 : raw.count;
			if (column === raw.count) {
				raw.resize(column + 1);
				raw.time[column] = t;
			}
			const source = values.subarray(i * rows, (i + 1) * rows);
			raw.chunk(column).set(source, raw.offset(column));
			for (let r = 0; r < rows; r++) {
				const value = source[r]!;
				if (value === value) {
					this._valueMin = Math.min(this._valueMin, value);
					this._valueMax = Math.max(this._valueMax, value);
				}
			}
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
			yield* this._rebuild(first);
		}
		return rejected;
	}

	/** Rebuilds, at every level, the buckets that hold raw columns from `from` on. */
	private *_rebuild(from: number): Generator<undefined, void, undefined> {
		const levels = this._levels;
		const rows = this._rows;
		let cells = 0;
		for (let l = 1; ; l++) {
			const below = levels[l - 1]!;
			if (below.count <= HEATMAP_LEVEL_COLUMNS || l > MAX_LEVELS) {
				// Levels a shorter history no longer needs are let go.
				levels.length = l;
				return;
			}
			let level = levels[l];
			if (level === undefined) {
				level = new HeatmapLevel(rows);
				levels.push(level);
				from = 0;
			}
			const count = Math.ceil(below.count / 4);
			level.resize(count);
			const start = Math.floor(from / 4 ** l);
			level.mark(start);
			for (let bucket = start; bucket < count; bucket++) {
				const firstChild = bucket * 4;
				const end = Math.min(firstChild + 4, below.count);
				level.time[bucket] = below.time[firstChild]!;
				const target = level.chunk(bucket);
				const at = level.offset(bucket);
				target.set(below.chunk(firstChild).subarray(below.offset(firstChild), below.offset(firstChild) + rows), at);
				for (let child = firstChild + 1; child < end; child++) {
					const source = below.chunk(child);
					const childAt = below.offset(child);
					for (let r = 0; r < rows; r++) {
						const value = source[childAt + r]!;
						// Also takes a value over a cell that has none.
						if (value === value && !(target[at + r]! >= value)) {
							target[at + r] = value;
						}
					}
				}
				cells += rows * 4;
				if (cells >= SLICE) {
					cells = 0;
					yield;
				}
			}
		}
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
		const count = raw.count;
		// The column before the first time asked for reaches into it.
		const start = Math.max(0, upperBound(raw.time, count, request.from) - 1);
		const end = Math.max(start, upperBound(raw.time, count, request.to));
		let level = 0;
		if (end > start && request.step > 0) {
			const from = Math.max(request.from, raw.time[start]!);
			const to = Math.min(request.to, raw.time[end - 1]!);
			const pixels = Math.max(1, (to - from) / request.step);
			while (level < this.levels && (end - start) / 4 ** (level + 1) >= pixels) {
				level++;
			}
		}
		while (level < this.levels && Math.ceil((end - start) / 4 ** level) * this._rows > request.limit) {
			level++;
		}
		const size = 4 ** level;
		return { level, start: Math.floor(start / size), end: Math.min(this.total(level), Math.ceil(end / size)) };
	}

	public read(level: number, start: number, end: number, update: MarksUpdate): void {
		const source = this._levels[level];
		const rows = this._rows;
		const count = source === undefined ? 0 : Math.max(0, Math.min(end, source.count) - start);
		update.level = level;
		update.start = start;
		update.count = count;
		update.total = source?.count ?? 0;
		update.timeStep = 0;
		update.priceStep = this._priceStep;
		update.priceStart = this._priceStart;
		update.rows = rows;
		update.valueMin = this._valueMin <= this._valueMax ? this._valueMin : Number.NaN;
		update.valueMax = this._valueMin <= this._valueMax ? this._valueMax : Number.NaN;
		update.time = new Float64Array(count);
		update.price = new Float64Array(0);
		update.values = new Float32Array(count * rows);
		if (source === undefined) {
			return;
		}
		update.time.set(source.time.subarray(start, start + count));
		for (let i = 0; i < count; i++) {
			const column = start + i;
			const at = source.offset(column);
			update.values.set(source.chunk(column).subarray(at, at + rows), i * rows);
		}
	}
}

/** First of the `count` sorted times that is after `time`. */
function upperBound(times: Float64Array, count: number, time: number): number {
	let lo = 0;
	let hi = count;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (times[mid]! <= time) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo;
}
