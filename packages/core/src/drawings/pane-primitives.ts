import { type Invalidation, INVALIDATE_CURSOR, INVALIDATE_LIGHT } from '../model/invalidation';
import type { FrameModel } from '../model/frame-model';
import type { TimeIndex } from '../model/time-index';
import type { TimeScale } from '../model/time-scale';
import { type ChartOptions, DEFAULT_PRICE_SCALE_ID } from '../options';
import type { PriceAxes } from '../price-axes';
import type { PanePrimitive, PrimitiveBounds, PrimitiveZOrder } from '../primitives';
import { Layer } from '../render/layer';
import type { ChartLayout } from '../render/layout';
import { PaneViewState, PrimitiveLayers, ScaleMapping } from '../render/primitive-host';
import type { Series } from '../series';
import type { ChartSettings } from '../settings';
import { canvasFits } from '../shared/canvas-budget';
import { report } from '../shared/frame';
import { Drawings } from './manager';

/**
 * The primitives of the pane and what draws them: their three layers, the views that map them to
 * the price scales, the canvas of the drawings layer, and the built-in drawings, which are created
 * on first use.
 */
export class PanePrimitives {
	/** Primitives of the pane in their three layers; the built-in drawings are among them. */
	public readonly layers: PrimitiveLayers;
	/** The view of primitives on the default price scale. */
	public readonly view: PaneViewState;
	/** The drawings layer, created with the first primitive drawn into it; null while merged. */
	public layer: Layer | null = null;
	/** Near the canvas budget, drawings go into the series layer instead (see `canvasFits`). */
	public merged = false;
	/** The drawings layer has to be created, merged or placed again before it is drawn. */
	public placement = false;
	public drawings: Drawings | null = null;
	public readonly bounds: PrimitiveBounds = { left: 0, top: 0, right: 0, bottom: 0 };
	/** The views primitives are drawn with, one per price scale they use. */
	private readonly _views = new Map<string, PaneViewState>();
	private readonly _target = {
		context: null as unknown as CanvasRenderingContext2D,
		pixelRatio: 1,
		width: 0,
		height: 0,
	};
	/** Cursor of the chart's options, and the one shown. */
	private _defaultCursor = 'crosshair';
	private _cursor = '';
	private readonly _settings: ChartSettings;
	private readonly _layout: ChartLayout;
	private readonly _scale: TimeScale;
	private readonly _series: readonly Series[];
	private readonly _axes: PriceAxes;
	private readonly _model: FrameModel;
	/** Logical positions of times, for anchors stored as times. */
	private readonly _times: TimeIndex;
	private readonly _invalidate: (level: Invalidation) => void;

	public constructor(
		settings: ChartSettings,
		layout: ChartLayout,
		scale: TimeScale,
		series: readonly Series[],
		axes: PriceAxes,
		model: FrameModel,
		times: TimeIndex,
		invalidate: (level: Invalidation) => void,
	) {
		this._settings = settings;
		this._layout = layout;
		this._scale = scale;
		this._series = series;
		this._axes = axes;
		this._model = model;
		this._times = times;
		this._invalidate = invalidate;
		this.layers = new PrimitiveLayers({ primitiveChanged: zOrder => this.changed(zOrder) });
		this.view = this.viewFor(DEFAULT_PRICE_SCALE_ID);
	}

	/** Takes over the options the cursor and the built-in drawings follow. */
	public applyOptions(options: ChartOptions): void {
		this._defaultCursor = options.crosshair.mode === 'hidden' ? 'default' : 'crosshair';
		this._cursor = '';
		this.applyCursor();
		if (this.drawings !== null) {
			this.drawings.style.handleFill = options.layout.background;
			this.drawings.style.fontFamily = options.layout.fontFamily;
			this.changed('normal');
		}
	}

	/** Attaches a primitive drawn with the default price scale. */
	public attach(primitive: PanePrimitive): void {
		this.ensureDrawings();
		this.layers.attach(primitive, this.view);
	}

