import type {
	ChartState,
	HeatmapSeriesApi,
	MarkSeriesState,
	PanePrimitive,
	PaneView,
	ScatterSeriesApi,
} from '@lumen-charts/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeWorker } from '../../engine/test/fake-worker';
import { buildPalette, packColor } from '../src/marks/palette';
import { type Call, MINUTE, TestChart, candles } from './drawing-helpers';

/** Stands in for `ImageData`, which the test environment lacks: the pixels a series hands to its canvas. */
class FakeImageData {
	public readonly data: Uint8ClampedArray;
	public constructor(
		public readonly width: number,
		public readonly height: number,
	) {
		this.data = new Uint8ClampedArray(width * height * 4);
	}
}

/** The view of the pane, taken by a primitive that draws nothing. */
class Probe implements PanePrimitive {
	public view: PaneView | null = null;
	public update(view: PaneView): void {
		this.view = view;
	}
	public draw(): void {}
}

/** A chart of candles with what it takes to look at the pixels of its heatmap and scatter series. */
class MarksChart extends TestChart {
	public readonly probe = new Probe();

	public constructor(options: ConstructorParameters<typeof TestChart>[0] = {}) {
		super(options);
		this.chart.attachPrimitive(this.probe);
	}

	/** The canvases series keep their pixels on: every canvas with a context that is not in the chart. */
	public surfaces(): HTMLCanvasElement[] {
		const layers = new Set(this.canvases());
		return [...this.recorders.keys()].filter(canvas => !layers.has(canvas));
	}

	/** The calls that handed pixels to a canvas, over all series. */
	public puts(): Call[] {
		return this.surfaces().flatMap(canvas => this.calls(canvas).filter(call => call.name === 'putImageData'));
	}

	/**
	 * The pixels of the series whose canvas got pixels last. They hold the pane column by column: the
	 * image is the pane transposed, as wide as the pane is high.
	 */
	public pixels(): { pixels: Uint32Array; width: number; height: number } {
		const image = this.puts().at(-1)!.args[0] as FakeImageData;
		return { pixels: new Uint32Array(image.data.buffer), width: image.height, height: image.width };
	}

	/** Pixels that are not transparent, as `[x, y]` of the pane. */
	public lit(): [number, number][] {
		const { pixels, height } = this.pixels();
		const list: [number, number][] = [];
		pixels.forEach((pixel, i) => {
			if (pixel !== 0) {
				list.push([Math.floor(i / height), i % height]);
			}
		});
		return list;
	}

	/** The pixel at `(x, y)` of the pane. */
	public at(x: number, y: number): number {
		const { pixels, height } = this.pixels();
		return pixels[Math.round(x) * height + Math.round(y)]!;
	}

	/** The rectangle of the pane a call handed to a series' canvas: left, top, width, height. */
	public static rect(put: Call): number[] {
		const [, , , top, left, height, width] = put.args as number[];
		return [left!, top!, width!, height!];
	}

	/** Canvas calls of one name on the pane (the series layer). */
	public paneCalls(name: string): Call[] {
		return this.pane.filter(call => call.name === name);
	}
}

/** The device pixel ratio of the test environment is 1: CSS pixels are device pixels. */
function grid(columns: number, rows: number, value: (c: number, r: number) => number, first = 100) {
	const time = new Float64Array(columns);
	const values = new Float32Array(columns * rows);
	for (let c = 0; c < columns; c++) {
		time[c] = (first + c) * MINUTE;
		for (let r = 0; r < rows; r++) {
			values[c * rows + r] = value(c, r);
		}
	}
	return { priceStart: 90, priceStep: 1, rows, time, values };
}

