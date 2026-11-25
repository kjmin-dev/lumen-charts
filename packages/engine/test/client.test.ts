import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type EngineClient, type EngineEvent, LocalTransport, createEngine } from '@lumen-ticks/engine';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeWorker } from './fake-worker';
import { ohlcv } from './helpers';

/** Module loading goes through the bundler's transform, which can take a while on a busy machine. */
const WAIT = { timeout: 10_000 };

function collect(engine: EngineClient): EngineEvent[] {
	const events: EngineEvent[] = [];
	engine.onevent = event => {
		events.push(event);
	};
	return events;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
	FakeWorker.behavior = 'ok';
});

describe('EngineClient on the calling thread', () => {
	it('answers every command asynchronously and in order', async () => {
		const engine = createEngine({ worker: false });
		const events = collect(engine);
		const series = engine.addSeries('ohlcv');
		engine.setData(series, ohlcv(100), 100);
		engine.requestWindow(0, 100, 128);
		expect(events.length).toBe(0);
		expect(engine.pending).toBe(3);
		await engine.whenIdle();
		expect(engine.mode).toBe('local');
		expect(events.map(event => event.ack)).toEqual([1, 2, 3]);
		expect(events[2]!.window!.count).toBe(100);
		expect(engine.pending).toBe(0);
		engine.destroy();
	});

	it('sends ticks issued in one task as one command, ahead of later commands', async () => {
		const engine = createEngine({ worker: false });
		const events = collect(engine);
		const series = engine.addSeries('ohlcv');
		engine.setData(series, ohlcv(10, 0, 60_000), 10);
		for (let i = 0; i < 1000; i++) {
			engine.tick(series, 9 * 60_000, 1, 2, 0, i, 5);
		}
		expect(engine.pending).toBe(3);
		engine.requestWindow(0, 10, 16);
		await engine.whenIdle();
		expect(events.length).toBe(4);
		expect(events[2]!.patches!.find(patch => patch.series === series)!.data[3]).toBe(999);
		// The window was requested after the ticks, so it already holds their result.
		const window = events[3]!.window!;
		expect(window.series[0]!.data[3 * window.capacity + 9]).toBe(999);
		engine.destroy();
	});

	it('does not count window requests as pending data', async () => {
		const engine = createEngine({ worker: false });
		const series = engine.addSeries('line');
		engine.setData(series, new Float64Array([1, 2, 10, 20]), 2);
		expect(engine.dataPending).toBe(true);
		expect(engine.barrier()).toBe(2);
		await engine.whenIdle();
		engine.requestWindow(0, 2, 2);
		expect(engine.pending).toBe(1);
		expect(engine.dataPending).toBe(false);
		expect(engine.barrier()).toBe(2);
		engine.tick(series, 3, 30);
		expect(engine.dataPending).toBe(true);
		// Flushing the buffered ticks issues them after the window request.
		expect(engine.barrier()).toBe(4);
		await engine.whenIdle();
		expect(engine.dataPending).toBe(false);
		engine.destroy();
	});

	it('time-slices a large load across tasks without reordering', async () => {
		const engine = createEngine({ worker: false });
		const events = collect(engine);
		const series = engine.addSeries('ohlcv');
		const count = 400_000;
		engine.setData(series, ohlcv(count), count);
		engine.tick(series, count * 60_000, 1, 1, 1, 1, 1);
		await engine.whenIdle();
		expect(events.map(event => event.ack)).toEqual([1, 2, 3]);
		expect(events[1]!.end).toBe(count);
		expect(events[2]!.end).toBe(count + 1);
		engine.destroy();
	});

	it('resolves idle waiters and ignores calls after destroy', async () => {
		const engine = createEngine({ worker: false });
		const events = collect(engine);
		engine.addSeries('line');
		const idle = engine.whenIdle();
		engine.destroy();
		await idle;
		engine.addSeries('line');
		engine.tick(1, 1, 1);
		expect(engine.pending).toBe(0);
		await Promise.resolve();
		expect(events.length).toBe(0);
	});
});

