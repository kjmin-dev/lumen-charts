import { type ChartApi, createChart, themes } from '@lumen-charts/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
	const axisOf = (id: string) => (chart as unknown as { _axesById: Map<string, AxisInternals> })._axesById.get(id)!;
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
});
