import type { MarkRenderer } from './backend';
import type { EngineClient, MarksTimeline, MarksUpdate } from '@lumen-charts/engine';
import type { PanePrimitives } from '../drawings/pane-primitives';
import type { FrameModel } from '../model/frame-model';
import type { TimeScale } from '../model/time-scale';
import type { PriceAxes, PriceAxis } from '../price-axes';
import type { ChartLayout } from '../render/layout';
import type { AnyMarkOptions, HeatmapOptions, MarkSeriesType, ScatterOptions } from './options';
import { HeatmapSeries, type MarkSeries, type MarkSeriesHost, ScatterSeries, checkOptions } from './series';
import type { MarkSeriesPlan, MarkSeriesState } from './state';
import { type MarksDatafeed, MarkFetches } from './fetches';
import { TimeMap } from './time-map';

/** What the marks need from the chart. */
export interface ChartMarksHost {
	markRenderer(): MarkRenderer;
	/** The data engine, created with the first series; null once the chart is destroyed. */
	ensureEngine(): EngineClient | null;
	/** Anything on the layers may differ: the frame draws them in full. */
	invalidate(): void;
	/** Data changed and nothing else: the frame fits the scales again and keeps what it can of the layers. */
	dataChanged(): void;
	/** A datafeed request ended: whoever waits for the chart to be idle may have nothing left to wait for. */
	settled(): void;
	/**
	 * Adds a line series that draws nothing and is listed nowhere, whose bars a mark series makes:
	 * the timeline of a chart without bars of its own. Returns its engine id.
	 */
	addTimeline(): number;
	removeTimeline(engineId: number): void;
}

/**
 * The heatmap and scatter series of a chart: series whose marks are not bars on the main timeline
 * and are drawn through a pixel buffer. This part owns them, hands the rows the data engine sends
 * to their windows, gives each frame the mapping of times they are drawn with, asks for the rows a
 * view needs, and takes their prices into the autoscale of their price scales.
 *
 * A heatmap is drawn into the series layer below the series, a scatter into the drawings layer
 * above them (below the drawings), each as a primitive of the pane.
 */
export class ChartMarks implements MarkSeriesHost {
	public readonly list: MarkSeries[] = [];
	public readonly map = new TimeMap();
	public mapVersion = 0;
	private readonly _host: ChartMarksHost;
	private readonly _layout: ChartLayout;
	private readonly _scale: TimeScale;
	private readonly _axes: PriceAxes;
	private readonly _primitives: PanePrimitives;
	private readonly _model: FrameModel;
	private _engine: EngineClient | null = null;
	private readonly _byEngineId = new Map<number, MarkSeries>();
	/** What the time map was last set from. */
	private readonly _mapKey = new Float64Array(7).fill(Number.NaN);
	private readonly _extent = { low: 0, high: 0 };
	private _destroyed = false;
	/** Marks fetched again from the datafeeds of series. */
	private readonly _fetches: MarkFetches;

	public constructor(
		host: ChartMarksHost,
		layout: ChartLayout,
		scale: TimeScale,
		axes: PriceAxes,
		primitives: PanePrimitives,
		model: FrameModel,
	) {
		this._host = host;
		this._layout = layout;
		this._scale = scale;
		this._axes = axes;
		this._primitives = primitives;
		this._model = model;
		this._fetches = new MarkFetches(
			() => this._engine,
			id => this._byEngineId.get(id),
			() => host.settled(),
		);
	}

	/** Datafeed requests in flight. */
	public get fetching(): number {
		return this._fetches.fetching;
	}

	public abortFetches(series: MarkSeries): void {
		this._fetches.abort(series);
	}

	// The series

	public add(
		type: MarkSeriesType,
		id: string,
		options: Partial<AnyMarkOptions>,
		datafeed: MarksDatafeed<never> | null = null,
		timeline: boolean | { interval?: number } = false,
	): MarkSeries {
		let link: MarksTimeline | null = null;
		if (timeline !== false) {
			const interval = timeline === true ? undefined : timeline.interval;
			const step = interval ?? (type === 'heatmap' ? 0 : DEFAULT_INTERVAL);
			if (!(step >= 0) || !Number.isFinite(step) || (type === 'scatter' && step === 0)) {
				throw new RangeError(
					`lumen-charts: the timeline of a ${type} needs an interval in milliseconds above 0${type === 'heatmap' ? ', or 0 for a bar per column' : ''}`,
				);
			}
			link = { series: this._host.addTimeline(), interval: step };
		}
		const series =
			type === 'heatmap'
				? new HeatmapSeries(this, id, options as Partial<HeatmapOptions>, datafeed, link)
				: new ScatterSeries(this, id, options as Partial<ScatterOptions>, datafeed, link);
		this.list.push(series);
		this._byEngineId.set(series.engineId, series);
		this._attach(series);
		this._host.invalidate();
		return series;
	}

