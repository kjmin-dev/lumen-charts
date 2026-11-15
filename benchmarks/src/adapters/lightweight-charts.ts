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

type Prepared = { kind: 'candles'; items: CandlestickData[] } | { kind: 'line'; items: LineData[] };

/**
 * Lowest bar spacing the time scale may reach, in CSS pixels. The library default (0.5) caps the
 * view at about two bars per pixel; the scenarios need every bar of 10 million in view.
 */
export const MIN_BAR_SPACING = 1e-6;

function seconds(ms: number): UTCTimestamp {
	return (ms / 1000) as UTCTimestamp;
}

class LightweightChartsAdapter implements ChartAdapter<Prepared> {
	private readonly _chart: IChartApi;
	private _series: ISeriesApi<SeriesType> | null = null;
	private _kind: Prepared['kind'] | null = null;

	public constructor(container: HTMLElement, size: ChartSize, conflation: boolean) {
		const options: DeepPartial<TimeChartOptions> = {
			width: size.width,
			height: size.height,
			autoSize: false,
			timeScale: {
				enableConflation: conflation,
				minBarSpacing: MIN_BAR_SPACING,
				timeVisible: true,
			},
		};
		this._chart = createChart(container, options);
	}

	public prepareCandles(data: CandleColumns): Prepared {
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
		return { kind: 'candles', items };
	}

	public prepareLine(data: LineColumns): Prepared {
		const { length, time, value } = data;
		const items: LineData[] = [];
		for (let i = 0; i < length; i++) {
			items.push({ time: seconds(time[i] ?? 0), value: value[i] ?? 0 });
		}
		return { kind: 'line', items };
	}

	public setData(data: Prepared): void {
		const series = this._ensureSeries(data.kind);
		series.setData(data.items);
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
		this._chart.timeScale().setVisibleLogicalRange({ from: range.from, to: range.to });
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
