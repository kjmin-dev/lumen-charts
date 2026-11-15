import {
	type CandlestickData,
	CandlestickSeries,
	type DeepPartial,
	type IChartApi,
	type ISeriesApi,
	type LineData,
	LineSeries,
	type SeriesType,
	type TimeChartOptions,
	type UTCTimestamp,
	createChart,
	version,
} from 'lightweight-charts';
import type { AdapterFactory, ChartAdapter, ChartSize, LogicalRange } from '../adapter.ts';
import type { CandleColumns, LineColumns, TickColumns } from '../data.ts';
import { settleFrames } from '../harness/frames.ts';

/** `prepended` is set by `preparePrepend`: how many of the items are new, older bars. */
type Prepared = ({ kind: 'candles'; items: CandlestickData[] } | { kind: 'line'; items: LineData[] }) & {
	prepended?: number;
};

/**
 * Lowest bar spacing the time scale may reach, in CSS pixels. The library default (0.5) caps the
 * view at about two bars per pixel; the scenarios need every bar of 10 million in view.
 */
export const MIN_BAR_SPACING = 1e-6;

function seconds(ms: number): UTCTimestamp {
	return (ms / 1000) as UTCTimestamp;
}

function candleItems(data: CandleColumns): CandlestickData[] {
	const { length, time, open, high, low, close } = data;
	const items: CandlestickData[] = [];
	for (let i = 0; i < length; i++) {
		items.push({
			time: seconds(time[i] ?? 0),
			open: open[i] ?? 0,
			high: high[i] ?? 0,
			low: low[i] ?? 0,
			close: close[i] ?? 0,
		});
	}
	return items;
}

function lineItems(data: LineColumns): LineData[] {
	const { length, time, value } = data;
	const items: LineData[] = [];
	for (let i = 0; i < length; i++) {
		items.push({ time: seconds(time[i] ?? 0), value: value[i] ?? 0 });
	}
	return items;
}

class LightweightChartsAdapter implements ChartAdapter<Prepared> {
	private readonly _chart: IChartApi;
	private _series: ISeriesApi<SeriesType> | null = null;
	private _kind: Prepared['kind'] | null = null;
	/**
	 * Rows prepended since the last `setData`. The library numbers bars from its first one, so its
	 * indexes are the harness's (fixed origin) plus this.
	 */
	private _offset = 0;

	public constructor(container: HTMLElement, size: ChartSize | 'auto', conflation: boolean) {
		const options: DeepPartial<TimeChartOptions> = {
			...(size === 'auto' ? { autoSize: true } : { width: size.width, height: size.height, autoSize: false }),
			timeScale: {
				enableConflation: conflation,
				minBarSpacing: MIN_BAR_SPACING,
				timeVisible: true,
			},
		};
		this._chart = createChart(container, options);
	}

	public prepareCandles(data: CandleColumns): Prepared {
		return { kind: 'candles', items: candleItems(data) };
	}

	public prepareLine(data: LineColumns): Prepared {
		return { kind: 'line', items: lineItems(data) };
	}

	public setData(data: Prepared): void {
		const series = this._ensureSeries(data.kind);
		series.setData(data.items);
		this._offset = 0;
	}

	/**
	 * The library has no prepend. Its way to add older history is to replace the series with the older
	 * bars followed by the current ones, which is what `prepend` does. This step builds that array:
	 * it converts the batch and reads the current bars back with `series.data()` (one new object per
	 * bar), so the adapter does not keep a second copy of every bar, which would add to the memory
	 * measured after a load. The result is only valid until the series changes again.
	 */
	public preparePrepend(data: CandleColumns | LineColumns): Prepared {
		const series = this._series;
		if (series === null || this._kind !== data.kind) {
			throw new Error(`Prepending ${data.kind} needs a ${data.kind} series with data`);
		}
		if (data.kind === 'candles') {
			const items = candleItems(data);
			const current = series.data() as readonly CandlestickData[];
			return { kind: 'candles', items: items.concat(current), prepended: items.length };
		}
		const items = lineItems(data);
		const current = series.data() as readonly LineData[];
		return { kind: 'line', items: items.concat(current), prepended: items.length };
	}

	/**
	 * Not equivalent to a real prepend: `setData` processes every bar of the series again, not only
	 * the new ones, so its cost grows with the history already loaded.
	 */
	public prepend(data: Prepared): void {
		const series = this._series;
		if (series === null || this._kind !== data.kind || data.prepended === undefined) {
			throw new Error('prepend needs the result of preparePrepend for the current series');
		}
		series.setData(data.items);
		this._offset += data.prepended;
	}

	public applyTick(ticks: TickColumns, index: number): void {
		const series = this._series;
		if (series === null || this._kind !== ticks.kind) {
			throw new Error(`Ticks of kind ${ticks.kind} need a ${ticks.kind} series`);
		}
		const time = seconds(ticks.time[index] ?? 0);
		if (ticks.kind === 'candles') {
			series.update({
				time,
				open: ticks.open[index] ?? 0,
				high: ticks.high[index] ?? 0,
				low: ticks.low[index] ?? 0,
				close: ticks.close[index] ?? 0,
			});
		} else {
			series.update({ time, value: ticks.value[index] ?? 0 });
		}
	}

	public setVisibleLogicalRange(range: LogicalRange): void {
		const offset = this._offset;
		this._chart.timeScale().setVisibleLogicalRange({ from: range.from + offset, to: range.to + offset });
	}

	public settle(): Promise<void> {
		// Updates are applied synchronously; drawing happens in requestAnimationFrame.
		return settleFrames();
	}

	public destroy(): void {
		this._chart.remove();
		this._series = null;
	}

	private _ensureSeries(kind: Prepared['kind']): ISeriesApi<SeriesType> {
		if (this._series !== null && this._kind === kind) {
			return this._series;
		}
		if (this._series !== null) {
			this._chart.removeSeries(this._series);
		}
		this._series = kind === 'candles' ? this._chart.addSeries(CandlestickSeries) : this._chart.addSeries(LineSeries);
		this._kind = kind;
		return this._series;
	}
}

function factory(conflation: boolean): AdapterFactory {
	return {
		library: { name: 'lightweight-charts', version: version() },
		options: {
			'timeScale.enableConflation': conflation,
			'timeScale.minBarSpacing': MIN_BAR_SPACING,
			'timeScale.timeVisible': true,
		},
		create: (container, size) => Promise.resolve(new LightweightChartsAdapter(container, size, conflation)),
	};
}

export const conflationOn = factory(true);
export const conflationOff = factory(false);
