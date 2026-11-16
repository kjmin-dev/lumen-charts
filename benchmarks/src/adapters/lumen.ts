import * as lumen from '@lumen-charts/core';
import { type ChartApi, type IndicatorApi, type IndicatorInput, type SeriesApi, createChart } from '@lumen-charts/core';
import type { AdapterFactory, ChartAdapter, ChartSize, LogicalRange } from '../adapter.ts';
import type { CandleColumns, LineColumns, SeriesColumns, TickColumns } from '../data.ts';
import type { BenchDrawing } from '../drawings.ts';
import { afterNextFrame, nextTask, pendingFrameCallbacks } from '../harness/frames.ts';
import { INDICATOR_SET } from '../indicators.ts';
import type { PriceAxesLayout } from '../jobs.ts';

/** Columns are lumen's own input format, so preparing passes them through unchanged. */
type Prepared = { kind: 'candles'; columns: CandleColumns } | { kind: 'line'; columns: LineColumns };

type AnySeries = SeriesApi<'candlestick'> | SeriesApi<'line'>;

type Feed = (from: number, to: number) => SeriesColumns;

/** The extended hours of a New York equity exchange (stage 4 scenarios). */
const EQUITY_HOURS = {
	timeZone: 'America/New_York',
	days: [1, 2, 3, 4, 5],
	hours: [
		{ start: '04:00', end: '09:30', kind: 'pre' },
		{ start: '09:30', end: '16:00' },
		{ start: '16:00', end: '20:00', kind: 'post' },
	],
	holidays: [],
};

/** A datafeed in lumen's shape over a function of the page. */
function datafeedOf(feed: Feed) {
	return { getBars: ({ from, to }: { from: number; to: number }) => Promise.resolve(feed(from, to)) } as never;
}

class LumenAdapter implements ChartAdapter<Prepared> {
	private readonly _chart: ChartApi;
	private _series: AnySeries | null = null;
	private _kind: Prepared['kind'] | null = null;
	/** Indicators of the stage 3 set to put on the next series, and those on the current one. */
	private _indicatorCount = 0;
	private _indicators: IndicatorApi[] = [];
	private _axes: PriceAxesLayout = 'one';
	private _repaints = 0;

	public constructor(container: HTMLElement, size: ChartSize | 'auto', worker: boolean) {
		this._chart = createChart(
			container,
			size === 'auto' ? { worker } : { width: size.width, height: size.height, autoSize: false, worker },
		);
	}

	public prepareCandles(data: CandleColumns): Prepared {
		return { kind: 'candles', columns: data };
	}

	public prepareLine(data: LineColumns): Prepared {
		return { kind: 'line', columns: data };
	}

	public withIndicators(count: number): void {
		this._indicatorCount = count;
	}

	public withPriceAxes(layout: PriceAxesLayout): void {
		this._axes = layout;
	}

	public applied(): Promise<void> {
		return this._chart.whenApplied();
	}

	public setData(data: Prepared): void {
		if (data.kind === 'candles') {
			const { time, open, high, low, close, volume } = data.columns;
			const series = this._candles();
			// With indicators, VWAP reads the volume; without, the stage 1 and 2 scenarios stay as they were.
			series.setData(
				this._indicatorCount > 0 ? { time, open, high, low, close, volume } : { time, open, high, low, close },
			);
			this._addIndicators(series);
			this._layOutAxes();
		} else {
			const { time, value } = data.columns;
			this._line().setData({ time, value });
		}
	}

	public setDataWithDatafeed(data: Prepared, datafeed: Feed, memoryLimit: number): void {
		this._chart.applyOptions({ memoryLimit });
		this._replaceSeries();
		if (data.kind === 'candles') {
			const series = this._chart.addSeries('candlestick', { datafeed: datafeedOf(datafeed) });
			this._series = series;
			this._kind = 'candles';
			const { time, open, high, low, close } = data.columns;
			series.setData({ time, open, high, low, close });
		} else {
			const series = this._chart.addSeries('line', { datafeed: datafeedOf(datafeed) });
			this._series = series;
			this._kind = 'line';
			const { time, value } = data.columns;
			series.setData({ time, value });
		}
	}

