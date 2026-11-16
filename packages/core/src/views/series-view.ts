/**
 * Where bars land on the canvas, in device pixels: bar `i` is centered at `origin + i * spacing`.
 *
 * The source of the items is either raw rows (`shift` 0) or the buckets of a coarse level, each
 * holding `2^shift` rows. `from` and `to` bound the visible source elements (rows or buckets, `to`
 * exclusive), and `firstRow` is the main-timeline index of the first row of element `from` (later
 * than `from << shift` when the data starts inside that bucket).
 */
export interface Geometry {
	origin: number;
	spacing: number;
	from: number;
	to: number;
	shift: number;
	firstRow: number;
}

/**
 * Sets the visible elements of `geometry` (`from`, `to`, `firstRow`) for rows `[from, to)` of a
 * timeline that starts at row `first`, given its `spacing` and `shift`. Below a pixel per element
 * only whole elements are shown: those whose first row is visible, so a merged pixel column never
 * holds part of a bucket. Otherwise every element that overlaps the rows is shown.
 */
export function placeElements(geometry: Geometry, from: number, to: number, first: number): void {
	const size = 2 ** geometry.shift;
	if (to <= from) {
		geometry.from = 0;
		geometry.to = 0;
		geometry.firstRow = 0;
		return;
	}
	if (geometry.spacing * size < 1) {
		// The first bucket of the data starts at its first row, wherever that is in the bucket.
		geometry.from = from === first ? Math.floor(from / size) : Math.ceil(from / size);
		geometry.to = Math.ceil(to / size);
	} else {
		geometry.from = Math.floor(from / size);
		geometry.to = Math.floor((to - 1) / size) + 1;
	}
	geometry.firstRow = Math.max(geometry.from * size, first);
}

/**
 * Turns the visible bars of one series into drawable items.
 *
 * While an element (a bar, or a bucket of bars) is at least one device pixel wide, every element is
 * an item. Below that, all elements that fall into the same pixel column are merged into one item
 * (first open, highest high, lowest low, last close), so the number of items never exceeds the
 * width of the canvas in device pixels. A line series is the same thing with one value standing in
 * for all four prices, which keeps the extremes of a merged column instead of only its last value.
 *
 * An element belongs to the pixel column of its first row. Raw rows and buckets therefore merge
 * the same way: with the origin on a whole pixel and `2^shift` bars per pixel, the column
 * boundaries fall on bucket boundaries and both sources give exactly the same items. A merged
 * column always holds whole elements, so the price range of the items is exact for the rows drawn.
 *
 * Items are kept between frames. A tick only re-merges the columns it touched.
 */
export class SeriesView {
	public count = 0;
	/** True when items are merged pixel columns rather than single elements. */
	public merged = false;

	/** Prices per item. */
	public open = new Float64Array(0);
	public high = new Float64Array(0);
	public low = new Float64Array(0);
	public close = new Float64Array(0);

	/** Device-pixel coordinates per item, filled by `project`. */
	public x = new Float32Array(0);
	public yOpen = new Float32Array(0);
	public yHigh = new Float32Array(0);
	public yLow = new Float32Array(0);
	public yClose = new Float32Array(0);
	/** 1 where the close is not below the open. */
	public up = new Uint8Array(0);

	/** Width of a candle body in device pixels, set before a custom renderer draws the items. */
	public barWidth = 1;

	/** Price range of the items, or an empty range (`min > max`) when there is nothing to show. */
	public min = Infinity;
	public max = -Infinity;

	private _version = -1;
	private _origin = NaN;
	private _spacing = NaN;
	private _from = 0;
	private _to = 0;
	private _shift = 0;
	private _firstRow = 0;
	private _firstColumn = 0;

