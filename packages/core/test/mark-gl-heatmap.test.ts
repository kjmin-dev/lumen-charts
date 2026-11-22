import type { HeatmapSeriesApi } from '@lumen-charts/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GpuBackend } from '../src/marks/backend';
import type { acquire } from '../src/marks/gpu/device';
import { heatFragment, heatSlotsFragment } from '../src/marks/gl/shaders';
import { setValueMapping } from '../src/marks/palette';
import type * as render from '../src/marks/render';
import { quantize } from '../src/marks/render';
import { canvasPixelsInUse } from '../src/shared/canvas-budget';
import { MINUTE, TestChart, candles } from './drawing-helpers';
import { FakeWebGl } from './fake-webgl';

vi.mock('../src/marks/render', async importOriginal => {
	const actual = await importOriginal<typeof render>();
	return { ...actual, quantize: vi.fn<typeof render.quantize>(actual.quantize) };
});
// A WebGPU device for the series that ask for one, whose backend the test hands over.
const pool = vi.hoisted(() => ({ acquire: vi.fn<typeof acquire>() }));
vi.mock('../src/marks/gpu/device.js', () => pool);

const COLUMNS = 10;
const ROWS = 20;

/** Columns at bars 100 to 109, cells a unit high from 90 to 110. */
function grid(value: (c: number, r: number) => number) {
	const time = Float64Array.from({ length: COLUMNS }, (_, c) => (100 + c) * MINUTE);
	const values = Float32Array.from({ length: COLUMNS * ROWS }, (_, i) => value(Math.floor(i / ROWS), i % ROWS));
	return { priceStart: 90, priceStep: 1, rows: ROWS, time, values };
}

/** The slots the Canvas 2D path draws `values` with, for a range of values fixed at `[min, max]`. */
function slotsOf(values: Float32Array, min: number, max: number, log = false): number[] {
	const mapping = { min: 0, factor: 0, log: false };
	setValueMapping(mapping, min, max, log);
	const slots = new Uint8Array(values.length);
	quantize(values, slots, ROWS, 0, values.length / ROWS, mapping);
	return [...slots];
}

/** A chart whose mark series draw through a fake WebGL2 context. */
class GlChart extends TestChart {
	public gl: FakeWebGl | null = null;

	public constructor() {
		super();
		const getContext = vi.mocked(HTMLCanvasElement.prototype.getContext);
		const canvas2d = getContext.getMockImplementation()!;
		const created = (gl: FakeWebGl): FakeWebGl => (this.gl = gl);
		getContext.mockImplementation(function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
			if (kind !== 'webgl2') return (canvas2d as (...args: unknown[]) => unknown).call(this, kind, ...rest);
			return created(new FakeWebGl(this));
		} as unknown as HTMLCanvasElement['getContext']);
	}

	/** The heatmap's records texture: unit 0 of its last draw. */
	public records(): Uint8Array {
		const texture = this.gl!.bound(0)!;
		return new Uint8Array(texture.data.buffer);
	}

	/** Words uploaded to a texture unit since `gl.uploads` was emptied. */
	public uploaded(unit: number): number {
		return this.gl!.uploads.filter(u => u.unit === unit).reduce((sum, u) => sum + u.width * u.height, 0);
	}

	public lastDraw() {
		return this.gl!.draws.at(-1)!;
	}
}

function path(heat: HeatmapSeriesApi): string | null {
	return (heat as unknown as { glHeatPath(): string | null }).glHeatPath();
}

