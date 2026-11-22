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
 * in percent or index values on a percentage or indexed one (see `PriceScaleMode`). Ranges, widths
 * and coordinates are those of the last frame drawn; coordinates are CSS pixels from the top of the
 * chart's plotting area, including the offset of an independent pane.
 *
 * A handle stands for its id, and stays valid when the chart removes the scale (see
 * `ChartApi.removePriceScale`): while the chart has no scale of that id it reads as a scale with
 * nothing on it (no width, no range, no coordinates, the options of an overlay), and `applyOptions`
 * or `setVisibleRange` make the scale again, listed in `ChartOptions.priceScales`.
 */
export interface PriceScaleApi {
	/** `default` for the scale `ChartOptions.priceScale` configures, or the id series name it by. */
	readonly id: string;
	/** Merges options, like `chart.applyOptions({ priceScales: { [id]: options } })`. */
	applyOptions(options: DeepPartial<PriceScaleOptions>): void;
	options(): Readonly<PriceScaleOptions>;
	/** Width of the axis in CSS pixels; 0 for an overlay, and for a scale nothing is on. */
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

/** What the price axes need from the chart. */
export interface PriceAxesHost extends PriceAxisHost {
	/** The scale `axis` was removed: nothing uses it, and no option lists it. */
	priceScaleRemoved(axis: PriceAxis): void;
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
	/**
	 * The options in effect: those of the scale (`options()`), except that a scale nothing is on
	 * shows no axis and has no pane of its own (see `PriceAxes.endSweep`).
	 */
	public settings: PriceScaleOptions;
	/** Whether a series, an indicator output, a heatmap or scatter, or a primitive is on the scale. */
	public inUse = false;
	/** The chart removed the scale; the object lives on as a handle of its id. */
	public removed = false;
	/** The last sweep that found the scale in use (see `PriceAxes.beginSweep`). */
	public usedIn = -1;
	public layer: Layer | null = null;
	/** Place and width of the axis in CSS pixels, while it is visible. */
	public axisLeft = 0;
	public axisWidth = MIN_AXIS_WIDTH;
	/** Device-pixel rows of the ticks. */
	public tickYs = new Float32Array(64);
	/** Tick generation the axis canvas shows, and the one its width was fitted to; -1 forces it. */
	public drawn = -1;
	public drawnGrid = -1;

	public get paneWeight(): number {
		const weight = this.settings.paneWeight;
		return Number.isFinite(weight) && weight > 0 ? weight : 0;
	}

	public get separatePane(): boolean {
		return this.id !== DEFAULT_PRICE_SCALE_ID && this.paneWeight > 0;
	}
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
	/** The axes the scale belongs to, which a handle of a removed scale asks for the scale of its id. */
	private readonly _owner: PriceAxes | null;
	/** The options of the scale, as resolved. */
	private _options: PriceScaleOptions;
	/** Those options without an axis or a pane, for while nothing is on the scale; made when needed. */
	private _unused: PriceScaleOptions | null = null;
	private _unusedOf: PriceScaleOptions | null = null;

	public constructor(id: string, host: PriceAxisHost, settings: PriceScaleOptions, owner: PriceAxes | null = null) {
		this.id = id;
		this.scale = new PriceScale(id);
		this._host = host;
		this._owner = owner;
		this._options = settings;
		this.settings = settings;
		this.setSettings(settings);
	}

	/** Takes resolved options and pushes what the scale keeps a copy of. */
	public setSettings(settings: PriceScaleOptions): void {
		this._options = settings;
		this.settings = this._effective();
		const scale = this.scale;
		scale.setMargins(settings.scaleMargins.top, settings.scaleMargins.bottom);
		scale.setMode(settings.mode);
		scale.setInverted(settings.invertScale);
	}

	/**
	 * Notes whether anything is on the scale. Returns true when that shows or hides its axis or its
	 * pane, which the layout has to follow.
	 */
	public setInUse(inUse: boolean): boolean {
		if (inUse === this.inUse) {
			return false;
		}
		this.inUse = inUse;
		const before = this.settings;
		this.settings = this._effective();
		return before.visible !== this.settings.visible || before.paneWeight !== this.settings.paneWeight;
	}

