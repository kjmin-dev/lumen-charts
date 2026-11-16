import type { ChartApi, LogicalRange, TimeScaleApi } from './api';
import type { EngineClient, IndicatorInfo } from '@lumen-charts/engine';
import { DataFlow } from './data/data-flow';
import { DatafeedFetches } from './data/datafeed';
import { type LevelWindow, WindowCache } from './data/window-cache';
import { Drawings } from './drawings/manager';
import type { DrawingsApi } from './drawings/types';
import {
	ChartIndicators,
	type Indicator,
	type IndicatorApi,
	type IndicatorOptions,
	type IndicatorOutputApi,
	outputSeriesDefaults,
} from './indicators';
import { type AxisTarget, Interaction, type InteractionHost, type PointerDelegate } from './input/interaction';
import {
	INVALIDATE_CURSOR,
	INVALIDATE_FULL,
	INVALIDATE_LIGHT,
	INVALIDATE_NONE,
	type Invalidation,
} from './model/invalidation';
import type { SessionInfo } from './model/sessions';
import { TimeDisplay } from './model/time-display';
import { TimeIndex } from './model/time-index';
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
	resolveOptions,
	shallowEqual,
} from './options';
import { AXIS_PADDING, type PriceAxis, PriceAxes, type PriceAxisHost, type PriceScaleApi } from './price-axes';
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
import type { PanePrimitive, PrimitiveBounds, PrimitiveZOrder } from './primitives';
import { Layer } from './render/layer';
import { ChartLayout } from './render/layout';
import { PaneViewState, PrimitiveLayers, ScaleMapping } from './render/primitive-host';
import { drawCandles, drawHistogram, drawLine } from './render/series';
import { drawExtendedHours, drawSessionBreaks } from './render/sessions';
import { Series, type SeriesApi, type SeriesCreateOptions, type SeriesType } from './series';
import {
	CHART_STATE_VERSION,
	type ChartState,
	type ChartStateOptions,
	type ChartStateSelection,
	ENVIRONMENT_OPTIONS,
	type RestorePlan,
	type SeriesPlan,
	type ViewState,
	chartStateOptions,
	planRestore,
} from './state';
import { ChartSettings } from './settings';
import { canvasFits } from './shared/canvas-budget';
import { type FrameClient, cancelFrame, report, requestFrame } from './shared/frame';
import { watchPixelRatio } from './shared/media';
import { observeVisibility, unobserveVisibility } from './shared/observers';
import { type Geometry, candleWidths, placeElements } from './views/series-view';

class Chart implements ChartApi, InteractionHost, TimeScaleApi, FrameClient, PriceAxisHost {
	public readonly scale: TimeScale;
	/** Whether the chart waits for the shared animation frame (see `FrameClient`). */
	public frameQueued = false;
	/** The root element, its canvases, and the sizes of the chart, the pane and the axes. */
	private readonly _layout: ChartLayout;
	private readonly _interaction: Interaction;
	/** The price scales with their axes. */
	private readonly _axes: PriceAxes;
	private readonly _timeTicks = new TimeTicks();
	/** Time zone, sessions and label formats. */
	private readonly _time = new TimeDisplay();
	private readonly _cache = new WindowCache();
	private readonly _series: Series[] = [];
	private readonly _geometry: Geometry = { origin: 0, spacing: 1, from: 0, to: 0, shift: 0, firstRow: 0 };
	/** Window the series were drawn from in the last model update. */
	private _drawn: LevelWindow | null = null;
	private readonly _widths = { body: 1, wick: 1 };

	private readonly _settings: ChartSettings;
	private _watermarkLines: string[] = [];

	private _level: Invalidation = INVALIDATE_NONE;
	/** While a state is restored, changes only note the level they need: one invalidation at the end. */
	private _batching = false;
	private _batchLevel: Invalidation = INVALIDATE_NONE;
	/** Times a restored view shows, until the timeline can place them (see `_resolveView`). */
	private _pendingView: { from: number; to: number } | null = null;
	/** Series named by the chart so far (see `SeriesCreateOptions.id`). */
	private _named = 0;
	/**
	 * Whether any part of the chart is in the viewport. A chart that is not keeps applying data and
	 * remembers its invalidation level, but draws only once it is visible again.
	 */
	private _visible = true;
	private _destroyed = false;
	private _idle: (() => void)[] = [];
	/** The data engine and what its events change. */
	private readonly _data: DataFlow;
	/** Requests to the datafeeds of series for rows the engine needs again. */
	private readonly _fetches: DatafeedFetches;
	/** Indicators, their definitions and the modules being loaded. */
	private readonly _indicators: ChartIndicators;
	private _applied: (() => void)[] = [];

	private _crosshairVisible = false;
	private _crosshairX = 0;
	private _crosshairY = 0;
	/** The crosshair moved since drawings were last hit-tested for it. */
	private _hoverDirty = false;

	/** Logical positions of times, for anchors stored as times. */
	private readonly _times = new TimeIndex();
	/** Primitives of the pane in their three layers; the built-in drawings are among them. */
	private readonly _layers: PrimitiveLayers;
	/** The views primitives are drawn with, one per price scale they use; the default scale's. */
	private readonly _views = new Map<string, PaneViewState>();
	private readonly _view: PaneViewState;
	/** The drawings layer, created with the first primitive drawn into it; null while merged. */
	private _drawingsLayer: Layer | null = null;
	/** Near the canvas budget, drawings go into the series layer instead (see `canvasFits`). */
	private _drawingsMerged = false;
	/** The drawings layer has to be created, merged or placed again before it is drawn. */
	private _drawingsPlacement = false;
	private _drawings: Drawings | null = null;
	private readonly _target = {
		context: null as unknown as CanvasRenderingContext2D,
		pixelRatio: 1,
		width: 0,
		height: 0,
	};
	private readonly _bounds: PrimitiveBounds = { left: 0, top: 0, right: 0, bottom: 0 };
	/** Cursor of the chart's options, and the one shown. */
	private _defaultCursor = 'crosshair';
	private _cursor = '';

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