describe('heatmap and scatter series on a chart', () => {
	let t: MarksChart;

	beforeEach(() => {
		vi.stubGlobal('ImageData', FakeImageData);
		t = new MarksChart();
	});

	afterEach(() => {
		t.destroy();
		FakeWorker.behavior = 'ok';
	});

	async function withBars(count = 200): Promise<void> {
		t.chart.addSeries('candlestick', { id: 'bars' }).setData(candles(count));
		await t.settle();
	}

	it('draws scatter points where their time and price are, above the series', async () => {
		await withBars();
		const scatter = t.chart.addSeries('scatter', { pointSize: 3, color: '#ff0000' });
		expect(scatter.type).toBe('scatter');
		scatter.setData([
			{ time: 150 * MINUTE, price: 100 },
			{ time: 160.5 * MINUTE, price: 104, value: 5 },
			{ time: 160.5 * MINUTE, price: 96, value: 9 },
		]);
		await t.settle();
		const view = t.probe.view!;
		const x1 = Math.round(view.timeToX(150 * MINUTE));
		const y1 = Math.round(scatter.priceToCoordinate(100)!);
		// Three points of 3 x 3 pixels, none overlapping.
		expect(t.lit().length).toBe(27);
		expect(t.at(x1, y1)).toBe(packColor(255, 0, 0, 255));
		expect(t.at(x1 - 1, y1 - 1)).toBe(packColor(255, 0, 0, 255));
		expect(t.at(x1 + 2, y1)).toBe(0);
		// Half a minute after bar 160: half way to bar 161. The lowest value has the first color of
		// the palette, the highest the last.
		const x2 = Math.round((view.timeToX(160 * MINUTE) + view.timeToX(161 * MINUTE)) / 2);
		const palette = buildPalette('viridis');
		expect(t.at(x2, scatter.priceToCoordinate(104)!)).toBe(palette[0]);
		expect(t.at(x2, scatter.priceToCoordinate(96)!)).toBe(palette[255]);
		// Composited onto the drawings layer, which is above the series layer.
		expect(t.drawingsLayer.filter(call => call.name === 'drawImage').length).toBe(1);
		expect(t.paneCalls('drawImage').length).toBe(0);
		expect(scatter.drawn()).toEqual({ level: 0, marks: 3 });
	});

	it('places points from the start of their bar when asked to', async () => {
		await withBars();
		const scatter = t.chart.addSeries('scatter', { pointSize: 1, barAlign: 'start' });
		scatter.setData([{ time: 150.5 * MINUTE, price: 100 }]);
		await t.settle();
		// Half a minute into bar 150: the middle of the bar.
		expect(t.lit()).toEqual([
			[Math.round(t.probe.view!.timeToX(150 * MINUTE)), Math.round(scatter.priceToCoordinate(100)!)],
		]);
	});

	it('draws heatmap cells over their bars and prices, below the series', async () => {
		await withBars();
		const heat = t.chart.addSeries('heatmap', { palette: ['#000000', '#ffffff'] });
		expect(heat.type).toBe('heatmap');
		// Columns at bars 100 to 109, cells a unit high from 90 to 110; one cell has no value.
		heat.setData(grid(10, 20, (c, r) => (c === 2 && r === 3 ? Number.NaN : c * 20 + r)));
		await t.settle();
		const view = t.probe.view!;
		const spacing = view.barSpacing;
		const left = Math.round(view.timeToX(100 * MINUTE) - spacing / 2);
		const right = Math.round(view.timeToX(110 * MINUTE) - spacing / 2);
		const top = Math.round(heat.priceToCoordinate(110)!);
		const bottom = Math.round(heat.priceToCoordinate(90)!);
		const lit = t.lit();
		const cellWidth =
			Math.round(view.timeToX(103 * MINUTE) - spacing / 2) - Math.round(view.timeToX(102 * MINUTE) - spacing / 2);
		const cellHeight = Math.round(heat.priceToCoordinate(93)!) - Math.round(heat.priceToCoordinate(94)!);
		// Every pixel of the grid but those of the cell without a value.
		expect(lit.length).toBe((right - left) * (bottom - top) - cellWidth * cellHeight);
		expect(Math.min(...lit.map(p => p[0]))).toBe(left);
		expect(Math.max(...lit.map(p => p[0]))).toBe(right - 1);
		expect(Math.min(...lit.map(p => p[1]))).toBe(top);
		expect(Math.max(...lit.map(p => p[1]))).toBe(bottom - 1);
		// The lowest value is black, the highest white.
		expect(t.at(left, bottom - 1)).toBe(packColor(0, 0, 0, 255));
		expect(t.at(right - 1, top)).toBe(packColor(255, 255, 255, 255));
		expect(t.at(view.timeToX(102 * MINUTE), heat.priceToCoordinate(93.5)!)).toBe(0);
		// Composited onto the series layer before the candles are drawn.
		const calls = t.pane.map(call => call.name);
		const image = calls.indexOf('drawImage');
		expect(image).toBeGreaterThan(calls.indexOf('fillRect'));
		expect(calls.slice(image + 1)).toContain('fillRect');
		// The canvas holds the pane transposed, and is drawn with x and y swapped.
		expect(t.pane[image - 1]!.name).toBe('transform');
		expect(t.pane[image - 1]!.args).toEqual([0, 1, 1, 0, 0, 0]);
		expect(t.pane[image]!.args.slice(1)).toEqual([
			top,
			left,
			bottom - top,
			right - left,
			top,
			left,
			bottom - top,
			right - left,
		]);
		expect(heat.drawn()).toEqual({ level: 0, marks: 200 });
	});

	it('reads the value of the cell at a time and a price', async () => {
		await withBars();
		const heat = t.chart.addSeries('heatmap');
		heat.setData(grid(10, 20, (c, r) => (c === 2 && r === 3 ? Number.NaN : c * 20 + r)));
		expect(heat.valueAt(104 * MINUTE, 95.5)).toBeNull();
		await t.settle();
		expect(heat.valueAt(104 * MINUTE, 95.5)).toBe(85);
		expect(heat.valueAt(104.9 * MINUTE, 95)).toBe(85);
		expect(heat.valueAt(109.9 * MINUTE, 109.9)).toBe(199);
		// A cell without a value, and places outside the grid.
		expect(heat.valueAt(102 * MINUTE, 93.5)).toBeNull();
		expect(heat.valueAt(99 * MINUTE, 95)).toBeNull();
		expect(heat.valueAt(110 * MINUTE, 95)).toBeNull();
		expect(heat.valueAt(104 * MINUTE, 110)).toBeNull();
		expect(heat.valueAt(104 * MINUTE, 89.9)).toBeNull();
	});

	it('takes the points in view into the autoscale of their price scale, unless told not to', async () => {
		await withBars();
		const before = t.chart.priceScale().getVisibleRange()!;
		expect(before.to).toBeLessThan(120);
		const scatter = t.chart.addSeries('scatter');
		scatter.setData([
			// Far from the view: it does not count.
			{ time: -5000 * MINUTE, price: 999 },
			{ time: 150 * MINUTE, price: 150 },
			{ time: 160 * MINUTE, price: 60 },
		]);
		await t.settle();
		const fitted = t.chart.priceScale().getVisibleRange()!;
		expect(fitted.to).toBe(150);
		expect(fitted.from).toBe(60);
		scatter.applyOptions({ autoscale: false });
		await t.settle();
		expect(t.chart.priceScale().getVisibleRange()).toEqual(before);
		// A point added later widens the range again once it counts.
		scatter.applyOptions({ autoscale: true });
		scatter.update({ time: 170 * MINUTE, price: 170 });
		await t.settle();
		expect(t.chart.priceScale().getVisibleRange()!.to).toBe(170);
	});

	it('keeps a heatmap out of the autoscale by default, and fits one that is alone on its scale', async () => {
		await withBars();
		const before = t.chart.priceScale().getVisibleRange()!;
		const heat = t.chart.addSeries('heatmap');
		heat.setData(grid(10, 200, () => 1));
		await t.settle();
		expect(t.chart.priceScale().getVisibleRange()).toEqual(before);
		heat.applyOptions({ autoscale: true });
		await t.settle();
		expect(t.chart.priceScale().getVisibleRange()).toEqual({ from: 90, to: 290 });
		// On a scale of its own, with nothing to follow: fitted to its grid.
		heat.applyOptions({ autoscale: false, priceScaleId: 'book' });
		await t.settle();
		expect(heat.priceScale().id).toBe('book');
		expect(t.chart.priceScale('book').getVisibleRange()).toEqual({ from: 90, to: 290 });
		expect(t.chart.priceScale().getVisibleRange()).toEqual(before);
		expect(t.lit().length).toBeGreaterThan(0);
	});

	it('adds an appended point to the picture without drawing the layers of the bars again', async () => {
		await withBars();
		const scatter = t.chart.addSeries('scatter', { pointSize: 3, autoscale: false });
		scatter.setData([
			{ time: 150 * MINUTE, price: 100 },
			{ time: 160 * MINUTE, price: 101 },
		]);
		await t.settle();
		expect(t.lit().length).toBe(18);
		t.clearCalls();
		scatter.update({ time: 170 * MINUTE, price: 102 });
		await t.settle();
		expect(t.lit().length).toBe(27);
		// Only the pixels of the new point are handed over.
		const puts = t.puts();
		expect(puts.length).toBe(1);
		const x = Math.round(t.probe.view!.timeToX(170 * MINUTE));
		const y = Math.round(scatter.priceToCoordinate(102)!);
		expect(MarksChart.rect(puts[0]!)).toEqual([x - 1, y - 1, 3, 3]);
		// The series layer is kept as it is; the drawings layer is composited again.
		expect(t.pane.length).toBe(0);
		expect(t.drawingsLayer.filter(call => call.name === 'drawImage').length).toBe(1);
		expect(scatter.drawn().marks).toBe(2);
		// An earlier point is refused.
		scatter.update({ time: 100 * MINUTE, price: 100 });
		await t.settle();
		expect(t.lit().length).toBe(27);
		// Several at once.
		scatter.append({ time: [171 * MINUTE, 172 * MINUTE], price: [99, 98], value: [1, 2] });
		await t.settle();
		expect(t.lit().length).toBe(45);
	});

	it('draws a replaced or added heatmap column, and nothing else of the heatmap', async () => {
		await withBars();
		const heat = t.chart.addSeries('heatmap', { palette: ['#000000', '#ffffff'], valueMin: 0, valueMax: 100 });
		expect(() => heat.update({ time: 0, values: [1] })).toThrow(/setData/);
		heat.setData(grid(10, 20, () => 0));
		await t.settle();
		const view = t.probe.view!;
		const edge = (bar: number): number => Math.round(view.timeToX(bar * MINUTE) - view.barSpacing / 2);
		const top = Math.round(heat.priceToCoordinate(110)!);
		const bottom = Math.round(heat.priceToCoordinate(90)!);
		t.clearCalls();
		// The last column again, with other values.
		heat.update({ time: 109 * MINUTE, values: new Float32Array(20).fill(100) });
		await t.settle();
		expect(t.at(edge(109), bottom - 1)).toBe(packColor(255, 255, 255, 255));
		expect(t.at(edge(109) - 1, bottom - 1)).toBe(packColor(0, 0, 0, 255));
		let puts = t.puts();
		expect(puts.length).toBe(1);
		// From the column before it (whose right edge is its left one) to the right edge of the map.
		expect(MarksChart.rect(puts[0]!)).toEqual([edge(108), top, edge(110) - edge(108), bottom - top]);
		// A column after it; one with fewer values leaves the rest of its cells without one.
		t.clearCalls();
		heat.update({ time: 110 * MINUTE, values: [50, 50] });
		await t.settle();
		puts = t.puts();
		expect(puts.length).toBe(1);
		expect(MarksChart.rect(puts[0]!)).toEqual([edge(109), top, edge(111) - edge(109), bottom - top]);
		expect(t.at(edge(110), bottom - 1)).not.toBe(0);
		expect(t.at(edge(110), top)).toBe(0);
		expect(heat.valueAt(110 * MINUTE, 91.5)).toBe(50);
		expect(heat.valueAt(110 * MINUTE, 95)).toBeNull();
		// A column before the last is refused; columns on another grid are an error.
		heat.update({ time: 105 * MINUTE, values: new Float32Array(20).fill(100) });
		await t.settle();
		expect(heat.valueAt(105 * MINUTE, 95)).toBe(0);
		expect(() => heat.append(grid(1, 5, () => 1, 120))).toThrow(/grid/);
		heat.append(grid(2, 20, () => 7, 111));
		await t.settle();
		expect(heat.valueAt(112 * MINUTE, 95)).toBe(7);
	});

	it('keeps the picture while only the bars tick, and draws it again when the view moves', async () => {
		await withBars();
		const bars = t.chart.series()[0]!;
		const scatter = t.chart.addSeries('scatter');
		const heat = t.chart.addSeries('heatmap');
		scatter.setData([{ time: 150 * MINUTE, price: 100 }]);
		heat.setData(grid(10, 20, (c, r) => c + r));
		await t.settle();
		t.clearCalls();
		// A tick inside the range of the bar, so the price scale stays as it is.
		const base = 100 + Math.sin(199 / 50) * 10;
		bars.update({ time: 199 * MINUTE, open: base, high: base + 2, low: base - 2, close: base + 0.5 });
		await t.settle();
		// The heatmap is composited with the series layer again; no pixels are written or handed over.
		expect(t.puts().length).toBe(0);
		expect(t.paneCalls('drawImage').length).toBe(1);
		t.chart.timeScale().setVisibleLogicalRange({ from: 90, to: 170 });
		await t.settle();
		expect(t.puts().length).toBe(2);
	});

	it('follows its options: colors, size, opacity, visibility', async () => {
		await withBars();
		const scatter = t.chart.addSeries('scatter', { pointSize: 1, autoscale: false });
		scatter.setData([
			{ time: 150 * MINUTE, price: 100, value: 10 },
			{ time: 160 * MINUTE, price: 100, value: 1000 },
			{ time: 170 * MINUTE, price: 100 },
		]);
		await t.settle();
		expect(scatter.options().pointSize).toBe(1);
		const x = (bar: number): number => Math.round(t.probe.view!.timeToX(bar * MINUTE));
		const y = Math.round(scatter.priceToCoordinate(100)!);
		const viridis = buildPalette('viridis');
		expect(t.at(x(150), y)).toBe(viridis[0]);
		scatter.applyOptions({
			pointSize: 5,
			shape: 'circle',
			palette: 'greys',
			valueMin: 0,
			valueMax: 20,
			color: 'rgba(1, 2, 3, 0.5)',
		});
		await t.settle();
		expect(t.lit().length).toBe(63);
		const greys = buildPalette('greys');
		// A fixed range: half way for 10, and the last color for everything above it.
		expect(t.at(x(150), y)).toBe(greys[128]);
		expect(t.at(x(160), y)).toBe(greys[255]);
		expect(t.at(x(170), y)).toBe(packColor(1, 2, 3, 128));
		// The logarithm of the values: 10 is a third of the way from 1 to 1000.
		scatter.applyOptions({ valueScale: 'log', valueMin: 1, valueMax: 1000 });
		await t.settle();
		expect(t.at(x(150), y)).toBe(greys[85]);
		// Opacity is applied when the picture is composited.
		t.clearCalls();
		scatter.applyOptions({ opacity: 0.4 });
		await t.settle();
		expect(t.puts().length).toBe(1);
		expect(t.drawingsLayer.some(call => call.name === 'drawImage')).toBe(true);
		t.clearCalls();
		scatter.applyOptions({ visible: false });
		await t.settle();
		expect(t.drawingsLayer.some(call => call.name === 'drawImage')).toBe(false);
		// Applying what is there does nothing.
		t.clearCalls();
		scatter.applyOptions({ visible: false, opacity: 0.4 });
		expect(t.frames.length).toBe(0);
	});

	it('refuses options it cannot draw before anything changes', async () => {
		await withBars();
		expect(() => t.chart.addSeries('scatter', { palette: 'rainbow' })).toThrow(RangeError);
		expect(() => t.chart.addSeries('scatter', { color: 'red' })).toThrow(RangeError);
		expect(() => t.chart.addSeries('heatmap', { palette: ['#000', 'nope'] })).toThrow(RangeError);
		expect(t.chart.markSeries()).toEqual([]);
		const scatter = t.chart.addSeries('scatter');
		expect(() => scatter.applyOptions({ pointSize: 9, palette: 'rainbow' })).toThrow(RangeError);
		expect(scatter.options().pointSize).toBe(3);
		expect(scatter.options().palette).toBe('viridis');
		const heat = t.chart.addSeries('heatmap');
		expect(() => heat.setData({ priceStart: 0, priceStep: 0, rows: 2, time: [1], values: [1, 2] })).toThrow(RangeError);
		expect(() => heat.setData({ priceStart: 0, priceStep: 1, rows: 0, time: [1], values: [] })).toThrow(RangeError);
		expect(() => heat.setData({ priceStart: 0, priceStep: 1, rows: 2, time: [1, 2], values: [1, 2] })).toThrow(
			RangeError,
		);
		expect(() => scatter.setData({ time: [1, 2], price: [1] })).toThrow(RangeError);
	});

	it('names series of every kind from one set of ids, lists and removes them', async () => {
		await withBars();
		const scatter = t.chart.addSeries('scatter');
		const heat = t.chart.addSeries('heatmap', { id: 'book' });
		expect(scatter.id).toBe('series-1');
		expect(heat.id).toBe('book');
		expect(() => t.chart.addSeries('scatter', { id: 'bars' })).toThrow(/exists already/);
		expect(() => t.chart.addSeries('line', { id: 'book' })).toThrow(/exists already/);
		expect(t.chart.addSeries('line').id).toBe('series-2');
		expect(t.chart.markSeries()).toEqual([scatter, heat]);
		expect(t.chart.series().map(series => series.id)).toEqual(['bars', 'series-2']);
		scatter.setData([{ time: 150 * MINUTE, price: 100 }]);
		heat.setData(grid(10, 20, () => 1));
		await t.settle();
		t.clearCalls();
		t.chart.removeSeries(heat);
		await t.settle();
		expect(t.chart.markSeries()).toEqual([scatter]);
		expect(t.paneCalls('drawImage').length).toBe(0);
		t.chart.removeSeries(scatter);
		t.chart.removeSeries(scatter);
		await t.settle();
		expect(t.chart.markSeries()).toEqual([]);
		// Calls on a series that is gone change nothing.
		scatter.update({ time: 151 * MINUTE, price: 100 });
		await t.settle();
	});

	it('draws from a level of detail when there are more points than pixels, and from the points when zoomed in', async () => {
		await withBars(2000);
		const scatter = t.chart.addSeries('scatter', { pointSize: 1 });
		// 100 trades a minute, each near the price of its bar.
		const count = 200_000;
		const bars = candles(2000);
		const time = new Float64Array(count);
		const price = new Float64Array(count);
		for (let i = 0; i < count; i++) {
			time[i] = i * 600;
			price[i] = bars.close[Math.floor(i / 100)]! + ((i * 7) % 11) * 0.01;
		}
		scatter.setData({ time, price });
		t.chart.timeScale().fitContent();
		await t.settle();
		const wide = scatter.drawn();
		expect(wide.level).toBeGreaterThan(0);
		expect(wide.marks).toBeLessThan(count / 4);
		const widePixels = t.lit().length;
		expect(widePixels).toBeGreaterThan(500);
		// Zoomed in to 20 bars: 2,000 points, each drawn.
		t.chart.timeScale().setVisibleLogicalRange({ from: 1000, to: 1020 });
		await t.settle();
		const narrow = scatter.drawn();
		expect(narrow.level).toBe(0);
		expect(narrow.marks).toBeGreaterThan(2000);
		expect(narrow.marks).toBeLessThan(2400);
	});

	it('fits the price range of many points in view, and of fewer once the view leaves the others', async () => {
		await withBars(2000);
		const scatter = t.chart.addSeries('scatter', { pointSize: 1 });
		// Ten points a minute over bars 100 to 1900, at prices 100 to 101; one far above at bar 500
		// and one far below at bar 1500.
		const count = 18_000;
		const time = new Float64Array(count);
		const price = new Float64Array(count);
		for (let i = 0; i < count; i++) {
			time[i] = 100 * MINUTE + i * 6000;
			price[i] = 100 + (i % 11) / 10;
		}
		price[4000] = 400;
		price[14_000] = 20;
		scatter.setData({ time, price });
		t.chart.series()[0]!.applyOptions({ visible: false });
		t.chart.timeScale().fitContent();
		await t.settle();
		expect(scatter.drawn().level).toBe(0);
		expect(t.chart.priceScale().getVisibleRange()).toEqual({ from: 20, to: 400 });
		t.chart.timeScale().setVisibleLogicalRange({ from: 700, to: 1700 });
		await t.settle();
		expect(t.chart.priceScale().getVisibleRange()).toEqual({ from: 20, to: 101 });
		t.chart.timeScale().setVisibleLogicalRange({ from: 300, to: 1300 });
		await t.settle();
		expect(t.chart.priceScale().getVisibleRange()).toEqual({ from: 100, to: 400 });
		t.chart.timeScale().setVisibleLogicalRange({ from: 700, to: 1300 });
		await t.settle();
		expect(t.chart.priceScale().getVisibleRange()).toEqual({ from: 100, to: 101 });
	});

	it('draws from a coarser level when the view holds more marks than maxMarks', async () => {
		await withBars(2000);
		expect(() => t.chart.addSeries('scatter', { maxMarks: 0 })).toThrow(RangeError);
		const count = 200_000;
		const bars = candles(2000);
		const time = new Float64Array(count);
		const price = new Float64Array(count);
		for (let i = 0; i < count; i++) {
			time[i] = i * 600;
			price[i] = bars.close[Math.floor(i / 100)]! + ((i * 7) % 11) * 0.01;
		}
		const scatter = t.chart.addSeries('scatter', { pointSize: 1, maxMarks: 500 });
		scatter.setData({ time, price });
		// 20 bars hold 2,000 points: more than this series may draw from.
		t.chart.timeScale().setVisibleLogicalRange({ from: 1000, to: 1020 });
		await t.settle();
		expect(scatter.drawn().level).toBeGreaterThan(0);
		expect(scatter.drawn().marks).toBeLessThan(1000);
		expect(t.lit().length).toBeGreaterThan(0);
		const heat = t.chart.addSeries('heatmap', { maxMarks: 400 });
		heat.setData(grid(2000, 4, c => c % 7, 0));
		await t.settle();
		// 20 columns of 4 cells fit; 1,000 do not.
		expect(heat.drawn().level).toBe(0);
		t.chart.timeScale().setVisibleLogicalRange({ from: 500, to: 1500 });
		await t.settle();
		expect(heat.drawn().level).toBeGreaterThan(0);
	});

	it('colors the heatmap columns that come into view, and those changed out of view', async () => {
		await withBars(400);
		const white = packColor(255, 255, 255, 255);
		const black = packColor(0, 0, 0, 255);
		const heat = t.chart.addSeries('heatmap', { palette: ['#000000', '#ffffff'], valueMin: 0, valueMax: 100 });
		// Columns at bars 0 to 299: white at every tenth, black between.
		heat.setData(grid(300, 4, c => (c % 10 === 0 ? 100 : 0), 0));
		t.chart.timeScale().setVisibleLogicalRange({ from: 100, to: 120 });
		await t.settle();
		const check = (bar: number, color: number): void => {
			const view = t.probe.view!;
			expect(t.at(view.timeToX(bar * MINUTE), heat.priceToCoordinate(92.5)!)).toBe(color);
		};
		check(110, white);
		check(111, black);
		// The last column changes while it is out of view.
		heat.update({ time: 299 * MINUTE, values: [100, 100, 100, 100] });
		await t.settle();
		t.chart.timeScale().setVisibleLogicalRange({ from: 115, to: 135 });
		await t.settle();
		check(120, white);
		check(130, white);
		check(131, black);
		t.chart.timeScale().setVisibleLogicalRange({ from: 60, to: 80 });
		await t.settle();
		check(70, white);
		check(71, black);
		t.chart.timeScale().setVisibleLogicalRange({ from: 285, to: 305 });
		await t.settle();
		check(290, white);
		check(298, black);
		check(299, white);
	});

	it('merges heatmap columns where there are more of them than pixels', async () => {
		await withBars(5000);
		const heat = t.chart.addSeries('heatmap', { palette: ['#000000', '#ffffff'], valueMin: 0, valueMax: 100 });
		// One bright column among dark ones.
		heat.setData(grid(5000, 4, c => (c === 2001 ? 100 : 0), 0));
		t.chart.timeScale().fitContent();
		await t.settle();
		expect(heat.drawn().level).toBeGreaterThan(0);
		// The bright column shows, in the pixel it shares with its neighbors.
		const white = packColor(255, 255, 255, 255);
		const { pixels } = t.pixels();
		expect(pixels.filter(pixel => pixel === white).length).toBeGreaterThan(0);
		expect(heat.valueAt(2000 * MINUTE, 91)).toBe(100);
		t.chart.timeScale().setVisibleLogicalRange({ from: 1990, to: 2010 });
		await t.settle();
		expect(heat.drawn().level).toBe(0);
		expect(heat.valueAt(2000 * MINUTE, 91)).toBe(0);
		expect(heat.valueAt(2001 * MINUTE, 91)).toBe(100);
	});

	it('saves heatmap and scatter series with their options and restores them', async () => {
		await withBars();
		const scatter = t.chart.addSeries('scatter', {
			id: 'trades',
			pointSize: 4,
			palette: ['#000', '#fff'],
			valueMax: 50,
		});
		const heat = t.chart.addSeries('heatmap', { id: 'book', priceScaleId: 'depth', opacity: 0.5 });
		scatter.setData([{ time: 150 * MINUTE, price: 100, value: 3 }]);
		heat.setData(grid(10, 20, () => 1));
		await t.settle();
		const state = t.chart.saveState();
		expect(state.series!.map(entry => [entry.id, entry.type, entry.order])).toEqual([
			['bars', 'candlestick', 0],
			['trades', 'scatter', 1],
			['book', 'heatmap', 2],
		]);
		expect(state.series![1]!.options).toEqual(scatter.options());
		expect(state.series![2]!.options).toEqual(heat.options());
		// As plain JSON, into another chart.
		const copy = JSON.parse(JSON.stringify(state)) as ChartState;
		const other = new MarksChart();
		try {
			other.chart.restoreState(copy);
			expect(other.chart.series().map(series => series.id)).toEqual(['bars']);
			const restored = other.chart.markSeries();
			expect(restored.map(series => [series.id, series.type])).toEqual([
				['trades', 'scatter'],
				['book', 'heatmap'],
			]);
			expect(restored[0]!.options()).toEqual(scatter.options());
			expect(restored[1]!.options()).toEqual(heat.options());
			expect(restored[1]!.priceScale().id).toBe('depth');
			// Saved again, the state is the same.
			expect(other.chart.saveState().series).toEqual(copy.series);
			// They take data like any series.
			other.chart.series()[0]!.setData(candles(200));
			(restored[0] as ScatterSeriesApi).setData([{ time: 150 * MINUTE, price: 100 }]);
			await other.settle();
			expect(other.lit().length).toBe(16);
		} finally {
			other.destroy();
		}
	});

	it('keeps the data of series a restored state names, changes their options, and removes the others', async () => {
		await withBars();
		const scatter = t.chart.addSeries('scatter', { id: 'trades', pointSize: 1 });
		const heat = t.chart.addSeries('heatmap', { id: 'book' });
		scatter.setData([{ time: 150 * MINUTE, price: 100 }]);
		heat.setData(grid(10, 20, () => 1));
		await t.settle();
		const state = t.chart.saveState();
		const entry = state.series!.find(series => series.id === 'trades')!;
		(entry.options as { pointSize: number }).pointSize = 3;
		state.series = state.series!.filter(series => series.id !== 'book');
		state.series.push({ ...entry, id: 'more' } as MarkSeriesState);
		t.chart.restoreState(state);
		await t.settle();
		const list = t.chart.markSeries();
		expect(list.map(series => series.id)).toEqual(['trades', 'more']);
		// The same series, with its point, now three pixels wide.
		expect(list[0]).toBe(scatter);
		expect(scatter.options().pointSize).toBe(3);
		expect(scatter.drawn().marks).toBe(1);
		// Without the series part, they stay as they are.
		t.chart.restoreState({ version: 1, series: [] }, { parts: ['view'] });
		expect(t.chart.markSeries().length).toBe(2);
		t.chart.restoreState({ version: 1, drawings: [] });
		expect(t.chart.markSeries().length).toBe(2);
		// A name passes from a scatter to a line and from the bars to a heatmap in one restore.
		const swapped = t.chart.saveState();
		swapped.series = [
			{ ...swapped.series!.find(series => series.id === 'bars')!, id: 'trades' },
			{ ...swapped.series!.find(series => series.id === 'more')!, id: 'bars', type: 'heatmap', options: {} } as never,
		];
		t.chart.restoreState(swapped);
		expect(t.chart.series().map(series => [series.id, series.type])).toEqual([['trades', 'candlestick']]);
		expect(t.chart.markSeries().map(series => [series.id, series.type])).toEqual([['bars', 'heatmap']]);
		expect(t.chart.markSeries()[0]!.options().palette).toBe('heat');
		t.chart.restoreState({ version: 1, series: [] });
		expect(t.chart.markSeries().length).toBe(0);
		expect(t.chart.series().length).toBe(0);
	});

	it('refuses a state with a heatmap or scatter that is wrong, before anything changes', async () => {
		await withBars();
		t.chart.addSeries('scatter', { id: 'trades' });
		const state = t.chart.saveState();
		const wrong = (change: (entry: Record<string, unknown>) => void, message: RegExp): void => {
			const copy = JSON.parse(JSON.stringify(state)) as ChartState;
			// The bars would go, were anything applied.
			copy.series = copy.series!.filter(entry => entry.id !== 'bars');
			change(copy.series[0] as unknown as Record<string, unknown>);
			expect(() => t.chart.restoreState(copy)).toThrow(message);
			expect(t.chart.series().length).toBe(1);
			expect(t.chart.markSeries().length).toBe(1);
		};
		wrong(entry => {
			(entry.options as Record<string, unknown>).palette = 'rainbow';
		}, /series\[0\]\.options/);
		wrong(entry => {
			(entry.options as Record<string, unknown>).pointSize = 'big';
		}, /series\[0\]\.options\.pointSize must be a finite number/);
		wrong(entry => {
			(entry.options as Record<string, unknown>).shape = 'star';
		}, /must be one of square, circle/);
		wrong(entry => {
			(entry.options as Record<string, unknown>).lineWidth = 2;
		}, /lineWidth is not an option/);
		wrong(entry => {
			(entry.options as Record<string, unknown>).valueMin = 'low';
		}, /valueMin must be a finite number or null/);
		wrong(entry => {
			entry.id = '';
		}, /series\[0\]\.id/);
		wrong(entry => {
			entry.pane = 1;
		}, /pane/);
		// Two series of one name, of different kinds.
		const twice = JSON.parse(JSON.stringify(state)) as ChartState;
		(twice.series![1] as { id: string }).id = 'bars';
		expect(() => t.chart.restoreState(twice)).toThrow(/"bars" is used twice/);
		// A wrong bar series is refused before the heatmap and scatter series change.
		const bad = JSON.parse(JSON.stringify(state)) as ChartState;
		(bad.series![0] as unknown as { type: string }).type = 'area';
		bad.series = [bad.series![0]!];
		expect(() => t.chart.restoreState(bad)).toThrow(/must be one of/);
		expect(t.chart.markSeries().length).toBe(1);
	});

	it('draws the pictures again after the browser lost the canvases', async () => {
		await withBars();
		const scatter = t.chart.addSeries('scatter');
		scatter.setData([{ time: 150 * MINUTE, price: 100 }]);
		await t.settle();
		t.clearCalls();
		t.canvases()[0]!.dispatchEvent(new Event('contextrestored'));
		await t.settle();
		expect(t.puts().length).toBe(1);
		expect(t.lit().length).toBe(9);
	});

	it('draws nothing without bars, and the marks once there are bars', async () => {
		const scatter = t.chart.addSeries('scatter');
		scatter.setData([{ time: 150 * MINUTE, price: 100 }]);
		await t.settle();
		expect(t.puts().length).toBe(0);
		expect(scatter.drawn().marks).toBe(0);
		t.chart.addSeries('candlestick').setData(candles(200));
		await t.settle();
		expect(t.lit().length).toBe(9);
	});
});

