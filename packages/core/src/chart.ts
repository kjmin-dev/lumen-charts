import {
	type EngineClient,
	type EngineEvent,
	type FetchRequest,
	type IndicatorInfo,
	columnCount,
	createEngine,
	levelFor,
} from '@lumen-charts/engine';
import { type LevelWindow, WindowCache } from './data/window-cache';
import { ChartIndicators, type IndicatorApi, type IndicatorOptions, type IndicatorOutputApi } from './indicators';
import { type AxisTarget, Interaction, type InteractionHost } from './input/interaction';
import { INVALIDATE_FULL, INVALIDATE_LIGHT, INVALIDATE_NONE, type Invalidation } from './model/invalidation';
import type { SessionInfo } from './model/sessions';
import { TimeDisplay } from './model/time-display';
import { TimeScale } from './model/time-scale';
import { TimeTicks } from './model/time-ticks';
import {
	type CandlestickOptions,
	type ChartOptions,
	DEFAULT_PRICE_SCALE_ID,
	type DeepPartial,
	type HistogramOptions,
	type LineOptions,
	type PriceScaleOptions,
	mergeOptions,
	optionsEqual,
	overlayScaleOptions,
	resolveOptions,
} from './options';
import { MIN_AXIS_WIDTH, PriceAxis, type PriceAxisHost, type PriceScaleApi } from './price-axes';
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
import { drawCandles, drawHistogram, drawLine } from './render/series';
import { drawExtendedHours, drawSessionBreaks } from './render/sessions';
import { Series, type SeriesApi, type SeriesCreateOptions, type SeriesType } from './series';
import { type FrameClient, cancelFrame, requestFrame } from './shared/frame';
import { type ColorSchemeWatch, watchColorScheme, watchPixelRatio } from './shared/media';
import { observeSize, observeVisibility, unobserveSize, unobserveVisibility } from './shared/observers';
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
	/**
	 * Whether `time` (UTC milliseconds) falls in a session of the schedule (`sessions.schedule`),
	 * extended hours included. Always true without a schedule.
	 */
	isInSession(time: number): boolean;
	/**
	 * The session `time` (UTC milliseconds) falls in, with its kind and trading day, or null outside
	 * every session and without a schedule.
	 */
	sessionAt(time: number): SessionInfo | null;
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
	/**
	 * Removes a series, and every indicator that reads it.
	 */
	removeSeries(series: SeriesApi): void;
	/**
	 * Adds an indicator computed from `source` (a series, or an indicator output to chain from) in
	 * the data engine, with the worker when there is one. Its outputs are series on the main timeline,
	 * drawn on the price pane and included in autoscale; ticks of the source update them in the same
	 * message as the bars. `name` is a built-in (`sma`, `ema`, `wma`, `rsi`, `macd`, `bollinger`,
	 * `atr`, `stochastic`, `vwap`, `highest`, `lowest`) or an indicator registered with
	 * `registerIndicators`. Values appear once computed in the background. Throws for an unknown name
	 * and a `RangeError` for a parameter out of bounds.
	 */
	addIndicator(
		source: SeriesApi | IndicatorOutputApi,
		name: string,
		options?: DeepPartial<IndicatorOptions>,
	): IndicatorApi;
	/** Removes an indicator, and every indicator that reads its outputs. */
	removeIndicator(indicator: IndicatorApi): void;
	/**
	 * Loads a module of custom indicators into the data engine (in the worker, or on this thread
	 * without one) and resolves with what it registered. The module exports indicator definitions:
	 * a default export or an `indicators` export holding one or an array (see `defineIndicator`). It
	 * is imported by URL, so it must be a standalone ES module the page's content security policy
	 * allows (`script-src`), resolved against the document's base URL.
	 */
	registerIndicators(url: string | URL): Promise<readonly IndicatorInfo[]>;
	timeScale(): TimeScaleApi;
	/**
	 * The price scale with this id: by default the default scale (`default`), which
	 * `ChartOptions.priceScale` configures. An id no option or series has named yet gets an overlay
	 * scale.
	 */
	priceScale(id?: string): PriceScaleApi;
	/**
	 * Resolves once all data handed over so far has been applied and painted. A chart outside the
	 * viewport is not painted until it comes back into view, and does not wait for that.
	 */
	whenIdle(): Promise<void>;
	/**
	 * Resolves once all data handed over so far has been applied on the main thread, indicator
	 * values computed from it included, without waiting for the frame that draws it.
	 */
	whenApplied(): Promise<void>;
	/** Where the data engine runs; `connecting` until a worker has answered or failed. */
	engineMode(): 'none' | 'connecting' | 'worker' | 'local';
	/** Removes the chart from the DOM and releases its resources. */
	destroy(): void;
}

const AXIS_PADDING = 8;
/** The price axis grows as soon as a label needs it but shrinks only past this slack, to avoid jitter. */
const AXIS_SHRINK_SLACK = 12;

interface Deferred {
	seq: number;
	action: () => void;
}

/** The used value of a length, in CSS pixels, or NaN for anything else (`auto`, a percentage). */
function pixels(value: string): number {
	return value.endsWith('px') ? Number.parseFloat(value) : Number.NaN;
}

/** A datafeed request: in flight, or waiting out the pause after a failure (`timer`). */
interface Fetch {
	series: Series;
	controller: AbortController;
	timer: ReturnType<typeof setTimeout> | null;
}

/** Pause before asking a datafeed again after the first failure, and the longest one, in milliseconds. */
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;

