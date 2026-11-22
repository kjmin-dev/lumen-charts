import type { IndicatorInfo } from '@lumen-charts/engine';
import type { DrawingsApi } from './drawings/types';
import type { IndicatorApi, IndicatorOptions, IndicatorOutputApi } from './indicators';
import type { SessionInfo } from './model/sessions';
import type { ChartOptions, DeepPartial } from './options';
import type { PriceScaleApi } from './price-axes';
import type { PanePrimitive } from './primitives';
import type { SeriesApi, SeriesCreateOptions, SeriesType, TimeRange } from './series';
import type { HeatmapOptions, ScatterOptions } from './marks/options';
import type { MarksDatafeed } from './marks/fetches';
import type { HeatmapData, ScatterData } from './marks/input';
import type { HeatmapSeriesApi, MarkSeriesApi, ScatterSeriesApi } from './marks/series';
import type { ChartState, ChartStateSelection } from './state';

/** A range of logical positions: bar `i` covers `[i - 0.5, i + 0.5)`. */
/**
 * Options `addSeries` takes for a heatmap or a scatter: the series options, its name in saved state,
 * a datafeed to fetch its marks from again, which lets the engine let them go under the chart's
 * `memoryLimit`, and whether its marks make the timeline of a chart without bars.
 */
export type MarkSeriesCreateOptions<O, D> = Partial<O> & {
	id?: string;
	datafeed?: MarksDatafeed<D>;
	/**
	 * The marks make the bars of the time axis, for a chart without a series of bars: one bar per
	 * `interval` milliseconds that holds marks (a minute by default for a scatter), or for a heatmap
	 * one per column (`true`, or an interval of 0). Like a datafeed, it is not saved with the state.
	 * Where the chart also has a series of bars, the series that got data first gives the timeline.
	 */
	timeline?: boolean | { interval?: number };
};

export interface LogicalRange {
	from: number;
	to: number;
}

/**
 * Controls the visible part of the timeline. Data is applied asynchronously by the engine, so a
 * call made after `setData` or `update` takes effect once that data has arrived.
 *
 * Coordinates are CSS pixels from the left edge of the pane. The conversions map what is on screen:
 * the view of the last frame drawn, which is current in the handlers of the chart's events. They
 * return null while the chart has no bars, and where there is no answer.
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
	 * Shows the times `from` to `to` (UTC milliseconds) across the pane: at once when the bars around
	 * them are held, otherwise once the data engine has placed them, or once there are bars.
	 */
	setVisibleRange(range: TimeRange): void;
	/**
	 * The times (UTC milliseconds) at the left and right edge of the pane: between bars and beyond
	 * the ends as the timeline places times there. Null without bars, and where the rows at an edge
	 * are not held.
	 */
	getVisibleRange(): TimeRange | null;
	/**
	 * x of a time (UTC milliseconds): of its bar, between two bars for a time between theirs, beyond
	 * the ends at the spacing of the bars there. A time far from the bars held is asked of the data
	 * engine: null until the answer is in, which takes a frame or two.
	 */
	timeToCoordinate(time: number): number | null;
	/** The time at x: of a bar, between bars, or beyond the ends. Null where the rows are not held. */
	coordinateToTime(x: number): number | null;
	/** x of a logical position (bar `i` is centered on `i`). */
	logicalToCoordinate(logical: number): number | null;
	/** The logical position at x, with fractions between bars. */
	coordinateToLogical(x: number): number | null;
	/**
	 * Calls `handler` once per frame in which the visible range changed (a pan, a zoom, a resize, a
	 * new bar while following the last one), with the range or null without bars; returns a
	 * function that stops it.
	 */
	subscribe(event: 'visibleLogicalRangeChange', handler: (range: LogicalRange | null) => void): () => void;
	/**
	 * As `visibleLogicalRangeChange`, with the range of `getVisibleRange`. While the rows at an edge
	 * are on their way, it waits for them rather than report null.
	 */
	subscribe(event: 'visibleTimeRangeChange', handler: (range: TimeRange | null) => void): () => void;
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

