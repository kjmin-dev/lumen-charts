import { type ChartApi, type SeriesApi, createChart } from '@lumen-charts/core';
import type { AdapterFactory, ChartAdapter, ChartSize, LogicalRange } from '../adapter.ts';
import type { CandleColumns, LineColumns, TickColumns } from '../data.ts';
import { pendingFrameCallbacks } from '../harness/frames.ts';

/** Columns are lumen's own input format, so preparing passes them through unchanged. */
type Prepared = { kind: 'candles'; columns: CandleColumns } | { kind: 'line'; columns: LineColumns };

type AnySeries = SeriesApi<'candlestick'> | SeriesApi<'line'>;

/**
 * Resolves in a task after the current one. Called from an animation-frame callback, that task runs
 * after the frame's style, layout, paint and commit steps.
 */
function nextTask(): Promise<void> {
	return new Promise(resolve => {
		const channel = new MessageChannel();
		channel.port1.addEventListener(
			'message',
			() => {
				channel.port1.close();
				resolve();
			},
			{ once: true },
		);
		channel.port1.start();
		channel.port2.postMessage(null);
	});
}

class LumenAdapter implements ChartAdapter<Prepared> {
	private readonly _chart: ChartApi;
	private _series: AnySeries | null = null;
	private _kind: Prepared['kind'] | null = null;

	public constructor(container: HTMLElement, size: ChartSize, worker: boolean) {
		this._chart = createChart(container, { width: size.width, height: size.height, autoSize: false, worker });
	}

	public prepareCandles(data: CandleColumns): Prepared {
		return { kind: 'candles', columns: data };
	}

	public prepareLine(data: LineColumns): Prepared {
		return { kind: 'line', columns: data };
	}

	public setData(data: Prepared): void {
		if (data.kind === 'candles') {
			const { time, open, high, low, close } = data.columns;
			this._candles().setData({ time, open, high, low, close });
		} else {
			const { time, value } = data.columns;
			this._line().setData({ time, value });
		}
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
			const { time, open, high, low, close } = data.columns;
			(this._series as SeriesApi<'candlestick'>).prepend({ time, open, high, low, close });
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
			});
		} else {
			(this._series as SeriesApi<'line'>).update({ time, value: ticks.value[index] ?? 0 });
		}
	}

	public setVisibleLogicalRange(range: LogicalRange): void {
		this._chart.timeScale().setVisibleLogicalRange({ from: range.from, to: range.to });
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
		}
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
		}
	}
}

function factory(worker: boolean): AdapterFactory {
	return {
		// The workspace sources at the commit recorded with every results file.
		library: { name: '@lumen-charts/core', version: 'workspace' },
		options: { worker },
		create: (container, size) => Promise.resolve(new LumenAdapter(container, size, worker)),
	};
}

/** Data engine in a worker (the default). */
export const lumenWorker = factory(true);
/** Data engine time-sliced on the main thread. */
export const lumenMain = factory(false);
