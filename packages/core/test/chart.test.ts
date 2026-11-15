import { type ChartApi, createChart } from '@lumen-charts/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('createChart', () => {
	let container: HTMLDivElement;
	let frames: (() => void)[];

	beforeEach(() => {
		container = document.createElement('div');
		document.body.appendChild(container);
		frames = [];
		vi.stubGlobal('requestAnimationFrame', (cb: () => void) => frames.push(cb));
		vi.stubGlobal('cancelAnimationFrame', (id: number) => {
			frames[id - 1] = () => {};
		});
	});

	afterEach(() => {
		container.remove();
		vi.unstubAllGlobals();
	});

	it('mounts a canvas inside the container', () => {
		const chart = createChart(container, { autoSize: false, width: 400, height: 200 });
		expect(container.contains(chart.element())).toBe(true);
		expect(chart.element().querySelector('canvas')).not.toBeNull();
		expect(chart.element().style.width).toBe('400px');
		chart.destroy();
	});

	it('coalesces several changes into one frame', () => {
		const chart = createChart(container, { autoSize: false, width: 400, height: 200 });
		const scheduled = frames.length;
		chart.applyOptions({ background: '#000000' });
		chart.applyOptions({ background: '#111111' });
		chart.resize(500, 250);
		expect(frames.length).toBe(scheduled);
		chart.destroy();
	});

	it('does not schedule a frame when options are unchanged', () => {
		const chart = createChart(container, { autoSize: false, width: 400, height: 200 });
		for (const frame of frames.splice(0)) {
			frame();
		}
		chart.applyOptions({ width: 400, height: 200, background: '#ffffff' });
		expect(frames.length).toBe(0);
		chart.applyOptions({ background: '#222222' });
		expect(frames.length).toBe(1);
		chart.destroy();
	});

	it('ignores undefined option values', () => {
		const chart = createChart(container, { autoSize: false, width: 400, height: 200 });
		chart.applyOptions({ width: undefined });
		expect(chart.options().width).toBe(400);
		chart.destroy();
	});

	it('removes its element on destroy and tolerates repeated calls', () => {
		const chart = createChart(container);
		chart.destroy();
		chart.destroy();
		expect(container.childElementCount).toBe(0);
		chart.applyOptions({ background: '#333333' });
		expect(chart.options().background).toBe('#ffffff');
	});
});

interface Call {
	name: string;
	args: unknown[];
	fillStyle: string;
}

