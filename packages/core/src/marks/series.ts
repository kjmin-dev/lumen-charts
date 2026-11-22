import { HeatRanges, HeatPan } from './heat-ranges';
import type { EngineClient, HeatmapColumns, MarksUpdate } from '@lumen-charts/engine';
import { DEFAULT_PRICE_SCALE_ID, definedOnly } from '../options';
import type { PriceAxis, PriceScaleApi } from '../price-axes';
import type { DrawTarget, PanePrimitive, PrimitiveHost, PrimitiveZOrder } from '../primitives';
import {
	type HeatmapColumn,
	type HeatmapData,
	type HeatmapGrid,
	type ScatterData,
	type ScatterPoint,
	packHeatmap,
	packHeatmapColumn,
	packScatter,
	packScatterPoint,
} from './input';
import {
	type AnyMarkOptions,
	type HeatmapOptions,
	type MarkSeriesType,
	type ScatterOptions,
	defaultMarkOptions,
} from './options';
import { type ValueMapping, buildPalette, parseColor, setValueMapping } from './palette';
import {
	HeatmapScratch,
	type PixelBox,
	type PointStamp,
	type PriceProjection,
	drawHeatmap,
	heatEdge,
	heatEndTime,
	drawScatter,
	emptyBox,
	makeStamp,
	priceExtent,
	quantize,
	slotColors,
} from './render';
import { CanvasMarkBackend } from './canvas-backend';
import {
	type HeatSlots,
	MarkGpuClient,
	type MarkFrame,
	type MarkRenderer,
	type MarkRendererStatus,
	type MarkRendererReason,
} from './backend';
import { GlMarkClient } from './gl/renderer';
import type { TimeMap } from './time-map';
import { MarksWindow } from './window';

/** Rows of a scatter window whose lowest and highest price are kept together, for the autoscale. */
const EXTENT_BLOCK = 4096;
/** Screens of rows asked for on either side of the view. */
const SCATTER_MARGIN = 0.5;
const HEATMAP_MARGIN = 1;

/** What a heatmap and a scatter series have in common in the API. */
export interface MarkSeriesApi<T extends MarkSeriesType = MarkSeriesType> {
	/** Name of the series in saved state: the `id` it was added with, or the one it was given. */
	readonly id: string;
	readonly type: T;
	/** Requested renderer and the effective path for this series. */
	renderer(): MarkRendererStatus;
	/**
	 * Merges options. Throws a RangeError for a palette or color that cannot be read, before anything
	 * changes.
	 */
	applyOptions(options: Partial<T extends 'heatmap' ? HeatmapOptions : ScatterOptions>): void;
	options(): Readonly<T extends 'heatmap' ? HeatmapOptions : ScatterOptions>;
	/** The price scale the series is drawn on (see the `priceScaleId` option). */
	priceScale(): PriceScaleApi;
	/** Where a price is drawn on the series' scale, in CSS pixels from the top of the pane; null before the scale has a range. */
	priceToCoordinate(price: number): number | null;
	/** The price drawn at a coordinate: the inverse of `priceToCoordinate`. */
	coordinateToPrice(y: number): number | null;
	/**
	 * What the series was last drawn from: the level of detail (0: the points or columns as given)
	 * and the marks in view at that level (scatter points, or heatmap cells). For diagnostics.
	 */
	drawn(): { level: number; marks: number };
}

/**
 * A scatter series: points at any time and price, several per bar if need be, each a small mark
 * colored by its value. The points live in the data engine; the chart holds those around the view,
 * and at more points than pixels a level of detail that merges the points of one pixel.
 */
export interface ScatterSeriesApi extends MarkSeriesApi<'scatter'> {
	/**
	 * Replaces the points. Times are UTC milliseconds; points are drawn in time order (an input out
	 * of order is sorted), and several may share a time. A point without a finite time and price is
	 * left out.
	 */
	setData(data: ScatterData): void;
	/** Adds a point at or after the time of the last one; an earlier one is refused. */
	update(point: ScatterPoint): void;
	/** Adds points at or after the time of the last one, in time order: one message for all of them. */
	append(data: ScatterData): void;
	/**
	 * Adds older points, at or before the time of the first one; a later one is refused. They are
	 * drawn before (under) the points there are. The points held keep their place, so a view of the
	 * newest points does not wait for them.
	 */
	prepend(data: ScatterData): void;
	/** Removes the points with times in `[from, to]` (UTC milliseconds, inclusive). */
	removeMarks(range: { from: number; to: number }): void;
}

/**
 * A heatmap series: columns of cells on a grid of prices, each cell colored by its value (the size
 * resting at a price of an order book, the volume traded there). The columns live in the data
 * engine; the chart holds those around the view, merged four at a time per level of detail where
 * there are more columns than pixels.
 */
