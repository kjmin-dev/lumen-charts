import type { PriceScaleMode } from '../options';

/** Largest share of the pane height the two margins may take together. */
const MAX_MARGINS = 0.95;
const MIN_DECIMALS = 2;
const MAX_DECIMALS = 8;
const MAX_TICKS = 64;
/** Labels kept for reuse before the cache is cleared. */
const MAX_LABELS = 512;
/** Below this ratio of its top to its bottom, a logarithmic scale puts ticks a fixed step apart. */
const LOG_UNIFORM_SPAN = 3;

/**
 * Maps prices to vertical positions in the pane, in CSS pixels from its top.
 *
 * A scale works on values, which depend on its mode: the price itself (`normal`), its decimal
 * logarithm (`logarithmic`), its change in percent from a base price (`percentage`), or the price
 * as an index on which the base is 100 (`indexed`). The base is the price of a series at the first
 * visible bar, so every series on a percentage or indexed scale has a base of its own; conversions
 * that take no base use `base`, that of the scale's first series. Values map to coordinates
 * linearly: `y = offset - value * scale`, with `scale` negative on an inverted scale.
 *
 * The visible range `[min, max]` is in values, fitted between margins at the top and the bottom.
 * Tick positions and labels are recomputed only when the range, the height or the format changes.
 */
export class PriceScale {
	public readonly id: string;
	/** Height of the pane in CSS pixels. */
	public height = 0;
	/** CSS coordinates in the chart's shared plot area. */
	public top = 0;
	public contains(y: number): boolean {
		return y >= this.top && y < this.top + this.height;
	}
	/** Visible range, in values of the scale. */
	public min = 0;
	public max = 1;
	/** Whether a range was set since the scale was made or its mode changed. */
	public hasRange = false;
	/** Increases whenever the mapping between values and coordinates changes. */
	public version = 0;
	public mode: PriceScaleMode = 'normal';
	public inverted = false;
	/** Base price of the scale's first series, for percentage and indexed modes; NaN otherwise. */
	public base = Number.NaN;

	public tickCount = 0;
	/** Tick positions, in values of the scale, bottom to top. */
	public readonly tickValues = new Float64Array(MAX_TICKS);
	public readonly tickLabels: string[] = [];
	/** Increases whenever the ticks are recomputed or cleared. */
	public ticksGeneration = 0;
	/** Decimals of the labels. */
	public decimals = MIN_DECIMALS;
	/** Tick size of the prices; 0 picks the decimals from the tick step. */
	public minMove = 0;
	/** Decimals of the prices; -1 takes those of `minMove`. */
	public precision = -1;
	/** Increases whenever labels of the same price could read differently. */
	public formatVersion = 0;

	private _offset = 0;
	private _scale = 1;
	private _topMargin = 0.1;
	private _bottomMargin = 0.1;
	private _ticksVersion = -1;
	private _ticksSpacing = 0;
	private readonly _labels = new Map<number, string>();
	/** Prices of the ticks of a logarithmic scale, before their labels are made. */
	private readonly _tickPrices = new Float64Array(MAX_TICKS);

	public constructor(id = '') {
		this.id = id;
		this._update();
	}

	public setHeight(height: number, top = 0): void {
		if (height === this.height && top === this.top) {
			return;
		}
		this.height = height;
		this.top = top;
		this._update();
	}

	/** Empty space above and below the values, as fractions of the height. */
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

	/** Changes the mode. The range is in other units afterwards, so it has to be set again. */
	public setMode(mode: PriceScaleMode): void {
		if (mode === this.mode) {
			return;
		}
		this.mode = mode;
		this.hasRange = false;
		this._formatChanged();
		this._update();
	}

	/** Puts the lowest value at the top. */
	public setInverted(inverted: boolean): void {
		if (inverted === this.inverted) {
			return;
		}
		this.inverted = inverted;
		this._update();
	}