	/** The options in effect: a scale other than the default one takes no room while nothing is on it. */
	private _effective(): PriceScaleOptions {
		const options = this._options;
		if (this.inUse || this.id === DEFAULT_PRICE_SCALE_ID || (!options.visible && !(options.paneWeight > 0))) {
			return options;
		}
		if (this._unusedOf !== options) {
			this._unusedOf = options;
			this._unused = { ...options, visible: false, paneWeight: 0 };
		}
		return this._unused!;
	}

	/** This scale, or for a handle of a removed scale the scale of its id now, if there is one. */
	private _current(): PriceAxis | null {
		return this.removed ? (this._owner?.find(this.id) ?? null) : this;
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
		const current = this._current();
		return current !== null ? current._options : this._owner!.overlayOptions();
	}

	public width(): number {
		const current = this._current();
		return current !== null && current.settings.visible ? current.axisWidth : 0;
	}

	public getVisibleRange(): PriceRange | null {
		const current = this._current();
		if (current !== this) {
			return current?.getVisibleRange() ?? null;
		}
		const scale = this.scale;
		if (!scale.hasRange) {
			return null;
		}
		return scale.mode === 'logarithmic'
			? { from: 10 ** scale.min, to: 10 ** scale.max }
			: { from: scale.min, to: scale.max };
	}

	public setVisibleRange(range: PriceRange): void {
		if (this.removed && this._owner !== null) {
			this._owner.get(this.id).setVisibleRange(range);
			return;
		}
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
		const current = this._current();
		if (current !== this) {
			return current?.priceToCoordinate(price) ?? null;
		}
		if (!this.scale.hasRange) {
			return null;
		}
		const y = this.scale.priceToY(price);
		return Number.isFinite(y) ? y : null;
	}

	public coordinateToPrice(y: number): number | null {
		const current = this._current();
		if (current !== this) {
			return current?.coordinateToPrice(y) ?? null;
		}
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
		if (dy === 0 || !scale.hasRange || this.removed) {
			return;
		}
		this._manual();
		scale.zoom(Math.exp((dy * 2) / Math.max(1, scale.height)));
		this._host.invalidate(INVALIDATE_LIGHT);
	}

	/**
	 * Scales the axis around the price at `y` (CSS pixels from the top of the chart), which stays
	 * where it is: a factor above 1 shows more. Turns autoscale off, as a drag does.
	 */
	public zoomAt(y: number, factor: number): void {
		const scale = this.scale;
		if (factor === 1 || !(factor > 0) || !scale.hasRange || this.removed) {
			return;
		}
		this._manual();
		scale.zoomAt(y, factor);
		this._host.invalidate(INVALIDATE_LIGHT);
	}