export interface HeatmapSeriesApi extends MarkSeriesApi<'heatmap'> {
	/** Replaces the columns and sets the price grid (see `HeatmapData`). Throws a RangeError for a grid that is not one. */
	setData(data: HeatmapData): void;
	/**
	 * Replaces the last column when `column.time` is its time, or adds a column after it; an earlier
	 * time is refused. The column is on the grid of the last `setData`, which must have come first.
	 */
	update(column: HeatmapColumn): void;
	/** Adds columns after the last one, on the grid the series has (`data`'s must be the same). */
	append(data: HeatmapData): void;
	/**
	 * Adds older columns, before the first one and in time order, on the grid the series has; a column
	 * at or after the first column's time is refused.
	 */
	prepend(data: HeatmapData): void;
	/** Removes the columns with times in `[from, to]` (UTC milliseconds, inclusive). */
	removeMarks(range: { from: number; to: number }): void;
	/**
	 * The value of the cell at a time and a price, from the columns held around the view at the level
	 * of detail drawn (so at a wide view, the highest of the columns merged there). Null outside the
	 * grid, where no column is held, and for a cell without a value. For a readout at the crosshair.
	 */
	valueAt(time: number, price: number): number | null;
}

/** What a mark series needs from the chart. */
export interface MarkSeriesHost {
	markRenderer(): MarkRenderer;
	/** The data engine, created if need be; null once the chart is destroyed. */
	engine(): EngineClient | null;
	/** Options changed: the frame fits the scales again and draws the layers. */
	optionsChanged(series: MarkSeries): void;
	/** Rows changed: the frame fits the scales again, and draws the series' layer. */
	rowsChanged(series: MarkSeries): void;
	/** The series is on another price scale. */
	scaleChanged(series: MarkSeries): void;
	/** Asks for the rows the last view needs, without waiting for the frame. */
	request(series: MarkSeries): void;
	axisOf(series: MarkSeries): PriceAxis;
	/** What the frame maps times with, and its version, which changes with the mapping. */
	readonly map: TimeMap;
	readonly mapVersion: number;
	/** Size of the pane in device pixels, and device pixels per CSS pixel. */
	paneWidth(): number;
	paneHeight(): number;
	pixelRatio(): number;
	document(): Document;
}

/**
 * A heatmap or scatter series: its options, its window of rows, its pixels, and the primitive that
 * draws them into a layer of the pane.
 *
 * A frame draws in one of three ways. When the mapping of times and prices, the options and the rows
 * are those of the picture held, the picture is composited as it is. When only rows changed (an
 * append), the pixels of those rows are written and handed over. Otherwise the picture is drawn
 * again from the rows in view.
 */
export abstract class MarkSeries {
	public readonly id: string;
	public abstract readonly type: MarkSeriesType;
	/**
	 * What draws the series into its layer of the pane. An object of its own: a series has an
	 * `update` for its data, and a primitive one for its geometry.
	 */
	public readonly primitive: PanePrimitive;
	/** Id of the series in the data engine; -1 without an engine. */
	public readonly engineId: number;
	public seriesOptions: AnyMarkOptions;
	public readonly window = new MarksWindow();
	public readonly surface: CanvasMarkBackend;
	private readonly _gpu = new MarkGpuClient();
	private readonly _gl: GlMarkClient;
	private _effective: MarkRendererStatus['path'] = 'canvas2d';
	private _reason: MarkRendererReason | null = null;
	private _peakBytes = 0;
	private readonly _invalidateBackend = () => {
		this.forget();
		this._primitiveHost?.requestUpdate();
		this._host.optionsChanged(this);
	};
	private readonly _webgpuChanged = () => {
		// Make room for the requested device before it allocates its first frame.
		if (this._gpu.backend) this._gl.release();
		this._invalidateBackend();
	};
	private readonly _canvasAll = () => this._drawAll(this._host.map);
	private readonly _canvasRows = (from: number, to: number, box: PixelBox) =>
		this._drawRows(this._host.map, from, to, box);
	/** Times at the edges of the pane, with room for what a mark covers beside its time; NaN before the first frame. */
	public viewFrom = Number.NaN;
	public viewTo = Number.NaN;
	/** Milliseconds and price per device pixel of the last frame. */
	public viewStep = 0;
	public viewPriceStep = 0;
	/** The scale the series was attached with. */
	public attachedScale = '';
	protected readonly _host: MarkSeriesHost;
	protected _primitiveHost: PrimitiveHost | null = null;
	protected _palette: Uint32Array;
	/** The options the palette was built from. */
	private _paletteOptions: AnyMarkOptions | null = null;
	protected readonly _mapping: ValueMapping = { min: 0, factor: 1, log: false };
	protected readonly _projection: PriceProjection = { offset: 0, scale: 0, log: false };
	/** What the picture held was drawn with: see `_signature`. */
	private readonly _drawn = new Float64Array(14).fill(Number.NaN);
	private readonly _current = new Float64Array(14);
	private _drawnOptions: AnyMarkOptions | null = null;
	private _drawnRevision = -1;
	private drawnCount = -1;
	/** Marks in view when the picture was last drawn in full. */
	protected _marks = 0;
	protected readonly _box: PixelBox = { left: 0, top: 0, right: 0, bottom: 0 };

	public constructor(
		host: MarkSeriesHost,
		id: string,
		type: MarkSeriesType,
		options: Partial<AnyMarkOptions>,
		zOrder: PrimitiveZOrder,
		zIndex: number,
	) {
		this._host = host;
		this.id = id;
		this.primitive = {
			zOrder,
			zIndex,
			attached: primitiveHost => {
				this._primitiveHost = primitiveHost;
			},
			detached: () => {
				this._primitiveHost = null;
			},
			draw: target => this.draw(target),
		};
		const merged = { ...defaultMarkOptions(type), ...definedOnly(options) } as AnyMarkOptions;
		this._palette = checkOptions(merged);
		this._paletteOptions = merged;
		this.seriesOptions = merged;
		this.engineId = host.engine()?.addMarks(type) ?? -1;
		this.surface = new CanvasMarkBackend(host.document());
		this._gl = new GlMarkClient(host.document(), this._invalidateBackend);
	}

