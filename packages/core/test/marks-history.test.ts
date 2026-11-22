import type { HeatmapOptions, HeatmapSeriesApi, PanePrimitive, PaneView, ScatterSeriesApi } from '@lumen-charts/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeWorker } from '../../engine/test/fake-worker';
import { MINUTE, TestChart, candles } from './drawing-helpers';

/** Stands in for `ImageData`, which the test environment lacks. */
class FakeImageData {
	public readonly data: Uint8ClampedArray;
	public constructor(
		public readonly width: number,
		public readonly height: number,
	) {
		this.data = new Uint8ClampedArray(width * height * 4);
	}
}

class Probe implements PanePrimitive {
	public view: PaneView | null = null;
	public update(view: PaneView): void {
		this.view = view;
	}
	public draw(): void {}
}

/** A chart of candles whose mark series draw through Canvas 2D pixel buffers, which a test can read. */
class Chart extends TestChart {
	public readonly probe = new Probe();

	public constructor(options: ConstructorParameters<typeof TestChart>[0] = {}) {
		super({ markRenderer: 'canvas2d', ...options });
		this.chart.attachPrimitive(this.probe);
	}

	/** The pixels the series whose canvas got pixels last holds, as of its last full or partial hand-over. */
	public pixels(): Uint32Array {
		const layers = new Set(this.canvases());
		const surfaces = [...this.recorders.keys()].filter(canvas => !layers.has(canvas));
		let image: FakeImageData | null = null;
		for (const canvas of surfaces) {
			for (const call of this.calls(canvas)) {
				if (call.name === 'putImageData') {
					image = call.args[0] as FakeImageData;
				}
			}
		}
		return image === null ? new Uint32Array(0) : new Uint32Array(image.data.buffer.slice(0));
	}

	public lit(): number {
		return this.pixels().filter(pixel => pixel !== 0).length;
	}
}

/**
 * A book of `columns` columns a minute apart from bar `first`, `rows` cells each, whose lowest cell
 * wanders with the price: as a grid that follows the price (`priceStart` per column), and as the
 * same cells on one grid spanning every column, with no value where a column has no cell.
 */
function book(columns: number, rows: number, first = 100) {
	const time = new Float64Array(columns);
	const starts = new Float64Array(columns);
	const values = new Float32Array(columns * rows);
	const offsets: number[] = [];
	let offset = 0;
	for (let c = 0; c < columns; c++) {
		offset += [0, 1, -1, 2, 0, -2, 1][c % 7]!;
		offsets.push(offset);
		time[c] = (first + c) * MINUTE;
		starts[c] = 90 + offset * 0.5;
		for (let r = 0; r < rows; r++) {
			values[c * rows + r] = r === 2 && c % 3 === 0 ? Number.NaN : (c * 7 + r * 11) % 50;
		}
	}
	const low = Math.min(...offsets);
	const span = Math.max(...offsets) - low + rows;
	const wide = new Float32Array(columns * span).fill(Number.NaN);
	for (let c = 0; c < columns; c++) {
		wide.set(values.subarray(c * rows, (c + 1) * rows), c * span + offsets[c]! - low);
	}
	return {
		following: { priceStart: starts, priceStep: 0.5, rows, time, values },
		fixed: { priceStart: 90 + low * 0.5, priceStep: 0.5, rows: span, time, values: wide },
		low: 90 + low * 0.5,
		high: 90 + (low + span) * 0.5,
	};
}

/** A chart of candles with one heatmap of `data`, the view on bars 90 to 260. */
async function draw(
	data: ReturnType<typeof book>['fixed'] | ReturnType<typeof book>['following'],
	options: Partial<HeatmapOptions> = {},
): Promise<{ t: Chart; heat: HeatmapSeriesApi }> {
	const t = new Chart();
	t.chart.addSeries('candlestick').setData(candles(300));
	const heat = t.chart.addSeries('heatmap', { valueMin: 0, valueMax: 50, ...options }) as HeatmapSeriesApi;
	heat.setData(data);
	t.chart.timeScale().setVisibleLogicalRange({ from: 90, to: 260 });
	await t.settle();
	return { t, heat };
}