	/** Tick size and decimals of the prices (see `SeriesOptionsCommon.minMove`). */
	public setFormat(minMove: number, precision: number): void {
		const move = minMove > 0 && minMove < Infinity ? minMove : 0;
		const digits = precision >= 0 ? Math.min(MAX_DECIMALS * 2, Math.floor(precision)) : -1;
		if (move === this.minMove && digits === this.precision) {
			return;
		}
		this.minMove = move;
		this.precision = digits;
		this._formatChanged();
		// Ticks fall on multiples of the tick size, so they have to be placed again.
		this._ticksVersion = -1;
	}

	/** Sets the visible range in values. A degenerate range is widened so it still maps to pixels. */
	public setRange(min: number, max: number): void {
		if (!(min <= max) || !Number.isFinite(min) || !Number.isFinite(max)) {
			return;
		}
		if (min === max) {
			const pad = min === 0 ? 1 : Math.abs(min) * 0.01;
			min -= pad;
			max += pad;
		}
		this.hasRange = true;
		if (min === this.min && max === this.max) {
			return;
		}
		this.min = min;
		this.max = max;
		this._update();
	}

	/** Scales the range around its middle: a factor above 1 shows more. */
	public zoom(factor: number): void {
		if (!this.hasRange || !(factor > 0) || factor === Infinity) {
			return;
		}
		const middle = (this.min + this.max) / 2;
		const half = ((this.max - this.min) / 2) * factor;
		// Keep a range that still has distinct ends and finite pixels per value.
		if (!(half > Math.max(1, Math.abs(middle)) * 1e-12) || !(half < 1e300)) {
			return;
		}
		this.min = middle - half;
		this.max = middle + half;
		this._update();
	}

	/**
	 * Scales the range around the value at `y` (CSS pixels), which stays at `y`: a factor above 1
	 * shows more.
	 */
	public zoomAt(y: number, factor: number): void {
		if (!this.hasRange || !(factor > 0) || factor === Infinity || !Number.isFinite(y)) {
			return;
		}
		const value = this.yToValue(y);
		const min = value - (value - this.min) * factor;
		const max = value + (this.max - value) * factor;
		const half = (max - min) / 2;
		// As `zoom`: a range that still has distinct ends and finite pixels per value.
		if (!(half > Math.max(1, Math.abs(min + half)) * 1e-12) || !(half < 1e300)) {
			return;
		}
		this.min = min;
		this.max = max;
		this._update();
	}

	/** Moves the range so the values follow a drag of `dy` CSS pixels (down is positive). */
	public scrollBy(dy: number): void {
		if (!this.hasRange || dy === 0 || !Number.isFinite(dy)) {
			return;
		}
		const delta = dy / this._scale;
		this.min += delta;
		this.max += delta;
		this._update();
	}

	/** The value of a price; NaN for a price the scale cannot show. */
	public toValue(price: number, base = this.base): number {
		switch (this.mode) {
			case 'normal':
				return price;
			case 'logarithmic':
				return price > 0 ? Math.log10(price) : Number.NaN;
			case 'percentage':
				return ((price - base) / Math.abs(base)) * 100;
			case 'indexed':
				return ((price - base) / Math.abs(base)) * 100 + 100;
		}
	}

	/** The price of a value. */
	public fromValue(value: number, base = this.base): number {
		switch (this.mode) {
			case 'normal':
				return value;
			case 'logarithmic':
				return 10 ** value;
			case 'percentage':
				return base + (value / 100) * Math.abs(base);
			case 'indexed':
				return base + ((value - 100) / 100) * Math.abs(base);
		}
	}

	public valueToY(value: number): number {
		return this._offset - value * this._scale;
	}

	public yToValue(y: number): number {
		return (this._offset - y) / this._scale;
	}

	public priceToY(price: number, base = this.base): number {
		return this.valueToY(this.toValue(price, base));
	}

	public yToPrice(y: number, base = this.base): number {
		return this.fromValue(this.yToValue(y), base);
	}

	/** With `scale`, the linear form of `valueToY`: `y = offset - value * scale`. */
	public get offset(): number {
		return this._offset;
	}