	public addSeriesWithDatafeed(data: Prepared, datafeed: Feed | null): void {
		if (data.kind !== 'line') {
			throw new Error('Secondary series are lines');
		}
		const series = this._chart.addSeries('line', datafeed === null ? {} : { datafeed: datafeedOf(datafeed) });
		const { time, value } = data.columns;
		series.setData({ time, value });
	}

	public reloadWithDatafeed(data: Prepared, datafeed: Feed): void {
		if (this._series === null || this._kind !== 'line' || data.kind !== 'line') {
			throw new Error('Reloading needs a line series with a datafeed');
		}
		const { time, value } = data.columns;
		(this._series as SeriesApi<'line'>).setData({ time, value }, { datafeed: datafeedOf(datafeed) });
	}

	public correctBar(time: number, value: number): void {
		(this._series as SeriesApi<'line'>).update({ time, value });
	}

	public removeBars(from: number, to: number): void {
		const series = this._series as SeriesApi<'line'> & { removeBars?: (range: { from: number; to: number }) => void };
		// The code of earlier stages, measured with the same harness, has no deletions.
		if (typeof series.removeBars !== 'function') {
			throw new Error('This version of lumen cannot remove bars');
		}
		series.removeBars({ from, to });
	}

	public preparePrepend(data: CandleColumns | LineColumns): Prepared {
		return data.kind === 'candles' ? this.prepareCandles(data) : this.prepareLine(data);
	}

	public prepend(data: Prepared): void {
		if (this._series === null || this._kind !== data.kind) {
			throw new Error(`Prepending ${data.kind} needs a ${data.kind} series with data`);
		}
		// lumen keeps a fixed index origin, as the harness's logical ranges do, so nothing is remapped.
		if (data.kind === 'candles') {
			const { time, open, high, low, close, volume } = data.columns;
			(this._series as SeriesApi<'candlestick'>).prepend(
				this._indicatorCount > 0 ? { time, open, high, low, close, volume } : { time, open, high, low, close },
			);
		} else {
			const { time, value } = data.columns;
			(this._series as SeriesApi<'line'>).prepend({ time, value });
		}
	}

	public applyTick(ticks: TickColumns, index: number): void {
		if (this._series === null || this._kind !== ticks.kind) {
			throw new Error(`Ticks of kind ${ticks.kind} need a ${ticks.kind} series`);
		}
		const time = ticks.time[index] ?? 0;
		if (ticks.kind === 'candles') {
			(this._series as SeriesApi<'candlestick'>).update({
				time,
				open: ticks.open[index] ?? 0,
				high: ticks.high[index] ?? 0,
				low: ticks.low[index] ?? 0,
				close: ticks.close[index] ?? 0,
				volume: this._indicatorCount > 0 ? (ticks.volume[index] ?? 0) : undefined,
			});
		} else {
			(this._series as SeriesApi<'line'>).update({ time, value: ticks.value[index] ?? 0 });
		}
	}

	public setTimeZone(timeZone: string, sessions: boolean): void {
		// Options a version of lumen without time zones does not know are ignored.
		this._chart.applyOptions({
			localization: { timeZone },
			...(sessions ? { sessions: { schedule: EQUITY_HOURS, breaks: { visible: true } } } : {}),
		} as never);
	}

	public repaint(): void {
		this._repaints++;
		this._chart.applyOptions({ layout: { textColor: this._repaints % 2 === 0 ? '#4a5160' : '#4a5161' } });
	}

	public setVisibleLogicalRange(range: LogicalRange): void {
		this._chart.timeScale().setVisibleLogicalRange({ from: range.from, to: range.to });
	}

	public addDrawings(drawings: readonly BenchDrawing[]): void {
		const api = (this._chart as Partial<Pick<ChartApi, 'drawings'>>).drawings?.();
		// The code of earlier stages, measured with the same harness, has no drawings.
		if (api === undefined) {
			throw new Error('This version of lumen has no drawings');
		}
		for (const drawing of drawings) {
			api.add({
				type: drawing.type,
				points: drawing.points,
				options: drawing.text === undefined ? undefined : { text: drawing.text },
			});
		}
	}

