import type { EngineClient, SeriesKind } from '@lumen-charts/engine';
import {
	type LineColumns,
	type LinePoint,
	type OhlcBar,
	type OhlcColumns,
	type Packed,
	packCandles,
	packLine,
} from './data/input';
import type { IndicatorApi, IndicatorOptions } from './indicators';
import { INVALIDATE_LIGHT, type Invalidation } from './model/invalidation';
import type { PriceScale } from './model/price-scale';
import {
	type CandlestickOptions,
	DEFAULT_CANDLESTICK_OPTIONS,
	DEFAULT_HISTOGRAM_OPTIONS,
	DEFAULT_LINE_OPTIONS,
	type DeepPartial,
	type HistogramOptions,
	type LineOptions,
	definedOnly,
	shallowEqual,
} from './options';
import type { PriceAxis, PriceScaleApi } from './price-axes';
import { SeriesView } from './views/series-view';

/** Bars the chart asks a datafeed for: the ones with times in `[from, to]`, which it held before. */
export interface DatafeedRequest {
	/** Time of the first bar, UTC milliseconds (inclusive). */
	from: number;
	/** Time of the last bar, UTC milliseconds (inclusive). */
	to: number;
	/** Number of bars in `[from, to]`. */
	countBack: number;
	/**
	 * Aborted when the bars are no longer needed: the view moved away from them before they came,
	 * the history was replaced (`setData`, for example at another resolution), or the series was
	 * removed or the chart destroyed. Pass it on to `fetch` to cancel the request; whatever a
	 * request resolves to after its signal was aborted is ignored.
	 */
	signal: AbortSignal;
}

/**
 * A source the chart can fetch history from again, modeled on the pull side of TradingView's
 * datafeed contract. With a datafeed and the chart's `memoryLimit`, the data engine may let go of
 * bars far from the view and ask for them when they are needed. Requests for the same bars are
 * never in flight twice; a failed request is tried again the next time the bars are needed (or
 * right away, when a correction or a deletion waits for them), after a pause that grows with every
 * failure (1 s up to 30 s).
 *
 * The bars a datafeed returns are the source of truth for the bars it covers: values that changed
 * at the source while the chart had let the bars go are taken over as corrections, and the levels
 * of detail are rebuilt from them. Bars added or removed at the source in the middle of history do
 * not match the bars the chart let go and are refused; tell the chart about them with
 * `SeriesApi.removeBars` or a new `setData`.
 */
export interface Datafeed<T extends SeriesType = SeriesType> {
	/**
	 * Resolves to the bars with times in `[request.from, request.to]`, oldest first, in any format
	 * `setData` accepts (bars outside the range are ignored). They must be the bars the chart has
	 * there, as many and with the same times: bars that differ in number or time are refused with a
	 * console warning, and the chart keeps drawing a coarser level of detail there.
	 */
	getBars(request: DatafeedRequest): Promise<SeriesTypes[SeriesType & T]['data']>;
}

/** Options `addSeries` takes: the series options, and a datafeed to fetch its history from again. */
export type SeriesCreateOptions<T extends SeriesType> = Partial<SeriesTypes[T]['options']> & {
	datafeed?: Datafeed<T>;
};

/** Options of `SeriesApi.setData`. */
export interface SetDataOptions<T extends SeriesType = SeriesType> {
	/**
	 * The datafeed the new history is fetched back from, or null for none (then nothing of it is let
	 * go). Pass it when the new history comes from another source, as when switching resolution or
	 * symbol with a datafeed that serves one; leave it out to keep the current datafeed.
	 */
	datafeed?: Datafeed<T> | null;
}

/** Bars with times in `[from, to]`, UTC milliseconds, both inclusive. */
export interface TimeRange {
	from: number;
	to: number;
}

/** What each series type takes: its options, one update, and a whole history. */
export interface SeriesTypes {
	candlestick: { options: CandlestickOptions; bar: OhlcBar; data: readonly OhlcBar[] | OhlcColumns };
	line: { options: LineOptions; bar: LinePoint; data: readonly LinePoint[] | LineColumns };
	histogram: { options: HistogramOptions; bar: LinePoint; data: readonly LinePoint[] | LineColumns };
}

export type SeriesType = keyof SeriesTypes;

/** Options of any series type. */
export type AnySeriesOptions = CandlestickOptions | LineOptions | HistogramOptions;

