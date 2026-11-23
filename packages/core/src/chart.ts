import type {
	ChartApi,
	ChartError,
	ChartPointerEvent,
	LogicalRange,
	MarkSeriesCreateOptions,
	TimeScaleApi,
} from './api';
import type { EngineClient, IndicatorInfo } from '@lumen-charts/engine';
import { DataFlow } from './data/data-flow';
import { DatafeedFetches } from './data/datafeed';
import { WindowCache } from './data/window-cache';
import { PanePrimitives } from './drawings/pane-primitives';
import type { DrawingsApi } from './drawings/types';
import { ChartIndicators, type IndicatorApi, type IndicatorOptions, type IndicatorOutputApi } from './indicators';
import { ChartMarks } from './marks/chart-marks';
import type { HeatmapData, ScatterData } from './marks/input';
import type { AnyMarkOptions, HeatmapOptions, MarkSeriesType, ScatterOptions } from './marks/options';
import type { MarksDatafeed } from './marks/fetches';
import type { HeatmapSeriesApi, MarkSeriesApi, ScatterSeriesApi } from './marks/series';
import { type MarkSeriesPlan, isMarkType, planMarkSeries } from './marks/state';
import { ChartReadout } from './input/chart-readout';
import { ChartAccessibility } from './input/chart-accessibility';
import { ChartEvents } from './input/chart-events';
import { type AxisTarget, Interaction, type InteractionHost, type PointerDelegate } from './input/interaction';
import {
	INVALIDATE_CURSOR,
	INVALIDATE_FULL,
	INVALIDATE_LIGHT,
	INVALIDATE_NONE,
	type Invalidation,
} from './model/invalidation';
import { Crosshair } from './model/crosshair';
import { FrameModel } from './model/frame-model';
import type { SessionInfo } from './model/sessions';
import { TimeDisplay } from './model/time-display';
import { TimeIndex } from './model/time-index';
import { TimeScale } from './model/time-scale';
import {
	type CandlestickOptions,
	checkMarkRenderer,
	type ChartOptions,
	DEFAULT_PRICE_SCALE_ID,
	type DeepPartial,
	type LineOptions,
	type PriceScaleOptions,
	mergeOptions,
	optionsEqual,
	prepareChartKeymap,
	resolveOptions,
} from './options';
import { type PriceAxis, PriceAxes, type PriceAxesHost, type PriceScaleApi } from './price-axes';
import type { PanePrimitive, PaneView } from './primitives';
import { AxisRenderer } from './render/axes';
import { ChartLayout } from './render/layout';
import { OverlayRenderer } from './render/overlay';
import { PaneRenderer } from './render/pane';
import { Series, type SeriesApi, type SeriesCreateOptions, type SeriesType, type TimeRange } from './series';
import { type ChartState, type ChartStateSelection } from './state';
import { ChartSettings } from './settings';
import { StateIo } from './state-io';
import { type FrameClient, cancelFrame, report, requestFrame } from './shared/frame';
import { Listeners } from './shared/listeners';
import { watchPixelRatio } from './shared/media';
import { observeVisibility, unobserveVisibility } from './shared/observers';

/**
 * The chart behind `ChartApi`: it owns the parts, wires them to each other, and runs the frame.
 *
 * What stays here is what crosses the parts: the public methods, which mostly hand over to one
 * part; invalidation and scheduling (`invalidate`, `_schedule`); the two phases of a frame
 * (`frameRead`, `frameWrite`); applying options to every part; and who waits for the chart to be
 * idle. A feature lives in its part:
 *
 * - `ChartSettings` (settings.ts): the options applied and what they resolve to.
 * - `ChartLayout` (render/layout.ts): the root element, the canvases, sizing and layout.
 * - `PriceAxes` (price-axes.ts): the price scales and their axes.
 * - `DataFlow` (data/data-flow.ts): the data engine, its events, window requests, deferred calls.
 * - `DatafeedFetches` (data/datafeed.ts): rows fetched again from the datafeeds of series.
 * - `ChartIndicators` (indicators.ts): indicators and their output series.
 * - `FrameModel` (model/frame-model.ts): what a frame draws, from the view and the window cache.
 * - `PanePrimitives` (drawings/pane-primitives.ts): primitives, drawings and their layer.
 * - `PaneRenderer`, `AxisRenderer`, `OverlayRenderer` (render/): the series layer, axes, overlay.
 * - `StateIo` (state-io.ts): save and restore, and the view of a restored state.
 * - `ChartMarks` (marks/chart-marks.ts): heatmap and scatter series, drawn through pixel buffers.
 * - `ChartEvents` (input/chart-events.ts): the crosshair, click and visible range events.
 *
 * Parts get the parts and callbacks they need rather than the chart, and nothing here runs per
 * item: a frame makes a handful of calls into them.
 */
