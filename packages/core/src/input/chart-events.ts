import type { ChartPointerEvent, LogicalRange, SeriesValue } from '../api';
import type { ChartIndicators } from '../indicators';
import type { Crosshair } from '../model/crosshair';
import type { FrameModel } from '../model/frame-model';
import { INVALIDATE_CURSOR, type Invalidation } from '../model/invalidation';
import type { TimeIndex } from '../model/time-index';
import type { TimeScale } from '../model/time-scale';
import type { PriceAxes } from '../price-axes';
import type { Series, TimeRange } from '../series';
import { Listeners } from '../shared/listeners';

/** The values of an event without any; never changed. */
const NO_VALUES: ReadonlyMap<string, SeriesValue> = new Map();

/**
 * Smallest change of a visible range that is reported, in bars and in milliseconds. A range that one
 * chart reports and another shows comes back with rounding errors; without a floor, two charts that
 * sync their ranges could echo them to each other in every frame.
 */
const LOGICAL_EPSILON = 1e-6;
const TIME_EPSILON = 1e-3;

/** Whether two numbers are the same, NaN included. */
function same(a: number, b: number): boolean {
	return a === b || (a !== a && b !== b);
}

/** Whether two numbers are within `epsilon` of each other, or both NaN. */
function near(a: number, b: number, epsilon: number): boolean {
	return Math.abs(a - b) <= epsilon || (a !== a && b !== b);
}

/** Adds the value of `series` in row `row` of the window drawn, if it has one there. */
function addValue(values: Map<string, SeriesValue>, key: string, series: Series, row: number): void {
	const close = series.close[row];
	if (close === undefined || close !== close) {
		return;
	}
	values.set(
		key,
		series.type === 'candlestick'
			? { open: series.open[row]!, high: series.high[row]!, low: series.low[row]!, close }
			: { value: close },
	);
}

/**
 * The events of the chart and its time scale, and the crosshair the application places.
 *
 * Events are delivered at the end of a frame, once it has drawn, so a handler sees what is on
 * screen and the conversions answer for it; many changes within a frame give one event. What an
 * event carries is built only while someone listens: without listeners, a frame costs a few
 * comparisons and allocates nothing.
 */
export class ChartEvents {
	public readonly crosshairMove = new Listeners<ChartPointerEvent>();
	public readonly click = new Listeners<ChartPointerEvent>();
	public readonly logicalRange = new Listeners<LogicalRange | null>();
	public readonly timeRange = new Listeners<TimeRange | null>();

	/** The crosshair the application placed, while it holds: a time, a price (NaN for none) and a scale. */
	private _anchored = false;
	private _anchorTime = NaN;
	private _anchorPrice = NaN;
	private _anchorScale = '';
	/** The crosshair as the last frame left it: position, visibility and the bar under it. */
	private _crosshairX = NaN;
	private _crosshairY = NaN;
	private _crosshairVisible = false;
	private _crosshairIndex = NaN;
	/** A click waiting for the end of the frame, in CSS pixels in the pane. */
	private _clicked = false;
	private _clickX = 0;
	private _clickY = 0;
	/** The visible ranges as last reported; NaN for none. */
	private _logicalFrom = NaN;
	private _logicalTo = NaN;
	private _timeFrom = NaN;
	private _timeTo = NaN;
	/** The times at the edges of the pane, as `_measureTimes` found them. */
	private _measuredFrom = NaN;
	private _measuredTo = NaN;

	private readonly _scale: TimeScale;
	private readonly _crosshair: Crosshair;
	private readonly _model: FrameModel;
	private readonly _series: readonly Series[];
	private readonly _indicators: ChartIndicators;
	private readonly _times: TimeIndex;
	private readonly _axes: PriceAxes;
	private readonly _invalidate: (level: Invalidation) => void;

	public constructor(
		scale: TimeScale,
		crosshair: Crosshair,
		model: FrameModel,
		series: readonly Series[],
		indicators: ChartIndicators,
		times: TimeIndex,
		axes: PriceAxes,
		invalidate: (level: Invalidation) => void,
	) {
		this._scale = scale;
		this._crosshair = crosshair;
		this._model = model;
		this._series = series;
		this._indicators = indicators;
		this._times = times;
		this._axes = axes;
		this._invalidate = invalidate;
	}

