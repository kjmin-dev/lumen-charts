import type { AxisTarget } from './input/interaction';
import { INVALIDATE_LIGHT, type Invalidation } from './model/invalidation';
import { PriceScale } from './model/price-scale';
import {
	type ChartOptions,
	DEFAULT_PRICE_SCALE_ID,
	type DeepPartial,
	type PriceScaleOptions,
	overlayScaleOptions,
} from './options';
import type { Layer } from './render/layer';
import type { ChartLayout } from './render/layout';
import type { ChartSettings } from './settings';
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
/** Space between an axis label and the edges of its axis, in CSS pixels. */
export const AXIS_PADDING = 8;
/** The price axis grows as soon as a label needs it but shrinks only past this slack, to avoid jitter. */
const AXIS_SHRINK_SLACK = 12;

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

/**
 * The price scales of a chart with their axes: the default scale, those the `priceScales` option
 * lists, and the overlays series name.
 */
export class PriceAxes {
	/**
	 * Price scales with their axes, in layout order: the default scale, those `priceScales` lists in
	 * its order, then overlays only series named. Axes on one side go outward from the pane in it.
	 */
	public list: PriceAxis[] = [];
	/** The scale whose ticks the horizontal grid lines follow, from the last model update. */
	public grid: PriceAxis;
	private readonly _byId = new Map<string, PriceAxis>();
	private readonly _host: PriceAxisHost;
	private readonly _settings: ChartSettings;
	private readonly _layout: ChartLayout;

	public constructor(host: PriceAxisHost, settings: ChartSettings, layout: ChartLayout) {
		this._host = host;
		this._settings = settings;
		this._layout = layout;
		const main = new PriceAxis(DEFAULT_PRICE_SCALE_ID, host, settings.options.priceScale);
		main.layer = layout.mainAxis;
		this.list.push(main);
		this._byId.set(main.id, main);
		this.grid = main;
	}

	/**
	 * Gives every price scale its options and puts the scales in layout order: the default one, those
	 * `priceScales` lists, then the overlays only series named. Makes the canvases of axes shown for
	 * the first time and hides those of hidden ones.
	 */
	public sync(options: ChartOptions): void {
		const main = this._byId.get(DEFAULT_PRICE_SCALE_ID)!;
		main.setSettings(options.priceScale);
		const ordered = [main];
		for (const id of Object.keys(options.priceScales)) {
			const axis = this.get(id);
			axis.setSettings(options.priceScales[id]!);
			ordered.push(axis);
		}
		const overlay = overlayScaleOptions(this._settings.theme());
		for (const axis of this.list) {
			if (!ordered.includes(axis)) {
				axis.setSettings(overlay);
				ordered.push(axis);
			}
		}
		this.list = ordered;
		for (const axis of ordered) {
			this._syncAxisLayer(axis);
		}
	}

	/** The price scale with this id, made as an overlay if there is none. */
	public get(id: string): PriceAxis {
		let axis = this._byId.get(id);
		if (axis === undefined) {
			axis = new PriceAxis(
				id,
				this._host,
				this._settings.options.priceScales[id] ?? overlayScaleOptions(this._settings.theme()),
			);
			axis.scale.setHeight(this._layout.paneHeight);
			this._byId.set(id, axis);
			this.list.push(axis);
			this._syncAxisLayer(axis);
		}
		return axis;
	}