/**
 * Something that went wrong outside a call of the application, reported to `subscribe('error')`.
 *
 * - `engine`: the data engine threw while running a command. The command changed nothing the chart
 *   relies on, and the chart goes on. `message` is what was thrown; `cause` is the value thrown when
 *   the engine runs on this thread (from a worker only the text arrives).
 * - `worker`: the worker of the data engine failed after it started. The data it held is gone and
 *   the chart does not start another: it keeps drawing what it holds, takes no more data, and
 *   whoever waits for it (`whenIdle`, `whenApplied`) is no longer kept waiting. `cause` is the event
 *   the worker fired. Every chart on the worker gets one.
 * - `refused`: the engine did not apply `count` bars or points of the series `seriesId`: a time out
 *   of order, or between two bars that exist. This can be routine for a live feed, so it is never
 *   reported unless someone subscribed.
 */
export interface ChartError {
	kind: 'engine' | 'worker' | 'refused';
	message: string;
	/** The series of a `refused` error; absent when the engine names a series the chart no longer has. */
	seriesId?: string;
	/** Bars or points refused, for `refused`. */
	count?: number;
	cause?: unknown;
}

/**
 * What a series shows at the crosshair or a click: its bar for a candlestick series, its value for a
 * line or a histogram (and an indicator output).
 */
export type SeriesValue = { open: number; high: number; low: number; close: number } | { value: number };