	/** Attaches a primitive drawn with the price scale of `series`. */
	public attachToSeries(series: Series, primitive: PanePrimitive): void {
		this.ensureDrawings();
		series.primitives.add(primitive);
		this.layers.attach(primitive, this.viewFor(this._axes.of(series).id));
	}

	public detachFromSeries(series: Series, primitive: PanePrimitive): void {
		if (series.primitives.delete(primitive)) {
			this.layers.detach(primitive);
		}
	}

	/** Detaches every primitive, and releases the drawings and their layer. */
	public destroy(): void {
		this.layers.detachAll();
		this.drawings?.destroy();
		this._layout.root.removeEventListener('keydown', this._onKey);
		this.layer?.release();
	}

	/** The drawings, created on first use along with what they need: keys, the time index. */
	public ensureDrawings(): Drawings {
		if (this.drawings !== null) {
			return this.drawings;
		}
		const options = this._settings.options;
		const overlay = this._layout.overlay;
		const drawings = new Drawings(
			{
				layers: this.layers,
				times: this._times,
				view: id => this.viewFor(id),
				paneLeft: () => this._layout.paneLeft,
				invalidateOverlay: () => this._invalidate(INVALIDATE_CURSOR),
				snapPrice: (index, y, view) => this._snapPrice(index, y, view),
				report,
			},
			{
				handleFill: options.layout.background,
				fontFamily: options.layout.fontFamily,
				measure: (text, font) => {
					const ctx = overlay.ctx;
					if (ctx === null) {
						return text.length * Number.parseFloat(font) * 0.6;
					}
					ctx.font = font;
					return ctx.measureText(text).width;
				},
			},
		);
		this.drawings = drawings;
		// Focusable by a click, but not in the tab order, so Escape and Delete reach the drawings.
		if (this._layout.root.tabIndex < 0 && !this._layout.root.hasAttribute('tabindex')) {
			this._layout.root.tabIndex = -1;
		}
		this._layout.root.addEventListener('keydown', this._onKey);
		return drawings;
	}

	private readonly _onKey = (event: KeyboardEvent): void => {
		if (this.drawings?.key(event.key) === true) {
			event.preventDefault();
		}
	};

	/** A primitive or drawing changed: the layer it is drawn into is drawn again. */
	public changed(zOrder: PrimitiveZOrder): void {
		if (zOrder === 'bottom' || (zOrder === 'normal' && this.merged)) {
			this._invalidate(INVALIDATE_LIGHT);
			return;
		}
		if (zOrder === 'normal' && this.layer === null) {
			// The first primitive of the drawings layer: the layer is placed in the next frame.
			this.placement = true;
		}
		this._invalidate(INVALIDATE_CURSOR);
	}

	/** Detaches the primitives of a series that is gone. */
	public detachSeries(series: Series): void {
		for (const primitive of series.primitives) {
			this.layers.detach(primitive);
		}
		series.primitives.clear();
	}

	/**
	 * Price of a point placed at bar `index` and row `y` on the scale of `view`: in magnet mode, the
	 * open, high, low or close nearest to `y` of the first visible series on that scale, where the bar
	 * is held; otherwise the price at `y`. On a percentage or indexed scale a series is drawn with its
	 * own base, so the price is the one the scale shows where that value is drawn.
	 */
	private _snapPrice(index: number, y: number, view: PaneViewState): number {
		const free = view.yToPrice(y);
		const drawn = this._model.drawn;
		if (this._settings.options.crosshair.mode !== 'magnet' || drawn === null) {
			return free;
		}
		const row = Math.floor(index / 2 ** drawn.shift) - drawn.start;
		if (row < 0 || row >= drawn.count) {
			return free;
		}
		const ratio = this._layout.pixelRatio;
		for (const series of this._series) {
			const axis = series.axis;
			if (!series.seriesOptions.visible || axis === null || axis.id !== view.scaleId || row >= series.close.length) {
				continue;
			}
			let best = NaN;
			let bestY = NaN;
			let distance = Infinity;
			for (let c = 0; c < 4; c++) {
				const price = (c === 0 ? series.open : c === 1 ? series.high : c === 2 ? series.low : series.close)[row]!;
				const at = series.deviceY(price) / ratio;
				const d = Math.abs(at - y);
				if (d < distance) {
					distance = d;
					best = price;
					bestY = at;
				}
			}
			if (best === best) {
				// The same price, unless the series has a base of its own (percentage, indexed).
				return Math.abs(view.priceToY(best) - bestY) < 1e-6 ? best : view.yToPrice(bestY);
			}
		}
		return free;
	}