	/**
	 * The series layer cannot be brought up to date by redrawing the columns of changed items: set
	 * by every change other than data changed in place, and until the layer is drawn in full.
	 */
	private _paneStale = true;
	/** What the series layer was last drawn with, besides the series (see `Series.isDrawn`). */
	private readonly _paneGeometry: Geometry = { origin: NaN, spacing: NaN, from: 0, to: 0, shift: 0, firstRow: 0 };
	private _paneSource = -1;
	/**
	 * Where the layer has its vertical grid lines, session breaks and session shading. A new bar
	 * computes the time ticks again, mostly to the same positions: the positions decide.
	 */
	private readonly _paneTickXs = new DrawnPositions();
	private readonly _paneBreaks = new DrawnPositions();
	private readonly _paneShadeLeft = new DrawnPositions();
	private readonly _paneShadeRight = new DrawnPositions();
	private _paneGrid: PriceAxis | null = null;
	private _paneGridTicks = -1;
	/** Device columns `[_clipLeft, _clipRight)` the frame redraws, set by `_dirtyColumns`. */
	private _clipLeft = 0;
	private _clipRight = 0;
	private _unwatchPixelRatio: (() => void) | null = null;

	public constructor(container: HTMLElement, options: DeepPartial<ChartOptions>) {
		const input = mergeOptions({}, options);
		// Throws a RangeError for an unknown time zone or locale, or a malformed session schedule.
		this._time.apply(resolveOptions(input, false));
		this._settings = new ChartSettings(container, input, this._onScheme);
		this.scale = new TimeScale(
			this._settings.options.timeScale.barSpacing,
			this._settings.options.timeScale.rightOffset,
		);

		const doc = container.ownerDocument;
		this._layout = new ChartLayout(container, this._settings, this.scale, {
			invalidate: level => this.invalidate(level),
			priceAxes: () => this._axes.list,
			resized: () => this._resolveView(),
		});
		this._axes = new PriceAxes(this, this._settings, this._layout);
		this._indicators = new ChartIndicators({
			seriesList: this._series,
			engine: () => this._data.engine,
			ensureEngine: () => this._data.ensureEngine(),
			invalidate: level => this.invalidate(level),
			reloaded: (series, seq) => this.reloaded(series, seq),
			forget: series => this._cache.removeSeries(series),
			seriesRemoved: series => this._detachSeriesPrimitives(series),
			attachSeriesPrimitive: (series, primitive) => this.attachSeriesPrimitive(series, primitive),
			detachSeriesPrimitive: (series, primitive) => this.detachSeriesPrimitive(series, primitive),
			baseUrl: () => container.ownerDocument.baseURI,
			addIndicator: (source, name, settings) => this.addIndicator(source, name, settings),
			removeIndicator: indicator => this.removeIndicator(indicator),
			priceAxisOf: series => this.priceAxisOf(series),
		});
		this._fetches = new DatafeedFetches(
			this._series,
			this._cache,
			() => this._data.engine,
			() => {
				this._settle();
				this._settleApplied();
			},
		);
		this._data = new DataFlow(
			{
				syncView: () => this._syncView(),
				resolveInput: () => this._interaction.resolve(),
				invalidate: level => this.invalidate(level),
				dataChanged: () => this._schedule(INVALIDATE_LIGHT),
				callApplied: () => {
					this._paneStale = true;
				},
				resolveView: () => {
					if (this._pendingView !== null) {
						this._resolveView();
					}
				},
				settled: () => {
					this._settle();
					this._settleApplied();
				},
			},
			this._settings,
			this._layout,
			this.scale,
			this._cache,
			this._series,
			this._time,
			this._times,
			this._indicators,
			this._fetches,
		);
		this._interaction = new Interaction(this._layout.root, this);
		// The event does not bubble; capturing on the root hears it for every canvas, also later ones.
		this._layout.root.addEventListener('contextrestored', this._onContextRestored, true);

		this._unwatchPixelRatio = watchPixelRatio(doc.defaultView, this._onPixelRatio);
		observeVisibility(this._layout.root, this._onVisibility);
		this._layers = new PrimitiveLayers({ primitiveChanged: zOrder => this._primitiveChanged(zOrder) });
		this._view = this._viewFor(DEFAULT_PRICE_SCALE_ID);
		this._times.listener = () => {
			this._resolveView();
			this._primitiveChanged('normal');
		};
		this._applyResolved(this._settings.options);
	}

	// ChartApi

	public applyOptions(options: DeepPartial<ChartOptions>): void {
		if (this._destroyed) {
			return;
		}
		const input = mergeOptions(this._settings.input, options);
		if (options.localization !== undefined || options.sessions !== undefined) {
			// Throws before anything changes.
			this._applyTime(resolveOptions(input, false));
		}
		this._settings.apply(input);
		this._update();
	}

	public options(): Readonly<ChartOptions> {
		return this._settings.options;
	}

	public theme(): 'light' | 'dark' {
		return this._settings.theme();
	}

	public resize(width: number, height: number): void {
		if (this._destroyed || this._settings.options.autoSize) {
			return;
		}
		this.applyOptions({ width, height });
	}

	public element(): HTMLElement {
		return this._layout.root;
	}

	public addSeries<T extends SeriesType>(type: T, options: SeriesCreateOptions<T> = {}): SeriesApi<T> {
		const { datafeed, id, ...style } = options;
		let name = id;
		if (name === undefined || name === '') {
			do {
				name = `series-${++this._named}`;
			} while (this._seriesNamed(name) !== undefined);
		} else if (typeof name !== 'string') {
			throw new Error('lumen-charts: the id of a series must be a string');
		} else if (this._seriesNamed(name) !== undefined) {
			throw new Error(`lumen-charts: a series with id "${name}" exists already`);
		}
		const engine = this._data.ensureEngine();
		const kind = type === 'candlestick' ? 'ohlcv' : 'line';
		const engineId = engine?.addSeries(kind, datafeed !== undefined) ?? -1;
		const series = new Series(
			this,
			engineId,
			type,
			style as Partial<CandlestickOptions> | Partial<LineOptions>,
			false,
			name,
		);
		series.datafeed = (datafeed as Series['datafeed'] | undefined) ?? null;
		this._series.push(series);
		return series as unknown as SeriesApi<T>;
	}