class Chart implements ChartApi, InteractionHost, TimeScaleApi, FrameClient, PriceAxisHost {
	public readonly scale: TimeScale;
	/** Whether the chart waits for the shared animation frame (see `FrameClient`). */
	public frameQueued = false;
	private readonly _container: HTMLElement;
	private readonly _root: HTMLDivElement;
	private readonly _pane: Layer;
	private readonly _timeAxis: Layer;
	private readonly _overlay: Layer;
	private readonly _interaction: Interaction;
	/**
	 * Price scales with their axes, in layout order: the default scale, those `priceScales` lists in
	 * its order, then overlays only series named. Axes on one side go outward from the pane in it.
	 */
	private _axes: PriceAxis[] = [];
	private readonly _axesById = new Map<string, PriceAxis>();
	/** The scale whose ticks the horizontal grid lines follow, from the last model update. */
	private _gridAxis: PriceAxis;
	private readonly _timeTicks = new TimeTicks();
	/** Time zone, sessions and label formats. */
	private readonly _time = new TimeDisplay();
	private readonly _cache = new WindowCache();
	private readonly _series: Series[] = [];
	private readonly _geometry: Geometry = { origin: 0, spacing: 1, from: 0, to: 0, shift: 0, firstRow: 0 };
	/** Window the series were drawn from in the last model update. */
	private _drawn: LevelWindow | null = null;
	private readonly _widths = { body: 1, wick: 1 };

	/** Everything applied so far, merged; the theme is laid under it whenever it changes. */
	private _input: DeepPartial<ChartOptions>;
	private _options: ChartOptions;
	/** The system color scheme, watched while the theme is `auto`. */
	private _scheme: ColorSchemeWatch | null = null;
	private _engine: EngineClient | null = null;
	private _width = 0;
	private _height = 0;
	private _paneLeft = 0;
	private _paneWidth = 0;
	private _paneHeight = 0;
	private _axisHeight = 0;
	private _pixelRatio = 1;
	private _digitWidth = 0;
	private _font = '';
	private _watermarkFont = '';
	private _watermarkLines: string[] = [];
	private _layersDirty = true;

	private _level: Invalidation = INVALIDATE_NONE;
	/** Whether the shared resize observer reports the size of the root element. */
	private _sizeObserved = false;
	/** With `autoSize`: the size has to be measured before it is used (see `_ensureSize`). */
	private _sizeStale = false;
	/**
	 * Whether any part of the chart is in the viewport. A chart that is not keeps applying data and
	 * remembers its invalidation level, but draws only once it is visible again.
	 */
	private _visible = true;
	private _destroyed = false;
	private _deferred: Deferred[] = [];
	private _idle: (() => void)[] = [];
	/** Limit last sent to the engine. */
	private _memoryLimit = Infinity;
	/** Datafeed requests, by request id. */
	private readonly _fetches = new Map<number, Fetch>();
	/** Of those, the ones in flight (not waiting out a pause). */
	private _fetching = 0;
	/** Bars handed back to the engine, by request id, until it says whether it took them. */
	private readonly _answered = new Map<number, { series: Series; from: number; to: number }>();
	/** Indicators, their definitions and the modules being loaded. */
	private readonly _indicators: ChartIndicators;
	private _applied: (() => void)[] = [];
	/** Scale version the last window request was planned for. */
	private _plannedScale = -1;

	private _crosshairVisible = false;
	private _crosshairX = 0;
	private _crosshairY = 0;

	/** Device-pixel positions of vertical grid lines and time axis labels. */
	private _tickXs = new Float32Array(64);
	/** What the time ticks were last computed for, and a counter that changes when they are recomputed. */
	private _ticksScale = -1;
	private _ticksCache = -1;
	private _ticksFrom = 0;
	private _ticksTo = 0;
	private _ticksGeneration = 0;
	/** What the time axis last showed; -1 forces a redraw. */
	private _timeAxisDrawn = -1;
	private _timeAxisOrigin = 0;
	private readonly _axisStyle: AxisStyle = { background: '', textColor: '', font: '', pixelRatio: 1 };
	private _unwatchPixelRatio: (() => void) | null = null;

	public constructor(container: HTMLElement, options: DeepPartial<ChartOptions>) {
		this._container = container;
		this._input = mergeOptions({}, options);
		// Throws a RangeError for an unknown time zone or locale, or a malformed session schedule.
		this._time.apply(resolveOptions(this._input, false));
		this._watchScheme();
		this._options = this._resolve();
		this.scale = new TimeScale(this._options.timeScale.barSpacing, this._options.timeScale.rightOffset);

		const doc = container.ownerDocument;
		this._root = doc.createElement('div');
		this._root.style.position = 'relative';
		this._root.style.overflow = 'hidden';
		this._pane = new Layer(doc, true);
		const main = new PriceAxis(DEFAULT_PRICE_SCALE_ID, this, this._options.priceScale);
		main.layer = axisLayer(doc);
		this._axes.push(main);
		this._axesById.set(main.id, main);
		this._gridAxis = main;
		this._timeAxis = new Layer(doc, true);
		this._overlay = new Layer(doc, false);
		this._overlay.canvas.style.pointerEvents = 'none';
		this._root.append(this._pane.canvas, main.layer.canvas, this._timeAxis.canvas, this._overlay.canvas);
		container.appendChild(this._root);
		this._interaction = new Interaction(this._root, this);

		this._unwatchPixelRatio = watchPixelRatio(doc.defaultView, this._onPixelRatio);
		observeVisibility(this._root, this._onVisibility);
		this._applyResolved(this._options);
		this._indicators = new ChartIndicators({
			seriesList: this._series,
			engine: () => this._engine,
			ensureEngine: () => this._ensureEngine(),
			invalidate: level => this.invalidate(level),
			reloaded: (series, seq) => this.reloaded(series, seq),
			forget: series => this._cache.removeSeries(series),
			baseUrl: () => container.ownerDocument.baseURI,
			addIndicator: (source, name, settings) => this.addIndicator(source, name, settings),
			removeIndicator: indicator => this.removeIndicator(indicator),
			priceAxisOf: series => this.priceAxisOf(series),
		});
	}

	// ChartApi

	public applyOptions(options: DeepPartial<ChartOptions>): void {
		if (this._destroyed) {
			return;
		}
		const input = mergeOptions(this._input, options);
		if (options.localization !== undefined || options.sessions !== undefined) {
			// Throws before anything changes.
			this._applyTime(resolveOptions(input, false));
		}
		this._input = input;
		this._watchScheme();
		this._update();
	}

	public options(): Readonly<ChartOptions> {
		return this._options;
	}