	public remove(series: unknown): boolean {
		const index = this.list.indexOf(series as MarkSeries);
		if (index < 0) {
			return false;
		}
		const removed = this.list.splice(index, 1)[0]!;
		this._byEngineId.delete(removed.engineId);
		this._fetches.abort(removed);
		this._primitives.layers.detach(removed.primitive);
		removed.release();
		this._engine?.changeMarks(removed.engineId, { op: 'remove' });
		if (removed.timeline !== null) {
			this._host.removeTimeline(removed.timeline.series);
		}
		this._host.invalidate();
		return true;
	}

	public named(id: string): MarkSeries | undefined {
		return this.list.find(series => series.id === id);
	}

	private _attach(series: MarkSeries): void {
		const primitives = this._primitives;
		if (series.primitive.zOrder !== 'bottom') {
			// The drawings layer is drawn once the chart has its drawings part.
			primitives.ensureDrawings();
		}
		series.attachedScale = series.scaleId;
		primitives.layers.attach(series.primitive, primitives.viewFor(series.scaleId), series);
	}

	public destroy(): void {
		this._destroyed = true;
		this._fetches.destroy();
		for (const series of this.list) {
			series.release();
		}
		this.list.length = 0;
		this._byEngineId.clear();
		this._engine = null;
	}

	/** The pictures the series hold are gone with their canvases: every one is drawn again. */
	public forget(): void {
		for (const series of this.list) {
			series.forget();
		}
	}

	public preferenceChanged(): void {
		for (const series of this.list) series.preferenceChanged();
	}

	public markRenderer(): MarkRenderer {
		return this._host.markRenderer();
	}

	// MarkSeriesHost

	public engine(): EngineClient | null {
		if (this._engine === null && !this._destroyed) {
			const engine = this._host.ensureEngine();
			if (engine !== null) {
				this._engine = engine;
				engine.onmarks = this._onMarks;
				engine.onmarksfetch = event => this._fetches.handle(event);
			}
		}
		return this._engine;
	}

	private readonly _onMarks = (updates: MarksUpdate[]): void => {
		for (const update of updates) {
			this._byEngineId.get(update.series)?.receive(update);
		}
	};

	public optionsChanged(): void {
		this._host.invalidate();
	}

	public rowsChanged(): void {
		this._host.dataChanged();
	}

	public scaleChanged(series: MarkSeries): void {
		if (series.attachedScale !== series.scaleId && this.list.includes(series)) {
			this._primitives.layers.detach(series.primitive);
			this._attach(series);
		}
	}

	public axisOf(series: MarkSeries): PriceAxis {
		return this._axes.get(series.scaleId);
	}

	public paneWidth(): number {
		return this._layout.pane.width;
	}

	public paneHeight(): number {
		return this._layout.pane.height;
	}

	public pixelRatio(): number {
		return this._layout.pixelRatio;
	}

	public document(): Document {
		return this._layout.root.ownerDocument;
	}

	/** Asks the engine for the rows the view of `series` needs, unless its window has or awaits them. */
	public request(series: MarkSeries): void {
		const engine = this.engine();
		if (engine === null || !(series.viewTo >= series.viewFrom)) {
			// Before the first frame: that frame asks.
			this._host.dataChanged();
			return;
		}
		const now = performance.now();
		const request = series.window.plan(
			series.viewFrom,
			series.viewTo,
			series.viewStep,
			series.viewPriceStep,
			series.limit,
			series.margin,
			now,
		);
		if (request !== null) {
			series.window.sent(engine.requestMarks(series.engineId, request), now);
		}
	}

	// The frame

