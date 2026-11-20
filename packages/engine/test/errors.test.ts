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
