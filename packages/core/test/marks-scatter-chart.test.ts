import type { ChartPointerEvent, PanePrimitive, PaneView, ScatterSeriesApi } from '@lumen-charts/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GpuBackend } from '../src/marks/backend';
import type { acquire } from '../src/marks/gpu/device';
import { densityColorFragment, densityFragment, reduceFragment, scatterFragment } from '../src/marks/gl/shaders';
import { buildPalette, paletteIndex, setValueMapping } from '../src/marks/palette';
import { DensityScale } from '../src/marks/scatter-style';
import { type Call, MINUTE, TestChart, candles } from './drawing-helpers';
import { FakeWebGl } from './fake-webgl';

// A WebGPU device for the series that ask for one, whose backend the test hands over.
const pool = vi.hoisted(() => ({ acquire: vi.fn<typeof acquire>() }));
vi.mock('../src/marks/gpu/device.js', () => pool);

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

/**
 * A chart of candles whose scatter pixels can be read (Canvas 2D), and whose WebGL2 context is a
 * fake that records what is uploaded and drawn. The device pixel ratio is 1.
 */
class ScatterChart extends TestChart {
	public readonly probe = new Probe();
	public gl: FakeWebGl | null = null;
	/** Extensions the fake WebGL2 context offers, and what its `readPixels` reads. */
	public extensions: string[] = [];
	public readValue = 0;

	public constructor(markRenderer: 'canvas2d' | 'webgl2' = 'canvas2d') {
		super({ markRenderer });
		this.chart.attachPrimitive(this.probe);
		const getContext = vi.mocked(HTMLCanvasElement.prototype.getContext);
		const canvas2d = getContext.getMockImplementation()!;
		const created = (gl: FakeWebGl): FakeWebGl => {
			for (const name of this.extensions) gl.extensions.add(name);
			gl.readValue = this.readValue;
			return (this.gl = gl);
		};
		getContext.mockImplementation(function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
			if (kind === 'webgl2') return created(new FakeWebGl(this));
			const context = (canvas2d as (...args: unknown[]) => object | null).call(this, kind, ...rest);
			// The WebGL2 layer reads the size of its cached image from its context's canvas.
			if (context !== null && !('canvas' in context)) Object.assign(context, { canvas: this });
			return context;
		} as unknown as HTMLCanvasElement['getContext']);
	}

	public puts(): Call[] {
		const layers = new Set(this.canvases());
		return [...this.recorders.keys()]
			.filter(canvas => !layers.has(canvas))
			.flatMap(canvas => this.calls(canvas).filter(call => call.name === 'putImageData'));
	}

	/** The pane's pixels of the series that handed pixels over last, column by column. */
	public pixels(): { pixels: Uint32Array; height: number } {
		const image = this.puts().at(-1)!.args[0] as FakeImageData;
		return { pixels: new Uint32Array(image.data.buffer), height: image.width };
	}

	public lit(): [number, number][] {
		const { pixels, height } = this.pixels();
		const list: [number, number][] = [];
		pixels.forEach((pixel, i) => {
			if (pixel !== 0) list.push([Math.floor(i / height), i % height]);
		});
		return list;
	}

	public at(x: number, y: number): number {
		const { pixels, height } = this.pixels();
		return pixels[Math.round(x) * height + Math.round(y)]!;
	}

	/** The rectangle of the pane the last call handed over: left, top, width, height. */
	public lastRect(): number[] {
		const [, , , top, left, height, width] = this.puts().at(-1)!.args as number[];
		return [left!, top!, width!, height!];
	}

	/** Device pixel of the pane where a point at `time` and `price` is centered. */
	public center(scatter: ScatterSeriesApi, time: number, price: number): [number, number] {
		return [Math.round(this.probe.view!.timeToX(time)), Math.round(scatter.priceToCoordinate(price)!)];
	}
}

const GREY = ['#000000', '#ffffff'];

/** A point at price 100, at a minute, with a value; without one; with the minute as value and a size. */
const valued = (minute: number, value: number) => ({ time: minute * MINUTE, price: 100, value });
const plain = (minute: number) => ({ time: minute * MINUTE, price: 100 });
const at = (minute: number, size?: number) => ({ time: minute * MINUTE, price: 100, value: minute, size });