describe('EngineClient with a worker', () => {
	it('holds commands until the worker is ready, then uses it', async () => {
		vi.stubGlobal('Worker', FakeWorker);
		let worker: FakeWorker | undefined;
		const engine = createEngine({
			worker: () => {
				worker = new FakeWorker();
				return worker as unknown as Worker;
			},
		});
		const events = collect(engine);
		const series = engine.addSeries('ohlcv');
		engine.setData(series, ohlcv(50), 50);
		expect(engine.mode).toBe('connecting');
		expect(worker!.received.length).toBe(0);
		await engine.whenIdle();
		expect(engine.mode).toBe('worker');
		expect(worker!.received.map(command => command.type)).toEqual(['add', 'set']);
		expect(events[1]!.end).toBe(50);
		engine.destroy();
		expect(worker!.terminated).toBe(true);
	});

	it('falls back to the calling thread when the worker reports an error', async () => {
		vi.stubGlobal('Worker', FakeWorker);
		FakeWorker.behavior = 'error';
		let worker: FakeWorker | undefined;
		const engine = createEngine({
			worker: () => {
				worker = new FakeWorker();
				return worker as unknown as Worker;
			},
		});
		const events = collect(engine);
		const series = engine.addSeries('ohlcv');
		const data = ohlcv(50);
		engine.setData(series, data, 50);
		await engine.whenIdle();
		expect(engine.mode).toBe('local');
		expect(worker!.terminated).toBe(true);
		expect(worker!.received.length).toBe(0);
		// The data was never given to the failed worker, so the fallback could still load it.
		expect(events[1]!.end).toBe(50);
		engine.destroy();
	});

	it('falls back when creating the worker throws', async () => {
		vi.stubGlobal('Worker', FakeWorker);
		const engine = createEngine({
			worker: () => {
				throw new Error('SecurityError');
			},
		});
		expect(engine.mode).toBe('local');
		const events = collect(engine);
		engine.addSeries('line');
		await engine.whenIdle();
		expect(events.length).toBe(1);
		engine.destroy();
	});

	it('stops a worker that has not answered when destroyed', () => {
		vi.stubGlobal('Worker', FakeWorker);
		FakeWorker.behavior = 'silent';
		let worker: FakeWorker | undefined;
		const engine = createEngine({
			worker: () => {
				worker = new FakeWorker();
				return worker as unknown as Worker;
			},
		});
		engine.addSeries('line');
		engine.destroy();
		expect(worker!.terminated).toBe(true);
		expect(engine.pending).toBe(0);
	});

	it('falls back when the worker never answers', async () => {
		vi.stubGlobal('Worker', FakeWorker);
		FakeWorker.behavior = 'silent';
		const engine = createEngine({ worker: () => new FakeWorker() as unknown as Worker, workerTimeout: 20 });
		const events = collect(engine);
		engine.addSeries('line');
		await engine.whenIdle();
		expect(engine.mode).toBe('local');
		expect(events.length).toBe(1);
		engine.destroy();
	});
});

describe('indicator plugins', () => {
	const pluginUrl = pathToFileURL(resolvePath('packages/engine/test/fixtures/plugin.ts')).href;

	for (const mode of ['worker', 'local'] as const) {
		it(`loads a module of indicators and computes them in the engine (${mode})`, async () => {
			vi.stubGlobal('Worker', FakeWorker);
			const engine = createEngine({ worker: mode === 'worker' ? () => new FakeWorker() as unknown as Worker : false });
			const events = collect(engine);
			const series = engine.addSeries('ohlcv');
			engine.setData(series, ohlcv(100), 100);
			engine.loadPlugin(pluginUrl);
			await vi.waitFor(() => {
				expect(events.some(event => event.plugins !== undefined)).toBe(true);
			}, WAIT);
			expect(engine.mode).toBe(mode);
			const result = events.find(event => event.plugins !== undefined)!.plugins![0]!;
			expect(result.url).toBe(pluginUrl);
			expect(result.indicators!.map(info => info.name)).toEqual(['test-momentum', 'test-range', 'test-decay']);
			const inputs = [
				{ series, column: 2 },
				{ series, column: 3 },
			];
			const { outputs } = engine.addIndicator('test-range', [], inputs, 1);
			// The values are computed in the background and announced by a notice.
			await vi.waitFor(() => {
				expect(events.some(event => event.stale && event.computing === undefined && event.patches !== undefined)).toBe(
					true,
				);
			}, WAIT);
			engine.requestWindow(0, 100, 100);
			await engine.whenIdle();
			const window = events[events.length - 1]!.window!;
			const values = window.series.find(entry => entry.series === outputs[0])!.data;
			// High minus low is 4 on every bar of the helper's data, summed from the first bar.
			expect(Array.from(values.subarray(0, 5))).toEqual([4, 8, 12, 16, 20]);
			expect(values[99]).toBe(400);
			engine.destroy();
		});
	}
});

describe('LocalTransport', () => {
	it('keeps computing indicators when a command ends just as its slice does', async () => {
		// Every reading of the clock moves it 5 ms on: each slice ends right after the step it began with.
		let clock = 0;
		vi.spyOn(performance, 'now').mockImplementation(() => (clock += 5));
		const transport = new LocalTransport();
		const events: EngineEvent[] = [];
		transport.onevent = event => {
			events.push(event);
		};
		const inputs = [{ series: 1, column: 4 }];
		transport.post({ type: 'add', seq: 1, series: 1, kind: 'ohlcv' }, []);
		transport.post({ type: 'set', seq: 2, series: 1, count: 100, data: ohlcv(100) }, []);
		transport.post({ type: 'indicator', seq: 3, id: 10, name: 'sma', params: [5], inputs, outputs: [11] }, []);
		await vi.waitFor(() => {
			expect(events.some(event => event.ack === 3 && event.stale && event.computing === undefined)).toBe(true);
		}, WAIT);
		transport.close();
		vi.restoreAllMocks();
	});
});
