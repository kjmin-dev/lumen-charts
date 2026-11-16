import type { ChartApi, LogicalRange, TimeScaleApi } from './api';
import type { EngineClient, IndicatorInfo } from '@lumen-charts/engine';
import { DataFlow } from './data/data-flow';
import { DatafeedFetches } from './data/datafeed';
import { WindowCache } from './data/window-cache';
import { PanePrimitives } from './drawings/pane-primitives';
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
import { Crosshair } from './model/crosshair';
import { FrameModel } from './model/frame-model';
import type { SessionInfo } from './model/sessions';
import { TimeDisplay } from './model/time-display';
import { TimeIndex } from './model/time-index';
import { TimeScale } from './model/time-scale';
import {
	type CandlestickOptions,
	type ChartOptions,
	DEFAULT_PRICE_SCALE_ID,
	type DeepPartial,
	type LineOptions,
	type PriceScaleOptions,
	mergeOptions,
	optionsEqual,
	resolveOptions,
	shallowEqual,
} from './options';
import { type PriceAxis, PriceAxes, type PriceAxisHost, type PriceScaleApi } from './price-axes';
import type { PanePrimitive } from './primitives';
import { AxisRenderer } from './render/axes';
import { ChartLayout } from './render/layout';
import { OverlayRenderer } from './render/overlay';
import { PaneRenderer } from './render/pane';
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
import { type FrameClient, cancelFrame, requestFrame } from './shared/frame';
import { watchPixelRatio } from './shared/media';
import { observeVisibility, unobserveVisibility } from './shared/observers';

class Chart implements ChartApi, InteractionHost, TimeScaleApi, FrameClient, PriceAxisHost {
	public readonly scale: TimeScale;
	/** Whether the chart waits for the shared animation frame (see `FrameClient`). */
	public frameQueued = false;
	/** The root element, its canvases, and the sizes of the chart, the pane and the axes. */
	private readonly _layout: ChartLayout;
	private readonly _interaction: Interaction;
	/** The price scales with their axes. */
	private readonly _axes: PriceAxes;
	/** What the frame draws: the rows in view, their place, and the ticks. */
	private readonly _model: FrameModel;
	/** Time zone, sessions and label formats. */
	private readonly _time = new TimeDisplay();
	private readonly _cache = new WindowCache();
	private readonly _series: Series[] = [];

	private readonly _settings: ChartSettings;

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

	private readonly _crosshair = new Crosshair();
	/** The primitives and drawings of the pane, and their layer. */
	private readonly _primitives: PanePrimitives;
	/** What draws the series layer, the axes and the overlay. */
	private readonly _paneRenderer: PaneRenderer;
	private readonly _axisRenderer: AxisRenderer;
	private readonly _overlayRenderer: OverlayRenderer;
	/** Logical positions of times, for anchors stored as times. */
	private readonly _times = new TimeIndex();

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
			seriesRemoved: series => this._primitives.detachSeries(series),
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
					this._paneRenderer.stale = true;
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
			level => this.invalidate(level),
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
		this._times.listener = () => {
			this._resolveView();
			this._primitives.changed('normal');
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
		this._primitives.detachSeries(removed);
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
			state.drawings = this._primitives.drawings?.toJSON() ?? [];
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
		if (plan.drawings !== null && (plan.drawings.length > 0 || this._primitives.drawings !== null)) {
			this._primitives.ensureDrawings().restore(plan.drawings);
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
			const coarse = this._model.coarseWindow();
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
		this._primitives.destroy();
		this._layout.root.removeEventListener('contextrestored', this._onContextRestored, true);
		this._layout.release();
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
		this._crosshair.x = x;
		this._crosshair.y = y;
		this._crosshair.visible = visible;
		this._crosshair.hoverDirty = true;
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
			this._paneRenderer.stale = true;
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
		this._paneRenderer.applyOptions(options);
		this._layout.timeAxis.setVisible(options.timeScale.visible);
		this._primitives.applyOptions(options);
		this._layout.font = '';
		this._model.resetTicks();
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
		this._primitives.layers.normal.changed = true;
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
		this._paneRenderer.stale = true;
		const layout = this._layout;
		layout.placePanes();
		if (this._primitives.placeLayer(layout.pixelRatio)) {
			this._paneRenderer.stale = true;
		}
		layout.placeOverlay();
		this._axisRenderer.reset();
	}

	// Frame

	/** Write phase of a frame: sizes the canvases and draws whatever the invalidation level asks for. */
	public frameWrite(now: number): void {
		if (this._primitives.placement && this._primitives.placeLayer(this._layout.pixelRatio)) {
			this._paneRenderer.stale = true;
		}
		let level = this._level;
		this._level = INVALIDATE_NONE;
		if (level < INVALIDATE_LIGHT && this._primitives.merged && this._primitives.layers.normal.changed) {
			// Merged into the series layer, drawings are drawn with the series.
			level = INVALIDATE_LIGHT;
		}
		if (this._primitives.merged && this._primitives.layers.normal.changed) {
			// Also when the last merged drawing went away.
			this._paneRenderer.stale = true;
		}
		const animating = this._interaction.step(now);
		if (level === INVALIDATE_FULL || this._layout.font === '') {
			this._placeLayers();
		}
		if (level >= INVALIDATE_LIGHT) {
			this._model.update();
			if (this._axes.fitWidths(this.scale.isEmpty)) {
				// The axis takes its width from the pane. The same bars stay visible, slightly narrower.
				const scale = this.scale;
				const from = scale.from;
				const to = scale.to;
				this._layout.compute();
				scale.setVisibleRange(from, to);
				this._model.update();
			}
			if (this._layout.dirty) {
				this._placeLayers();
			}
			if (this._layout.paneWidth > 0 && this._layout.paneHeight > 0) {
				this._paneRenderer.render();
				this._axisRenderer.render();
			} else {
				// The changed items of this frame are not drawn, and the next frame will not know them.
				this._paneRenderer.stale = true;
			}
		}
		if (this._layout.paneWidth > 0 && this._layout.paneHeight > 0) {
			if (this._primitives.drawings !== null) {
				// Tools place points with the view of this frame, also before the first drawing exists.
				const moved = this._primitives.sync();
				if (this._primitives.layer !== null && this._primitives.layers.normal.changed) {
					this._primitives.render();
				}
				if (this._primitives.drawings !== null && (this._crosshair.hoverDirty || moved)) {
					this._crosshair.hoverDirty = false;
					this._primitives.drawings.hover(this._crosshair.x, this._crosshair.y, this._crosshair.visible);
				}
			}
			this._overlayRenderer.render();
		}
		this._primitives.applyCursor();
		this._times.flush(this._data.engine);
		this._cache.clearDirty();
		if (animating) {
			this.invalidate(INVALIDATE_LIGHT);
		}
		this._settle();
	}
}

/** Creates a chart inside `container`. */
export function createChart(container: HTMLElement, options: DeepPartial<ChartOptions> = {}): ChartApi {
	return new Chart(container, options);
}