/** The crosshair or a click, as `crosshairMove` and `click` report them. */
export interface ChartPointerEvent {
	/**
	 * What moved the crosshair: the pointer, the keyboard navigator, or `setCrosshairPosition` and
	 * `clearCrosshairPosition` (so code that syncs charts can ignore its own echoes). A click is
	 * always `pointer`.
	 */
	source: 'pointer' | 'keyboard' | 'api';
	/**
	 * CSS pixels from the pane's top left corner; null once the crosshair is hidden. `y` is NaN for
	 * a crosshair set without a price.
	 */
	point: { x: number; y: number } | null;
	/** The bar index at `point.x`, also beyond the bars; null without bars or a point. */
	logical: number | null;
	/** Time of the bar at `logical` (UTC milliseconds); null outside the bars and where none is held. */
	time: number | null;
	/**
	 * The value of every series with a value at `logical`, by series id; an indicator's outputs as
	 * `<indicator id>.<output name>`. Zoomed out so far that bars are merged into buckets, `time` and
	 * the values are those of the bucket drawn there: its first time, and its open, high, low and
	 * close (a line's value is the bucket's last).
	 */
	values: ReadonlyMap<string, SeriesValue>;
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
	 * Adds a heatmap: columns of cells on a grid of prices, drawn below the other series. Its marks
	 * are placed by time on the timeline of the bars, so the chart needs a series with bars. `id`
	 * names it in saved state, like any series; with a `datafeed`, the engine may let its marks go
	 * under the chart's `memoryLimit` and fetch them back when the view needs them.
	 */
	addSeries(type: 'heatmap', options?: MarkSeriesCreateOptions<HeatmapOptions, HeatmapData>): HeatmapSeriesApi;
	/** Adds a scatter series: points at any time and price, drawn above the other series. */
	addSeries(type: 'scatter', options?: MarkSeriesCreateOptions<ScatterOptions, ScatterData>): ScatterSeriesApi;
	/**
	 * Removes a series, and every indicator that reads it.
	 */
	removeSeries(series: SeriesApi | MarkSeriesApi): void;
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
	 * The series of the chart in the order they are drawn, without the outputs of indicators and
	 * without heatmap and scatter series (see `markSeries`).
	 */
	series(): SeriesApi[];
	/** The heatmap and scatter series of the chart, in the order they were added. */
	markSeries(): (HeatmapSeriesApi | ScatterSeriesApi)[];
	/** The indicators of the chart in the order they were added. */
	indicators(): IndicatorApi[];
	/**
	 * Loads a module of custom indicators into the data engine (in the worker, or on this thread
	 * without one) and resolves with what it registered. The module exports indicator definitions:
	 * a default export or an `indicators` export holding one or an array (see `defineIndicator`). It
	 * is imported by URL, so it must be a standalone ES module the page's content security policy
	 * allows (`script-src`), resolved against the document's base URL.
	 */
	registerIndicators(url: string | URL): Promise<readonly IndicatorInfo[]>;
	timeScale(): TimeScaleApi;
	/** The drawings of the chart: add, edit and remove them, start tools, listen to their events. */
	drawings(): DrawingsApi;
	/**
	 * Attaches a primitive drawn on the price pane with the main price scale (see `PanePrimitive`).
	 * Attaching one twice does nothing.
	 */
	attachPrimitive(primitive: PanePrimitive): void;
	detachPrimitive(primitive: PanePrimitive): void;
	/**
	 * The price scale with this id: by default the default scale (`default`), which
	 * `ChartOptions.priceScale` configures. An id no option or series has named yet gets an overlay
	 * scale, which goes again with the next frame if nothing is put on it (see `removePriceScale`);
	 * the handle stays valid either way.
	 */
	priceScale(id?: string): PriceScaleApi;
	/**
	 * Removes the scale `id` from `ChartOptions.priceScales`: its options go, and with them its range
	 * if it did not autoscale. Series, indicator outputs, heatmaps, scatters, primitives and drawings
	 * still on it stay there, on an overlay with default options; the scale itself goes with the
	 * first frame nothing is on it, as any scale the options do not list does. Handles of it stay
	 * valid (see `PriceScaleApi`). The default scale cannot be removed, and an id the options do not
	 * list is ignored.
	 */
	removePriceScale(id: string): void;
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
	/**
	 * Calls `handler` with every `ChartError`; returns a function that stops it. Without a handler,
	 * `engine` and `worker` errors are reported as uncaught errors of the page, and `refused` ones
	 * are not reported at all.
	 */
	subscribe(event: 'error', handler: (error: ChartError) => void): () => void;
	/**
	 * Calls `handler` once per frame in which the crosshair moved on screen, moved onto another bar,
	 * appeared or was hidden, after the frame was drawn. What the event carries is built only while
	 * someone listens.
	 */
	subscribe(event: 'crosshairMove', handler: (event: ChartPointerEvent) => void): () => void;
	/**
	 * Calls `handler` for a press and release of the primary button, or a tap, in the pane that did
	 * not move (a drag pans instead) and that no drawing took: not one that selects or moves a
	 * drawing, or places a point of a drawing tool.
	 */
	subscribe(event: 'click', handler: (event: ChartPointerEvent) => void): () => void;
	/**
	 * Puts the crosshair on the bar at or before `time` (UTC milliseconds), the last bar for a later
	 * time, and hides it for a time before the first bar. With a price, the horizontal line sits at
	 * that price on the price scale `scaleId` (the default scale). It follows its bar and price as the
	 * view moves, until the pointer moves the crosshair or `clearCrosshairPosition` hides it. For
	 * charts that show each other's crosshair: the `crosshairMove` it causes says `api`.
	 */
	setCrosshairPosition(time: number, price: number | null, scaleId?: string): void;
	/** Hides the crosshair, until the pointer moves it again. */
	clearCrosshairPosition(): void;
	/**
	 * The state of the chart as plain JSON: what was configured, without bars. It holds the options
	 * applied (not the size, `worker`, `memoryLimit`, `markRenderer`, accessibility settings or formatter functions), the series and indicators
	 * with their ids and options, the drawings, and the view: the times at the edges of the pane and
	 * the range of every price scale that does not autoscale. Reads only; nothing is drawn for it.
	 */
	saveState(selection?: ChartStateSelection): ChartState;
	/**
	 * Makes the chart what a state says, in one frame. The state is checked first, all of it, and a
	 * state that is wrong anywhere (another `version`, a value of the wrong kind, an indicator the
	 * chart does not know, a reference to a series that would not be there) throws before anything
	 * changes.
	 *
	 * - Options replace those applied before; the size, `worker`, `memoryLimit`, `markRenderer`, accessibility settings and the formatter
	 *   functions of `localization` stay as they are.
	 * - Series are matched by `id` and type: one the chart has keeps its bars, datafeed, renderer and
	 *   primitives and takes the state's options; one it lacks is added without bars (find it with
	 *   `series()`, or `markSeries()` for a heatmap or a scatter, and hand it data); one the state
	 *   lacks is removed.
	 * - Indicators are found by name, so custom ones must be registered first. They are kept as far
	 *   as both lists start with the same ones, and the others are computed again.
	 * - Drawings are replaced, with a `removed` and a `created` event each.
	 * - The view goes back to the same times whatever history is loaded: at once when the bars around
	 *   them are at hand, otherwise once the data engine has placed them, or once there are bars.
	 *
	 * A state need not have every section, and `selection.parts` restores some of those it has; the
	 * rest of the chart stays as it is.
	 */
	restoreState(state: ChartState, selection?: ChartStateSelection): void;
	/** Removes the chart from the DOM and releases its resources. */
	destroy(): void;
}
