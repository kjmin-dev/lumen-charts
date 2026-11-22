import type { MarksRequest, MarksUpdate } from '@lumen-charts/engine';

/** A request without an answer is given up after this long, so a failed command cannot stall a series. */
const REQUEST_TIMEOUT_MS = 2000;
/** Rows a window may gain through patches, beyond half again its size, before it is asked for anew. */
const GROWTH_SLACK = 65_536;

/**
 * The main thread's copy of one level of a marks series around the view: the rows the engine sent
 * for the last request, kept current by the patches of appends. A frame draws from whatever is held.
 *
 * Rows are scatter points (or cells of a coarse level) with a time, a price, a value, and a count
 * and size where the level has them, or heatmap columns with a time and their cells. Heatmap cells
 * are `rows` per column from grid row 0, or, where the grid follows the price (`varying`), each
 * column's own number from a grid row of its own: see `cellStart`, `cellOffset` and `cellLength`.
 */
export class MarksWindow {
	/** Generation of the series' data the rows belong to; -1 before the first rows. */
	public generation = -1;
	public level = -1;
	/** Rows `[start, start + count)` of the level are held, of `[first, first + total)` it has. */
	public start = 0;
	public count = 0;
	public first = 0;
	public total = 0;
	public timeStep = 0;
	public priceStep = 0;
	public priceStart = 0;
	public rows = 1;
	public valueMin = Number.NaN;
	public valueMax = Number.NaN;
	/** Buffers with room for `capacity` rows. */
	public capacity = 0;
	public time: Float64Array = new Float64Array(0);
	public price: Float64Array = new Float64Array(0);
	public values: Float32Array = new Float32Array(0);
	/** Scatter: points per row, empty where each row is one point. */
	public counts: Float32Array = new Float32Array(0);
	/** Scatter: size of each row's mark in CSS pixels (NaN: the series' size), empty when none has one. */
	public sizes: Float32Array = new Float32Array(0);
	/**
	 * Heatmap whose grid follows the price: the grid row of each column's first cell, its number of
	 * cells, and where they start in `values` (`starts[count]` is the end of the last). Empty otherwise.
	 */
	public offsets: Int32Array = new Int32Array(0);
	public lengths: Int32Array = new Int32Array(0);
	public starts: Int32Array = new Int32Array(0);
	/**
	 * Changes when the rows are replaced by others: everything derived from them starts over. Rows
	 * that only move to larger buffers are the same rows.
	 */
	public version = 0;
	/** Changes with every change of a row, a patch included. */
	public revision = 0;
	/** Rows (as indexes into the buffers) patches changed since `clearDirty`: `[dirtyFrom, dirtyTo)`. */
	public dirtyFrom = Infinity;
	public dirtyTo = -Infinity;

	/** The data was replaced (`setData`): what is held belongs to the old one. */
	private _stale = true;
	private _loading = false;
	private _requestSeq = -1;
	private _requestAt = 0;
	/** Times and steps of the request out, and of the one the rows held answer. */
	private _pendingFrom = 0;
	private _pendingTo = 0;
	private _pendingStep = 0;
	private _pendingPriceStep = 0;
	private _coveredFrom = Number.NaN;
	private _coveredTo = Number.NaN;
	private _step = 0;
	private _priceStepAsked = 0;
	private _countAtReply = 0;

	/** True while a request is out. */
	public get loading(): boolean {
		return this._loading;
	}

	/** Heatmap columns start at grid rows of their own and have cells of their own number. */
	public get varying(): boolean {
		return this.offsets.length > 0;
	}

	/** Where the cells of held column `column` (an index into the buffers) start in `values`. */
	public cellStart(column: number): number {
		return this.offsets.length > 0 ? this.starts[column]! : column * this.rows;
	}

	/** The grid row of the first cell of held column `column`. */
	public cellOffset(column: number): number {
		return this.offsets.length > 0 ? this.offsets[column]! : 0;
	}

	/** The number of cells of held column `column`. */
	public cellLength(column: number): number {
		return this.offsets.length > 0 ? this.lengths[column]! : this.rows;
	}

	/** Cells the buffers have room for. */
	public get cellCapacity(): number {
		return this.values.length;
	}

	/**
	 * The engine says the series changed in a way no patch carries (`MarksUpdate.notice`): rows in
	 * front of those held (a prepend), rows removed, rows back from the datafeed. The view is asked
	 * for again; with another generation, the rows held are drawn until the new ones are here.
	 */
	/** The view is asked for again at the next plan, keeping the rows held: after a failed fetch. */
	public retry(): void {
		this._coveredFrom = Number.NaN;
		this._coveredTo = Number.NaN;
	}

	public notice(update: MarksUpdate): void {
		if (update.generation !== this.generation) {
			this._stale = true;
		}
		this._coveredFrom = Number.NaN;
		this._coveredTo = Number.NaN;
		if (this._loading) {
			// The answer on its way may predate the change: it is asked for again.
			this._requestAt = -Infinity;
		}
	}