export interface SeriesApi<T extends SeriesType = SeriesType> {
	readonly type: T;
	/**
	 * Replaces the history. Times are UTC milliseconds and must be strictly increasing. This is also
	 * how to switch resolution (1 minute to 5 minutes, say) or symbol: datafeed requests still out for
	 * the old history are aborted and their answers ignored, and the levels of detail are rebuilt.
	 * For the series whose timeline the chart shows (the first one with data), every index then
	 * means another bar, as after the first `setData`.
	 */
	setData(data: SeriesTypes[T]['data'], options?: SetDataOptions<T>): void;
	/**
	 * Updates the bar with this time, or appends a new bar if the time is later than the last one.
	 * An older bar is corrected in place, and the levels of detail are rebuilt from all the bars they
	 * summarize. When the memory limit has let that bar go, the correction is applied once the bars it
	 * needs are fetched back from the datafeed, which happens at once; other updates do not wait for
	 * it. A time between two existing bars is refused: bars cannot be inserted in the middle.
	 */
	update(bar: SeriesTypes[T]['bar']): void;
	/** Adds older history before the first bar. Indexes of existing bars do not change. */
	prepend(data: SeriesTypes[T]['data']): void;
	/**
	 * Removes the bars with times in `range`. Removing bars at either end leaves the indexes of the
	 * other bars as they are. Removing bars in the middle closes the gap: the bars on one side move
	 * over, so for the series whose timeline the chart shows, the indexes of those bars change
	 * (logical ranges set before refer to other bars afterwards). When that needs bars the memory limit
	 * let go, they are fetched back first, and later calls on this series wait for it.
	 */
	removeBars(range: TimeRange): void;
	applyOptions(options: Partial<SeriesTypes[T]['options']>): void;
	options(): Readonly<SeriesTypes[T]['options']>;
	/**
	 * Adds an indicator computed from this series in the data engine, drawn on the price pane. See
	 * `ChartApi.addIndicator`.
	 */
	addIndicator(name: string, options?: DeepPartial<IndicatorOptions>): IndicatorApi;
	/** The price scale the series is drawn on (see the `priceScaleId` option). */
	priceScale(): PriceScaleApi;
	/**
	 * Where a price of this series is drawn, in CSS pixels from the top of the pane, as of the last
	 * frame; on a percentage or indexed scale, relative to this series' first visible bar. Null before
	 * the scale has a range, and for a price the scale cannot show (zero or below on a logarithmic
	 * scale) or a series with no bar in view on a percentage or indexed scale.
	 */
	priceToCoordinate(price: number): number | null;
	/** The price drawn at a coordinate: the inverse of `priceToCoordinate`. */
	coordinateToPrice(y: number): number | null;
}

export interface SeriesHost {
	engine(): EngineClient | null;
	invalidate(level: Invalidation): void;
	addIndicator(source: Series, name: string, options?: DeepPartial<IndicatorOptions>): IndicatorApi;
	/** The series got a new history with the command `seq`: requests for the old one are obsolete. */
	reloaded(series: Series, seq: number): void;
	/** The price scale the series is on, following its `priceScaleId`. */
	priceAxisOf(series: Series): PriceAxis;
}

/** Equal, NaN included. */
function sameNumber(a: number, b: number): boolean {
	return a === b || (a !== a && b !== b);
}

function defaultOptions(type: SeriesType): AnySeriesOptions {
	return type === 'candlestick'
		? DEFAULT_CANDLESTICK_OPTIONS
		: type === 'histogram'
			? DEFAULT_HISTOGRAM_OPTIONS
			: DEFAULT_LINE_OPTIONS;
}

const EMPTY: Float64Array = new Float64Array(0);

export class Series implements SeriesApi {
	public readonly type: SeriesType;
	public readonly kind: SeriesKind;
	public readonly id: number;
	public readonly view = new SeriesView();
	public seriesOptions: AnySeriesOptions;
	/** True for an indicator output: its values come from the engine, not from the application. */
	public readonly derived: boolean;

	/** Columns of this series in the window drawn from; a raw line uses one column for all four. */
	public open = EMPTY;
	public high = EMPTY;
	public low = EMPTY;
	public close = EMPTY;
	/** Cache version the columns above were taken from. */
	public columnsVersion = -1;