	/**
	 * Computes the ticks of the visible axes and of the scale the grid follows, about `tickSpacing`
	 * CSS pixels apart, and their rows at the device pixel ratio `ratio`.
	 */
	public updateTicks(tickSpacing: number, ratio: number): void {
		const axes = this.list;
		// The grid follows the default scale, unless it has no series and a visible axis has.
		let grid = axes[0]!;
		if (grid.count === 0) {
			for (const axis of axes) {
				if (axis.settings.visible && axis.count > 0) {
					grid = axis;
					break;
				}
			}
		}
		this.grid = grid;
		for (const axis of axes) {
			const priceScale = axis.scale;
			const first = axis.first;
			if (first !== null) {
				priceScale.setFormat(first.seriesOptions.minMove, first.seriesOptions.precision);
			}
			if (axis !== grid && !axis.settings.visible) {
				continue;
			}
			if (axis.count === 0) {
				priceScale.clearTicks();
				continue;
			}
			priceScale.updateTicks(tickSpacing);
			const count = priceScale.tickCount;
			if (axis.tickYs.length < count) {
				axis.tickYs = new Float32Array(count * 2);
			}
			for (let i = 0; i < count; i++) {
				axis.tickYs[i] = Math.round(priceScale.valueToY(priceScale.tickValues[i]!) * ratio);
			}
		}
	}

	/** The price scale a series is on, following its `priceScaleId`. */
	public of(series: Series): PriceAxis {
		// Options are replaced as a whole on every change: while they are the same, so is the scale.
		const options = series.seriesOptions;
		let axis = series.axis;
		if (axis === null || series.axisOptions !== options) {
			axis = this.get(options.priceScaleId || DEFAULT_PRICE_SCALE_ID);
			series.axis = axis;
			series.axisOptions = options;
		}
		return axis;
	}

	/** Makes the canvas of an axis shown for the first time, below the overlay, and shows or hides it. */
	private _syncAxisLayer(axis: PriceAxis): void {
		if (axis.layer === null && axis.settings.visible) {
			axis.layer = this._layout.addAxisLayer();
		}
		axis.layer?.setVisible(axis.settings.visible);
	}

	/** Has the widths of the axes fitted again by the next frame: fonts or formats may differ. */
	public resetFit(): void {
		for (const axis of this.list) {
			axis.fitTicks = -1;
		}
	}

	/**
	 * Adjusts the widths of the price axes to their longest labels. Returns true if the layout changed.
	 * `empty` says the chart has no bars, and so no labels to fit.
	 */
	public fitWidths(empty: boolean): boolean {
		let changed = false;
		for (const axis of this.list) {
			const priceScale = axis.scale;
			// Labels change only with the ticks, so most frames have nothing to measure.
			if (
				!axis.settings.visible ||
				(priceScale.ticksGeneration === axis.fitTicks && this._layout.digitWidth === axis.fitDigit)
			) {
				continue;
			}
			axis.fitTicks = priceScale.ticksGeneration;
			axis.fitDigit = this._layout.digitWidth;
			if (axis.count === 0 || !priceScale.hasRange || empty) {
				continue;
			}
			let characters = Math.max(
				priceScale.formatValue(priceScale.max).length,
				priceScale.formatValue(priceScale.min).length,
			);
			for (let i = 0; i < priceScale.tickCount; i++) {
				const length = priceScale.tickLabels[i]!.length;
				if (length > characters) {
					characters = length;
				}
			}
			const needed = Math.max(
				MIN_AXIS_WIDTH,
				Math.ceil((characters * this._layout.digitWidth + 2 * AXIS_PADDING) / 4) * 4,
			);
			if (needed <= axis.axisWidth && needed + AXIS_SHRINK_SLACK >= axis.axisWidth) {
				continue;
			}
			axis.axisWidth = needed;
			changed = true;
		}
		return changed;
	}

	/** The visible axis drawn on `target` (the element under the pointer), or null. */
	public at(target: EventTarget | null): PriceAxis | null {
		for (const axis of this.list) {
			if (axis.settings.visible && axis.layer !== null && axis.layer.canvas === target) {
				return axis;
			}
		}
		return null;
	}

	/** Moves the scales that do not autoscale with a drag of `dy` CSS pixels. */
	public scrollBy(dy: number): void {
		let moved = false;
		for (const axis of this.list) {
			if (!axis.settings.autoScale && axis.count > 0 && axis.scale.hasRange) {
				axis.scale.scrollBy(dy);
				moved = true;
			}
		}
		if (moved) {
			this._host.invalidate(INVALIDATE_LIGHT);
		}
	}
}
