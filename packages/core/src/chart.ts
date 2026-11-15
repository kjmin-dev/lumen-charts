import { type EngineClient, type EngineEvent, createEngine, valueColumnCount } from '@lumen-charts/engine';
import { WindowCache } from './data/window-cache';
import { Interaction, type InteractionHost } from './input/interaction';
import { INVALIDATE_FULL, INVALIDATE_LIGHT, INVALIDATE_NONE, type Invalidation } from './model/invalidation';
import { PriceScale } from './model/price-scale';
import { TimeScale } from './model/time-scale';
import { TimeTicks, formatDateTime } from './model/time-ticks';
import {
	type CandlestickOptions,
	type ChartOptions,
	DEFAULT_OPTIONS,
	type LineOptions,
	definedOnly,
	shallowEqual,
} from './options';
import {
	type AxisStyle,
	drawDashedColumn,
	drawDashedRow,
	drawGrid,
	drawPriceAxis,
	drawTag,
	drawTimeAxis,
} from './render/chrome';
import { Layer } from './render/layer';
import { drawCandles, drawLine } from './render/series';
import { Series, type SeriesApi, type SeriesType, type SeriesTypes } from './series';
import { type Geometry, candleWidths } from './views/series-view';

/** A range of logical positions: bar `i` covers `[i - 0.5, i + 0.5)`. */
export interface LogicalRange {
	from: number;
	to: number;
}

/**
 * Controls the visible part of the timeline. Data is applied asynchronously by the engine, so a
 * call made after `setData` or `update` takes effect once that data has arrived.
 */
export interface TimeScaleApi {
	/** Shows every bar. */
	fitContent(): void;
	/** Scrolls so the last bar sits at the right edge. */
	scrollToRealTime(): void;
	setVisibleLogicalRange(range: LogicalRange): void;
	/** The range on screen right now, or null while there is no data. */
	getVisibleLogicalRange(): LogicalRange | null;
}

export interface ChartApi {
	/** Merges options. Applying values equal to the current ones does nothing. */
	applyOptions(options: Partial<ChartOptions>): void;
	options(): Readonly<ChartOptions>;
	/** Sets an explicit size in CSS pixels. Has no effect while `autoSize` is on. */
	resize(width: number, height: number): void;
	/** Root element created by the chart inside the container. */
	element(): HTMLElement;
	addSeries<T extends SeriesType>(type: T, options?: Partial<SeriesTypes[T]['options']>): SeriesApi<T>;
	removeSeries(series: SeriesApi): void;
	timeScale(): TimeScaleApi;
	/** Resolves once all data handed over so far has been applied and painted. */
	whenIdle(): Promise<void>;
	/** Where the data engine runs; `connecting` until a worker has answered or failed. */
	engineMode(): 'none' | 'connecting' | 'worker' | 'local';
	/** Removes the chart from the DOM and releases its resources. */
	destroy(): void;
}

const MIN_AXIS_WIDTH = 40;
const AXIS_PADDING = 8;
/** The price axis grows as soon as a label needs it but shrinks only past this slack, to avoid jitter. */
const AXIS_SHRINK_SLACK = 12;

interface Deferred {
	seq: number;
	action: () => void;
}

class Chart implements ChartApi, InteractionHost, TimeScaleApi {
	public readonly scale: TimeScale;
	private readonly _container: HTMLElement;
	private readonly _root: HTMLDivElement;
	private readonly _pane: Layer;
	private readonly _priceAxis: Layer;
	private readonly _timeAxis: Layer;
	private readonly _overlay: Layer;
	private readonly _interaction: Interaction;
	private readonly _priceScale = new PriceScale();
	private readonly _timeTicks = new TimeTicks();
	private readonly _cache = new WindowCache();
	private readonly _series: Series[] = [];
	private readonly _geometry: Geometry = { origin: 0, spacing: 1, from: 0, to: 0 };
	private readonly _widths = { body: 1, wick: 1 };

	private _options: ChartOptions;
	private _engine: EngineClient | null = null;
	private _width = 0;
	private _height = 0;
	private _paneWidth = 0;
	private _paneHeight = 0;
	private _axisWidth = MIN_AXIS_WIDTH;
	private _axisHeight = 0;
	private _pixelRatio = 1;
	private _digitWidth = 0;
	private _font = '';
	private _layersDirty = true;

	private _level: Invalidation = INVALIDATE_NONE;
	private _frame: number | null = null;
	private _resizeObserver: ResizeObserver | null = null;
	private _destroyed = false;
	private _deferred: Deferred[] = [];
	private _idle: (() => void)[] = [];