class Chart implements ChartApi, InteractionHost, FrameClient, PriceAxesHost {
	public readonly scale: TimeScale;
	/** Whether the chart waits for the shared animation frame (see `FrameClient`). */
	public frameQueued = false;

	// What the parts share.
	private readonly _series: Series[] = [];
	private readonly _cache = new WindowCache();
	/** Time zone, sessions and label formats. */
	private readonly _time = new TimeDisplay();
	/** Logical positions of times, for anchors stored as times. */
	private readonly _times = new TimeIndex();
	private readonly _crosshair = new Crosshair();

	// The parts.
	private readonly _settings: ChartSettings;
	/** The root element, its canvases, and the sizes of the chart, the pane and the axes. */
	private readonly _layout: ChartLayout;
	/** The price scales with their axes. */
	private readonly _axes: PriceAxes;
	/** Indicators, their definitions and the modules being loaded. */
	private readonly _indicators: ChartIndicators;
	/** Requests to the datafeeds of series for rows the engine needs again. */
	private readonly _fetches: DatafeedFetches;
	/** The data engine and what its events change. */
	private readonly _data: DataFlow;
	/** What the frame draws: the rows in view, their place, and the ticks. */
	private readonly _model: FrameModel;
	private readonly _interaction: Interaction;
	private readonly _accessibility: ChartAccessibility;
	/** The primitives and drawings of the pane, and their layer. */
	private readonly _primitives: PanePrimitives;
	/** Saves and restores the state of the chart, and holds a restored view until it can be shown. */
	private readonly _stateIo: StateIo;
	/** Heatmap and scatter series. */
	private readonly _marks: ChartMarks;
	/** Events of the crosshair, clicks and the visible range, and the crosshair the application places. */
	private readonly _events: ChartEvents;
	/** What `timeScale()` returns. */
	private readonly _timeScale: TimeScaleApi;
	/** The heatmap and scatter series of a state being restored, checked, until the restore applies them. */
	private _markPlans: MarkSeriesPlan[] | null = null;
	/** What draws the series layer, the axes and the overlay. */
	private readonly _paneRenderer: PaneRenderer;
	private readonly _axisRenderer: AxisRenderer;
	private readonly _overlayRenderer: OverlayRenderer;

	private _level: Invalidation = INVALIDATE_NONE;
	/** While a state is restored, changes only note the level they need: one invalidation at the end. */
	private _batching = false;
	private _batchLevel: Invalidation = INVALIDATE_NONE;
	/** Series named by the chart so far (see `SeriesCreateOptions.id`). */
	private _named = 0;
	/**
	 * Whether any part of the chart is in the viewport. A chart that is not keeps applying data and
	 * remembers its invalidation level, but draws only once it is visible again.
	 */
	private _visible = true;
	private _destroyed = false;
	/** Who waits for the chart to be idle (`whenIdle`), and for its data to be applied (`whenApplied`). */
	private _idle: (() => void)[] = [];
	private _applied: (() => void)[] = [];
	/** Handlers of `subscribe('error')`. */
	private readonly _errors = new Listeners<ChartError>();
	private _unwatchPixelRatio: (() => void) | null = null;