	// API

	public applyOptions(options: Partial<AnyMarkOptions>): void {
		const next = { ...this.seriesOptions, ...definedOnly(options) } as AnyMarkOptions;
		let same = true;
		for (const key of Object.keys(next) as (keyof AnyMarkOptions)[]) {
			if (next[key] !== this.seriesOptions[key]) {
				same = false;
			}
		}
		if (same) {
			return;
		}
		// Throws before anything changes.
		const palette = checkOptions(next, options.palette === undefined ? this._palette : undefined);
		this.setOptions(next, palette);
	}

	/** Takes options that were checked (`checkOptions`). */
	public setOptions(options: AnyMarkOptions, palette: Uint32Array): void {
		const scaleChanged = options.priceScaleId !== this.seriesOptions.priceScaleId;
		const previous = this.seriesOptions;
		if (
			this._drawnOptions === previous &&
			palette === this._palette &&
			Object.keys(options).every(
				key => key === 'opacity' || options[key as keyof AnyMarkOptions] === previous[key as keyof AnyMarkOptions],
			)
		) {
			this._drawnOptions = options;
		}
		this.seriesOptions = options;
		this._palette = palette;
		this._paletteOptions = options;
		if (scaleChanged) {
			this._host.scaleChanged(this);
		}
		this._primitiveHost?.requestUpdate();
		this._host.optionsChanged(this);
	}

	public options(): Readonly<AnyMarkOptions> {
		return this.seriesOptions;
	}

	public priceScale(): PriceScaleApi {
		return this._host.axisOf(this);
	}

	public priceToCoordinate(price: number): number | null {
		return this._host.axisOf(this).priceToCoordinate(price);
	}

	public coordinateToPrice(y: number): number | null {
		return this._host.axisOf(this).coordinateToPrice(y);
	}

	public drawn(): { level: number; marks: number } {
		return { level: Math.max(0, this.window.level), marks: this._marks };
	}

	/** Id of the price scale the series is on. */
	public get scaleId(): string {
		return this.seriesOptions.priceScaleId || DEFAULT_PRICE_SCALE_ID;
	}

	// Data

	/** Rows from the engine: a window, the rows an append changed, or a notice to ask again. */
	public receive(update: MarksUpdate): void {
		if (update.notice === true) {
			this.window.notice(update);
			this._host.request(this);
			return;
		}
		if (this.window.apply(update)) {
			if (this.type !== 'heatmap') this._primitiveHost?.requestUpdate();
			this._host.rowsChanged(this);
		}
	}

	/** The data was replaced: the rows held are drawn until the new ones are here, asked for at once. */
	protected _replaced(): void {
		this.window.invalidate();
		this._host.request(this);
	}

	/** Screens of rows asked for on either side of the view. */
	public abstract readonly margin: number;

	/**
	 * The most rows (scatter points, heatmap cells) asked for at once: `maxMarks` for the view, and
	 * as many per screen of margin. Beyond it the engine sends a coarser level.
	 */
	public get limit(): number {
		return Math.max(1, this.seriesOptions.maxMarks) * (1 + 2 * this.margin);
	}

	/**
	 * The lowest and highest price the series shows in the view, into `out` (`low > high` for none).
	 * Called once per frame, before the scales are fitted.
	 */
	public abstract extent(out: { low: number; high: number }): void;

	/** Device pixels a mark reaches beyond where its time falls, on either side: the view asks for the times of that many more. */
	public abstract reach(pixelRatio: number): number;

	// Drawing

	/** The picture held is gone (the browser lost the canvas): the next frame draws it again. */
	public forget(): void {
		this._gpu.backend?.release();
		this._drawn.fill(Number.NaN);
	}

	public renderer(): MarkRendererStatus {
		return {
			requested: this._host.markRenderer(),
			effective: this._effective === 'canvas2d' || this._effective === 'webgl2' ? this._effective : 'webgpu',
			path: this._effective,
			reason: this._reason,
			bytes: (this._gpu.backend?.bytes ?? 0) + this._gl.bytes,
			peakBytes: this._peakBytes,
		};
	}
	/**
	 * Internal, read by the benchmark harness: what the WebGL2 renderer drew a heatmap from last,
	 * its values or its palette slots; null for a scatter or on another path.
	 */
	public glHeatPath(): 'values' | 'slots' | null {
		return this.type === 'heatmap' && this._effective === 'webgl2' ? this._gl.heatPath : null;
	}
	/**
	 * Internal, read by the benchmark harness: the WebGPU kernel of the series' last dispatch, which
	 * names its path or a variant of it; null on another renderer.
	 */
	public gpuKernel(): string | null {
		const path = this._effective;
		return path === 'canvas2d' || path === 'webgl2' ? null : (this._gpu.backend?.kernel ?? null);
	}
	public preferenceChanged(): void {
		this._gpu.release();
		this._effective = 'canvas2d';
		this._reason = null;
		this._gl.release();
		this._invalidateBackend();
	}
	public release(): void {
		this._gpu.release();
		this._gl.release();
		this.surface.release();
	}

