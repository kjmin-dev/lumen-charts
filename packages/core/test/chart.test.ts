import { type ChartApi, type DatafeedRequest, createChart, themes } from '@lumen-charts/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { timeZone } from '../src/model/time-zone';

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
		chart.applyOptions({ layout: { background: '#000000' } });
		chart.applyOptions({ layout: { background: '#111111' } });
		chart.resize(500, 250);
		expect(frames.length).toBe(scheduled);
		chart.destroy();
	});

	it('does not schedule a frame when options are unchanged', () => {
		const chart = createChart(container, { autoSize: false, width: 400, height: 200 });
		for (const frame of frames.splice(0)) {
			frame();
		}
		chart.applyOptions({ width: 400, height: 200, layout: { background: '#ffffff' } });
		expect(frames.length).toBe(0);
		chart.applyOptions({ layout: { background: '#222222' } });
		expect(frames.length).toBe(1);
		chart.destroy();
	});

	it('ignores undefined option values', () => {
		const chart = createChart(container, { autoSize: false, width: 400, height: 200 });
		chart.applyOptions({ width: undefined });
		expect(chart.options().width).toBe(400);
		chart.destroy();
	});

	it('merges nested options and ignores a nested value equal to the current one', () => {
		const chart = createChart(container, { autoSize: false, width: 400, height: 200 });
		for (const frame of frames.splice(0)) {
			frame();
		}
		chart.applyOptions({ grid: { vertLines: { visible: false } } });
		expect(chart.options().grid.vertLines.visible).toBe(false);
		expect(chart.options().grid.vertLines.color).toBe(themes.light.grid.vertLines.color);
		expect(chart.options().grid.horzLines.visible).toBe(true);
		frames.splice(0);
		chart.applyOptions({ grid: { vertLines: { visible: false } }, layout: {} });
		expect(frames.length).toBe(0);
		chart.destroy();
	});

	it('follows the system color scheme while the theme is auto', () => {
		const view = container.ownerDocument.defaultView!;
		const listeners = new Set<() => void>();
		const scheme = { dark: false };
		vi.spyOn(view, 'matchMedia').mockImplementation((query: string) => {
			const watched = query.includes('prefers-color-scheme');
			return {
				media: query,
				get matches() {
					return watched && scheme.dark;
				},
				addEventListener: (_type: string, listener: () => void) => {
					if (watched) {
						listeners.add(listener);
					}
				},
				removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
			} as unknown as MediaQueryList;
		});
		const chart = createChart(container, { autoSize: false, width: 400, height: 200, theme: 'auto' });
		expect(chart.theme()).toBe('light');
		expect(chart.options().layout.background).toBe(themes.light.layout.background);
		for (const frame of frames.splice(0)) {
			frame();
		}

		scheme.dark = true;
		for (const listener of listeners) {
			listener();
		}
		expect(chart.theme()).toBe('dark');
		expect(chart.options().layout.background).toBe(themes.dark.layout.background);
		expect(frames.length).toBe(1);

		chart.applyOptions({ theme: 'light' });
		expect(chart.theme()).toBe('light');
		expect(listeners.size).toBe(0);
		chart.destroy();
		vi.restoreAllMocks();
	});

	it('removes its element on destroy and tolerates repeated calls', () => {
		const chart = createChart(container);
		chart.destroy();
		chart.destroy();
		expect(container.childElementCount).toBe(0);
		chart.applyOptions({ layout: { background: '#333333' } });
		expect(chart.options().layout.background).toBe('#ffffff');
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

const idOf = (series: unknown): number => (series as { id: number }).id;
const tasks = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/** Engine and datafeed tasks, a few rounds of them. */
const someTasks = async (rounds = 6): Promise<void> => {
	if (rounds > 0) {
		await tasks();
		await someTasks(rounds - 1);
	}
};
const everyFifth = (_: number, i: number): boolean => i % 5 === 0;
/** UTC milliseconds of a crosshair label `YYYY-MM-DD HH:MM`. */
const labelTime = (label: string): number => Date.parse(`${label.replace(' ', 'T')}:00Z`);
const outsideRemoved = (_: number, i: number): boolean => i < 90_010 || i > 90_019;

describe('chart with series', () => {
	let container: HTMLDivElement;
	let frames: ((now: number) => void)[];
	let recorders: Map<HTMLCanvasElement, ReturnType<typeof recorder>>;
	let chart: ChartApi;
	let now = 0;

	const layer = (index: number) => recorders.get(chart.element().querySelectorAll('canvas')[index]!)!;
	const pane = () => layer(0);
	const priceAxis = () => layer(1);
	const timeAxis = () => layer(2);
	const overlay = () => layer(3);
	const axisLabels = (): string[] =>
		timeAxis()
			.calls.filter(call => call.name === 'fillText')
			.map(call => String(call.args[0]));
	const crosshairLabels = (): string[] =>
		overlay()
			.calls.filter(call => call.name === 'fillText')
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

	const cacheOf = () =>
		(chart as unknown as { _cache: { raw: { start: number; count: number; blocks: Map<number, Float64Array> } } })
			._cache.raw;

	const internals = () =>
		chart as unknown as {
			_cache: { held(level: number): { count: number } | null };
			_drawn: { level: number } | null;
			_geometry: { to: number; shift: number; firstRow: number };
			_axes: { scale: { min: number; max: number } }[];
		};

	it('draws a wide view from a coarse level, exactly scaled, without holding raw rows', async () => {
		const count = 300_000;
		const data = candles(count);
		const main = chart.addSeries('candlestick', { upColor: UP, downColor: DOWN, wickUpColor: UP, wickDownColor: DOWN });
		main.setData(data);
		// A secondary line with a spike far above the candles, in a single bar.
		const spiked = data.close.slice();
		spiked[123_457] = 500;
		const line = chart.addSeries('line', { color: '#123456' });
		line.setData({ time: data.time, value: spiked });
		chart.timeScale().fitContent();
		await settle();
		const { _cache, _drawn, _geometry, _axes } = internals();
		const priceScale = _axes[0]!.scale;
		expect(_drawn!.level).toBeGreaterThanOrEqual(1);
		expect(_cache.held(0)).toBeNull();
		// The price range is exactly that of the rows drawn, spike included.
		const drawnTo = Math.min(count, _geometry.to * 2 ** _geometry.shift);
		let low = Infinity;
		let high = -Infinity;
		for (let i = _geometry.firstRow; i < drawnTo; i++) {
			low = Math.min(low, data.low[i]!, spiked[i]!);
			high = Math.max(high, data.high[i]!, spiked[i]!);
		}
		expect([priceScale.min, priceScale.max]).toEqual([low, high]);
		expect(high).toBe(500);
		const paneWidth = chart.element().querySelectorAll('canvas')[0]!.width;
		expect(candleRects().length).toBeLessThanOrEqual(paneWidth + 1);
		const lineTos = pane().calls.filter(call => call.name === 'lineTo').length;
		expect(lineTos).toBeLessThanOrEqual(4 * paneWidth);

		// A tick on the last bar reaches the bucket on screen.
		const last = count - 1;
		main.update({ time: data.time[last]!, open: data.open[last]!, high: 900, low: data.low[last]!, close: 120 });
		await settle();
		expect(priceScale.max).toBe(900);

		// Zoomed in, the chart draws raw rows again and lets go of the coarse level.
		const level = _drawn!.level;
		chart.timeScale().setVisibleLogicalRange({ from: 1000, to: 1100 });
		await settle();
		expect(internals()._drawn!.level).toBe(0);
		expect(_cache.held(level)).toBeNull();
		expect(_cache.held(0)!.count).toBeGreaterThan(100);
	});

	const datafeedBars = 200_000;
	const datafeedData = candles(datafeedBars);
	const coreOf = () =>
		(chart as unknown as { _engine: { _transport: { _core: { memory: { evictable: number; bytes: number } } } } })
			._engine._transport._core;
	/** Lets the engine finish building levels and letting rows go, between frames. */
	const idleEngine = async (rounds = 50): Promise<void> => {
		if (rounds > 0) {
			await tasks();
			return idleEngine(rounds - 1);
		}
		return settle();
	};
	const rawRows = (from: number, to: number): number[] => {
		const raw = cacheOf();
		const block = raw.blocks.get(1)!;
		return [...block.subarray(from - raw.start, to - raw.start)];
	};

	describe('with a datafeed and a memory limit', () => {
		const count = datafeedBars;
		const data = datafeedData;

		it('fetches bars it let go when the view comes back to them', async () => {
			chart.applyOptions({ memoryLimit: 1 });
			const requests: { from: number; to: number; countBack: number }[] = [];
			const line = chart.addSeries('line', {
				datafeed: {
					getBars: request => {
						requests.push(request);
						const start = data.time.indexOf(request.from);
						const end = data.time.indexOf(request.to) + 1;
						// A feed may send more than asked for; the extra bars are ignored.
						return new Promise(resolve =>
							setTimeout(
								() =>
									resolve({ time: data.time.slice(start - 3, end + 3), value: data.close.slice(start - 3, end + 3) }),
								0,
							),
						);
					},
				},
			});
			line.setData({ time: data.time, value: data.close });
			await idleEngine();
			expect(coreOf().memory.evictable).toBe(0);
			expect(coreOf().memory.bytes).toBeLessThan(count * 16);

			chart.timeScale().setVisibleLogicalRange({ from: 50_000, to: 50_200 });
			await settle();
			expect(requests.length).toBeGreaterThan(0);
			const first = requests[0]!;
			expect(first.countBack).toBe(data.time.indexOf(first.to) - data.time.indexOf(first.from) + 1);
			expect(internals()._drawn!.level).toBe(0);
			expect(rawRows(50_000, 50_200)).toEqual([...data.close.subarray(50_000, 50_200)]);
		});

		it('refuses bars that do not match the ones let go, warns, and keeps drawing a level', async () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			chart.applyOptions({ memoryLimit: 1 });
			const line = chart.addSeries('line', {
				datafeed: {
					getBars: request => {
						const start = data.time.indexOf(request.from);
						const end = data.time.indexOf(request.to) + 1;
						// One bar missing.
						return Promise.resolve({ time: data.time.slice(start, end - 1), value: data.close.slice(start, end - 1) });
					},
				},
			});
			line.setData({ time: data.time, value: data.close });
			await idleEngine();
			chart.timeScale().setVisibleLogicalRange({ from: 50_000, to: 50_200 });
			await settle();
			expect(warn).toHaveBeenCalled();
			expect(String(warn.mock.calls[0]![0])).toMatch(/do not match/);
			// What is on screen comes from the finest level, which still holds that history.
			expect(internals()._drawn!.level).toBe(1);
			expect(pane().calls.filter(call => call.name === 'lineTo').length).toBeGreaterThan(5);
		});

		it('survives a datafeed that fails, and a destroy while bars are on their way', async () => {
			chart.applyOptions({ memoryLimit: 1 });
			let calls = 0;
			let release: (() => void) | null = null;
			const line = chart.addSeries('line', {
				datafeed: {
					getBars: () => {
						calls++;
						if (calls === 1) {
							return Promise.reject(new Error('offline'));
						}
						return new Promise(resolve => {
							release = () => resolve({ time: [], value: [] });
						});
					},
				},
			});
			line.setData({ time: data.time, value: data.close });
			await idleEngine();
			chart.timeScale().setVisibleLogicalRange({ from: 50_000, to: 50_200 });
			await settle();
			expect(calls).toBe(1);
			expect(internals()._drawn!.level).toBe(1);

			// Elsewhere in history, a request that never comes back before the chart is destroyed.
			chart.timeScale().setVisibleLogicalRange({ from: 120_000, to: 120_200 });
			runFrames();
			await tasks();
			await tasks();
			expect(calls).toBe(2);
			const idle = chart.whenIdle();
			chart.destroy();
			await idle;
			release!();
			await tasks();
		});

		/** Bars of `data` a request asks for, as a line. */
		const barsFor = (request: DatafeedRequest, source: { time: Float64Array; close: Float64Array } = data) => {
			const start = source.time.indexOf(request.from);
			const end = source.time.indexOf(request.to) + 1;
			return { time: source.time.slice(start, end), value: source.close.slice(start, end) };
		};

		it('draws bars fetched again in the first frame after the view changed', async () => {
			chart.applyOptions({ memoryLimit: 1 });
			let calls = 0;
			const line = chart.addSeries('line', {
				datafeed: {
					getBars: request => {
						calls++;
						return Promise.resolve(barsFor(request));
					},
				},
			});
			line.setData({ time: data.time, value: data.close });
			await idleEngine();
			expect(frames.length).toBe(0);
			chart.timeScale().setVisibleLogicalRange({ from: 80_000, to: 80_200 });
			// The window is asked for when the view changes: the engine and the datafeed answer before
			// the frame, which then draws the bars instead of a coarser level.
			await someTasks();
			expect(calls).toBeGreaterThan(0);
			runFrames();
			expect(internals()._drawn!.level).toBe(0);
			expect(rawRows(80_000, 80_200)).toEqual([...data.close.subarray(80_000, 80_200)]);
		});

		it('aborts a request once the view moved away from its bars, and ignores what it still brings', async () => {
			chart.applyOptions({ memoryLimit: 1 });
			const out: { request: DatafeedRequest; resolve: (bars: ReturnType<typeof barsFor>) => void }[] = [];
			let instant = false;
			const line = chart.addSeries('line', {
				datafeed: {
					getBars: request =>
						instant
							? Promise.resolve(barsFor(request))
							: new Promise(resolve => {
									out.push({ request, resolve });
								}),
				},
			});
			line.setData({ time: data.time, value: data.close });
			await idleEngine();
			chart.timeScale().setVisibleLogicalRange({ from: 50_000, to: 50_200 });
			runFrames();
			await someTasks();
			const old = out.splice(0);
			expect(old.length).toBeGreaterThan(0);
			expect(old.some(entry => entry.request.signal.aborted)).toBe(false);
			// The view jumps far away before the bars come: nothing needs them any more.
			instant = true;
			chart.timeScale().setVisibleLogicalRange({ from: 150_000, to: 150_200 });
			runFrames();
			await someTasks();
			expect(old.every(entry => entry.request.signal.aborted)).toBe(true);
			for (const entry of old) {
				entry.resolve(barsFor(entry.request));
			}
			await settle();
			expect(internals()._drawn!.level).toBe(0);
			expect(rawRows(150_000, 150_200)).toEqual([...data.close.subarray(150_000, 150_200)]);
			expect((chart as unknown as { _fetches: Map<number, unknown> })._fetches.size).toBe(0);
		});

		it('aborts every request when the history is replaced, the series removed or the chart destroyed', async () => {
			chart.applyOptions({ memoryLimit: 1 });
			const signals: AbortSignal[] = [];
			const datafeed = {
				getBars: (request: DatafeedRequest) => {
					signals.push(request.signal);
					return new Promise<never>(() => {});
				},
			};
			const outstanding = async (from: number): Promise<AbortSignal[]> => {
				chart.timeScale().setVisibleLogicalRange({ from, to: from + 200 });
				runFrames();
				await someTasks();
				const list = signals.splice(0);
				expect(list.length).toBeGreaterThan(0);
				expect(list.some(signal => signal.aborted)).toBe(false);
				return list;
			};
			const first = chart.addSeries('line', { datafeed });
			first.setData({ time: data.time, value: data.close });
			await idleEngine();
			const beforeReload = await outstanding(50_000);
			first.setData({ time: data.time, value: data.close });
			expect(beforeReload.every(signal => signal.aborted)).toBe(true);
			await idleEngine();
			const beforeRemove = await outstanding(60_000);
			chart.removeSeries(first);
			expect(beforeRemove.every(signal => signal.aborted)).toBe(true);
			const second = chart.addSeries('line', { datafeed });
			second.setData({ time: data.time, value: data.close });
			await idleEngine();
			const beforeDestroy = await outstanding(70_000);
			chart.destroy();
			expect(beforeDestroy.every(signal => signal.aborted)).toBe(true);
		});

		it('switches to another resolution with a new history and datafeed', async () => {
			chart.applyOptions({ memoryLimit: 1 });
			const minute: DatafeedRequest[] = [];
			const line = chart.addSeries('line', {
				datafeed: {
					getBars: request => {
						minute.push(request);
						return new Promise(() => {});
					},
				},
			});
			line.setData({ time: data.time, value: data.close });
			await idleEngine();
			chart.timeScale().setVisibleLogicalRange({ from: 50_000, to: 50_200 });
			runFrames();
			await someTasks();
			expect(minute.length).toBeGreaterThan(0);
			// Five-minute bars, from a datafeed that serves them.
			const five = { time: data.time.filter(everyFifth), close: data.close.filter(everyFifth) };
			const asked: DatafeedRequest[] = [];
			line.setData(
				{ time: five.time, value: five.close },
				{
					datafeed: {
						getBars: request => {
							asked.push(request);
							return Promise.resolve(barsFor(request, five));
						},
					},
				},
			);
			expect(minute.every(request => request.signal.aborted)).toBe(true);
			const before = minute.length;
			await idleEngine();
			chart.timeScale().setVisibleLogicalRange({ from: 10_000, to: 10_200 });
			await settle();
			expect(asked.length).toBeGreaterThan(0);
			expect(minute.length).toBe(before);
			expect(internals()._drawn!.level).toBe(0);
			expect(rawRows(10_000, 10_200)).toEqual([...five.close.subarray(10_000, 10_200)]);
		});

		it('corrects and removes bars let go through the series', async () => {
			chart.applyOptions({ memoryLimit: 1 });
			// The source: it has the correction, and the bars removed are gone from it.
			const source = { time: data.time.slice(), close: data.close.slice() };
			const line = chart.addSeries('line', {
				datafeed: { getBars: request => Promise.resolve(barsFor(request, source)) },
			});
			line.setData({ time: data.time, value: data.close });
			await idleEngine();
			// A correction of a bar let go waits for its chunk, which is fetched at once; so does a
			// deletion in the middle, which moves the bars on its shorter side (here the older ones).
			source.close[90_000] = 1234;
			line.update({ time: data.time[90_000]!, value: 1234 });
			source.time = source.time.filter(outsideRemoved);
			source.close = source.close.filter(outsideRemoved);
			line.removeBars({ from: data.time[90_010]!, to: data.time[90_019]! });
			await settle();
			chart.timeScale().setVisibleLogicalRange({ from: 89_990, to: 90_030 });
			await settle();
			const raw = (
				chart as unknown as {
					_cache: { raw: { start: number; count: number; time: Float64Array; blocks: Map<number, Float64Array> } };
				}
			)._cache.raw;
			const times = [...raw.time.subarray(0, raw.count)];
			const block = raw.blocks.get(idOf(line))!;
			expect(block[times.indexOf(data.time[90_000]!)]).toBe(1234);
			expect(times.filter(time => time >= data.time[90_010]! && time <= data.time[90_019]!)).toEqual([]);
			// The bar before the gap and the one after it are neighbors now.
			const before = times.indexOf(data.time[90_009]!);
			expect(times[before + 1]).toBe(data.time[90_020]);
			expect(raw.start + before).toBe(90_019);
		});
	});

	it('keeps a secondary value sent with the second of two new main bars', async () => {
		const data = candles(1000);
		const main = chart.addSeries('candlestick');
		main.setData(data);
		const line = chart.addSeries('line');
		line.setData({ time: data.time, value: data.close });
		await settle();
		const t1 = data.time[999]! + MINUTE;
		const t2 = t1 + MINUTE;
		// One task: two new candles, then the line's value for the newest one.
		main.update({ time: t1, open: 100, high: 101, low: 99, close: 100.5 });
		main.update({ time: t2, open: 100.5, high: 102, low: 100, close: 101 });
		line.update({ time: t2, value: 123 });
		await settle();
		const cache = cacheOf();
		const row = 1001 - cache.start;
		expect(row).toBeLessThan(cache.count);
		expect(cache.blocks.get(idOf(line))![row]).toBe(123);
	});

	it('does not show a bar whose secondary values a racing snapshot left out', async () => {
		const data = candles(5000);
		const main = chart.addSeries('candlestick');
		main.setData(data);
		const line = chart.addSeries('line');
		line.setData({ time: data.time, value: data.close });
		await settle();

		const time = data.time[4999]! + MINUTE;
		// A new bar on both series, still buffered in the client.
		main.update({ time, open: 100, high: 101, low: 99, close: 100.5 });
		line.update({ time, value: 123 });
		// In the same task the user zooms out, so the next frame requests a window ending at the
		// end the client knows. The snapshot that comes back stops one bar short of the new bar.
		const wheel = new WheelEvent('wheel', { deltaY: 300, bubbles: true, cancelable: true });
		Object.defineProperty(wheel, 'clientX', { value: 500 });
		chart.element().dispatchEvent(wheel);
		runFrames();
		await tasks();
		await tasks();
		// Before the next frame, a tick updates only the main bar.
		main.update({ time, open: 100, high: 101.5, low: 99, close: 100.7 });
		await tasks();
		await tasks();
		await settle();
		// Then the main series moves on; the line does not tick again.
		main.update({ time: time + MINUTE, open: 100, high: 101, low: 99, close: 100.2 });
		await settle();

		const cache = cacheOf();
		const row = 5000 - cache.start;
		expect(row).toBeLessThan(cache.count);
		expect(cache.blocks.get(idOf(line))![row]).toBe(123);
	});

	it('follows the last value while the last bar is outside the cached window', async () => {
		const data = candles(100_000);
		const series = chart.addSeries('candlestick');
		series.setData(data);
		await settle();
		chart.timeScale().setVisibleLogicalRange({ from: 1000, to: 1100 });
		await settle();
		const cache = cacheOf();
		expect(cache.start + cache.count).toBeLessThan(100_000);
		const last = 99_999;
		const close = data.open[last]! + 7.25;
		series.update({ time: data.time[last]!, open: data.open[last]!, high: close, low: data.low[last]!, close });
		await settle();
		expect((series as unknown as { lastValue: number }).lastValue).toBe(close);
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
	it('switches theme colors and keeps the colors set explicitly', async () => {
		chart.addSeries('candlestick').setData(candles(1000));
		chart.applyOptions({ grid: { horzLines: { color: '#ff00ff' } } });
		await settle();
		chart.applyOptions({ theme: 'dark' });
		expect(chart.theme()).toBe('dark');
		const dark = chart.options();
		expect(dark.layout.background).toBe(themes.dark.layout.background);
		expect(dark.grid.vertLines.color).toBe(themes.dark.grid.vertLines.color);
		expect(dark.grid.horzLines.color).toBe('#ff00ff');
		clearCalls();
		await settle();
		expect(pane().calls[0]).toMatchObject({ name: 'fillRect', fillStyle: themes.dark.layout.background });
		expect(priceAxis().calls[0]).toMatchObject({ name: 'fillRect', fillStyle: themes.dark.layout.background });
		expect(pane().calls.some(call => call.fillStyle === '#ff00ff')).toBe(true);

		chart.applyOptions({ theme: 'light' });
		expect(chart.options().layout.background).toBe(themes.light.layout.background);
		expect(chart.options().grid.horzLines.color).toBe('#ff00ff');
	});

	it('puts the price axis on the left and maps the pointer into the pane', async () => {
		chart.addSeries('candlestick').setData(candles(5000));
		await settle();
		clearCalls();
		chart.applyOptions({ priceScale: { position: 'left' } });
		await settle();
		const canvases = chart.element().querySelectorAll('canvas');
		const axisWidth = Number.parseFloat(canvases[1]!.style.width);
		expect(axisWidth).toBeGreaterThan(0);
		expect(canvases[1]!.style.left).toBe('0px');
		expect(canvases[0]!.style.left).toBe(`${axisWidth}px`);
		// Labels end next to the border that faces the pane.
		const labels = priceAxis().calls.filter(call => call.name === 'fillText');
		expect(labels.length).toBeGreaterThan(2);
		for (const label of labels) {
			expect(label.args[1]).toBe(canvases[1]!.width - 8);
		}

		clearCalls();
		pointer('pointermove', axisWidth + 100, 150);
		await settle();
		// The vertical crosshair line is drawn as 1-pixel-wide dashes near the pointer.
		const column = overlay().calls.filter(call => call.name === 'fillRect' && call.args[2] === 1 && call.args[1] === 0);
		expect(column.length).toBe(1);
		expect(Math.abs((column[0]!.args[0] as number) - (axisWidth + 100))).toBeLessThanOrEqual(3);
		// The price label sits on the axis at the left edge.
		const tags = overlay().calls.filter(
			call => call.name === 'fillRect' && call.args[0] === 0 && call.args[2] === axisWidth,
		);
		expect(tags.length).toBeGreaterThanOrEqual(1);
	});

	it('gives the pane the whole chart when both axes are hidden', async () => {
		chart.addSeries('candlestick').setData(candles(1000));
		chart.applyOptions({ priceScale: { visible: false }, timeScale: { visible: false } });
		await settle();
		const canvases = chart.element().querySelectorAll('canvas');
		expect(canvases[0]!.style.width).toBe('640px');
		expect(canvases[0]!.style.height).toBe('400px');
		expect(canvases[1]!.style.display).toBe('none');
		expect(canvases[2]!.style.display).toBe('none');
		clearCalls();
		pointer('pointermove', 200, 150);
		await settle();
		// Neither the last value nor the crosshair has an axis to put a label on.
		expect(overlay().calls.filter(call => call.name === 'fillText')).toHaveLength(0);
		expect(priceAxis().calls).toHaveLength(0);

		chart.applyOptions({ priceScale: { visible: true }, timeScale: { visible: true } });
		await settle();
		expect(canvases[1]!.style.display).toBe('block');
		expect(Number.parseFloat(canvases[0]!.style.width)).toBeLessThan(640);
	});

	it('draws dashed grid lines as one stroke and leaves out hidden ones', async () => {
		chart.addSeries('candlestick').setData(candles(1000));
		await settle();
		clearCalls();
		chart.applyOptions({ grid: { vertLines: { visible: false }, horzLines: { style: 'dashed', color: '#abcdef' } } });
		await settle();
		const calls = pane().calls;
		expect(calls.filter(call => call.name === 'stroke')).toHaveLength(1);
		expect(calls.find(call => call.name === 'setLineDash')?.args[0]).toEqual([3, 3]);
		expect(calls.filter(call => call.name === 'moveTo').length).toBeGreaterThan(2);
		expect(calls.filter(call => call.fillStyle === themes.light.grid.vertLines.color)).toHaveLength(0);
	});

	it('snaps the crosshair to the close in magnet mode, and hides it', async () => {
		const data = candles(5000);
		chart.addSeries('candlestick').setData(data);
		chart.applyOptions({ crosshair: { mode: 'magnet' } });
		await settle();
		clearCalls();
		pointer('pointermove', 200, 37);
		await settle();
		const range = chart.timeScale().getVisibleLogicalRange()!;
		const paneWidth = Number.parseFloat(chart.element().querySelectorAll('canvas')[0]!.style.width);
		const index = Math.round(range.from + (200 / paneWidth) * (range.to - range.from));
		const labels = overlay()
			.calls.filter(call => call.name === 'fillText')
			.map(call => call.args[0]);
		expect(labels).toContain(data.close[index]!.toFixed(2));

		chart.applyOptions({ crosshair: { mode: 'hidden' } });
		expect(chart.element().style.cursor).toBe('default');
		clearCalls();
		pointer('pointermove', 210, 40);
		await settle();
		// Only the last value label is left.
		expect(overlay().calls.filter(call => call.name === 'fillText')).toHaveLength(1);
	});

	it('hides a series, and shows its value label without the price line', async () => {
		const series = chart.addSeries('candlestick', {
			upColor: UP,
			downColor: DOWN,
			wickUpColor: UP,
			wickDownColor: DOWN,
		});
		series.setData(candles(1000));
		await settle();
		const colored = (): Call[] =>
			overlay().calls.filter(call => call.name === 'fillRect' && (call.fillStyle === UP || call.fillStyle === DOWN));
		// The dashed price line is many rectangles; the label is one.
		expect(colored().length).toBeGreaterThan(10);
		series.applyOptions({ priceLineVisible: false });
		clearCalls();
		await settle();
		expect(colored()).toHaveLength(1);

		series.applyOptions({ visible: false });
		clearCalls();
		await settle();
		expect(candleRects()).toHaveLength(0);
		expect(overlay().calls.filter(call => call.name === 'fillText')).toHaveLength(0);

		series.applyOptions({ visible: true });
		clearCalls();
		await settle();
		expect(candleRects().length).toBeGreaterThan(50);
	});

	it('outlines candle bodies with one stroke per color and can leave out wicks', async () => {
		const BORDER = '#0000ff';
		const series = chart.addSeries('candlestick', {
			upColor: UP,
			downColor: DOWN,
			wickUpColor: UP,
			wickDownColor: DOWN,
			borderVisible: true,
			borderUpColor: BORDER,
			borderDownColor: BORDER,
		});
		series.setData(candles(1000));
		await settle();
		clearCalls();
		chart.timeScale().setVisibleLogicalRange({ from: 900, to: 999 });
		await settle();
		const calls = pane().calls;
		const outlines = calls.filter(call => call.name === 'rect');
		expect(outlines.length).toBeGreaterThan(50);
		expect(calls.filter(call => call.name === 'stroke')).toHaveLength(2);
		// Each outline is laid half a pixel inside its body, and the fill one pixel inside.
		const fills = calls.filter(call => call.name === 'fillRect' && (call.fillStyle === UP || call.fillStyle === DOWN));
		for (const outline of outlines.slice(0, 10)) {
			const [x, y, width] = outline.args as number[];
			const fill = fills.find(call => call.args[0] === x! + 0.5 && call.args[1] === y! + 0.5);
			expect(fill?.args[2]).toBe(width! - 1);
		}
		// Wicks stop at the body, so a transparent body shows no wick through it.
		const bodyWidth = (outlines[0]!.args[2] as number) + 1;
		const wicks = fills.filter(call => call.args[2] !== bodyWidth - 2);
		for (const wick of wicks) {
			const inside = outlines.some(outline => {
				const [x, y, , height] = outline.args as number[];
				const wickTop = wick.args[1] as number;
				const wickBottom = wickTop + (wick.args[3] as number);
				return (wick.args[0] as number) > x! && wickTop >= y! + 0.5 && wickBottom <= y! + 0.5 + height!;
			});
			expect(inside).toBe(false);
		}

		series.applyOptions({ wickVisible: false, borderVisible: false });
		clearCalls();
		await settle();
		const bodies = candleRects();
		expect(bodies.length).toBeGreaterThan(50);
		expect(bodies.every(call => call.args[2] === bodyWidth)).toBe(true);
	});

	it('draws step and dashed lines, and a marker under the crosshair', async () => {
		const data = candles(500);
		const line = chart.addSeries('line', { lineType: 'step', lineStyle: 'dashed' });
		line.setData({ time: data.time, value: data.close });
		await settle();
		const lineTos = (): number => pane().calls.filter(call => call.name === 'lineTo').length;
		const dashes = pane().calls.filter(call => call.name === 'setLineDash');
		expect(dashes[0]!.args[0]).toEqual([6, 6]);
		expect(dashes.at(-1)!.args[0]).toEqual([]);
		const step = lineTos();

		line.applyOptions({ lineType: 'simple', lineStyle: 'solid' });
		clearCalls();
		await settle();
		expect(step).toBe(2 * lineTos());
		expect(pane().calls.filter(call => call.name === 'setLineDash')).toHaveLength(0);

		clearCalls();
		pointer('pointermove', 200, 150);
		await settle();
		expect(overlay().calls.filter(call => call.name === 'arc')).toHaveLength(2);
		line.applyOptions({ crosshairMarkerVisible: false });
		clearCalls();
		await settle();
		expect(overlay().calls.filter(call => call.name === 'arc')).toHaveLength(0);
	});

	it('draws a watermark behind the series', async () => {
		chart.addSeries('candlestick').setData(candles(500));
		await settle();
		clearCalls();
		chart.applyOptions({ watermark: { visible: true, text: 'LUMEN\n1D' } });
		await settle();
		const calls = pane().calls;
		const texts = calls.filter(call => call.name === 'fillText').map(call => call.args[0]);
		expect(texts).toEqual(['LUMEN', '1D']);
		const lastText = calls.map(call => call.name).lastIndexOf('fillText');
		const firstCandle = calls.findIndex(call => call.name === 'fillRect' && call.fillStyle === '#26a69a');
		expect(lastText).toBeLessThan(firstCandle);
	});

	describe('time zones and sessions', () => {
		/** One-minute candles from 2024-03-08 05:00 UTC (00:00 in New York) across the change to EDT. */
		const START = Date.UTC(2024, 2, 8, 5);

		it('changes the time zone at run time: axis, crosshair, and back', async () => {
			chart.addSeries('candlestick').setData(candles(4 * 1440, START));
			chart.timeScale().setVisibleLogicalRange({ from: 1400, to: 1800 });
			await settle();
			// 04:20 to 11:00 UTC on 9 March.
			const utc = axisLabels();
			expect(utc).toContain('06:00');
			expect(utc).not.toContain('9');
			pointer('pointermove', 300, 100);
			await settle();
			const utcCrosshair = crosshairLabels().find(label => /^2024-03-0\d \d\d:\d\d$/.test(label))!;

			clearCalls();
			chart.applyOptions({ localization: { timeZone: 'America/New_York' } });
			await settle();
			// The same bars, five hours earlier on the wall clock: 23:20 on the 8th to 06:00 on the 9th.
			const newYork = axisLabels();
			expect(newYork).not.toEqual(utc);
			expect(newYork).toContain('9');
			expect(newYork).toContain('01:00');
			const shifted = crosshairLabels().find(label => /^2024-03-0\d \d\d:\d\d$/.test(label))!;
			expect(labelTime(utcCrosshair) - labelTime(shifted)).toBe(5 * 3_600_000);
			expect(chart.options().localization.timeZone).toBe('America/New_York');

			clearCalls();
			chart.applyOptions({ localization: { timeZone: 'UTC' } });
			await settle();
			expect(axisLabels()).toEqual(utc);
		});

		it('looks offsets up when the zone changes or bars arrive, not in the frames that draw them', async () => {
			const zone = timeZone('Asia/Seoul');
			chart.addSeries('candlestick').setData(candles(20_000, START));
			chart.timeScale().setVisibleLogicalRange({ from: 5000, to: 5400 });
			await settle();
			const before = zone.samples;
			chart.applyOptions({ localization: { timeZone: 'Asia/Seoul' } });
			// The table was built in the call, for the bars on screen.
			expect(zone.samples).toBeGreaterThan(before);
			const built = zone.samples;
			await settle();
			// Across the whole history, one view at a time.
			const panFrom = async (from: number): Promise<void> => {
				if (from < 19_000) {
					chart.timeScale().setVisibleLogicalRange({ from, to: from + 1000 });
					await settle();
					await panFrom(from + 1900);
				}
			};
			await panFrom(0);
			expect(zone.samples).toBe(built);
		});

		it('refuses an unknown time zone or a malformed schedule and keeps the options', async () => {
			chart.addSeries('candlestick').setData(candles(500, START));
			await settle();
			chart.applyOptions({ localization: { timeZone: 'Europe/Berlin' } });
			expect(() => chart.applyOptions({ localization: { timeZone: 'Atlantis/Capital' } })).toThrow(RangeError);
			expect(() =>
				chart.applyOptions({ sessions: { schedule: { hours: [{ start: '09:30', end: '25:00' }] } } }),
			).toThrow(RangeError);
			expect(() => chart.applyOptions({ localization: { locale: 'not a locale!' } })).toThrow(RangeError);
			expect(chart.options().localization.timeZone).toBe('Europe/Berlin');
			expect(chart.options().sessions.schedule.hours).toEqual([]);
			expect(() => createChart(container, { localization: { timeZone: 'Atlantis/Capital' } })).toThrow(RangeError);
		});

		it('formats with a locale and the application formatters', async () => {
			chart.addSeries('candlestick').setData(candles(3 * 1440, START));
			chart.timeScale().setVisibleLogicalRange({ from: 0, to: 3 * 1440 });
			chart.applyOptions({
				localization: { tickMarkFormatter: (_time, kind) => (kind === 'day' ? 'D' : null) },
			});
			await settle();
			expect(axisLabels()).toContain('D');
			expect(axisLabels()).toContain('12:00');
			chart.applyOptions({
				localization: { locale: 'en-US', tickMarkFormatter: null, timeFormatter: (time: number) => `t${time}` },
			});
			await settle();
			expect(axisLabels().some(label => label.endsWith('PM'))).toBe(true);
			clearCalls();
			pointer('pointermove', 300, 100);
			await settle();
			expect(crosshairLabels().some(label => /^t\d+$/.test(label))).toBe(true);
		});

		it('draws session breaks and shades extended hours, and answers session queries', async () => {
			// Extended equity hours in New York: 04:00 to 20:00, so 16 hours of bars a day.
			const days = [8, 11, 12];
			const time: number[] = [];
			for (const day of days) {
				const open = Date.UTC(2024, 2, day, day < 10 ? 9 : 8);
				for (let i = 0; i < 16 * 60; i++) {
					time.push(open + i * MINUTE);
				}
			}
			const data = candles(time.length);
			data.time.set(time);
			chart.addSeries('candlestick').setData(data);
			chart.timeScale().fitContent();
			chart.applyOptions({
				localization: { timeZone: 'America/New_York' },
				sessions: {
					schedule: {
						timeZone: 'America/New_York',
						hours: [
							{ start: '04:00', end: '09:30', kind: 'pre' },
							{ start: '09:30', end: '16:00' },
							{ start: '16:00', end: '20:00', kind: 'post' },
						],
					},
					breaks: { visible: true, color: '#ff00ff', style: 'solid' },
					extendedHours: { color: '#00ffff' },
				},
			});
			await settle();
			const calls = pane().calls;
			const breaks = calls.filter(call => call.name === 'fillRect' && call.fillStyle === '#ff00ff');
			expect(breaks).toHaveLength(2);
			// Three days: pre-market of the first, post and pre where two days meet (twice), and the last
			// post-market.
			const shades = calls.filter(call => call.name === 'fillRect' && call.fillStyle === '#00ffff');
			expect(shades).toHaveLength(4);
			const firstCandle = calls.findIndex(call => call.name === 'fillRect' && call.fillStyle === '#26a69a');
			expect(calls.indexOf(shades[3]!)).toBeLessThan(firstCandle);
			expect(calls.indexOf(breaks[1]!)).toBeLessThan(firstCandle);
			// The second day starts at bar 960: the break sits at its left edge, between the shades.
			const breakX = breaks[0]!.args[0] as number;
			const shadeLeft = shades[1]!.args[0] as number;
			const shadeRight = shadeLeft + (shades[1]!.args[2] as number);
			expect(breakX).toBeGreaterThan(shadeLeft);
			expect(breakX).toBeLessThan(shadeRight);
			// The axis names the days after their trading day.
			expect(axisLabels()).toEqual(expect.arrayContaining(['11', '12']));

			const scale = chart.timeScale();
			expect(scale.isInSession(Date.parse('2024-03-11T13:30:00Z'))).toBe(true);
			expect(scale.isInSession(Date.parse('2024-03-10T13:30:00Z'))).toBe(false);
			expect(scale.sessionAt(Date.parse('2024-03-11T13:30:00Z'))).toEqual({
				index: 1,
				kind: 'regular',
				tradingDay: '2024-03-11',
			});

			// Hidden decorations, then no schedule: always in session.
			chart.applyOptions({ sessions: { breaks: { visible: false }, extendedHours: { visible: false } } });
			clearCalls();
			await settle();
			expect(pane().calls.filter(call => call.fillStyle === '#ff00ff' || call.fillStyle === '#00ffff')).toHaveLength(0);
			chart.applyOptions({ sessions: { schedule: { hours: [] } } });
			expect(scale.isInSession(Date.parse('2024-03-10T13:30:00Z'))).toBe(true);
			expect(scale.sessionAt(Date.parse('2024-03-10T13:30:00Z'))).toBeNull();
		});

		it('shows daily bars as their UTC dates in any time zone', async () => {
			const data = candles(400, Date.UTC(2023, 0, 2));
			for (let i = 0; i < 400; i++) {
				data.time[i] = Date.UTC(2023, 0, 2) + i * 86_400_000;
			}
			chart.addSeries('candlestick').setData(data);
			chart.applyOptions({ localization: { timeZone: 'America/Los_Angeles' } });
			chart.timeScale().fitContent();
			await settle();
			expect(axisLabels()).toContain('2024');
			pointer('pointermove', 300, 100);
			await settle();
			expect(crosshairLabels().some(label => label.endsWith(' 00:00'))).toBe(true);
		});
	});
});
