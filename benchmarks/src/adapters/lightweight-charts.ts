import {
	type CandlestickData,
	CandlestickSeries,
	type DeepPartial,
	HistogramSeries,
	type IChartApi,
	type ISeriesApi,
	type LineData,
	LineSeries,
	type SeriesType,
	type TimeChartOptions,
	type UTCTimestamp,
	type WhitespaceData,
	createChart,
	version,
} from 'lightweight-charts';
import type { AdapterFactory, ChartAdapter, ChartSize, LogicalRange } from '../adapter.ts';
import type { CandleColumns, LineColumns, TickColumns } from '../data.ts';
import { settleFrames } from '../harness/frames.ts';
import type { AppliedAdapter, IndicatorAdapter } from '../scenarios/indicators.ts';
import { UserIndicators } from './user-indicators.ts';

/**
 * `prepended` is set by `preparePrepend`: how many of the items are new, older bars. `columns` keeps
 * the candles as columns for indicators computed in application code.
 */
type Prepared = ({ kind: 'candles'; items: CandlestickData[] } | { kind: 'line'; items: LineData[] }) & {
	prepended?: number;
	columns?: CandleColumns;
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

class LightweightChartsAdapter implements ChartAdapter<Prepared>, IndicatorAdapter, AppliedAdapter {
	private readonly _chart: IChartApi;
	private _series: ISeriesApi<SeriesType> | null = null;
	private _kind: Prepared['kind'] | null = null;
	/**
	 * Rows prepended since the last `setData`. The library numbers bars from its first one, so its
	 * indexes are the harness's (fixed origin) plus this.
	 */
	private _offset = 0;
	/** Indicators to put on the next series, computed in application code, and their series. */
	private _indicatorCount = 0;
	private _user: UserIndicators | null = null;
	private _outputs: ISeriesApi<SeriesType>[] = [];
	private readonly _values: number[] = [];
	private readonly _row: number[] = [0, 0, 0, 0, 0, 0];

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
		return { kind: 'candles', items: candleItems(data), columns: data };
	}

	/**
	 * Lightweight Charts has no indicators: application code computes them (here with the same
	 * kernels as lumen, incrementally) and hands each output to a line or histogram series of its own.
	 */
	public withIndicators(count: number): void {
		this._indicatorCount = count;
	}

	public applied(): Promise<void> {
		// Updates, indicator values included, are applied synchronously by the calls themselves.
		return Promise.resolve();
	}

	public prepareLine(data: LineColumns): Prepared {
		return { kind: 'line', items: lineItems(data) };
	}

	public setData(data: Prepared): void {
		const series = this._ensureSeries(data.kind);
		series.setData(data.items);
		this._offset = 0;
		if (this._indicatorCount > 0 && data.columns !== undefined) {
			this._user ??= new UserIndicators(this._indicatorCount);
			this._user.load(data.columns);
			this._setOutputs();
		}
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
			return { kind: 'candles', items: items.concat(current), prepended: items.length, columns: data };
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
		if (this._user !== null && data.columns !== undefined) {
			// The indicators are recomputed over the whole history and handed over again.
			this._user.prepend(data.columns);
			this._setOutputs();
		}
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
			const user = this._user;
			if (user !== null) {
				const row = this._row;
				row[0] = ticks.time[index] ?? 0;
				row[1] = ticks.open[index] ?? 0;
				row[2] = ticks.high[index] ?? 0;
				row[3] = ticks.low[index] ?? 0;
				row[4] = ticks.close[index] ?? 0;
				row[5] = ticks.volume[index] ?? 0;
				user.tick(row);
				user.lastValues(this._values);
				for (let i = 0; i < this._outputs.length; i++) {
					const value = this._values[i]!;
					this._outputs[i]!.update(value === value ? { time, value } : { time });
				}
			}
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
		this._outputs = [];
		this._user = null;
	}

	/** Hands every indicator output to its series, creating them the first time. */
	private _setOutputs(): void {
		const user = this._user!;
		const styles = user.outputs;
		if (this._outputs.length === 0) {
			for (const { style, color } of styles) {
				this._outputs.push(
					style === 'histogram'
						? this._chart.addSeries(HistogramSeries, { color, priceLineVisible: false })
						: this._chart.addSeries(LineSeries, {
								color,
								lineWidth: 1,
								priceLineVisible: false,
								crosshairMarkerVisible: false,
							}),
				);
			}
		}
		const time = user.columns.data[0]!;
		const length = user.columns.length;
		let k = 0;
		for (const entry of user.entries) {
			for (const output of entry.outputs) {
				const items: (LineData | WhitespaceData)[] = [];
				for (let i = 0; i < length; i++) {
					const value = output[i]!;
					const t = seconds(time[i]!);
					items.push(value === value ? { time: t, value } : { time: t });
				}
				this._outputs[k++]!.setData(items);
			}
		}
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