	/** Where bars let go under the memory limit are fetched back from. */
	public datafeed: Datafeed | null = null;
	/** `seq` of the last `setData`: fetch requests from events before it are for the old history. */
	public reloadSeq = 0;
	/** Pause after the last failed datafeed request; it doubles with every failure in a row. */
	public fetchBackoff = 0;
	/** Times of bars whose request failed, and until when (`performance.now()`) they are not asked for again. */
	public failures: { from: number; to: number; until: number }[] = [];

	/** Latest known value, for the last-value line. */
	public lastValue = NaN;
	public lastUp = true;

	/** The price scale the series was last drawn on; the chart follows `priceScaleId` changes. */
	public axis: PriceAxis | null = null;
	/** The options `axis` was looked up for: a change of options looks it up again. */
	public axisOptions: AnySeriesOptions | null = null;
	/** Whether the last model update put the series on its scale (it was visible). */
	public scaled = false;
	/** Price at the first visible bar, on a percentage or indexed scale; NaN otherwise. */
	public base = Number.NaN;
	/** Device-pixel rows of prices on the scale, as last drawn: see `deviceY`. */
	public deviceOffset = 0;
	public deviceScale = 0;
	public deviceLog = false;

	private readonly _host: SeriesHost;
	/** What the last value label was made from, and the label. */
	private _labelValue = Number.NaN;
	private _labelBase = Number.NaN;
	private _labelScale: PriceScale | null = null;
	private _labelFormat = -1;
	private _labelOptions: AnySeriesOptions | null = null;
	private _labelText = '';

	public constructor(
		host: SeriesHost,
		id: number,
		type: SeriesType,
		options: Partial<AnySeriesOptions>,
		derived = false,
	) {
		this._host = host;
		this.id = id;
		this.type = type;
		this.kind = type === 'candlestick' ? 'ohlcv' : 'line';
		this.derived = derived;
		this.seriesOptions = { ...defaultOptions(type), ...definedOnly(options) } as AnySeriesOptions;
	}

	public setData(data: SeriesTypes[SeriesType]['data'], options?: SetDataOptions): void {
		const packed = this._pack(data);
		this.lastValue = NaN;
		let fetchable: boolean | undefined;
		if (options !== undefined && 'datafeed' in options) {
			this.datafeed = options.datafeed ?? null;
			fetchable = this.datafeed !== null;
		}
		const engine = this._host.engine();
		if (engine !== null) {
			this._host.reloaded(this, engine.setData(this.id, packed.data, packed.count, fetchable));
		}
	}

	public removeBars(range: TimeRange): void {
		const { from, to } = range;
		if (!(from <= to)) {
			return;
		}
		// Bars removed at the source explain answers there that did not match: no need to pause.
		this.failures = this.failures.filter(failure => failure.to < from || failure.from > to);
		this._host.engine()?.deleteBars(this.id, from, to);
	}

	public prepend(data: SeriesTypes[SeriesType]['data']): void {
		const packed = this._pack(data);
		if (packed.count > 0) {
			this._host.engine()?.prepend(this.id, packed.data, packed.count);
		}
	}

	public update(bar: OhlcBar | LinePoint): void {
		const engine = this._host.engine();
		if (engine === null) {
			return;
		}
		if (this.kind === 'ohlcv') {
			const candle = bar as OhlcBar;
			engine.tick(this.id, candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume ?? NaN);
		} else {
			engine.tick(this.id, bar.time, (bar as LinePoint).value);
		}
	}

	public applyOptions(options: Partial<AnySeriesOptions>): void {
		const next = { ...this.seriesOptions, ...definedOnly(options) } as AnySeriesOptions;
		if (shallowEqual(this.seriesOptions, next)) {
			return;
		}
		this.seriesOptions = next;
		this._host.invalidate(INVALIDATE_LIGHT);
	}

	public options(): Readonly<AnySeriesOptions> {
		return this.seriesOptions;
	}

	public addIndicator(name: string, options?: DeepPartial<IndicatorOptions>): IndicatorApi {
		return this._host.addIndicator(this, name, options);
	}

	public priceScale(): PriceScaleApi {
		return this._host.priceAxisOf(this);
	}

	public priceToCoordinate(price: number): number | null {
		const scale = this._host.priceAxisOf(this).scale;
		if (!scale.hasRange) {
			return null;
		}
		const y = scale.priceToY(price, this.base);
		return Number.isFinite(y) ? y : null;
	}