	public resetScale(): void {
		if (!this.settings.autoScale && !this.removed) {
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
 * lists, and the overlays that something on the chart names.
 *
 * Which scales there are follows what uses them, as of the last frame (see `beginSweep`): the
 * default scale is always there; one the options list is there while they list it, and takes room
 * (an axis, a pane) only while something is on it; any other is there while something is on it.
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
	private readonly _host: PriceAxesHost;
	private readonly _settings: ChartSettings;
	private readonly _layout: ChartLayout;
	/** The sweep in progress (see `beginSweep`). */
	private _sweep = 0;

	public constructor(host: PriceAxesHost, settings: ChartSettings, layout: ChartLayout) {
		this._host = host;
		this._settings = settings;
		this._layout = layout;
		const main = new PriceAxis(DEFAULT_PRICE_SCALE_ID, host, settings.options.priceScale, this);
		main.inUse = true;
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
				this,
			);
			axis.scale.setHeight(this._layout.mainPaneHeight);
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
				if (!axis.separatePane && axis.settings.visible && axis.count > 0) {
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
			if (axis !== grid && !axis.settings.visible && !axis.separatePane) {
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

	/** The price scale with this id, if there is one; makes none. */
	public find(id: string): PriceAxis | null {
		return this._byId.get(id) ?? null;
	}

	/** The options of a scale no option lists, in the theme in effect. */
	public overlayOptions(): PriceScaleOptions {
		return overlayScaleOptions(this._settings.theme());
	}

	/**
	 * Starts finding the scales in use, which `markUsed` and `markUsedId` mark until `endSweep`. The
	 * chart does it at the start of every frame that updates the model, with every series, indicator
	 * output, heatmap, scatter and primitive it has, shown or hidden.
	 */
	public beginSweep(): void {
		this._sweep++;
	}

	/** Marks a scale as in use. */
	public markUsed(axis: PriceAxis): void {
		axis.usedIn = this._sweep;
	}

	/** Marks the scale `id` as in use, if there is one. */
	public markUsedId(id: string): void {
		const axis = this._byId.get(id);
		if (axis !== undefined) {
			axis.usedIn = this._sweep;
		}
	}

	/**
	 * Ends finding the scales in use. A scale no option lists that nothing used is removed: its state
	 * and its canvas go, and a later use makes it again. One the options list stays, but takes no room
	 * while nothing is on it. Returns true when an axis or a pane appeared or went, which the layout
	 * has to follow.
	 */
	public endSweep(): boolean {
		const sweep = this._sweep;
		const declared = this._settings.options.priceScales;
		const list = this.list;
		let changed = false;
		// The default scale, first, is always there and always in use.
		for (let i = list.length - 1; i > 0; i--) {
			const axis = list[i]!;
			const used = axis.usedIn === sweep;
			if (!used && !Object.prototype.hasOwnProperty.call(declared, axis.id)) {
				list.splice(i, 1);
				this._byId.delete(axis.id);
				axis.removed = true;
				// Not listed, it was an overlay: its canvas, if it had one, is hidden and takes no room.
				const layer = axis.layer;
				if (layer !== null) {
					layer.release();
					layer.canvas.remove();
					axis.layer = null;
				}
				if (this.grid === axis) {
					this.grid = list[0]!;
				}
				// A handle of the id may outlive the scale: it keeps no series.
				axis.first = null;
				this._host.priceScaleRemoved(axis);
				continue;
			}
			if (axis.setInUse(used)) {
				this._syncAxisLayer(axis);
				changed = true;
			}
		}
		return changed;
	}

	/** The price scale a series is on, following its `priceScaleId`. */
	public of(series: Series): PriceAxis {
		// Options are replaced as a whole on every change: while they are the same, so is the scale.
		const options = series.seriesOptions;
		let axis = series.axis;
		if (axis === null || series.axisOptions !== options || axis.removed) {
			axis = this.get(options.priceScaleId || DEFAULT_PRICE_SCALE_ID);
			series.axis = axis;
			series.axisOptions = options;
		}
		return axis;
	}

	/**
	 * Makes the canvas of an axis the options show for the first time, below the overlay, and shows
	 * or hides it: hidden while the options hide the axis or nothing is on the scale. A hidden axis
	 * lets its bitmap go; the next placement of the canvases makes it again.
	 */
	private _syncAxisLayer(axis: PriceAxis): void {
		const visible = axis.settings.visible;
		// Made once the options show the axis, so canvases keep the order of their scales' options.
		if (axis.layer === null && axis.options().visible) {
			axis.layer = this._layout.addAxisLayer();
		}
		const layer = axis.layer;
		if (layer === null) {
			return;
		}
		if (!visible && layer.visible && layer.pixels > 0) {
			layer.release();
		}
		layer.setVisible(visible);
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
	public scrollBy(dy: number, y: number): void {
		let moved = false;
		for (const axis of this.list) {
			if (!axis.settings.autoScale && axis.count > 0 && axis.scale.hasRange && axis.scale.contains(y)) {
				axis.scale.scrollBy(dy);
				moved = true;
			}
		}
		if (moved) {
			this._host.invalidate(INVALIDATE_LIGHT);
		}
	}
}