	private _crosshairVisible = false;
	private _crosshairX = 0;
	private _crosshairY = 0;

	/** Device-pixel positions of grid lines and axis labels. */
	private _tickXs = new Float32Array(64);
	private _tickYs = new Float32Array(64);
	/** What the time ticks were last computed for, and a counter that changes when they are recomputed. */
	private _ticksScale = -1;
	private _ticksCache = -1;
	private _ticksFrom = 0;
	private _ticksTo = 0;
	private _ticksGeneration = 0;
	/** What the axes last showed; -1 forces a redraw. */
	private _priceAxisDrawn = -1;
	private _timeAxisDrawn = -1;
	private _timeAxisOrigin = 0;
	private readonly _axisStyle: AxisStyle = { background: '', textColor: '', borderColor: '', font: '', pixelRatio: 1 };
	private _ratioQuery: MediaQueryList | null = null;

	public constructor(container: HTMLElement, options: Partial<ChartOptions>) {
		this._container = container;
		this._options = { ...DEFAULT_OPTIONS, ...definedOnly(options) };
		this.scale = new TimeScale(this._options.barSpacing, this._options.rightOffset);

		const doc = container.ownerDocument;
		this._root = doc.createElement('div');
		this._root.style.position = 'relative';
		this._root.style.overflow = 'hidden';
		this._pane = new Layer(doc, true);
		this._priceAxis = new Layer(doc, true);
		this._timeAxis = new Layer(doc, true);
		this._overlay = new Layer(doc, false);
		this._overlay.canvas.style.pointerEvents = 'none';
		this._root.append(this._pane.canvas, this._priceAxis.canvas, this._timeAxis.canvas, this._overlay.canvas);
		container.appendChild(this._root);
		this._interaction = new Interaction(this._root, this);

		this._watchPixelRatio();
		this._syncSizing();
	}

	// ChartApi

	public applyOptions(options: Partial<ChartOptions>): void {
		if (this._destroyed) {
			return;
		}
		const next = { ...this._options, ...definedOnly(options) };
		if (shallowEqual(this._options, next)) {
			return;
		}
		this._options = next;
		this._syncSizing();
		this._font = '';
		this._ticksScale = -1;
		this._computeLayout();
		this.invalidate(INVALIDATE_FULL);
	}

	public options(): Readonly<ChartOptions> {
		return this._options;
	}

	public resize(width: number, height: number): void {
		if (this._destroyed || this._options.autoSize) {
			return;
		}
		this.applyOptions({ width, height });
	}

	public element(): HTMLElement {
		return this._root;
	}

	public addSeries<T extends SeriesType>(type: T, options: Partial<SeriesTypes[T]['options']> = {}): SeriesApi<T> {
		if (this._engine === null && !this._destroyed) {
			this._engine = createEngine({ worker: this._options.worker });
			this._engine.onevent = this._onEvent;
		}
		const kind = type === 'candlestick' ? 'ohlcv' : 'line';
		const id = this._engine?.addSeries(kind) ?? -1;
		const series = new Series(this, id, type, options as Partial<CandlestickOptions> | Partial<LineOptions>);
		this._series.push(series);
		return series as unknown as SeriesApi<T>;
	}

	public removeSeries(series: SeriesApi): void {
		const index = this._series.indexOf(series as unknown as Series);
		if (index < 0) {
			return;
		}
		const removed = this._series.splice(index, 1)[0]!;
		this._cache.blocks.delete(removed.id);
		this._engine?.removeSeries(removed.id);
		this.invalidate(INVALIDATE_LIGHT);
	}

	public timeScale(): TimeScaleApi {
		return this;
	}

	public whenIdle(): Promise<void> {
		if (this._isIdle()) {
			return Promise.resolve();
		}
		return new Promise(resolve => {
			this._idle.push(resolve);
		});
	}

	public engineMode(): 'none' | 'connecting' | 'worker' | 'local' {
		return this._engine === null ? 'none' : this._engine.mode;
	}

	public destroy(): void {
		if (this._destroyed) {
			return;
		}
		this._destroyed = true;
		this._resizeObserver?.disconnect();
		this._resizeObserver = null;
		if (this._frame !== null) {
			cancelAnimationFrame(this._frame);
			this._frame = null;
		}
		this._interaction.destroy();
		this._ratioQuery?.removeEventListener('change', this._onPixelRatio);
		this._ratioQuery = null;
		this._engine?.destroy();
		this._engine = null;
		this._deferred = [];
		this._pane.release();
		this._priceAxis.release();
		this._timeAxis.release();
		this._overlay.release();
		this._root.remove();
		this._settle();
	}