	public theme(): 'light' | 'dark' {
		const theme = this._options.theme;
		const dark = theme === 'auto' ? this._scheme?.dark === true : theme === 'dark';
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
		const engine = this._ensureEngine();
		const { datafeed, ...style } = options;
		const kind = type === 'candlestick' ? 'ohlcv' : 'line';
		const id = engine?.addSeries(kind, datafeed !== undefined) ?? -1;
		const series = new Series(this, id, type, style as Partial<CandlestickOptions> | Partial<LineOptions>);
		series.datafeed = (datafeed as Series['datafeed'] | undefined) ?? null;
		this._series.push(series);
		return series as unknown as SeriesApi<T>;
	}

	public removeSeries(series: SeriesApi): void {
		const index = this._series.indexOf(series as unknown as Series);
		if (index < 0 || this._series[index]!.derived) {
			return;
		}
		this._indicators.removeReadersOf(this._series[index]!.id);
		// Its indicators' outputs were listed after it, so removing them left it in place.
		const removed = this._series.splice(index, 1)[0]!;
		this._abortFetches(removed);
		this._cache.removeSeries(removed.id);
		this._engine?.removeSeries(removed.id);
		this.invalidate(INVALIDATE_LIGHT);
	}

	public addIndicator(
		source: SeriesApi | IndicatorOutputApi | Series,
		name: string,
		options: DeepPartial<IndicatorOptions> = {},
	): IndicatorApi {
		return this._indicators.add(source, name, options);
	}

	public removeIndicator(indicator: IndicatorApi): void {
		this._indicators.remove(indicator);
	}

	public registerIndicators(url: string | URL): Promise<readonly IndicatorInfo[]> {
		return this._indicators.register(url);
	}

	public timeScale(): TimeScaleApi {
		return this;
	}

	public priceScale(id: string = DEFAULT_PRICE_SCALE_ID): PriceScaleApi {
		return this._axisFor(id);
	}

	public whenIdle(): Promise<void> {
		if (this._isIdle()) {
			return Promise.resolve();
		}
		return new Promise(resolve => {
			this._idle.push(resolve);
		});
	}