	/** Adds a handler of `crosshairMove` or `click`; null for another event. */
	public subscribePointer(event: string, handler: (event: ChartPointerEvent) => void): (() => void) | null {
		if (event === 'crosshairMove') {
			return this.crosshairMove.add(handler);
		}
		if (event === 'click') {
			return this.click.add(handler);
		}
		return null;
	}

	/** Adds a handler of a change of the visible range; null for another event. */
	public subscribeRange(event: string, handler: (range: LogicalRange | null) => void): (() => void) | null {
		if (event === 'visibleLogicalRangeChange') {
			return this.logicalRange.add(handler);
		}
		if (event === 'visibleTimeRangeChange') {
			if (!this.timeRange.active) {
				// Not followed without listeners: what is on screen now is what was reported.
				this._measureTimes();
				this._timeFrom = this._measuredFrom;
				this._timeTo = this._measuredTo;
			}
			return this.timeRange.add(handler);
		}
		return null;
	}

	public clear(): void {
		this.crosshairMove.clear();
		this.click.clear();
		this.logicalRange.clear();
		this.timeRange.clear();
	}

	/** The times at the edges of the pane, or null without bars or where the rows are not held. */
	public visibleTimes(): TimeRange | null {
		this._measureTimes();
		const from = this._measuredFrom;
		const to = this._measuredTo;
		return from === from && to === to ? { from, to } : null;
	}

	// The crosshair of the application

	public setCrosshairPosition(time: number, price: number | null, scaleId: string): void {
		this._anchored = true;
		this._anchorTime = time;
		this._anchorPrice = price ?? NaN;
		this._anchorScale = scaleId;
		// A time beyond the bars held is placed with the ends of the timeline, which are then kept known.
		this._times.active = true;
		this._crosshair.source = 'api';
		this._invalidate(INVALIDATE_CURSOR);
	}

	public clearCrosshairPosition(): void {
		this._anchored = false;
		const crosshair = this._crosshair;
		if (crosshair.visible) {
			crosshair.visible = false;
			crosshair.hoverDirty = true;
		}
		crosshair.source = 'api';
		this._invalidate(INVALIDATE_CURSOR);
	}

	/** The pointer moved the crosshair: one the application placed gives way. */
	public pointerMoved(): void {
		this._anchored = false;
	}

	/** Times may map to other positions: a crosshair placed by time is placed again. */
	public timelineChanged(): void {
		if (this._anchored) {
			this._invalidate(INVALIDATE_CURSOR);
		}
	}

	/**
	 * Puts the crosshair the application placed on its bar and price in the view of this frame, so
	 * it stays there as the view moves. A time the engine is asked about hides it until the answer is
	 * in, which `timelineChanged` reports.
	 */
	public place(): void {
		const crosshair = this._crosshair;
		if (!this._anchored) {
			return;
		}
		if (crosshair.source === 'keyboard') {
			// The keyboard navigator moved it since: it has it now.
			this._anchored = false;
			return;
		}
		const scale = this._scale;
		let visible = false;
		let x = crosshair.x;
		let y = crosshair.y;
		if (!scale.isEmpty) {
			// The bar at or before the time; the last bar for a later time, none for an earlier one.
			const index = Math.min(scale.end - 1, Math.floor(this._times.lookup(this._anchorTime)));
			if (index >= scale.first) {
				visible = true;
				x = scale.indexToX(index);
				const price = this._anchorPrice;
				// Without a scale of that id there is no price to place: looking makes none.
				y = price === price ? (this._axes.find(this._anchorScale)?.priceToCoordinate(price) ?? NaN) : NaN;
			}
		}
		if (visible !== crosshair.visible || (visible && (x !== crosshair.x || !same(y, crosshair.y)))) {
			crosshair.hoverDirty = true;
		}
		crosshair.x = x;
		crosshair.y = y;
		crosshair.visible = visible;
		crosshair.source = 'api';
	}

	// Pointer events