	private paintAccelerated(
		pref: MarkRenderer,
		frame: MarkFrame,
		target: CanvasRenderingContext2D,
		changed: boolean,
	): MarkRendererStatus['path'] {
		if (pref === 'webgpu') {
			const options = frame.options as ScatterOptions;
			const supported =
				frame.type !== 'scatter' || (options.shape === 'square' && Math.round(options.pointSize * frame.ratio) <= 9);
			if (supported) {
				this._gpu.start(this._host.document(), this._webgpuChanged);
				const backend = this._gpu.backend;
				if (backend) {
					try {
						const result = backend.paint(
							frame,
							target,
							changed || this._effective === 'webgl2' || this._effective === 'canvas2d',
						);
						if (result !== 'budget') {
							this._gl.release();
							return result;
						}
						this._reason = 'budget';
					} catch {
						this._gpu.release();
						this._gpu.disable('render-failed');
						this._reason = 'render-failed';
					}
				} else {
					this._reason = this._gpu.reason;
				}
			} else {
				this._gpu.release();
				this._reason = 'unsupported-style';
			}
		}
		const failure = this._gl.paint(frame, target, changed || this._effective !== 'webgl2');
		if (!failure) return 'webgl2';
		this._reason ??= failure;
		return 'canvas2d';
	}

	private prepareGeometry(): boolean {
		const options = this.seriesOptions;
		const host = this._host;
		const window = this.window;
		const width = host.paneWidth(),
			height = host.paneHeight();
		const scale = host.axisOf(this).scale;
		const ratio = host.pixelRatio();
		const projection = this._projection;
		// As `Series.setProjection`: on a percentage or indexed scale a value is linear in the price.
		let offset = scale.offset * ratio;
		let factor = scale.scale * ratio;
		const mode = scale.mode;
		let shown = scale.hasRange && window.level >= 0;
		if (mode === 'percentage' || mode === 'indexed') {
			const base = scale.base;
			const a = 100 / Math.abs(base);
			const c = (mode === 'indexed' ? 100 : 0) - base * a;
			offset -= c * factor;
			factor *= a;
			shown = shown && base === base && base !== 0;
		}
		projection.offset = offset;
		projection.scale = factor;
		projection.log = mode === 'logarithmic';
		if (this._paletteOptions !== options) {
			this._palette = buildPalette(options.palette);
			this._paletteOptions = options;
		}
		const min = options.valueMin ?? window.valueMin;
		const max = options.valueMax ?? window.valueMax;
		setValueMapping(this._mapping, min, max, options.valueScale === 'log');
		const current = this._current;
		current[0] = host.mapVersion;
		current[1] = offset;
		current[2] = factor;
		current[3] = projection.log ? 1 : 0;
		current[4] = window.version;
		current[5] = this._mapping.min;
		current[6] = this._mapping.factor;
		current[7] = this._mapping.log ? 1 : 0;
		current[8] = shown ? 1 : 0;
		current[9] = this.viewFrom;
		current[10] = this.viewTo;
		current[11] = ratio;
		current[12] = width;
		current[13] = height;
		const drawn = this._drawn;
		let same = this._drawnOptions === options;
		for (let i = 0; same && i < current.length; i++) {
			// NaN (before the first frame) never matches: drawn again.
			same = current[i] === drawn[i];
		}
		return same;
	}

	/** Merge the affected strip of a value-only heatmap update into the pane clip. */
	public paneDamage(bounds: { left: number; right: number }): boolean {
		if (!this.seriesOptions.visible) return true;
		const w = this.window;
		if (!this.prepareGeometry() || this.drawnCount !== w.count) return false;
		if (this._drawnRevision === w.revision) return true;
		if (w.dirtyFrom !== w.count - 1 || w.dirtyTo !== w.count) return false;
		const map = this._host.map;
		bounds.left = Math.min(bounds.left, heatEdge(w.time, w.count, w.dirtyFrom, map));
		bounds.right = Math.max(bounds.right, heatEdge(w.time, w.count, w.count, map));
		return true;
	}

	public draw(target: DrawTarget): void {
		const options = this.seriesOptions;
		if (!options.visible) return;
		const host = this._host,
			window = this.window,
			surface = this.surface;
		const same = this.prepareGeometry();
		const drawn = this._drawn,
			current = this._current,
			projection = this._projection;
		const shown = current[8] === 1;
		const ratio = host.pixelRatio(),
			width = host.paneWidth(),
			height = host.paneHeight();
		const pref = host.markRenderer();
		const wasGpu = this._effective !== 'canvas2d';
		let path: MarkRendererStatus['path'] = 'canvas2d';
		this._reason = null;
		if (pref !== 'canvas2d' && shown && width > 0 && height > 0) {
			const scatter = this.type === 'scatter';
			const from = scatter ? window.lowerBound(this.viewFrom) : Math.max(0, window.upperBound(this.viewFrom) - 1);
			const to = scatter ? window.upperBound(this.viewTo) : Math.min(window.count, window.upperBound(this.viewTo) + 1);
			path = this.paintAccelerated(
				pref,
				{
					type: this.type,
					window,
					map: host.map,
					projection,
					mapping: this._mapping,
					palette: this._palette,
					options,
					width,
					height,
					ratio,
					from,
					to,
					slots: this._fixedSlots(),
				},
				target.context,
				!same,
			);
			if (path !== 'canvas2d') {
				this._marks = Math.max(0, to - from) * (scatter ? 1 : window.rows);
				this._peakBytes = Math.max(this._peakBytes, (this._gpu.backend?.bytes ?? 0) + this._gl.bytes);
			}
		}
		if (path === 'canvas2d') {
			const fresh = surface.resize(width, height);
			const full =
				fresh ||
				wasGpu ||
				!same ||
				(this.type === 'scatter' && window.level > 0 && this._drawnRevision !== window.revision);
			if (full) this._marks = 0;
			const reuse =
				full &&
				shown &&
				this.type === 'heatmap' &&
				this.reusePan(
					!fresh &&
						!wasGpu &&
						this._drawnOptions === options &&
						window.revision === this._drawnRevision &&
						[1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13].every(i => current[i] === drawn[i]),
				);
			surface.paint(
				target.context,
				Math.min(1, options.opacity),
				full && !reuse,
				window.revision !== this._drawnRevision,
				shown,
				window,
				this._canvasAll,
				this._canvasRows,
				this._box,
			);
		} else if (!wasGpu) surface.release();
		// The patches of this frame are cleared below: a WebGL2 layer kept for later uploads anew.
		if (path !== 'webgl2') this._gl.stale();
		this._effective = path;
		if (!same) {
			drawn.set(current);
			this._drawnOptions = options;
		}
		this.drawnCount = window.count;
		this._drawnRevision = window.revision;
		this._beforeClearDirty();
		window.clearDirty();
	}

