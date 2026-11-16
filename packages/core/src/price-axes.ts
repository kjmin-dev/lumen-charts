import type { AxisTarget } from './input/interaction';
import { INVALIDATE_LIGHT, type Invalidation } from './model/invalidation';
import { PriceScale } from './model/price-scale';
import type { DeepPartial, PriceScaleOptions } from './options';
import type { Layer } from './render/layer';
import type { Series } from './series';

/** A range of values of a price scale, `from` below `to`. */
export interface PriceRange {
	from: number;
	to: number;
}

/**
 * A price scale of the chart. Its values are prices on a normal or logarithmic scale, and changes
 * in percent or index values on a percentage or indexed one (see `PriceScaleMode`). Ranges and
 * coordinates are those of the last frame drawn; coordinates are CSS pixels from the top of the
 * pane.
 */
export interface PriceScaleApi {
	/** `default` for the scale `ChartOptions.priceScale` configures, or the id series name it by. */
	readonly id: string;
	/** Merges options, like `chart.applyOptions({ priceScales: { [id]: options } })`. */
	applyOptions(options: DeepPartial<PriceScaleOptions>): void;
	options(): Readonly<PriceScaleOptions>;
	/** Width of the axis in CSS pixels; 0 for an overlay. */
	width(): number;
	/**
	 * The range of values fitted between the scale's margins: prices on a normal or logarithmic
	 * scale, percent or index values on a percentage or indexed one. Null until the scale has shown
	 * something.
	 */
	getVisibleRange(): PriceRange | null;
	/** Fits these values (in the units of `getVisibleRange`) between the margins and turns autoscale off. */
	setVisibleRange(range: PriceRange): void;
	/**
	 * Where a price is drawn on this scale; on a percentage or indexed scale, relative to the first
	 * series on it (a series' own `priceToCoordinate` uses its own base). Null when the scale has no
	 * range yet or cannot show the price (zero or below on a logarithmic scale).
	 */
	priceToCoordinate(price: number): number | null;
	/** The price drawn at a coordinate: the inverse of `priceToCoordinate`. */
	coordinateToPrice(y: number): number | null;
}

/** What a price axis needs from the chart. */
export interface PriceAxisHost {
	/** Merges options of the scale `id` into the chart's options. */
	applyPriceScaleOptions(id: string, options: DeepPartial<PriceScaleOptions>): void;
	invalidate(level: Invalidation): void;
}

export const MIN_AXIS_WIDTH = 40;

/**
 * A price scale of the chart and what it takes to draw it: its options, its axis canvas (made when
 * the axis is first shown), the axis' place, and the device rows of its ticks. During a model update
 * it also collects the range of the values of its series.
 */
export class PriceAxis implements PriceScaleApi, AxisTarget {
	public readonly id: string;
	public readonly scale: PriceScale;
	public settings: PriceScaleOptions;
	public layer: Layer | null = null;
	/** Place and width of the axis in CSS pixels, while it is visible. */
	public axisLeft = 0;
	public axisWidth = MIN_AXIS_WIDTH;
	/** Device-pixel rows of the ticks. */
	public tickYs = new Float32Array(64);
	/** Tick generation the axis canvas shows, and the one its width was fitted to; -1 forces it. */
	public drawn = -1;
	public fitTicks = -1;
	public fitDigit = -1;

	/** Visible series on the scale, in the last model update. */
	public count = 0;
	/** The first of them, whose price format the axis takes. */
	public first: Series | null = null;
	/** Range of their values in view. */
	public low = Infinity;
	public high = -Infinity;

	private readonly _host: PriceAxisHost;

	public constructor(id: string, host: PriceAxisHost, settings: PriceScaleOptions) {
		this.id = id;
		this.scale = new PriceScale(id);
		this._host = host;
		this.settings = settings;
		this.setSettings(settings);
	}

	/** Takes resolved options and pushes what the scale keeps a copy of. */
	public setSettings(settings: PriceScaleOptions): void {
		this.settings = settings;
		const scale = this.scale;
		scale.setMargins(settings.scaleMargins.top, settings.scaleMargins.bottom);
		scale.setMode(settings.mode);
		scale.setInverted(settings.invertScale);
	}

	/** Starts collecting series and their range for a model update. */
	public beginFrame(): void {
		this.count = 0;
		this.first = null;
		this.low = Infinity;
		this.high = -Infinity;
		this.scale.base = Number.NaN;
	}

	/** Takes values `[low, high]` of a series into the range. */
	public include(low: number, high: number): void {
		// As everywhere an extreme is taken: a bound that is not a number is skipped, and of zeros of
		// both signs the lower is -0 and the higher +0, whatever the order of the series.
		if (low === low) {
			this.low = Math.min(this.low, low);
		}
		if (high === high) {
			this.high = Math.max(this.high, high);
		}
	}

	/** Fits the scale to the range collected, if it autoscales or has no range yet. */
	public fit(): void {
		if (this.count > 0 && this.low <= this.high && (this.settings.autoScale || !this.scale.hasRange)) {
			this.scale.setRange(this.low, this.high);
		}
	}

	// PriceScaleApi

	public applyOptions(options: DeepPartial<PriceScaleOptions>): void {
		this._host.applyPriceScaleOptions(this.id, options);
	}

	public options(): Readonly<PriceScaleOptions> {
		return this.settings;
	}

	public width(): number {
		return this.settings.visible ? this.axisWidth : 0;
	}

	public getVisibleRange(): PriceRange | null {
		const scale = this.scale;
		if (!scale.hasRange) {
			return null;
		}
		return scale.mode === 'logarithmic'
			? { from: 10 ** scale.min, to: 10 ** scale.max }
			: { from: scale.min, to: scale.max };
	}

	public setVisibleRange(range: PriceRange): void {
		let low = Math.min(range.from, range.to);
		let high = Math.max(range.from, range.to);
		if (this.scale.mode === 'logarithmic') {
			if (!(low > 0)) {
				return;
			}
			low = Math.log10(low);
			high = Math.log10(high);
		}
		if (!Number.isFinite(low) || !Number.isFinite(high)) {
			return;
		}
		this._manual();
		this.scale.setRange(low, high);
		this._host.invalidate(INVALIDATE_LIGHT);
	}

	public priceToCoordinate(price: number): number | null {
		if (!this.scale.hasRange) {
			return null;
		}
		const y = this.scale.priceToY(price);
		return Number.isFinite(y) ? y : null;
	}

	public coordinateToPrice(y: number): number | null {
		if (!this.scale.hasRange) {
			return null;
		}
		const price = this.scale.yToPrice(y);
		return Number.isFinite(price) ? price : null;
	}

	// AxisTarget

	/** Scales the axis by a drag of `dy` CSS pixels: down shows more, up less, around the middle. */
	public dragBy(dy: number): void {
		const scale = this.scale;
		if (dy === 0 || !scale.hasRange) {
			return;
		}
		this._manual();
		scale.zoom(Math.exp((dy * 2) / Math.max(1, scale.height)));
		this._host.invalidate(INVALIDATE_LIGHT);
	}

	public resetScale(): void {
		if (!this.settings.autoScale) {
			this._host.applyPriceScaleOptions(this.id, { autoScale: true });
		}
	}

	/** Turns autoscale off, keeping the range in view. */
	private _manual(): void {
		if (this.settings.autoScale) {
			this._host.applyPriceScaleOptions(this.id, { autoScale: false });
		}
	}
}
