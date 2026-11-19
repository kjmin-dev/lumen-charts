import type { MarksRequest, MarksUpdate } from '@lumen-charts/engine';

/** A request without an answer is given up after this long, so a failed command cannot stall a series. */
const REQUEST_TIMEOUT_MS = 2000;
/** Rows a window may gain through patches, beyond half again its size, before it is asked for anew. */
const GROWTH_SLACK = 65_536;

/**
 * The main thread's copy of one level of a marks series around the view: the rows the engine sent
 * for the last request, kept current by the patches of appends. A frame draws from whatever is held.
 *
 * Rows are scatter points (or cells of a coarse level) with a time, a price and a value, or heatmap
 * columns with a time and `rows` values each.
 */
export class MarksWindow {
	/** Generation of the series' data the rows belong to; -1 before the first rows. */
	public generation = -1;
	public level = -1;
	/** Rows `[start, start + count)` of the level are held, of `total` it has. */
	public start = 0;
	public count = 0;
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
			this._coveredTo = update.start + update.count >= update.total ? Infinity : this._pendingTo;
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
			this._countAtReply = update.count;
			this.version++;
			this.revision++;
			this.clearDirty();
			return true;
		}
		// A patch: rows of the level held that an append changed or added.
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
		this._reserve(to - this.start);
		const rows = this.rows;
		const source = from - update.start;
		const target = from - this.start;
		const n = to - from;
		this.time.set(update.time.subarray(source, source + n), target);
		if (update.price.length > 0) {
			this.price.set(update.price.subarray(source, source + n), target);
		}
		this.values.set(update.values.subarray(source * rows, (source + n) * rows), target * rows);
		this.count = Math.max(this.count, to - this.start);
		this._describe(update);
		this.dirtyFrom = Math.min(this.dirtyFrom, target);
		this.dirtyTo = Math.max(this.dirtyTo, target + n);
		this.revision++;
		return true;
	}

	/** Takes over what describes the level and the values. Returns true if the value range changed. */
	private _describe(update: MarksUpdate): boolean {
		const changed = !same(update.valueMin, this.valueMin) || !same(update.valueMax, this.valueMax);
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
		const values = new Float32Array(capacity * rows);
		values.set(this.values.subarray(0, this.count * rows));
		this.values = values;
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

/** Whether a step per pixel differs from the one asked for by two or more either way, or one of them is none. */
function zoomed(asked: number, wanted: number): boolean {
	return asked > 0 !== wanted > 0 || (wanted > 0 && (wanted >= asked * 2 || wanted <= asked / 2));
}

/** Equal, NaN included. */
function same(a: number, b: number): boolean {
	return a === b || (a !== a && b !== b);
}