describe('a heatmap grid that follows the price', () => {
	beforeEach(() => {
		vi.stubGlobal('ImageData', FakeImageData);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	for (const [name, options] of [
		['slots', {}],
		['values', { valueMin: null, valueMax: null }],
	] as const) {
		it(`draws the cells each column has, as one grid over all of them would (from its ${name})`, async () => {
			const data = book(120, 6);
			const a = await draw(data.following, options);
			const b = await draw(data.fixed, options);
			try {
				expect(a.t.lit()).toBeGreaterThan(1000);
				expect(a.t.pixels()).toEqual(b.t.pixels());
				// The value at a point is that of the column's own cell there.
				for (const [time, price] of [
					[100.5, 90.2],
					[130.5, 91.1],
					[150.5, 93.4],
					[219.5, 89.6],
					[160.5, 80],
				] as const) {
					expect(a.heat.valueAt(time * MINUTE, price)).toBe(b.heat.valueAt(time * MINUTE, price));
				}
			} finally {
				a.t.destroy();
				b.t.destroy();
			}
		});
	}

	it('fits the prices of the columns in view when alone on its scale', async () => {
		const data = book(120, 6);
		const { t, heat } = await draw(data.following, { priceScaleId: 'book', autoscale: true });
		try {
			const top = heat.coordinateToPrice(0)!;
			const bottom = heat.coordinateToPrice(t.probe.view!.height)!;
			expect(top).toBeGreaterThanOrEqual(data.high - 1e-9);
			expect(bottom).toBeLessThanOrEqual(data.low + 1e-9);
			// Not much more than the rows the columns span.
			expect(top - bottom).toBeLessThan((data.high - data.low) * 1.5);
		} finally {
			t.destroy();
		}
	});

	it('takes a column on rows of its own as an update, as a set of all columns would draw it', async () => {
		const after = book(121, 6);
		const whole = await draw(after.following);
		const expected = whole.t.pixels();
		whole.t.destroy();
		vi.stubGlobal('ImageData', FakeImageData);
		const { t, heat } = await draw(book(120, 6).following);
		try {
			const column = after.following.values.subarray(120 * 6, 121 * 6);
			heat.update({ time: 220 * MINUTE, values: column, priceStart: after.following.priceStart[120]! });
			await t.settle();
			expect(t.pixels()).toEqual(expected);
			// Off the grid of the series: refused before anything is sent.
			expect(() => heat.update({ time: 221 * MINUTE, values: column, priceStart: 90.3 })).toThrow(RangeError);
		} finally {
			t.destroy();
		}
	});
});

/** Draws with a fresh chart of candles and the view on bars 90 to 310, and returns its pixels. */
async function picture(
	worker: boolean,
	build: (t: Chart) => Promise<void> | void,
): Promise<{ pixels: Uint32Array; marks: number }> {
	vi.stubGlobal('ImageData', FakeImageData);
	vi.stubGlobal('Worker', FakeWorker);
	const t = new Chart({ worker: worker ? () => new FakeWorker() as unknown as Worker : false });
	try {
		t.chart.addSeries('candlestick').setData(candles(300));
		t.chart.timeScale().setVisibleLogicalRange({ from: 90, to: 310 });
		await build(t);
		await t.settle();
		const series = t.chart.markSeries()[0]!;
		return { pixels: t.pixels(), marks: series.drawn().marks };
	} finally {
		t.destroy();
	}
}

function scatter(t: Chart): ScatterSeriesApi {
	return t.chart.addSeries('scatter', { autoscale: false }) as ScatterSeriesApi;
}

function addHeat(t: Chart): HeatmapSeriesApi {
	return t.chart.addSeries('heatmap', { valueMin: 0, valueMax: 50 }) as HeatmapSeriesApi;
}

/** Trades every 20 seconds from bar `from / 3`, for points `[from, to)`. */
function points(from: number, to: number) {
	const time: number[] = [];
	const price: number[] = [];
	const value: number[] = [];
	for (let i = from; i < to; i++) {
		time.push(i * 20_000);
		price.push(100 + Math.sin(i / 7) * 3);
		value.push((i * 13) % 40);
	}
	return { time, price, value };
}

function join(...parts: ReturnType<typeof points>[]) {
	return {
		time: parts.flatMap(part => part.time),
		price: parts.flatMap(part => part.price),
		value: parts.flatMap(part => part.value),
	};
}

describe('older marks, and marks removed', () => {
	beforeEach(() => {
		vi.stubGlobal('ImageData', FakeImageData);
		vi.stubGlobal('Worker', FakeWorker);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		FakeWorker.behavior = 'ok';
	});

	for (const worker of [false, true]) {
		const engine = worker ? 'in a worker' : 'on the main thread';

		it(`draws prepended points once the view reaches them, and leaves removed ones out, with the engine ${engine}`, async () => {
			const all = await picture(worker, t => scatter(t).setData(points(300, 900)));
			const prepended = await picture(worker, async t => {
				const series = scatter(t);
				series.setData(points(600, 900));
				await t.settle();
				const before = t.lit();
				series.prepend(points(300, 600));
				await t.settle();
				expect(t.lit()).toBeGreaterThan(before);
			});
			expect(prepended.pixels).toEqual(all.pixels);
			expect(prepended.marks).toBe(all.marks);
			const kept = await picture(worker, t => scatter(t).setData(join(points(300, 400), points(501, 900))));
			const removed = await picture(worker, async t => {
				const series = scatter(t);
				series.setData(points(300, 900));
				await t.settle();
				series.removeMarks({ from: 400 * 20_000, to: 500 * 20_000 });
				expect(() => series.removeMarks({ from: 2, to: 1 })).toThrow(RangeError);
			});
			expect(removed.pixels).toEqual(kept.pixels);
		});

		it(`prepends and removes heatmap columns, with the engine ${engine}`, async () => {
			const data = book(150, 5, 100).following;
			const part = (...ranges: [number, number][]) => {
				const columns = ranges.flatMap(([from, to]) => Array.from({ length: to - from }, (_, i) => from + i));
				const values = new Float32Array(columns.length * 5);
				columns.forEach((c, i) => values.set(data.values.subarray(c * 5, c * 5 + 5), i * 5));
				return {
					...data,
					priceStart: Float64Array.from(columns, c => data.priceStart[c]!),
					time: Float64Array.from(columns, c => data.time[c]!),
					values,
				};
			};
			const all = await picture(worker, t => addHeat(t).setData(data));
			const prepended = await picture(worker, async t => {
				const series = addHeat(t);
				series.setData(part([60, 150]));
				await t.settle();
				series.prepend(part([0, 60]));
			});
			expect(prepended.pixels).toEqual(all.pixels);
			const kept = await picture(worker, t => addHeat(t).setData(part([0, 20], [30, 150])));
			const removed = await picture(worker, async t => {
				const series = addHeat(t);
				series.setData(data);
				await t.settle();
				series.removeMarks({ from: 120 * MINUTE, to: 129 * MINUTE });
			});
			expect(removed.pixels).toEqual(kept.pixels);
		});
	}
});

/** Trades every second for `count` points, at bars a minute apart. */
function history(count: number) {
	const time = new Float64Array(count);
	const price = new Float64Array(count);
	const value = new Float32Array(count);
	for (let i = 0; i < count; i++) {
		time[i] = i * 1000;
		price[i] = 100 + Math.sin(i / 3000) * 4 + ((i * 7) % 11) * 0.01;
		value[i] = (i * 13) % 50;
	}
	return { time, price, value };
}

/** The points of `data` with times in `[from, to]`, as a datafeed returns them. */
function slice(data: ReturnType<typeof history>, from: number, to: number) {
	const first = data.time.findIndex(t => t >= from);
	let end = first;
	while (end < data.time.length && data.time[end]! <= to) {
		end++;
	}
	return {
		time: data.time.slice(first, end),
		price: data.price.slice(first, end),
		value: data.value.slice(first, end),
	};
}

type ScatterColumnsData = ReturnType<typeof slice>;

/**
 * A chart whose scatter of 400,000 points is viewed at its end, then zoomed into older points:
 * under `limit` with `getMarks` as its datafeed, those points were let go and are fetched back.
 */
async function zoomed(
	limit: number,
	getMarks: ((from: number, to: number) => Promise<ScatterColumnsData>) | null,
): Promise<{ pixels: Uint32Array; level: number; calls: number; warnings: string[] }> {
	vi.stubGlobal('ImageData', FakeImageData);
	const t = new Chart({ memoryLimit: limit });
	// The chart's own `destroy` restores every mock: the warnings are read before it.
	const warnings: string[] = [];
	vi.spyOn(console, 'warn').mockImplementation((message: string) => {
		warnings.push(message);
	});
	try {
		const data = history(400_000);
		t.chart.addSeries('candlestick').setData(candles(7000));
		let calls = 0;
		const datafeed =
			getMarks === null
				? undefined
				: {
						getMarks: ({ from, to }: { from: number; to: number }) => {
							calls++;
							return getMarks(from, to);
						},
					};
		const series = t.chart.addSeries('scatter', { autoscale: false, datafeed });
		series.setData(data);
		// The newest points in view: the older ones go.
		t.chart.timeScale().setVisibleLogicalRange({ from: 6600, to: 6680 });
		await t.settle();
		// Into points that were let go.
		t.chart.timeScale().setVisibleLogicalRange({ from: 2500, to: 2540 });
		await t.settle();
		return { pixels: t.pixels(), level: series.drawn().level, calls, warnings };
	} finally {
		t.destroy();
	}
}

describe('marks fetched again from a datafeed under the memory limit', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it('draws a view of marks let go from a level, then from the marks fetched back', async () => {
		const data = history(400_000);
		const reference = await zoomed(Infinity, null);
		expect(reference.level).toBe(0);
		expect(reference.calls).toBe(0);
		const fetched = await zoomed(1, (from, to) => Promise.resolve(slice(data, from, to)));
		expect(fetched.calls).toBeGreaterThan(0);
		expect(fetched.level).toBe(0);
		expect(fetched.pixels).toEqual(reference.pixels);
	});

	it('keeps drawing from a level while the datafeed fails, warns of marks that differ, and asks again later', async () => {
		const data = history(400_000);
		const failing = await zoomed(1, () => Promise.reject(new Error('offline')));
		expect(failing.calls).toBeGreaterThan(0);
		expect(failing.level).toBeGreaterThan(0);
		expect(failing.warnings).toEqual([]);
		const wrong = await zoomed(1, (from, to) => {
			const marks = slice(data, from, to);
			marks.price[3] = marks.price[3]! + 1;
			return Promise.resolve(marks);
		});
		expect(wrong.level).toBeGreaterThan(0);
		expect(wrong.warnings).toEqual([expect.stringContaining('do not match')]);
	});
});

describe('indicators over heatmap and scatter series', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('read a column of a scatter per bar, follow trades as they come, and go with the series', async () => {
		vi.stubGlobal('ImageData', FakeImageData);
		const t = new Chart();
		try {
			const candlesSeries = t.chart.addSeries('candlestick', { id: 'bars' });
			candlesSeries.setData(candles(100));
			const trades = t.chart.addSeries('scatter', { id: 'trades' });
			// Three trades in the last bar, of 2, 3 and 5 at 101, 102 and 104.
			trades.setData({
				time: [99 * MINUTE + 1000, 99 * MINUTE + 2000, 99 * MINUTE + 3000],
				price: [101, 102, 104],
				value: [2, 3, 5],
			});
			const count = candlesSeries.addIndicator('sma', {
				id: 'trade-count',
				params: { period: 1 },
				inputs: [{ series: trades, column: 'count' }],
			});
			const vwap = candlesSeries.addIndicator('sma', {
				params: { period: 1 },
				inputs: [{ series: trades, column: 'vwap' }],
			});
			await t.settle();
			expect(count.output().lastValue()).toBe(3);
			expect(vwap.output().lastValue()).toBeCloseTo((2 * 101 + 3 * 102 + 5 * 104) / 10, 12);
			trades.update({ time: 99 * MINUTE + 4000, price: 100, value: 10 });
			await t.settle();
			expect(count.output().lastValue()).toBe(4);
			// A column a scatter does not have.
			expect(() =>
				candlesSeries.addIndicator('sma', { inputs: [{ series: trades, column: 'center' as 'count' }] }),
			).toThrow(RangeError);
			// Saved by the series' id and the column, and restored onto the same series.
			const state = t.chart.saveState();
			expect(state.indicators!.find(entry => entry.id === 'trade-count')!.inputs).toEqual([
				{ series: 'trades', column: 'count' },
			]);
			t.chart.restoreState(state);
			await t.settle();
			const restored = t.chart.indicators().find(entry => entry.id === 'trade-count')!;
			expect(restored.output().lastValue()).toBe(4);
			// A state that reads a column a heatmap does not have is refused.
			const wrong = JSON.parse(JSON.stringify(state)) as typeof state;
			wrong.indicators![0]!.inputs = [{ series: 'trades', column: 'center' as 'close' }];
			expect(() => t.chart.restoreState(wrong)).toThrow(/must be one of count/);
			t.chart.removeSeries(trades);
			expect(t.chart.indicators()).toEqual([]);
		} finally {
			t.destroy();
		}
	});
});

