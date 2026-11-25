import { type ChartApi, createChart, themes } from '@lumen-ticks/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spreadLabels } from '../src/render/label-layout';

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
const LINE = '#123456';

/** Candles around `level`, swinging by a tenth of it. */
function candles(count: number, level = 100) {
	const time = new Float64Array(count);
	const open = new Float64Array(count);
	const high = new Float64Array(count);
	const low = new Float64Array(count);
	const close = new Float64Array(count);
	for (let i = 0; i < count; i++) {
		const base = level + Math.sin(i / 50) * level * 0.1;
		time[i] = i * MINUTE;
		open[i] = base;
		close[i] = base + (i % 2 === 0 ? 1 : -1) * level * 0.01;
		high[i] = base + level * 0.02;
		low[i] = base - level * 0.02;
	}
	return { time, open, high, low, close };
}

/** A line of `count` points from a function of the index. */
function line(count: number, value: (i: number) => number) {
	return {
		time: Float64Array.from({ length: count }, (_, i) => i * MINUTE),
		value: Float64Array.from({ length: count }, (_, i) => value(i)),
	};
}

function pointer(target: Element, type: string, x: number, y: number): void {
	target.dispatchEvent(
		new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', bubbles: true }),
	);
}

function wheelAt(target: Element, x: number, y: number, deltaY: number, init: WheelEventInit = {}): WheelEvent {
	const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true, ...init });
	// The DOM used for tests does not take pointer coordinates or modifiers from the event init.
	Object.defineProperty(event, 'clientX', { value: x });
	Object.defineProperty(event, 'clientY', { value: y });
	Object.defineProperty(event, 'ctrlKey', { value: init.ctrlKey === true });
	target.dispatchEvent(event);
	return event;
}

function touch(target: Element, type: string, id: number, x: number, y: number): void {
	target.dispatchEvent(
		new PointerEvent(type, { clientX: x, clientY: y, pointerId: id, pointerType: 'touch', bubbles: true }),
	);
}

/** Tops for wanted tops `wanted`, labels `size` high on an axis from `top` to `bottom`. */
function spread(wanted: number[], size: number, top: number, bottom: number): number[] {
	const out = Array.from({ length: wanted.length }, () => Number.NaN);
	spreadLabels(wanted, wanted.length, size, top, bottom, out);
	return out;
}

/** How far labels are from where they want to be: the sum of the squared distances. */
function cost(tops: number[], wanted: number[]): number {
	return tops.reduce((sum, top, i) => sum + (top - wanted[i]!) ** 2, 0);
}

interface ChartInternals {
	_axes: { list: { id: string; scale: { height: number } }[] };
}

interface AxisInternals {
	id: string;
	scale: { min: number; max: number };
	layer: { canvas: HTMLCanvasElement } | null;
	axisLeft: number;
	axisWidth: number;
}