	public whenApplied(): Promise<void> {
		if (this._isApplied()) {
			return Promise.resolve();
		}
		return new Promise(resolve => {
			this._applied.push(resolve);
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
		unobserveSize(this._root);
		unobserveVisibility(this._root);
		cancelFrame(this);
		this._interaction.destroy();
		this._unwatchPixelRatio?.();
		this._unwatchPixelRatio = null;
		this._scheme?.release();
		this._scheme = null;
		this._abortFetches(null);
		this._answered.clear();
		this._engine?.destroy();
		this._engine = null;
		this._deferred = [];
		this._indicators.destroy();
		this._settleApplied();
		this._pane.release();
		for (const axis of this._axes) {
			axis.layer?.release();
		}
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
		this._syncView();
		const scale = this.scale;
		return scale.isEmpty || scale.width <= 0 ? null : { from: scale.from, to: scale.to };
	}

	public isInSession(time: number): boolean {
		return this._time.isInSession(time);
	}

	public sessionAt(time: number): SessionInfo | null {
		return this._time.sessionAt(time);
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

	public priceAxisAt(target: EventTarget | null): AxisTarget | null {
		for (const axis of this._axes) {
			if (axis.settings.visible && axis.layer !== null && axis.layer.canvas === target) {
				return axis;
			}
		}
		return null;
	}

	public scrollPrices(dy: number): void {
		let moved = false;
		for (const axis of this._axes) {
			if (!axis.settings.autoScale && axis.count > 0 && axis.scale.hasRange) {
				axis.scale.scrollBy(dy);
				moved = true;
			}
		}
		if (moved) {
			this.invalidate(INVALIDATE_LIGHT);
		}
	}

	// PriceAxisHost and SeriesHost

	public applyPriceScaleOptions(id: string, options: DeepPartial<PriceScaleOptions>): void {
		this.applyOptions(id === DEFAULT_PRICE_SCALE_ID ? { priceScale: options } : { priceScales: { [id]: options } });
	}

	public priceAxisOf(series: Series): PriceAxis {
		return this._axisOf(series);
	}

	public engine(): EngineClient | null {
		return this._engine;
	}

	public reloaded(series: Series, seq: number): void {
		// The engine drops requests for the old history once it gets there; their answers would be ignored.
		this._abortFetches(series);
		series.reloadSeq = seq;
		series.fetchBackoff = 0;
		series.failures.length = 0;
	}

	/** Coalesces any number of changes into one draw per animation frame. */
	public invalidate(level: Invalidation): void {
		if (this._destroyed) {
			return;
		}
		if (level >= INVALIDATE_LIGHT && this._visible && this.scale.version !== this._plannedScale) {
			// The view changed: rows it needs are asked for now rather than in the next frame, so rows
			// that must be fetched again are usually back by the frame that draws the view. A chart
			// outside the viewport asks in the frame that draws it once it is back.
			this._requestWindow(this._container.ownerDocument.defaultView?.devicePixelRatio ?? 1);
		}
		if (level > this._level) {
			this._level = level;
		}
		if (this._visible) {
			requestFrame(this);
		}
	}

	/** Read phase of a frame: everything the draw needs from the layout, before any chart writes. */
	public frameRead(): void {
		this._syncView();
	}

	/**
	 * Brings the pane size and the view up to date with the layout and with pointer input that waits
	 * for it. Called before the view is read or changed outside a frame, so calls apply in order.
	 */
	private _syncView(): void {
		this._ensureSize();
		this._interaction.resolve();
	}

	// Data flow

	/** The data engine, created with the first series (or plugin module). */
	private _ensureEngine(): EngineClient | null {
		if (this._engine === null && !this._destroyed) {
			this._engine = createEngine({ worker: this._options.worker });
			this._engine.onevent = this._onEvent;
			this._memoryLimit = this._options.memoryLimit;
			if (this._memoryLimit !== Infinity) {
				this._engine.setMemoryLimit(this._memoryLimit);
			}
		}
		return this._engine;
	}

	private _isApplied(): boolean {
		const engine = this._engine;
		return (
			this._destroyed ||
			engine === null ||
			(engine.pending === 0 && this._indicators.computing === 0 && this._fetching === 0)
		);
	}

	private _settleApplied(): void {
		if (this._applied.length === 0 || !this._isApplied()) {
			return;
		}
		const waiters = this._applied;
		this._applied = [];
		for (const resolve of waiters) {
			resolve();
		}
	}

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
			this._syncView();
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
		// The window to ask for depends on the pane width.
		this._ensureSize();
		const scale = this.scale;
		const wasEmpty = scale.isEmpty;
		const version = scale.version;
		this._cache.apply(event, this._columnCount);
		const window = event.window;
		if (window !== undefined && window.count > 0) {
			// Offsets of the bars that can come into view are looked up before a frame needs them.
			this._time.cover(window.time[0]!, window.time[window.count - 1]!);
		}
		scale.setExtent(event.first, event.end);
		if (wasEmpty && !scale.isEmpty) {
			scale.reset(this._options.timeScale.barSpacing, this._options.timeScale.rightOffset);
		}
		this._trackLastValues(event);
		this._indicators.computing = event.computing ?? 0;
		if (event.plugins !== undefined) {
			this._indicators.settlePlugins(event.plugins);
		}
		if (
			event.fetch !== undefined ||
			event.cancel !== undefined ||
			event.restored !== undefined ||
			event.window?.incomplete === true
		) {
			this._handleFetches(event);
		}
		// A failed command changes nothing on screen, and redrawing for it would only repeat the request.
		let changed =
			event.failed !== true &&
			(scale.version !== version || event.stale || event.window !== undefined || event.patches !== undefined);
		const deferred = this._deferred;
		while (deferred.length > 0 && deferred[0]!.seq <= event.ack) {
			// Pointer input from before the call comes first.
			this._interaction.resolve();
			deferred.shift()!.action();
			changed = true;
		}
		if (changed) {
			// Requested now rather than in the next draw, the rows usually arrive before that frame,
			// so new data is drawn in one frame instead of an empty frame followed by the data.
			this._requestWindow(this._container.ownerDocument.defaultView?.devicePixelRatio ?? 1);
			this.invalidate(INVALIDATE_LIGHT);
		}
		// Nothing to draw, or a chart outside the viewport, which draws when it comes back.
		this._settle();
		this._settleApplied();
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
			(!this.frameQueued &&
				this._fetching === 0 &&
				this._indicators.computing === 0 &&
				(this._engine === null || this._engine.pending === 0))
		);
	}

	/**
	 * Fetches rows the engine let go and needs again from the series' datafeed, and hands them back.
	 * The engine checks them against the rows it let go; a raw window waits for them meanwhile, and the
	 * chart draws a coarse level where it has nothing else. Requests the engine no longer needs are
	 * aborted through the signal `getBars` got.
	 */
	private _handleFetches(event: EngineEvent): void {
		const restored = event.restored;
		if (restored !== undefined) {
			const answered = this._answered.get(restored.request);
			this._answered.delete(restored.request);
			if (restored.outcome === 'restored' && answered !== undefined) {
				answered.series.fetchBackoff = 0;
			} else if (restored.outcome === 'mismatch' && answered !== undefined) {
				console.warn(
					`lumen-charts: the datafeed returned ${restored.received} bars where ${restored.expected} were expected; ` +
						'they do not match the bars they replace and were ignored.',
				);
				failed(answered.series, answered.from, answered.to);
			}
		}
		const window = event.window;
		if (window?.incomplete === true) {
			// The rows could not be fetched: draw what the levels show and ask again after a pause.
			let backoff = RETRY_MIN_MS;
			for (const series of this._series) {
				backoff = Math.max(backoff, series.fetchBackoff);
			}
			this._cache.level(window.level).holdOff(performance.now() + backoff);
		}
		for (const id of event.cancel ?? []) {
			this._abortFetch(id);
		}
		const engine = this._engine;
		for (const request of event.fetch ?? []) {
			const series = this._seriesById(request.series);
			if (engine === null || this._fetches.has(request.id) || series === undefined) {
				// A removed series: the engine forgot its requests when it removed it.
				continue;
			}
			if (event.ack < series.reloadSeq) {
				// Asked for before the series got a new history: the engine drops it once it gets there.
				continue;
			}
			if (series.datafeed === null) {
				engine.restoreRows(request.id, null, 0);
				continue;
			}
			this._fetch(series, request);
		}
	}

	/** Calls the series' datafeed for a request, after the pause that follows a failure if one is running. */
	private _fetch(series: Series, request: FetchRequest): void {
		const datafeed = series.datafeed!;
		const { id, from, to, start, end } = request;
		const controller = new AbortController();
		const entry: Fetch = { series, controller, timer: null };
		this._fetches.set(id, entry);
		const done = (data: Float64Array | null, count: number): void => {
			if (controller.signal.aborted) {
				return;
			}
			this._fetches.delete(id);
			this._fetching--;
			const engine = this._engine;
			if (data === null) {
				failed(series, from, to);
			} else if (engine !== null) {
				this._answered.set(id, { series, from, to });
			}
			// After destroy the engine is gone, and nothing waits for the rows.
			engine?.restoreRows(id, data, count);
			this._settle();
			this._settleApplied();
		};
		const call = (): void => {
			entry.timer = null;
			this._fetching++;
			let pending: Promise<unknown>;
			try {
				pending = datafeed.getBars({ from, to, countBack: end - start, signal: controller.signal });
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
		};
		// Bars whose request failed a moment ago are asked for again only after the pause.
		const now = performance.now();
		let wait = 0;
		const failures = series.failures;
		for (let i = failures.length - 1; i >= 0; i--) {
			const failure = failures[i]!;
			if (failure.until <= now) {
				failures.splice(i, 1);
			} else if (failure.from <= to && failure.to >= from) {
				wait = Math.max(wait, failure.until - now);
			}
		}
		if (wait > 0) {
			entry.timer = setTimeout(call, wait);
		} else {
			call();
		}
	}

	/** Aborts a datafeed request; its answer, if one still comes, is ignored. */
	private _abortFetch(id: number): void {
		const entry = this._fetches.get(id);
		if (entry === undefined) {
			return;
		}
		this._fetches.delete(id);
		if (entry.timer === null) {
			this._fetching--;
		} else {
			clearTimeout(entry.timer);
		}
		entry.controller.abort();
		this._settle();
		this._settleApplied();
	}

	/** Aborts the datafeed requests of a series, or of every series. */
	private _abortFetches(series: Series | null): void {
		for (const [id, entry] of this._fetches) {
			if (series === null || entry.series === series) {
				this._abortFetch(id);
			}
		}
	}

	private _seriesById(id: number): Series | undefined {
		for (const series of this._series) {
			if (series.id === id) {
				return series;
			}
		}
		return undefined;
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
		return resolveOptions(this._input, this._scheme?.dark === true);
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
		this._syncAxes(options);
		const watermark = options.watermark;
		this._watermarkLines = watermark.visible && watermark.text !== '' ? watermark.text.split('\n') : [];
		this._timeAxis.setVisible(options.timeScale.visible);
		this._root.style.cursor = options.crosshair.mode === 'hidden' ? 'default' : 'crosshair';
		this._font = '';
		this._ticksScale = -1;
		for (const axis of this._axes) {
			axis.fitTicks = -1;
		}
		this._applyTime(options);
		this._syncSizing();
		this._computeLayout();
	}

	/**
	 * Takes over the time zone, locale and session options. When they change, the offsets of the
	 * bars on screen are looked up now rather than in the frame that draws them. Throws a RangeError
	 * for an unknown time zone or locale, or a malformed schedule, and then changes nothing.
	 */
	private _applyTime(options: ChartOptions): void {
		const drawn = this._drawn;
		if (this._time.apply(options) && drawn !== null && drawn.count > 0) {
			this._time.cover(drawn.time[0]!, drawn.time[drawn.count - 1]!);
		}
	}

	/**
	 * Gives every price scale its options and puts the scales in layout order: the default one, those
	 * `priceScales` lists, then the overlays only series named. Makes the canvases of axes shown for
	 * the first time and hides those of hidden ones.
	 */
	private _syncAxes(options: ChartOptions): void {
		const main = this._axesById.get(DEFAULT_PRICE_SCALE_ID)!;
		main.setSettings(options.priceScale);
		const ordered = [main];
		for (const id of Object.keys(options.priceScales)) {
			const axis = this._axisFor(id);
			axis.setSettings(options.priceScales[id]!);
			ordered.push(axis);
		}
		const overlay = overlayScaleOptions(this.theme());
		for (const axis of this._axes) {
			if (!ordered.includes(axis)) {
				axis.setSettings(overlay);
				ordered.push(axis);
			}
		}
		this._axes = ordered;
		for (const axis of ordered) {
			this._syncAxisLayer(axis);
		}
	}

	/** The price scale with this id, made as an overlay if there is none. */
	private _axisFor(id: string): PriceAxis {
		let axis = this._axesById.get(id);
		if (axis === undefined) {
			axis = new PriceAxis(id, this, this._options.priceScales[id] ?? overlayScaleOptions(this.theme()));
			axis.scale.setHeight(this._paneHeight);
			this._axesById.set(id, axis);
			this._axes.push(axis);
			this._syncAxisLayer(axis);
		}
		return axis;
	}

	/** The price scale a series is on, following its `priceScaleId`. */
	private _axisOf(series: Series): PriceAxis {
		// Options are replaced as a whole on every change: while they are the same, so is the scale.
		const options = series.seriesOptions;
		let axis = series.axis;
		if (axis === null || series.axisOptions !== options) {
			axis = this._axisFor(options.priceScaleId || DEFAULT_PRICE_SCALE_ID);
			series.axis = axis;
			series.axisOptions = options;
		}
		return axis;
	}

	/** Makes the canvas of an axis shown for the first time, below the overlay, and shows or hides it. */
	private _syncAxisLayer(axis: PriceAxis): void {
		if (axis.layer === null && axis.settings.visible && !this._destroyed) {
			axis.layer = axisLayer(this._root.ownerDocument);
			this._root.insertBefore(axis.layer.canvas, this._overlay.canvas);
			this._layersDirty = true;
		}
		axis.layer?.setVisible(axis.settings.visible);
	}

	/** Listens to the system color scheme while the theme is `auto`. */
	private _watchScheme(): void {
		const auto = this._input.theme === 'auto';
		if (auto === (this._scheme !== null)) {
			return;
		}
		if (!auto) {
			this._scheme!.release();
			this._scheme = null;
			return;
		}
		this._scheme = watchColorScheme(this._container.ownerDocument.defaultView, this._onScheme);
	}

	private readonly _onScheme = (): void => {
		if (!this._destroyed) {
			this._update();
		}
	};

	// Sizing and layout

	private _syncSizing(): void {
		const root = this._root;
		if (this._options.autoSize) {
			root.style.width = '100%';
			root.style.height = '100%';
			if (!this._sizeObserved) {
				// The observer reports after a layout, which is after the next frame's draw. That draw
				// measures instead, in its read phase, so the first paint already has the right size.
				// Without an observer nothing reports later changes, so every options change measures.
				this._sizeObserved = observeSize(root, this._onSize);
				this._sizeStale = true;
				this.invalidate(INVALIDATE_FULL);
			}
		} else {
			if (this._sizeObserved) {
				unobserveSize(root);
				this._sizeObserved = false;
			}
			this._sizeStale = false;
			root.style.width = `${this._options.width}px`;
			root.style.height = `${this._options.height}px`;
			this._setSize(this._options.width, this._options.height);
		}
	}

	/** Size of the root element's content box, from the shared resize observer. */
	private readonly _onSize = (width: number, height: number): void => {
		if (this._destroyed || !this._options.autoSize) {
			return;
		}
		this._sizeStale = false;
		this._setSize(Math.floor(width), Math.floor(height));
	};

	/**
	 * Measures the chart if its size is not known yet. This reads the layout, and so can force one:
	 * it happens in the read phase of a frame, where every chart reads before any chart writes, or
	 * earlier when a call or arriving data needs the size, but not when the chart is created: charts
	 * created in a loop would each lay the page out again.
	 *
	 * The size is that of the root element, which fills the content box of the container. The
	 * container's bounding rectangle would include its padding and borders and follow its CSS
	 * transforms, and the canvases would no longer fit the root.
	 */
	private _ensureSize(): void {
		if (!this._sizeStale) {
			return;
		}
		this._sizeStale = false;
		const root = this._root;
		// The used width and height keep their fractions, like the sizes the observer reports;
		// `clientWidth` is rounded, and the two would disagree by a pixel.
		const style = this._container.ownerDocument.defaultView?.getComputedStyle(root);
		const width = style === undefined ? Number.NaN : pixels(style.width);
		const height = style === undefined ? Number.NaN : pixels(style.height);
		this._setSize(
			Math.floor(width === width ? width : root.clientWidth),
			Math.floor(height === height ? height : root.clientHeight),
		);
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

	/**
	 * Splits the chart into pane and axes, the price axes of each side laid out from the pane outward.
	 * Only numbers change here; canvases follow in the next draw.
	 */
	private _computeLayout(): void {
		const { timeScale, layout } = this._options;
		const axes = this._axes;
		let left = 0;
		let right = 0;
		for (const axis of axes) {
			if (axis.settings.visible) {
				if (axis.settings.position === 'left') {
					left += axis.axisWidth;
				} else {
					right += axis.axisWidth;
				}
			}
		}
		this._axisHeight = timeScale.visible ? Math.round(layout.fontSize + 16) : 0;
		this._paneLeft = left;
		this._paneWidth = Math.max(0, this._width - left - right);
		this._paneHeight = Math.max(0, this._height - this._axisHeight);
		let leftEdge = left;
		let rightEdge = left + this._paneWidth;
		for (const axis of axes) {
			if (axis.settings.visible) {
				if (axis.settings.position === 'left') {
					leftEdge -= axis.axisWidth;
					axis.axisLeft = leftEdge;
				} else {
					axis.axisLeft = rightEdge;
					rightEdge += axis.axisWidth;
				}
			}
			axis.scale.setHeight(this._paneHeight);
		}
		this.scale.setWidth(this._paneWidth);
		this._layersDirty = true;
	}

	/** Redraws at the new resolution when the window moves to another screen or the page is zoomed. */
	private readonly _onPixelRatio = (): void => {
		this.invalidate(INVALIDATE_FULL);
	};

	private readonly _onVisibility = (visible: boolean): void => {
		if (this._destroyed || visible === this._visible) {
			return;
		}
		this._visible = visible;
		if (!visible) {
			// Whoever waits for the chart to be idle does not wait for it to come back into view.
			cancelFrame(this);
			this._settle();
		} else if (this._level !== INVALIDATE_NONE) {
			requestFrame(this);
		}
	};

	private _placeLayers(): void {
		this._layersDirty = false;
		const ratio = this._container.ownerDocument.defaultView?.devicePixelRatio ?? 1;
		this._pixelRatio = ratio;
		const { _paneLeft: paneLeft, _paneWidth: paneWidth, _paneHeight: paneHeight } = this;
		const options = this._options;
		this._pane.place(paneLeft, 0, paneWidth, paneHeight, ratio);
		for (const axis of this._axes) {
			if (axis.settings.visible) {
				axis.layer?.place(axis.axisLeft, 0, axis.axisWidth, paneHeight, ratio);
			}
			// Resizing a canvas clears it, so the axes are drawn again whatever their state.
			axis.drawn = -1;
		}
		if (options.timeScale.visible) {
			this._timeAxis.place(0, paneHeight, this._width, this._axisHeight, ratio);
		}
		this._overlay.place(0, 0, this._width, this._height, ratio);
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

	/** Write phase of a frame: sizes the canvases and draws whatever the invalidation level asks for. */
	public frameWrite(now: number): void {
		const level = this._level;
		this._level = INVALIDATE_NONE;
		const animating = this._interaction.step(now);
		if (level === INVALIDATE_FULL || this._font === '') {
			this._placeLayers();
		}
		if (level >= INVALIDATE_LIGHT) {
			this._updateModel();
			if (this._fitPriceAxes()) {
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
	}

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
		this._plannedScale = scale.version;
		if (engine !== null && !scale.isEmpty) {
			const level = this._levelFor(scale.barSpacing * ratio);
			const cache = this._cache;
			const request = cache.plan(level, scale.from, scale.to, scale.first, scale.end);
			if (request !== null) {
				cache.level(level).sent(engine.requestWindow(request.start, request.count, request.capacity, request.level));
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
					cache.level(1).sent(engine.requestWindow(fallback.start, fallback.count, fallback.capacity, fallback.level));
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

		const axes = this._axes;
		for (let i = 0; i < axes.length; i++) {
			axes[i]!.beginFrame();
		}
		const size = 2 ** geometry.shift;
		for (const series of this._series) {
			const visible = series.seriesOptions.visible;
			const axis = visible ? this._axisOf(series) : null;
			if (axis !== null) {
				axis.count++;
				if (axis.first === null) {
					axis.first = series;
				}
			}
			series.scaled = visible;
			series.base = Number.NaN;
			if (source === null) {
				series.bind(undefined, 0, -1, 0);
				series.view.reset();
				continue;
			}
			series.bind(source.blocks.get(series.id), source.capacity, source.version, source.level);
			const view = series.view;
			// A hidden series keeps no items, so it is rebuilt in full once it is shown again.
			if (series.open.length === 0 || axis === null) {
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
			this._includeSeries(axis, series, geometry.from - source.start, geometry.to - source.start);
			const lastRow = Math.floor((scale.end - 1) / size) - source.start;
			if (lastRow >= 0 && lastRow < source.count) {
				const close = series.close[lastRow]!;
				if (close === close) {
					series.lastValue = close;
					series.lastUp = close >= series.open[lastRow]!;
				}
			}
		}

		for (let i = 0; i < axes.length; i++) {
			axes[i]!.fit();
		}
		for (const series of this._series) {
			const axis = series.axis;
			if (axis === null || !series.scaled) {
				continue;
			}
			series.setProjection(axis.scale, ratio);
			if (series.view.count > 0) {
				series.view.project(series.deviceOffset, series.deviceScale, series.type !== 'line', series.deviceLog);
			}
		}

		// Ticks of the visible axes, and of the scale the grid follows: the default one, unless it has
		// no series and a visible axis has.
		let grid = axes[0]!;
		if (grid.count === 0) {
			for (const axis of axes) {
				if (axis.settings.visible && axis.count > 0) {
					grid = axis;
					break;
				}
			}
		}
		this._gridAxis = grid;
		const fontSize = this._options.layout.fontSize;
		const tickSpacing = Math.max(32, fontSize * 3.5);
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
				this._time.marks.breakCount = 0;
				this._time.marks.shadeCount = 0;
			} else {
				// At a coarse level the labels sit on buckets, which hold `size` bars each.
				const time = this._time;
				const from = geometry.from - source.start;
				const to = geometry.to - source.start;
				timeTicks.update(
					source.time,
					from,
					to,
					Math.max(1, (fontSize * 7) / (scale.barSpacing * size)),
					time.zone,
					time.sessions,
					time.format,
					size,
				);
				const sessions = this._options.sessions;
				// Breaks and shading are placed while a day is at least 6 CSS pixels wide, and not on
				// daily bars.
				time.marks.update(
					source.time,
					from,
					timeTicks.dates ? from : to,
					time.zone,
					time.sessions,
					scale.width / 6,
					sessions.breaks.visible,
					sessions.extendedHours.visible,
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
		this._time.marks.place(geometry.origin, geometry.spacing, tickStart, size);
	}

	/**
	 * Takes the values of a series in view into the range of its scale. On a percentage or indexed
	 * scale the series' base is its first value in view, from element `from` of its columns on.
	 */
	private _includeSeries(axis: PriceAxis, series: Series, from: number, to: number): void {
		const view = series.view;
		let low = view.min;
		let high = view.max;
		if (!(low <= high)) {
			return;
		}
		const scale = axis.scale;
		const mode = scale.mode;
		if (series.type === 'histogram') {
			// Bars grow from their base, which is always in view where the scale can show it.
			const base = (series.seriesOptions as HistogramOptions).base;
			if (mode !== 'logarithmic' || base > 0) {
				low = Math.min(low, base);
				high = Math.max(high, base);
			}
		}
		if (mode === 'normal') {
			axis.include(low, high);
		} else if (mode === 'logarithmic') {
			if (high > 0) {
				axis.include(Math.log10(low > 0 ? low : view.lowestPositive()), Math.log10(high));
			}
		} else {
			const base = firstValue(series.close, from, to);
			series.base = base;
			if (base !== 0 && base === base) {
				if (scale.base !== scale.base) {
					scale.base = base;
				}
				axis.include(scale.toValue(low, base), scale.toValue(high, base));
			}
		}
	}

	/** Adjusts the widths of the price axes to their longest labels. Returns true if the layout changed. */
	private _fitPriceAxes(): boolean {
		let changed = false;
		for (const axis of this._axes) {
			const priceScale = axis.scale;
			// Labels change only with the ticks, so most frames have nothing to measure.
			if (
				!axis.settings.visible ||
				(priceScale.ticksGeneration === axis.fitTicks && this._digitWidth === axis.fitDigit)
			) {
				continue;
			}
			axis.fitTicks = priceScale.ticksGeneration;
			axis.fitDigit = this._digitWidth;
			if (axis.count === 0 || !priceScale.hasRange || this.scale.isEmpty) {
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
			const needed = Math.max(MIN_AXIS_WIDTH, Math.ceil((characters * this._digitWidth + 2 * AXIS_PADDING) / 4) * 4);
			if (needed <= axis.axisWidth && needed + AXIS_SHRINK_SLACK >= axis.axisWidth) {
				continue;
			}
			axis.axisWidth = needed;
			changed = true;
		}
		return changed;
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
		const grid = this._gridAxis;
		const marks = this._time.marks;
		const sessions = options.sessions;
		if (marks.shadeCount > 0) {
			drawExtendedHours(
				ctx,
				marks.shadeLeft,
				marks.shadeRight,
				marks.shadeCount,
				layer.height,
				sessions.extendedHours.color,
			);
		}
		drawGrid(
			ctx,
			layer.width,
			layer.height,
			this._tickXs,
			this._timeTicks.count,
			grid.tickYs,
			grid.scale.tickCount,
			options.grid.vertLines,
			options.grid.horzLines,
			ratio,
		);
		if (marks.breakCount > 0) {
			const breaks = sessions.breaks;
			drawSessionBreaks(
				ctx,
				marks.breakX,
				marks.breakCount,
				layer.height,
				breaks.color,
				thickness(breaks.width, ratio),
				breaks.style,
			);
		}
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
			const inverted = series.deviceScale < 0;
			if (series.kind === 'ohlcv') {
				drawCandles(ctx, view, widths.body, widths.wick, border, series.seriesOptions as CandlestickOptions, inverted);
			} else if (series.type === 'histogram') {
				const histogram = series.seriesOptions as HistogramOptions;
				let base = Math.round(series.deviceY(histogram.base));
				if (!Number.isFinite(base)) {
					// A base a logarithmic scale cannot show: the bars grow from the edge of the pane.
					base = inverted ? 0 : layer.height;
				}
				drawHistogram(
					ctx,
					view,
					base,
					widths.body,
					histogram.color,
					histogram.negativeColor || histogram.color,
					inverted,
				);
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
		const ratio = this._pixelRatio;
		const options = this._options;
		const style = this._axisStyle;
		style.background = options.layout.background;
		style.textColor = options.layout.textColor;
		style.font = this._font;
		style.pixelRatio = ratio;
		for (const axis of this._axes) {
			const priceScale = axis.scale;
			const layer = axis.layer;
			if (!axis.settings.visible || layer === null || axis.drawn === priceScale.ticksGeneration) {
				continue;
			}
			const priceOptions = axis.settings;
			if (layer.ctx !== null) {
				drawPriceAxis(
					layer.ctx,
					layer.width,
					layer.height,
					style,
					priceOptions.borderVisible ? priceOptions.borderColor : '',
					priceOptions.position,
					AXIS_PADDING * ratio,
					axis.tickYs,
					priceScale.tickLabels,
					priceScale.tickCount,
				);
			}
			axis.drawn = priceScale.ticksGeneration;
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
		const paneLeft = Math.round(this._paneLeft * ratio);
		const paneWidth = this._pane.width;
		const paneHeight = this._pane.height;
		const tagHeight = Math.round((options.layout.fontSize + 8) * ratio);
		const font = this._font;
		// Value labels of overlays go on the default scale's axis, or on the first visible one.
		let overlayAxis: PriceAxis | null = null;
		for (const axis of this._axes) {
			if (axis.settings.visible) {
				overlayAxis = axis;
				break;
			}
		}

		for (const series of this._series) {
			const seriesOptions = series.seriesOptions;
			const value = series.lastValue;
			const axis = series.axis;
			if (value !== value || !seriesOptions.visible || axis === null) {
				continue;
			}
			const labelAxis = axis.settings.visible ? axis : overlayAxis;
			const showLine = seriesOptions.priceLineVisible;
			const showLabel = seriesOptions.lastValueVisible && labelAxis !== null;
			if (!showLine && !showLabel) {
				continue;
			}
			const y = Math.round(series.deviceY(value));
			// NaN (a value the scale cannot show) fails too.
			if (!(y >= 0 && y < paneHeight)) {
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
				this._axisTag(ctx, labelAxis!, y - (tagHeight >> 1), tagHeight, color, series.valueLabel(axis.scale, value));
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
		let cssY = this._crosshairY;
		let magnet: Series | null = null;
		if (crosshair.mode === 'magnet' && inCache) {
			magnet = this._magnetSeries(row);
			const snapped = magnet === null ? Number.NaN : magnet.deviceY(magnet.close[row]!);
			if (Number.isFinite(snapped)) {
				cssY = snapped / ratio;
			} else {
				magnet = null;
			}
		}
		const y = Math.round(cssY * ratio);
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
		if (horzLine.labelVisible && yInPane) {
			// A label on every axis with something on it, each in its own values.
			const background = horzLine.labelBackgroundColor;
			const top = y - (tagHeight >> 1);
			for (const axis of this._axes) {
				const priceScale = axis.scale;
				if (!axis.settings.visible || axis.count === 0 || !priceScale.hasRange) {
					continue;
				}
				const text =
					magnet !== null && magnet.axis === axis
						? priceScale.format(
								magnet.close[row]!,
								magnet.base,
								magnet.seriesOptions.minMove,
								magnet.seriesOptions.precision,
							)
						: priceScale.formatValue(priceScale.yToValue(cssY));
				this._axisTag(ctx, axis, top, tagHeight, background, text);
			}
		}
		if (vertLine.labelVisible && options.timeScale.visible && inCache) {
			const time = drawn!.time[row]!;
			// Daily bars are dates, shown as they are (see `TimeTicks.dates`).
			const label = this._time.format.crosshair(time, this._timeTicks.dates ? time : this._time.zone.wall(time));
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

	/** A label on a price axis, `top` and `height` in device pixels. */
	private _axisTag(
		ctx: CanvasRenderingContext2D,
		axis: PriceAxis,
		top: number,
		height: number,
		background: string,
		text: string,
	): void {
		const ratio = this._pixelRatio;
		const left = Math.round(axis.axisLeft * ratio);
		const width = Math.round((axis.axisLeft + axis.axisWidth) * ratio) - left;
		const onLeft = axis.settings.position === 'left';
		const padding = AXIS_PADDING * ratio;
		drawTag(
			ctx,
			left,
			top,
			width,
			height,
			background,
			textColorOn(ctx, background),
			text,
			onLeft ? left + width - padding : left + padding,
			onLeft ? 'right' : 'left',
			this._font,
		);
	}

	/** The first visible series with a value at a cache row, for the magnet crosshair. */
	private _magnetSeries(row: number): Series | null {
		for (const series of this._series) {
			if (series.seriesOptions.visible && series.axis !== null && row < series.close.length) {
				const value = series.close[row]!;
				if (value === value) {
					return series;
				}
			}
		}
		return null;
	}

	/** Dots where the crosshair crosses line series, ringed in the background color. */
	private _renderMarkers(ctx: CanvasRenderingContext2D, x: number, row: number): void {
		const ratio = this._pixelRatio;
		for (const series of this._series) {
			if (series.type !== 'line' || row >= series.close.length) {
				continue;
			}
			const line = series.seriesOptions as LineOptions;
			const value = series.close[row]!;
			if (!line.visible || !line.crosshairMarkerVisible || value !== value) {
				continue;
			}
			const y = series.deviceY(value);
			if (!Number.isFinite(y)) {
				continue;
			}
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

/** The canvas of a price axis; dragging it scales the axis. */
function axisLayer(doc: Document): Layer {
	const layer = new Layer(doc, true);
	layer.canvas.style.cursor = 'ns-resize';
	return layer;
}

/** The first value in `[from, to)` that is not NaN, or NaN. */
function firstValue(values: Float64Array, from: number, to: number): number {
	const end = Math.min(to, values.length);
	for (let i = Math.max(0, from); i < end; i++) {
		const value = values[i]!;
		if (value === value) {
			return value;
		}
	}
	return Number.NaN;
}

/**
 * Color of the latest value: the line color, or the body color of the last bar's direction. A
 * hollow body (a faint color with an outline) gives way to its outline color.
 */
function seriesColor(ctx: CanvasRenderingContext2D, series: Series): string {
	if (series.type === 'histogram') {
		const histogram = series.seriesOptions as HistogramOptions;
		return series.lastValue < histogram.base && histogram.negativeColor !== ''
			? histogram.negativeColor
			: histogram.color;
	}
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

/** Notes a failed datafeed request: the pause doubles (1 s to 30 s) and those bars wait it out. */
function failed(series: Series, from: number, to: number): void {
	series.fetchBackoff = Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, series.fetchBackoff * 2));
	series.failures.push({ from, to, until: performance.now() + series.fetchBackoff });
}

/** Creates a chart inside `container`. */
export function createChart(container: HTMLElement, options: DeepPartial<ChartOptions> = {}): ChartApi {
	return new Chart(container, options);
}