describe('scatter sizes, densities and the point at a pixel, on a chart', () => {
	let t: ScatterChart;

	beforeEach(async () => {
		vi.stubGlobal('ImageData', FakeImageData);
		t = new ScatterChart();
		t.chart.addSeries('candlestick', { id: 'bars' }).setData(candles(200));
		await t.settle();
	});

	afterEach(() => {
		t.destroy();
	});

	it('draws each point at its own size, and a wide point centered beyond the view reaches into it', async () => {
		const scatter = t.chart.addSeries('scatter', { pointSize: 3, color: '#ff0000' });
		scatter.setData([
			{ time: 150 * MINUTE, price: 100, size: 9 },
			{ time: 160 * MINUTE, price: 100 },
			{ time: 170 * MINUTE, price: 100, size: 0.2 },
		]);
		await t.settle();
		expect(t.lit().length).toBe(81 + 9 + 1);
		const [x, y] = t.center(scatter, 150 * MINUTE, 100);
		expect(t.at(x - 4, y + 4)).not.toBe(0);
		expect(t.at(x - 5, y)).toBe(0);

		// Bar 150 just left of the pane: its 21-pixel point reaches columns 0 to 2 or so.
		scatter.applyOptions({ pointSize: 3 });
		scatter.setData([{ time: 150 * MINUTE, price: 100, size: 21 }]);
		t.chart.timeScale().setVisibleLogicalRange({ from: 150.5, to: 190.5 });
		await t.settle();
		const center = t.probe.view!.timeToX(150 * MINUTE);
		expect(center).toBeLessThan(-3);
		const columns = [...new Set(t.lit().map(([px]) => px))];
		expect(columns.length).toBe(Math.round(center) + 11);
		expect(Math.min(...columns)).toBe(0);
		expect(Math.max(...columns)).toBe(Math.round(center) + 10);
	});

	it('hands over the pixels of an appended point at its own size, and draws again for a wider one', async () => {
		const scatter = t.chart.addSeries('scatter', { pointSize: 3 });
		scatter.setData([{ time: 150 * MINUTE, price: 100, size: 7 }]);
		await t.settle();
		scatter.update({ time: 170 * MINUTE, price: 100, size: 7 });
		await t.settle();
		const [x, y] = t.center(scatter, 170 * MINUTE, 100);
		expect(t.lastRect()).toEqual([x - 3, y - 3, 7, 7]);
		expect(t.lit().length).toBe(49 + 49);
		// A point wider than any held reaches further beyond the view: the picture is drawn again.
		scatter.update({ time: 180 * MINUTE, price: 100, size: 9 });
		await t.settle();
		const [x0] = t.center(scatter, 150 * MINUTE, 100);
		const [x2] = t.center(scatter, 180 * MINUTE, 100);
		expect(t.lastRect()).toEqual([x0 - 3, y - 4, x2 + 5 - (x0 - 3), 9]);
		expect(t.lit().length).toBe(49 + 49 + 81);
	});

	it('colors each pixel by the number of points that cover it, from 1 to the most in the frame', async () => {
		const palette = buildPalette(GREY);
		const scatter = t.chart.addSeries('scatter', { pointSize: 3, colorBy: 'density', palette: GREY });
		scatter.setData([valued(150, 1), valued(150, 9), valued(150, 3), valued(160, 50), valued(170, 7)]);
		await t.settle();
		expect(t.lit().length).toBe(27);
		const x150 = t.center(scatter, 150 * MINUTE, 100);
		const x160 = t.center(scatter, 160 * MINUTE, 100);
		const x170 = t.center(scatter, 170 * MINUTE, 100);
		expect(t.at(...x150)).toBe(palette[255]);
		expect(t.at(...x160)).toBe(palette[0]);
		expect(t.at(...x170)).toBe(palette[0]);

		// A point where the most are not yet: only its pixels are handed over.
		scatter.update(valued(170, 1));
		await t.settle();
		expect(t.lastRect()).toEqual([x170[0] - 1, x170[1] - 1, 3, 3]);
		expect(t.at(...x170)).toBe(palette[128]);
		// Three more at 170 make five there: the top of the palette moves, every pixel is colored again.
		scatter.append([valued(170, 1), valued(170, 1), valued(170, 1)]);
		await t.settle();
		expect(t.lastRect()).toEqual([x150[0] - 1, x150[1] - 1, x170[0] - x150[0] + 3, 3]);
		const mapping = { min: 0, factor: 0, log: false };
		setValueMapping(mapping, 1, 5, false);
		expect(t.at(...x150)).toBe(palette[paletteIndex(mapping, 3)]);
		expect(t.at(...x160)).toBe(palette[0]);
		expect(t.at(...x170)).toBe(palette[255]);
		expect(scatter.pointAt(x170[0] + 0.5, x170[1] + 0.5)).toMatchObject({ count: 1, density: 5 });
	});

	it('fixes the top of the palette with valueMax, and spreads it over the logarithm with log', async () => {
		const palette = buildPalette(GREY);
		const scatter = t.chart.addSeries('scatter', { pointSize: 3, colorBy: 'density', palette: GREY, valueMax: 4 });
		scatter.setData([plain(150), plain(150), plain(150), plain(160)]);
		await t.settle();
		const x150 = t.center(scatter, 150 * MINUTE, 100);
		const x160 = t.center(scatter, 160 * MINUTE, 100);
		expect(t.at(...x150)).toBe(palette[170]);
		expect(t.at(...x160)).toBe(palette[0]);
		// Above the fixed top: that pixel takes the last color, and nothing else changes.
		scatter.append([plain(160), plain(160), plain(160), plain(160)]);
		await t.settle();
		expect(t.lastRect()).toEqual([x160[0] - 1, x160[1] - 1, 3, 3]);
		expect(t.at(...x160)).toBe(palette[255]);

		scatter.applyOptions({ valueMax: null, valueScale: 'log' });
		await t.settle();
		const mapping = { min: 0, factor: 0, log: false };
		setValueMapping(mapping, 1, 5, true);
		expect(t.at(...x150)).toBe(palette[paletteIndex(mapping, 3)]);
		expect(paletteIndex(mapping, 3)).toBe(174);
		expect(t.at(...x160)).toBe(palette[255]);
	});

	it('sums the points a cell of a coarse level holds, so the frame holds every point', async () => {
		const n = 100_000;
		const time = Float64Array.from({ length: n }, (_, i) => (i / n) * 199 * MINUTE);
		// Twenty prices: points share their price bins, and cells hold many of them.
		const price = Float64Array.from({ length: n }, (_, i) => 95 + ((i * 7) % 20) * 0.5);
		const scatter = t.chart.addSeries('scatter', { pointSize: 1, colorBy: 'density' });
		scatter.setData({ time, price });
		t.chart.timeScale().fitContent();
		await t.settle();
		expect(scatter.drawn().level).toBeGreaterThan(0);
		const density = (scatter as unknown as { _density: Float32Array })._density;
		let total = 0;
		let most = 0;
		for (const d of density) {
			total += d;
			most = Math.max(most, d);
		}
		expect(total).toBe(n);
		expect(most).toBeGreaterThan(1);
		// The readout of a lit pixel tells the cell's points, and the pixel's density.
		const lit = t.lit();
		const { height } = t.pixels();
		let cells = 0;
		for (const [x, y] of lit.slice(0, 200)) {
			const hit = scatter.pointAt(x + 0.5, y + 0.5)!;
			expect(hit.density).toBe(density[x * height + y]);
			if (hit.count > 1) cells++;
		}
		expect(cells).toBeGreaterThan(0);
	});

	it('reads the point drawn on top at a position of the pane, at its own size', async () => {
		const scatter = t.chart.addSeries('scatter', { pointSize: 3 });
		scatter.setData([
			{ time: 150 * MINUTE, price: 100, value: 4 },
			{ time: 150 * MINUTE, price: 100, value: 9, size: 7 },
			{ time: 160 * MINUTE, price: 101 },
		]);
		await t.settle();
		const [x, y] = t.center(scatter, 150 * MINUTE, 100);
		const top = { time: 150 * MINUTE, price: 100, value: 9, size: 7, count: 1 };
		expect(scatter.pointAt(x + 0.5, y + 0.5)).toEqual({ ...top, density: 2 });
		expect(scatter.pointAt(x + 3.5, y - 2.5)).toEqual({ ...top, density: 1 });
		expect(scatter.pointAt(x + 4.5, y + 0.5)).toBeNull();
		const [x2, y2] = t.center(scatter, 160 * MINUTE, 101);
		expect(scatter.pointAt(x2 - 0.5, y2 + 1.5)).toEqual({
			time: 160 * MINUTE,
			price: 101,
			value: null,
			size: 3,
			count: 1,
			density: 1,
		});
		expect(scatter.pointAt(-1, y)).toBeNull();
		expect(scatter.pointAt(x, 10_000)).toBeNull();

		// What the crosshair is on, as a `crosshairMove` handler reads it.
		const events: ChartPointerEvent[] = [];
		t.chart.subscribe('crosshairMove', event => events.push(event));
		t.chart.setCrosshairPosition(150 * MINUTE, 100);
		await t.settle();
		const point = events.at(-1)!.point!;
		expect(scatter.pointAt(point.x, point.y)).toEqual({ ...top, density: 2 });

		scatter.applyOptions({ visible: false });
		await t.settle();
		expect(scatter.pointAt(x + 0.5, y + 0.5)).toBeNull();
	});

	it('refuses a colorBy it does not know, and saves and restores the one it has', async () => {
		const scatter = t.chart.addSeries('scatter', { id: 'trades', colorBy: 'density' });
		expect(scatter.options().colorBy).toBe('density');
		expect(() => scatter.applyOptions({ colorBy: 'size' as 'value' })).toThrow(RangeError);
		expect(scatter.options().colorBy).toBe('density');
		expect(() => t.chart.addSeries('scatter', { colorBy: 'count' as 'value' })).toThrow(RangeError);
		const state = t.chart.saveState();
		const saved = state.series!.find(entry => entry.id === 'trades')!;
		expect((saved.options as { colorBy: string }).colorBy).toBe('density');

		scatter.applyOptions({ colorBy: 'value' });
		t.chart.restoreState(state);
		expect(scatter.options().colorBy).toBe('density');
		const wrong = structuredClone(state);
		(wrong.series!.find(entry => entry.id === 'trades')!.options as { colorBy: string }).colorBy = 'count';
		expect(() => t.chart.restoreState(wrong)).toThrow(/colorBy must be one of value, density/);
		const heat = structuredClone(state);
		heat.series!.push({ id: 'book', type: 'heatmap', options: { colorBy: 'density' }, pane: 0, order: 9 } as never);
		expect(() => t.chart.restoreState(heat)).toThrow(/colorBy is not an option of the series/);
	});
});

