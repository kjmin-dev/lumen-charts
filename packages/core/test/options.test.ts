import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	type WorkerConstructor,
	type WorkerOption,
	configureWorker,
	createChart,
	createWorkerPool,
} from '../src/index';
import { mergeOptions, optionsEqual, resolveOptions, themes } from '../src/options';
import { dashPattern, isFaint, textColorOn } from '../src/render/chrome';
import { FakeWorker } from '../../engine/test/fake-worker';

describe('resolveOptions', () => {
	it('lays the theme over the defaults and what was set over the theme', () => {
		const light = resolveOptions({}, false);
		expect(light.theme).toBe('light');
		expect(light.layout.background).toBe(themes.light.layout.background);
		expect(light.layout.fontSize).toBe(12);

		const dark = resolveOptions({ theme: 'dark', grid: { horzLines: { color: '#ff00ff' } } }, false);
		expect(dark.layout.background).toBe(themes.dark.layout.background);
		expect(dark.crosshair.vertLine.labelBackgroundColor).toBe(themes.dark.crosshair.vertLine.labelBackgroundColor);
		expect(dark.grid.vertLines.color).toBe(themes.dark.grid.vertLines.color);
		expect(dark.grid.horzLines.color).toBe('#ff00ff');
		// Values a theme doesn't set are the same in every theme.
		expect(dark.grid.horzLines.visible).toBe(true);
		expect(dark.crosshair.vertLine.style).toBe('dashed');
	});

	it('resolves auto to the system scheme', () => {
		expect(resolveOptions({ theme: 'auto' }, true).layout.background).toBe(themes.dark.layout.background);
		expect(resolveOptions({ theme: 'auto' }, false).layout.background).toBe(themes.light.layout.background);
		expect(resolveOptions({ theme: 'auto' }, true).theme).toBe('auto');
	});

	it('ignores keys and shapes the options do not have', () => {
		const options = resolveOptions(
			{ background: '#123456', layout: 'red', grid: { vertLines: { visible: false, extra: 1 } } } as never,
			false,
		);
		expect('background' in options).toBe(false);
		expect(options.layout.background).toBe(themes.light.layout.background);
		expect(options.grid.vertLines.visible).toBe(false);
		expect('extra' in options.grid.vertLines).toBe(false);
	});
});

const worker = (): Worker => ({}) as Worker;

describe('mergeOptions', () => {
	it('merges nested values, skips undefined and copies what it takes', () => {
		const patch = { layout: { textColor: '#111111' } };
		const merged = mergeOptions<Record<string, unknown>>({ layout: { background: '#000000' }, width: 1 }, {
			...patch,
			width: undefined,
		} as never);
		expect(merged).toEqual({ layout: { background: '#000000', textColor: '#111111' }, width: 1 });
		patch.layout.textColor = '#222222';
		expect((merged.layout as { textColor: string }).textColor).toBe('#111111');
	});

	it('keeps functions, constructors, URLs and worker pools intact without flattening them', () => {
		class BundlerWorker extends FakeWorker {}
		const ctor = BundlerWorker as unknown as WorkerConstructor;
		const url = new URL('https://example.test/worker.js');
		const pool = createWorkerPool({ maxWorkers: 2 });

		expect(mergeOptions({ worker: true as WorkerOption }, { worker }).worker).toBe(worker);
		expect(mergeOptions({ worker: true as WorkerOption }, { worker: ctor }).worker).toBe(ctor);
		expect(mergeOptions({ worker: true as WorkerOption }, { worker: url }).worker).toBe(url);
		expect(mergeOptions({ worker: true as WorkerOption }, { worker: pool }).worker).toBe(pool);
		expect(resolveOptions({ worker: url }, false).worker).toBe(url);
		expect(resolveOptions({ worker: pool }, false).worker).toBe(pool);
		expect(resolveOptions({ worker: 'dedicated' }, false).worker).toBe('dedicated');
		pool.destroy();
	});
});