describe('a chart whose timeline comes from its marks', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('draws a heatmap without bars, one bar per column, and lists nothing of its timeline', async () => {
		vi.stubGlobal('ImageData', FakeImageData);
		const t = new Chart();
		try {
			const depth = t.chart.addSeries('heatmap', { timeline: true, valueMin: 0, valueMax: 50, autoscale: true });
			const columns = 120;
			const time = Float64Array.from({ length: columns }, (_, c) => c * 90_000);
			depth.setData({
				priceStart: 99,
				priceStep: 0.5,
				rows: 8,
				time,
				values: Float32Array.from({ length: columns * 8 }, (_, i) => i % 50),
			});
			t.chart.timeScale().fitContent();
			await t.settle();
			expect(t.lit()).toBeGreaterThan(1000);
			expect(t.chart.series()).toEqual([]);
			expect(t.chart.timeScale().getVisibleLogicalRange()!.to).toBeGreaterThanOrEqual(columns - 1);
			// A bar per column: the column at bar 60 is at the time of column 60.
			expect(t.probe.view!.timeToX(60 * 90_000)).toBeCloseTo(t.probe.view!.logicalToX(60), 6);
			depth.update({ time: columns * 90_000, values: new Float32Array(8).fill(7) });
			await t.settle();
			expect(t.probe.view!.timeToX(columns * 90_000)).toBeCloseTo(t.probe.view!.logicalToX(columns), 6);
			expect(JSON.stringify(t.chart.saveState().series)).not.toContain('"line"');
			t.chart.removeSeries(depth);
			await t.settle();
			expect(t.chart.markSeries()).toEqual([]);
		} finally {
			t.destroy();
		}
	});

	it('draws trades without bars, a bar for each minute that has trades', async () => {
		vi.stubGlobal('ImageData', FakeImageData);
		const t = new Chart();
		try {
			const trades = t.chart.addSeries('scatter', { timeline: { interval: MINUTE } });
			trades.setData({ time: [5000, 20_000, 3 * MINUTE, 3 * MINUTE + 1, 7 * MINUTE], price: [100, 101, 102, 103, 99] });
			t.chart.timeScale().fitContent();
			await t.settle();
			expect(t.lit()).toBeGreaterThan(0);
			const view = t.probe.view!;
			// Minutes 0, 3 and 7 are bars 0, 1 and 2.
			expect(view.timeToX(3 * MINUTE)).toBeCloseTo(view.logicalToX(1), 6);
			expect(view.timeToX(7 * MINUTE)).toBeCloseTo(view.logicalToX(2), 6);
			expect(() => t.chart.addSeries('scatter', { timeline: { interval: 0 } })).toThrow(RangeError);
		} finally {
			t.destroy();
		}
	});
});