	/**
	 * Called by the model update of a frame, after the bars in view are known and before the price
	 * scales are fitted: sets the mapping of times from the bars the frame draws, asks for the rows
	 * each series needs for the view, and takes their prices into the range of their scales.
	 */
	public frame(): void {
		const list = this.list;
		if (list.length === 0) {
			return;
		}
		const geometry = this._model.geometry;
		const drawn = this._model.drawn;
		const scale = this._scale;
		const map = this.map;
		const key = this._mapKey;
		const version = drawn === null ? -1 : drawn.version;
		const count = drawn === null ? 0 : drawn.count;
		const start = drawn === null ? 0 : drawn.start;
		if (
			key[0] !== version ||
			key[1] !== count ||
			key[2] !== start ||
			key[3] !== geometry.shift ||
			key[4] !== scale.first ||
			key[5] !== geometry.origin ||
			key[6] !== geometry.spacing
		) {
			key[0] = version;
			key[1] = count;
			key[2] = start;
			key[3] = geometry.shift;
			key[4] = scale.first;
			key[5] = geometry.origin;
			key[6] = geometry.spacing;
			if (drawn === null) {
				map.set(EMPTY, 0, 0, 0, 0, 0, 0, 1);
			} else {
				map.set(drawn.time, 0, count, start, drawn.shift, scale.first, geometry.origin, geometry.spacing);
			}
			this.mapVersion++;
			// Scatter series are on the drawings layer, which is drawn again when something of it changed.
			this._primitives.layers.normal.changed = true;
		}
		const width = this._layout.pane.width;
		const ratio = this._layout.pixelRatio;
		const extent = this._extent;
		let fallback = false;
		for (let i = 0; i < list.length; i++) {
			const series = list[i]!;
			const options = series.seriesOptions;
			if (!options.visible || map.count === 0 || width <= 0) {
				continue;
			}
			const axis = this._axes.get(series.scaleId);
			axis.count++;
			const reach = series.reach(ratio);
			series.viewFrom = map.time(-reach);
			series.viewTo = map.time(width + reach);
			series.viewStep = (series.viewTo - series.viewFrom) / (width + 2 * reach);
			// As of the last frame: a level whose price bins are taller than a pixel shows them.
			const priceScale = axis.scale;
			series.viewPriceStep =
				priceScale.hasRange && priceScale.mode === 'normal' ? 1 / Math.abs(priceScale.scale * ratio) : 0;
			this.request(series);
			if (options.autoscale) {
				series.extent(extent);
				include(axis, extent.low, extent.high);
			} else {
				fallback = true;
			}
		}
		if (fallback) {
			// A series that does not autoscale follows the others of its scale; where there is none to
			// follow, the scale would have no range, and the series is fitted after all.
			for (let i = 0; i < list.length; i++) {
				const series = list[i]!;
				const options = series.seriesOptions;
				if (!options.visible || options.autoscale || map.count === 0 || width <= 0) {
					continue;
				}
				const axis = this._axes.get(series.scaleId);
				if (!(axis.low <= axis.high) && !axis.scale.hasRange) {
					series.extent(extent);
					include(axis, extent.low, extent.high);
				}
			}
		}
	}

	// Saved state

	/** The series as a state holds them, with `order` counted on from `first`. */
	public save(first: number): MarkSeriesState[] {
		return this.list.map((series, i) => ({
			id: series.id,
			type: series.type,
			options: { ...series.seriesOptions },
			pane: 0,
			order: first + i,
		}));
	}

	/** Removes the series a checked plan does not keep: those it does not name, or names as another type. */
	public drop(plans: readonly MarkSeriesPlan[]): void {
		const wanted = new Map(plans.map(plan => [plan.id, plan]));
		for (const series of this.list.slice()) {
			if (wanted.get(series.id)?.type !== series.type) {
				this.remove(series);
			}
		}
	}

	/** Makes the series those of a checked plan: kept by id and type, added, or removed. */
	public restore(plans: readonly MarkSeriesPlan[]): void {
		this.drop(plans);
		const ordered: MarkSeries[] = [];
		const sorted = plans.slice();
		sorted.sort((a, b) => a.order - b.order);
		for (const plan of sorted) {
			let series = this.named(plan.id);
			if (series === undefined) {
				series = this.add(plan.type, plan.id, plan.options);
			} else {
				series.setOptions(plan.options, checkOptions(plan.options));
			}
			ordered.push(series);
		}
		// Drawn in the order of the state, within their layers.
		for (const series of ordered) {
			this._primitives.layers.detach(series.primitive);
		}
		this.list.length = 0;
		for (const series of ordered) {
			this.list.push(series);
			this._attach(series);
		}
	}
}

const EMPTY = new Float64Array(0);

/** Bars of a scatter's timeline, without an interval of its own: a minute. */
const DEFAULT_INTERVAL = 60_000;

/** Takes the prices `[low, high]` into the range an axis collects, in the values of its scale. */
function include(axis: PriceAxis, low: number, high: number): void {
	if (!(low <= high)) {
		return;
	}
	const scale = axis.scale;
	const mode = scale.mode;
	if (mode === 'normal') {
		axis.include(low, high);
	} else if (mode === 'logarithmic') {
		if (high > 0) {
			axis.include(low > 0 ? Math.log10(low) : Number.NaN, Math.log10(high));
		}
	} else {
		const base = scale.base;
		if (base === base && base !== 0) {
			axis.include(scale.toValue(low, base), scale.toValue(high, base));
		}
	}
}