describe('price axes', () => {
	let container: HTMLDivElement;
	let frames: ((now: number) => void)[];
	let recorders: Map<HTMLCanvasElement, ReturnType<typeof recorder>>;
	let chart: ChartApi;
	let now = 0;

	const canvases = () => [...chart.element().querySelectorAll('canvas')];
	const axisOf = (id: string) =>
		(chart as unknown as { _axes: { _byId: Map<string, AxisInternals> } })._axes._byId.get(id)!;
	const callsOf = (canvas: HTMLCanvasElement): Call[] => recorders.get(canvas)!.calls;
	const pane = () => callsOf(canvases()[0]!);
	const overlay = () => callsOf(canvases().at(-1)!);
	const axisLabels = (id: string): string[] =>
		callsOf(axisOf(id).layer!.canvas)
			.filter(call => call.name === 'fillText')
			.map(call => String(call.args[0]));
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
	const range = (id?: string) => chart.priceScale(id).getVisibleRange()!;
	const axisLeft = (id: string) => Number.parseFloat(axisOf(id).layer!.canvas.style.left);
	const canvas = (id: string) => axisOf(id).layer!.canvas;
	const paneWidth = () => Number.parseFloat(canvases()[0]!.style.width);

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

	it('keeps one axis on the right by default, the scale every series is on', async () => {
		const series = chart.addSeries('candlestick');
		series.setData(candles(1000));
		const scale = chart.priceScale();
		expect(scale.getVisibleRange()).toBeNull();
		expect(series.priceToCoordinate(100)).toBeNull();
		await settle();
		expect(canvases()).toHaveLength(4);
		expect(scale.id).toBe('default');
		expect(series.priceScale()).toBe(scale);
		expect(series.options().priceScaleId).toBe('default');
		expect(scale.options()).toEqual(chart.options().priceScale);
		expect(scale.options()).toMatchObject({ mode: 'normal', autoScale: true, invertScale: false });
		expect(chart.options().priceScales).toEqual({});
		expect(scale.width()).toBe(Number.parseFloat(canvases()[1]!.style.width));
		const { from, to } = range();
		expect(from).toBeLessThan(to);
		const y = series.priceToCoordinate(100)!;
		expect(y).toBeGreaterThan(0);
		expect(y).toBeLessThan(400);
		expect(series.coordinateToPrice(y)).toBeCloseTo(100, 9);
		expect(scale.priceToCoordinate(100)).toBe(y);
		expect(scale.coordinateToPrice(y)).toBeCloseTo(100, 9);
	});

	it('lays out several axes on both sides, from the pane outward', async () => {
		chart.applyOptions({
			priceScales: {
				left: { visible: true, position: 'left' },
				outer: { visible: true, position: 'left' },
				right2: { visible: true },
			},
		});
		chart.addSeries('candlestick').setData(candles(1000));
		chart.addSeries('line', { priceScaleId: 'left' }).setData(line(1000, i => 1000 + i));
		chart.addSeries('line', { priceScaleId: 'outer' }).setData(line(1000, i => 0.001 * (1 + i / 1000)));
		chart.addSeries('line', { priceScaleId: 'right2' }).setData(line(1000, i => 50_000 - i * 10));
		await settle();
		// The overlay stays on top of every axis.
		expect(canvases()).toHaveLength(7);
		expect(canvases().at(-1)!.style.pointerEvents).toBe('none');
		const width = (id: string) => chart.priceScale(id).width();
		const paneLeft = Number.parseFloat(canvases()[0]!.style.left);
		const paneRight = paneLeft + paneWidth();
		expect(axisLeft('outer')).toBe(0);
		expect(axisLeft('left')).toBe(width('outer'));
		expect(paneLeft).toBe(width('outer') + width('left'));
		expect(axisLeft('default')).toBe(paneRight);
		expect(axisLeft('right2')).toBe(paneRight + width('default'));
		expect(paneRight + width('default') + width('right2')).toBe(640);
		// Every axis is labelled in its own range, and wide labels widen their axis.
		const numbers = (id: string) => axisLabels(id).map(Number);
		expect(Math.min(...numbers('left'))).toBeGreaterThan(900);
		expect(Math.max(...numbers('outer'))).toBeLessThan(0.01);
		expect(axisLabels('outer').every(label => /^0\.00\d+$/.test(label))).toBe(true);
		expect(Math.min(...numbers('right2'))).toBeGreaterThan(30_000);
		expect(width('outer')).toBeGreaterThan(width('default'));
		expect(Math.max(...numbers('default'))).toBeLessThan(200);
	});

	it('scales an overlay on its own and moves a series between scales at run time', async () => {
		chart.addSeries('candlestick').setData(candles(1000));
		const levels = chart.addSeries('line', { priceScaleId: 'levels' });
		levels.setData(line(1000, i => 1000 + (i % 100)));
		await settle();
		// An id no option names is an overlay: no axis of its own.
		expect(canvases()).toHaveLength(4);
		expect(chart.priceScale('levels').width()).toBe(0);
		expect(chart.priceScale('levels').options().visible).toBe(false);
		expect(range('default').to).toBeLessThan(200);
		expect(range('levels')).toEqual({ from: 1000, to: 1099 });
		// The overlay fills the pane between the margins, like the default scale.
		expect(levels.priceToCoordinate(1099)).toBeCloseTo(37.2, 9);
		expect(levels.priceToCoordinate(1000)).toBeCloseTo(334.8, 9);

		levels.applyOptions({ priceScaleId: 'default' });
		await settle();
		expect(levels.priceScale().id).toBe('default');
		expect(range('default').to).toBe(1099);
		levels.applyOptions({ priceScaleId: 'levels' });
		await settle();
		expect(range('default').to).toBeLessThan(200);
	});

	it('autoscales a scale to all its visible series', async () => {
		const low = chart.addSeries('line');
		low.setData(line(500, i => 10 + (i % 10)));
		const high = chart.addSeries('line');
		high.setData(line(500, i => 30 + (i % 20)));
		await settle();
		expect(range()).toEqual({ from: 10, to: 49 });
		high.applyOptions({ visible: false });
		await settle();
		expect(range()).toEqual({ from: 10, to: 19 });
		// A histogram's base is always in range.
		chart.addSeries('histogram', { base: 0 }).setData(line(500, i => 5 + (i % 3)));
		await settle();
		expect(range()).toEqual({ from: 0, to: 19 });
	});

	it('shows every series in percent from its first visible bar', async () => {
		chart.applyOptions({ priceScale: { mode: 'percentage' } });
		const a = line(1000, i => 100 + i * 0.05);
		const b = line(1000, i => 1000 + i * 2);
		const first = chart.addSeries('line', { color: LINE });
		first.setData(a);
		const second = chart.addSeries('line');
		second.setData(b);
		chart.timeScale().setVisibleLogicalRange({ from: 400, to: 600 });
		await settle();
		// Both start at 0% at bar 400.
		const y = first.priceToCoordinate(a.value[400]!)!;
		expect(second.priceToCoordinate(b.value[400]!)).toBeCloseTo(y, 9);
		expect(chart.priceScale().priceToCoordinate(a.value[400]!)).toBeCloseTo(y, 9);
		const { from, to } = range();
		expect(from).toBe(0);
		// The second rises by 2 per bar from 1800, the first by 0.05 from 120: about 22% over the view.
		expect(to).toBeCloseTo(((b.value[600]! - b.value[400]!) / b.value[400]!) * 100, 6);
		expect(axisLabels('default').every(label => label.endsWith('%'))).toBe(true);
		expect(axisLabels('default')).toContain('0.00%');
		// The last value, in percent from the first visible bar, on the axis.
		const texts = overlay()
			.filter(call => call.name === 'fillText')
			.map(call => String(call.args[0]));
		const lastChange = ((a.value[999]! - a.value[400]!) / a.value[400]!) * 100;
		expect(texts).toContain(`${lastChange.toFixed(2)}%`);

		chart.applyOptions({ priceScale: { mode: 'indexed' } });
		await settle();
		expect(range().from).toBe(100);
		expect(second.priceToCoordinate(b.value[400]!)).toBeCloseTo(first.priceToCoordinate(a.value[400]!)!, 9);
		expect(axisLabels('default')).toContain('100.00');
	});

	it('draws a logarithmic scale with round ticks and leaves out prices at or below zero', async () => {
		chart.applyOptions({ priceScale: { mode: 'logarithmic' } });
		const values = line(1000, i => (i < 10 ? -i : 10 ** (i / 250)));
		const series = chart.addSeries('line', { color: LINE });
		series.setData(values);
		chart.timeScale().fitContent();
		await settle();
		const { from, to } = range();
		expect(from).toBeCloseTo(values.value[10]!, 9);
		expect(to).toBeCloseTo(values.value[999]!, 6);
		const labels = axisLabels('default').map(Number);
		expect(labels.length).toBeGreaterThan(3);
		for (const label of labels) {
			const digits = label / 10 ** Math.floor(Math.log10(label));
			expect(Math.abs(digits * 10 - Math.round(digits * 10))).toBeLessThan(1e-6);
		}
		// Equal ratios, equal distances.
		const ten = series.priceToCoordinate(10)!;
		expect(series.priceToCoordinate(1)! - ten).toBeCloseTo(ten - series.priceToCoordinate(100)!, 6);
		expect(series.priceToCoordinate(0)).toBeNull();
		expect(series.priceToCoordinate(-3)).toBeNull();
		expect(pane().filter(call => call.name === 'lineTo').length).toBeGreaterThan(100);
		expect(chart.priceScale().getVisibleRange()!.from).toBeCloseTo(values.value[10]!, 9);
	});

	it('draws an inverted scale with higher prices lower down, candles and histograms included', async () => {
		chart.applyOptions({ priceScale: { invertScale: true } });
		const series = chart.addSeries('candlestick', {
			upColor: UP,
			downColor: DOWN,
			wickUpColor: UP,
			wickDownColor: DOWN,
		});
		series.setData(candles(1000));
		const volume = chart.addSeries('histogram', { priceScaleId: 'volume', color: '#888888', base: 0 });
		chart.priceScale('volume').applyOptions({ invertScale: true, scaleMargins: { top: 0, bottom: 0.8 } });
		volume.setData(line(1000, i => 10 + (i % 7)));
		await settle();
		expect(series.priceToCoordinate(110)!).toBeGreaterThan(series.priceToCoordinate(90)!);
		const rects = pane().filter(call => call.name === 'fillRect' && (call.fillStyle === UP || call.fillStyle === DOWN));
		const visible = chart.timeScale().getVisibleLogicalRange()!;
		expect(rects.length).toBeGreaterThanOrEqual((visible.to - visible.from) * 2 - 4);
		for (const rect of rects) {
			expect(rect.args[3]).toBeGreaterThan(0);
		}
		// Volume hangs from the top: its base row is the top of the pane, the bars grow downward.
		const bars = pane().filter(call => call.name === 'fillRect' && call.fillStyle === '#888888');
		expect(bars.length).toBeGreaterThan(50);
		for (const bar of bars) {
			expect(bar.args[1]).toBe(0);
			expect(bar.args[3]).toBeGreaterThan(0);
			expect(bar.args[3]).toBeLessThanOrEqual(80);
		}
	});

	it('scales an axis by dragging it, moves it with the pane, and resets it on a double click', async () => {
		chart.addSeries('candlestick').setData(candles(1000));
		await settle();
		const axis = axisOf('default').layer!.canvas;
		expect(axis.style.cursor).toBe('ns-resize');
		const before = range();
		const timeBefore = chart.timeScale().getVisibleLogicalRange();
		pointer(axis, 'pointerdown', 620, 100);
		pointer(chart.element(), 'pointermove', 610, 160);
		pointer(chart.element(), 'pointerup', 610, 160);
		await settle();
		expect(chart.priceScale().options().autoScale).toBe(false);
		expect(chart.options().priceScale.autoScale).toBe(false);
		const scaled = range();
		// Dragged down: more prices in view, around the same middle; the time scale did not move.
		expect(scaled.to - scaled.from).toBeGreaterThan((before.to - before.from) * 1.3);
		expect((scaled.to + scaled.from) / 2).toBeCloseTo((before.to + before.from) / 2, 9);
		expect(chart.timeScale().getVisibleLogicalRange()).toEqual(timeBefore);

		// The scale no longer follows the data: dragging the pane down shows higher prices.
		pointer(chart.element(), 'pointerdown', 300, 100);
		pointer(chart.element(), 'pointermove', 300, 140);
		pointer(chart.element(), 'pointerup', 300, 140);
		await settle();
		const moved = range();
		expect(moved.from).toBeGreaterThan(scaled.from);
		expect(moved.to - moved.from).toBeCloseTo(scaled.to - scaled.from, 9);

		axis.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		await settle();
		expect(chart.priceScale().options().autoScale).toBe(true);
		expect(range()).toEqual(before);
		// A double click on the pane does nothing to the scales.
		chart.element().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		await settle();
		expect(range()).toEqual(before);
	});

	it('reuses its arrays from frame to frame on every mode and axis', async () => {
		chart.applyOptions({
			priceScale: { mode: 'logarithmic' },
			priceScales: { left: { visible: true, position: 'left', mode: 'percentage', invertScale: true } },
		});
		const candlesSeries = chart.addSeries('candlestick');
		candlesSeries.setData(candles(5000));
		const levels = chart.addSeries('line', { priceScaleId: 'left' });
		levels.setData(line(5000, i => 1000 + (i % 100)));
		chart.timeScale().setVisibleLogicalRange({ from: 3000, to: 3200 });
		await settle();
		const arrays = () => {
			const views = [candlesSeries, levels].map(
				series => (series as unknown as { view: Record<string, unknown> }).view,
			);
			return [
				...['default', 'left'].map(id => (axisOf(id) as unknown as { tickYs: Float32Array }).tickYs),
				...views.flatMap(view =>
					['open', 'high', 'low', 'close', 'x', 'yOpen', 'yHigh', 'yLow', 'yClose'].map(key => view[key]),
				),
			];
		};
		const before = arrays();
		for (let i = 1; i <= 20; i++) {
			chart.timeScale().setVisibleLogicalRange({ from: 3000 + i * 3, to: 3200 + i * 3 });
			pointer(chart.element(), 'pointermove', 200 + i, 100 + i);
			runFrames();
		}
		await settle();
		const after = arrays();
		expect(after).toHaveLength(before.length);
		after.forEach((array, i) => expect(array).toBe(before[i]));
	});

	it('keeps an autoscaled scale in place when the pane is dragged up or down', async () => {
		chart.addSeries('candlestick').setData(candles(1000));
		await settle();
		const before = range();
		pointer(chart.element(), 'pointerdown', 300, 100);
		pointer(chart.element(), 'pointermove', 300, 180);
		pointer(chart.element(), 'pointerup', 300, 180);
		await settle();
		expect(range()).toEqual(before);
	});

	it('shows the crosshair price on every visible axis and value labels on the axis of each series', async () => {
		chart.applyOptions({ priceScales: { left: { visible: true, position: 'left' } } });
		chart.addSeries('candlestick', { upColor: UP, downColor: DOWN }).setData(candles(1000));
		const levels = chart.addSeries('line', { priceScaleId: 'left', color: LINE });
		levels.setData(line(1000, i => 1000 + (i % 100)));
		const volume = chart.addSeries('histogram', { priceScaleId: 'volume', color: '#888888' });
		volume.setData(line(1000, i => 10 + (i % 7)));
		chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
		await settle();
		const leftAxis = axisOf('left');
		const rightAxis = axisOf('default');
		const tagsAt = (axis: AxisInternals, color: string) =>
			overlay().filter(call => call.name === 'fillRect' && call.args[0] === axis.axisLeft && call.fillStyle === color);
		// The value of the line on the left axis; the candles and the overlay on the right.
		expect(tagsAt(leftAxis, LINE)).toHaveLength(1);
		expect(tagsAt(rightAxis, LINE)).toHaveLength(0);
		expect(tagsAt(rightAxis, '#888888')).toHaveLength(1);
		expect(tagsAt(rightAxis, UP).length + tagsAt(rightAxis, DOWN).length).toBe(1);

		clearCalls();
		pointer(chart.element(), 'pointermove', leftAxis.axisWidth + 200, 150);
		await settle();
		const background = themes.light.crosshair.horzLine.labelBackgroundColor;
		expect(tagsAt(leftAxis, background)).toHaveLength(1);
		expect(tagsAt(rightAxis, background)).toHaveLength(1);
		const texts = overlay()
			.filter(call => call.name === 'fillText')
			.map(call => ({ text: String(call.args[0]), x: call.args[1] as number }));
		// Each label reads its own scale at the pointer; crosshair labels come after the value labels.
		const leftTexts = texts.filter(entry => entry.x === leftAxis.axisLeft + leftAxis.axisWidth - 8);
		const leftLabel = leftTexts[leftTexts.length - 1]!;
		expect(Number(leftLabel.text)).toBeCloseTo(levels.coordinateToPrice(150)!, 2);
		const rightLabels = texts.filter(entry => entry.x === rightAxis.axisLeft + 8).map(entry => Number(entry.text));
		const pointerPrice = chart.priceScale().coordinateToPrice(150)!;
		expect(rightLabels.some(value => Math.abs(value - pointerPrice) < 0.01)).toBe(true);
	});

	it('puts an indicator on a scale of its own, and back on the scale of its source', async () => {
		chart.applyOptions({
			priceScales: { rsi: { visible: true, position: 'left', scaleMargins: { top: 0.7, bottom: 0 } } },
		});
		const series = chart.addSeries('candlestick');
		series.setData(candles(2000, 1000));
		const rsi = series.addIndicator('rsi', { priceScaleId: 'rsi' });
		const average = series.addIndicator('sma', { params: { period: 20 } });
		await settle();
		expect(rsi.options().priceScaleId).toBe('rsi');
		expect(rsi.output().options().priceScaleId).toBe('rsi');
		expect(average.output().options().priceScaleId).toBe('default');
		expect(range('default').from).toBeGreaterThan(800);
		const oscillator = range('rsi');
		expect(oscillator.from).toBeGreaterThanOrEqual(0);
		expect(oscillator.to).toBeLessThanOrEqual(100);
		expect(axisLabels('rsi').length).toBeGreaterThan(0);

		rsi.applyOptions({ priceScaleId: '' });
		await settle();
		expect(rsi.output().options().priceScaleId).toBe('default');
		expect(range('default').from).toBeLessThan(100);
		// An output's own scale wins over the indicator's in the same call.
		const macd = series.addIndicator('macd', {
			priceScaleId: 'macd',
			outputs: { histogram: { priceScaleId: 'histogram' } },
		});
		expect(macd.output('macd').options().priceScaleId).toBe('macd');
		expect(macd.output('histogram').options().priceScaleId).toBe('histogram');
	});

	it('stacks indicator and volume panes on one timeline and restores their sizes and scales', async () => {
		chart.applyOptions({
			priceScales: { oscillator: { paneWeight: 0.5, visible: true }, volume: { paneWeight: 0.5, visible: true } },
		});
		const source = chart.addSeries('candlestick', { id: 'price' });
		source.setData(candles(200));
		const rsi = source.addIndicator('rsi', { priceScaleId: 'oscillator' });
		const volume = chart.addSeries('histogram', { id: 'volume-bars', priceScaleId: 'volume' });
		volume.setData(line(200, i => i + 1));
		await settle();
		const top = (id: string) => parseFloat(canvas(id).style.top);
		const height = (id: string) => parseFloat(canvas(id).style.height);
		expect(top('oscillator')).toBe(height('default'));
		expect(top('volume')).toBe(top('oscillator') + height('oscillator'));
		expect(height('default')).toBeCloseTo(2 * height('oscillator'), 0);
		expect(chart.priceScale(rsi.output().options().priceScaleId).priceToCoordinate(50)!).toBeGreaterThan(
			top('oscillator'),
		);
		expect(volume.priceToCoordinate(100)!).toBeGreaterThan(top('volume'));
		chart.priceScale('volume').setVisibleRange({ from: 0, to: 250 });
		chart.priceScale().setVisibleRange({ from: 80, to: 120 });
		await settle();
		const before = range('volume');
		pointer(canvases()[0]!, 'pointerdown', 300, top('volume') + 10);
		pointer(canvases()[0]!, 'pointermove', 300, top('volume') + 24);
		pointer(canvases()[0]!, 'pointerup', 300, top('volume') + 24);
		await settle();
		expect(range('volume')).not.toEqual(before);
		expect(range()).toEqual({ from: 80, to: 120 });
		expect(axisLabels('oscillator').length).toBeGreaterThan(0);
		const state = chart.saveState();
		chart.priceScale('volume').applyOptions({ paneWeight: 0 });
		chart.resize(800, 600);
		await settle();
		expect(top('volume')).toBe(0);
		chart.restoreState(state);
		await settle();
		expect(chart.priceScale('volume').options().paneWeight).toBe(0.5);
		expect(top('volume')).toBeGreaterThan(top('oscillator'));
		expect(canvas('oscillator').style.left).toBe(canvas('volume').style.left);
	});

	it('separates value labels without moving the plotted prices and snaps to the nearest close', async () => {
		chart.applyOptions({ crosshair: { mode: 'nearest' } });
		const first = chart.addSeries('line', { color: '#112233', precision: 2 });
		const other = chart.addSeries('line', { color: '#445566', precision: 2 });
		first.setData(line(100, () => 100));
		other.setData(line(100, () => 101));
		await settle();
		chart.priceScale().setVisibleRange({ from: 0, to: 200 });
		clearCalls();
		await settle();
		const y1 = first.priceToCoordinate(100)!;
		const y2 = other.priceToCoordinate(101)!;
		expect(Math.abs(y1 - y2)).toBeLessThan(5);
		const labels = overlay().filter(
			call => call.name === 'fillText' && ['100.00', '101.00'].includes(String(call.args[0])),
		);
		expect(labels).toHaveLength(2);
		expect(Math.abs(Number(labels[0]!.args[2]) - Number(labels[1]!.args[2]))).toBeGreaterThanOrEqual(20);
		clearCalls();
		pointer(canvases()[0]!, 'pointermove', 500, y2);
		await settle();
		const crosshair = overlay().filter(call => call.name === 'fillText' && call.args[0] === '101.00');
		expect(crosshair.length).toBe(2);
	});
	it('formats prices by the tick size of the series', async () => {
		const series = chart.addSeries('candlestick', { minMove: 0.25 });
		const data = candles(1000);
		series.setData(data);
		await settle();
		const labels = axisLabels('default');
		expect(labels.length).toBeGreaterThan(2);
		for (const label of labels) {
			expect(label).toMatch(/^\d+\.\d\d$/);
			expect((Number(label) * 4) % 1).toBe(0);
		}
		const close = data.close[999]!;
		const texts = overlay()
			.filter(call => call.name === 'fillText')
			.map(call => String(call.args[0]));
		expect(texts).toContain((Math.round(close * 4) / 4).toFixed(2));

		clearCalls();
		series.applyOptions({ precision: 3 });
		await settle();
		expect(axisLabels('default').every(label => /^\d+\.\d{3}$/.test(label))).toBe(true);
	});

	it('sets and reads the visible range of a scale, which then stays', async () => {
		const series = chart.addSeries('line');
		series.setData(line(1000, i => 100 + (i % 50)));
		await settle();
		chart.priceScale().setVisibleRange({ from: 50, to: 250 });
		expect(chart.priceScale().options().autoScale).toBe(false);
		series.update({ time: 1000 * MINUTE, value: 400 });
		await settle();
		expect(range()).toEqual({ from: 50, to: 250 });
		expect(series.priceToCoordinate(250)).toBeCloseTo(37.2, 9);

		chart.applyOptions({ priceScale: { mode: 'logarithmic' } });
		chart.priceScale().setVisibleRange({ from: 10, to: 1000 });
		await settle();
		expect(range().from).toBeCloseTo(10, 9);
		expect(range().to).toBeCloseTo(1000, 9);
		expect(series.priceToCoordinate(100)).toBeCloseTo(186, 9);
	});

	it('takes the theme for scales without colors and keeps their options in the chart options', async () => {
		chart.priceScale('extra').applyOptions({ visible: true, position: 'left' });
		expect(chart.options().priceScales['extra']).toMatchObject({ visible: true, position: 'left', mode: 'normal' });
		expect(chart.priceScale('extra').options().borderColor).toBe(themes.light.priceScale.borderColor);
		expect(chart.priceScale('overlay').options().borderColor).toBe(themes.light.priceScale.borderColor);
		chart.applyOptions({ theme: 'dark' });
		expect(chart.priceScale('extra').options().borderColor).toBe(themes.dark.priceScale.borderColor);
		expect(chart.priceScale('overlay').options().borderColor).toBe(themes.dark.priceScale.borderColor);
		chart.priceScale().applyOptions({ invertScale: true });
		expect(chart.options().priceScale.invertScale).toBe(true);
		// `default` in the further scales is the default scale's id and is ignored there.
		chart.applyOptions({ priceScales: { default: { visible: false } } });
		expect(chart.options().priceScales['default']).toBeUndefined();
		expect(chart.priceScale().options().visible).toBe(true);
		// An axis that is hidden again gives its room back.
		chart.addSeries('line').setData(line(100, i => i));
		chart.addSeries('line', { priceScaleId: 'extra' }).setData(line(100, i => i * 2));
		await settle();
		const withAxis = paneWidth();
		const extraWidth = chart.priceScale('extra').width();
		expect(extraWidth).toBeGreaterThan(0);
		chart.priceScale('extra').applyOptions({ visible: false });
		await settle();
		expect(chart.priceScale('extra').width()).toBe(0);
		expect(paneWidth()).toBe(withAxis + extraWidth);
		expect(axisOf('extra').layer!.canvas.style.display).toBe('none');
	});

	/** The labels drawn on the overlay (value labels, crosshair labels), in drawing order. */
	const texts = (): { text: string; y: number }[] =>
		overlay()
			.filter(call => call.name === 'fillText')
			.map(call => ({ text: String(call.args[0]), y: Number(call.args[2]) }));
	const axisTexts = (): string[] => texts().map(entry => entry.text);
	/** Rows of the labels with this text. */
	const yOf = (text: string): number[] =>
		texts()
			.filter(entry => entry.text === text)
			.map(entry => entry.y);
	/** Client x of bar `bar`. */
	const at = (bar: number) =>
		chart.timeScale().logicalToCoordinate(bar)! + Number.parseFloat(canvases()[0]!.style.left);
	const scaleIds = () => (chart as unknown as ChartInternals)._axes.list.map(axis => axis.id);
	const mainHeight = () => (chart as unknown as ChartInternals)._axes.list[0]!.scale.height;
	const paneLeft = () => Number.parseFloat(canvases()[0]!.style.left);

	describe('value labels', () => {
		it('spreads labels that would overlap around their values, in value order, series order on ties', async () => {
			const a = chart.addSeries('line', { precision: 1 });
			const b = chart.addSeries('line', { precision: 2 });
			const c = chart.addSeries('line', { precision: 3 });
			const far = chart.addSeries('line', { precision: 4 });
			for (const series of [a, b, c]) series.setData(line(100, () => 100));
			far.setData(line(100, () => 160));
			await settle();
			chart.priceScale().setVisibleRange({ from: 0, to: 200 });
			clearCalls();
			await settle();
			// Labels are 20 pixels high (12 px font): equal values stack top to bottom in series
			// order, the stack centred on the value, and a label clear of the others stays on its value.
			const row = Math.round(a.priceToCoordinate(100)!);
			expect(yOf('100.0')).toEqual([row - 20]);
			expect(yOf('100.00')).toEqual([row]);
			expect(yOf('100.000')).toEqual([row + 20]);
			expect(yOf('160.0000')).toEqual([Math.round(far.priceToCoordinate(160)!)]);

			// Labels pushed against the top of the axis move down as little as they can.
			chart.priceScale().setVisibleRange({ from: 0, to: 95 });
			clearCalls();
			await settle();
			expect(yOf('100.0')).toEqual([10]);
			expect(yOf('100.00')).toEqual([30]);
			expect(yOf('100.000')).toEqual([50]);
		});

		it('drops the labels of the series drawn last when the axis cannot fit them all', async () => {
			chart.resize(640, 100);
			const all = [0, 1, 2, 3, 4].map(i => {
				const series = chart.addSeries('line', { precision: 2 });
				series.setData(line(100, () => 100 + i));
				return series;
			});
			await settle();
			// The pane is 72 pixels high: three labels of 20 fit.
			const shown = axisTexts();
			shown.sort();
			expect(shown).toEqual(['100.00', '101.00', '102.00']);
			const ys = ['102.00', '101.00', '100.00'].map(text => yOf(text)[0]!);
			expect(ys[1]! - ys[0]!).toBeGreaterThanOrEqual(20);
			expect(ys[2]! - ys[1]!).toBeGreaterThanOrEqual(20);
			expect(ys[0]! - 10).toBeGreaterThanOrEqual(0);
			expect(ys[2]! + 10).toBeLessThanOrEqual(72);
			// Hiding a series gives its place to the next.
			all[0]!.applyOptions({ visible: false });
			clearCalls();
			await settle();
			const next = axisTexts();
			next.sort();
			expect(next).toEqual(['101.00', '102.00', '103.00']);
		});

		it('draws the crosshair label last, at its own place over the value labels', async () => {
			const a = chart.addSeries('line', { precision: 1 });
			a.setData(line(100, () => 100));
			chart.addSeries('line', { precision: 3 }).setData(line(100, () => 100));
			await settle();
			chart.priceScale().setVisibleRange({ from: 0, to: 200 });
			await settle();
			const y = Math.round(a.priceToCoordinate(100)!);
			clearCalls();
			pointer(canvases()[0]!, 'pointermove', 300, y);
			await settle();
			// The value labels moved apart; the crosshair's, with the price under the pointer, is on it.
			const labels = texts();
			expect(yOf('100.0')).toEqual([y - 10, y]);
			expect(yOf('100.000')).toEqual([y + 10]);
			const crosshair = labels.map(entry => entry.text === '100.0' && entry.y === y).lastIndexOf(true);
			expect(crosshair).toBeGreaterThan(labels.findIndex(entry => entry.text === '100.000'));
		});
	});

	describe('magnet', () => {
		it('snaps to the nearest value on screen of any scale, each placed by its own scale', async () => {
			chart.applyOptions({
				crosshair: { mode: 'magnet' },
				priceScales: { left: { visible: true, position: 'left' } },
			});
			const main = chart.addSeries('line', { precision: 2 });
			main.setData(line(100, i => 100 + i));
			const other = chart.addSeries('line', { priceScaleId: 'left', precision: 3 });
			other.setData(line(100, i => 5000 - i));
			await settle();
			// At bar 80 the first series is near the top and the other near the bottom.
			const top = main.priceToCoordinate(180)!;
			const bottom = other.priceToCoordinate(4920)!;
			expect(bottom - top).toBeGreaterThan(100);
			clearCalls();
			pointer(canvases()[0]!, 'pointermove', at(80), bottom - 3);
			await settle();
			// The other series' scale shows its exact value; the default one its own value there.
			expect(axisTexts()).toContain('4920.000');
			expect(axisTexts()).not.toContain('180.00');
			clearCalls();
			pointer(canvases()[0]!, 'pointermove', at(80), top + 3);
			await settle();
			expect(axisTexts()).toContain('180.00');
			expect(axisTexts()).not.toContain('4920.000');
		});

		it('takes the open, high, low or close of a candle, and closes only in nearest mode', async () => {
			chart.applyOptions({ crosshair: { mode: 'magnet' } });
			const data = candles(1000);
			const series = chart.addSeries('candlestick', { precision: 2 });
			series.setData(data);
			await settle();
			const bar = 950;
			const low = data.low[bar]!;
			const close = data.close[bar]!;
			const y = series.priceToCoordinate(low)! + 2;
			clearCalls();
			pointer(canvases()[0]!, 'pointermove', at(bar), y);
			await settle();
			expect(axisTexts()).toContain(low.toFixed(2));
			chart.applyOptions({ crosshair: { mode: 'nearest' } });
			clearCalls();
			pointer(canvases()[0]!, 'pointermove', at(bar), y);
			await settle();
			expect(axisTexts()).toContain(close.toFixed(2));
			expect(axisTexts()).not.toContain(low.toFixed(2));
		});

		it('breaks ties by series order and leaves out values the pane does not show', async () => {
			chart.applyOptions({ crosshair: { mode: 'magnet' } });
			const first = chart.addSeries('line', { precision: 1 });
			const second = chart.addSeries('line', { precision: 3 });
			first.setData(line(100, () => 100));
			second.setData(line(100, () => 100));
			await settle();
			chart.priceScale().setVisibleRange({ from: 0, to: 200 });
			await settle();
			clearCalls();
			pointer(canvases()[0]!, 'pointermove', at(50), first.priceToCoordinate(100)! + 4);
			await settle();
			// The value label of each, and the crosshair's in the first series' format.
			expect(axisTexts().filter(text => text === '100.0')).toHaveLength(2);
			expect(axisTexts().filter(text => text === '100.000')).toHaveLength(1);

			// Above the pane, a value is out of reach however near: the one in the pane is taken. The
			// overlay draws only what changed, so the calls are those of both frames: the data's, with
			// the crosshair where it was, and the pointer's, near the value above the pane.
			clearCalls();
			second.setData(line(100, () => 230));
			first.setData(line(100, () => 185));
			await settle();
			expect(second.priceToCoordinate(230)!).toBeLessThan(0);
			pointer(canvases()[0]!, 'pointermove', at(50), 2);
			await settle();
			// The value label of the first series, and the crosshair's on its value.
			expect(axisTexts().filter(text => text === '185.0')).toHaveLength(2);
			expect(axisTexts()).not.toContain('230.000');
		});

		it('snaps within the pane under the pointer only', async () => {
			chart.applyOptions({
				crosshair: { mode: 'magnet' },
				priceScales: { lower: { visible: true, paneWeight: 0.5 } },
			});
			const main = chart.addSeries('line', { precision: 2 });
			main.setData(line(100, () => 100));
			const lower = chart.addSeries('line', { priceScaleId: 'lower', precision: 3 });
			lower.setData(line(100, i => (i === 50 ? 1000 : 0)));
			await settle();
			const boundary = Number.parseFloat(canvas('lower').style.top);
			// The lower series' value at bar 50 is at the top of its pane, just below the pointer.
			expect(lower.priceToCoordinate(1000)! - boundary).toBeLessThan(40);
			clearCalls();
			pointer(canvases()[0]!, 'pointermove', at(50), boundary - 2);
			await settle();
			expect(axisTexts()).toContain('100.00');
			expect(axisTexts()).not.toContain('1000.000');
		});
	});

	describe('removing scales', () => {
		it('removes a scale no option lists once nothing is on it, and keeps its handle valid', async () => {
			chart.addSeries('candlestick').setData(candles(1000));
			const levels = chart.addSeries('line', { priceScaleId: 'levels' });
			levels.setData(line(1000, i => 1000 + (i % 100)));
			await settle();
			const handle = chart.priceScale('levels');
			expect(levels.priceScale()).toBe(handle);
			expect(scaleIds()).toEqual(['default', 'levels']);
			// Hidden, a series still holds its scale.
			levels.applyOptions({ visible: false });
			await settle();
			expect(scaleIds()).toEqual(['default', 'levels']);
			chart.removeSeries(levels);
			await settle();
			expect(scaleIds()).toEqual(['default']);
			expect(handle.getVisibleRange()).toBeNull();
			expect(handle.width()).toBe(0);
			expect(handle.priceToCoordinate(1000)).toBeNull();
			expect(handle.coordinateToPrice(100)).toBeNull();
			expect(handle.options()).toEqual(chart.priceScale('unused').options());
			expect(handle.options().visible).toBe(false);

			// Named again, it is made again, and the old handle reads the new scale.
			const again = chart.addSeries('line', { priceScaleId: 'levels' });
			again.setData(line(1000, i => 2000 + (i % 10)));
			await settle();
			expect(scaleIds()).toEqual(['default', 'levels']);
			expect(handle.getVisibleRange()).toEqual({ from: 2000, to: 2009 });
			expect(handle.priceToCoordinate(2009)).toBe(again.priceToCoordinate(2009));
			// Moved to another scale, a series leaves its old one behind.
			again.applyOptions({ priceScaleId: 'default' });
			await settle();
			expect(scaleIds()).toEqual(['default']);
			// Writing through a handle makes the scale, listed in the options.
			handle.setVisibleRange({ from: 1, to: 2 });
			await settle();
			expect(scaleIds()).toEqual(['default', 'levels']);
			expect(chart.options().priceScales['levels']?.autoScale).toBe(false);
			expect(handle.getVisibleRange()).toEqual({ from: 1, to: 2 });
		});

		it('keeps a scale primitives or drawings are on', async () => {
			chart.addSeries('candlestick').setData(candles(1000));
			const drawing = chart.drawings().add({
				type: 'trendLine',
				points: [
					{ time: 920 * MINUTE, price: 1 },
					{ time: 980 * MINUTE, price: 2 },
				],
				priceScaleId: 'zone',
			});
			await settle();
			chart.timeScale().scrollToRealTime();
			await settle();
			expect(scaleIds()).toEqual(['default', 'zone']);
			drawing.remove();
			// Gone with the next frame that updates the chart.
			chart.applyOptions({ layout: { textColor: '#333333' } });
			await settle();
			expect(scaleIds()).toEqual(['default']);
		});

		it('keeps a listed scale with its options and range, without axis or pane while nothing is on it', async () => {
			chart.applyOptions({
				priceScales: {
					left: { visible: true, position: 'left' },
					lower: { visible: true, paneWeight: 0.5 },
				},
			});
			chart.addSeries('candlestick').setData(candles(1000));
			await settle();
			const fullWidth = paneWidth();
			const fullHeight = mainHeight();
			const time = chart.timeScale().getVisibleLogicalRange()!;
			expect(scaleIds()).toEqual(['default', 'left', 'lower']);
			expect(chart.priceScale('left').width()).toBe(0);
			expect(chart.priceScale('left').options().visible).toBe(true);
			expect(chart.priceScale('lower').options().paneWeight).toBe(0.5);
			expect(paneLeft()).toBe(0);
			expect(fullWidth).toBe(640 - chart.priceScale().width());

			const left = chart.addSeries('line', { priceScaleId: 'left' });
			left.setData(line(1000, i => 1000 + i));
			const lower = chart.addSeries('histogram', { priceScaleId: 'lower' });
			lower.setData(line(1000, i => i % 7));
			await settle();
			const leftWidth = chart.priceScale('left').width();
			expect(leftWidth).toBeGreaterThan(0);
			expect(paneLeft()).toBe(leftWidth);
			expect(canvas('left').style.display).toBe('block');
			expect(canvas('lower').style.display).toBe('block');
			expect(mainHeight()).toBeLessThan(fullHeight * 0.75);
			// The same bars stay in view as the pane narrows.
			const narrowed = chart.timeScale().getVisibleLogicalRange()!;
			expect(narrowed.from).toBeCloseTo(time.from, 6);
			expect(narrowed.to).toBeCloseTo(time.to, 6);
			chart.priceScale('left').setVisibleRange({ from: 1, to: 2 });

			chart.removeSeries(left);
			chart.removeSeries(lower);
			await settle();
			expect(scaleIds()).toEqual(['default', 'left', 'lower']);
			expect(chart.priceScale('left').width()).toBe(0);
			expect(canvas('left').style.display).toBe('none');
			expect(canvas('lower').style.display).toBe('none');
			expect(paneWidth()).toBe(fullWidth);
			expect(mainHeight()).toBe(fullHeight);
			expect(chart.priceScale('left').getVisibleRange()).toEqual({ from: 1, to: 2 });
			expect(chart.saveState().view!.priceRanges['left']).toEqual({ from: 1, to: 2 });
		});

		it('removes a listed scale on request: its options and range go, what is on it stays as an overlay', async () => {
			chart.applyOptions({ priceScales: { lower: { visible: true, paneWeight: 0.5 } } });
			chart.addSeries('candlestick').setData(candles(1000));
			const lower = chart.addSeries('line', { priceScaleId: 'lower' });
			lower.setData(line(1000, i => 10 + (i % 5)));
			await settle();
			const split = mainHeight();
			chart.priceScale('lower').setVisibleRange({ from: 0, to: 100 });
			chart.removePriceScale('default');
			chart.removePriceScale('unknown');
			expect(chart.priceScale().options().visible).toBe(true);
			chart.removePriceScale('lower');
			await settle();
			expect(chart.options().priceScales).toEqual({});
			expect(chart.saveState().options?.priceScales ?? {}).toEqual({});
			expect(chart.saveState().view!.priceRanges['lower']).toBeUndefined();
			expect(scaleIds()).toEqual(['default', 'lower']);
			expect(mainHeight()).toBeGreaterThan(split);
			expect(chart.priceScale('lower').options()).toMatchObject({ visible: false, paneWeight: 0, autoScale: true });
			expect(chart.priceScale('lower').getVisibleRange()).toEqual({ from: 10, to: 14 });
			chart.removeSeries(lower);
			await settle();
			expect(scaleIds()).toEqual(['default']);
			// Nothing keeps the removed scale, or the series that was last on it.
			const parts = chart as unknown as {
				_overlayRenderer: { tags: Map<{ id: string }, unknown> };
				_axes: { list: { id: string }[] };
			};
			expect([...parts._overlayRenderer.tags.keys()].map(axis => axis.id)).not.toContain('lower');
			const handle = chart.priceScale('lower') as unknown as { first: unknown };
			expect(handle.first ?? null).toBeNull();
		});
	});

	describe('wheel and pinch on an axis', () => {
		it('scales the axis under the wheel or a trackpad pinch around the price there, and time over the pane', async () => {
			chart.addSeries('candlestick').setData(candles(1000));
			await settle();
			const axis = canvas('default');
			const time = chart.timeScale().getVisibleLogicalRange();
			const before = range();
			const y = 120;
			const price = chart.priceScale().coordinateToPrice(y)!;
			expect(wheelAt(axis, 610, y, -100).defaultPrevented).toBe(true);
			await settle();
			expect(chart.priceScale().options().autoScale).toBe(false);
			const zoomed = range();
			expect(zoomed.to - zoomed.from).toBeCloseTo((before.to - before.from) * Math.exp(-100 * 0.002), 9);
			expect(chart.priceScale().priceToCoordinate(price)).toBeCloseTo(y, 6);
			expect(chart.timeScale().getVisibleLogicalRange()).toEqual(time);

			// A trackpad pinch (the wheel with the control key); fingers closing show more.
			wheelAt(axis, 610, 300, 20, { ctrlKey: true });
			await settle();
			const pinched = range();
			expect(pinched.to - pinched.from).toBeCloseTo((zoomed.to - zoomed.from) * Math.exp(20 * 0.01), 9);
			expect(chart.timeScale().getVisibleLogicalRange()).toEqual(time);

			// Over the pane, the wheel zooms time and leaves the price scale alone.
			wheelAt(canvases()[0]!, 300, y, -100);
			await settle();
			expect(chart.timeScale().getVisibleLogicalRange()).not.toEqual(time);
			expect(range()).toEqual(pinched);

			axis.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
			await settle();
			expect(chart.priceScale().options().autoScale).toBe(true);
		});

		it('scales the axis with two fingers that start on it, around the price between them', async () => {
			chart.addSeries('candlestick').setData(candles(1000));
			await settle();
			const axis = canvas('default');
			const time = chart.timeScale().getVisibleLogicalRange();
			const before = range();
			const price = chart.priceScale().coordinateToPrice(250)!;
			touch(axis, 'pointerdown', 1, 610, 150);
			touch(chart.element(), 'pointerdown', 2, 610, 250);
			touch(chart.element(), 'pointermove', 2, 610, 350);
			await settle();
			// The fingers went from 100 to 200 pixels apart: half the range, around the price between them.
			const pinched = range();
			expect(pinched.to - pinched.from).toBeCloseTo((before.to - before.from) / 2, 9);
			expect(chart.priceScale().priceToCoordinate(price)).toBeCloseTo(250, 6);
			expect(chart.priceScale().options().autoScale).toBe(false);
			expect(chart.timeScale().getVisibleLogicalRange()).toEqual(time);
			// The finger left goes on scaling the axis, and nothing scrolls on release.
			touch(chart.element(), 'pointerup', 2, 610, 350);
			touch(chart.element(), 'pointermove', 1, 610, 190);
			touch(chart.element(), 'pointerup', 1, 610, 190);
			await settle();
			expect(range().to - range().from).toBeGreaterThan(pinched.to - pinched.from);
			expect(chart.timeScale().getVisibleLogicalRange()).toEqual(time);
		});
	});
});

