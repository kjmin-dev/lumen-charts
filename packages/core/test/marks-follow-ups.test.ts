import type { HeatmapSeriesApi, PanePrimitive, PaneView, ScatterSeriesApi } from '@lumen-charts/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeWorker } from '../../engine/test/fake-worker';
import type { GpuBackend, MarkFrame } from '../src/marks/backend';
import type { acquire } from '../src/marks/gpu/device';
import { packScatterCellRows } from '../src/marks/gl/density';
import { densityFragment, scatterFragment } from '../src/marks/gl/shaders';
import { buildPalette, parseColor, setValueMapping } from '../src/marks/palette';
import { Premultiplier } from '../src/marks/premultiply';
import {
	accumulateScatterCells,
	drawScatterCells,
	emptyBox,
	makeStamp,
	scatterCellArea,
	StampCache,
} from '../src/marks/render';
import { hitScatterCells } from '../src/marks/scatter-style';
import { TimeMap } from '../src/marks/time-map';
import { MarksWindow } from '../src/marks/window';
import { MINUTE, TestChart, candles } from './drawing-helpers';
import { FakeWebGl } from './fake-webgl';

const pool = vi.hoisted(() => ({ acquire: vi.fn<typeof acquire>() }));
vi.mock('../src/marks/gpu/device.js', () => pool);

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

class FollowUpChart extends TestChart {
	public readonly probe = new Probe();
	public gl: FakeWebGl | null = null;
	public extensions: string[] = [];
	/** The largest point sprite of the contexts made from now on (0: quads). */
	public maxPointSize = 0;

	public constructor(options: ConstructorParameters<typeof TestChart>[0] = {}) {
		super({ markRenderer: 'canvas2d', ...options });
		this.chart.attachPrimitive(this.probe);
		const getContext = vi.mocked(HTMLCanvasElement.prototype.getContext);
		const canvas2d = getContext.getMockImplementation()!;
		const created = (gl: FakeWebGl): FakeWebGl => {
			for (const name of this.extensions) gl.extensions.add(name);
			gl.maxPointSize = this.maxPointSize;
			return (this.gl = gl);
		};
		getContext.mockImplementation(function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
			if (kind === 'webgl2') return created(new FakeWebGl(this));
			const context = (canvas2d as (...args: unknown[]) => object | null).call(this, kind, ...rest);
			if (context !== null && !('canvas' in context)) Object.assign(context, { canvas: this });
			return context;
		} as unknown as HTMLCanvasElement['getContext']);
	}

	public pixels(): { pixels: Uint32Array; width: number; height: number } {
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
		if (image === null) return { pixels: new Uint32Array(0), width: 0, height: 0 };
		return { pixels: new Uint32Array(image.data.buffer.slice(0)), width: image.height, height: image.width };
	}

	public lit(): number {
		return this.pixels().pixels.filter(p => p !== 0).length;
	}
}

/** CPU reference implementation of the GLSL 5-word scatter cell shader (`shaders.ts`). */
function emulateGlCellShader(
	packed: Uint32Array,
	visible: number,
	width: number,
	height: number,
	circle: boolean,
): Uint32Array {
	const pixels = new Uint32Array(width * height);
	for (let k = 0; k < visible; k++) {
		const at = k * 5;
		const originX = packed[at]! | 0;
		const originY = packed[at + 1]! | 0;
		const rgba = packed[at + 2]!;
		const boxW = packed[at + 3]! | 0;
		const dim = packed[at + 4]!;
		const size = dim & 1023;
		const boxH = dim >>> 10;
		const dx = boxW - size;
		const dy = boxH - size;
		const halfS = size >> 1;
		for (let lx = 0; lx < boxW; lx++) {
			const x = originX + lx;
			if (x < 0 || x >= width) continue;
			for (let ly = 0; ly < boxH; ly++) {
				const y = originY + ly;
				if (y < 0 || y >= height) continue;
				if (circle && size >= 3) {
					const cx = lx < halfS ? lx : lx >= halfS + dx ? lx - dx : halfS;
					const r = Math.fround(size / 2);
					const d = Math.fround(Math.fround(cx) + 0.5 - r);
					const halfSpan = Math.fround(Math.sqrt(Math.max(0, Math.fround(r * r - d * d))));
					const yFrom = Math.floor(Math.fround(r - halfSpan + 0.5));
					const yTo = Math.floor(Math.fround(r + halfSpan + 0.5)) + dy;
					if (ly < yFrom || ly >= yTo) continue;
				}
				pixels[x * height + y] = rgba;
			}
		}
	}
	return pixels;
}