	/** CSS pixels per unit of value; negative when the scale is inverted. */
	public get scale(): number {
		return this._scale;
	}

	/** A value as the axis shows it: a price, or a percentage or index value. */
	public formatValue(value: number): string {
		switch (this.mode) {
			case 'normal':
				return this.formatPrice(value);
			case 'logarithmic':
				return this.formatPrice(10 ** value);
			case 'percentage':
				return `${fixed(value, this.decimals)}%`;
			case 'indexed':
				return fixed(value, this.decimals);
		}
	}

	/**
	 * A price as a label shows it: in normal and logarithmic modes the price, rounded to `minMove`
	 * with the decimals of the format given (the scale's own by default); in the other modes its value.
	 */
	public format(price: number, base = this.base, minMove = this.minMove, precision = this.precision): string {
		if (this.mode === 'percentage' || this.mode === 'indexed') {
			return this.formatValue(this.toValue(price, base));
		}
		return this.formatPrice(price, minMove, precision);
	}

	/** A price rounded to the tick size, with the decimals of the format. */
	public formatPrice(price: number, minMove = this.minMove, precision = this.precision): string {
		let rounded = price;
		if (minMove > 0) {
			rounded = Math.round(price / minMove) * minMove;
		}
		const decimals = precision >= 0 ? precision : minMove > 0 ? decimalsOf(minMove) : this.decimals;
		return fixed(rounded, decimals);
	}

	/** Forgets the ticks, for a scale with nothing to show. */
	public clearTicks(): void {
		if (this.tickCount === 0 && this._ticksVersion === -1) {
			return;
		}
		this.tickCount = 0;
		this._ticksVersion = -1;
		this.ticksGeneration++;
	}

	/**
	 * Recomputes ticks at least `spacing` CSS pixels apart, if the scale changed since the last call.
	 * Ticks are round values: multiples of 1, 2 or 5 times a power of ten (and of the tick size) on a
	 * linear scale; on a logarithmic one, round prices whose step grows with the price.
	 *
	 * Ticks cover the pane, but not more than `spacing` pixels beyond the range: a scale whose margins
	 * keep it in a band of the pane (an oscillator below the prices) labels that band only.
	 */
	public updateTicks(spacing: number): void {
		if (this._ticksVersion === this.version && this._ticksSpacing === spacing) {
			return;
		}
		this._ticksVersion = this.version;
		this._ticksSpacing = spacing;
		this.ticksGeneration++;
		this.tickCount = 0;
		if (this.height <= 0 || !this.hasRange) {
			return;
		}
		const a = this.yToValue(this.top);
		const b = this.yToValue(this.top + this.height);
		const reach = spacing / Math.abs(this._scale);
		const low = Math.max(Math.min(a, b), this.min - reach);
		const high = Math.min(Math.max(a, b), this.max + reach);
		if (this.mode === 'logarithmic') {
			this._logTicks(spacing, low, high);
		} else {
			this._linearTicks(spacing, low, high);
		}
	}

	/** Ticks of a linear scale between the values `from` and `to`, bottom to top. */
	private _linearTicks(spacing: number, from: number, to: number): void {
		const step = this._step(spacing / Math.abs(this._scale), this.mode === 'normal');
		this._setDecimals(step);
		const low = Math.ceil(from / step);
		const high = Math.floor(to / step);
		const percent = this.mode === 'percentage';
		let count = 0;
		for (let k = low; k <= high && count < MAX_TICKS; k++) {
			// Multiplying the integer keeps ticks free of accumulated rounding error.
			const value = k * step;
			let label = this._labels.get(value);
			if (label === undefined) {
				label = percent ? `${fixed(value, this.decimals)}%` : fixed(value, this.decimals);
				this._labels.set(value, label);
			}
			this.tickValues[count] = value;
			this.tickLabels[count] = label;
			count++;
		}
		this.tickCount = count;
	}

