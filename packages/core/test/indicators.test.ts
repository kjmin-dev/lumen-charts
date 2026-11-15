import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type ChartApi, createChart } from '@lumen-charts/core';
import { computeIndicator, macd, resolveParams, rsi, sma } from '@lumen-charts/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Call {
	name: string;
	args: unknown[];
	fillStyle: string;
	strokeStyle: string;
}

/** Stands in for a 2D context and records what is drawn. */
function recorder(): { calls: Call[]; ctx: CanvasRenderingContext2D } {
	const calls: Call[] = [];
	const state: Record<string, unknown> = { fillStyle: '', strokeStyle: '' };
	const ctx = new Proxy(state, {
		get(target, property: string) {
			if (property === 'measureText') {
				return (text: string) => ({ width: text.length * 7 });
			}
			if (property in target) {
				return target[property];
			}
			return (...args: unknown[]) => {
				calls.push({
					name: property,
					args,
					fillStyle: String(target.fillStyle),
					strokeStyle: String(target.strokeStyle),
				});
			};
		},
		set(target, property: string, value) {
			target[property] = value;
			return true;
		},
	});
	return { calls, ctx: ctx as unknown as CanvasRenderingContext2D };
}

const MINUTE = 60_000;

function candles(count: number, start = 0) {
	const time = new Float64Array(count);
	const open = new Float64Array(count);
	const high = new Float64Array(count);
	const low = new Float64Array(count);
	const close = new Float64Array(count);
	for (let i = 0; i < count; i++) {
		const base = 100 + Math.sin(i / 50) * 10;
		time[i] = start + i * MINUTE;
		open[i] = base;
		close[i] = base + (i % 3 === 0 ? 1 : -0.5);
		high[i] = base + 2;
		low[i] = base - 2;
	}
	return { time, open, high, low, close };
}

