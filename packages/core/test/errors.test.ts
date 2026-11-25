import type { ChartError } from '@lumen-ticks/core';
import { EngineCore, setMaxWorkers } from '@lumen-ticks/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeWorker } from '../../engine/test/fake-worker';
import { MINUTE, TestChart, candles } from './drawing-helpers';

/** Makes the next command the engine runs throw `error`. */
function throwNext(error: unknown): void {
	vi.spyOn(EngineCore.prototype, 'run').mockImplementationOnce(function* () {
		yield;
		throw error;
	});
}

const factory = (): Worker => new FakeWorker() as unknown as Worker;

describe('chart errors', () => {
	let t: TestChart;
	let reported: ReturnType<typeof vi.fn<(error: unknown) => void>>;
	let errors: ChartError[];

	beforeEach(() => {
		reported = vi.fn<(error: unknown) => void>();
		errors = [];
		FakeWorker.created = [];
	});

	afterEach(() => {
		t.destroy();
		FakeWorker.behavior = 'ok';
		setMaxWorkers(4);
	});

	/** A chart whose page errors land in `reported`. */
	function chart(worker = false): TestChart {
		t = new TestChart({ worker: worker ? factory : false });
		vi.stubGlobal('reportError', reported);
		if (worker) {
			vi.stubGlobal('Worker', FakeWorker);
		}
		return t;
	}

	it('hands a command the engine threw on to the handlers, with what was thrown', async () => {
		chart();
		const unsubscribe = t.chart.subscribe('error', error => errors.push(error));
		const series = t.chart.addSeries('candlestick');
		series.setData(candles(50));
		await t.settle();
		const thrown = new Error('kernel exploded');
		throwNext(thrown);
		series.update({ time: 50 * MINUTE, open: 1, high: 2, low: 0, close: 1 });
		await t.settle();
		expect(errors).toEqual([{ kind: 'engine', message: 'kernel exploded', cause: thrown }]);
		expect(reported).not.toHaveBeenCalled();

		// The chart goes on: later data is applied.
		unsubscribe();
		series.update({ time: 50 * MINUTE, open: 1, high: 2, low: 0, close: 1 });
		t.chart.timeScale().fitContent();
		await t.settle();
		expect(t.chart.timeScale().getVisibleLogicalRange()!.to).toBeGreaterThanOrEqual(50);
		expect(errors).toHaveLength(1);
	});

	it('reports engine errors to the page without a handler', async () => {
		chart();
		const thrown = new Error('kernel exploded');
		throwNext(thrown);
		t.chart.addSeries('candlestick');
		await t.settle();
		expect(reported).toHaveBeenCalledTimes(1);
		expect(reported.mock.calls[0]![0]).toBe(thrown);
	});

	it('names the series and the count of updates the engine refused', async () => {
		chart();
		t.chart.subscribe('error', error => errors.push(error));
		const series = t.chart.addSeries('candlestick', { id: 'btc' });
		series.setData(candles(50));
		await t.settle();
		// Between two bars: refused, twice in one task, so in one command.
		series.update({ time: 10.5 * MINUTE, open: 1, high: 2, low: 0, close: 1 });
		series.update({ time: 20.5 * MINUTE, open: 1, high: 2, low: 0, close: 1 });
		await t.settle();
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({ kind: 'refused', seriesId: 'btc', count: 2 });
		expect(errors[0]!.message).toContain('series "btc"');
	});

	it('reports refused updates nowhere without a handler', async () => {
		chart();
		const series = t.chart.addSeries('line');
		series.setData({ time: [0, MINUTE, 2 * MINUTE], value: [1, 2, 3] });
		await t.settle();
		series.update({ time: MINUTE / 2, value: 4 });
		await t.settle();
		expect(reported).not.toHaveBeenCalled();
	});

	it('stops calling a handler once unsubscribed', async () => {
		chart();
		const handler = vi.fn<(error: ChartError) => void>();
		const unsubscribe = t.chart.subscribe('error', handler);
		unsubscribe();
		unsubscribe();
		throwNext(new Error('nobody listens'));
		t.chart.addSeries('line');
		await t.settle();
		expect(handler).not.toHaveBeenCalled();
		expect(reported).toHaveBeenCalledTimes(1);
	});

	it('throws for an event it does not have', () => {
		chart();
		expect(() => t.chart.subscribe('nothing' as 'error', () => {})).toThrow(/no event "nothing"/);
	});

	describe('a worker that fails after it started', () => {
		it('settles whoever waits, keeps drawing what the chart holds, and takes no more data', async () => {
			chart(true);
			t.chart.subscribe('error', error => errors.push(error));
			const series = t.chart.addSeries('candlestick');
			series.setData(candles(200));
			await t.settle();
			expect(t.chart.engineMode()).toBe('worker');
			const range = t.chart.timeScale().getVisibleLogicalRange();

			// Data and a view change wait for the engine when the worker fails.
			series.setData(candles(300));
			t.chart.timeScale().fitContent();
			const idle = t.chart.whenIdle();
			const applied = t.chart.whenApplied();
			FakeWorker.created[0]!.crash('error', 'out of memory');
			await t.settle();
			await Promise.all([idle, applied]);
			expect(errors).toHaveLength(1);
			expect(errors[0]).toMatchObject({ kind: 'worker', message: 'The data engine worker failed: out of memory' });
			expect(errors[0]!.cause).toMatchObject({ type: 'error' });

			// The view change ran on the bars the chart held; they are drawn.
			expect(t.chart.timeScale().getVisibleLogicalRange()).not.toEqual(range);
			t.clearCalls();
			t.chart.applyOptions({ layout: { background: '#000000' } });
			t.runFrames();
			expect(t.pane.some(call => call.name === 'fillRect')).toBe(true);

			// Later calls change nothing and keep nobody waiting.
			series.update({ time: 200 * MINUTE, open: 1, high: 2, low: 0, close: 1 });
			series.setData(candles(10));
			await t.settle();
			await expect(t.chart.registerIndicators('https://example.com/indicators.js')).rejects.toThrow(/stopped/);
			expect(errors).toHaveLength(1);
		});

		it('gives every chart on the worker an error of its own', async () => {
			chart(true);
			setMaxWorkers(1);
			const other = new TestChart({ worker: factory });
			try {
				const otherErrors: ChartError[] = [];
				t.chart.subscribe('error', error => errors.push(error));
				other.chart.subscribe('error', error => otherErrors.push(error));
				t.chart.addSeries('line').setData({ time: [0, MINUTE], value: [1, 2] });
				other.chart.addSeries('line').setData({ time: [0, MINUTE], value: [3, 4] });
				await Promise.all([t.settle(), other.settle()]);
				expect(FakeWorker.created).toHaveLength(1);
				FakeWorker.created[0]!.crash();
				expect(errors.map(error => error.kind)).toEqual(['worker']);
				expect(otherErrors.map(error => error.kind)).toEqual(['worker']);
			} finally {
				other.chart.destroy();
				other.container.remove();
			}
		});

		it('is reported to the page without a handler', async () => {
			chart(true);
			t.chart.addSeries('line').setData({ time: [0, MINUTE], value: [1, 2] });
			await t.settle();
			FakeWorker.created[0]!.crash('messageerror');
			expect(reported).toHaveBeenCalledTimes(1);
			const error = reported.mock.calls[0]![0] as Error;
			expect(error.message).toBe('lumen-ticks: The data engine worker sent a message that could not be read');
			expect(error.cause).toMatchObject({ type: 'messageerror' });
		});
	});
});