describe('optionsEqual', () => {
	it('compares nested objects by value and URLs by href', () => {
		expect(optionsEqual({ a: { b: 1 } }, { a: { b: 1 } })).toBe(true);
		expect(optionsEqual({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
		expect(optionsEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
		expect(
			optionsEqual(
				{ worker: new URL('https://example.test/worker.js') },
				{ worker: new URL('https://example.test/worker.js') },
			),
		).toBe(true);
		expect(
			optionsEqual({ worker: new URL('https://example.test/a.js') }, { worker: new URL('https://example.test/b.js') }),
		).toBe(false);
		const poolA = createWorkerPool();
		const poolB = createWorkerPool();
		expect(optionsEqual({ worker: poolA }, { worker: poolA })).toBe(true);
		expect(optionsEqual({ worker: poolA }, { worker: poolB })).toBe(false);
		poolA.destroy();
		poolB.destroy();
	});
});

describe('chart worker configuration', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		FakeWorker.created = [];
		configureWorker({ source: true, maxWorkers: 4, timeout: 4000 });
	});

	it('respects configureWorker(false), WorkerConstructor, dedicated mode and explicit WorkerPool', async () => {
		vi.stubGlobal('Worker', FakeWorker);

		configureWorker(false);
		const localChart = createChart(document.createElement('div'), { autoSize: false });
		localChart.addSeries('line');
		expect(localChart.engineMode()).toBe('local');
		localChart.destroy();

		class ViteChartWorker extends FakeWorker {}
		configureWorker({ source: ViteChartWorker as unknown as WorkerConstructor, maxWorkers: 1 });
		const sharedA = createChart(document.createElement('div'), { autoSize: false });
		const sharedB = createChart(document.createElement('div'), { autoSize: false });
		const dedicated = createChart(document.createElement('div'), { autoSize: false, worker: 'dedicated' });
		sharedA.addSeries('line');
		sharedB.addSeries('line');
		dedicated.addSeries('line');
		await Promise.all([sharedA.whenApplied(), sharedB.whenApplied(), dedicated.whenApplied()]);
		expect(sharedA.engineMode()).toBe('worker');
		expect(sharedB.engineMode()).toBe('worker');
		expect(dedicated.engineMode()).toBe('worker');
		expect(FakeWorker.created.length).toBe(2);
		sharedA.destroy();
		sharedB.destroy();
		dedicated.destroy();

		const pool = createWorkerPool({ worker: ViteChartWorker as unknown as WorkerConstructor, maxWorkers: 1 });
		const pooled = createChart(document.createElement('div'), { autoSize: false, worker: pool });
		pooled.addSeries('line');
		await pooled.whenApplied();
		expect(pooled.engineMode()).toBe('worker');
		expect(pool.activeWorkers).toBe(1);
		expect(pool.engines).toBe(1);
		pooled.destroy();
		pool.destroy();
	});
});

describe('dashPattern', () => {
	it('scales with the unit and shares arrays', () => {
		expect(dashPattern('solid', 2)).toEqual([]);
		expect(dashPattern('dotted', 1)).toEqual([1, 2]);
		expect(dashPattern('dashed', 2)).toEqual([6, 6]);
		expect(dashPattern('dashed', 2)).toBe(dashPattern('dashed', 2.2));
	});
});

describe('textColorOn', () => {
	/** A context that reports colors the way browsers do for these inputs: unchanged. */
	const ctx = { fillStyle: '' } as unknown as CanvasRenderingContext2D;

	it('picks dark text on light colors and white text on dark ones', () => {
		expect(textColorOn(ctx, '#ffffff')).toBe('#0e1116');
		expect(textColorOn(ctx, '#f5b83d')).toBe('#0e1116');
		expect(textColorOn(ctx, 'rgba(255, 255, 0, 1)')).toBe('#0e1116');
		expect(textColorOn(ctx, '#000000')).toBe('#ffffff');
		expect(textColorOn(ctx, '#ef5350')).toBe('#ffffff');
		expect(textColorOn(ctx, '#2962ff')).toBe('#ffffff');
		expect(textColorOn(ctx, '#26a69a')).toBe('#ffffff');
		expect(textColorOn(ctx, '#ff9800')).toBe('#0e1116');
		// Colors it cannot read get white text.
		expect(textColorOn(ctx, 'color(display-p3 1 1 1)')).toBe('#ffffff');
	});

	it('tells faint colors from opaque ones', () => {
		expect(isFaint(ctx, 'rgba(0, 0, 0, 0)')).toBe(true);
		expect(isFaint(ctx, 'rgba(38, 166, 154, 0.2)')).toBe(true);
		expect(isFaint(ctx, 'rgba(38, 166, 154, 0.8)')).toBe(false);
		expect(isFaint(ctx, '#26a69a')).toBe(false);
		expect(isFaint(ctx, 'color(display-p3 1 1 1)')).toBe(false);
	});
});