	public constructor(container: HTMLElement, options: DeepPartial<ChartOptions>) {
		const input = mergeOptions<DeepPartial<ChartOptions>>({}, options);
		const keymap = prepareChartKeymap(input);
		// Throws a RangeError for an unknown time zone or locale, or a malformed session schedule.
		this._time.apply(resolveOptions(input, false));
		this._settings = new ChartSettings(container, input, this._onScheme);
		this.scale = new TimeScale(
			this._settings.options.timeScale.barSpacing,
			this._settings.options.timeScale.rightOffset,
		);

		const doc = container.ownerDocument;
		// Callbacks look up later parts when invoked. Initial sizing runs once every part is ready.
		this._layout = new ChartLayout(container, this._settings, this.scale, {
			invalidate: this._onInvalidate,
			priceAxes: () => this._axes.list,
			resized: () => this._stateIo.resolveView(),
		});
		this._axes = new PriceAxes(this, this._settings, this._layout);
		this._indicators = this._createIndicators(container);
		this._fetches = new DatafeedFetches(this._series, this._cache, () => this._data.engine, this._onDataSettled);
		this._data = this._createDataFlow();
		this._model = new FrameModel(
			this._settings,
			this._layout,
			this.scale,
			this._cache,
			this._series,
			this._axes,
			this._time,
			this._times,
			this._data,
		);
		this._interaction = new Interaction(this._layout.root, this);
		// The event does not bubble; capturing on the root hears it for every canvas, also later ones.
		this._layout.root.addEventListener('contextrestored', this._onContextRestored, true);

		this._unwatchPixelRatio = watchPixelRatio(doc.defaultView, this._onPixelRatio);
		observeVisibility(this._layout.root, this._onVisibility);
		this._primitives = new PanePrimitives(
			this._settings,
			this._layout,
			this.scale,
			this._series,
			this._axes,
			this._model,
			this._times,
			this._onInvalidate,
		);
		this._stateIo = this._createStateIo();
		this._marks = this._createMarks();
		this._model.marks = this._marks;
		this._accessibility = new ChartAccessibility(
			keymap,
			this._layout,
			this.scale,
			this._model,
			new ChartReadout(this._model, this._time, this._series, this._indicators, this._marks),
			this._crosshair,
			this._onInvalidate,
		);
		this._paneRenderer = new PaneRenderer(
			this._settings,
			this._layout,
			this._series,
			this._axes,
			this._model,
			this._time,
			this._primitives,
			this._crosshair,
		);
		this._axisRenderer = new AxisRenderer(this._settings, this._layout, this._axes, this._model);
		this._overlayRenderer = new OverlayRenderer(
			this._settings,
			this._layout,
			this.scale,
			this._series,
			this._axes,
			this._model,
			this._time,
			this._primitives,
			this._crosshair,
		);
		this._events = new ChartEvents(
			this.scale,
			this._crosshair,
			this._model,
			this._series,
			this._indicators,
			this._times,
			this._axes,
			this._onInvalidate,
		);
		this._timeScale = this._createTimeScale();
		this._times.listener = () => {
			this._stateIo.resolveView();
			this._primitives.timelineChanged();
			this._events.timelineChanged();
		};
		this._applyResolved(this._settings.options);
	}

	private _createIndicators(container: HTMLElement): ChartIndicators {
		return new ChartIndicators({
			seriesList: this._series,
			engine: () => this._data.engine,
			ensureEngine: () => this._data.ensureEngine(),
			invalidate: this._onInvalidate,
			reloaded: (series, seq) => this.reloaded(series, seq),
			forget: series => this._cache.removeSeries(series),
			seriesRemoved: series => this._primitives.detachSeries(series),
			attachSeriesPrimitive: (series, primitive) => this.attachSeriesPrimitive(series, primitive),
			detachSeriesPrimitive: (series, primitive) => this.detachSeriesPrimitive(series, primitive),
			baseUrl: () => container.ownerDocument.baseURI,
			markOf: value => this._marks.list.find(entry => entry === value) ?? null,
			addIndicator: (source, name, settings) => this.addIndicator(source, name, settings),
			removeIndicator: indicator => this.removeIndicator(indicator),
			priceAxisOf: series => this.priceAxisOf(series),
		});
	}