	protected reusePan(_compatible: boolean): boolean {
		return false;
	}

	/** The slots of a heatmap whose options fix the mapping of values; null otherwise. */
	protected _fixedSlots(): HeatSlots | null {
		return null;
	}

	/**
	 * The window's patches are about to be cleared: what is kept from its rows and was not brought
	 * up to date by this frame's renderer takes them now.
	 */
	protected _beforeClearDirty(): void {}

	/** Writes the rows in view into the surface, which is empty, and sets its box. */
	protected abstract _drawAll(map: TimeMap): void;

	/**
	 * Writes rows `[from, to)` (indexes into the window's buffers), which changed since the picture
	 * was drawn, over it; `box` gets the pixels to hand over, and the surface's box grows with them.
	 */
	protected abstract _drawRows(map: TimeMap, from: number, to: number, box: PixelBox): void;
}

/** Asks the engine to remove the marks of a range of times; throws a RangeError for a range that is not one. */
function removeMarks(host: MarkSeriesHost, engineId: number, range: { from: number; to: number }): void {
	const { from, to } = range;
	if (typeof from !== 'number' || typeof to !== 'number' || Number.isNaN(from) || Number.isNaN(to) || from > to) {
		throw new RangeError('lumen-charts: removeMarks needs a range of times with `from` at or before `to`');
	}
	host.engine()?.changeMarks(engineId, { op: 'delete', from, to });
}

/** The color table of options that are sound; throws a RangeError for those that are not. */
export function checkOptions(options: AnyMarkOptions, palette = buildPalette(options.palette)): Uint32Array {
	if ('color' in options && parseColor(options.color) === null) {
		throw new RangeError(`lumen-charts: cannot read the color "${String(options.color)}"`);
	}
	if (!(options.maxMarks >= 1)) {
		throw new RangeError(`lumen-charts: maxMarks must be at least 1, got ${String(options.maxMarks)}`);
	}
	return palette;
}

export class ScatterSeries extends MarkSeries implements ScatterSeriesApi {
	public readonly type = 'scatter';
	public readonly margin = SCATTER_MARGIN;
	private _stamp: PointStamp = makeStamp(1, false);
	private _stampCircle = false;
	/** Lowest and highest price of each complete block of rows of the window, as of `_blocksVersion`. */
	private _blockLow = new Float64Array(0);
	private _blockHigh = new Float64Array(0);
	private _blocks = 0;
	private _blocksVersion = -1;
	private readonly _scan = { low: 0, high: 0 };
	private _colorOptions: ScatterOptions | null = null;
	private _colorPixel = 0;

	public constructor(host: MarkSeriesHost, id: string, options: Partial<ScatterOptions>) {
		// In the drawings layer, above the series; below the drawings and the primitives of the
		// application, whose `zIndex` is 0 unless they say otherwise.
		super(host, id, 'scatter', options, 'normal', -1);
	}

	public override options(): Readonly<ScatterOptions> {
		return this.seriesOptions as ScatterOptions;
	}

	public setData(data: ScatterData): void {
		const rows = packScatter(data);
		this._host.engine()?.changeMarks(this.engineId, { op: 'set', data: rows });
		this._replaced();
	}

	public update(point: ScatterPoint): void {
		this._host.engine()?.changeMarks(this.engineId, { op: 'append', data: packScatterPoint(point) });
	}

	public append(data: ScatterData): void {
		const rows = packScatter(data);
		if (rows.count > 0) {
			this._host.engine()?.changeMarks(this.engineId, { op: 'append', data: rows });
		}
	}

	public prepend(data: ScatterData): void {
		const rows = packScatter(data);
		if (rows.count > 0) {
			this._host.engine()?.changeMarks(this.engineId, { op: 'prepend', data: rows });
		}
	}

	public removeMarks(range: { from: number; to: number }): void {
		removeMarks(this._host, this.engineId, range);
	}

	private _size(pixelRatio: number): number {
		return Math.max(1, Math.round((this.seriesOptions as ScatterOptions).pointSize * pixelRatio));
	}