describe('spreadLabels', () => {
	it('leaves labels that overlap nothing where they want to be', () => {
		expect(spread([], 20, 0, 100)).toEqual([]);
		expect(spread([40], 20, 0, 100)).toEqual([40]);
		expect(spread([0, 20, 55, 80], 20, 0, 100)).toEqual([0, 20, 55, 80]);
	});

	it('moves overlapping labels apart around the mean of their values, as little as it can', () => {
		expect(spread([40, 40], 20, 0, 200)).toEqual([30, 50]);
		expect(spread([40, 40, 40], 20, 0, 200)).toEqual([20, 40, 60]);
		// Two clusters that join once spread: one block around the mean of all four.
		expect(spread([40, 45, 70, 75], 20, 0, 200)).toEqual([28, 48, 68, 88]);
		// Halves round the same way for every label of a block, so they stay apart.
		expect(spread([10, 11], 20, 0, 200)).toEqual([1, 21]);
	});

	it('keeps labels inside the axis and fills it when they just fit', () => {
		expect(spread([-5, 0], 20, 0, 100)).toEqual([0, 20]);
		expect(spread([85, 90], 20, 0, 100)).toEqual([60, 80]);
		expect(spread([50, 50, 50, 50, 50], 20, 0, 100)).toEqual([0, 20, 40, 60, 80]);
		expect(spread([300, 310], 20, 100, 200)).toEqual([160, 180]);
	});

	it('works in place', () => {
		const tops = [40, 40, 90];
		spreadLabels(tops, 3, 20, 0, 200, tops);
		expect(tops).toEqual([30, 50, 90]);
	});

	it('places random labels in order, apart, inside, and as near as the best placement on whole pixels', () => {
		let seed = 7;
		const random = () => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed / 2147483648;
		};
		const size = 10;
		const bottom = 40;
		for (let round = 0; round < 60; round++) {
			const count = 1 + Math.floor(random() * 3);
			const wanted = Array.from({ length: count }, () => Math.floor(random() * 50) - 5);
			wanted.sort((a, b) => a - b);
			const tops = spread(wanted, size, 0, bottom);
			expect(tops.every(Number.isInteger)).toBe(true);
			expect(tops[0]!).toBeGreaterThanOrEqual(0);
			expect(tops[count - 1]! + size).toBeLessThanOrEqual(bottom);
			for (let i = 1; i < count; i++) {
				expect(tops[i]! - tops[i - 1]!).toBeGreaterThanOrEqual(size);
			}
			// Every placement on whole pixels, for comparison.
			let best = Infinity;
			const place = (i: number, from: number, chosen: number[]): void => {
				if (i === count) {
					best = Math.min(best, cost(chosen, wanted));
					return;
				}
				for (let top = from; top + (count - i) * size <= bottom; top++) {
					place(i + 1, top + size, [...chosen, top]);
				}
			};
			place(0, 0, []);
			// Rounding moves each label by half a pixel at most from the best placement in reals.
			expect(cost(tops, wanted)).toBeLessThanOrEqual(best + count * 0.25 + 1e-9);
		}
	});
});
