import { type EngineClient, type EngineEvent, columnCount, createEngine, levelFor } from '@lumen-charts/engine';
import { type LevelWindow, WindowCache } from './data/window-cache';
import { Interaction, type InteractionHost } from './input/interaction';
import { INVALIDATE_FULL, INVALIDATE_LIGHT, INVALIDATE_NONE, type Invalidation } from './model/invalidation';
import { PriceScale } from './model/price-scale';
import { TimeScale } from './model/time-scale';
import { TimeTicks, formatDateTime } from './model/time-ticks';
import {
	type CandlestickOptions,
	type ChartOptions,
	type DeepPartial,
	type LineOptions,
	mergeOptions,
	optionsEqual,
	resolveOptions,
} from './options';
import {
	type AxisStyle,
	dashPattern,
	drawColumn,
	drawGrid,
	drawPriceAxis,
	drawRow,
	drawTag,
	drawTimeAxis,
	isFaint,
	textColorOn,
} from './render/chrome';
import { Layer } from './render/layer';
import { drawCandles, drawLine } from './render/series';
import { Series, type SeriesApi, type SeriesCreateOptions, type SeriesType } from './series';
import { type Geometry, candleWidths, placeElements } from './views/series-view';

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
	/**
	 * Merges options, including nested ones: `{ grid: { vertLines: { visible: false } } }` changes
	 * only that value. Applying values equal to the current ones does nothing.
	 */
	applyOptions(options: DeepPartial<ChartOptions>): void;
	/** The options in effect: defaults, then the theme's colors, then everything applied. */
	options(): Readonly<ChartOptions>;
	/** The theme in effect, which `auto` resolves to the system setting. */
	theme(): 'light' | 'dark';
	/** Sets an explicit size in CSS pixels. Has no effect while `autoSize` is on. */
	resize(width: number, height: number): void;
	/** Root element created by the chart inside the container. */
	element(): HTMLElement;
	/**
	 * Adds a series. Pass a `datafeed` to let the chart fetch its history again, which lets the
	 * `memoryLimit` option apply to it.
	 */
	addSeries<T extends SeriesType>(type: T, options?: SeriesCreateOptions<T>): SeriesApi<T>;
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
	private readonly _geometry: Geometry = { origin: 0, spacing: 1, from: 0, to: 0, shift: 0, firstRow: 0 };
	/** Window the series were drawn from in the last model update. */
	private _drawn: LevelWindow | null = null;
	private readonly _widths = { body: 1, wick: 1 };

	/** Everything applied so far, merged; the theme is laid under it whenever it changes. */
	private _input: DeepPartial<ChartOptions>;
	private _options: ChartOptions;
	private _darkQuery: MediaQueryList | null = null;
	private _engine: EngineClient | null = null;
	private _width = 0;
	private _height = 0;
	private _paneLeft = 0;
	private _paneWidth = 0;
	private _paneHeight = 0;
	private _axisWidth = MIN_AXIS_WIDTH;
	private _axisHeight = 0;
	private _pixelRatio = 1;
	private _digitWidth = 0;
	private _font = '';
	private _watermarkFont = '';
	private _watermarkLines: string[] = [];
	private _layersDirty = true;

	private _level: Invalidation = INVALIDATE_NONE;
	private _frame: number | null = null;
	private _resizeObserver: ResizeObserver | null = null;
	private _destroyed = false;
	private _deferred: Deferred[] = [];
	private _idle: (() => void)[] = [];
	/** Limit last sent to the engine. */
	private _memoryLimit = Infinity;
	/** Datafeed requests in flight, by series and first row. */
	private readonly _fetches = new Set<string>();
	/** Pause before asking again for rows whose fetch failed; grows with every failure. */
	private _fetchBackoff = 0;

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
	private readonly _axisStyle: AxisStyle = { background: '', textColor: '', font: '', pixelRatio: 1 };
	private _ratioQuery: MediaQueryList | null = null;
	private _axisFitScale = -1;
	private _axisFitDigit = -1;

	public constructor(container: HTMLElement, options: DeepPartial<ChartOptions>) {
		this._container = container;
		this._input = mergeOptions({}, options);
		this._watchScheme();
		this._options = this._resolve();
		this.scale = new TimeScale(this._options.timeScale.barSpacing, this._options.timeScale.rightOffset);

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
		this._applyResolved(this._options);
	}

	// ChartApi

	public applyOptions(options: DeepPartial<ChartOptions>): void {
		if (this._destroyed) {
			return;
		}
		this._input = mergeOptions(this._input, options);
		this._watchScheme();
		this._update();
	}

	public options(): Readonly<ChartOptions> {
		return this._options;
	}

	public theme(): 'light' | 'dark' {
		const theme = this._options.theme;
		const dark = theme === 'auto' ? this._darkQuery?.matches === true : theme === 'dark';
		return dark ? 'dark' : 'light';
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

	public addSeries<T extends SeriesType>(type: T, options: SeriesCreateOptions<T> = {}): SeriesApi<T> {
		if (this._engine === null && !this._destroyed) {
			this._engine = createEngine({ worker: this._options.worker });
			this._engine.onevent = this._onEvent;
			this._memoryLimit = this._options.memoryLimit;
			if (this._memoryLimit !== Infinity) {
				this._engine.setMemoryLimit(this._memoryLimit);
			}
		}
		const { datafeed, ...style } = options;
		const kind = type === 'candlestick' ? 'ohlcv' : 'line';
		const id = this._engine?.addSeries(kind, datafeed !== undefined) ?? -1;
		const series = new Series(this, id, type, style as Partial<CandlestickOptions> | Partial<LineOptions>);
		series.datafeed = (datafeed as Series['datafeed'] | undefined) ?? null;
		this._series.push(series);
		return series as unknown as SeriesApi<T>;
	}

	public removeSeries(series: SeriesApi): void {
		const index = this._series.indexOf(series as unknown as Series);
		if (index < 0) {
			return;
		}
		const removed = this._series.splice(index, 1)[0]!;
		this._cache.removeSeries(removed.id);
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
		this._darkQuery?.removeEventListener('change', this._onScheme);
		this._darkQuery = null;
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

	public paneLeft(): number {
		return this._paneLeft;
	}

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

	/**
	 * Runs `action` once the engine has applied all data handed over so far, keeping call order.
	 * Window requests in flight do not delay it: a view change does not depend on them.
	 */
	private _afterData(action: () => void): void {
		if (this._destroyed) {
			return;
		}
		const engine = this._engine;
		if (engine === null || !engine.dataPending) {
			action();
			this.invalidate(INVALIDATE_LIGHT);
			return;
		}
		this._deferred.push({ seq: engine.barrier(), action });
	}

	private readonly _columnCount = (id: number, level: number): number => {
		for (const series of this._series) {
			if (series.id === id) {
				return columnCount(series.kind, level);
			}
		}
		return 1;
	};

	private readonly _onEvent = (event: EngineEvent): void => {
		const scale = this.scale;
		const wasEmpty = scale.isEmpty;
		const version = scale.version;
		this._cache.apply(event, this._columnCount);
		scale.setExtent(event.first, event.end);
		if (wasEmpty && !scale.isEmpty) {
			scale.reset(this._options.timeScale.barSpacing, this._options.timeScale.rightOffset);
		}
		this._trackLastValues(event);
		if (event.fetch !== undefined || event.restored !== undefined || event.window?.incomplete === true) {
			this._handleFetches(event);
		}
		// A failed command changes nothing on screen, and redrawing for it would only repeat the request.
		let changed =
			event.failed !== true &&
			(scale.version !== version || event.stale || event.window !== undefined || event.patches !== undefined);
		const deferred = this._deferred;
		while (deferred.length > 0 && deferred[0]!.seq <= event.ack) {
			deferred.shift()!.action();
			changed = true;
		}
		if (changed) {
			// Requested now rather than in the next draw, the rows usually arrive before that frame,
			// so new data is drawn in one frame instead of an empty frame followed by the data.
			this._requestWindow(this._container.ownerDocument.defaultView?.devicePixelRatio ?? 1);
			this.invalidate(INVALIDATE_LIGHT);
		} else {
			this._settle();
		}
	};

	/**
	 * Takes the latest value of each series straight from the patches. The last bar is often outside
	 * the window held by the cache (the user is looking at history), and its value is still shown.
	 */
	private _trackLastValues(event: EngineEvent): void {
		const patches = event.patches;
		if (patches === undefined) {
			return;
		}
		for (const patch of patches) {
			if (patch.level !== 0 || patch.start + patch.count !== event.end) {
				continue;
			}
			for (const series of this._series) {
				if (series.id !== patch.series) {
					continue;
				}
				const rows = patch.count;
				const closeColumn = series.kind === 'ohlcv' ? 3 : 0;
				const close = patch.data[closeColumn * rows + rows - 1]!;
				if (close === close) {
					series.lastValue = close;
					series.lastUp = close >= patch.data[rows - 1]!;
				}
				break;
			}
		}
	}

	private _isIdle(): boolean {
		return (
			this._destroyed ||
			(this._frame === null && this._fetches.size === 0 && (this._engine === null || this._engine.pending === 0))
		);
	}

	/**
	 * Fetches rows the engine let go and needs again from the series' datafeed, and hands them back.
	 * The engine checks them against the rows it let go; a raw window waits for them meanwhile, and the
	 * chart draws a coarse level where it has nothing else.
	 */
	private _handleFetches(event: EngineEvent): void {
		const restored = event.restored;
		if (restored !== undefined) {
			if (restored.outcome === 'restored') {
				this._fetchBackoff = 0;
			} else if (restored.outcome === 'mismatch') {
				console.warn(
					`lumen-charts: the datafeed returned ${restored.received} bars where ${restored.expected} were expected; ` +
						'they do not match the bars they replace and were ignored.',
				);
			}
		}
		if (event.window?.incomplete === true) {
			// The rows could not be fetched: draw what the levels show and ask again after a pause.
			this._fetchBackoff = Math.min(30_000, Math.max(1000, this._fetchBackoff * 2));
			this._cache.raw.holdOff(performance.now() + this._fetchBackoff);
		}
		for (const request of event.fetch ?? []) {
			const engine = this._engine;
			const series = this._series.find(entry => entry.id === request.series);
			const key = `${request.series}:${request.start}`;
			if (engine === null || this._fetches.has(key)) {
				continue;
			}
			if (series?.datafeed === null || series === undefined) {
				engine.restoreRows(request.series, request.start, null, 0);
				continue;
			}
			this._fetches.add(key);
			const { from, to, start, end } = request;
			const done = (data: Float64Array | null, count: number): void => {
				this._fetches.delete(key);
				// After destroy the engine is gone, and nothing waits for the rows.
				this._engine?.restoreRows(series.id, start, data, count);
				this._settle();
			};
			let pending: Promise<unknown>;
			try {
				pending = series.datafeed.getBars({ from, to, countBack: end - start });
			} catch (error) {
				pending = Promise.reject(error);
			}
			pending.then(
				bars => {
					let packed: { data: Float64Array; count: number };
					try {
						packed = series.packFetched(bars as never, from, to);
					} catch {
						done(null, 0);
						return;
					}
					done(packed.data, packed.count);
				},
				() => {
					done(null, 0);
				},
			);
		}
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

	// Options

	private _resolve(): ChartOptions {
		return resolveOptions(this._input, this._darkQuery?.matches === true);
	}

	/** Re-resolves the options, for example after the system color scheme changed. */
	private _update(): void {
		const next = this._resolve();
		if (optionsEqual(next, this._options)) {
			return;
		}
		this._options = next;
		this._applyResolved(next);
		if (this._engine !== null && next.memoryLimit !== this._memoryLimit) {
			this._memoryLimit = next.memoryLimit;
			this._engine.setMemoryLimit(next.memoryLimit);
		}
		this.invalidate(INVALIDATE_FULL);
	}

	/** Pushes resolved options into the parts that keep their own copy. */
	private _applyResolved(options: ChartOptions): void {
		const margins = options.priceScale.scaleMargins;
		this._priceScale.setMargins(margins.top, margins.bottom);
		const watermark = options.watermark;
		this._watermarkLines = watermark.visible && watermark.text !== '' ? watermark.text.split('\n') : [];
		this._priceAxis.setVisible(options.priceScale.visible);
		this._timeAxis.setVisible(options.timeScale.visible);
		this._root.style.cursor = options.crosshair.mode === 'hidden' ? 'default' : 'crosshair';
		this._font = '';
		this._ticksScale = -1;
		this._axisFitScale = -1;
		this._syncSizing();
		this._computeLayout();
	}

	/** Listens to the system color scheme while the theme is `auto`. */
	private _watchScheme(): void {
		const auto = this._input.theme === 'auto';
		if (auto === (this._darkQuery !== null)) {
			return;
		}
		if (!auto) {
			this._darkQuery!.removeEventListener('change', this._onScheme);
			this._darkQuery = null;
			return;
		}
		const view = this._container.ownerDocument.defaultView;
		if (view === null || typeof view.matchMedia !== 'function') {
			return;
		}
		this._darkQuery = view.matchMedia('(prefers-color-scheme: dark)');
		this._darkQuery.addEventListener?.('change', this._onScheme);
	}

	private readonly _onScheme = (): void => {
		if (!this._destroyed) {
			this._update();
		}
	};

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
		const { priceScale, timeScale, layout } = this._options;
		const axisWidth = priceScale.visible ? this._axisWidth : 0;
		this._axisHeight = timeScale.visible ? Math.round(layout.fontSize + 16) : 0;
		this._paneLeft = priceScale.position === 'left' ? axisWidth : 0;
		this._paneWidth = Math.max(0, this._width - axisWidth);
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
		const { _paneLeft: paneLeft, _paneWidth: paneWidth, _paneHeight: paneHeight } = this;
		const options = this._options;
		this._pane.place(paneLeft, 0, paneWidth, paneHeight, ratio);
		if (options.priceScale.visible) {
			const left = options.priceScale.position === 'left' ? 0 : paneWidth;
			this._priceAxis.place(left, 0, this._axisWidth, paneHeight, ratio);
		}
		if (options.timeScale.visible) {
			this._timeAxis.place(0, paneHeight, this._width, this._axisHeight, ratio);
		}
		this._overlay.place(0, 0, this._width, this._height, ratio);
		// Resizing a canvas clears it, so the axes are drawn again whatever their state.
		this._priceAxisDrawn = -1;
		this._timeAxisDrawn = -1;
		const { fontSize, fontFamily } = options.layout;
		const font = `${fontSize * ratio}px ${fontFamily}`;
		if (font !== this._font) {
			this._font = font;
			const ctx = this._overlay.ctx;
			if (ctx === null) {
				this._digitWidth = fontSize * 0.6;
			} else {
				ctx.font = font;
				this._digitWidth = ctx.measureText('0').width / ratio;
			}
		}
		this._watermarkFont = `${options.watermark.fontSize * ratio}px ${fontFamily}`;
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

	/**
	 * Level of detail for a bar spacing in device pixels: raw rows up to 16 bars per pixel, then the
	 * coarsest level whose buckets are not wider than a pixel.
	 */
	private _levelFor(spacing: number): number {
		const scale = this.scale;
		return spacing < 1 ? levelFor(1 / spacing, scale.end - scale.first) : 0;
	}

	/**
	 * Asks the engine for the rows or buckets around the visible range at the level the view needs,
	 * unless the cache has or awaits them.
	 */
	private _requestWindow(ratio: number): void {
		const scale = this.scale;
		const engine = this._engine;
		if (engine !== null && !scale.isEmpty) {
			const level = this._levelFor(scale.barSpacing * ratio);
			const cache = this._cache;
			const request = cache.plan(level, scale.from, scale.to, scale.first, scale.end);
			if (request !== null) {
				engine.requestWindow(request.start, request.count, request.capacity, request.level);
			}
			// While the raw rows for the view are on their way (a fast scroll left the window, or they
			// are fetched again) or could not be fetched, the finest level is drawn instead of nothing.
			// Not before the first raw window, though: right after a load the levels are still being
			// built in the background, and the raw rows come first.
			const raw = cache.level(0);
			const visibleFrom = Math.max(scale.first, Math.ceil(scale.from - 0.5));
			const visibleTo = Math.min(scale.end, Math.floor(scale.to + 0.5) + 1);
			const covered =
				raw.capacity > 0 && raw.rowsFrom(scale.first) <= visibleFrom && raw.rowsTo(scale.end) >= visibleTo;
			if (level === 0 && !covered && (raw.capacity > 0 || raw.incomplete) && scale.end - scale.first >= 16) {
				const fallback = cache.plan(1, scale.from, scale.to, scale.first, scale.end);
				if (fallback !== null) {
					engine.requestWindow(fallback.start, fallback.count, fallback.capacity, fallback.level);
				}
			}
		}
	}

	/** Brings scales, items and ticks up to date with the time scale and the window cache. */
	private _updateModel(): void {
		const scale = this.scale;
		const cache = this._cache;
		const ratio = this._pixelRatio;
		this._requestWindow(ratio);

		const geometry = this._geometry;
		const spacing = scale.barSpacing * ratio;
		let origin = (scale.width - (scale.end - 1 + scale.rightOffset + 0.5) * scale.barSpacing) * ratio;
		const level = this._levelFor(spacing);
		// Visible rows. Below a pixel per bar, rows are binned into pixel columns: the origin sits on
		// a whole pixel, so the bins (and the level the rows come from) never change the picture, and
		// a row is visible when its column is inside the pane.
		let rowFrom: number;
		let rowTo: number;
		if (spacing < 1) {
			origin = Math.round(origin);
			rowFrom = Math.ceil(-origin / spacing);
			rowTo = Math.ceil((Math.max(1, Math.round(scale.width * ratio)) - origin) / spacing);
		} else {
			rowFrom = Math.ceil(scale.from - 0.5);
			rowTo = Math.floor(scale.to + 0.5) + 1;
		}
		rowFrom = Math.max(rowFrom, scale.first);
		rowTo = Math.min(rowTo, scale.end);
		if (scale.isEmpty || rowTo < rowFrom) {
			rowTo = rowFrom;
		}
		const source = cache.source(level, rowFrom, rowTo, scale.first, scale.end);
		cache.retain(level, source === null ? level : source.level);
		this._drawn = source;
		geometry.origin = origin;
		geometry.spacing = spacing;
		geometry.shift = source === null ? 0 : source.shift;
		if (source === null) {
			placeElements(geometry, 0, 0, 0);
		} else {
			placeElements(
				geometry,
				Math.max(rowFrom, source.rowsFrom(scale.first)),
				Math.min(rowTo, source.rowsTo(scale.end)),
				scale.first,
			);
		}

		let min = Infinity;
		let max = -Infinity;
		const size = 2 ** geometry.shift;
		for (const series of this._series) {
			if (source === null) {
				series.bind(undefined, 0, -1, 0);
				series.view.reset();
				continue;
			}
			series.bind(source.blocks.get(series.id), source.capacity, source.version, source.level);
			const view = series.view;
			// A hidden series keeps no items, so it is rebuilt in full once it is shown again.
			if (series.open.length === 0 || !series.seriesOptions.visible) {
				view.reset();
				continue;
			}
			view.update(
				geometry,
				series.open,
				series.high,
				series.low,
				series.close,
				source.start,
				source.version,
				source.dirtyLo,
				source.dirtyHi,
			);
			if (view.min < min) {
				min = view.min;
			}
			if (view.max > max) {
				max = view.max;
			}
			const lastRow = Math.floor((scale.end - 1) / size) - source.start;
			if (lastRow >= 0 && lastRow < source.count) {
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

		const fontSize = this._options.layout.fontSize;
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
		const version = source === null ? -1 : source.version;
		if (
			scale.version !== this._ticksScale ||
			version !== this._ticksCache ||
			geometry.from !== this._ticksFrom ||
			geometry.to !== this._ticksTo
		) {
			this._ticksScale = scale.version;
			this._ticksCache = version;
			this._ticksFrom = geometry.from;
			this._ticksTo = geometry.to;
			this._ticksGeneration++;
			if (source === null) {
				timeTicks.count = 0;
			} else {
				// At a coarse level the labels sit on buckets, which hold `size` bars each.
				timeTicks.update(
					source.time,
					geometry.from - source.start,
					geometry.to - source.start,
					Math.max(1, (fontSize * 7) / (scale.barSpacing * size)),
				);
			}
		}
		if (this._tickXs.length < timeTicks.count) {
			this._tickXs = new Float32Array(timeTicks.count * 2);
		}
		const tickStart = source === null ? 0 : source.start;
		for (let i = 0; i < timeTicks.count; i++) {
			const index = Math.max((tickStart + timeTicks.position[i]!) * size, scale.first);
			this._tickXs[i] = Math.round(geometry.origin + index * geometry.spacing);
		}
	}

	/** Adjusts the price axis width to its longest label. Returns true if the layout changed. */
	private _fitPriceAxis(): boolean {
		if (!this._options.priceScale.visible) {
			return false;
		}
		const priceScale = this._priceScale;
		// Labels change only with the scale, so most frames have nothing to measure.
		if (priceScale.version === this._axisFitScale && this._digitWidth === this._axisFitDigit) {
			return false;
		}
		this._axisFitScale = priceScale.version;
		this._axisFitDigit = this._digitWidth;
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
		const ratio = this._pixelRatio;
		ctx.fillStyle = options.layout.background;
		ctx.fillRect(0, 0, layer.width, layer.height);
		drawGrid(
			ctx,
			layer.width,
			layer.height,
			this._tickXs,
			this._timeTicks.count,
			this._tickYs,
			this._priceScale.tickCount,
			options.grid.vertLines,
			options.grid.horzLines,
			ratio,
		);
		if (this._watermarkLines.length > 0) {
			this._renderWatermark(ctx, layer.width, layer.height);
		}
		const widths = this._widths;
		// A bucket drawn as one candle (a coarse level shown wider than a pixel) is as wide as its bars.
		candleWidths(this._geometry.spacing * 2 ** this._geometry.shift, ratio, widths);
		const border = Math.max(1, Math.floor(ratio));
		for (const series of this._series) {
			const view = series.view;
			if (view.count === 0 || !series.seriesOptions.visible) {
				continue;
			}
			if (series.kind === 'ohlcv') {
				drawCandles(ctx, view, widths.body, widths.wick, border, series.seriesOptions as CandlestickOptions);
			} else {
				const line = series.seriesOptions as LineOptions;
				const width = Math.max(1, line.lineWidth * ratio);
				drawLine(ctx, view, line.color, width, dashPattern(line.lineStyle, width), line.lineType === 'step');
			}
		}
	}

	private _renderWatermark(ctx: CanvasRenderingContext2D, width: number, height: number): void {
		const watermark = this._options.watermark;
		const lines = this._watermarkLines;
		const ratio = this._pixelRatio;
		const lineHeight = watermark.fontSize * ratio * 1.2;
		const padding = 2 * AXIS_PADDING * ratio;
		const block = lineHeight * lines.length;
		const { horzAlign, vertAlign } = watermark;
		const x = horzAlign === 'left' ? padding : horzAlign === 'right' ? width - padding : width / 2;
		let y = vertAlign === 'top' ? padding : vertAlign === 'bottom' ? height - padding - block : (height - block) / 2;
		y += lineHeight / 2;
		ctx.font = this._watermarkFont;
		ctx.fillStyle = watermark.color;
		ctx.textAlign = horzAlign;
		ctx.textBaseline = 'middle';
		for (const line of lines) {
			ctx.fillText(line, x, y);
			y += lineHeight;
		}
	}

	/** Axes are redrawn only when their ticks changed: a tick that leaves the scales alone skips them. */
	private _renderAxes(): void {
		const priceScale = this._priceScale;
		const ratio = this._pixelRatio;
		const options = this._options;
		const style = this._axisStyle;
		style.background = options.layout.background;
		style.textColor = options.layout.textColor;
		style.font = this._font;
		style.pixelRatio = ratio;
		const priceOptions = options.priceScale;
		if (priceOptions.visible && this._priceAxisDrawn !== priceScale.version) {
			const layer = this._priceAxis;
			if (layer.ctx !== null) {
				drawPriceAxis(
					layer.ctx,
					layer.width,
					layer.height,
					style,
					priceOptions.borderVisible ? priceOptions.borderColor : '',
					priceOptions.position,
					AXIS_PADDING * ratio,
					this._tickYs,
					priceScale.tickLabels,
					priceScale.tickCount,
				);
			}
			this._priceAxisDrawn = priceScale.version;
		}
		const timeOptions = options.timeScale;
		const origin = this._geometry.origin;
		if (timeOptions.visible && (this._timeAxisDrawn !== this._ticksGeneration || this._timeAxisOrigin !== origin)) {
			const layer = this._timeAxis;
			if (layer.ctx !== null) {
				drawTimeAxis(
					layer.ctx,
					layer.width,
					layer.height,
					style,
					timeOptions.borderVisible ? timeOptions.borderColor : '',
					Math.round(this._paneLeft * ratio),
					this._tickXs,
					this._timeTicks.labels,
					this._timeTicks.count,
				);
			}
			this._timeAxisDrawn = this._ticksGeneration;
			this._timeAxisOrigin = origin;
		}
	}

	/** Price lines, value labels and the crosshair, on a transparent canvas above everything else. */
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
		const paneLeft = Math.round(this._paneLeft * ratio);
		const paneWidth = this._pane.width;
		const paneHeight = this._pane.height;
		const axisVisible = options.priceScale.visible;
		const leftAxis = options.priceScale.position === 'left';
		const axisLeft = leftAxis ? 0 : paneLeft + paneWidth;
		const axisWidth = leftAxis ? paneLeft : layer.width - axisLeft;
		const tagHeight = Math.round((options.layout.fontSize + 8) * ratio);
		const textX = leftAxis ? axisWidth - AXIS_PADDING * ratio : axisLeft + AXIS_PADDING * ratio;
		const align: CanvasTextAlign = leftAxis ? 'right' : 'left';
		const font = this._font;

		for (const series of this._series) {
			const seriesOptions = series.seriesOptions;
			const value = series.lastValue;
			if (value !== value || !seriesOptions.visible) {
				continue;
			}
			const showLine = seriesOptions.priceLineVisible;
			const showLabel = seriesOptions.lastValueVisible && axisVisible;
			if (!showLine && !showLabel) {
				continue;
			}
			const y = Math.round(priceScale.priceToY(value) * ratio);
			if (y < 0 || y >= paneHeight) {
				continue;
			}
			const color = seriesColor(ctx, series);
			if (showLine) {
				drawRow(
					ctx,
					y,
					paneLeft,
					paneWidth,
					seriesOptions.priceLineColor !== '' ? seriesOptions.priceLineColor : color,
					thickness(seriesOptions.priceLineWidth, ratio),
					seriesOptions.priceLineStyle,
				);
			}
			if (showLabel) {
				const top = y - (tagHeight >> 1);
				const text = priceScale.format(value);
				drawTag(ctx, axisLeft, top, axisWidth, tagHeight, color, textColorOn(ctx, color), text, textX, align, font);
			}
		}

		const crosshair = options.crosshair;
		const scale = this.scale;
		if (!this._crosshairVisible || scale.isEmpty || crosshair.mode === 'hidden') {
			return;
		}
		const geometry = this._geometry;
		const index = Math.min(scale.end - 1, Math.max(scale.first, Math.round(scale.xToLogical(this._crosshairX))));
		const x = paneLeft + Math.round(geometry.origin + index * geometry.spacing);
		const drawn = this._drawn;
		const row = drawn === null ? -1 : Math.floor(index / 2 ** drawn.shift) - drawn.start;
		const inCache = drawn !== null && row >= 0 && row < drawn.count;
		let y = Math.round(this._crosshairY * ratio);
		let price = priceScale.yToPrice(this._crosshairY);
		if (crosshair.mode === 'magnet' && inCache) {
			const close = this._magnetValue(row);
			if (close === close) {
				price = close;
				y = Math.round(priceScale.priceToY(close) * ratio);
			}
		}
		const { vertLine, horzLine } = crosshair;
		if (vertLine.visible) {
			drawColumn(ctx, x, paneHeight, vertLine.color, thickness(vertLine.width, ratio), vertLine.style);
		}
		const yInPane = y >= 0 && y < paneHeight;
		if (horzLine.visible && yInPane) {
			drawRow(ctx, y, paneLeft, paneWidth, horzLine.color, thickness(horzLine.width, ratio), horzLine.style);
		}
		if (inCache) {
			this._renderMarkers(ctx, x, row);
		}
		if (horzLine.labelVisible && axisVisible && yInPane) {
			const background = horzLine.labelBackgroundColor;
			const text = priceScale.format(price);
			const top = y - (tagHeight >> 1);
			drawTag(
				ctx,
				axisLeft,
				top,
				axisWidth,
				tagHeight,
				background,
				textColorOn(ctx, background),
				text,
				textX,
				align,
				font,
			);
		}
		if (vertLine.labelVisible && options.timeScale.visible && inCache) {
			const label = formatDateTime(drawn!.time[row]!);
			const width = Math.ceil((label.length * this._digitWidth + 2 * AXIS_PADDING) * ratio);
			const left = Math.min(Math.max(paneLeft, x - (width >> 1)), Math.max(paneLeft, paneLeft + paneWidth - width));
			const background = vertLine.labelBackgroundColor;
			drawTag(
				ctx,
				left,
				paneHeight,
				width,
				layer.height - paneHeight,
				background,
				textColorOn(ctx, background),
				label,
				left + width / 2,
				'center',
				font,
			);
		}
	}

	/** Value of the first visible series at a cache row, for the magnet crosshair. */
	private _magnetValue(row: number): number {
		for (const series of this._series) {
			if (series.seriesOptions.visible && row < series.close.length) {
				const value = series.close[row]!;
				if (value === value) {
					return value;
				}
			}
		}
		return NaN;
	}

	/** Dots where the crosshair crosses line series, ringed in the background color. */
	private _renderMarkers(ctx: CanvasRenderingContext2D, x: number, row: number): void {
		const ratio = this._pixelRatio;
		const priceScale = this._priceScale;
		for (const series of this._series) {
			if (series.kind !== 'line' || row >= series.close.length) {
				continue;
			}
			const line = series.seriesOptions as LineOptions;
			const value = series.close[row]!;
			if (!line.visible || !line.crosshairMarkerVisible || value !== value) {
				continue;
			}
			const y = priceScale.priceToY(value) * ratio;
			const radius = line.crosshairMarkerRadius * ratio;
			ctx.fillStyle = this._options.layout.background;
			ctx.beginPath();
			ctx.arc(x, y, radius + ratio, 0, 2 * Math.PI);
			ctx.fill();
			ctx.fillStyle = line.color;
			ctx.beginPath();
			ctx.arc(x, y, radius, 0, 2 * Math.PI);
			ctx.fill();
		}
	}
}

/** Device-pixel thickness of a line `width` CSS pixels wide. */
function thickness(width: number, pixelRatio: number): number {
	return Math.max(1, Math.floor(width * pixelRatio));
}

/**
 * Color of the latest value: the line color, or the body color of the last bar's direction. A
 * hollow body (a faint color with an outline) gives way to its outline color.
 */
function seriesColor(ctx: CanvasRenderingContext2D, series: Series): string {
	if (series.kind !== 'ohlcv') {
		return (series.seriesOptions as LineOptions).color;
	}
	const candle = series.seriesOptions as CandlestickOptions;
	const body = series.lastUp ? candle.upColor : candle.downColor;
	if (candle.borderVisible && isFaint(ctx, body)) {
		return series.lastUp ? candle.borderUpColor : candle.borderDownColor;
	}
	return body;
}

/** Creates a chart inside `container`. */
export function createChart(container: HTMLElement, options: DeepPartial<ChartOptions> = {}): ChartApi {
	return new Chart(container, options);
}