function makeHeatData(patched: boolean) {
	const count = 60;
	const rows = 5;
	const time = Float64Array.from({ length: count }, (_, c) => (100 + c) * MINUTE);
	const values = Float32Array.from({ length: count * rows }, (_, i) => (i % 40) + 5);
	const priceStart = Float64Array.from({ length: count }, (_, c) => 95 + (c % 3) * 0.5);
	if (patched) {
		values.fill(49, 20 * rows, 21 * rows);
		priceStart[20] = 98;
	}
	return { priceStart, priceStep: 0.5, rows, time, values };
}

describe('mark corrections on a chart (local and worker)', () => {
	beforeEach(() => {
		vi.stubGlobal('ImageData', FakeImageData);
		vi.stubGlobal('Worker', FakeWorker);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		FakeWorker.behavior = 'ok';
	});

	for (const worker of [false, true]) {
		const mode = worker ? 'worker' : 'local';

		it(`corrects heatmap columns in place without ghost pixels (${mode})`, async () => {
			const opts = { worker: worker ? () => new FakeWorker() as unknown as Worker : false };
			let expected: Uint32Array;
			const ref = new FollowUpChart(opts);
			try {
				ref.chart.addSeries('candlestick').setData(candles(200));
				const refHeat = ref.chart.addSeries('heatmap', { valueMin: 0, valueMax: 50 }) as HeatmapSeriesApi;
				refHeat.setData(makeHeatData(true));
				ref.chart.timeScale().setVisibleLogicalRange({ from: 95, to: 165 });
				await ref.settle();
				expected = ref.pixels().pixels;
			} finally {
				ref.destroy();
			}
			vi.stubGlobal('ImageData', FakeImageData);
			vi.stubGlobal('Worker', FakeWorker);
			const t = new FollowUpChart(opts);
			try {
				t.chart.addSeries('candlestick').setData(candles(200));
				const heat = t.chart.addSeries('heatmap', { valueMin: 0, valueMax: 50 }) as HeatmapSeriesApi;
				heat.setData(makeHeatData(false));
				t.chart.timeScale().setVisibleLogicalRange({ from: 95, to: 165 });
				await t.settle();
				expect(t.pixels().pixels).not.toEqual(expected);

				// Single-column correction shifts priceStart and updates values cleanly with no ghosts at old priceStart.
				heat.correct({ time: 120 * MINUTE, priceStart: 98, values: new Float32Array(5).fill(49) });
				await t.settle();
				expect(t.pixels().pixels).toEqual(expected);
				expect(heat.valueAt(120 * MINUTE + 1000, 98.2)).toBe(49);
				expect(heat.valueAt(120 * MINUTE + 1000, 95.2)).toBeNull();

				// Off-grid throws before sending.
				expect(() => heat.correct({ time: 120 * MINUTE, priceStart: 98.1, values: new Float32Array(5) })).toThrow(
					RangeError,
				);
			} finally {
				t.destroy();
			}
		});

		it(`corrects scatter points in place without ghost pixels and updates indicators (${mode})`, async () => {
			const opts = { worker: worker ? () => new FakeWorker() as unknown as Worker : false };
			const base = Array.from({ length: 40 }, (_, i) => ({
				time: (160 + i) * MINUTE,
				price: 100 + (i % 5),
				value: 10 + i,
			}));
			const expectedPoints = [
				...base.slice(0, 39),
				{ time: 199 * MINUTE + 100, price: 108, value: 99 },
				{ time: 199 * MINUTE + 200, price: 107, value: 88 },
				{ time: 199 * MINUTE + 300, price: 106, value: 77 },
			];
			let expected: Uint32Array;
			const ref = new FollowUpChart(opts);
			try {
				ref.chart.addSeries('candlestick').setData(candles(200));
				const refScatter = ref.chart.addSeries('scatter', { autoscale: false, pointSize: 5 }) as ScatterSeriesApi;
				refScatter.setData(expectedPoints);
				ref.chart.timeScale().setVisibleLogicalRange({ from: 155, to: 202 });
				await ref.settle();
				expected = ref.pixels().pixels;
			} finally {
				ref.destroy();
			}
			vi.stubGlobal('ImageData', FakeImageData);
			vi.stubGlobal('Worker', FakeWorker);
			const t = new FollowUpChart(opts);
			try {
				const bars = t.chart.addSeries('candlestick');
				bars.setData(candles(200));
				const scatter = t.chart.addSeries('scatter', { autoscale: false, pointSize: 5 }) as ScatterSeriesApi;
				scatter.setData(base);
				const countInd = bars.addIndicator('sma', {
					params: { period: 1 },
					priceScaleId: 'count',
					inputs: [{ series: scatter, column: 'count' }],
				});
				t.chart.timeScale().setVisibleLogicalRange({ from: 155, to: 202 });
				await t.settle();
				expect(countInd.output().lastValue()).toBe(1);

				scatter.correct(
					[
						{ time: 199 * MINUTE + 100, price: 108, value: 99 },
						{ time: 199 * MINUTE + 200, price: 107, value: 88 },
						{ time: 199 * MINUTE + 300, price: 106, value: 77 },
					],
					{ from: 199 * MINUTE, to: 200 * MINUTE },
				);
				await t.settle();
				expect(countInd.output().lastValue()).toBe(3);
				expect(t.pixels().pixels).toEqual(expected);
				expect(() => scatter.correct([], { from: 10, to: 5 })).toThrow(RangeError);
			} finally {
				t.destroy();
			}
		});
	}
});