	/** A click in the pane: reported at the end of the next frame. */
	public clicked(x: number, y: number): void {
		this._clicked = true;
		this._clickX = x;
		this._clickY = y;
		this._invalidate(INVALIDATE_CURSOR);
	}

	/** Delivers what changed in this frame: the visible ranges, the crosshair, a click. */
	public deliver(): void {
		const scale = this._scale;
		const empty = scale.isEmpty || scale.width <= 0;
		const from = empty ? NaN : scale.from;
		const to = empty ? NaN : scale.to;
		if (!near(from, this._logicalFrom, LOGICAL_EPSILON) || !near(to, this._logicalTo, LOGICAL_EPSILON)) {
			this._logicalFrom = from;
			this._logicalTo = to;
			if (this.logicalRange.active) {
				this.logicalRange.emit(empty ? null : { from, to });
			}
		}
		if (this.timeRange.active) {
			this._measureTimes();
			const timeFrom = this._measuredFrom;
			const timeTo = this._measuredTo;
			// With bars, an edge without a time waits for its rows, which are on their way.
			const known = empty || (timeFrom === timeFrom && timeTo === timeTo);
			if (known && (!near(timeFrom, this._timeFrom, TIME_EPSILON) || !near(timeTo, this._timeTo, TIME_EPSILON))) {
				this._timeFrom = timeFrom;
				this._timeTo = timeTo;
				this.timeRange.emit(timeFrom === timeFrom && timeTo === timeTo ? { from: timeFrom, to: timeTo } : null);
			}
		}

		const crosshair = this._crosshair;
		const visible = crosshair.visible;
		const index = visible && !scale.isEmpty ? Math.round(scale.xToLogical(crosshair.x)) : NaN;
		if (
			visible !== this._crosshairVisible ||
			(visible &&
				(!same(crosshair.x, this._crosshairX) ||
					!same(crosshair.y, this._crosshairY) ||
					!same(index, this._crosshairIndex)))
		) {
			this._crosshairVisible = visible;
			this._crosshairX = crosshair.x;
			this._crosshairY = crosshair.y;
			this._crosshairIndex = index;
			if (this.crosshairMove.active) {
				this.crosshairMove.emit(this._event(crosshair.source, crosshair.x, crosshair.y, visible));
			}
		}

		if (this._clicked) {
			this._clicked = false;
			if (this.click.active) {
				this.click.emit(this._event('pointer', this._clickX, this._clickY, true));
			}
		}
	}

	/** What an event at `(x, y)` carries, from the rows this frame drew. */
	private _event(source: ChartPointerEvent['source'], x: number, y: number, visible: boolean): ChartPointerEvent {
		if (!visible) {
			return { source, point: null, logical: null, time: null, values: NO_VALUES };
		}
		const point = { x, y };
		const scale = this._scale;
		if (scale.isEmpty) {
			return { source, point, logical: null, time: null, values: NO_VALUES };
		}
		const index = Math.round(scale.xToLogical(x));
		const drawn = this._model.drawn;
		const row = drawn === null ? -1 : Math.floor(index / 2 ** drawn.shift) - drawn.start;
		if (drawn === null || index < scale.first || index >= scale.end || row < 0 || row >= drawn.count) {
			return { source, point, logical: index, time: null, values: NO_VALUES };
		}
		const time = drawn.time[row]!;
		const values = new Map<string, SeriesValue>();
		for (const series of this._series) {
			if (!series.derived) {
				addValue(values, series.id, series, row);
			}
		}
		for (const indicator of this._indicators.list) {
			for (const output of indicator.outputList) {
				addValue(values, `${indicator.id}.${output.name}`, output.series, row);
			}
		}
		return { source, point, logical: index, time: time === time ? time : null, values };
	}

	/** Finds the times at the edges of the pane, without allocating. */
	private _measureTimes(): void {
		const scale = this._scale;
		if (scale.isEmpty || scale.width <= 0) {
			this._measuredFrom = NaN;
			this._measuredTo = NaN;
			return;
		}
		const coarse = this._model.coarseWindow();
		this._measuredFrom = this._times.estimateTime(scale.from, coarse);
		this._measuredTo = this._times.estimateTime(scale.to, coarse);
	}
}