	/** Shows the cursor of the tool or drawing under the pointer, or the chart's own. */
	public applyCursor(): void {
		const cursor = this.drawings?.cursor || this._defaultCursor;
		if (cursor !== this._cursor) {
			this._cursor = cursor;
			this._layout.root.style.cursor = cursor;
		}
	}

	/**
	 * Places the drawings layer, or merges it into the series layer when the canvas budget is near.
	 * Returns true when drawings moved from one to the other: the series layer is then drawn in full.
	 */
	public placeLayer(ratio: number): boolean {
		let stale = false;
		this.placement = false;
		const wanted = this.layers.normal.entries.length > 0;
		const area = Math.round(this._layout.paneWidth * ratio) * Math.round(this._layout.paneHeight * ratio);
		const layer = this.layer;
		const merged = wanted && !canvasFits(area - (layer === null ? 0 : layer.pixels));
		if (!wanted || merged) {
			if (layer !== null) {
				layer.release();
				layer.canvas.remove();
				this.layer = null;
			}
			if (merged !== this.merged) {
				this.merged = merged;
				this.layers.normal.changed = true;
				stale = true;
			}
			return stale;
		}
		if (this.merged) {
			this.merged = false;
			stale = true;
		}
		if (layer === null) {
			const created = new Layer(this._layout.root.ownerDocument, false);
			created.canvas.style.pointerEvents = 'none';
			this._layout.root.insertBefore(created.canvas, this._layout.overlay.canvas);
			this.layer = created;
			this.layers.normal.changed = true;
		}
		if (this.layer!.place(this._layout.paneLeft, 0, this._layout.paneWidth, this._layout.paneHeight, ratio)) {
			this.layers.normal.changed = true;
		}
		return stale;
	}

	/** The view of primitives and drawings on price scale `id`, made with the scale if need be. */
	public viewFor(id: string): PaneViewState {
		let view = this._views.get(id);
		if (view === undefined) {
			const scale = this._axes.get(id).scale;
			view = new PaneViewState(id, this._times, new ScaleMapping(scale), () => this._model.coarseWindow());
			this._views.set(id, view);
		}
		return view;
	}

	/** Hands the mapping of the last model update (what is on screen) to the views of primitives. */
	public syncPaneView(): void {
		const geometry = this._model.geometry;
		const scale = this._scale;
		for (const view of this._views.values()) {
			view.sync(
				geometry.origin,
				geometry.spacing,
				this._layout.pixelRatio,
				this._layout.paneWidth,
				this._layout.paneHeight,
				scale.first,
				scale.end - 1,
			);
		}
	}

	/** Takes over the frame's mapping for primitives, and brings their geometry up to date. */
	public sync(): boolean {
		this.syncPaneView();
		const layers = this.layers;
		const bounds = this.bounds;
		let updated = layers.normal.update(bounds);
		if (layers.top.update(bounds)) {
			updated = true;
		}
		return updated;
	}

	/** Sets the draw target to a layer's context, with the origin at the pane's top left corner. */
	public targetOf(ctx: CanvasRenderingContext2D): typeof this._target {
		const target = this._target;
		target.context = ctx;
		target.pixelRatio = this._layout.pixelRatio;
		target.width = this._layout.paneWidth;
		target.height = this._layout.paneHeight;
		return target;
	}

	/** Draws the primitives of the drawings layer, the built-in drawings among them. */
	public render(): void {
		const layer = this.layer;
		const ctx = layer?.ctx ?? null;
		if (layer === null || ctx === null) {
			return;
		}
		ctx.clearRect(0, 0, layer.width, layer.height);
		this.layers.normal.draw(this.targetOf(ctx));
	}
}
