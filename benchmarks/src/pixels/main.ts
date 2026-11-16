// Checks that a frame which redraws only the columns a tick changed leaves the same pixels as a full
// redraw of the same state (design section 6.2, docs/design/stage-5.md). Run by `pnpm bench:pixels` in headless Chromium.
//
// A case builds a chart and then changes its data step by step. After every step the canvases are
// read, the chart is made to draw everything again, and the canvases are read once more: both
// readings must be equal in every byte. A second pass lets partial frames follow one another
// without a full redraw in between and compares at intervals.

import {
	type ChartApi,
	type ChartOptions,
	type DeepPartial,
	type LineOptions,
	type SeriesApi,
	createChart,
} from '@lumen-charts/core';

const MINUTE = 60_000;
/** A Wednesday, 09:40 in New York: the bars before 09:30 are in the pre-market session. */
const END = Date.UTC(2024, 2, 6, 14, 40);

export interface PixelCase {
	readonly name: string;
	readonly steps: number;
}

export interface PixelResult {
	readonly name: string;
	readonly steps: number;
	/** Frames by what they did with the series layer. */
	readonly partial: number;
	readonly full: number;
	readonly kept: number;
	/** Comparisons made, and those with a difference. */
	readonly compared: number;
	readonly different: number;
	readonly differentPixels: number;
	readonly largestDifference: number;
	/** Narrowest and widest range of columns a partial frame redrew, in device pixels. */
	readonly clipMin: number;
	readonly clipMax: number;
	readonly firstDifference: string;
}

function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface Bars {
	time: Float64Array;
	open: Float64Array;
	high: Float64Array;
	low: Float64Array;
	close: Float64Array;
	volume: Float64Array;
}

function bars(count: number, seed: number): Bars {
	const next = random(seed);
	const out: Bars = {
		time: new Float64Array(count),
		open: new Float64Array(count),
		high: new Float64Array(count),
		low: new Float64Array(count),
		close: new Float64Array(count),
		volume: new Float64Array(count),
	};
	let price = 100;
	for (let i = 0; i < count; i++) {
		const open = price;
		price = Math.max(5, price * (1 + (next() - 0.5) * 0.004));
		out.time[i] = END - (count - 1 - i) * MINUTE;
		out.open[i] = open;
		out.close[i] = price;
		out.high[i] = Math.max(open, price) * (1 + next() * 0.001);
		out.low[i] = Math.min(open, price) * (1 - next() * 0.001);
		out.volume[i] = 100 + next() * 900;
	}
	return out;
}

type View = '200' | '20k' | 'all';
const VIEWS: readonly View[] = ['200', '20k', 'all'];
const COUNT = 200_000;

/** What a case does at step `i`; values come from `next`. */
type Step = (i: number, next: () => number) => void;

interface Setup {
	readonly name: string;
	readonly options?: DeepPartial<ChartOptions>;
	/** Adds the series and returns the steps; `after` runs once the first data is drawn. */
	build(chart: ChartApi, data: Bars): { step: Step; after?: () => void };
}

/** A candle series fed by a last bar that moves, closes and is followed by a new one. */
function liveCandles(series: SeriesApi<'candlestick'>, data: Bars): Step {
	let time = data.time[COUNT - 1]!;
	let open = data.open[COUNT - 1]!;
	let high = data.high[COUNT - 1]!;
	let low = data.low[COUNT - 1]!;
	let close = data.close[COUNT - 1]!;
	return (i, next) => {
		if (i % 5 === 4) {
			time += MINUTE;
			open = close;
			high = close;
			low = close;
		}
		// Now and then a move that leaves the price range in view, so autoscale changes it.
		close *= i % 7 === 6 ? 1.2 : 1 + (next() - 0.5) * 0.002;
		high = Math.max(high, close);
		low = Math.min(low, close);
		series.update({ time, open, high, low, close, volume: 500 });
	};
}

const LINES: readonly Partial<LineOptions>[] = [
	{ color: '#1f77b4', lineWidth: 1 },
	{ color: 'rgba(214, 39, 40, 0.5)', lineWidth: 3 },
	{ color: '#2ca02c', lineWidth: 2, lineStyle: 'dashed' },
	{ color: 'rgba(148, 103, 189, 0.7)', lineWidth: 1, lineStyle: 'dotted' },
	{ color: '#8c564b', lineWidth: 2, lineType: 'step' },
	{ color: 'rgba(23, 190, 207, 0.6)', lineWidth: 4 },
];