	public pointerTarget(): HTMLElement {
		return this._chart.element();
	}

	public hitTestDrawing(x: number, y: number): boolean {
		return this._chart.drawings().hitTest(x, y) !== null;
	}

	public async settle(): Promise<void> {
		// `whenIdle` resolves once the engine has answered and the draw showing it has run, from inside
		// that animation frame; the next task then comes after the frame's rendering. Waiting a whole
		// extra frame instead, as `settleFrames` does, would add up to a refresh interval to every settle.
		for (;;) {
			await this._chart.whenIdle();
			await nextTask();
			if (pendingFrameCallbacks() === 0) {
				return;
			}
			// A frame is still to come. If it is this chart's, `whenIdle` waits for it. If it is another
			// chart's (several charts on a page), this chart is idle already, and asking again at once
			// would spin through tasks until that frame; waiting for the frame costs nothing instead.
			await afterNextFrame();
		}
	}

	public idle(): Promise<void> {
		return this._chart.whenIdle();
	}

	public destroy(): void {
		this._chart.destroy();
		this._series = null;
	}

	private _candles(): SeriesApi<'candlestick'> {
		if (this._series === null || this._kind !== 'candles') {
			this._replaceSeries();
			this._series = this._chart.addSeries('candlestick');
			this._kind = 'candles';
		}
		return this._series as SeriesApi<'candlestick'>;
	}

	private _line(): SeriesApi<'line'> {
		if (this._series === null || this._kind !== 'line') {
			this._replaceSeries();
			this._series = this._chart.addSeries('line');
			this._kind = 'line';
		}
		return this._series as SeriesApi<'line'>;
	}

	private _replaceSeries(): void {
		if (this._series !== null) {
			this._chart.removeSeries(this._series);
			this._series = null;
			this._indicators = [];
		}
	}

	/** Puts the scales of the series and its indicators where the price axes layout says. */
	private _layOutAxes(): void {
		const chart = this._chart;
		if (this._axes === 'log' || this._axes === 'percent') {
			chart.applyOptions({ priceScale: { mode: this._axes === 'log' ? 'logarithmic' : 'percentage' } });
		} else if (this._axes === 'four') {
			chart.applyOptions({
				priceScales: {
					inner: { visible: true, position: 'left' },
					outer: { visible: true, position: 'left' },
					right: { visible: true },
				},
			});
			const ids = ['inner', 'outer', 'right'];
			this._indicators.forEach((indicator, i) => {
				indicator.applyOptions({ priceScaleId: ids[i % ids.length]! });
			});
		}
	}

	/** Puts the indicator set on a new series; its indicators compute in the data engine. */
	private _addIndicators(series: SeriesApi<'candlestick'>): void {
		if (this._indicators.length > 0 || this._indicatorCount === 0) {
			return;
		}
		for (const entry of INDICATOR_SET.slice(0, this._indicatorCount)) {
			const inputs: IndicatorInput[] | undefined = entry.inputs?.map(input =>
				typeof input === 'string' ? input : this._indicators[input.from]!.output(),
			);
			this._indicators.push(series.addIndicator(entry.name, { params: entry.params, inputs }));
		}
	}
}

function factory(worker: boolean): AdapterFactory {
	return {
		// The workspace sources at the commit recorded with every results file.
		library: { name: '@lumen-charts/core', version: 'workspace' },
		options: { worker },
		create: (container, size) => Promise.resolve(new LumenAdapter(container, size, worker)),
		setMaxWorkers: count => {
			// Read from the namespace, so the harness also builds against sources from before worker
			// sharing, which have no such function (`pnpm bench --packages`).
			const set = (lumen as { setMaxWorkers?: (count: number) => void }).setMaxWorkers;
			set?.(count);
		},
	};
}

/** Data engine in a worker (the default). */
export const lumenWorker = factory(true);
/** Data engine time-sliced on the main thread. */
export const lumenMain = factory(false);
