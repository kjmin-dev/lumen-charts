import type { DataFlow } from '../data/data-flow';
import type { LevelWindow, WindowCache } from '../data/window-cache';
import type { HistogramOptions } from '../options';
import type { PriceAxes, PriceAxis } from '../price-axes';
import type { ChartLayout } from '../render/layout';
import type { Series } from '../series';
import type { ChartSettings } from '../settings';
import { type Geometry, placeElements } from '../views/series-view';
import type { TimeDisplay } from './time-display';
import type { TimeIndex } from './time-index';
import type { TimeScale } from './time-scale';
import { TimeTicks } from './time-ticks';

/**
 * What a frame draws, computed from the time scale and the window cache: the rows in view and
 * where they are, the items of the series, the ranges and ticks of the price scales, and the time
 * ticks. A frame at the Light level or above brings it up to date, and the layers are drawn from it.
 */
export class FrameModel {
	/** Where the rows in view are drawn, in device pixels. */
	public readonly geometry: Geometry = { origin: 0, spacing: 1, from: 0, to: 0, shift: 0, firstRow: 0 };
	/** Window the series were drawn from in the last update. */
	public drawn: LevelWindow | null = null;
	public readonly timeTicks = new TimeTicks();
	/** Device-pixel positions of vertical grid lines and time axis labels. */
	public tickXs = new Float32Array(64);
	/**
	 * Takes more than the series into the ranges of the price scales, for the logical positions in
	 * view: called between collecting the series' ranges and fitting the scales (primitives that take
	 * part in autoscale, see `PanePrimitives.includeRanges`).
	 */
	public ranges: ((from: number, to: number) => void) | null = null;
	/** A counter that changes when the time ticks are computed again. */
	public ticksGeneration = 0;
	/** Takes part in the update between the series and the fitting of the price scales, when set. */
	public marks: { frame(): void } | null = null;
	/** What the time ticks were last computed for. */
	private _ticksScale = -1;
	private _ticksCache = -1;
	private _ticksFrom = 0;
	private _ticksTo = 0;
	private readonly _settings: ChartSettings;
	private readonly _layout: ChartLayout;
	private readonly _scale: TimeScale;
	private readonly _cache: WindowCache;
	private readonly _series: readonly Series[];
	private readonly _axes: PriceAxes;
	/** Time zone, sessions and label formats. */
	private readonly _time: TimeDisplay;
	private readonly _times: TimeIndex;
	private readonly _data: DataFlow;

	public constructor(
		settings: ChartSettings,
		layout: ChartLayout,
		scale: TimeScale,
		cache: WindowCache,
		series: readonly Series[],
		axes: PriceAxes,
		time: TimeDisplay,
		times: TimeIndex,
		data: DataFlow,
	) {
		this._settings = settings;
		this._layout = layout;
		this._scale = scale;
		this._cache = cache;
		this._series = series;
		this._axes = axes;
		this._time = time;
		this._times = times;
		this._data = data;
	}

	/** Has the time ticks computed again by the next update: their labels may differ. */
	public resetTicks(): void {
		this._ticksScale = -1;
	}

	/** Brings scales, items and ticks up to date with the time scale and the window cache. */
	public update(): void {
		const scale = this._scale;
		const cache = this._cache;
		const ratio = this._layout.pixelRatio;
		this._data.requestWindow(ratio);

		const geometry = this.geometry;
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
		this.drawn = source;
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
		// Heatmap and scatter series: their mapping of times, their rows, their part in the autoscale.
		this.marks?.frame();

		if (this.ranges !== null && source !== null) {
			this.ranges(scale.from, scale.to);
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

		const fontSize = this._settings.options.layout.fontSize;
		this._axes.updateTicks(Math.max(32, fontSize * 3.5), ratio);

		// Time ticks depend only on which bars are visible and how far apart they are.
		const timeTicks = this.timeTicks;
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
			this.ticksGeneration++;
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
		if (this.tickXs.length < timeTicks.count) {
			this.tickXs = new Float32Array(timeTicks.count * 2);
		}
		const tickStart = source === null ? 0 : source.start;
		for (let i = 0; i < timeTicks.count; i++) {
			const index = Math.max((tickStart + timeTicks.position[i]!) * size, scale.first);
			this.tickXs[i] = Math.round(geometry.origin + index * geometry.spacing);
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

	/** A window of buckets that answers for times the raw rows do not hold. */
	public coarseWindow(): LevelWindow | null {
		const drawn = this.drawn;
		return drawn !== null && drawn.level > 0 ? drawn : this._cache.held(1);
	}
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