const SETUPS: readonly Setup[] = [
	{
		name: 'candles',
		build(chart, data) {
			const series = chart.addSeries('candlestick', {
				upColor: 'rgba(38, 166, 154, 0.4)',
				downColor: 'rgba(239, 83, 80, 0.4)',
				borderVisible: true,
			});
			series.setData(data);
			return { step: liveCandles(series, data) };
		},
	},
	{
		// Lines of every style, one with gaps, and a histogram. Besides the last point, an older point
		// of every line is corrected in some steps: columns away from the right edge change, as they
		// would for an output drawn shifted.
		name: 'lines',
		build(chart, data) {
			const series = LINES.map((options, index) => {
				const line = chart.addSeries('line', options);
				const value = new Float64Array(COUNT);
				for (let i = 0; i < COUNT; i++) {
					value[i] = data.close[i]! * (1 + index * 0.01) + Math.sin(i / (3 + index)) * 0.3;
					if (index === 0 && (i % 97 === 0 || i > COUNT - 3)) {
						value[i] = NaN;
					}
				}
				line.setData({ time: data.time, value });
				return { line, value };
			});
			const histogram = chart.addSeries('histogram', {
				color: 'rgba(44, 160, 44, 0.5)',
				negativeColor: 'rgba(214, 39, 40, 0.5)',
				priceScaleId: 'histogram',
			});
			const spread = new Float64Array(COUNT);
			for (let i = 0; i < COUNT; i++) {
				spread[i] = data.close[i]! - data.open[i]!;
			}
			histogram.setData({ time: data.time, value: spread });
			chart.priceScale('histogram').applyOptions({ scaleMargins: { top: 0.7, bottom: 0 } });
			let time = data.time[COUNT - 1]!;
			return {
				step(i, next) {
					if (i % 5 === 4) {
						time += MINUTE;
					}
					for (const [index, { line, value }] of series.entries()) {
						const last = value[COUNT - 4]! * (1 + (next() - 0.5) * (i % 7 === 6 ? 0.3 : 0.002));
						// The line with gaps gets a value in some steps and loses it in others.
						line.update({ time, value: index === 0 && i % 3 === 0 ? NaN : last });
						if (i % 3 === 1) {
							const row = COUNT - 30 - index * 11 - (i % 4) * 500;
							line.update({ time: data.time[row]!, value: value[row]! * (1 + (next() - 0.5) * 0.004) });
						}
					}
					histogram.update({ time, value: (next() - 0.5) * 0.4 });
				},
			};
		},
	},
	{
		name: 'indicators',
		build(chart, data) {
			const series = chart.addSeries('candlestick');
			series.setData(data);
			series.addIndicator('sma', { params: { period: 20 } });
			series.addIndicator('ema', { params: { period: 50 }, outputs: { ema: { lineWidth: 2 } } });
			series.addIndicator('bollinger', { params: { period: 20, multiplier: 2 } });
			series.addIndicator('macd', { priceScaleId: 'macd' });
			series.addIndicator('rsi', { params: { period: 14 }, priceScaleId: 'rsi' });
			series.addIndicator('stochastic', { priceScaleId: 'rsi' });
			chart.priceScale('macd').applyOptions({ scaleMargins: { top: 0.75, bottom: 0 } });
			chart.priceScale('rsi').applyOptions({ scaleMargins: { top: 0, bottom: 0.75 } });
			return { step: liveCandles(series, data) };
		},
	},
	{
		// Logarithmic, inverted and percentage scales, each with an axis.
		name: 'scales',
		options: {
			priceScale: { mode: 'logarithmic' },
			priceScales: {
				inverted: { visible: true, position: 'left', invertScale: true },
				percent: { visible: true, position: 'left', mode: 'percentage' },
			},
		},
		build(chart, data) {
			const series = chart.addSeries('candlestick');
			series.setData(data);
			const inverted = chart.addSeries('line', { color: '#ff7f0e', lineWidth: 2, priceScaleId: 'inverted' });
			inverted.setData({ time: data.time, value: data.high });
			const percent = chart.addSeries('line', { color: 'rgba(31, 119, 180, 0.6)', priceScaleId: 'percent' });
			percent.setData({ time: data.time, value: data.low });
			const candles = liveCandles(series, data);
			let time = data.time[COUNT - 1]!;
			let value = data.close[COUNT - 1]!;
			return {
				step(i, next) {
					candles(i, next);
					if (i % 5 === 4) {
						time += MINUTE;
					}
					value *= 1 + (next() - 0.5) * 0.002;
					inverted.update({ time, value: value * 1.001 });
					percent.update({ time, value: value * 0.999 });
				},
			};
		},
	},
	{
		// Everything the series layer draws under the series: a watermark, dashed grid lines, session
		// breaks and shading. The price scale is fixed, so large moves leave the pane instead of
		// changing the scale.
		name: 'chrome',
		options: {
			watermark: { visible: true, text: 'LUMEN 1m', fontSize: 64, horzAlign: 'right', vertAlign: 'center' },
			grid: { vertLines: { style: 'dashed' }, horzLines: { style: 'dotted' } },
			localization: { timeZone: 'America/New_York' },
			sessions: {
				schedule: {
					timeZone: 'America/New_York',
					days: [1, 2, 3, 4, 5],
					hours: [
						{ start: '04:00', end: '09:30', kind: 'pre' },
						{ start: '09:30', end: '16:00' },
						{ start: '16:00', end: '20:00', kind: 'post' },
					],
					holidays: [],
				},
				breaks: { visible: true, style: 'dashed' },
				extendedHours: { visible: true },
			},
		},
		build(chart, data) {
			const series = chart.addSeries('candlestick');
			series.setData(data);
			const line = chart.addSeries('line', { color: 'rgba(255, 127, 14, 0.5)', lineWidth: 3 });
			line.setData({ time: data.time, value: data.high });
			const candles = liveCandles(series, data);
			let time = data.time[COUNT - 1]!;
			return {
				step(i, next) {
					candles(i, next);
					if (i % 5 === 4) {
						time += MINUTE;
					}
					line.update({ time, value: data.high[COUNT - 1]! * (1 + (next() - 0.5) * (i % 4 === 3 ? 0.5 : 0.004)) });
				},
				after: () => chart.priceScale().applyOptions({ autoScale: false }),
			};
		},
	},
];