	public reach(pixelRatio: number): number {
		// A point is centered on its time; placed from the start of its bar, it is half a bar further left.
		const half = (this.seriesOptions as ScatterOptions).barAlign === 'start' ? this._host.map.spacing / 2 : 0;
		return this._size(pixelRatio) + half;
	}

	/**
	 * The price extent of the points in view. Prices of rows do not change while a window holds them,
	 * so the extremes of every `EXTENT_BLOCK` rows are taken once: a pan then reads a few hundred
	 * numbers and the rows at the two ends of the view, not every point.
	 */
	public extent(out: { low: number; high: number }): void {
		const window = this.window;
		const from = window.lowerBound(this.viewFrom);
		const to = Math.max(from, window.upperBound(this.viewTo));
		if (window.version !== this._blocksVersion) {
			this._blocksVersion = window.version;
			this._blocks = 0;
		}
		const complete = Math.floor(window.count / EXTENT_BLOCK);
		if (this._blockLow.length < complete) {
			const low = new Float64Array(Math.max(complete, this._blockLow.length * 2));
			const high = new Float64Array(low.length);
			low.set(this._blockLow.subarray(0, this._blocks));
			high.set(this._blockHigh.subarray(0, this._blocks));
			this._blockLow = low;
			this._blockHigh = high;
		}
		const scan = this._scan;
		for (let block = this._blocks; block < complete; block++) {
			priceExtent(window.price, block * EXTENT_BLOCK, (block + 1) * EXTENT_BLOCK, scan);
			this._blockLow[block] = scan.low;
			this._blockHigh[block] = scan.high;
		}
		this._blocks = complete;
		const first = Math.ceil(from / EXTENT_BLOCK);
		const last = Math.min(complete, Math.floor(to / EXTENT_BLOCK));
		if (last <= first) {
			priceExtent(window.price, from, to, out);
			return;
		}
		priceExtent(window.price, from, first * EXTENT_BLOCK, out);
		let low = out.low;
		let high = out.high;
		for (let block = first; block < last; block++) {
			low = Math.min(low, this._blockLow[block]!);
			high = Math.max(high, this._blockHigh[block]!);
		}
		priceExtent(window.price, last * EXTENT_BLOCK, to, scan);
		out.low = Math.min(low, scan.low);
		out.high = Math.max(high, scan.high);
	}

	/** The pixel of points without a value. */
	private _color(): number {
		const options = this.seriesOptions as ScatterOptions;
		if (options !== this._colorOptions) {
			this._colorOptions = options;
			this._colorPixel = parseColor(options.color) ?? 0;
		}
		return this._colorPixel;
	}

	private _prepare(): number {
		const options = this.seriesOptions as ScatterOptions;
		const size = this._size(this._host.pixelRatio());
		const circle = options.shape === 'circle';
		if (size !== this._stamp.size || circle !== this._stampCircle) {
			this._stamp = makeStamp(size, circle);
			this._stampCircle = circle;
		}
		return options.barAlign === 'start' ? -this._host.map.spacing / 2 : 0;
	}

	protected _drawAll(map: TimeMap): void {
		const window = this.window;
		const from = window.lowerBound(this.viewFrom);
		const to = Math.max(from, window.upperBound(this.viewTo));
		this._marks = to - from;
		this._drawRows(map, from, to, this._box);
	}

	protected _drawRows(map: TimeMap, from: number, to: number, box: PixelBox): void {
		const shift = this._prepare();
		const window = this.window;
		const surface = this.surface;
		emptyBox(box);
		drawScatter(
			surface.pixels,
			surface.width,
			surface.height,
			window.time,
			window.price,
			window.values,
			from,
			Math.min(to, window.count),
			map,
			shift,
			this._projection,
			this._palette,
			this._mapping,
			this._color(),
			this._stamp,
			box,
		);
		const whole = surface.box;
		whole.left = Math.min(whole.left, box.left);
		whole.top = Math.min(whole.top, box.top);
		whole.right = Math.max(whole.right, box.right);
		whole.bottom = Math.max(whole.bottom, box.bottom);
	}
}

export class HeatmapSeries extends MarkSeries implements HeatmapSeriesApi {
	public readonly type = 'heatmap';
	public readonly margin = HEATMAP_MARGIN;
	/** The grid of the last `setData`, which `update` packs columns for. */
	private _grid: HeatmapGrid | null = null;
	private _slots = new Uint8Array(0);
	/** What the slots were made from: the buffers, and the mapping of values. */
	private _slotsVersion = -1;
	private _slotsMin = Number.NaN;
	private _slotsFactor = Number.NaN;
	private _slotsLog = false;
	/** The columns that have slots: `[_slotsFrom, _slotsTo)`. */
	private _slotsFrom = 0;
	private _slotsTo = 0;
	/** The revision of the window whose patches the slots hold. */
	private _slotsRevision = -1;
	private readonly _colors = new Uint32Array(256);
	private _colorsPalette: Uint32Array | null = null;
	private readonly _scratch = new HeatmapScratch();

	public constructor(host: MarkSeriesHost, id: string, options: Partial<HeatmapOptions>) {
		// In the series layer, below the series.
		super(host, id, 'heatmap', options, 'bottom', 0);
	}

	public override options(): Readonly<HeatmapOptions> {
		return this.seriesOptions;
	}

