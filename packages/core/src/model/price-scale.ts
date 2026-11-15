/** Largest share of the pane height the two margins may take together. */
const MAX_MARGINS = 0.95;
const MIN_DECIMALS = 2;
const MAX_DECIMALS = 8;
const MAX_TICKS = 64;

/**
 * Linear price scale that fits `[min, max]` between margins at the top and bottom of the pane.
 * Tick positions and labels are recomputed only when the range or height changes.
 */
export class PriceScale {
	/** Height of the pane in CSS pixels. */
	public height = 0;
	public min = 0;
	public max = 1;
	/** Increases whenever the mapping between prices and pixels changes. */
	public version = 0;

	public tickCount = 0;
	public readonly tickPrices = new Float64Array(MAX_TICKS);
	public readonly tickLabels: string[] = [];
	public decimals = MIN_DECIMALS;

	private _top = 0;
	private _scale = 1;
	private _topMargin = 0.1;
	private _bottomMargin = 0.1;
	private _ticksVersion = -1;
	private _ticksSpacing = 0;
	private readonly _labels = new Map<number, string>();

	public setHeight(height: number): void {
		if (height === this.height) {
			return;
		}
		this.height = height;
		this._update();
	}

	/** Empty space above and below the prices, as fractions of the height. */
	public setMargins(top: number, bottom: number): void {
		let t = top > 0 ? top : 0;
		let b = bottom > 0 ? bottom : 0;
		if (t + b > MAX_MARGINS) {
			const shrink = MAX_MARGINS / (t + b);
			t *= shrink;
			b *= shrink;
		}
		if (t === this._topMargin && b === this._bottomMargin) {
			return;
		}
		this._topMargin = t;
		this._bottomMargin = b;
		this._update();
	}

	/** Sets the visible price range. A degenerate range is widened so it still maps to pixels. */
	public setRange(min: number, max: number): void {
		if (!(min <= max)) {
			return;
		}
		if (min === max) {
			const pad = min === 0 ? 1 : Math.abs(min) * 0.01;
			min -= pad;
			max += pad;
		}
		if (min === this.min && max === this.max) {
			return;
		}
		this.min = min;
		this.max = max;
		this._update();
	}

	public priceToY(price: number): number {
		return this._top + (this.max - price) * this._scale;
	}

	/** With `scale`, the linear form of `priceToY`: `y = offset - price * scale`. */
	public get offset(): number {
		return this._top + this.max * this._scale;
	}

	/** CSS pixels per unit of price. */
	public get scale(): number {
		return this._scale;
	}

	public yToPrice(y: number): number {
		return this.max - (y - this._top) / this._scale;
	}

	public format(price: number): string {
		return price.toFixed(this.decimals);
	}

	/** Recomputes ticks at least `spacing` CSS pixels apart, if the scale changed since the last call. */
	public updateTicks(spacing: number): void {
		if (this._ticksVersion === this.version && this._ticksSpacing === spacing) {
			return;
		}
		this._ticksVersion = this.version;
		this._ticksSpacing = spacing;
		this.tickCount = 0;
		if (this.height <= 0) {
			return;
		}
		const step = niceStep(spacing / this._scale);
		const decimals = Math.min(MAX_DECIMALS, Math.max(MIN_DECIMALS, -Math.floor(Math.log10(step) + 1e-9)));
		if (decimals !== this.decimals || this._labels.size > 512) {
			this.decimals = decimals;
			this._labels.clear();
		}
		const low = Math.ceil(this.yToPrice(this.height) / step);
		const high = Math.floor(this.yToPrice(0) / step);
		let count = 0;
		for (let k = low; k <= high && count < MAX_TICKS; k++) {
			// Multiplying the integer keeps ticks free of accumulated rounding error.
			const price = k * step;
			let label = this._labels.get(price);
			if (label === undefined) {
				label = price.toFixed(decimals);
				this._labels.set(price, label);
			}
			this.tickPrices[count] = price;
			this.tickLabels[count] = label;
			count++;
		}
		this.tickCount = count;
	}

	private _update(): void {
		const top = this.height * this._topMargin;
		const inner = Math.max(1, this.height * (1 - this._topMargin - this._bottomMargin));
		this._top = top;
		this._scale = inner / (this.max - this.min);
		this.version++;
	}
}

/** Smallest of 1, 2, 5 times a power of ten that is not below `raw`. */
export function niceStep(raw: number): number {
	if (!(raw > 0) || !Number.isFinite(raw)) {
		return 1;
	}
	const power = 10 ** Math.floor(Math.log10(raw));
	const fraction = raw / power;
	const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
	return nice * power;
}