	/**
	 * Rebuilds the items for the given geometry.
	 *
	 * @param open,high,low,close columns of a window (the same array four times for a raw line)
	 * @param cacheStart index of element 0 of those columns
	 * @param version changes when the columns are replaced
	 * @param dirtyLo,dirtyHi elements changed in place since the last call
	 */
	public update(
		geometry: Geometry,
		open: Float64Array,
		high: Float64Array,
		low: Float64Array,
		close: Float64Array,
		cacheStart: number,
		version: number,
		dirtyLo: number,
		dirtyHi: number,
	): void {
		const { origin, spacing, from, to, shift, firstRow } = geometry;
		if (to <= from) {
			this.count = 0;
			this._version = -1;
			this.min = Infinity;
			this.max = -Infinity;
			return;
		}
		const size = 2 ** shift;
		const merged = spacing * size < 1;
		const firstColumn = merged ? Math.floor(origin + firstRow * spacing) : 0;
		const lastRow = to - 1 === from ? firstRow : (to - 1) * size;
		const count = merged ? Math.floor(origin + lastRow * spacing) - firstColumn + 1 : to - from;
		const same =
			version === this._version &&
			origin === this._origin &&
			spacing === this._spacing &&
			from === this._from &&
			to === this._to &&
			shift === this._shift &&
			firstRow === this._firstRow;

		let itemFrom = 0;
		let itemTo = count;
		if (same) {
			if (dirtyHi <= dirtyLo) {
				return;
			}
			// Only the items that contain changed elements are rebuilt.
			const lo = Math.max(dirtyLo, from);
			const hi = Math.min(dirtyHi, to);
			if (hi <= lo) {
				return;
			}
			if (merged) {
				itemFrom = Math.max(0, Math.floor(origin + lo * size * spacing) - firstColumn - 1);
				itemTo = Math.min(count, Math.floor(origin + (hi - 1) * size * spacing) - firstColumn + 2);
			} else {
				itemFrom = lo - from;
				itemTo = hi - from;
			}
		} else {
			this._ensure(count);
			this._version = version;
			this._origin = origin;
			this._spacing = spacing;
			this._from = from;
			this._to = to;
			this._shift = shift;
			this._firstRow = firstRow;
			this._firstColumn = firstColumn;
			this.count = count;
			this.merged = merged;
		}

		const itemOpen = this.open;
		const itemHigh = this.high;
		const itemLow = this.low;
		const itemClose = this.close;
		const itemX = this.x;
		if (merged) {
			// Column `p` holds the rows whose center falls in [p, p + 1), and the elements whose first
			// row is one of them. Both ends of a column use the same expression, so neighboring columns
			// can never overlap or leave an element out; the first and last column take everything up
			// to the ends of the visible elements.
			const base = firstColumn - origin;
			const last = count - 1;
			// A raw line passes one column for all four prices and needs only one read per row.
			const single = high === low;
			let rowFrom =
				itemFrom === 0
					? from - cacheStart
					: Math.min(to, Math.max(from, Math.ceil(Math.ceil((base + itemFrom) / spacing) / size))) - cacheStart;
			for (let k = itemFrom; k < itemTo; k++) {
				const rowTo =
					k === last
						? to - cacheStart
						: Math.min(to, Math.max(from, Math.ceil(Math.ceil((base + k + 1) / spacing) / size))) - cacheStart;
				let max = -Infinity;
				let min = Infinity;
				if (single) {
					for (let row = rowFrom; row < rowTo; row++) {
						const value = high[row]!;
						// Rows without a value are skipped. `Math.max` and `Math.min` compile to one
						// instruction each, where a comparison is a branch that prices mispredict.
						if (value === value) {
							max = Math.max(max, value);
							min = Math.min(min, value);
						}
					}
				} else {
					for (let row = rowFrom; row < rowTo; row++) {
						const h = high[row]!;
						const l = low[row]!;
						if (h === h) {
							max = Math.max(max, h);
						}
						if (l === l) {
							min = Math.min(min, l);
						}
					}
				}
				if (max === -Infinity || min === Infinity) {
					itemOpen[k] = NaN;
					itemHigh[k] = NaN;
					itemLow[k] = NaN;
					itemClose[k] = NaN;
				} else {
					let first = rowFrom;
					while (first < rowTo - 1 && open[first]! !== open[first]!) {
						first++;
					}
					let latest = rowTo - 1;
					while (latest > rowFrom && close[latest]! !== close[latest]!) {
						latest--;
					}
					itemOpen[k] = open[first]!;
					itemHigh[k] = max;
					itemLow[k] = min;
					itemClose[k] = close[latest]!;
				}
				itemX[k] = firstColumn + k;
				rowFrom = rowTo;
			}
		} else {
			const offset = from - cacheStart;
			// An element is drawn at the center of its rows.
			const center = (size - 1) / 2;
			for (let k = itemFrom; k < itemTo; k++) {
				const row = offset + k;
				itemOpen[k] = open[row]!;
				itemHigh[k] = high[row]!;
				itemLow[k] = low[row]!;
				itemClose[k] = close[row]!;
				itemX[k] = Math.round(origin + ((from + k) * size + center) * spacing);
			}
		}

		let min = Infinity;
		let max = -Infinity;
		for (let k = 0; k < count; k++) {
			const h = itemHigh[k]!;
			const l = itemLow[k]!;
			if (h === h) {
				max = Math.max(max, h);
			}
			if (l === l) {
				min = Math.min(min, l);
			}
		}
		this.min = min;
		this.max = max;
	}