	public removeSeries(series: SeriesApi): void {
		const index = this._series.indexOf(series as unknown as Series);
		if (index < 0 || this._series[index]!.derived) {
			return;
		}
		this._indicators.removeReadersOf(this._series[index]!.engineId);
		// Its indicators' outputs were listed after it, so removing them left it in place.
		const removed = this._series.splice(index, 1)[0]!;
		this._detachSeriesPrimitives(removed);
		this._fetches.abort(removed);
		this._cache.removeSeries(removed.engineId);
		this._data.engine?.removeSeries(removed.engineId);
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

	public series(): SeriesApi[] {
		return this._series.filter(series => !series.derived) as unknown as SeriesApi[];
	}

	public indicators(): IndicatorApi[] {
		return [...this._indicators.list];
	}

	public timeScale(): TimeScaleApi {
		return this;
	}

	// State

	public saveState(selection: ChartStateSelection = {}): ChartState {
		const parts = selection.parts;
		const state: ChartState = { version: CHART_STATE_VERSION };
		if (parts === undefined || parts.includes('options')) {
			state.options = chartStateOptions(this._settings.input, false);
		}
		const units = this._units();
		if (parts === undefined || parts.includes('series')) {
			state.series = [];
			units.forEach((unit, order) => {
				if (unit instanceof Series) {
					state.series!.push({ id: unit.id, type: unit.type, options: { ...unit.seriesOptions }, pane: 0, order });
				}
			});
		}
		if (parts === undefined || parts.includes('indicators')) {
			state.indicators = this._indicators.save(indicator => units.indexOf(indicator));
		}
		if (parts === undefined || parts.includes('drawings')) {
			state.drawings = this._drawings?.toJSON() ?? [];
		}
		if (parts === undefined || parts.includes('view')) {
			state.view = this._saveView();
		}
		return state;
	}

	public restoreState(state: ChartState, selection: ChartStateSelection = {}): void {
		if (this._destroyed) {
			return;
		}
		// Everything that can refuse the state comes before the first change.
		const plan = planRestore(state, selection.parts, {
			definition: name => this._indicators.definition(name),
			seriesIds: () => this._series.filter(series => !series.derived).map(series => series.id),
			outputDefaults: outputSeriesDefaults,
		});
		let input: DeepPartial<ChartOptions> | null = null;
		if (plan.options !== null) {
			input = this._restoredInput(plan.options);
			// Throws a RangeError for an unknown time zone or locale, or a malformed session schedule.
			new TimeDisplay().apply(resolveOptions(input, false));
		}
		this._batching = true;
		this._batchLevel = INVALIDATE_LIGHT;
		try {
			this._restore(plan, input);
		} finally {
			this._batching = false;
			this.invalidate(this._batchLevel);
		}
	}

	private _restore(plan: RestorePlan, input: DeepPartial<ChartOptions> | null): void {
		if (input !== null) {
			this._settings.apply(input);
			this._update();
		}
		const order = new Map<Series | Indicator, number>();
		if (plan.series !== null) {
			this._restoreSeries(plan.series, order);
		}
		if (plan.indicators !== null) {
			const restored = this._indicators.restore(plan.indicators, id => this._seriesNamed(id));
			for (const entry of plan.indicators) {
				order.set(restored.get(entry.id)!, entry.order);
			}
		}
		if (order.size > 0) {
			// Drawing order: what was restored by its place in the state, the rest by where it is now.
			const units = this._units();
			const keys = new Map(units.map((unit, i) => [unit, order.get(unit) ?? i]));
			units.sort((a, b) => keys.get(a)! - keys.get(b)!);
			const list = this._series;
			list.length = 0;
			for (const unit of units) {
				if (unit instanceof Series) {
					list.push(unit);
				} else {
					for (const output of unit.outputList) {
						list.push(output.series);
					}
				}
			}
		}
		if (plan.drawings !== null && (plan.drawings.length > 0 || this._drawings !== null)) {
			this._ensureDrawings().restore(plan.drawings);
		}
		if (plan.view !== null) {
			for (const id of Object.keys(plan.view.priceRanges)) {
				this._axes.get(id).setVisibleRange(plan.view.priceRanges[id]!);
			}
			this._pendingView = plan.view.timeRange;
			this._resolveView();
		}
	}

	/** The options a restore applies: those of the state, and what a state does not hold as it is now. */
	private _restoredInput(saved: ChartStateOptions): DeepPartial<ChartOptions> {
		const current = this._settings.input as Record<string, unknown>;
		const next = mergeOptions<Record<string, unknown>>({}, saved);
		for (const key of ENVIRONMENT_OPTIONS) {
			if (current[key] !== undefined) {
				next[key] = current[key];
			}
		}
		const { tickMarkFormatter, timeFormatter } = this._settings.input.localization ?? {};
		if (tickMarkFormatter !== undefined || timeFormatter !== undefined) {
			next.localization = {
				...(next.localization as object | undefined),
				...(tickMarkFormatter !== undefined && { tickMarkFormatter }),
				...(timeFormatter !== undefined && { timeFormatter }),
			};
		}
		return next as DeepPartial<ChartOptions>;
	}

	/** Makes the series those of a checked state: kept by id and type, added, or removed. */
	private _restoreSeries(plans: readonly SeriesPlan[], order: Map<Series | Indicator, number>): void {
		const wanted = new Map(plans.map(plan => [plan.id, plan]));
		for (const series of this._series.slice()) {
			if (!series.derived && wanted.get(series.id)?.type !== series.type) {
				this.removeSeries(series);
			}
		}
		for (const plan of plans) {
			let series = this._seriesNamed(plan.id);
			if (series === undefined) {
				this.addSeries(plan.type, { ...plan.options, id: plan.id } as SeriesCreateOptions<SeriesType>);
				series = this._series[this._series.length - 1]!;
			} else if (!shallowEqual(series.seriesOptions, plan.options)) {
				series.seriesOptions = plan.options;
			}
			order.set(series, plan.order);
		}
	}

	/** Series and indicators in drawing order; the outputs of an indicator are drawn together. */
	private _units(): (Series | Indicator)[] {
		const owners = new Map<Series, Indicator>();
		for (const indicator of this._indicators.list) {
			for (const output of indicator.outputList) {
				owners.set(output.series, indicator);
			}
		}
		const units: (Series | Indicator)[] = [];
		const listed = new Set<Indicator>();
		for (const series of this._series) {
			const owner = owners.get(series);
			if (owner === undefined) {
				units.push(series);
			} else if (!listed.has(owner)) {
				listed.add(owner);
				units.push(owner);
			}
		}
		return units;
	}

	private _seriesNamed(id: string): Series | undefined {
		for (const series of this._series) {
			if (!series.derived && series.id === id) {
				return series;
			}
		}
		return undefined;
	}

	/**
	 * The view as a state holds it. Times are whole milliseconds, so a view saved, restored and saved
	 * again gives the same numbers.
	 */
	private _saveView(): ViewState {
		this._syncView();
		const priceRanges: ViewState['priceRanges'] = {};
		for (const axis of this._axes.list) {
			const range = axis.settings.autoScale ? null : axis.getVisibleRange();
			if (range !== null) {
				priceRanges[axis.id] = range;
			}
		}
		const pending = this._pendingView;
		if (pending !== null) {
			// Restored and not shown yet: still the view of the chart.
			return { timeRange: { from: pending.from, to: pending.to }, priceRanges };
		}
		const scale = this.scale;
		let timeRange: ViewState['timeRange'] = null;
		if (!scale.isEmpty && scale.width > 0) {
			const coarse = this._coarseWindow();
			const from = Math.round(this._times.estimateTime(scale.from, coarse));
			const to = Math.round(this._times.estimateTime(scale.to, coarse));
			if (from < to) {
				timeRange = { from, to };
			}
		}
		return { timeRange, priceRanges };
	}

	/** The application set the view of a chart with bars: a restored view still waiting gives way. */
	private _viewSet(): void {
		if (!this.scale.isEmpty) {
			this._pendingView = null;
		}
	}

	/**
	 * Shows the times of a restored view as soon as the timeline can place them: at once when the
	 * bars around them are held, otherwise when the engine's answer is in, or when there are bars.
	 */
	private _resolveView(): void {
		const view = this._pendingView;
		const scale = this.scale;
		if (view === null || scale.isEmpty || scale.width <= 0) {
			return;
		}
		const times = this._times;
		let from = times.locate(view.from);
		let to = times.locate(view.to);
		if (from !== from || to !== to) {
			from = times.lookup(view.from);
			to = times.lookup(view.to);
		}
		if (from !== from || to !== to) {
			// Asked for: the next frame sends the question, and the answer comes back here.
			this.invalidate(INVALIDATE_CURSOR);
			return;
		}
		this._pendingView = null;
		scale.setVisibleRange(from, to);
		this.invalidate(INVALIDATE_LIGHT);
	}

	public priceScale(id: string = DEFAULT_PRICE_SCALE_ID): PriceScaleApi {
		return this._axes.get(id);
	}

	public drawings(): DrawingsApi {
		return this._ensureDrawings();
	}

	public attachPrimitive(primitive: PanePrimitive): void {
		if (!this._destroyed) {
			this._ensureDrawings();
			this._layers.attach(primitive, this._view);
		}
	}

	public detachPrimitive(primitive: PanePrimitive): void {
		this._layers.detach(primitive);
	}

	public attachSeriesPrimitive(series: Series, primitive: PanePrimitive): void {
		if (!this._destroyed && this._series.includes(series)) {
			this._ensureDrawings();
			series.primitives.add(primitive);
			this._layers.attach(primitive, this._viewFor(this._axes.of(series).id));
		}
	}

	public detachSeriesPrimitive(series: Series, primitive: PanePrimitive): void {
		if (series.primitives.delete(primitive)) {
			this._layers.detach(primitive);
		}
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
		return this._data.engine === null ? 'none' : this._data.engine.mode;
	}

	public destroy(): void {
		if (this._destroyed) {
			return;
		}
		this._destroyed = true;
		this._layout.destroy();
		this._data.close();
		unobserveVisibility(this._layout.root);
		cancelFrame(this);
		this._interaction.destroy();
		this._unwatchPixelRatio?.();
		this._unwatchPixelRatio = null;
		this._settings.release();
		this._fetches.destroy();
		this._data.destroy();
		this._indicators.destroy();
		this._settleApplied();
		this._layers.detachAll();
		this._drawings?.destroy();
		this._layout.root.removeEventListener('keydown', this._onKey);
		this._layout.root.removeEventListener('contextrestored', this._onContextRestored, true);
		this._layout.release();
		this._drawingsLayer?.release();
		this._layout.root.remove();
		this._settle();
	}

	// TimeScaleApi

	public fitContent(): void {
		this._data.afterData(() => {
			this._viewSet();
			this.scale.fitContent();
		});
	}

	public scrollToRealTime(): void {
		this._data.afterData(() => {
			this._viewSet();
			this.scale.scrollToRealTime();
		});
	}

	public setVisibleLogicalRange(range: LogicalRange): void {
		const { from, to } = range;
		this._data.afterData(() => {
			this._viewSet();
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
		return this._layout.paneLeft;
	}

	public paneWidth(): number {
		return this._layout.paneWidth;
	}

	public paneHeight(): number {
		return this._layout.paneHeight;
	}

	public setCrosshair(x: number, y: number, visible: boolean): void {
		this._crosshairX = x;
		this._crosshairY = y;
		this._crosshairVisible = visible;
		this._hoverDirty = true;
	}

	public pointerDelegate(): PointerDelegate | null {
		if (this._drawings !== null) {
			// Presses land on what is on screen: the mapping of the last frame.
			this._syncPaneView();
		}
		return this._drawings;
	}

	public priceAxisAt(target: EventTarget | null): AxisTarget | null {
		return this._axes.at(target);
	}

	public scrollPrices(dy: number): void {
		this._axes.scrollBy(dy);
	}

	// PriceAxisHost and SeriesHost

	public applyPriceScaleOptions(id: string, options: DeepPartial<PriceScaleOptions>): void {
		this.applyOptions(id === DEFAULT_PRICE_SCALE_ID ? { priceScale: options } : { priceScales: { [id]: options } });
	}

	public priceAxisOf(series: Series): PriceAxis {
		return this._axes.of(series);
	}

	public engine(): EngineClient | null {
		return this._data.engine;
	}

	public reloaded(series: Series, seq: number): void {
		// The engine drops requests for the old history once it gets there; their answers would be ignored.
		this._fetches.abort(series);
		series.reloadSeq = seq;
		series.fetchBackoff = 0;
		series.failures.length = 0;
	}

	/** Coalesces any number of changes into one draw per animation frame. */
	public invalidate(level: Invalidation): void {
		if (level >= INVALIDATE_LIGHT) {
			// Options, the view, the set of series, a primitive: anything on the series layer may differ.
			this._paneStale = true;
		}
		this._schedule(level);
	}

	/**
	 * Asks for a frame at `level`. Called directly, a Light frame may keep the series layer and redraw
	 * the columns of changed items only: for data that changed, which the frame checks against what
	 * the layer shows (see `_dirtyColumns`).
	 */
	private _schedule(level: Invalidation): void {
		if (this._destroyed) {
			return;
		}
		if (this._batching) {
			if (level > this._batchLevel) {
				this._batchLevel = level;
			}
			return;
		}
		if (level >= INVALIDATE_LIGHT && this._visible && this.scale.version !== this._data.plannedScale) {
			// The view changed: rows it needs are asked for now rather than in the next frame, so rows
			// that must be fetched again are usually back by the frame that draws the view. A chart
			// outside the viewport asks in the frame that draws it once it is back.
			this._data.requestWindow(this._layout.devicePixelRatio());
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
		this._layout.ensureSize();
		this._interaction.resolve();
	}

	// Drawings and primitives

	/** The drawings, created on first use along with what they need: keys, the time index. */
	private _ensureDrawings(): Drawings {
		if (this._drawings !== null) {
			return this._drawings;
		}
		const options = this._settings.options;
		const overlay = this._layout.overlay;
		const drawings = new Drawings(
			{
				layers: this._layers,
				times: this._times,
				view: id => this._viewFor(id),
				paneLeft: () => this._layout.paneLeft,
				invalidateOverlay: () => this.invalidate(INVALIDATE_CURSOR),
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
		this._drawings = drawings;
		// Focusable by a click, but not in the tab order, so Escape and Delete reach the drawings.
		if (this._layout.root.tabIndex < 0 && !this._layout.root.hasAttribute('tabindex')) {
			this._layout.root.tabIndex = -1;
		}
		this._layout.root.addEventListener('keydown', this._onKey);
		return drawings;
	}

	private readonly _onKey = (event: KeyboardEvent): void => {
		if (this._drawings?.key(event.key) === true) {
			event.preventDefault();
		}
	};

	/** A primitive or drawing changed: the layer it is drawn into is drawn again. */
	private _primitiveChanged(zOrder: PrimitiveZOrder): void {
		if (zOrder === 'bottom' || (zOrder === 'normal' && this._drawingsMerged)) {
			this.invalidate(INVALIDATE_LIGHT);
			return;
		}
		if (zOrder === 'normal' && this._drawingsLayer === null) {
			// The first primitive of the drawings layer: the layer is placed in the next frame.
			this._drawingsPlacement = true;
		}
		this.invalidate(INVALIDATE_CURSOR);
	}

	private _detachSeriesPrimitives(series: Series): void {
		for (const primitive of series.primitives) {
			this._layers.detach(primitive);
		}
		series.primitives.clear();
	}

	/** A window of buckets that answers for times the raw rows do not hold. */
	private _coarseWindow(): LevelWindow | null {
		const drawn = this._drawn;
		return drawn !== null && drawn.level > 0 ? drawn : this._cache.held(1);
	}

	/**
	 * Price of a point placed at bar `index` and row `y` on the scale of `view`: in magnet mode, the
	 * open, high, low or close nearest to `y` of the first visible series on that scale, where the bar
	 * is held; otherwise the price at `y`. On a percentage or indexed scale a series is drawn with its
	 * own base, so the price is the one the scale shows where that value is drawn.
	 */
	private _snapPrice(index: number, y: number, view: PaneViewState): number {
		const free = view.yToPrice(y);
		const drawn = this._drawn;
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

	private _applyCursor(): void {
		const cursor = this._drawings?.cursor || this._defaultCursor;
		if (cursor !== this._cursor) {
			this._cursor = cursor;
			this._layout.root.style.cursor = cursor;
		}
	}

	/** Places the drawings layer, or merges it into the series layer when the canvas budget is near. */
	private _placeDrawingsLayer(ratio: number): void {
		this._drawingsPlacement = false;
		const wanted = this._layers.normal.entries.length > 0;
		const area = Math.round(this._layout.paneWidth * ratio) * Math.round(this._layout.paneHeight * ratio);
		const layer = this._drawingsLayer;
		const merged = wanted && !canvasFits(area - (layer === null ? 0 : layer.pixels));
		if (!wanted || merged) {
			if (layer !== null) {
				layer.release();
				layer.canvas.remove();
				this._drawingsLayer = null;
			}
			if (merged !== this._drawingsMerged) {
				this._drawingsMerged = merged;
				this._layers.normal.changed = true;
				this._paneStale = true;
			}
			return;
		}
		if (this._drawingsMerged) {
			this._drawingsMerged = false;
			this._paneStale = true;
		}
		if (layer === null) {
			const created = new Layer(this._layout.root.ownerDocument, false);
			created.canvas.style.pointerEvents = 'none';
			this._layout.root.insertBefore(created.canvas, this._layout.overlay.canvas);
			this._drawingsLayer = created;
			this._layers.normal.changed = true;
		}
		if (this._drawingsLayer!.place(this._layout.paneLeft, 0, this._layout.paneWidth, this._layout.paneHeight, ratio)) {
			this._layers.normal.changed = true;
		}
	}

	/** The view of primitives and drawings on price scale `id`, made with the scale if need be. */
	private _viewFor(id: string): PaneViewState {
		let view = this._views.get(id);
		if (view === undefined) {
			const scale = this._axes.get(id).scale;
			view = new PaneViewState(id, this._times, new ScaleMapping(scale), () => this._coarseWindow());
			this._views.set(id, view);
		}
		return view;
	}

	/** Hands the mapping of the last model update (what is on screen) to the views of primitives. */
	private _syncPaneView(): void {
		const geometry = this._geometry;
		const scale = this.scale;
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
	private _syncPrimitives(): boolean {
		this._syncPaneView();
		const layers = this._layers;
		const bounds = this._bounds;
		let updated = layers.normal.update(bounds);
		if (layers.top.update(bounds)) {
			updated = true;
		}
		return updated;
	}

	/** Sets the draw target to a layer's context, with the origin at the pane's top left corner. */
	private _targetOf(ctx: CanvasRenderingContext2D): typeof this._target {
		const target = this._target;
		target.context = ctx;
		target.pixelRatio = this._layout.pixelRatio;
		target.width = this._layout.paneWidth;
		target.height = this._layout.paneHeight;
		return target;
	}

	/** Draws the primitives of the drawings layer, the built-in drawings among them. */
	private _renderDrawings(): void {
		const layer = this._drawingsLayer;
		const ctx = layer?.ctx ?? null;
		if (layer === null || ctx === null) {
			return;
		}
		ctx.clearRect(0, 0, layer.width, layer.height);
		this._layers.normal.draw(this._targetOf(ctx));
	}

	// Data flow

	private _isApplied(): boolean {
		const engine = this._data.engine;
		return (
			this._destroyed ||
			engine === null ||
			(engine.pending === 0 && this._indicators.computing === 0 && this._fetches.fetching === 0)
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

	private _isIdle(): boolean {
		return (
			this._destroyed ||
			(!this.frameQueued &&
				this._fetches.fetching === 0 &&
				this._indicators.computing === 0 &&
				(this._data.engine === null || this._data.engine.pending === 0))
		);
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

	/** Re-resolves the options, for example after the system color scheme changed. */
	private _update(): void {
		const next = this._settings.resolve();
		if (optionsEqual(next, this._settings.options)) {
			return;
		}
		this._settings.options = next;
		this._applyResolved(next);
		this._data.setMemoryLimit(next.memoryLimit);
		this.invalidate(INVALIDATE_FULL);
	}

	/** Pushes resolved options into the parts that keep their own copy. */
	private _applyResolved(options: ChartOptions): void {
		this._axes.sync(options);
		const watermark = options.watermark;
		this._watermarkLines = watermark.visible && watermark.text !== '' ? watermark.text.split('\n') : [];
		this._layout.timeAxis.setVisible(options.timeScale.visible);
		this._defaultCursor = options.crosshair.mode === 'hidden' ? 'default' : 'crosshair';
		this._cursor = '';
		this._applyCursor();
		if (this._drawings !== null) {
			this._drawings.style.handleFill = options.layout.background;
			this._drawings.style.fontFamily = options.layout.fontFamily;
			this._primitiveChanged('normal');
		}
		this._layout.font = '';
		this._ticksScale = -1;
		for (const axis of this._axes.list) {
			axis.fitTicks = -1;
		}
		this._applyTime(options);
		this._layout.syncSizing();
		this._layout.compute();
	}

	/**
	 * Takes over the time zone, locale and session options. When they change, the offsets of the
	 * bars on screen are looked up now rather than in the frame that draws them. Throws a RangeError
	 * for an unknown time zone or locale, or a malformed schedule, and then changes nothing.
	 */
	private _applyTime(options: ChartOptions): void {
		const drawn = this._drawn;
		if (this._time.apply(options) && drawn !== null) {
			this._time.cover(drawn.time, drawn.count, 2 ** drawn.shift);
		}
	}

	private readonly _onScheme = (): void => {
		if (!this._destroyed) {
			this._update();
		}
	};

	// Sizing and layout

	/** Redraws at the new resolution when the window moves to another screen or the page is zoomed. */
	private readonly _onPixelRatio = (): void => {
		this.invalidate(INVALIDATE_FULL);
	};

	/**
	 * The browser lost a canvas (the GPU process restarted, say) and hands it back empty. Layers keep
	 * what they drew between frames: axes while their ticks stay, drawings while nothing moves, the
	 * series layer outside the columns a tick changed. So everything is drawn again.
	 */
	private readonly _onContextRestored = (): void => {
		this._layout.dirty = true;
		this._layers.normal.changed = true;
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

	/** Sizes the canvases to the layout, at the device pixel ratio of the window. */
	private _placeLayers(): void {
		// A canvas that changes size is cleared, and the pixel ratio and fonts may differ.
		this._paneStale = true;
		const layout = this._layout;
		layout.placePanes();
		this._placeDrawingsLayer(layout.pixelRatio);
		layout.placeOverlay();
		this._timeAxisDrawn = -1;
	}

	// Frame

	/** Write phase of a frame: sizes the canvases and draws whatever the invalidation level asks for. */
	public frameWrite(now: number): void {
		if (this._drawingsPlacement) {
			this._placeDrawingsLayer(this._layout.pixelRatio);
		}
		let level = this._level;
		this._level = INVALIDATE_NONE;
		if (level < INVALIDATE_LIGHT && this._drawingsMerged && this._layers.normal.changed) {
			// Merged into the series layer, drawings are drawn with the series.
			level = INVALIDATE_LIGHT;
		}
		if (this._drawingsMerged && this._layers.normal.changed) {
			// Also when the last merged drawing went away.
			this._paneStale = true;
		}
		const animating = this._interaction.step(now);
		if (level === INVALIDATE_FULL || this._layout.font === '') {
			this._placeLayers();
		}
		if (level >= INVALIDATE_LIGHT) {
			this._updateModel();
			if (this._axes.fitWidths(this.scale.isEmpty)) {
				// The axis takes its width from the pane. The same bars stay visible, slightly narrower.
				const scale = this.scale;
				const from = scale.from;
				const to = scale.to;
				this._layout.compute();
				scale.setVisibleRange(from, to);
				this._updateModel();
			}
			if (this._layout.dirty) {
				this._placeLayers();
			}
			if (this._layout.paneWidth > 0 && this._layout.paneHeight > 0) {
				this._renderPane();
				this._renderAxes();
			} else {
				// The changed items of this frame are not drawn, and the next frame will not know them.
				this._paneStale = true;
			}
		}
		if (this._layout.paneWidth > 0 && this._layout.paneHeight > 0) {
			if (this._drawings !== null) {
				// Tools place points with the view of this frame, also before the first drawing exists.
				const moved = this._syncPrimitives();
				if (this._drawingsLayer !== null && this._layers.normal.changed) {
					this._renderDrawings();
				}
				if (this._drawings !== null && (this._hoverDirty || moved)) {
					this._hoverDirty = false;
					this._drawings.hover(this._crosshairX, this._crosshairY, this._crosshairVisible);
				}
			}
			this._renderOverlay();
		}
		this._applyCursor();
		this._times.flush(this._data.engine);
		this._cache.clearDirty();
		if (animating) {
			this.invalidate(INVALIDATE_LIGHT);
		}
		this._settle();
	}

	/** Brings scales, items and ticks up to date with the time scale and the window cache. */
	private _updateModel(): void {
		const scale = this.scale;
		const cache = this._cache;
		const ratio = this._layout.pixelRatio;
		this._data.requestWindow(ratio);

		const geometry = this._geometry;
		const spacing = scale.barSpacing * ratio;
		let origin = (scale.width - (scale.end - 1 + scale.rightOffset + 0.5) * scale.barSpacing) * ratio;
		const level = this._data.levelFor(spacing);
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
		this._times.setWindow(cache.held(0));
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

		const axes = this._axes.list;
		for (let i = 0; i < axes.length; i++) {
			axes[i]!.beginFrame();
		}
		const size = 2 ** geometry.shift;
		for (const series of this._series) {
			const visible = series.seriesOptions.visible;
			const axis = visible ? this._axes.of(series) : null;
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
			series.bind(source.blocks.get(series.engineId), source.capacity, source.version, source.level);
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
		this._axes.grid = grid;
		const fontSize = this._settings.options.layout.fontSize;
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
				const sessions = this._settings.options.sessions;
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

	/**
	 * Finds the device columns a frame has to redraw when only data changed, into `_clipLeft` and
	 * `_clipRight`. Returns `PANE_FULL` when the series layer has to be drawn as a whole, `PANE_KEPT`
	 * when it shows everything already, `PANE_PARTIAL` otherwise.
	 *
	 * The layer can be patched when it was drawn with this geometry, window, grid and price mappings,
	 * and everything on it is drawn by the chart itself: then it differs from a full redraw only where
	 * the items the views rebuilt are drawn. A changed item moves the line from its neighbor on either
	 * side, so the columns reach from the item before the first one to the item after the last, plus
	 * what the stroke or the bar covers around them. A new price range, a scrolled view, a replaced
	 * window, a custom renderer or a primitive below the series fail the test.
	 */
	private _dirtyColumns(width: number): number {
		const geometry = this._geometry;
		const drawn = this._paneGeometry;
		const grid = this._axes.grid;
		const layers = this._layers;
		const marks = this._time.marks;
		if (
			this._paneStale ||
			geometry.origin !== drawn.origin ||
			geometry.spacing !== drawn.spacing ||
			geometry.from !== drawn.from ||
			geometry.to !== drawn.to ||
			geometry.shift !== drawn.shift ||
			geometry.firstRow !== drawn.firstRow ||
			(this._drawn === null ? -1 : this._drawn.version) !== this._paneSource ||
			!this._paneTickXs.match(this._tickXs, this._timeTicks.count) ||
			!this._paneBreaks.match(marks.breakX, marks.breakCount) ||
			!this._paneShadeLeft.match(marks.shadeLeft, marks.shadeCount) ||
			!this._paneShadeRight.match(marks.shadeRight, marks.shadeCount) ||
			grid !== this._paneGrid ||
			grid.scale.ticksGeneration !== this._paneGridTicks ||
			layers.bottom.entries.length > 0 ||
			(this._drawingsMerged && layers.normal.entries.length > 0)
		) {
			return PANE_FULL;
		}
		const ratio = this._layout.pixelRatio;
		const body = this._widths.body;
		let left = Infinity;
		let right = -Infinity;
		for (const series of this._series) {
			if (!series.isDrawn()) {
				return PANE_FULL;
			}
			const view = series.view;
			const count = view.count;
			if (count === 0) {
				continue;
			}
			if (series.renderer !== null) {
				return PANE_FULL;
			}
			if (view.dirtyTo <= view.dirtyFrom) {
				continue;
			}
			const reach = seriesReach(series, ratio, body);
			const from = view.x[Math.max(0, view.dirtyFrom - 1)]! - reach;
			// Dashes are counted along the path, so a change moves every dash after it.
			const to = isDashed(series) ? width : view.x[Math.min(count - 1, view.dirtyTo)]! + reach;
			if (from < left) {
				left = from;
			}
			if (to > right) {
				right = to;
			}
		}
		left = Math.max(0, Math.floor(left));
		right = Math.min(width, Math.ceil(right));
		if (!(right > left)) {
			return PANE_KEPT;
		}
		if (left === 0 && right === width) {
			return PANE_FULL;
		}
		this._clipLeft = left;
		this._clipRight = right;
		return PANE_PARTIAL;
	}

	/**
	 * Draws the series layer: all of it, or only the columns in which a tick changed something
	 * (`_dirtyColumns`). Those are cleared and drawn through a clip with the same calls in the same
	 * order as the whole layer, so the result is the full redraw's, pixel for pixel: each series is
	 * drawn from the last item whose stroke or bar ends left of the columns to the first one that
	 * starts right of them, which leaves every pixel inside with the same shapes over it.
	 */
	private _renderPane(): void {
		const layer = this._layout.pane;
		const ctx = layer.ctx;
		if (ctx === null) {
			return;
		}
		const options = this._settings.options;
		const ratio = this._layout.pixelRatio;
		const widths = this._widths;
		// A bucket drawn as one candle (a coarse level shown wider than a pixel) is as wide as its bars.
		candleWidths(this._geometry.spacing * 2 ** this._geometry.shift, ratio, widths);
		const mode = this._dirtyColumns(layer.width);
		const partial = mode === PANE_PARTIAL;
		if (mode === PANE_KEPT) {
			return;
		}
		if (partial) {
			ctx.save();
			ctx.beginPath();
			ctx.rect(this._clipLeft, 0, this._clipRight - this._clipLeft, layer.height);
			ctx.clip();
		}
		ctx.fillStyle = options.layout.background;
		ctx.fillRect(0, 0, layer.width, layer.height);
		const grid = this._axes.grid;
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
		const layers = this._layers;
		const primitives = layers.size > 0;
		if (primitives) {
			this._syncPaneView();
			if (layers.bottom.entries.length > 0) {
				layers.bottom.update(this._bounds);
				layers.bottom.draw(this._targetOf(ctx));
			}
		}
		const border = Math.max(1, Math.floor(ratio));
		for (const series of this._series) {
			const view = series.view;
			series.markDrawn();
			if (view.count === 0 || !series.seriesOptions.visible) {
				continue;
			}
			if (series.renderer !== null) {
				view.barWidth = widths.body;
				const axis = series.axis;
				series.renderer.draw(this._targetOf(ctx), view, axis === null ? this._view : this._viewFor(axis.id));
				continue;
			}
			let from = 0;
			let to = view.count;
			if (partial) {
				const reach = seriesReach(series, ratio, widths.body);
				// One item more on either side: where a line starts or ends it has a cap, not a join.
				from = isDashed(series) ? 0 : Math.max(0, view.firstAfter(this._clipLeft - reach) - 1);
				to = Math.min(to, view.firstAfter(this._clipRight + reach) + 1);
				if (to <= from) {
					continue;
				}
			}
			const inverted = series.deviceScale < 0;
			if (series.kind === 'ohlcv') {
				drawCandles(
					ctx,
					view,
					widths.body,
					widths.wick,
					border,
					series.seriesOptions as CandlestickOptions,
					inverted,
					from,
					to,
				);
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
					from,
					to,
				);
			} else {
				const line = series.seriesOptions as LineOptions;
				const width = Math.max(1, line.lineWidth * ratio);
				drawLine(ctx, view, line.color, width, dashPattern(line.lineStyle, width), line.lineType === 'step', from, to);
			}
		}
		if (primitives && this._drawingsMerged) {
			if (layers.normal.update(this._bounds)) {
				this._hoverDirty = true;
			}
			layers.normal.draw(this._targetOf(ctx));
		}
		if (partial) {
			ctx.restore();
			return;
		}
		const geometry = this._geometry;
		const drawn = this._paneGeometry;
		drawn.origin = geometry.origin;
		drawn.spacing = geometry.spacing;
		drawn.from = geometry.from;
		drawn.to = geometry.to;
		drawn.shift = geometry.shift;
		drawn.firstRow = geometry.firstRow;
		this._paneSource = this._drawn === null ? -1 : this._drawn.version;
		this._paneTickXs.take(this._tickXs, this._timeTicks.count);
		this._paneBreaks.take(marks.breakX, marks.breakCount);
		this._paneShadeLeft.take(marks.shadeLeft, marks.shadeCount);
		this._paneShadeRight.take(marks.shadeRight, marks.shadeCount);
		this._paneGrid = grid;
		this._paneGridTicks = grid.scale.ticksGeneration;
		this._paneStale = false;
	}

	private _renderWatermark(ctx: CanvasRenderingContext2D, width: number, height: number): void {
		const watermark = this._settings.options.watermark;
		const lines = this._watermarkLines;
		const ratio = this._layout.pixelRatio;
		const lineHeight = watermark.fontSize * ratio * 1.2;
		const padding = 2 * AXIS_PADDING * ratio;
		const block = lineHeight * lines.length;
		const { horzAlign, vertAlign } = watermark;
		const x = horzAlign === 'left' ? padding : horzAlign === 'right' ? width - padding : width / 2;
		let y = vertAlign === 'top' ? padding : vertAlign === 'bottom' ? height - padding - block : (height - block) / 2;
		y += lineHeight / 2;
		ctx.font = this._layout.watermarkFont;
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
		const ratio = this._layout.pixelRatio;
		const options = this._settings.options;
		const style = this._axisStyle;
		style.background = options.layout.background;
		style.textColor = options.layout.textColor;
		style.font = this._layout.font;
		style.pixelRatio = ratio;
		for (const axis of this._axes.list) {
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
			const layer = this._layout.timeAxis;
			if (layer.ctx !== null) {
				drawTimeAxis(
					layer.ctx,
					layer.width,
					layer.height,
					style,
					timeOptions.borderVisible ? timeOptions.borderColor : '',
					Math.round(this._layout.paneLeft * ratio),
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
		const layer = this._layout.overlay;
		const ctx = layer.ctx;
		if (ctx === null) {
			return;
		}
		ctx.clearRect(0, 0, layer.width, layer.height);
		const ratio = this._layout.pixelRatio;
		const options = this._settings.options;
		const paneLeft = Math.round(this._layout.paneLeft * ratio);
		const paneWidth = this._layout.pane.width;
		const paneHeight = this._layout.pane.height;
		const tagHeight = Math.round((options.layout.fontSize + 8) * ratio);
		const font = this._layout.font;
		// Value labels of overlays go on the default scale's axis, or on the first visible one.
		let overlayAxis: PriceAxis | null = null;
		for (const axis of this._axes.list) {
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

		const drawings = this._drawings;
		if (this._layers.top.entries.length > 0 || (drawings !== null && drawings.overlayInUse)) {
			// Pane coordinates, clipped to the pane, like the layers below.
			ctx.save();
			ctx.beginPath();
			ctx.rect(paneLeft, 0, paneWidth, paneHeight);
			ctx.clip();
			ctx.translate(paneLeft, 0);
			const target = this._targetOf(ctx);
			this._layers.top.draw(target);
			drawings?.drawOverlay(target);
			ctx.restore();
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
			for (const axis of this._axes.list) {
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
			const width = Math.ceil((label.length * this._layout.digitWidth + 2 * AXIS_PADDING) * ratio);
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
		const ratio = this._layout.pixelRatio;
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
			this._layout.font,
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
		const ratio = this._layout.pixelRatio;
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
			ctx.fillStyle = this._settings.options.layout.background;
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
/** Device positions the series layer was drawn with, to tell whether they are still the same. */
class DrawnPositions {
	private _values = new Float32Array(16);
	private _count = -1;

	public match(values: Float32Array, count: number): boolean {
		if (count !== this._count) {
			return false;
		}
		const own = this._values;
		for (let i = 0; i < count; i++) {
			if (values[i] !== own[i]) {
				return false;
			}
		}
		return true;
	}

	public take(values: Float32Array, count: number): void {
		if (this._values.length < count) {
			this._values = new Float32Array(count * 2);
		}
		this._values.set(values.subarray(0, count));
		this._count = count;
	}
}

/** What a frame does with the series layer (see `Chart._dirtyColumns`). */
const PANE_FULL = 0;
const PANE_PARTIAL = 1;
const PANE_KEPT = 2;

/** A line series drawn with dashes or dots. */
function isDashed(series: Series): boolean {
	return series.type === 'line' && (series.seriesOptions as LineOptions).lineStyle !== 'solid';
}

/**
 * How far from the x of an item, in device pixels, anything drawn for that item alone can color a
 * pixel: a bar is narrower than `body` on either side; a line's stroke, joins and caps stay within
 * half its width of the path, which runs up to half a pixel beside the item, and antialiasing
 * spreads an edge by less than a pixel.
 */
function seriesReach(series: Series, pixelRatio: number, body: number): number {
	if (series.type !== 'line') {
		return body + 1;
	}
	return Math.max(1, (series.seriesOptions as LineOptions).lineWidth * pixelRatio) / 2 + 2;
}

function thickness(width: number, pixelRatio: number): number {
	return Math.max(1, Math.floor(width * pixelRatio));
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

/** Creates a chart inside `container`. */
export function createChart(container: HTMLElement, options: DeepPartial<ChartOptions> = {}): ChartApi {
	return new Chart(container, options);
}