const STEPS = 40;

export const CASES: readonly PixelCase[] = SETUPS.flatMap(setup =>
	VIEWS.flatMap(view => [
		{ name: `${setup.name}/${view}/each`, steps: STEPS },
		{ name: `${setup.name}/${view}/run`, steps: STEPS },
	]),
);

/** Counts what the frames of a chart do with its series layer, through the calls on its context. */
class PaneWatch {
	public partial = 0;
	public full = 0;
	public kept = 0;
	public clipMin = Infinity;
	public clipMax = 0;
	public lastClip = '';
	private _clips = 0;
	private _fills = 0;
	private readonly _restore: () => void;

	public constructor(canvas: HTMLCanvasElement) {
		const ctx = canvas.getContext('2d')!;
		const rect = ctx.rect.bind(ctx);
		const clip = ctx.clip.bind(ctx);
		const fillRect = ctx.fillRect.bind(ctx);
		let width = 0;
		ctx.rect = (x: number, y: number, w: number, h: number): void => {
			width = w;
			this.lastClip = `${x}-${x + w}`;
			rect(x, y, w, h);
		};
		ctx.clip = (): void => {
			this._clips++;
			this.clipMin = Math.min(this.clipMin, width);
			this.clipMax = Math.max(this.clipMax, width);
			clip();
		};
		ctx.fillRect = (x: number, y: number, w: number, h: number): void => {
			this._fills++;
			fillRect(x, y, w, h);
		};
		const own = ctx as unknown as Record<string, unknown>;
		this._restore = () => {
			delete own['rect'];
			delete own['clip'];
			delete own['fillRect'];
		};
	}

	/** Forgets the calls so far, for a frame that is not counted. */
	public skip(): void {
		this._clips = 0;
		this._fills = 0;
	}

	/** Classifies the frame (or frames) since the last call. */
	public frame(): void {
		if (this._clips > 0) {
			this.partial++;
		} else if (this._fills > 0) {
			this.full++;
		} else {
			this.kept++;
		}
		this.skip();
	}

	public release(): void {
		this._restore();
	}
}

const scratch = document.createElement('canvas');
const scratchContext = scratch.getContext('2d', { willReadFrequently: true })!;

/**
 * The pixels of every canvas of the chart. They are copied to another canvas and read there, so
 * reading does not make the browser move the chart's canvases off the GPU.
 */
function snapshot(chart: ChartApi): Uint8ClampedArray[] {
	const out: Uint8ClampedArray[] = [];
	for (const canvas of chart.element().querySelectorAll('canvas')) {
		scratch.width = canvas.width;
		scratch.height = canvas.height;
		scratchContext.globalCompositeOperation = 'copy';
		scratchContext.drawImage(canvas, 0, 0);
		out.push(scratchContext.getImageData(0, 0, canvas.width, canvas.height).data);
	}
	return out;
}

interface Difference {
	pixels: number;
	largest: number;
	/** The canvas and the box of the differing pixels in it. */
	where: string;
}