/** Stands in for a 2D context and records what is drawn. */
function recorder(): { calls: Call[]; ctx: CanvasRenderingContext2D } {
	const calls: Call[] = [];
	const state: Record<string, unknown> = { fillStyle: '' };
	const ctx = new Proxy(state, {
		get(target, property: string) {
			if (property === 'measureText') {
				return (text: string) => ({ width: text.length * 7 });
			}
			if (property in target) {
				return target[property];
			}
			return (...args: unknown[]) => {
				calls.push({ name: property, args, fillStyle: String(target.fillStyle) });
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
const UP = '#00aa00';
const DOWN = '#aa0000';

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
		close[i] = base + (i % 2 === 0 ? 1 : -1);
		high[i] = base + 2;
		low[i] = base - 2;
	}
	return { time, open, high, low, close };
}

describe('chart with series', () => {
	let container: HTMLDivElement;
	let frames: ((now: number) => void)[];
	let recorders: Map<HTMLCanvasElement, ReturnType<typeof recorder>>;
	let chart: ChartApi;
	let now = 0;

	const layer = (index: number) => recorders.get(chart.element().querySelectorAll('canvas')[index]!)!;
	const pane = () => layer(0);
	const priceAxis = () => layer(1);
	const overlay = () => layer(3);
	const clearCalls = (): void => {
		for (const entry of recorders.values()) {
			entry.calls.length = 0;
		}
	};
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
	const pointer = (type: string, x: number, y: number, init: PointerEventInit = {}): void => {
		chart
			.element()
			.dispatchEvent(
				new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', bubbles: true, ...init }),
			);
	};
	const candleRects = (): Call[] =>
		pane().calls.filter(call => call.name === 'fillRect' && (call.fillStyle === UP || call.fillStyle === DOWN));

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

	it('draws the latest bars as whole-pixel candles once data arrives', async () => {
		expect(chart.engineMode()).toBe('none');
		const series = chart.addSeries('candlestick', {
			upColor: UP,
			downColor: DOWN,
			wickUpColor: UP,
			wickDownColor: DOWN,
		});
		series.setData(candles(5000));
		expect(chart.timeScale().getVisibleLogicalRange()).toBeNull();
		await settle();
		expect(chart.engineMode()).toBe('local');

		const range = chart.timeScale().getVisibleLogicalRange()!;
		expect(range.to).toBe(4999.5);
		const visible = Math.round(range.to - range.from);
		const rects = candleRects();
		// A wick and a body per visible candle, give or take the bars cut by the edges.
		expect(rects.length).toBeGreaterThanOrEqual(visible * 2 - 4);
		expect(rects.length).toBeLessThanOrEqual(visible * 2 + 4);
		for (const rect of rects) {
			for (const value of rect.args as number[]) {
				expect(Number.isInteger(value)).toBe(true);
			}
			expect(rect.args[3]).toBeGreaterThan(0);
		}
		expect(rects.some(rect => rect.fillStyle === UP)).toBe(true);
		expect(rects.some(rect => rect.fillStyle === DOWN)).toBe(true);
		expect(priceAxis().calls.filter(call => call.name === 'fillText').length).toBeGreaterThan(2);
	});

	it('applies time scale calls after the data they follow', async () => {
		const series = chart.addSeries('candlestick');
		series.setData(candles(20_000));
		chart.timeScale().fitContent();
		await settle();
		const range = chart.timeScale().getVisibleLogicalRange()!;
		expect(range.from).toBeCloseTo(-0.5, 6);
		expect(range.to).toBeCloseTo(19_999.5, 6);

		chart.timeScale().setVisibleLogicalRange({ from: 100, to: 300 });
		expect(chart.timeScale().getVisibleLogicalRange()!.from).toBeCloseTo(100, 6);
	});

	it('draws at most one candle per pixel column however many bars are visible', async () => {
		const series = chart.addSeries('candlestick', {
			upColor: UP,
			downColor: DOWN,
			wickUpColor: UP,
			wickDownColor: DOWN,
		});
		series.setData(candles(300_000));
		chart.timeScale().fitContent();
		await settle();
		const paneWidth = chart.element().querySelectorAll('canvas')[0]!.width;
		const rects = candleRects();
		expect(rects.length).toBeGreaterThan(paneWidth / 2);
		expect(rects.length).toBeLessThanOrEqual(paneWidth + 1);
		for (const rect of rects) {
			expect(rect.args[2]).toBe(1);
		}
	});

	it('shows ticks on the last bar without redrawing the axes', async () => {
		const series = chart.addSeries('candlestick', {
			upColor: UP,
			downColor: DOWN,
			wickUpColor: UP,
			wickDownColor: DOWN,
		});
		const data = candles(1000);
		series.setData(data);
		await settle();
		const before = candleRects().length;
		clearCalls();

		const last = data.time[999]!;
		// Stays inside the bar's old range, so the price scale has no reason to change.
		const close = data.open[999]! - 0.5;
		series.update({ time: last, open: data.open[999]!, high: data.high[999]!, low: data.low[999]!, close });
		await settle();
		expect(candleRects().length).toBe(before);
		expect(priceAxis().calls.length).toBe(0);
		const tags = overlay().calls.filter(call => call.name === 'fillText');
		expect(tags.map(call => call.args[0])).toContain(close.toFixed(2));

		// A new bar scrolls the chart by one bar while the last bar is in view.
		series.update({ time: last + MINUTE, open: 100.5, high: 101, low: 100, close: 100.8 });
		clearCalls();
		await settle();
		expect(chart.timeScale().getVisibleLogicalRange()!.to).toBe(1000.5);
	});

	it('keeps the view when history is prepended', async () => {
		const series = chart.addSeries('candlestick');
		series.setData(candles(1000, 5000 * MINUTE));
		await settle();
		const before = chart.timeScale().getVisibleLogicalRange()!;
		series.prepend(candles(5000, 0));
		await settle();
		expect(chart.timeScale().getVisibleLogicalRange()).toEqual(before);
		chart.timeScale().fitContent();
		expect(chart.timeScale().getVisibleLogicalRange()!.from).toBeCloseTo(-5000.5, 6);
	});

	it('draws a line series as one path on the shared timeline', async () => {
		const data = candles(2000);
		chart.addSeries('candlestick').setData(data);
		const line = chart.addSeries('line', { color: '#123456' });
		line.setData({ time: data.time, value: data.close });
		await settle();
		const calls = pane().calls;
		expect(calls.filter(call => call.name === 'stroke').length).toBe(1);
		expect(calls.filter(call => call.name === 'beginPath').length).toBe(1);
		expect(calls.filter(call => call.name === 'lineTo').length).toBeGreaterThan(50);

		chart.removeSeries(line);
		clearCalls();
		await settle();
		expect(pane().calls.filter(call => call.name === 'stroke').length).toBe(0);
	});

	it('pans with a drag and zooms with the wheel', async () => {
		chart.addSeries('candlestick').setData(candles(5000));
		await settle();
		const scale = chart.timeScale();
		const start = scale.getVisibleLogicalRange()!;
		pointer('pointerdown', 300, 100);
		pointer('pointermove', 360, 100);
		pointer('pointerup', 360, 100);
		await settle();
		const panned = scale.getVisibleLogicalRange()!;
		const paneWidth = Number.parseFloat(chart.element().querySelectorAll('canvas')[0]!.style.width);
		const barSpacing = paneWidth / (start.to - start.from);
		expect(panned.to).toBeCloseTo(start.to - 60 / barSpacing, 6);

		const anchor = 200;
		const span = panned.to - panned.from;
		const wheel = new WheelEvent('wheel', { deltaY: 200, bubbles: true, cancelable: true });
		// The DOM used for tests does not take pointer coordinates from the event init.
		Object.defineProperty(wheel, 'clientX', { value: anchor });
		chart.element().dispatchEvent(wheel);
		await settle();
		const zoomed = scale.getVisibleLogicalRange()!;
		expect(zoomed.to - zoomed.from).toBeGreaterThan(span * 1.3);
		expect(wheel.defaultPrevented).toBe(true);

		// Input that carries no usable position is ignored instead of corrupting the scale.
		chart.element().dispatchEvent(new WheelEvent('wheel', { deltaY: Number.NaN, bubbles: true, cancelable: true }));
		await settle();
		expect(scale.getVisibleLogicalRange()).toEqual(zoomed);
	});

	it('redraws only the overlay when the crosshair moves', async () => {
		chart.addSeries('candlestick').setData(candles(5000));
		await settle();
		clearCalls();
		pointer('pointermove', 200, 150);
		await settle();
		expect(pane().calls.length).toBe(0);
		expect(priceAxis().calls.length).toBe(0);
		const labels = overlay()
			.calls.filter(call => call.name === 'fillText')
			.map(call => String(call.args[0]));
		expect(labels.some(label => /^1970-01-0\d \d\d:\d\d$/.test(label))).toBe(true);

		clearCalls();
		pointer('pointerleave', 700, 150);
		await settle();
		expect(overlay().calls.filter(call => call.name === 'clearRect').length).toBe(1);
		expect(overlay().calls.filter(call => call.name === 'fillText').length).toBe(1);
	});

	it('reports rejected data by leaving the chart empty, and survives destroy while loading', async () => {
		const series = chart.addSeries('line');
		series.setData([
			{ time: 5, value: 1 },
			{ time: 4, value: 2 },
		]);
		await settle();
		expect(chart.timeScale().getVisibleLogicalRange()!.to).toBe(0.5);

		series.setData(Array.from({ length: 50_000 }, (_, i) => ({ time: i * MINUTE, value: i })));
		const idle = chart.whenIdle();
		chart.destroy();
		await idle;
		series.update({ time: 1, value: 1 });
		expect(chart.engineMode()).toBe('none');
	});
});