describe('WebGL2 heatmap from palette slots', () => {
	let t: GlChart;
	let before: number;

	beforeEach(async () => {
		before = canvasPixelsInUse();
		t = new GlChart();
		t.chart.addSeries('candlestick', { id: 'bars' }).setData(candles(200));
		await t.settle();
	});

	afterEach(() => {
		t.destroy();
	});

	it('draws from slots only when valueMin and valueMax are both set', async () => {
		const data = grid((c, r) => (c === 2 && r === 3 ? Number.NaN : c * 20 + r));
		const auto = t.chart.addSeries('heatmap');
		auto.setData(data);
		await t.settle();
		expect(auto.renderer().effective).toBe('webgl2');
		expect(path(auto)).toBe('values');
		expect(t.lastDraw().fragment).toBe(heatFragment);
		expect(new Float32Array(t.records().buffer, 0, data.values.length)).toEqual(data.values);

		auto.applyOptions({ valueMin: 0 });
		await t.settle();
		expect(path(auto)).toBe('values');

		auto.applyOptions({ valueMax: 150, valueScale: 'log' });
		await t.settle();
		expect(path(auto)).toBe('slots');
		const draw = t.lastDraw();
		expect(draw.fragment).toBe(heatSlotsFragment);
		expect(draw.uniforms['rows']).toEqual([ROWS]);
		// 200 slots, four to a word: 50 words in a row 64 wide.
		expect(draw.uniforms['recordsStride']).toEqual([6, 63]);
		expect([...t.records().subarray(0, COLUMNS * ROWS)]).toEqual(slotsOf(data.values, 0, 150, true));
		expect(auto.renderer().path).toBe('webgl2');
	});

	it('uploads the slots of a changed last column, and only those', async () => {
		const data = grid((c, r) => c * 20 + r);
		const heat = t.chart.addSeries('heatmap', { valueMin: 0, valueMax: 199 });
		heat.setData(data);
		await t.settle();
		expect(path(heat)).toBe('slots');
		t.gl!.uploads.length = 0;
		vi.mocked(quantize).mockClear();

		const column = Float32Array.from({ length: ROWS }, (_, r) => (r % 3 === 0 ? Number.NaN : 199 - r * 7));
		heat.update({ time: 109 * MINUTE, values: column });
		await t.settle();
		// Column 9 holds cells 180 to 199: words 45 to 49.
		expect(t.uploaded(0)).toBe(5);
		expect(t.gl!.uploads.filter(u => u.unit === 0)).toEqual([{ unit: 0, x: 45, y: 0, width: 5, height: 1 }]);
		const cells = vi.mocked(quantize).mock.calls.reduce((sum, [, , rows, from, to]) => sum + (to - from) * rows, 0);
		expect(cells).toBe(ROWS);
		data.values.set(column, 9 * ROWS);
		expect([...t.records().subarray(0, COLUMNS * ROWS)]).toEqual(slotsOf(data.values, 0, 199));
		expect(t.lastDraw().fragment).toBe(heatSlotsFragment);
	});

	it('uploads the slots of the columns a pan brings into view', async () => {
		const columns = 200;
		const time = Float64Array.from({ length: columns }, (_, c) => c * MINUTE);
		const values = Float32Array.from({ length: columns * ROWS }, (_, i) => (i * 7) % 199);
		const heat = t.chart.addSeries('heatmap', { valueMin: 0, valueMax: 199 });
		heat.setData({ priceStart: 90, priceStep: 1, rows: ROWS, time, values });
		t.chart.timeScale().setVisibleLogicalRange({ from: 100, to: 140 });
		await t.settle();
		const expected = slotsOf(values, 0, 199);
		const cells = (from: number, to: number) => [from * ROWS, to * ROWS] as const;
		expect([...t.records().subarray(...cells(101, 139))]).toEqual(expected.slice(...cells(101, 139)));
		t.gl!.uploads.length = 0;
		vi.mocked(quantize).mockClear();

		t.chart.timeScale().setVisibleLogicalRange({ from: 104, to: 144 });
		await t.settle();
		expect(path(heat)).toBe('slots');
		// Four columns come into view, of five words each, and the edge columns around them.
		expect(t.uploaded(0)).toBeGreaterThanOrEqual(20);
		expect(t.uploaded(0)).toBeLessThanOrEqual(30);
		const quantized = vi.mocked(quantize).mock.calls.reduce((sum, [, , rows, from, to]) => sum + (to - from) * rows, 0);
		expect(quantized).toBe(t.uploaded(0) * 4);
		expect([...t.records().subarray(...cells(101, 143))]).toEqual(expected.slice(...cells(101, 143)));
	});

	it('takes a new palette without quantizing or uploading the slots again', async () => {
		const heat = t.chart.addSeries('heatmap', { valueMin: 0, valueMax: 199 });
		heat.setData(grid((c, r) => c * 20 + r));
		await t.settle();
		const records = [...t.records()];
		t.gl!.uploads.length = 0;
		vi.mocked(quantize).mockClear();

		heat.applyOptions({ palette: 'inferno' });
		await t.settle();
		expect(vi.mocked(quantize)).not.toHaveBeenCalled();
		expect(t.uploaded(0)).toBe(0);
		// The colors of the 256 slots, and no thresholds.
		expect(t.uploaded(2)).toBe(256);
		expect([...t.records()]).toEqual(records);
		expect(t.gl!.draws.length).toBeGreaterThan(0);
	});

	it('switches between values and slots as valueMin and valueMax come and go, and counts its memory', async () => {
		const data = grid((c, r) => c * 20 + r);
		const heat = t.chart.addSeries('heatmap', { valueMin: 10, valueMax: 120 });
		heat.setData(data);
		await t.settle();
		const slotsBytes = heat.renderer().bytes;
		expect(path(heat)).toBe('slots');

		heat.applyOptions({ valueMin: null, valueMax: null });
		await t.settle();
		expect(path(heat)).toBe('values');
		expect(t.lastDraw().fragment).toBe(heatFragment);
		expect(new Float32Array(t.records().buffer, 0, data.values.length)).toEqual(data.values);
		// 200 values in a row 256 wide, against 50 words of slots in a row 64 wide.
		expect(heat.renderer().bytes - slotsBytes).toBe(4 * (256 - 64));

		heat.applyOptions({ valueMin: 0, valueMax: 50 });
		await t.settle();
		expect(path(heat)).toBe('slots');
		expect(t.lastDraw().fragment).toBe(heatSlotsFragment);
		expect([...t.records().subarray(0, COLUMNS * ROWS)]).toEqual(slotsOf(data.values, 0, 50));
		expect(heat.renderer().bytes).toBe(slotsBytes);

		t.chart.removeSeries(heat);
		await t.settle();
		t.destroy();
		expect(canvasPixelsInUse()).toBe(before);
		t = new GlChart();
	});

	it('keeps the slots of a column patched while another renderer drew from the values', async () => {
		// WebGPU draws the patch from the values, then gives up for the memory budget: WebGL2 draws
		// from the slots, which must hold the patch although no frame asked for them in between.
		const paint = vi.fn<GpuBackend['paint']>(() => 'heatmap');
		const backend: GpuBackend = { paint, bytes: 0, kernel: 'heatmap', release: vi.fn<() => void>() };
		pool.acquire.mockImplementation((_doc, listener) => {
			listener(backend, null);
			return { release: vi.fn<() => void>() };
		});
		Object.defineProperty(window.navigator, 'gpu', { value: {}, configurable: true });
		try {
			const data = grid((c, r) => c * 20 + r);
			t.chart.applyOptions({ markRenderer: 'webgpu' });
			const heat = t.chart.addSeries('heatmap', { valueMin: 0, valueMax: 199 });
			heat.setData(data);
			// The device module loads, and the frame after it draws through WebGPU.
			await vi.waitFor(async () => {
				await t.settle();
				expect(paint).toHaveBeenCalled();
			});
			expect(heat.renderer().effective).toBe('webgpu');

			const column = Float32Array.from({ length: ROWS }, (_, r) => 199 - r * 9);
			heat.update({ time: 109 * MINUTE, values: column });
			await t.settle();
			expect(heat.renderer().effective).toBe('webgpu');

			paint.mockReturnValue('budget');
			heat.applyOptions({ opacity: 0.5 });
			await t.settle();
			expect(heat.renderer().reason).toBe('budget');
			expect(path(heat)).toBe('slots');
			data.values.set(column, 9 * ROWS);
			expect([...t.records().subarray(0, COLUMNS * ROWS)]).toEqual(slotsOf(data.values, 0, 199));
		} finally {
			Reflect.deleteProperty(window.navigator, 'gpu');
			pool.acquire.mockReset();
		}
	});
});