	/**
	 * Converts item prices to device-pixel rows: `y = offset - value * scale`, where the value is the
	 * price, or its decimal logarithm with `log` (NaN, so not drawn, for prices at or below zero).
	 * Candles snap to whole pixels so their edges stay sharp; lines keep fractions.
	 *
	 * `yHigh` and `yLow` always get the upper and the lower row of an item: on an inverted scale
	 * (`scale` below zero) the high is the lower one, and they swap. `up` keeps telling the direction
	 * of the prices.
	 */
	public project(offset: number, scale: number, snap: boolean, log = false): void {
		const count = this.count;
		const { open, high, low, close, yOpen, yClose, up } = this;
		const yHigh = scale < 0 ? this.yLow : this.yHigh;
		const yLow = scale < 0 ? this.yHigh : this.yLow;
		if (log) {
			for (let k = 0; k < count; k++) {
				const o = open[k]!;
				const h = high[k]!;
				const l = low[k]!;
				const c = close[k]!;
				const yo = offset - (o > 0 ? Math.log10(o) : Number.NaN) * scale;
				const yh = offset - (h > 0 ? Math.log10(h) : Number.NaN) * scale;
				const yl = offset - (l > 0 ? Math.log10(l) : Number.NaN) * scale;
				const yc = offset - (c > 0 ? Math.log10(c) : Number.NaN) * scale;
				if (snap) {
					yOpen[k] = Math.round(yo);
					yHigh[k] = Math.round(yh);
					yLow[k] = Math.round(yl);
					yClose[k] = Math.round(yc);
					up[k] = c >= o ? 1 : 0;
				} else {
					yOpen[k] = yo;
					yHigh[k] = yh;
					yLow[k] = yl;
					yClose[k] = yc;
				}
			}
		} else if (snap) {
			for (let k = 0; k < count; k++) {
				const o = open[k]!;
				const c = close[k]!;
				yOpen[k] = Math.round(offset - o * scale);
				yHigh[k] = Math.round(offset - high[k]! * scale);
				yLow[k] = Math.round(offset - low[k]! * scale);
				yClose[k] = Math.round(offset - c * scale);
				up[k] = c >= o ? 1 : 0;
			}
		} else {
			for (let k = 0; k < count; k++) {
				yOpen[k] = offset - open[k]! * scale;
				yHigh[k] = offset - high[k]! * scale;
				yLow[k] = offset - low[k]! * scale;
				yClose[k] = offset - close[k]! * scale;
			}
		}
	}

	/**
	 * Lowest price above zero among the items, Infinity if there is none. Autoscale on a logarithmic
	 * scale needs it when the items reach zero or below.
	 */
	public lowestPositive(): number {
		const { open, high, low, close, count } = this;
		let lowest = Infinity;
		for (let k = 0; k < count; k++) {
			const l = low[k]!;
			if (l > 0) {
				if (l < lowest) {
					lowest = l;
				}
				continue;
			}
			// The low is not above zero, but the other prices may be.
			const o = open[k]!;
			const h = high[k]!;
			const c = close[k]!;
			if (o > 0 && o < lowest) {
				lowest = o;
			}
			if (c > 0 && c < lowest) {
				lowest = c;
			}
			if (h > 0 && h < lowest) {
				lowest = h;
			}
		}
		return lowest;
	}

	/** Forgets the kept items, for example after the source columns were swapped. */
	public reset(): void {
		this._version = -1;
		this.count = 0;
		this.min = Infinity;
		this.max = -Infinity;
	}

	private _ensure(count: number): void {
		if (this.open.length >= count) {
			return;
		}
		// Grow in steps so a slowly widening view does not reallocate every frame.
		const size = Math.max(count, Math.ceil(this.open.length * 1.5), 256);
		this.open = new Float64Array(size);
		this.high = new Float64Array(size);
		this.low = new Float64Array(size);
		this.close = new Float64Array(size);
		this.x = new Float32Array(size);
		this.yOpen = new Float32Array(size);
		this.yHigh = new Float32Array(size);
		this.yLow = new Float32Array(size);
		this.yClose = new Float32Array(size);
		this.up = new Uint8Array(size);
	}
}

/** Width of a candle body in device pixels for a bar spacing, and the wick width that goes with it. */
export function candleWidths(spacing: number, pixelRatio: number, out: { body: number; wick: number }): void {
	let wick = Math.max(1, Math.floor(pixelRatio));
	let body = Math.max(1, Math.floor(spacing * 0.8));
	// Leave at least one pixel between neighboring bodies once there is room for it.
	if (spacing >= 2) {
		body = Math.max(1, Math.min(body, Math.floor(spacing) - 1));
	}
	if (wick > body) {
		wick = body;
	}
	// Body and wick need the same parity, or the wick cannot sit in the middle of the body.
	if ((body - wick) % 2 !== 0) {
		body--;
	}
	out.body = body;
	out.wick = wick;
}