	// TimeScaleApi

	public fitContent(): void {
		this._afterData(() => {
			this.scale.fitContent();
		});
	}

	public scrollToRealTime(): void {
		this._afterData(() => {
			this.scale.scrollToRealTime();
		});
	}

	public setVisibleLogicalRange(range: LogicalRange): void {
		const { from, to } = range;
		this._afterData(() => {
			this.scale.setVisibleRange(from, to);
		});
	}

	public getVisibleLogicalRange(): LogicalRange | null {
		const scale = this.scale;
		return scale.isEmpty || scale.width <= 0 ? null : { from: scale.from, to: scale.to };
	}

	// InteractionHost and SeriesHost

	public paneWidth(): number {
		return this._paneWidth;
	}

	public paneHeight(): number {
		return this._paneHeight;
	}

	public setCrosshair(x: number, y: number, visible: boolean): void {
		this._crosshairX = x;
		this._crosshairY = y;
		this._crosshairVisible = visible;
	}

	public engine(): EngineClient | null {
		return this._engine;
	}

	/** Coalesces any number of changes into one draw per animation frame. */
	public invalidate(level: Invalidation): void {
		if (this._destroyed) {
			return;
		}
		if (level > this._level) {
			this._level = level;
		}
		if (this._frame === null) {
			this._frame = requestAnimationFrame(this._draw);
		}
	}

	// Data flow

	/** Runs `action` once the engine has applied everything requested so far, keeping call order. */
	private _afterData(action: () => void): void {
		if (this._destroyed) {
			return;
		}
		const engine = this._engine;
		if (engine === null || engine.pending === 0) {
			action();
			this.invalidate(INVALIDATE_LIGHT);
			return;
		}
		this._deferred.push({ seq: engine.barrier(), action });
	}

	private readonly _valueColumns = (id: number): number => {
		for (const series of this._series) {
			if (series.id === id) {
				return valueColumnCount(series.kind);
			}
		}
		return 1;
	};

	private readonly _onEvent = (event: EngineEvent): void => {
		const scale = this.scale;
		const wasEmpty = scale.isEmpty;
		const version = scale.version;
		this._cache.apply(event, this._valueColumns);
		scale.setExtent(event.first, event.end);
		if (wasEmpty && !scale.isEmpty) {
			scale.reset(this._options.barSpacing, this._options.rightOffset);
		}
		let changed = scale.version !== version || event.stale || event.window !== undefined || event.patches !== undefined;
		const deferred = this._deferred;
		while (deferred.length > 0 && deferred[0]!.seq <= event.ack) {
			deferred.shift()!.action();
			changed = true;
		}
		if (changed) {
			this.invalidate(INVALIDATE_LIGHT);
		} else {
			this._settle();
		}
	};

	private _isIdle(): boolean {
		return this._destroyed || (this._frame === null && (this._engine === null || this._engine.pending === 0));
	}

	private _settle(): void {
		if (this._idle.length === 0 || !this._isIdle()) {
			return;
		}
		const waiters = this._idle;
		this._idle = [];
		for (const resolve of waiters) {
			resolve();
		}
	}

	// Sizing and layout

	private _syncSizing(): void {
		if (this._options.autoSize) {
			this._root.style.width = '100%';
			this._root.style.height = '100%';
			if (this._resizeObserver === null && typeof ResizeObserver !== 'undefined') {
				this._resizeObserver = new ResizeObserver(() => this._measure());
				this._resizeObserver.observe(this._container);
			}
			this._measure();
		} else {
			this._resizeObserver?.disconnect();
			this._resizeObserver = null;
			this._root.style.width = `${this._options.width}px`;
			this._root.style.height = `${this._options.height}px`;
			this._setSize(this._options.width, this._options.height);
		}
	}

	private _measure(): void {
		const rect = this._container.getBoundingClientRect();
		this._setSize(Math.floor(rect.width), Math.floor(rect.height));
	}

	private _setSize(width: number, height: number): void {
		if (width === this._width && height === this._height) {
			return;
		}
		this._width = width;
		this._height = height;
		this._computeLayout();
		this.invalidate(INVALIDATE_FULL);
	}

