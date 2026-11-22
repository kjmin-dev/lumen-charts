import type { PanePrimitives } from './drawings/pane-primitives';
import { type ChartIndicators, type Indicator, outputSeriesDefaults } from './indicators';
import type { FrameModel } from './model/frame-model';
import { INVALIDATE_CURSOR, INVALIDATE_LIGHT, type Invalidation } from './model/invalidation';
import { TimeDisplay } from './model/time-display';
import type { TimeIndex } from './model/time-index';
import type { TimeScale } from './model/time-scale';
import { type ChartOptions, type DeepPartial, mergeOptions, resolveOptions, shallowEqual } from './options';
import type { PriceAxes } from './price-axes';
import { Series, type SeriesApi, type SeriesCreateOptions, type SeriesType } from './series';
import type { ChartSettings } from './settings';
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

import type { HeatmapSeriesApi, ScatterSeriesApi } from './marks/series';

/** What saving and restoring a state needs from the chart. */
export interface StateHost {
	addSeries<T extends SeriesType>(type: T, options?: SeriesCreateOptions<T>): SeriesApi<T>;
	removeSeries(series: SeriesApi): void;
	/** The series with this id that is not the output of an indicator. */
	seriesNamed(id: string): Series | undefined;
	/** The heatmap or scatter series with this id. */
	markNamed(id: string): ScatterSeriesApi | HeatmapSeriesApi | undefined;
	/** The heatmap and scatter series a state's indicators may read, by id (see `RestoreContext.markKinds`). */
	markKinds(): ReadonlyMap<string, 'heatmap' | 'scatter'>;
	/** Takes `input` in place of the options applied so far. */
	replaceOptions(input: DeepPartial<ChartOptions>): void;
	/** Runs `changes` with one invalidation at the end, whatever they change. */
	batch(changes: () => void): void;
	/** Brings the pane size and the view up to date, before the view is read. */
	syncView(): void;
	invalidate(level: Invalidation): void;
}

/**
 * Saves the state of a chart and restores one: options, series, indicators, drawings and the view.
 * The view of a state is a range of times, which a chart without the bars around them cannot show
 * yet: it is kept until the timeline can place the times.
 */
export class StateIo {
	/** Times a restored view shows, until the timeline can place them (see `resolveView`). */
	private _pendingView: { from: number; to: number } | null = null;
	private readonly _host: StateHost;
	private readonly _settings: ChartSettings;
	private readonly _scale: TimeScale;
	private readonly _series: Series[];
	private readonly _indicators: ChartIndicators;
	private readonly _axes: PriceAxes;
	private readonly _model: FrameModel;
	private readonly _times: TimeIndex;
	private readonly _primitives: PanePrimitives;

	public constructor(
		host: StateHost,
		settings: ChartSettings,
		scale: TimeScale,
		series: Series[],
		indicators: ChartIndicators,
		axes: PriceAxes,
		model: FrameModel,
		times: TimeIndex,
		primitives: PanePrimitives,
	) {
		this._host = host;
		this._settings = settings;
		this._scale = scale;
		this._series = series;
		this._indicators = indicators;
		this._axes = axes;
		this._model = model;
		this._times = times;
		this._primitives = primitives;
	}

	/** The state of the chart as plain JSON (see `ChartApi.saveState`). */
	public save(selection: ChartStateSelection = {}): ChartState {
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

	/** Makes the chart what a state says, or throws before anything changes (see `ChartApi.restoreState`). */
	public restore(state: ChartState, selection: ChartStateSelection = {}): void {
		// Everything that can refuse the state comes before the first change.
		const plan = planRestore(state, selection.parts, {
			definition: name => this._indicators.definition(name),
			seriesIds: () => this._series.filter(series => !series.derived).map(series => series.id),
			markKinds: () => this._host.markKinds(),
			outputDefaults: outputSeriesDefaults,
		});
		let input: DeepPartial<ChartOptions> | null = null;
		if (plan.options !== null) {
			input = this._restoredInput(plan.options);
			// Throws a RangeError for an unknown time zone or locale, or a malformed session schedule.
			new TimeDisplay().apply(resolveOptions(input, false));
		}
		this._host.batch(() => this._restore(plan, input));
	}

	private _restore(plan: RestorePlan, input: DeepPartial<ChartOptions> | null): void {
		if (input !== null) {
			this._host.replaceOptions(input);
		}
		const order = new Map<Series | Indicator, number>();
		if (plan.series !== null) {
			this._restoreSeries(plan.series, order);
		}
		if (plan.indicators !== null) {
			const restored = this._indicators.restore(
				plan.indicators,
				id => this._host.seriesNamed(id),
				id => this._host.markNamed(id),
			);
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
			this.resolveView();
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
				this._host.removeSeries(series);
			}
		}
		for (const plan of plans) {
			let series = this._host.seriesNamed(plan.id);
			if (series === undefined) {
				this._host.addSeries(plan.type, { ...plan.options, id: plan.id } as SeriesCreateOptions<SeriesType>);
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
			if (owner === undefined && series.derived) {
				// The timeline a heatmap or scatter makes, which the series makes again.
				continue;
			}
			if (owner === undefined) {
				units.push(series);
			} else if (!listed.has(owner)) {
				listed.add(owner);
				units.push(owner);
			}
		}
		return units;
	}

	/**
	 * The view as a state holds it. Times are whole milliseconds, so a view saved, restored and saved
	 * again gives the same numbers.
	 */
	private _saveView(): ViewState {
		this._host.syncView();
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
		const scale = this._scale;
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
	public viewSet(): void {
		if (!this._scale.isEmpty) {
			this._pendingView = null;
		}
	}

	/** Shows the times `from` to `to` as soon as the timeline can place them, as a restored view. */
	public showTimes(from: number, to: number): void {
		this._pendingView = { from, to };
		this.resolveView();
	}

	/**
	 * Shows the times of a restored view as soon as the timeline can place them: at once when the
	 * bars around them are held, otherwise when the engine's answer is in, or when there are bars.
	 */
	public resolveView(): void {
		const view = this._pendingView;
		const scale = this._scale;
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
			this._host.invalidate(INVALIDATE_CURSOR);
			return;
		}
		this._pendingView = null;
		scale.setVisibleRange(from, to);
		this._host.invalidate(INVALIDATE_LIGHT);
	}
}