	/** The data was replaced: the rows held are shown until the new ones arrive, and asked for again. */
	public invalidate(): void {
		this._stale = true;
	}

	public clearDirty(): void {
		this.dirtyFrom = Infinity;
		this.dirtyTo = -Infinity;
	}

	/** Notes the `seq` of the request just planned. */
	public sent(seq: number, now: number): void {
		this._requestSeq = seq;
		this._requestAt = now;
	}

	/** Takes rows from the engine: a window or a patch. Returns true if anything a frame draws changed. */
	public apply(update: MarksUpdate): boolean {
		if (update.request !== undefined) {
			if (update.request < this._requestSeq) {
				// Superseded: the answer to the newer request brings the rows the view needs now.
				return false;
			}
			this._loading = false;
			this._stale = false;
			this._coveredFrom = this._pendingFrom;
			// A window that ends with the last row grows with every append: nothing is missing after it.
			this._coveredTo = update.start + update.count >= update.first + update.total ? Infinity : this._pendingTo;
			this._step = this._pendingStep;
			this._priceStepAsked = this._pendingPriceStep;
			const range = this._describe(update);
			if (update.kept === true) {
				this._countAtReply = this.count;
				return range;
			}
			this.generation = update.generation;
			this.level = update.level;
			this.start = update.start;
			this.count = update.count;
			this.capacity = update.count;
			this.time = update.time;
			this.price = update.price;
			this.values = update.values;
			this.counts = update.counts;
			this.sizes = update.sizes;
			this.offsets = update.offsets;
			this.lengths = update.lengths;
			this.starts = this.offsets.length > 0 ? prefix(update.lengths, update.count) : EMPTY_STARTS;
			this._countAtReply = update.count;
			this.version++;
			this.revision++;
			this.clearDirty();
			return true;
		}
		// A patch: rows of the level held that an append changed or added, which run to the end.
		const end = this.start + this.count;
		if (
			update.generation !== this.generation ||
			update.level !== this.level ||
			update.start > end ||
			update.start + update.count <= this.start
		) {
			return false;
		}
		const from = Math.max(update.start, this.start);
		const to = update.start + update.count;
		const source = from - update.start;
		const target = from - this.start;
		const n = to - from;
		if (update.offsets.length > 0 && this.offsets.length === 0) {
			// The grid follows the price from this column on: the columns held start at row 0.
			this._vary();
		}
		this._reserve(to - this.start);
		this.time.set(update.time.subarray(source, source + n), target);
		if (update.price.length > 0) {
			this.price.set(update.price.subarray(source, source + n), target);
		}
		if (update.counts.length > 0) {
			this.counts = room(this.counts, this.capacity, 1);
			this.counts.set(update.counts.subarray(source, source + n), target);
		}
		if (update.sizes.length > 0) {
			this.sizes = room(this.sizes, this.capacity, Number.NaN);
			this.sizes.set(update.sizes.subarray(source, source + n), target);
		}
		if (this.offsets.length > 0) {
			// Cells of the patched columns follow those of the columns before them.
			let skip = 0;
			for (let i = 0; i < source; i++) {
				skip += update.lengths[i]!;
			}
			let cells = 0;
			for (let i = source; i < source + n; i++) {
				cells += update.lengths[i]!;
			}
			const at = this.starts[target]!;
			if (this.values.length < at + cells) {
				const values = new Float32Array(Math.max(at + cells, Math.ceil(this.values.length * 1.5)));
				values.set(this.values.subarray(0, at));
				this.values = values;
			}
			this.values.set(update.values.subarray(skip, skip + cells), at);
			this.offsets.set(update.offsets.subarray(source, source + n), target);
			this.lengths.set(update.lengths.subarray(source, source + n), target);
			for (let i = target; i < target + n; i++) {
				this.starts[i + 1] = this.starts[i]! + this.lengths[i]!;
			}
		} else {
			const rows = this.rows;
			this.values.set(update.values.subarray(source * rows, (source + n) * rows), target * rows);
		}
		this.count = Math.max(this.count, to - this.start);
		this._describe(update);
		this.dirtyFrom = Math.min(this.dirtyFrom, target);
		this.dirtyTo = Math.max(this.dirtyTo, target + n);
		this.revision++;
		return true;
	}

	/** Gives the heatmap columns held their grid rows: all from row 0, `rows` cells each. */
	private _vary(): void {
		const capacity = Math.max(this.capacity, 1);
		this.offsets = new Int32Array(capacity);
		this.lengths = new Int32Array(capacity).fill(this.rows);
		this.lengths.fill(0, this.count);
		this.starts = prefix(this.lengths, capacity);
	}

	/** Takes over what describes the level and the values. Returns true if the value range changed. */
	private _describe(update: MarksUpdate): boolean {
		const changed = !same(update.valueMin, this.valueMin) || !same(update.valueMax, this.valueMax);
		this.first = update.first;
		this.total = update.total;
		this.timeStep = update.timeStep;
		this.priceStep = update.priceStep;
		this.priceStart = update.priceStart;
		this.rows = update.rows;
		this.valueMin = update.valueMin;
		this.valueMax = update.valueMax;
		return changed;
	}