	public setData(data: HeatmapData): void {
		const columns = packHeatmap(data);
		this._grid = { rows: columns.rows, priceStart: columns.priceStart, priceStep: columns.priceStep };
		this._host.engine()?.changeMarks(this.engineId, { op: 'set', data: columns });
		this._replaced();
	}

	/** Columns on the series' grid, packed; throws for a grid that is another or none. */
	private _onGrid(data: HeatmapData, op: string): HeatmapColumns {
		const grid = this._grid;
		if (grid === null || data.rows !== grid.rows || data.priceStep !== grid.priceStep) {
			throw new Error(
				`lumen-charts: columns given to a heatmap's \`${op}\` must be on the grid of its last \`setData\``,
			);
		}
		return packHeatmap(data, grid);
	}

	public prepend(data: HeatmapData): void {
		const columns = this._onGrid(data, 'prepend');
		if (columns.count > 0) {
			this._host.engine()?.changeMarks(this.engineId, { op: 'prepend', data: columns });
		}
	}

	public removeMarks(range: { from: number; to: number }): void {
		removeMarks(this._host, this.engineId, range);
	}

	public update(column: HeatmapColumn): void {
		if (this._grid === null) {
			throw new Error('lumen-charts: a heatmap gets its price grid from `setData`, which must come before `update`');
		}
		this._host.engine()?.changeMarks(this.engineId, { op: 'append', data: packHeatmapColumn(this._grid, column) });
	}

	public append(data: HeatmapData): void {
		const columns = this._onGrid(data, 'append');
		if (columns.count > 0) {
			this._host.engine()?.changeMarks(this.engineId, { op: 'append', data: columns });
		}
	}

	public valueAt(time: number, price: number): number | null {
		const window = this.window;
		if (window.level < 0 || window.count === 0) {
			return null;
		}
		const column = window.upperBound(time) - 1;
		const row = Math.floor((price - window.priceStart) / window.priceStep);
		if (column < 0 || !(row >= 0 && row < window.rows)) {
			return null;
		}
		if (column === window.count - 1) {
			// The last column held is as wide as the one before it, and no wider than that.
			const end = heatEndTime(window.time, window.count, this._host.map);
			if (window.start + window.count < window.total || !(time < end)) {
				return null;
			}
		}
		const value = window.values[column * window.rows + row]!;
		return value === value ? value : null;
	}

	public reach(): number {
		// A column starts half a bar left of where its time falls.
		return this._host.map.spacing / 2 + 1;
	}

	public extent(out: { low: number; high: number }): void {
		const window = this.window;
		out.low = Infinity;
		out.high = -Infinity;
		// A column before the view reaches into it.
		const from = Math.max(0, window.upperBound(this.viewFrom) - 1);
		if (window.level >= 0 && window.upperBound(this.viewTo) > from) {
			out.low = window.priceStart;
			out.high = window.priceStart + window.rows * window.priceStep;
		}
	}

	/**
	 * Brings the slots of columns `[from, to)` up to date with their values and the mapping of values.
	 * Slots are made for the columns a frame draws and kept, so a pan turns only the columns that
	 * come into view into slots, and a new window only those in view.
	 */
	private _quantize(from: number, to: number): void {
		const window = this.window;
		const mapping = this._mapping;
		const rows = window.rows;
		const cells = window.capacity * rows;
		if (this._colorsPalette !== this._palette) {
			slotColors(this._palette, this._colors);
			this._colorsPalette = this._palette;
		}
		if (!this._slotsMatch()) {
			if (this._slots.length < cells) {
				// Whole words: the WebGL2 renderer uploads the slots four to a word.
				this._slots = new Uint8Array((cells + 3) & ~3);
			}
			this._slotsVersion = window.version;
			this._slotsMin = mapping.min;
			this._slotsFactor = mapping.factor;
			this._slotsLog = mapping.log;
			this._slotsFrom = 0;
			this._slotsTo = 0;
			this._slotsRevision = window.revision;
		} else {
			this._quantizePatches();
		}
		if (to <= from) {
			return;
		}
		if (this._slotsTo <= this._slotsFrom || from > this._slotsTo || to < this._slotsFrom) {
			quantize(window.values, this._slots, rows, from, to, mapping);
			this._slotsFrom = from;
			this._slotsTo = to;
			return;
		}
		if (from < this._slotsFrom) {
			quantize(window.values, this._slots, rows, from, this._slotsFrom, mapping);
			this._slotsFrom = from;
		}
		if (to > this._slotsTo) {
			quantize(window.values, this._slots, rows, this._slotsTo, to, mapping);
			this._slotsTo = to;
		}
	}

	/** Whether the slots were made from the rows held and the mapping of values of this frame. */
	private _slotsMatch(): boolean {
		const window = this.window,
			mapping = this._mapping;
		return (
			window.version === this._slotsVersion &&
			mapping.min === this._slotsMin &&
			mapping.factor === this._slotsFactor &&
			mapping.log === this._slotsLog &&
			this._slots.length >= window.capacity * window.rows
		);
	}

	/** Brings the slots of the columns patches changed up to date, where they have slots already. */
	private _quantizePatches(): void {
		const window = this.window;
		if (window.dirtyTo <= window.dirtyFrom || window.revision === this._slotsRevision) {
			return;
		}
		this._slotsRevision = window.revision;
		const from = Math.max(window.dirtyFrom, this._slotsFrom);
		const to = Math.min(window.dirtyTo, this._slotsTo);
		if (to > from) {
			quantize(window.values, this._slots, window.rows, from, to, this._mapping);
		}
	}