	/** Splits the chart into pane and axes. Only numbers change here; canvases follow in the next draw. */
	private _computeLayout(): void {
		this._axisHeight = Math.round(this._options.fontSize + 16);
		this._paneWidth = Math.max(0, this._width - this._axisWidth);
		this._paneHeight = Math.max(0, this._height - this._axisHeight);
		this.scale.setWidth(this._paneWidth);
		this._priceScale.setHeight(this._paneHeight);
		this._layersDirty = true;
	}

	/** Redraws at the new resolution when the window moves to another screen or the page is zoomed. */
	private _watchPixelRatio(): void {
		const view = this._container.ownerDocument.defaultView;
		if (view === null || typeof view.matchMedia !== 'function') {
			return;
		}
		this._ratioQuery?.removeEventListener('change', this._onPixelRatio);
		this._ratioQuery = view.matchMedia(`(resolution: ${view.devicePixelRatio}dppx)`);
		this._ratioQuery.addEventListener?.('change', this._onPixelRatio);
	}

	private readonly _onPixelRatio = (): void => {
		this._watchPixelRatio();
		this.invalidate(INVALIDATE_FULL);
	};

	private _placeLayers(): void {
		this._layersDirty = false;
		const ratio = this._container.ownerDocument.defaultView?.devicePixelRatio ?? 1;
		this._pixelRatio = ratio;
		const { _paneWidth: paneWidth, _paneHeight: paneHeight } = this;
		this._pane.place(0, 0, paneWidth, paneHeight, ratio);
		this._priceAxis.place(paneWidth, 0, this._axisWidth, paneHeight, ratio);
		this._timeAxis.place(0, paneHeight, this._width, this._axisHeight, ratio);
		this._overlay.place(0, 0, this._width, this._height, ratio);
		// Resizing a canvas clears it, so the axes are drawn again whatever their state.
		this._priceAxisDrawn = -1;
		this._timeAxisDrawn = -1;
		const font = `${this._options.fontSize * ratio}px ${this._options.fontFamily}`;
		if (font !== this._font) {
			this._font = font;
			const ctx = this._overlay.ctx;
			if (ctx === null) {
				this._digitWidth = this._options.fontSize * 0.6;
			} else {
				ctx.font = font;
				this._digitWidth = ctx.measureText('0').width / ratio;
			}
		}
	}

	// Frame

	private readonly _draw = (now: number): void => {
		this._frame = null;
		const level = this._level;
		this._level = INVALIDATE_NONE;
		const animating = this._interaction.step(now);
		if (level === INVALIDATE_FULL || this._font === '') {
			this._placeLayers();
		}
		if (level >= INVALIDATE_LIGHT) {
			this._updateModel();
			if (this._fitPriceAxis()) {
				// The axis takes its width from the pane. The same bars stay visible, slightly narrower.
				const scale = this.scale;
				const from = scale.from;
				const to = scale.to;
				this._computeLayout();
				scale.setVisibleRange(from, to);
				this._updateModel();
			}
			if (this._layersDirty) {
				this._placeLayers();
			}
			if (this._paneWidth > 0 && this._paneHeight > 0) {
				this._renderPane();
				this._renderAxes();
			}
		}
		if (this._paneWidth > 0 && this._paneHeight > 0) {
			this._renderOverlay();
		}
		this._cache.clearDirty();
		if (animating) {
			this.invalidate(INVALIDATE_LIGHT);
		}
		this._settle();
	};