describe('indicators on a chart', () => {
	let container: HTMLDivElement;
	let frames: ((now: number) => void)[];
	let recorders: Map<HTMLCanvasElement, ReturnType<typeof recorder>>;
	let chart: ChartApi;
	let now = 0;

	const pane = () => recorders.get(chart.element().querySelectorAll('canvas')[0]!)!;
	const priceAxis = () => recorders.get(chart.element().querySelectorAll('canvas')[1]!)!;
	const runFrames = (): void => {
		for (const frame of frames.splice(0)) {
			now += 16;
			frame(now);
		}
	};
	/** Runs frames and engine tasks until the chart reports that everything is applied and painted. */
	const settle = async (): Promise<void> => {
		const state = { done: false };
		void chart.whenIdle().then(() => {
			state.done = true;
		});
		const step = async (remaining: number): Promise<void> => {
			if (state.done || remaining === 0) {
				return;
			}
			runFrames();
			await new Promise(resolve => setTimeout(resolve, 0));
			await step(remaining - 1);
		};
		await step(500);
		expect(state.done).toBe(true);
	};
	const strokes = (color: string): number =>
		pane().calls.filter(call => call.name === 'stroke' && call.strokeStyle === color).length;

	beforeEach(() => {
		container = document.createElement('div');
		document.body.appendChild(container);
		frames = [];
		recorders = new Map();
		vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => frames.push(cb));
		vi.stubGlobal('cancelAnimationFrame', () => {});
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
			let entry = recorders.get(this);
			if (entry === undefined) {
				entry = recorder();
				recorders.set(this, entry);
			}
			return entry.ctx;
		} as unknown as HTMLCanvasElement['getContext']);
		chart = createChart(container, { autoSize: false, width: 640, height: 400, worker: false });
	});

	afterEach(() => {
		chart.destroy();
		container.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('computes an indicator in the engine, draws it as a line and updates it with ticks', async () => {
		const data = candles(3000);
		const series = chart.addSeries('candlestick');
		series.setData(data);
		const average = series.addIndicator('sma', { params: { period: 20 }, outputs: { value: { color: '#abcdef' } } });
		await settle();
		const expected = computeIndicator(sma, new Float64Array([20]), [data.close])[0]!;
		expect(average.output().lastValue()).toBe(expected[2999]);
		expect(average.output('value').options().color).toBe('#abcdef');
		expect(strokes('#abcdef')).toBe(1);

		const close = [...data.close, 120];
		series.update({ time: data.time[2999]! + MINUTE, open: 110, high: 121, low: 109, close: 120 });
		await chart.whenApplied();
		// Applied without a frame: the value travels with the bar.
		expect(average.output().lastValue()).toBe(computeIndicator(sma, new Float64Array([20]), [close])[0]![3000]);
	});

	it('draws a histogram output from its base, which autoscale includes', async () => {
		const data = candles(1500);
		const series = chart.addSeries('candlestick');
		series.setData(data);
		const indicator = series.addIndicator('macd', {
			outputs: { histogram: { color: '#00ff00', negativeColor: '#ff0000' } },
		});
		await settle();
		expect(indicator.output('histogram').type).toBe('histogram');
		// Prices around 100 and an oscillator around 0 share the price scale.
		const labels = priceAxis()
			.calls.filter(call => call.name === 'fillText')
			.map(call => Number(call.args[0]));
		expect(Math.min(...labels)).toBeLessThanOrEqual(0);
		expect(Math.max(...labels)).toBeGreaterThanOrEqual(100);
		const [line] = computeIndicator(macd, resolveParams(macd.params), [data.close]);
		expect(indicator.output('macd').lastValue()).toBe(line![1499]);
		// With the candles hidden the scale fits the oscillator, and its bars are tall enough to see.
		series.applyOptions({ visible: false });
		pane().calls.length = 0;
		await settle();
		const bars = pane().calls.filter(
			call => call.name === 'fillRect' && (call.fillStyle === '#00ff00' || call.fillStyle === '#ff0000'),
		);
		expect(bars.length).toBeGreaterThan(20);
		expect(bars.some(bar => bar.fillStyle === '#00ff00')).toBe(true);
		expect(bars.some(bar => bar.fillStyle === '#ff0000')).toBe(true);
	});

	it('chains indicators, and removes the readers of a removed indicator', async () => {
		const data = candles(2000);
		const series = chart.addSeries('candlestick');
		series.setData(data);
		const strength = series.addIndicator('rsi');
		const smoothed = strength
			.output()
			.addIndicator('sma', { params: { period: 9 }, outputs: { value: { color: '#123123' } } });
		await settle();
		const values = computeIndicator(rsi, new Float64Array([14]), [data.close])[0]!;
		expect(smoothed.output().lastValue()).toBe(computeIndicator(sma, new Float64Array([9]), [values])[0]![1999]);
		strength.remove();
		pane().calls.length = 0;
		await settle();
		expect(strokes('#123123')).toBe(0);
		// Removed with its source, so changing it does nothing.
		smoothed.applyOptions({ params: { period: 3 } });
		await settle();
	});

	it('keeps the old values until new parameters are computed', async () => {
		const data = candles(2000);
		const series = chart.addSeries('candlestick');
		series.setData(data);
		const average = series.addIndicator('sma');
		await settle();
		const before = average.output().lastValue();
		average.applyOptions({ params: { period: 50 } });
		expect(average.options().params['period']).toBe(50);
		expect(average.output().lastValue()).toBe(before);
		await settle();
		expect(average.output().lastValue()).toBe(computeIndicator(sma, new Float64Array([50]), [data.close])[0]![1999]);
		// Style only: no recomputation.
		average.applyOptions({ outputs: { value: { lineWidth: 3 } } });
		expect(average.output().options()).toMatchObject({ lineWidth: 3 });
	});

	it('removes the indicators of a removed series', async () => {
		const series = chart.addSeries('candlestick');
		series.setData(candles(500));
		series.addIndicator('ema', { outputs: { value: { color: '#777777' } } });
		await settle();
		expect(strokes('#777777')).toBe(1);
		chart.removeSeries(series);
		pane().calls.length = 0;
		await settle();
		expect(strokes('#777777')).toBe(0);
	});

	it('refuses unknown indicators, parameters out of bounds and inputs that read later indicators', () => {
		const series = chart.addSeries('candlestick');
		expect(() => series.addIndicator('nope')).toThrow(/Unknown indicator/);
		expect(() => series.addIndicator('sma', { params: { period: 0 } })).toThrow(RangeError);
		const first = series.addIndicator('sma');
		const second = series.addIndicator('ema');
		expect(() => first.applyOptions({ inputs: [second.output()] })).toThrow(/added before/);
		const other = createChart(document.createElement('div'), { worker: false });
		const foreign = other.addSeries('line');
		expect(() => series.addIndicator('sma', { inputs: [{ series: foreign }] })).toThrow(/of this chart/);
		other.destroy();
	});

	it('loads indicators from a plugin module into the engine on this thread', async () => {
		const data = candles(800);
		const series = chart.addSeries('candlestick');
		series.setData(data);
		const infos = await chart.registerIndicators(pathToFileURL(resolvePath('packages/engine/test/fixtures/plugin.ts')));
		expect(infos.map(info => info.name)).toEqual(['test-momentum', 'test-range', 'test-decay']);
		const momentum = series.addIndicator('test-momentum', { params: { period: 5 } });
		await settle();
		expect(momentum.output().type).toBe('histogram');
		expect(momentum.output().lastValue()).toBeCloseTo(data.close[799]! - data.close[794]!, 10);
		await expect(
			chart.registerIndicators(pathToFileURL(resolvePath('packages/engine/test/fixtures/missing.js'))),
		).rejects.toThrow(/Could not load/);
	});

	it('draws a histogram series of its own, from a base of zero', async () => {
		const data = candles(400);
		const volume = chart.addSeries('histogram', { color: '#0000ff' });
		volume.setData({ time: data.time, value: data.high });
		await settle();
		expect(
			pane().calls.filter(call => call.name === 'fillRect' && call.fillStyle === '#0000ff').length,
		).toBeGreaterThan(20);
		const labels = priceAxis()
			.calls.filter(call => call.name === 'fillText')
			.map(call => Number(call.args[0]));
		expect(Math.min(...labels)).toBeLessThanOrEqual(0);
	});
});