describe('scatter sizes and densities on WebGL2 and WebGPU', () => {
	let t: ScatterChart;

	beforeEach(async () => {
		t = new ScatterChart('webgl2');
		t.chart.addSeries('candlestick', { id: 'bars' }).setData(candles(200));
		await t.settle();
	});

	afterEach(() => {
		t.destroy();
	});

	it('falls back to Canvas 2D for densities without float blending', async () => {
		vi.stubGlobal('ImageData', FakeImageData);
		const scatter = t.chart.addSeries('scatter', { colorBy: 'density' });
		scatter.setData([at(150), at(150)]);
		await t.settle();
		expect(scatter.renderer()).toMatchObject({ effective: 'canvas2d', reason: 'unsupported-style' });
		expect(t.lit().length).toBe(9);
		scatter.applyOptions({ colorBy: 'value' });
		await t.settle();
		expect(scatter.renderer()).toMatchObject({ effective: 'webgl2', reason: null });
	});

	it('sums densities on the GPU, reads the largest back, and adds appended points alone', async () => {
		// The context is made with the first mark series' frame.
		t.extensions = ['EXT_color_buffer_float', 'EXT_float_blend'];
		t.readValue = 3;
		const scatter = t.chart.addSeries('scatter', { colorBy: 'density', palette: 'inferno' });
		const gl = () => t.gl!;
		scatter.setData([at(150), at(150), at(150), at(160)]);
		await t.settle();
		expect(scatter.renderer()).toMatchObject({ effective: 'webgl2', path: 'webgl2', reason: null });
		const sum = gl().draws.filter(draw => draw.fragment === densityFragment);
		expect(sum.at(-1)).toMatchObject({ instances: 4, offscreen: true, blend: true });
		expect(gl().draws.some(draw => draw.fragment === reduceFragment && draw.offscreen)).toBe(true);
		expect(gl().draws.at(-1)).toMatchObject({ fragment: densityColorFragment, offscreen: false, blend: false });
		expect(gl().reads).toBe(1);
		// The counts, as float bits, where the colors would be; two words a row.
		const records = new Float32Array(gl().bound(0)!.data.buffer);
		expect([records[1], records[3], records[5], records[7]]).toEqual([1, 1, 1, 1]);
		// The thresholds of the palette for densities 1 to 3, then the colors.
		const scale = new DensityScale();
		const mapping = { min: 0, factor: 0, log: false };
		setValueMapping(mapping, 1, 3, false);
		scale.set(mapping);
		const style = gl().textures.find(texture => !texture.deleted && texture.data.length === 512)!;
		expect([...style.data.subarray(0, 256)]).toEqual([...scale.thresholds]);
		expect([...style.data.subarray(256)]).toEqual([...buildPalette('inferno')]);

		// The first patch grows the window, whose records are uploaded anew, all of them.
		scatter.update(at(160));
		await t.settle();
		// An appended point below the largest: one instance summed, nothing of the palette uploaded.
		const reads = gl().reads;
		gl().uploads.length = 0;
		gl().draws.length = 0;
		scatter.update(at(160));
		await t.settle();
		expect(gl().draws.filter(draw => draw.fragment === densityFragment)).toMatchObject([{ instances: 1 }]);
		expect(gl().uploads.filter(upload => upload.unit === 2)).toEqual([]);
		expect(gl().reads).toBe(reads + 1);

		// With valueMax the top of the palette is known: nothing is read back.
		scatter.applyOptions({ valueMax: 10 });
		await t.settle();
		expect(gl().reads).toBe(reads + 1);
		const densityBytes = scatter.renderer().bytes;
		scatter.applyOptions({ colorBy: 'value' });
		await t.settle();
		expect(gl().draws.at(-1)!.fragment).toBe(scatterFragment);
		// The densities of the pane and the levels down to one texel, 16 by 16 to one, and the table.
		const { width, height } = t.probe.view!;
		let texels = width * height;
		for (let w = width, h = height; w > 1 || h > 1; texels += w * h) {
			w = Math.ceil(w / 16);
			h = Math.ceil(h / 16);
		}
		expect(densityBytes - scatter.renderer().bytes).toBe(4 * (texels + 512));
	});

	it('uploads a size per row and pads the column ranges by the widest point', async () => {
		const scatter = t.chart.addSeries('scatter', { pointSize: 2 });
		scatter.setData([at(150, 9.4), at(155), at(160, 0.1)]);
		await t.settle();
		expect(scatter.renderer()).toMatchObject({ effective: 'webgl2', reason: null });
		const draw = t.gl!.draws.at(-1)!;
		expect(draw.fragment).toBe(scatterFragment);
		expect(draw.uniforms).toMatchObject({ stamp: [9], base: [2], recordWords: [3] });
		const records = t.gl!.bound(0)!.data;
		expect([records[2], records[5], records[8]]).toEqual([9, 0, 1]);
		// Without sizes the records are two words, and the padding is the series' size.
		scatter.setData([at(150), at(155)]);
		await t.settle();
		expect(t.gl!.draws.at(-1)!.uniforms).toMatchObject({ stamp: [2], base: [2], recordWords: [2] });
	});

	it('routes points with sizes and densities from WebGPU to WebGL2', async () => {
		const paint = vi.fn<GpuBackend['paint']>(() => 'scatter-tiles');
		const backend: GpuBackend = { paint, bytes: 0, kernel: 'scatter-tiles', release: vi.fn<() => void>() };
		pool.acquire.mockImplementation((_doc, listener) => {
			listener(backend, null);
			return { release: vi.fn<() => void>() };
		});
		Object.defineProperty(window.navigator, 'gpu', { value: {}, configurable: true });
		try {
			t.chart.applyOptions({ markRenderer: 'webgpu' });
			const scatter = t.chart.addSeries('scatter', { pointSize: 2 });
			scatter.setData([at(150), at(155)]);
			await vi.waitFor(async () => {
				await t.settle();
				expect(paint).toHaveBeenCalled();
			});
			expect(scatter.renderer().effective).toBe('webgpu');

			scatter.setData([at(150, 4), at(155)]);
			await t.settle();
			expect(scatter.renderer()).toMatchObject({ effective: 'webgl2', reason: 'unsupported-style' });
			scatter.setData([at(150), at(155)]);
			scatter.applyOptions({ colorBy: 'density' });
			await t.settle();
			// No float blending in this context: densities end in Canvas 2D, for WebGPU's reason.
			expect(scatter.renderer()).toMatchObject({ effective: 'canvas2d', reason: 'unsupported-style' });
			scatter.applyOptions({ colorBy: 'value' });
			await vi.waitFor(async () => {
				await t.settle();
				expect(scatter.renderer().effective).toBe('webgpu');
			});
		} finally {
			Reflect.deleteProperty(window.navigator, 'gpu');
			pool.acquire.mockReset();
		}
	});
});
