import type { IndicatorInfo } from '@lumen-charts/engine';
import type { DrawingsApi } from './drawings/types';
import type { IndicatorApi, IndicatorOptions, IndicatorOutputApi } from './indicators';
import type { SessionInfo } from './model/sessions';
import type { ChartOptions, DeepPartial } from './options';
import type { PriceScaleApi } from './price-axes';
import type { PanePrimitive } from './primitives';
import type { SeriesApi, SeriesCreateOptions, SeriesType } from './series';
import type { HeatmapOptions, ScatterOptions } from './marks/options';
import type { HeatmapSeriesApi, MarkSeriesApi, ScatterSeriesApi } from './marks/series';
import type { ChartState, ChartStateSelection } from './state';

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
	 * Adds a heatmap: columns of cells on a grid of prices, drawn below the other series. Its marks
	 * are placed by time on the timeline of the bars, so the chart needs a series with bars. `id`
	 * names it in saved state, like any series.
	 */
	addSeries(type: 'heatmap', options?: Partial<HeatmapOptions> & { id?: string }): HeatmapSeriesApi;
	/** Adds a scatter series: points at any time and price, drawn above the other series. */
	addSeries(type: 'scatter', options?: Partial<ScatterOptions> & { id?: string }): ScatterSeriesApi;
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
	/**
	 * The state of the chart as plain JSON: what was configured, without bars. It holds the options
	 * applied (not the size, `worker`, `memoryLimit` or formatter functions), the series and indicators
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
	 * - Options replace those applied before; the size, `worker`, `memoryLimit` and the formatter
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