describe('restoring a chart with marks', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('keeps the timeline a heatmap makes through a restore, and lets it go with the heatmap', async () => {
		vi.stubGlobal('ImageData', FakeImageData);
		const t = new Chart();
		try {
			const depth = t.chart.addSeries('heatmap', { id: 'depth', timeline: true, valueMin: 0, valueMax: 50 });
			depth.setData({
				priceStart: 99,
				priceStep: 0.5,
				rows: 8,
				time: Float64Array.from({ length: 120 }, (_, c) => c * 90_000),
				values: Float32Array.from({ length: 960 }, (_, i) => i % 50),
			});
			t.chart.addSeries('line', { id: 'overlay' });
			await t.settle();
			t.chart.restoreState(t.chart.saveState());
			await t.settle();
			// Still drawn on its own bars: bar 60 is at the time of column 60.
			const view = t.probe.view!;
			expect(view.timeToX(60 * 90_000)).toBeCloseTo(view.logicalToX(60), 6);
			const removed = vi.spyOn(EngineClientPrototype(t), 'removeSeries');
			t.chart.removeSeries(depth);
			await t.settle();
			// The heatmap's own timeline goes with it.
			expect(removed).toHaveBeenCalledTimes(1);
		} finally {
			t.destroy();
		}
	});

	it('removes the indicators that read a heatmap or scatter a restore removes', async () => {
		vi.stubGlobal('ImageData', FakeImageData);
		const t = new Chart();
		try {
			const bars = t.chart.addSeries('candlestick', { id: 'bars' });
			bars.setData(candles(50));
			const state = t.chart.saveState();
			const trades = t.chart.addSeries('scatter', { id: 'trades' });
			trades.setData({ time: [49 * MINUTE + 1000], price: [100] });
			bars.addIndicator('sma', { id: 'count', params: { period: 1 }, inputs: [{ series: trades, column: 'count' }] });
			await t.settle();
			t.chart.restoreState(state, { parts: ['series'] });
			await t.settle();
			expect(t.chart.markSeries()).toEqual([]);
			expect(t.chart.indicators()).toEqual([]);
			// What is saved now restores.
			expect(() => t.chart.restoreState(t.chart.saveState())).not.toThrow();
		} finally {
			t.destroy();
		}
	});
});

/** The prototype of the chart's engine client, to watch the commands it sends. */
function EngineClientPrototype(t: Chart): { removeSeries(id: number): void } {
	const engine = (t.chart as unknown as { _data: { engine: object } })._data.engine;
	return engine as { removeSeries(id: number): void };
}
