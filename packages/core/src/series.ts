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
import { INVALIDATE_LIGHT, type Invalidation } from './model/invalidation';
import {
	type CandlestickOptions,
	DEFAULT_CANDLESTICK_OPTIONS,
	DEFAULT_LINE_OPTIONS,
	type LineOptions,
	definedOnly,
	shallowEqual,
} from './options';
import { SeriesView } from './views/series-view';

/** Bars the chart asks a datafeed for: the ones with times in `[from, to]`, which it held before. */
export interface DatafeedRequest {
	/** Time of the first bar, UTC milliseconds (inclusive). */
	from: number;
	/** Time of the last bar, UTC milliseconds (inclusive). */
	to: number;
	/** Number of bars in `[from, to]`. */
	countBack: number;
}

/**
 * A source the chart can fetch history from again. With a datafeed and the chart's `memoryLimit`,
 * the data engine may let go of bars far from the view and ask for them when they are needed.
 * Requests for the same bars are never in flight twice; a failed request is tried again the next
 * time the bars are needed, after a pause that grows with every failure (1 s up to 30 s).
 */
export interface Datafeed<T extends SeriesType = SeriesType> {
	/**
	 * Resolves to the bars with times in `[request.from, request.to]`, oldest first, in any format
	 * `setData` accepts (bars outside the range are ignored). They must be the bars handed over
	 * before: bars that differ in number or time are refused with a console warning, and the chart
	 * keeps drawing a coarser level of detail there.
	 */
	getBars(request: DatafeedRequest): Promise<SeriesTypes[SeriesType & T]['data']>;
}

/** Options `addSeries` takes: the series options, and a datafeed to fetch its history from again. */
export type SeriesCreateOptions<T extends SeriesType> = Partial<SeriesTypes[T]['options']> & {
	datafeed?: Datafeed<T>;
};

/** What each series type takes: its options, one update, and a whole history. */
export interface SeriesTypes {
	candlestick: { options: CandlestickOptions; bar: OhlcBar; data: readonly OhlcBar[] | OhlcColumns };
	line: { options: LineOptions; bar: LinePoint; data: readonly LinePoint[] | LineColumns };
}

export type SeriesType = keyof SeriesTypes;

export interface SeriesApi<T extends SeriesType = SeriesType> {
	readonly type: T;
	/** Replaces the history. Times are UTC milliseconds and must be strictly increasing. */
	setData(data: SeriesTypes[T]['data']): void;
	/** Updates the bar with this time, or appends a new bar if the time is later than the last one. */
	update(bar: SeriesTypes[T]['bar']): void;
	/** Adds older history before the first bar. Indexes of existing bars do not change. */
	prepend(data: SeriesTypes[T]['data']): void;
	applyOptions(options: Partial<SeriesTypes[T]['options']>): void;
	options(): Readonly<SeriesTypes[T]['options']>;
}

export interface SeriesHost {
	engine(): EngineClient | null;
	invalidate(level: Invalidation): void;
}

const EMPTY: Float64Array = new Float64Array(0);

export class Series implements SeriesApi {
	public readonly type: SeriesType;
	public readonly kind: SeriesKind;
	public readonly id: number;
	public readonly view = new SeriesView();
	public seriesOptions: CandlestickOptions | LineOptions;

	/** Columns of this series in the window drawn from; a raw line uses one column for all four. */
	public open = EMPTY;
	public high = EMPTY;
	public low = EMPTY;
	public close = EMPTY;
	/** Cache version the columns above were taken from. */
	public columnsVersion = -1;

	/** Where bars let go under the memory limit are fetched back from. */
	public datafeed: Datafeed | null = null;

	/** Latest known value, for the last-value line. */
	public lastValue = NaN;
	public lastUp = true;

	private readonly _host: SeriesHost;

	public constructor(
		host: SeriesHost,
		id: number,
		type: SeriesType,
		options: Partial<CandlestickOptions> | Partial<LineOptions>,
	) {
		this._host = host;
		this.id = id;
		this.type = type;
		this.kind = type === 'candlestick' ? 'ohlcv' : 'line';
		this.seriesOptions =
			type === 'candlestick'
				? { ...DEFAULT_CANDLESTICK_OPTIONS, ...definedOnly(options as Partial<CandlestickOptions>) }
				: { ...DEFAULT_LINE_OPTIONS, ...definedOnly(options as Partial<LineOptions>) };
	}

	public setData(data: SeriesTypes[SeriesType]['data']): void {
		const packed = this._pack(data);
		this.lastValue = NaN;
		this._host.engine()?.setData(this.id, packed.data, packed.count);
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

	public applyOptions(options: Partial<CandlestickOptions> | Partial<LineOptions>): void {
		const next = { ...this.seriesOptions, ...definedOnly(options) } as CandlestickOptions | LineOptions;
		if (shallowEqual(this.seriesOptions, next)) {
			return;
		}
		this.seriesOptions = next;
		this._host.invalidate(INVALIDATE_LIGHT);
	}

	public options(): Readonly<CandlestickOptions | LineOptions> {
		return this.seriesOptions;
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