	/** Brings scales, items and ticks up to date with the time scale and the window cache. */
	private _updateModel(): void {
		const scale = this.scale;
		const cache = this._cache;
		const ratio = this._pixelRatio;
		const engine = this._engine;
		if (engine !== null && !scale.isEmpty) {
			const request = cache.plan(scale.from, scale.to, scale.first, scale.end);
			if (request !== null) {
				engine.requestWindow(request.start, request.count, request.capacity);
			}
		}

		const geometry = this._geometry;
		geometry.spacing = scale.barSpacing * ratio;
		geometry.origin = (scale.width - (scale.end - 1 + scale.rightOffset + 0.5) * scale.barSpacing) * ratio;
		const cacheEnd = cache.start + cache.count;
		geometry.from = Math.max(cache.start, Math.ceil(scale.from - 0.5));
		geometry.to = Math.min(cacheEnd, Math.floor(scale.to + 0.5) + 1);
		if (scale.isEmpty || geometry.to < geometry.from) {
			geometry.to = geometry.from;
		}

		let min = Infinity;
		let max = -Infinity;
		const lastRow = scale.end - 1 - cache.start;
		for (const series of this._series) {
			series.bind(cache.blocks.get(series.id), cache.capacity, cache.version);
			const view = series.view;
			if (series.open.length === 0) {
				view.reset();
				continue;
			}
			view.update(
				geometry,
				series.open,
				series.high,
				series.low,
				series.close,
				cache.start,
				cache.version,
				cache.dirtyLo,
				cache.dirtyHi,
			);
			if (view.min < min) {
				min = view.min;
			}
			if (view.max > max) {
				max = view.max;
			}
			if (lastRow >= 0 && lastRow < cache.count) {
				const close = series.close[lastRow]!;
				if (close === close) {
					series.lastValue = close;
					series.lastUp = close >= series.open[lastRow]!;
				}
			}
		}

		const priceScale = this._priceScale;
		if (min <= max) {
			priceScale.setRange(min, max);
		}
		const offset = priceScale.offset * ratio;
		const priceToDevice = priceScale.scale * ratio;
		for (const series of this._series) {
			series.view.project(offset, priceToDevice, series.kind === 'ohlcv');
		}

		const fontSize = this._options.fontSize;
		priceScale.updateTicks(Math.max(32, fontSize * 3.5));
		const priceTicks = priceScale.tickCount;
		if (this._tickYs.length < priceTicks) {
			this._tickYs = new Float32Array(priceTicks * 2);
		}
		for (let i = 0; i < priceTicks; i++) {
			this._tickYs[i] = Math.round(priceScale.priceToY(priceScale.tickPrices[i]!) * ratio);
		}

		// Time ticks depend only on which bars are visible and how far apart they are.
		const timeTicks = this._timeTicks;
		if (
			scale.version !== this._ticksScale ||
			cache.version !== this._ticksCache ||
			geometry.from !== this._ticksFrom ||
			geometry.to !== this._ticksTo
		) {
			this._ticksScale = scale.version;
			this._ticksCache = cache.version;
			this._ticksFrom = geometry.from;
			this._ticksTo = geometry.to;
			this._ticksGeneration++;
			timeTicks.update(
				cache.time,
				geometry.from - cache.start,
				geometry.to - cache.start,
				Math.max(1, (fontSize * 7) / scale.barSpacing),
			);
		}
		if (this._tickXs.length < timeTicks.count) {
			this._tickXs = new Float32Array(timeTicks.count * 2);
		}
		for (let i = 0; i < timeTicks.count; i++) {
			const index = cache.start + timeTicks.position[i]!;
			this._tickXs[i] = Math.round(geometry.origin + index * geometry.spacing);
		}
	}

	/** Adjusts the price axis width to its longest label. Returns true if the layout changed. */
	private _fitPriceAxis(): boolean {
		const priceScale = this._priceScale;
		let characters = priceScale.format(priceScale.max).length;
		for (let i = 0; i < priceScale.tickCount; i++) {
			const length = priceScale.tickLabels[i]!.length;
			if (length > characters) {
				characters = length;
			}
		}
		const needed = Math.max(MIN_AXIS_WIDTH, Math.ceil((characters * this._digitWidth + 2 * AXIS_PADDING) / 4) * 4);
		if (needed <= this._axisWidth && needed + AXIS_SHRINK_SLACK >= this._axisWidth) {
			return false;
		}
		if (this._series.length === 0 || this.scale.isEmpty) {
			return false;
		}
		this._axisWidth = needed;
		return true;
	}

	private _renderPane(): void {
		const layer = this._pane;
		const ctx = layer.ctx;
		if (ctx === null) {
			return;
		}
		const options = this._options;
		ctx.fillStyle = options.background;
		ctx.fillRect(0, 0, layer.width, layer.height);
		drawGrid(
			ctx,
			layer.width,
			layer.height,
			options.gridColor,
			this._tickXs,
			this._timeTicks.count,
			this._tickYs,
			this._priceScale.tickCount,
		);
		const ratio = this._pixelRatio;
		const widths = this._widths;
		candleWidths(this._geometry.spacing, ratio, widths);
		for (const series of this._series) {
			const view = series.view;
			if (view.count === 0) {
				continue;
			}
			if (series.kind === 'ohlcv') {
				drawCandles(ctx, view, widths.body, widths.wick, series.seriesOptions as CandlestickOptions);
			} else {
				const line = series.seriesOptions as LineOptions;
				drawLine(ctx, view, line.color, Math.max(1, line.lineWidth * ratio));
			}
		}
	}