describe('unified timeline from multiple mark series on a chart', () => {
	beforeEach(() => {
		vi.stubGlobal('ImageData', FakeImageData);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('shares one hidden timeline between heatmap and scatter and removes it only when the last leaves', async () => {
		const t = new FollowUpChart();
		try {
			const hm = t.chart.addSeries('heatmap', { timeline: true, valueMin: 0, valueMax: 50, autoscale: true });
			const sc = t.chart.addSeries('scatter', { timeline: { interval: MINUTE }, autoscale: false });
			hm.setData({
				priceStart: 98,
				priceStep: 1,
				rows: 4,
				time: Float64Array.of(1 * MINUTE, 3 * MINUTE, 5 * MINUTE),
				values: new Float32Array(12).fill(25),
			});
			sc.setData([
				{ time: 2 * MINUTE + 500, price: 100, value: 10 },
				{ time: 3 * MINUTE + 500, price: 101, value: 20 },
				{ time: 6 * MINUTE + 500, price: 99, value: 30 },
			]);
			t.chart.timeScale().fitContent();
			await t.settle();

			expect(t.chart.series()).toEqual([]);
			expect(JSON.stringify(t.chart.saveState().series)).not.toContain('"line"');
			// Union bars: minutes 1, 2, 3, 5, 6 -> logical 0, 1, 2, 3, 4.
			const view = t.probe.view!;
			expect(view.timeToX(1 * MINUTE)).toBeCloseTo(view.logicalToX(0), 6);
			expect(view.timeToX(2 * MINUTE)).toBeCloseTo(view.logicalToX(1), 6);
			expect(view.timeToX(3 * MINUTE)).toBeCloseTo(view.logicalToX(2), 6);
			expect(view.timeToX(5 * MINUTE)).toBeCloseTo(view.logicalToX(3), 6);
			expect(view.timeToX(6 * MINUTE)).toBeCloseTo(view.logicalToX(4), 6);

			const engine = (t.chart as unknown as { _data: { engine: { removeSeries(id: number): void } } })._data.engine;
			const removed = vi.spyOn(engine, 'removeSeries');

			// Removing heatmap keeps the shared timeline alive for scatter (minutes 2, 3, 6 -> logical 0, 1, 2).
			t.chart.removeSeries(hm);
			await t.settle();
			expect(removed).not.toHaveBeenCalled();
			expect(t.probe.view!.timeToX(2 * MINUTE)).toBeCloseTo(t.probe.view!.logicalToX(0), 6);
			expect(t.probe.view!.timeToX(3 * MINUTE)).toBeCloseTo(t.probe.view!.logicalToX(1), 6);
			expect(t.probe.view!.timeToX(6 * MINUTE)).toBeCloseTo(t.probe.view!.logicalToX(2), 6);

			// Invalid options on a new series do not disturb the existing timeline.
			expect(() => t.chart.addSeries('scatter', { timeline: true, color: 'not-a-color' })).toThrow(RangeError);

			// Removing the last contributor removes the hidden timeline once.
			t.chart.removeSeries(sc);
			await t.settle();
			expect(removed).toHaveBeenCalledTimes(1);
		} finally {
			t.destroy();
		}
	});
});

describe('scatter coarse LOD cell area rendering', () => {
	beforeEach(() => {
		vi.stubGlobal('ImageData', FakeImageData);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		pool.acquire.mockReset();
	});

	it('matches Canvas 2D, GLSL 5-word cell shader, and hitScatterCells pixel-for-pixel (square & circle, value & density)', () => {
		const width = 120;
		const height = 80;
		const map = new TimeMap();
		const times = Float64Array.from({ length: 12 }, (_, i) => i * 1000);
		map.set(times, 0, 12, 0, 0, 0, 5, 10);
		expect(map.maxPace).toBeCloseTo(0.01, 10);

		const projection = { offset: 75, scale: 5, log: false };
		expect(scatterCellArea(1, 500, 1, 12, map, projection, height)).toBe(true);
		expect(scatterCellArea(1, 50, 0.1, 12, map, projection, height)).toBe(false);
		expect(scatterCellArea(0, 500, 1, 12, map, projection, height)).toBe(false);

		const window = new MarksWindow();
		window.level = 1;
		window.count = 3;
		window.capacity = 3;
		window.timeStep = 2000;
		window.priceStep = 2;
		window.time = Float64Array.of(2000, 5000, 8000);
		window.price = Float64Array.of(5, 8, 6);
		window.values = Float32Array.of(10, 50, 90);
		window.counts = Float32Array.of(4, 7, 12);
		window.sizes = Float32Array.of(Number.NaN, 7, 4);
		window.bounds = Float64Array.of(1100, 2900, 4.2, 6.8, 4200, 5600, 7.1, 9.5, 7500, 8800, 4.5, 8.2);

		const palette = buildPalette('viridis');
		const mapping = { min: 0, factor: 1, log: false };
		setValueMapping(mapping, 0, 100, false);
		const fallback = parseColor('#ff0000')!;

		for (const circle of [false, true]) {
			const stamps = new StampCache();
			stamps.setCircle(circle);
			const baseStamp = makeStamp(5, circle);
			const canvasPixels = new Uint32Array(width * height);
			const box = { left: 0, top: 0, right: 0, bottom: 0 };
			emptyBox(box);
			drawScatterCells(
				canvasPixels,
				width,
				height,
				window.bounds,
				window.values,
				0,
				3,
				map,
				0,
				projection,
				palette,
				mapping,
				fallback,
				baseStamp,
				box,
				window.sizes,
				1,
				stamps,
			);

			const frame: MarkFrame = {
				type: 'scatter',
				window,
				map,
				projection,
				mapping,
				palette,
				options: {
					visible: true,
					priceScaleId: 'default',
					autoscale: true,
					opacity: 1,
					palette: 'viridis',
					valueMin: 0,
					valueMax: 100,
					valueScale: 'linear',
					maxMarks: 1000,
					pointSize: 5,
					shape: circle ? 'circle' : 'square',
					color: '#ff0000',
					colorBy: 'value',
					barAlign: 'center',
				},
				width,
				height,
				ratio: 1,
				from: 0,
				to: 3,
				cellArea: true,
			};
			const packed = new Uint32Array(3 * 5);
			const floats = new Float32Array(packed.buffer);
			const visible = packScatterCellRows(frame, packed, floats, 0, 3, fallback, false);
			expect(visible).toBe(3);
			const glPixels = emulateGlCellShader(packed, visible, width, height, circle);
			expect(glPixels).toEqual(canvasPixels);

			// Verify density accumulation and hitScatterCells agree on EVERY pixel of the pane!
			const density = new Float32Array(width * height);
			const dBox = { left: 0, top: 0, right: 0, bottom: 0 };
			emptyBox(dBox);
			accumulateScatterCells(
				density,
				width,
				height,
				window.bounds,
				window.counts,
				0,
				3,
				map,
				0,
				projection,
				baseStamp,
				dBox,
				window.sizes,
				1,
				stamps,
			);
			const hit = { row: -1, density: 0 };
			let litCount = 0;
			for (let x = 0; x < width; x++) {
				for (let y = 0; y < height; y++) {
					hitScatterCells(
						window.time,
						window.bounds,
						window.sizes,
						window.counts,
						window.timeStep,
						0,
						3,
						map,
						0,
						projection,
						baseStamp,
						stamps,
						1,
						7,
						width,
						height,
						x,
						y,
						hit,
					);
					const px = canvasPixels[x * height + y]!;
					const d = density[x * height + y]!;
					expect(hit.density).toBe(d);
					expect(hit.row >= 0).toBe(px !== 0);
					if (px !== 0) litCount++;
				}
			}
			expect(litCount).toBeGreaterThan(200);
		}
	});

	it('draws WebGL2 cells as quads after point sprites, with translucent colors premultiplied', async () => {
		const t = new FollowUpChart({ markRenderer: 'webgl2' });
		t.maxPointSize = 64;
		try {
			t.chart.addSeries('candlestick').setData(candles(200));
			const n = 100_000;
			const time = Float64Array.from({ length: n }, (_, i) => (i / n) * 199 * MINUTE);
			const price = Float64Array.from({ length: n }, (_, i) => 95 + ((i * 7) % 20) * 0.5);
			const value = Float32Array.from({ length: n }, (_, i) => i % 100);
			const stops = ['rgba(12,96,120,0.4)', 'rgba(220,120,50,0.65)'];
			const scatter = t.chart.addSeries('scatter', { pointSize: 2, shape: 'square', palette: stops });
			scatter.setData({ time, price, value });
			t.chart.timeScale().setVisibleLogicalRange({ from: 40, to: 80 });
			await t.settle();
			// Every point at level 0: one vertex each, as point sprites.
			expect(scatter.drawn().level).toBe(0);
			expect(t.gl!.draws.at(-1)!.uniforms['guard']![0]).toBeGreaterThan(0);

			scatter.applyOptions({ maxMarks: 250 });
			await t.settle();
			expect(scatter.drawn().level).toBeGreaterThan(0);
			const cells = t.gl!.draws.at(-1)!;
			// Boxes that are not square: instanced quads, whatever the last frame's sprites set.
			expect(cells.uniforms['recordWords']).toEqual([5]);
			expect(cells.uniforms['guard']).toEqual([0]);
			expect(cells.mode).toBe(t.gl!.TRIANGLE_STRIP);
			expect(cells.instances).toBeGreaterThan(0);
			// The color word of every cell record is a palette color premultiplied, as the drawing
			// buffer takes them (this document cannot be measured: the nearest byte).
			const premultiply = new Premultiplier({} as Document);
			const straight = buildPalette(stops);
			const premultiplied = new Set(Array.from(straight, color => premultiply.color(color)));
			expect([...straight].some(color => !premultiplied.has(color))).toBe(true);
			const records = t.gl!.textures.filter(texture => {
				if (texture.deleted || texture.data.length < cells.instances * 5) return false;
				for (let k = 0; k < cells.instances; k++) {
					if (!premultiplied.has(texture.data[k * 5 + 2]!)) return false;
				}
				return true;
			});
			expect(records).toHaveLength(1);
		} finally {
			t.destroy();
		}
	});

	it('draws super-pixel coarse cells via WebGL2 recordWords=5, routes them off WebGPU, and autoscales using true bounds', async () => {
		const paint = vi.fn<GpuBackend['paint']>(() => 'scatter-columns');
		const backend: GpuBackend = { paint, bytes: 0, kernel: 'scatter-columns', release: vi.fn<() => void>() };
		pool.acquire.mockImplementation((_doc, listener) => {
			listener(backend, null);
			return { release: vi.fn<() => void>() };
		});
		Object.defineProperty(window.navigator, 'gpu', { value: {}, configurable: true });
		const t = new FollowUpChart({ markRenderer: 'webgpu' });
		t.extensions = ['EXT_color_buffer_float', 'EXT_float_blend'];
		try {
			t.chart.addSeries('candlestick').setData(candles(200));
			const n = 100_000;
			const time = Float64Array.from({ length: n }, (_, i) => (i / n) * 199 * MINUTE);
			const price = Float64Array.from({ length: n }, (_, i) => 95 + ((i * 7) % 20) * 0.5);
			const value = Float32Array.from({ length: n }, (_, i) => i % 100);
			// Small maxMarks forces a coarse level whose timeStep spans several pixels per cell!
			const scatter = t.chart.addSeries('scatter', { pointSize: 2, maxMarks: 250, shape: 'square' });
			scatter.setData({ time, price, value });
			t.chart.timeScale().setVisibleLogicalRange({ from: 40, to: 80 });
			await t.settle();

			expect(scatter.drawn().level).toBeGreaterThan(0);
			// Super-pixel coarse cells route from WebGPU to WebGL2 with recordWords = 5.
			expect(scatter.renderer()).toMatchObject({ effective: 'webgl2', reason: 'unsupported-style' });
			const draw = t.gl!.draws.at(-1)!;
			expect(draw.fragment).toBe(scatterFragment);
			expect(draw.uniforms['recordWords']).toEqual([5]);

			// Density mode on super-pixel coarse cells also uses WebGL2 recordWords = 5!
			scatter.applyOptions({ colorBy: 'density', shape: 'circle' });
			await t.settle();
			const sumDraws = t.gl!.draws.filter(d => d.fragment === densityFragment);
			expect(sumDraws.at(-1)!.uniforms['recordWords']).toEqual([5]);
			expect(sumDraws.at(-1)!.uniforms['circle']).toEqual([1]);

			// Zooming out wide enough that coarse cells are sub-pixel (< 1 px) returns value mode to WebGPU!
			scatter.applyOptions({ colorBy: 'value', shape: 'square', maxMarks: 50_000 });
			t.chart.timeScale().fitContent();
			await vi.waitFor(async () => {
				await t.settle();
				expect(scatter.renderer().effective).toBe('webgpu');
			});
		} finally {
			Reflect.deleteProperty(window.navigator, 'gpu');
			t.destroy();
		}
	});
});