	/** Makes room for `count` rows, keeping those held. */
	private _reserve(count: number): void {
		if (count <= this.capacity) {
			return;
		}
		const capacity = Math.max(count, Math.ceil(this.capacity * 1.5), 64);
		const rows = this.rows;
		const time = new Float64Array(capacity);
		time.set(this.time.subarray(0, this.count));
		this.time = time;
		if (this.price.length > 0 || rows === 1) {
			const price = new Float64Array(capacity);
			price.set(this.price.subarray(0, this.count));
			this.price = price;
		}
		if (this.counts.length > 0) {
			this.counts = room(this.counts, capacity, 1);
		}
		if (this.sizes.length > 0) {
			this.sizes = room(this.sizes, capacity, Number.NaN);
		}
		if (this.offsets.length > 0) {
			this.offsets = grow(this.offsets, capacity);
			this.lengths = grow(this.lengths, capacity);
			const starts = new Int32Array(capacity + 1);
			starts.set(this.starts.subarray(0, this.count + 1));
			starts.fill(this.starts[this.count]!, this.count + 1);
			this.starts = starts;
		} else {
			const values = new Float32Array(capacity * rows);
			values.set(this.values.subarray(0, this.count * rows));
			this.values = values;
		}
		this.capacity = capacity;
	}

	/**
	 * Decides whether the view needs rows the window does not have, and returns the request for them.
	 * The view shows times `[from, to]` at `step` milliseconds and `priceStep` of price per device
	 * pixel. Rows are asked for with `margin` screens on either side; a new request goes out when
	 * less than a quarter of a screen is left, when the view was zoomed by two or more either way
	 * (another level may fit), when appends grew the window by half, or after `invalidate`.
	 */
	public plan(
		from: number,
		to: number,
		step: number,
		priceStep: number,
		limit: number,
		margin: number,
		now: number,
	): MarksRequest | null {
		if (!(to >= from) || !(step > 0)) {
			return null;
		}
		const span = to - from;
		if (this._loading && now - this._requestAt < REQUEST_TIMEOUT_MS) {
			// One is on its way: another only when the view has left what it will bring.
			if (
				from >= this._pendingFrom &&
				to <= this._pendingTo &&
				!zoomed(this._pendingStep, step) &&
				!zoomed(this._pendingPriceStep, priceStep)
			) {
				return null;
			}
		} else if (
			!this._stale &&
			this.level >= 0 &&
			from - span / 4 >= this._coveredFrom &&
			to + span / 4 <= this._coveredTo &&
			!zoomed(this._step, step) &&
			!zoomed(this._priceStepAsked, priceStep) &&
			this.count <= this._countAtReply * 1.5 + GROWTH_SLACK
		) {
			return null;
		}
		this._loading = true;
		this._pendingFrom = from - span * margin;
		this._pendingTo = to + span * margin;
		this._pendingStep = step;
		this._pendingPriceStep = priceStep;
		return {
			from: this._pendingFrom,
			to: this._pendingTo,
			step,
			priceStep,
			limit,
			generation: this._stale ? -1 : this.generation,
			heldLevel: this._stale ? -1 : this.level,
			heldStart: this.start,
			heldEnd: this.start + this.count,
		};
	}

	/** First held row whose time is not before `time`, as an index into the buffers. */
	public lowerBound(time: number): number {
		const times = this.time;
		let lo = 0;
		let hi = this.count;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (times[mid]! < time) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		return lo;
	}

	/** First held row whose time is after `time`. */
	public upperBound(time: number): number {
		const times = this.time;
		let lo = 0;
		let hi = this.count;
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
}

const EMPTY_STARTS = new Int32Array(0);

/** Where each of the first `count` columns' cells start, given their lengths, and the end of the last. */
function prefix(lengths: Int32Array, count: number): Int32Array {
	const starts = new Int32Array(Math.max(count, lengths.length) + 1);
	for (let i = 0; i < count; i++) {
		starts[i + 1] = starts[i]! + lengths[i]!;
	}
	starts.fill(starts[count]!, count + 1);
	return starts;
}

/** `array`, or a copy with room for `capacity` entries, the new ones `fill`. */
function room(array: Float32Array, capacity: number, fill: number): Float32Array {
	if (array.length >= capacity) {
		return array;
	}
	const grown = new Float32Array(capacity).fill(fill);
	grown.set(array);
	return grown;
}

function grow(array: Int32Array, capacity: number): Int32Array {
	const grown = new Int32Array(capacity);
	grown.set(array.subarray(0, Math.min(array.length, capacity)));
	return grown;
}

/** Whether a step per pixel differs from the one asked for by two or more either way, or one of them is none. */
function zoomed(asked: number, wanted: number): boolean {
	return asked > 0 !== wanted > 0 || (wanted > 0 && (wanted >= asked * 2 || wanted <= asked / 2));
}

/** Equal, NaN included. */
function same(a: number, b: number): boolean {
	return a === b || (a !== a && b !== b);
}