	/** Axes are redrawn only when their ticks changed: a tick that leaves the scales alone skips them. */
	private _renderAxes(): void {
		const priceScale = this._priceScale;
		const ratio = this._pixelRatio;
		const options = this._options;
		const style = this._axisStyle;
		style.background = options.background;
		style.textColor = options.textColor;
		style.borderColor = options.gridColor;
		style.font = this._font;
		style.pixelRatio = ratio;
		if (this._priceAxisDrawn !== priceScale.version) {
			const layer = this._priceAxis;
			if (layer.ctx !== null) {
				drawPriceAxis(
					layer.ctx,
					layer.width,
					layer.height,
					style,
					AXIS_PADDING * ratio,
					this._tickYs,
					priceScale.tickLabels,
					priceScale.tickCount,
				);
			}
			this._priceAxisDrawn = priceScale.version;
		}
		const origin = this._geometry.origin;
		if (this._timeAxisDrawn !== this._ticksGeneration || this._timeAxisOrigin !== origin) {
			const layer = this._timeAxis;
			if (layer.ctx !== null) {
				drawTimeAxis(
					layer.ctx,
					layer.width,
					layer.height,
					style,
					this._tickXs,
					this._timeTicks.labels,
					this._timeTicks.count,
				);
			}
			this._timeAxisDrawn = this._ticksGeneration;
			this._timeAxisOrigin = origin;
		}
	}

	/** Last-value lines and the crosshair, on a transparent canvas above everything else. */
	private _renderOverlay(): void {
		const layer = this._overlay;
		const ctx = layer.ctx;
		if (ctx === null) {
			return;
		}
		ctx.clearRect(0, 0, layer.width, layer.height);
		const ratio = this._pixelRatio;
		const options = this._options;
		const priceScale = this._priceScale;
		const paneWidth = this._pane.width;
		const paneHeight = this._pane.height;
		const axisWidth = layer.width - paneWidth;
		const thickness = Math.max(1, Math.floor(ratio));
		const dash = Math.round(3 * ratio);
		const tagHeight = Math.round((options.fontSize + 8) * ratio);
		const textX = paneWidth + AXIS_PADDING * ratio;

		for (const series of this._series) {
			const value = series.lastValue;
			if (value !== value || !series.seriesOptions.lastValueVisible) {
				continue;
			}
			const y = Math.round(priceScale.priceToY(value) * ratio);
			if (y < 0 || y >= paneHeight) {
				continue;
			}
			let color: string;
			if (series.kind === 'ohlcv') {
				const candle = series.seriesOptions as CandlestickOptions;
				color = series.lastUp ? candle.upColor : candle.downColor;
			} else {
				color = (series.seriesOptions as LineOptions).color;
			}
			drawDashedRow(ctx, y, paneWidth, color, dash, thickness);
			drawTag(
				ctx,
				paneWidth,
				y - (tagHeight >> 1),
				axisWidth,
				tagHeight,
				color,
				priceScale.format(value),
				textX,
				'left',
				this._font,
			);
		}

		const scale = this.scale;
		if (!this._crosshairVisible || scale.isEmpty) {
			return;
		}
		const geometry = this._geometry;
		const index = Math.min(scale.end - 1, Math.max(scale.first, Math.round(scale.xToLogical(this._crosshairX))));
		const x = Math.round(geometry.origin + index * geometry.spacing);
		const y = Math.round(this._crosshairY * ratio);
		const color = options.crosshairColor;
		drawDashedColumn(ctx, x, paneHeight, color, dash, thickness);
		drawDashedRow(ctx, y, paneWidth, color, dash, thickness);
		drawTag(
			ctx,
			paneWidth,
			y - (tagHeight >> 1),
			axisWidth,
			tagHeight,
			color,
			priceScale.format(priceScale.yToPrice(this._crosshairY)),
			textX,
			'left',
			this._font,
		);
		const cache = this._cache;
		const row = index - cache.start;
		if (row >= 0 && row < cache.count) {
			const label = formatDateTime(cache.time[row]!);
			const width = Math.ceil((label.length * this._digitWidth + 2 * AXIS_PADDING) * ratio);
			const left = Math.min(Math.max(0, x - (width >> 1)), Math.max(0, paneWidth - width));
			drawTag(
				ctx,
				left,
				paneHeight,
				width,
				layer.height - paneHeight,
				color,
				label,
				left + width / 2,
				'center',
				this._font,
			);
		}
	}
}

/** Creates a chart inside `container`. */
export function createChart(container: HTMLElement, options: Partial<ChartOptions> = {}): ChartApi {
	return new Chart(container, options);
}
