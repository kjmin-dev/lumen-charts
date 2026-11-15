import {
	type Command,
	type EngineClient,
	type EngineEvent,
	type EngineScope,
	type ReadyMessage,
	attachEngineHost,
	createEngine,
} from '@lumen-charts/engine';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ohlcv } from './helpers';

/** A worker that runs the real engine host in this thread and delivers messages asynchronously. */
class FakeWorker {
	public static behavior: 'ok' | 'error' | 'silent' = 'ok';
	public terminated = false;
	public received: Command[] = [];
	private readonly _listeners = new Map<string, Set<(event: MessageEvent) => void>>();
	private readonly _scopeListeners: ((event: MessageEvent<Command>) => void)[] = [];
	private readonly _scope: EngineScope;

	public constructor() {
		this._scope = {
			addEventListener: (_type, listener) => {
				this._scopeListeners.push(listener);
			},
			postMessage: (message: EngineEvent | ReadyMessage) => {
				queueMicrotask(() => {
					this._emit('message', { data: message } as MessageEvent);
				});
			},
		};
		const behavior = FakeWorker.behavior;
		queueMicrotask(() => {
			if (behavior === 'ok') {
				attachEngineHost(this._scope);
			} else if (behavior === 'error') {
				this._emit('error', {} as MessageEvent);
			}
		});
	}

	public addEventListener(type: string, listener: (event: MessageEvent) => void): void {
		let listeners = this._listeners.get(type);
		if (listeners === undefined) {
			listeners = new Set();
			this._listeners.set(type, listeners);
		}
		listeners.add(listener);
	}

	public removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
		this._listeners.get(type)?.delete(listener);
	}

	public postMessage(command: Command): void {
		this.received.push(command);
		queueMicrotask(() => {
			for (const listener of this._scopeListeners) {
				listener({ data: command } as MessageEvent<Command>);
			}
		});
	}

	public terminate(): void {
		this.terminated = true;
	}

	private _emit(type: string, event: MessageEvent): void {
		if (this.terminated) {
			return;
		}
		// Like a real event target, deliver to the listeners registered when dispatch starts.
		const listeners = Array.from(this._listeners.get(type) ?? []);
		for (const listener of listeners) {
			listener(event);
		}
	}
}

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