	/**
	 * Ticks of a logarithmic scale between the values `from` and `to`, bottom to top, on round prices
	 * at least `spacing` pixels apart.
	 *
	 * Over a range of less than a factor of `LOG_UNIFORM_SPAN`, the ticks are multiples of one step,
	 * the one the top needs, and look like those of a linear scale. Over a wider range the step grows
	 * with the price: each next tick is the first multiple of the round step nearest to the distance
	 * to the price `spacing` pixels higher (1, 2, 4, 10, 20, 40, ... over decades; every decade or
	 * every few once decades get narrow).
	 */
	private _logTicks(spacing: number, from: number, to: number): void {
		const bottom = 10 ** from;
		const top = 10 ** to;
		// The price ratio `spacing` pixels span.
		const ratio = 10 ** (spacing / Math.abs(this._scale));
		const uniform = top < bottom * LOG_UNIFORM_SPAN;
		const prices = this._tickPrices;
		let step = this._step((uniform ? top / ratio : bottom) * (ratio - 1), true);
		let tick = Math.ceil(bottom / step - 1e-9) * step;
		// Steps grow with the price, so the first one is the finest and sets the decimals.
		const finest = step;
		let count = 0;
		while (tick <= top * (1 + 1e-12) && count < MAX_TICKS) {
			prices[count++] = tick;
			if (uniform) {
				tick = Math.round(tick / step + 1) * step;
			} else {
				const price = tick * ratio;
				step = this._step(price - tick, true);
				tick = Math.ceil(price / step - 1e-9) * step;
			}
		}
		this._setDecimals(finest);
		for (let i = 0; i < count; i++) {
			const tickPrice = prices[i]!;
			let label = this._labels.get(tickPrice);
			if (label === undefined) {
				label = this.formatPrice(tickPrice);
				this._labels.set(tickPrice, label);
			}
			this.tickValues[i] = Math.log10(tickPrice);
			this.tickLabels[i] = label;
		}
		this.tickCount = count;
	}

	/** A round step not below `raw`; for prices, a multiple of the tick size. */
	private _step(raw: number, prices: boolean): number {
		const move = prices ? this.minMove : 0;
		return move > 0 ? move * Math.max(1, niceStep(raw / move)) : niceStep(raw);
	}

	/** Decimals for labels `step` apart: those of the format, or as many as the step needs. */
	private _setDecimals(step: number): void {
		const formatted = this.mode === 'normal' || this.mode === 'logarithmic';
		let decimals: number;
		if (formatted && this.precision >= 0) {
			decimals = this.precision;
		} else if (formatted && this.minMove > 0) {
			decimals = decimalsOf(this.minMove);
		} else {
			decimals = Math.min(MAX_DECIMALS, Math.max(MIN_DECIMALS, -Math.floor(Math.log10(step) + 1e-9)));
		}
		if (decimals !== this.decimals || this._labels.size > MAX_LABELS) {
			this.decimals = decimals;
			this._labels.clear();
			this.formatVersion++;
		}
	}

	private _formatChanged(): void {
		this._labels.clear();
		this.formatVersion++;
		this.version++;
	}

	private _update(): void {
		const top = this.top + this.height * this._topMargin;
		const inner = Math.max(1, this.height * (1 - this._topMargin - this._bottomMargin));
		const k = inner / (this.max - this.min);
		if (this.inverted) {
			this._offset = top - this.min * k;
			this._scale = -k;
		} else {
			this._offset = top + this.max * k;
			this._scale = k;
		}
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

/** Decimals of a tick size: 0.25 has 2, 0.001 has 3, 5 has none. */
export function decimalsOf(minMove: number): number {
	for (let decimals = 0; decimals < MAX_DECIMALS * 2; decimals++) {
		const scaled = minMove * 10 ** decimals;
		if (Math.abs(scaled - Math.round(scaled)) <= scaled * 1e-9) {
			return decimals;
		}
	}
	return MAX_DECIMALS * 2;
}

/** `value` with `decimals` decimals, without a sign on a value that rounds to zero. */
function fixed(value: number, decimals: number): string {
	return (Math.abs(value) < 0.5 * 10 ** -decimals ? 0 : value).toFixed(decimals);
}