	/**
	 * A frame drawn from the values, or not drawn, leaves the slots of the columns its patches
	 * changed as they were; renderers that read the slots later would show the old colors.
	 */
	protected override _beforeClearDirty(): void {
		if (this._slotsTo > this._slotsFrom && this._slotsMatch()) {
			this._quantizePatches();
		}
	}

	private readonly _heatSlots: HeatSlots = {
		update: (from, to) => {
			this._quantize(from, to);
			return this._slots;
		},
		holds: (from, to) => to <= from || (from >= this._slotsFrom && to <= this._slotsTo),
	};

	/**
	 * With `valueMin` and `valueMax` set, a value's slot depends on the value alone: renderers can
	 * keep the slots of cells and update those of the cells that change. Otherwise a change of the
	 * value range would change the slots of every cell.
	 */
	protected override _fixedSlots(): HeatSlots | null {
		const options = this.seriesOptions as HeatmapOptions;
		return options.valueMin !== null && options.valueMax !== null ? this._heatSlots : null;
	}

	private readonly panRanges = new HeatRanges();
	private readonly pan = new HeatPan();

	protected override reusePan(compatible: boolean): boolean {
		const surface = this.surface,
			w = this.window,
			map = this._host.map;
		const from = Math.max(0, w.upperBound(this.viewFrom) - 1),
			to = Math.min(w.count, w.upperBound(this.viewTo) + 1);
		const { width, height } = surface;
		this.panRanges.project({ window: w, map, projection: this._projection, width, height, from, to });
		const ranges = this.panRanges.data;
		const delta = this.pan.translation(map.x(w.time[0]!), ranges, width, height, compatible);
		if (delta === null || Math.abs(delta) > width / 4) return false;
		this._marks = Math.max(0, to - from) * w.rows;
		if (!delta) return true;
		surface.shiftColumns(delta);
		const left = delta > 0 ? 0 : width + delta,
			right = delta > 0 ? delta : width;
		this._quantize(from, to);
		for (let x = left; x < right; x++) {
			const c0 = ranges[x * 2]!,
				c1 = ranges[x * 2 + 1]!;
			for (let y = 0; y < height; y++) {
				const k = (width + y) * 2,
					lo = ranges[k]!,
					hi = ranges[k + 1]!;
				let slot = 0;
				for (let c = c0; c < c1; c++) for (let r = lo; r < hi; r++) slot = Math.max(slot, this._slots[c * w.rows + r]!);
				surface.pixels[x * height + y] = this._colors[slot]!;
			}
		}
		Object.assign(surface.box, { left: 0, right: width, top: 0, bottom: height });
		surface.commit({ left, right, top: 0, bottom: height });
		return true;
	}

	protected _drawAll(map: TimeMap): void {
		const window = this.window;
		const surface = this.surface;
		const from = Math.max(0, window.upperBound(this.viewFrom) - 1);
		const to = Math.min(window.count, window.upperBound(this.viewTo) + 1);
		this._quantize(from, to);
		this._marks = Math.max(0, to - from) * window.rows;
		drawHeatmap(
			surface.pixels,
			surface.width,
			surface.height,
			window.time,
			this._slots,
			window.rows,
			window.count,
			from,
			to,
			window.priceStart,
			window.priceStep,
			map,
			this._projection,
			this._colors,
			this._scratch,
			0,
			surface.width,
			surface.box,
		);
	}

	protected _drawRows(map: TimeMap, from: number, _to: number, box: PixelBox): void {
		const window = this.window;
		const surface = this.surface;
		const whole = surface.box;
		const viewFirst = Math.max(0, window.upperBound(this.viewFrom) - 1);
		const end = Math.min(window.count, window.upperBound(this.viewTo) + 1);
		// The preceding column's right edge can move. Earlier columns rounded to the
		// same left edge also contribute to its maximum in a full draw.
		let first = Math.max(viewFirst, from - 1);
		if (first >= end) return;
		const edge = (i: number) => Math.round(map.x(window.time[i]!) - map.spacing / 2);
		const left = Math.max(0, Math.min(surface.width, edge(first)));
		if (left === surface.width) return;
		if (left > 0) {
			while (first > viewFirst && edge(first - 1) === left) first--;
		}
		this._quantize(first, end);
		// Everything from there to the right edge of the picture is drawn again: the last column's
		// right edge follows from the columns before it.
		const right = Math.max(left, whole.right);
		if (whole.bottom > whole.top) {
			for (let x = left; x < right; x++) {
				surface.pixels.fill(0, x * surface.height + whole.top, x * surface.height + whole.bottom);
			}
		}
		if (whole.right > whole.left) {
			whole.right = Math.max(whole.left, Math.min(whole.right, left));
		}
		drawHeatmap(
			surface.pixels,
			surface.width,
			surface.height,
			window.time,
			this._slots,
			window.rows,
			window.count,
			first,
			end,
			window.priceStart,
			window.priceStep,
			map,
			this._projection,
			this._colors,
			this._scratch,
			0,
			surface.width,
			whole,
		);
		box.left = left;
		box.right = Math.max(right, whole.right);
		box.top = whole.top;
		box.bottom = whole.bottom;
	}
}