	public coordinateToPrice(y: number): number | null {
		const scale = this._host.priceAxisOf(this).scale;
		if (!scale.hasRange) {
			return null;
		}
		const price = scale.yToPrice(y, this.base);
		return Number.isFinite(price) ? price : null;
	}

	/**
	 * Sets the device-pixel mapping of this series' prices on `scale` (see `deviceY`). On a percentage
	 * or indexed scale a value is linear in the price, given the base, so it stays one multiply-add.
	 */
	public setProjection(scale: PriceScale, pixelRatio: number): void {
		let offset = scale.offset * pixelRatio;
		let factor = scale.scale * pixelRatio;
		const mode = scale.mode;
		if (mode === 'percentage' || mode === 'indexed') {
			// value = price * a + c, with a = 100 / |base| and c = -base * a (+ 100 when indexed).
			const base = this.base;
			const a = 100 / Math.abs(base);
			const c = (mode === 'indexed' ? 100 : 0) - base * a;
			offset -= c * factor;
			factor *= a;
		}
		this.deviceOffset = offset;
		this.deviceScale = factor;
		this.deviceLog = mode === 'logarithmic';
	}

	/** Device-pixel row of a price, as last drawn; NaN for a price the scale cannot show. */
	public deviceY(price: number): number {
		const value = this.deviceLog ? (price > 0 ? Math.log10(price) : Number.NaN) : price;
		return this.deviceOffset - value * this.deviceScale;
	}

	/** Label of a value of this series on `scale`, made again only when something it shows changed. */
	public valueLabel(scale: PriceScale, value: number): string {
		const options = this.seriesOptions;
		if (
			value !== this._labelValue ||
			!sameNumber(this.base, this._labelBase) ||
			scale !== this._labelScale ||
			scale.formatVersion !== this._labelFormat ||
			options !== this._labelOptions
		) {
			this._labelValue = value;
			this._labelBase = this.base;
			this._labelScale = scale;
			this._labelFormat = scale.formatVersion;
			this._labelOptions = options;
			this._labelText = scale.format(value, this.base, options.minMove, options.precision);
		}
		return this._labelText;
	}

	/**
	 * Points the column views at this series' block of a window. At a coarse level a line has four
	 * columns (first, highest, lowest and last value), laid out like open, high, low and close.
	 */
	public bind(block: Float64Array | undefined, capacity: number, version: number, level: number): void {
		if (version === this.columnsVersion) {
			return;
		}
		this.columnsVersion = version;
		if (block === undefined) {
			this.open = EMPTY;
			this.high = EMPTY;
			this.low = EMPTY;
			this.close = EMPTY;
		} else if (this.kind === 'ohlcv' || level > 0) {
			this.open = block.subarray(0, capacity);
			this.high = block.subarray(capacity, 2 * capacity);
			this.low = block.subarray(2 * capacity, 3 * capacity);
			this.close = block.subarray(3 * capacity, 4 * capacity);
		} else {
			const value = block.subarray(0, capacity);
			this.open = value;
			this.high = value;
			this.low = value;
			this.close = value;
		}
	}

	/** Packs bars a datafeed returned, keeping only those with times in `[from, to]`. */
	public packFetched(bars: SeriesTypes[SeriesType]['data'], from: number, to: number): Packed {
		const packed = this._pack(bars);
		const { count } = packed;
		const columns = packed.data.length / Math.max(1, count);
		let lo = 0;
		while (lo < count && !(packed.data[lo]! >= from)) {
			lo++;
		}
		let hi = count;
		while (hi > lo && !(packed.data[hi - 1]! <= to)) {
			hi--;
		}
		if (lo === 0 && hi === count) {
			return packed;
		}
		const n = hi - lo;
		const data = new Float64Array(n * columns);
		for (let c = 0; c < columns; c++) {
			data.set(packed.data.subarray(c * count + lo, c * count + hi), c * n);
		}
		return { data, count: n };
	}

	private _pack(data: SeriesTypes[SeriesType]['data']): Packed {
		return this.kind === 'ohlcv'
			? packCandles(data as readonly OhlcBar[] | OhlcColumns)
			: packLine(data as readonly LinePoint[] | LineColumns);
	}
}
