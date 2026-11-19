/** Gap between two bars assumed when the timeline has a single bar, in milliseconds. */
const SINGLE_BAR_GAP = 60_000;
/** Segments at either end whose shortest gap sets the pace beyond the end. */
const END_SEGMENTS = 8;

/**
 * Where times fall across the pane, in device pixels, for marks that are not bars: a bar's time is
 * at the bar's center, a time between two bars the same fraction of the way between their centers
 * (as `PaneView.timeToLogical` places it), and a time before the first or after the last bar held
 * goes on at the pace of the bars there.
 *
 * The map is made of the bars the frame draws from: the times of the rows of the window held around
 * the view, or of the buckets of a coarse level (each at its first row, so inside a bucket times
 * are spread evenly, which is off by less than the bucket is wide: under a pixel where a coarse
 * level is drawn). Marks are in time order, so a renderer walks the segments once (`segment`).
 */
export class TimeMap {
	/** Times of the knots, increasing; `count` of them are valid. */
	public times: Float64Array = new Float64Array(0);
	public count = 0;
	/** Device pixels between two bars. */
	public spacing = 1;
	private _start = 0;
	private _size = 1;
	private _first = 0;
	private _origin = 0;
	/** Device pixels per millisecond before the first knot and after the last. */
	private _headPace = 0;
	private _tailPace = 0;
	/** The segment `segment` loaded last: a time `t` in it is at `x0 + (t - t0) * pace`, up to `t1`. */
	public t0 = 0;
	public t1 = 0;
	public x0 = 0;
	public pace = 0;
	private _segment = 0;

	/**
	 * Sets the map from a window of the main timeline: `times[offset + k]` is the time of item
	 * `start + k` (a row, or a bucket of `2^shift` rows), for `count` items. Row `i` is centered at
	 * `origin + i * spacing` device pixels, and the timeline starts at row `first`.
	 */
	public set(
		times: Float64Array,
		offset: number,
		count: number,
		start: number,
		shift: number,
		first: number,
		origin: number,
		spacing: number,
	): void {
		this.times = offset === 0 ? times : times.subarray(offset, offset + count);
		this.count = count;
		this._start = start;
		this._size = 2 ** shift;
		this._first = first;
		this._origin = origin;
		this.spacing = spacing;
		const single = spacing / SINGLE_BAR_GAP;
		this._headPace = single;
		this._tailPace = single;
		if (count >= 2) {
			this._headPace = this._endPace(0, Math.min(count - 1, END_SEGMENTS));
			this._tailPace = this._endPace(Math.max(0, count - 1 - END_SEGMENTS), count - 1);
		}
		this._segment = -2;
	}

	/** Pace of the fastest of segments `[from, to)`: gaps in trading (a night, a weekend) do not set it. */
	private _endPace(from: number, to: number): number {
		const times = this.times;
		let pace = 0;
		for (let k = from; k < to; k++) {
			const gap = times[k + 1]! - times[k]!;
			if (gap > 0) {
				pace = Math.max(pace, (this.knotX(k + 1) - this.knotX(k)) / gap);
			}
		}
		return pace > 0 ? pace : this.spacing / SINGLE_BAR_GAP;
	}

	/** Device x of knot `k`: the center of its row, or of the first row of its bucket. */
	public knotX(k: number): number {
		return this._origin + Math.max((this._start + k) * this._size, this._first) * this.spacing;
	}

	/**
	 * Loads the segment that holds `time` (`t0`, `t1`, `x0`, `pace`): the one between two knots, or
	 * the stretch before the first knot or after the last. Times at or after `t1` are in a later one.
	 */
	public segment(time: number): void {
		const times = this.times;
		const count = this.count;
		if (count === 0) {
			this.t0 = 0;
			this.t1 = Infinity;
			this.x0 = Number.NaN;
			this.pace = 0;
			return;
		}
		// Last knot at or before the time; -1 before the first.
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
		this._load(lo - 1);
	}

	/** Loads the segment after the one loaded: for times at or after `t1`. */
	public next(): void {
		this._load(this._segment + 1);
	}

	private _load(k: number): void {
		const times = this.times;
		const count = this.count;
		this._segment = k;
		if (k < 0) {
			this.t0 = times[0]!;
			this.t1 = this.t0;
			this.x0 = this.knotX(0);
			this.pace = this._headPace;
			return;
		}
		if (k >= count - 1) {
			this._segment = count - 1;
			this.t0 = times[count - 1]!;
			this.t1 = Infinity;
			this.x0 = this.knotX(count - 1);
			this.pace = this._tailPace;
			return;
		}
		const t0 = times[k]!;
		const t1 = times[k + 1]!;
		const x0 = this.knotX(k);
		this.t0 = t0;
		this.t1 = t1;
		this.x0 = x0;
		this.pace = t1 > t0 ? (this.knotX(k + 1) - x0) / (t1 - t0) : 0;
	}

	/** Device x of a time; NaN without bars. */
	public x(time: number): number {
		this.segment(time);
		return this.x0 + (time - this.t0) * this.pace;
	}

	/** The time drawn at device x; NaN without bars. */
	public time(x: number): number {
		const count = this.count;
		if (count === 0) {
			return Number.NaN;
		}
		// Last knot at or left of x.
		let lo = 0;
		let hi = count;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (this.knotX(mid) <= x) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		this._load(lo - 1);
		return this.pace > 0 ? this.t0 + (x - this.x0) / this.pace : this.t0;
	}
}