	private _createDataFlow(): DataFlow {
		return new DataFlow(
			{
				syncView: () => this._syncView(),
				resolveInput: () => this._interaction.resolve(),
				invalidate: this._onInvalidate,
				dataChanged: this._onDataChanged,
				callApplied: () => {
					this._paneRenderer.stale = true;
				},
				resolveView: () => this._stateIo.resolveView(),
				settled: this._onDataSettled,
				failed: (kind, message, cause) => this._failed(kind, message, cause),
				refused: (id, count) => this._refused(id, count),
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
	}

	private _createStateIo(): StateIo {
		return new StateIo(
			{
				addSeries: (type, seriesOptions) => this.addSeries(type, seriesOptions),
				removeSeries: series => this.removeSeries(series),
				seriesNamed: id => this._seriesNamed(id),
				markNamed: id => this._marks.named(id) as unknown as ScatterSeriesApi | HeatmapSeriesApi | undefined,
				markKinds: () =>
					new Map(
						(this._markPlans ?? this._marks.list).map(entry => [entry.id, entry.type] as [string, MarkSeriesType]),
					),
				replaceOptions: replaced => {
					this._settings.apply(replaced);
					this._update();
				},
				batch: changes => this._restoreBatch(changes),
				syncView: () => this._syncView(),
				invalidate: this._onInvalidate,
			},
			this._settings,
			this.scale,
			this._series,
			this._indicators,
			this._axes,
			this._model,
			this._times,
			this._primitives,
		);
	}

	/** The time scale API: the view methods of the chart, its conversions and its range events. */
	private _createTimeScale(): TimeScaleApi {
		return {
			fitContent: () => this.fitContent(),
			scrollToRealTime: () => this.scrollToRealTime(),
			setVisibleLogicalRange: range => this.setVisibleLogicalRange(range),
			getVisibleLogicalRange: () => this.getVisibleLogicalRange(),
			setVisibleRange: range => this._setVisibleRange(range),
			getVisibleRange: () => {
				this._syncView();
				return this._events.visibleTimes();
			},
			timeToCoordinate: time => this._timeToCoordinate(time),
			coordinateToTime: x => {
				const view = this._paneView();
				return view === null ? null : finite(view.xToTime(x));
			},
			logicalToCoordinate: logical => {
				const view = this._paneView();
				return view === null ? null : finite(view.logicalToX(logical));
			},
			coordinateToLogical: x => {
				const view = this._paneView();
				return view === null ? null : finite(view.xToLogical(x));
			},
			isInSession: time => this.isInSession(time),
			sessionAt: time => this.sessionAt(time),
			subscribe: ((event: string, handler: (range: LogicalRange | null) => void) => {
				const unsubscribe = this._events.subscribeRange(event, handler);
				if (unsubscribe === null) {
					throw new Error(`lumen-charts: the time scale has no event "${String(event)}"`);
				}
				return unsubscribe;
			}) as TimeScaleApi['subscribe'],
		};
	}

	private _createMarks(): ChartMarks {
		return new ChartMarks(
			{
				ensureEngine: () => this._data.ensureEngine(),
				markRenderer: () => this._settings.options.markRenderer,
				invalidate: () => this.invalidate(INVALIDATE_LIGHT),
				dataChanged: this._onDataChanged,
				settled: this._onDataSettled,
				addTimeline: () => this._addTimeline(),
				removeTimeline: engineId => this._removeTimeline(engineId),
				removing: engineId => this._indicators.removeReadersOf(engineId),
			},
			this._layout,
			this.scale,
			this._axes,
			this._primitives,
			this._model,
		);
	}

	// ChartApi

	public applyOptions(options: DeepPartial<ChartOptions>): void {
		if (this._destroyed) {
			return;
		}
		checkMarkRenderer(options.markRenderer);
		const input = mergeOptions(this._settings.input, options);
		const keymap = options.accessibility?.keyBindings === undefined ? undefined : prepareChartKeymap(input);
		if (options.localization !== undefined || options.sessions !== undefined) {
			// Throws before anything changes.
			this._applyTime(resolveOptions(input, false));
		}
		this._settings.apply(input);
		if (keymap) this._accessibility.setKeymap(keymap);
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

	public addSeries<T extends SeriesType>(type: T, options?: SeriesCreateOptions<T>): SeriesApi<T>;
	public addSeries(type: 'heatmap', options?: MarkSeriesCreateOptions<HeatmapOptions, HeatmapData>): HeatmapSeriesApi;
	public addSeries(type: 'scatter', options?: MarkSeriesCreateOptions<ScatterOptions, ScatterData>): ScatterSeriesApi;
	public addSeries(
		type: SeriesType | MarkSeriesType,
		options: SeriesCreateOptions<SeriesType> | (Partial<AnyMarkOptions> & { id?: string }) = {},
	): SeriesApi | HeatmapSeriesApi | ScatterSeriesApi {
		if (isMarkType(type)) {
			const {
				id: markId,
				datafeed,
				timeline,
				...markOptions
			} = options as Partial<AnyMarkOptions> & {
				id?: string;
				datafeed?: MarksDatafeed<never>;
				timeline?: boolean | { interval?: number };
			};
			// Throws for options that cannot be drawn, before the series has a name.
			return this._marks.add(
				type,
				this._nameSeries(markId),
				markOptions,
				datafeed ?? null,
				timeline ?? false,
			) as unknown as HeatmapSeriesApi | ScatterSeriesApi;
		}
		const { datafeed, id, ...style } = options as SeriesCreateOptions<SeriesType>;
		const name = this._nameSeries(id);
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
		this.invalidate(INVALIDATE_LIGHT);
		return series as unknown as SeriesApi;
	}

	/** The name of a new series: `id` if it is free, or the next `series-N` without one. */
	private _nameSeries(id: unknown): string {
		const taken = (name: string): boolean =>
			this._seriesNamed(name) !== undefined || this._marks.named(name) !== undefined;
		if (id === undefined || id === '') {
			let name: string;
			do {
				name = `series-${++this._named}`;
			} while (taken(name));
			return name;
		}
		if (typeof id !== 'string') {
			throw new Error('lumen-charts: the id of a series must be a string');
		}
		if (taken(id)) {
			throw new Error(`lumen-charts: a series with id "${id}" exists already`);
		}
		return id;
	}

	public removeSeries(series: SeriesApi | MarkSeriesApi): void {
		// Indicators that read a heatmap or scatter go with it, as with any series.
		if (this._marks.remove(series)) {
			return;
		}
		const index = this._series.indexOf(series as unknown as Series);
		if (index < 0 || this._series[index]!.derived) {
			return;
		}
		this._indicators.removeReadersOf(this._series[index]!.engineId);
		// Its indicators' outputs were listed after it, so removing them left it in place.
		const removed = this._series.splice(index, 1)[0]!;
		this._primitives.detachSeries(removed);
		this._fetches.abort(removed);
		this._cache.removeSeries(removed.engineId);
		this._data.engine?.removeSeries(removed.engineId);
		this.invalidate(INVALIDATE_LIGHT);
	}

	/**
	 * The hidden line series a heatmap or scatter makes the bars of (see `MarkSeriesCreateOptions`):
	 * listed with the series like an indicator's output, which keeps it out of `series()`, saved
	 * state, readouts and the price scales, and drawn by nobody.
	 */
	private _addTimeline(): number {
		const engine = this._data.ensureEngine();
		const engineId = engine?.addSeries('line', false) ?? -1;
		const series = new Series(
			this,
			engineId,
			'line',
			{ visible: false, priceLineVisible: false, lastValueVisible: false },
			true,
			'',
		);
		this._series.push(series);
		return engineId;
	}

	private _removeTimeline(engineId: number): void {
		const index = this._series.findIndex(series => series.engineId === engineId);
		if (index < 0) {
			return;
		}
		const removed = this._series.splice(index, 1)[0]!;
		this._primitives.detachSeries(removed);
		this._cache.removeSeries(engineId);
		this._data.engine?.removeSeries(engineId);
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

	public markSeries(): (HeatmapSeriesApi | ScatterSeriesApi)[] {
		return [...this._marks.list] as unknown as (HeatmapSeriesApi | ScatterSeriesApi)[];
	}

	public indicators(): IndicatorApi[] {
		return [...this._indicators.list];
	}

	public timeScale(): TimeScaleApi {
		return this._timeScale;
	}

	public saveState(selection: ChartStateSelection = {}): ChartState {
		const state = this._stateIo.save(selection);
		if (state.series !== undefined) {
			state.series.push(...this._marks.save(state.series.length));
		}
		return state;
	}

	public restoreState(state: ChartState, selection: ChartStateSelection = {}): void {
		if (this._destroyed) {
			return;
		}
		// Heatmap and scatter series are restored by their own part: they are checked first, so a state
		// that is wrong anywhere still throws before anything changes.
		const listed: unknown = state?.series;
		const wanted = selection.parts === undefined || selection.parts.includes('series');
		if (!wanted || !Array.isArray(listed)) {
			this._stateIo.restore(state, selection);
			return;
		}
		const marks: { entry: Record<string, unknown>; index: number }[] = [];
		const others: unknown[] = [];
		const ids = new Set<string>();
		listed.forEach((entry: unknown, index) => {
			if (typeof entry === 'object' && entry !== null && isMarkType((entry as { type?: unknown }).type)) {
				marks.push({ entry: entry as Record<string, unknown>, index });
			} else {
				others.push(entry);
				const id = (entry as { id?: unknown } | null)?.id;
				if (typeof id === 'string') {
					ids.add(id);
				}
			}
		});
		this._markPlans = planMarkSeries(marks, ids);
		try {
			// Checks the rest of the state, then changes the chart in one batch, these series with it.
			this._stateIo.restore({ ...state, series: others as ChartState['series'] }, selection);
		} finally {
			this._markPlans = null;
		}
	}

	/** Runs `changes` with one invalidation at the end: while they run, they only note the level they need. */
	private _restoreBatch(changes: () => void): void {
		this._batching = true;
		this._batchLevel = INVALIDATE_LIGHT;
		try {
			const plans = this._markPlans;
			this._markPlans = null;
			if (plans !== null) {
				// Before the other series and the indicators, which may read them.
				this._marks.restore(plans);
			}
			changes();
		} finally {
			this._batching = false;
			this.invalidate(this._batchLevel);
		}
	}

	public priceScale(id: string = DEFAULT_PRICE_SCALE_ID): PriceScaleApi {
		return this._axes.get(id);
	}

	public removePriceScale(id: string): void {
		const input = this._settings.input;
		const scales = input.priceScales as Record<string, unknown> | undefined;
		if (this._destroyed || scales === undefined || !Object.prototype.hasOwnProperty.call(scales, id)) {
			return;
		}
		const kept = { ...scales };
		delete kept[id];
		this._settings.apply({ ...input, priceScales: kept as DeepPartial<ChartOptions>['priceScales'] });
		this._update();
	}

	public drawings(): DrawingsApi {
		return this._primitives.ensureDrawings();
	}

	public attachPrimitive(primitive: PanePrimitive): void {
		if (!this._destroyed) {
			this._primitives.attach(primitive);
		}
	}

	public detachPrimitive(primitive: PanePrimitive): void {
		this._primitives.layers.detach(primitive);
	}

	public attachSeriesPrimitive(series: Series, primitive: PanePrimitive): void {
		if (!this._destroyed && this._series.includes(series)) {
			this._primitives.attachToSeries(series, primitive);
		}
	}

	public detachSeriesPrimitive(series: Series, primitive: PanePrimitive): void {
		this._primitives.detachFromSeries(series, primitive);
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

	public subscribe(event: 'error', handler: (error: ChartError) => void): () => void;
	public subscribe(event: 'crosshairMove' | 'click', handler: (event: ChartPointerEvent) => void): () => void;
	public subscribe(
		event: 'error' | 'crosshairMove' | 'click',
		handler: ((error: ChartError) => void) | ((event: ChartPointerEvent) => void),
	): () => void {
		if (event === 'error') {
			return this._errors.add(handler as (error: ChartError) => void);
		}
		const unsubscribe = this._events.subscribePointer(event, handler as (event: ChartPointerEvent) => void);
		if (unsubscribe === null) {
			throw new Error(`lumen-charts: the chart has no event "${String(event)}"`);
		}
		return unsubscribe;
	}

	public setCrosshairPosition(time: number, price: number | null, scaleId: string = DEFAULT_PRICE_SCALE_ID): void {
		if (this._destroyed) {
			return;
		}
		// The keyboard navigator gives the crosshair up, as it does to the pointer.
		this._accessibility.pointerMoved();
		this._events.setCrosshairPosition(time, price, scaleId);
	}

	public clearCrosshairPosition(): void {
		if (this._destroyed) {
			return;
		}
		this._accessibility.pointerMoved();
		this._events.clearCrosshairPosition();
	}

	public destroy(): void {
		if (this._destroyed) {
			return;
		}
		this._destroyed = true;
		this._errors.clear();
		this._events.clear();
		this._accessibility.destroy();
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
		this._marks.destroy();
		this._primitives.destroy();
		this._layout.root.removeEventListener('contextrestored', this._onContextRestored, true);
		this._layout.release();
		this._layout.root.remove();
		this._settle();
	}

	// TimeScaleApi

	public fitContent(): void {
		this._data.afterData(() => {
			this._stateIo.viewSet();
			this.scale.fitContent();
		});
	}

	public scrollToRealTime(): void {
		this._data.afterData(() => {
			this._stateIo.viewSet();
			this.scale.scrollToRealTime();
		});
	}

	public setVisibleLogicalRange(range: LogicalRange): void {
		const { from, to } = range;
		this._data.afterData(() => {
			this._stateIo.viewSet();
			this.scale.setVisibleRange(from, to);
		});
	}

	public getVisibleLogicalRange(): LogicalRange | null {
		this._syncView();
		const scale = this.scale;
		return scale.isEmpty || scale.width <= 0 ? null : { from: scale.from, to: scale.to };
	}

	private _setVisibleRange(range: TimeRange): void {
		const { from, to } = range;
		if (!(Number.isFinite(from) && Number.isFinite(to) && to > from)) {
			return;
		}
		this._data.afterData(() => this._stateIo.showTimes(from, to));
	}

	/**
	 * The view primitives are drawn with, which maps what the last frame drew; null without bars or
	 * before the pane has a size.
	 */
	private _paneView(): PaneView | null {
		if (this.scale.isEmpty) {
			return null;
		}
		this._primitives.syncPaneView();
		const view = this._primitives.view;
		return view.width > 0 ? view : null;
	}

	private _timeToCoordinate(time: number): number | null {
		const view = this._paneView();
		if (view === null || time !== time) {
			return null;
		}
		this._times.active = true;
		const x = view.timeToX(time);
		if (x !== x) {
			// The engine is asked in the next frame; once the answer is in, the time has a place.
			this.invalidate(INVALIDATE_CURSOR);
			return null;
		}
		return x;
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
		this._accessibility.pointerMoved();
		this._events.pointerMoved();
		const crosshair = this._crosshair;
		crosshair.x = x;
		crosshair.y = y;
		crosshair.visible = visible;
		crosshair.source = 'pointer';
		crosshair.hoverDirty = true;
	}

	public clicksWanted(): boolean {
		return this._events.click.active;
	}

	public click(x: number, y: number): void {
		this._events.clicked(x, y);
	}

	public pointerDelegate(): PointerDelegate | null {
		if (this._primitives.drawings !== null) {
			// Presses land on what is on screen: the mapping of the last frame.
			this._primitives.syncPaneView();
		}
		return this._primitives.drawings;
	}

	public priceAxisAt(target: EventTarget | null): AxisTarget | null {
		return this._axes.at(target);
	}

	public scrollPrices(dy: number, y: number): void {
		this._axes.scrollBy(dy, y);
	}

	// PriceAxesHost and SeriesHost

	public priceScaleRemoved(axis: PriceAxis): void {
		this._primitives.forgetView(axis.id);
		this._overlayRenderer.forgetAxis(axis);
	}

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

	// Modules can request a redraw, or report data changes that are eligible for a partial redraw.
	private readonly _onInvalidate = (level: Invalidation): void => this.invalidate(level);
	private readonly _onDataChanged = (): void => this._schedule(INVALIDATE_LIGHT);

	/** Coalesces any number of changes into one draw per animation frame. */
	public invalidate(level: Invalidation): void {
		if (level >= INVALIDATE_LIGHT) {
			// Options, the view, the set of series, a primitive: anything on the series layer may differ.
			this._paneRenderer.stale = true;
		}
		this._schedule(level);
	}

	/**
	 * Asks for a frame at `level`. Called directly, a Light frame may keep the series layer and redraw
	 * the columns of changed items only: for data that changed, which the frame checks against what
	 * the layer shows (see `PaneRenderer._dirtyColumns`).
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

	private _seriesNamed(id: string): Series | undefined {
		for (const series of this._series) {
			if (!series.derived && series.id === id) {
				return series;
			}
		}
		return undefined;
	}

	// Errors

	/** An error of the engine or its worker goes to the handlers, or else to the page. */
	private _failed(kind: 'engine' | 'worker', message: string, cause: unknown): void {
		if (this._errors.active) {
			const error: ChartError = { kind, message };
			if (cause !== undefined) {
				error.cause = cause;
			}
			this._errors.emit(error);
		} else if (kind === 'engine' && cause instanceof Error) {
			// The engine ran on this thread: what it threw, with its stack.
			report(cause);
		} else {
			report(new Error(`lumen-charts: ${message}`, { cause }));
		}
	}

	/** Refused rows go to the handlers only: a feed may send them routinely. */
	private _refused(id: number, count: number): void {
		if (!this._errors.active) {
			return;
		}
		const series =
			this._series.find(entry => entry.engineId === id) ?? this._marks.list.find(entry => entry.engineId === id);
		const name = series === undefined ? 'a series the chart no longer has' : `series "${series.id}"`;
		const error: ChartError = {
			kind: 'refused',
			message: `The data engine refused ${count} ${count === 1 ? 'update' : 'updates'} of ${name}: a time out of order, or between two bars, or a removal or correction of marks whose history the datafeed did not return.`,
			count,
		};
		if (series !== undefined) {
			error.seriesId = series.id;
		}
		this._errors.emit(error);
	}

	// Waiting for the chart

	private readonly _onDataSettled = (): void => {
		this._settle();
		this._settleApplied();
	};

	private _isApplied(): boolean {
		const engine = this._data.engine;
		return (
			this._destroyed ||
			engine === null ||
			(engine.pending === 0 &&
				this._indicators.computing === 0 &&
				this._fetches.fetching === 0 &&
				this._marks.fetching === 0)
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
				this._marks.fetching === 0 &&
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
		const rendererChanged = next.markRenderer !== this._settings.options.markRenderer;
		this._settings.options = next;
		if (rendererChanged) this._marks.preferenceChanged();
		this._applyResolved(next);
		this._data.setMemoryLimit(next.memoryLimit);
		this.invalidate(INVALIDATE_FULL);
	}

	/** Pushes resolved options into the parts that keep their own copy. */
	private _applyResolved(options: ChartOptions): void {
		this._layout.root.style.backgroundColor = options.layout.background;
		this._accessibility.apply(options.accessibility);
		this._axes.sync(options);
		this._paneRenderer.applyOptions(options);
		this._layout.timeAxis.setVisible(options.timeScale.visible);
		this._primitives.applyOptions(options);
		this._layout.font = '';
		this._model.resetTicks();
		this._axes.resetFit();
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
		const drawn = this._model.drawn;
		if (this._time.apply(options) && drawn !== null) {
			this._time.cover(drawn.time, drawn.count, 2 ** drawn.shift);
		}
	}

	private readonly _onScheme = (): void => {
		if (!this._destroyed) {
			this._update();
		}
	};

	// What the page tells the chart

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
		this._primitives.layers.normal.changed = true;
		this._marks.forget();
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

	// Frame

	/** Sizes the canvases to the layout, at the device pixel ratio of the window. */
	private _placeLayers(): void {
		// A canvas that changes size is cleared, and the pixel ratio and fonts may differ.
		this._paneRenderer.stale = true;
		this._overlayRenderer.stale = true;
		const layout = this._layout;
		layout.placePanes();
		if (this._primitives.placeLayer(layout.pixelRatio)) {
			this._paneRenderer.stale = true;
		}
		layout.placeOverlay();
		this._axisRenderer.reset();
	}

	/**
	 * Finds the price scales in use: those of the series and indicator outputs (shown or hidden), of
	 * heatmaps and scatters, and of primitives and drawings. Those no option lists and nothing uses go;
	 * those the options list take room only while in use. When an axis or a pane appeared or went,
	 * the pane takes the room left, and the same bars stay in view.
	 */
	private _sweepScales(): void {
		const axes = this._axes;
		axes.beginSweep();
		const series = this._series;
		for (let i = 0; i < series.length; i++) {
			axes.markUsed(axes.of(series[i]!));
		}
		const marks = this._marks.list;
		for (let i = 0; i < marks.length; i++) {
			axes.markUsed(axes.get(marks[i]!.scaleId));
		}
		this._primitives.markScales(axes);
		if (axes.endSweep()) {
			const scale = this.scale;
			const from = scale.from;
			const to = scale.to;
			const width = this._layout.paneWidth;
			this._layout.compute();
			if (this._layout.paneWidth !== width) {
				scale.setVisibleRange(from, to);
			}
		}
	}

	/** Write phase of a frame: sizes the canvases and draws whatever the invalidation level asks for. */
	public frameWrite(now: number): void {
		const layout = this._layout;
		const primitives = this._primitives;
		const pane = this._paneRenderer;
		if (primitives.placement && primitives.placeLayer(layout.pixelRatio)) {
			pane.stale = true;
		}
		let level = this._level;
		this._level = INVALIDATE_NONE;
		if (level < INVALIDATE_LIGHT && primitives.merged && primitives.layers.normal.changed) {
			// Merged into the series layer, drawings are drawn with the series.
			level = INVALIDATE_LIGHT;
		}
		if (primitives.merged && primitives.layers.normal.changed) {
			// Also when the last merged drawing went away.
			pane.stale = true;
		}
		const animating = this._interaction.step(now);
		if (level >= INVALIDATE_LIGHT) {
			// Price lines and value labels follow the series: the overlay compares them, or draws
			// everything again after a change of options.
			this._overlayRenderer.changed = true;
			if (level === INVALIDATE_FULL) this._overlayRenderer.stale = true;
		}
		if (level === INVALIDATE_FULL || layout.font === '') {
			this._placeLayers();
		}
		if (level >= INVALIDATE_LIGHT) {
			this._sweepScales();
			this._model.update();
			if (this._axes.fitWidths(this.scale.isEmpty)) {
				// The axis takes its width from the pane. The same bars stay visible, slightly narrower.
				const scale = this.scale;
				const from = scale.from;
				const to = scale.to;
				layout.compute();
				scale.setVisibleRange(from, to);
				this._model.update();
			}
			if (layout.dirty) {
				this._placeLayers();
			}
			this._accessibility.frame();
			if (layout.paneWidth > 0 && layout.paneHeight > 0) {
				pane.render();
				this._axisRenderer.render();
			} else {
				// The changed items of this frame are not drawn, and the next frame will not know them.
				pane.stale = true;
			}
		}
		// On its bar in the view just computed, before drawings are hovered and the overlay drawn.
		this._events.place();
		if (layout.paneWidth > 0 && layout.paneHeight > 0) {
			if (primitives.drawings !== null) {
				// Tools place points with the view of this frame, also before the first drawing exists.
				const moved = primitives.sync();
				if (primitives.layer !== null && primitives.layers.normal.changed) {
					primitives.render();
				}
				const crosshair = this._crosshair;
				if (primitives.drawings !== null && (crosshair.hoverDirty || moved)) {
					crosshair.hoverDirty = false;
					primitives.drawings.hover(crosshair.x, crosshair.y, crosshair.visible);
				}
			}
			this._overlayRenderer.render();
		}
		primitives.applyCursor();
		this._times.flush(this._data.engine);
		this._cache.clearDirty();
		if (animating) {
			this.invalidate(INVALIDATE_LIGHT);
		}
		// Last, so handlers see this frame on screen; what they change goes into the next one.
		this._events.deliver();
		this._settle();
	}
}

/** A number, or null for NaN and infinities. */
function finite(value: number): number | null {
	return Number.isFinite(value) ? value : null;
}

/** Creates a chart inside `container`. */
export function createChart(container: HTMLElement, options: DeepPartial<ChartOptions> = {}): ChartApi {
	return new Chart(container, options);
}