/** The pixels of a scatter and a heatmap at a wide view, after live updates, with the engine here or in a worker. */
async function picture(worker: boolean): Promise<{ scatter: number[]; heat: number[]; mode: string }> {
	vi.stubGlobal('ImageData', FakeImageData);
	vi.stubGlobal('Worker', FakeWorker);
	const t = new MarksChart({ worker: worker ? () => new FakeWorker() as unknown as Worker : false });
	try {
		t.chart.addSeries('candlestick').setData(candles(3000));
		const scatter: ScatterSeriesApi = t.chart.addSeries('scatter', { pointSize: 2 });
		const heat: HeatmapSeriesApi = t.chart.addSeries('heatmap', { autoscale: true });
		const count = 150_000;
		const time = new Float64Array(count);
		const price = new Float64Array(count);
		const value = new Float32Array(count);
		for (let i = 0; i < count; i++) {
			time[i] = i * 1200;
			price[i] = 100 + Math.sin(i / 5000) * 8 + ((i * 13) % 17) * 0.02;
			value[i] = (i * 31) % 97;
		}
		scatter.setData({ time, price, value });
		heat.setData(grid(3000, 16, (c, r) => Math.sin(c / 40 + r) * 50 + 50, 0));
		t.chart.timeScale().fitContent();
		await t.settle();
		// Live data, then a narrower view.
		scatter.update({ time: count * 1200, price: 104, value: 500 });
		heat.update({ time: 2999 * MINUTE, values: new Float32Array(16).fill(100) });
		await t.settle();
		const wide: number[][] = [];
		for (const canvas of t.surfaces()) {
			let image: FakeImageData | null = null;
			for (const call of t.calls(canvas)) {
				if (call.name === 'putImageData') {
					image = call.args[0] as FakeImageData;
				}
			}
			wide.push(Array.from(new Uint32Array(image!.data.buffer)));
		}
		expect(scatter.drawn().level).toBeGreaterThan(0);
		expect(heat.drawn().level).toBeGreaterThan(0);
		return { scatter: wide[0]!, heat: wide[1]!, mode: t.chart.engineMode() };
	} finally {
		t.destroy();
	}
}

describe('heatmap and scatter series with the engine in a worker', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('draw the same pixels as with the engine on the main thread', async () => {
		const main = await picture(false);
		const worker = await picture(true);
		expect(main.mode).toBe('local');
		expect(worker.mode).toBe('worker');
		expect(main.scatter.filter(pixel => pixel !== 0).length).toBeGreaterThan(1000);
		expect(main.heat.filter(pixel => pixel !== 0).length).toBeGreaterThan(1000);
		expect(worker.scatter).toEqual(main.scatter);
		expect(worker.heat).toEqual(main.heat);
	});
});