function compare(a: Uint8ClampedArray[], b: Uint8ClampedArray[], widths: number[]): Difference {
	const out: Difference = { pixels: 0, largest: 0, where: '' };
	const where: string[] = [];
	if (a.length !== b.length) {
		return { pixels: -1, largest: 255, where: 'another number of canvases' };
	}
	for (let c = 0; c < a.length; c++) {
		const left = a[c]!;
		const right = b[c]!;
		if (left.length !== right.length) {
			return { pixels: -1, largest: 255, where: `canvas ${c} has another size` };
		}
		const width = widths[c]!;
		let x0 = Infinity;
		let y0 = Infinity;
		let x1 = -1;
		let y1 = -1;
		for (let i = 0; i < left.length; i += 4) {
			const difference = Math.max(
				Math.abs(left[i]! - right[i]!),
				Math.abs(left[i + 1]! - right[i + 1]!),
				Math.abs(left[i + 2]! - right[i + 2]!),
				Math.abs(left[i + 3]! - right[i + 3]!),
			);
			if (difference > 0) {
				const x = (i / 4) % width;
				const y = Math.floor(i / 4 / width);
				x0 = Math.min(x0, x);
				y0 = Math.min(y0, y);
				x1 = Math.max(x1, x);
				y1 = Math.max(y1, y);
				out.pixels++;
				out.largest = Math.max(out.largest, difference);
			}
		}
		if (x1 >= 0) {
			where.push(`canvas ${c} of width ${width}, columns ${x0}-${x1}, rows ${y0}-${y1}`);
		}
	}
	out.where = where.join('; ');
	return out;
}

export async function runCase(name: string, container: HTMLElement): Promise<PixelResult> {
	const [setupName, view, pass] = name.split('/') as [string, View, 'each' | 'run'];
	const setup = SETUPS.find(entry => entry.name === setupName);
	if (setup === undefined) {
		throw new Error(`Unknown case ${name}`);
	}
	container.replaceChildren();
	const chart = createChart(container, { width: 640, height: 360, autoSize: false, worker: false, ...setup.options });
	const data = bars(COUNT, 7);
	const { step, after } = setup.build(chart, data);
	const scale = chart.timeScale();
	if (view === 'all') {
		scale.fitContent();
	} else {
		const shown = view === '200' ? 200 : 20_000;
		// Room at the right edge, so new bars arrive in view without scrolling it.
		scale.setVisibleLogicalRange({ from: COUNT - shown, to: COUNT + shown / 20 });
	}
	await chart.whenIdle();
	after?.();
	await chart.whenIdle();

	const canvases = [...chart.element().querySelectorAll('canvas')];
	const watch = new PaneWatch(canvases[0]!);
	/** Draws everything again without changing anything: two changes of an option that cancel out. */
	const redraw = async (): Promise<void> => {
		const visible = chart.options().grid.vertLines.visible;
		chart.applyOptions({ grid: { vertLines: { visible: !visible } } });
		chart.applyOptions({ grid: { vertLines: { visible } } });
		await chart.whenIdle();
		watch.skip();
	};
	const next = random(11);
	let compared = 0;
	let different = 0;
	let differentPixels = 0;
	let largestDifference = 0;
	let firstDifference = '';
	const check = async (i: number): Promise<void> => {
		const widths = [...chart.element().querySelectorAll('canvas')].map(canvas => canvas.width);
		const before = snapshot(chart);
		await redraw();
		const difference = compare(before, snapshot(chart), widths);
		compared++;
		if (difference.pixels !== 0) {
			different++;
			differentPixels += Math.max(0, difference.pixels);
			largestDifference = Math.max(largestDifference, difference.largest);
			if (firstDifference === '') {
				firstDifference = `step ${i}: ${difference.where}, clip ${watch.lastClip}`;
			}
		}
	};
	for (let i = 0; i < STEPS; i++) {
		step(i, next);
		await chart.whenIdle();
		watch.frame();
		if (pass === 'each' || i % 8 === 7 || i === STEPS - 1) {
			await check(i);
		}
	}
	watch.release();
	chart.destroy();
	return {
		name,
		steps: STEPS,
		partial: watch.partial,
		full: watch.full,
		kept: watch.kept,
		compared,
		different,
		differentPixels,
		largestDifference,
		clipMin: watch.partial > 0 ? watch.clipMin : 0,
		clipMax: watch.clipMax,
		firstDifference,
	};
}

declare global {
	interface Window {
		pixels?: { cases: readonly PixelCase[]; run: (name: string) => Promise<PixelResult> };
	}
}

const container = document.getElementById('chart');
if (container === null) {
	throw new Error('Missing #chart element');
}
if (new URLSearchParams(window.location.search).get('raster') === 'cpu') {
	// A canvas that is read often is rasterized on the CPU: the other rasterizer of the browser.
	const getContext = HTMLCanvasElement.prototype.getContext;
	HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, options?: object) {
		return getContext.call(this, type, type === '2d' ? { ...options, willReadFrequently: true } : options);
	} as typeof getContext;
}
window.pixels = { cases: CASES, run: name => runCase(name, container) };
