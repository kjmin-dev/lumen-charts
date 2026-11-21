import { type EngineClient, EngineCore, type EngineEvent, createEngine, setMaxWorkers } from '@lumen-charts/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeWorker } from './fake-worker';
import { line, ohlcv, run, ticks } from './helpers';

function collect(engine: EngineClient): EngineEvent[] {
	const events: EngineEvent[] = [];
	engine.onevent = event => {
		events.push(event);
	};
	return events;
}

/** Makes the next command the engine runs throw `error`. */
function throwNext(error: unknown): void {
	vi.spyOn(EngineCore.prototype, 'run').mockImplementationOnce(function* () {
		yield;
		throw error;
	});
}

const factory = (): Worker => new FakeWorker() as unknown as Worker;

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	FakeWorker.behavior = 'ok';
	setMaxWorkers(4);
});

describe('rows the engine does not apply', () => {
	it('are counted by series', () => {
		const core = new EngineCore();
		run(core, { type: 'add', series: 1, kind: 'ohlcv' });
		run(core, { type: 'add', series: 2, kind: 'line' });
		run(core, { type: 'set', series: 1, count: 10, data: ohlcv(10, 0, 60_000) });
		run(core, { type: 'set', series: 2, count: 3, data: line([0, 60_000, 120_000], [1, 2, 3]) });
		// Between two bars of series 1, twice; before the first bar of series 2; a series nobody added.
		const event = run(core, ticks([1, 30_000, 1, 2, 0, 1, 1], [2, -60_000, 5], [1, 90_000, 1, 2, 0, 1, 1], [7, 0, 1]));
		expect(event.rejected).toBe(4);
		expect(event.rejectedSeries).toEqual([1, 2, 2, 1, 7, 1]);
	});

	it('include rows of a history whose times stop increasing', () => {
		const core = new EngineCore();
		run(core, { type: 'add', series: 1, kind: 'line' });
		const event = run(core, { type: 'set', series: 1, count: 4, data: line([0, 2, 1, 3], [1, 2, 3, 4]) });
		expect(event.rejectedSeries).toEqual([1, 2]);
	});

	it('leave the list out when every row applied', () => {
		const core = new EngineCore();
		run(core, { type: 'add', series: 1, kind: 'ohlcv' });
		run(core, { type: 'set', series: 1, count: 10, data: ohlcv(10, 0, 60_000) });
		const event = run(core, ticks([1, 9 * 60_000, 1, 2, 0, 1, 1], [1, 10 * 60_000, 1, 2, 0, 1, 1]));
		expect(event.rejected).toBe(0);
		expect(event.rejectedSeries).toBeUndefined();
	});
});

describe('a command that throws', () => {
	it('is answered with what was thrown on the calling thread', async () => {
		const engine = createEngine({ worker: false });
		const events = collect(engine);
		const error = new Error('kernel exploded');
		throwNext(error);
		engine.addSeries('line');
		await engine.whenIdle();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ failed: true, error: 'kernel exploded' });
		expect(events[0]!.cause).toBe(error);
		engine.destroy();
	});

	it('is answered with the text of what was thrown from a worker', async () => {
		vi.stubGlobal('Worker', FakeWorker);
		const engine = createEngine({ worker: factory });
		const events = collect(engine);
		throwNext('not an error object');
		engine.addSeries('line');
		await engine.whenIdle();
		expect(engine.mode).toBe('worker');
		expect(events[0]).toMatchObject({ failed: true, error: 'not an error object' });
		expect(events[0]!.cause).toBeUndefined();
		engine.destroy();
	});
});

describe('a worker that fails after it started', () => {
	beforeEach(() => {
		FakeWorker.created = [];
		vi.stubGlobal('Worker', FakeWorker);
		setMaxWorkers(1);
	});

	it('loses every engine on it, answers what they wait for and drops later commands', async () => {
		const first = createEngine({ worker: factory });
		const second = createEngine({ worker: factory });
		const lost: [string, string, unknown][] = [];
		first.onlost = (message, cause) => lost.push(['first', message, cause]);
		second.onlost = (message, cause) => lost.push(['second', message, cause]);
		const series = first.addSeries('ohlcv');
		second.addSeries('line');
		await Promise.all([first.whenIdle(), second.whenIdle()]);
		const worker = FakeWorker.created[0]!;
		expect(FakeWorker.created).toHaveLength(1);

		// A command on its way when the worker fails is never answered by it.
		first.setData(series, ohlcv(10), 10);
		expect(first.pending).toBe(1);
		const idle = first.whenIdle();
		worker.crash('error', 'out of memory');
		await idle;
		expect(worker.terminated).toBe(true);
		expect(lost.map(([who, message]) => [who, message])).toEqual([
			['first', 'The data engine worker failed: out of memory'],
			['second', 'The data engine worker failed: out of memory'],
		]);
		expect(lost[0]![2]).toMatchObject({ type: 'error' });
		expect(first.lost).toBe(true);
		expect(first.pending).toBe(0);
		expect(first.dataPending).toBe(false);

		// Later commands go nowhere and nobody waits for them.
		const sent = worker.received.length;
		first.tick(series, 0, 1, 2, 0, 1, 1);
		expect(first.requestWindow(0, 10, 16)).toBe(-1);
		await first.whenIdle();
		expect(worker.received).toHaveLength(sent);

		// The next engine gets a worker of its own rather than the failed one.
		const third = createEngine({ worker: factory });
		third.addSeries('line');
		await third.whenIdle();
		expect(FakeWorker.created).toHaveLength(2);
		expect(third.mode).toBe('worker');
		for (const engine of [first, second, third]) {
			engine.destroy();
		}
		expect(lost).toHaveLength(2);
	});

	it('loses its engines when a message from it cannot be read', async () => {
		const engine = createEngine({ worker: factory });
		const messages: string[] = [];
		engine.onlost = message => messages.push(message);
		engine.addSeries('line');
		await engine.whenIdle();
		FakeWorker.created[0]!.crash('messageerror');
		expect(messages).toEqual(['The data engine worker sent a message that could not be read']);
		engine.destroy();
	});

	it('still falls back to the calling thread when it fails before it answered', async () => {
		FakeWorker.behavior = 'error';
		const engine = createEngine({ worker: factory });
		const onlost = vi.fn<(message: string, cause: unknown) => void>();
		engine.onlost = onlost;
		engine.addSeries('line');
		await engine.whenIdle();
		expect(engine.mode).toBe('local');
		expect(onlost).not.toHaveBeenCalled();
		engine.destroy();
	});
});

/** Makes the first background step of an engine that has some throw `error`. */
function throwInBackground(error: unknown): void {
	const step = EngineCore.prototype.backgroundStep;
	let thrown = false;
	vi.spyOn(EngineCore.prototype, 'backgroundStep').mockImplementation(function (this: EngineCore) {
		if (!thrown && this.busy) {
			thrown = true;
			throw error;
		}
		return step.call(this);
	});
}

describe('background work that throws', () => {
	it('stops the background work of its engine alone and tells it, in a worker', async () => {
		FakeWorker.created = [];
		vi.stubGlobal('Worker', FakeWorker);
		setMaxWorkers(1);
		const first = createEngine({ worker: factory });
		const second = createEngine({ worker: factory });
		const firstEvents = collect(first);
		const lost: string[] = [];
		first.onlost = message => lost.push(message);
		second.onlost = message => lost.push(message);
		throwInBackground(new Error('kernel exploded'));
		// Levels of detail of a large history are left to the background.
		const series = first.addSeries('ohlcv');
		first.setData(series, ohlcv(600_000), 600_000);
		await first.whenIdle();
		const settle = async (remaining: number): Promise<void> => {
			await new Promise(resolve => setTimeout(resolve, 5));
			if (!firstEvents.some(event => event.failed === true) && remaining > 0) {
				await settle(remaining - 1);
			}
		};
		await settle(200);
		const failure = firstEvents.find(event => event.failed === true);
		expect(failure).toMatchObject({ failed: true, error: 'kernel exploded', computing: 0, stale: false });
		// The worker and the other engine on it go on.
		expect(lost).toEqual([]);
		expect(FakeWorker.created[0]!.terminated).toBe(false);
		const other = second.addSeries('line');
		second.setData(other, line([0, 60_000, 120_000], [1, 2, 3]), 3);
		await second.whenIdle();
		expect(second.lost).toBe(false);
		// The engine whose background work threw still answers commands.
		const answered = firstEvents.length;
		first.requestWindow(0, 100, 128);
		await first.whenIdle();
		expect(firstEvents.length).toBe(answered + 1);
		expect(firstEvents.at(-1)!.window).toBeDefined();
		first.destroy();
		second.destroy();
	});

	it('stops the background work and tells the client on the calling thread', async () => {
		const requestIdle = vi.fn<typeof requestIdleCallback>();
		vi.stubGlobal('requestIdleCallback', requestIdle);
		const error = new Error('kernel exploded');
		const engine = createEngine({ worker: false });
		const events = collect(engine);
		const series = engine.addSeries('ohlcv');
		// Leave levels of detail for the idle callback, as in the worker case above.
		engine.setData(series, ohlcv(600_000), 600_000);
		await engine.whenIdle();
		expect(requestIdle).toHaveBeenCalledOnce();
		const [idle] = requestIdle.mock.calls[0]!;
		// Install the mock just for this callback. Fake workers share the same prototype.
		vi.spyOn(EngineCore.prototype, 'backgroundStep').mockImplementationOnce(() => {
			throw error;
		});
		idle({ didTimeout: false, timeRemaining: () => 4 });
		const failure = events.find(event => event.failed === true);
		expect(failure).toMatchObject({ failed: true, error: 'kernel exploded', computing: 0 });
		expect(failure!.cause).toBe(error);
		engine.destroy();
	});
});
