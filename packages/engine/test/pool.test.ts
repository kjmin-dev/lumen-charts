import {
	type EngineClient,
	EngineCore,
	type EngineEvent,
	createEngine,
	getMaxWorkers,
	setMaxWorkers,
} from '@lumen-charts/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeWorker } from './fake-worker';
import { ohlcv } from './helpers';

function collect(engine: EngineClient): EngineEvent[] {
	const events: EngineEvent[] = [];
	engine.onevent = event => {
		events.push(event);
	};
	return events;
}

const factory = (): Worker => new FakeWorker() as unknown as Worker;
const other = (): Worker => new FakeWorker() as unknown as Worker;
const firstWorker = (): FakeWorker => FakeWorker.created[0]!;
const engineIds = (worker: FakeWorker): (number | undefined)[] => worker.received.map(message => message.engine);
/** The notice of indicator values swapped in, which answers no command: it carries their latest values. */
const swapNotice = (events: EngineEvent[]): EngineEvent | undefined =>
	events.find(event => event.stale && event.computing === undefined && event.patches !== undefined);
/** The values of a series in the last window answered. */
const windowValues = (events: EngineEvent[], series: number): Float64Array =>
	events.at(-1)!.window!.series.find(entry => entry.series === series)!.data;

describe('shared engine workers', () => {
	let engines: EngineClient[];
	const create = (worker: () => Worker = factory, workerTimeout?: number): EngineClient => {
		const engine = createEngine({ worker, ...(workerTimeout === undefined ? {} : { workerTimeout }) });
		engines.push(engine);
		return engine;
	};
	const idle = (): Promise<void[]> => Promise.all(engines.map(engine => engine.whenIdle()));

	beforeEach(() => {
		engines = [];
		FakeWorker.created = [];
		vi.stubGlobal('Worker', FakeWorker);
		setMaxWorkers(1);
	});

	afterEach(() => {
		for (const engine of engines) {
			engine.destroy();
		}
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		FakeWorker.behavior = 'ok';
		setMaxWorkers(4);
	});

	it('gives the first engines a worker each, then shares the worker with the fewest engines', async () => {
		setMaxWorkers(2);
		expect(getMaxWorkers()).toBe(2);
		const all = [0, 1, 2, 3, 4].map(() => create());
		for (const engine of all) {
			engine.addSeries('line');
		}
		await idle();
		expect(FakeWorker.created.length).toBe(2);
		expect(all.map(engine => engine.mode)).toEqual(['worker', 'worker', 'worker', 'worker', 'worker']);
		expect(engineIds(FakeWorker.created[0]!)).toEqual([0, 1, 2]);
		expect(engineIds(FakeWorker.created[1]!)).toEqual([0, 1]);

		// A place given back is the next one taken.
		all[3]!.destroy();
		const next = create();
		next.addSeries('line');
		await idle();
		expect(FakeWorker.created.length).toBe(2);
		expect(engineIds(FakeWorker.created[1]!).at(-1)).toBe(2);

		// An engine that joins a worker already running uses it at once.
		expect(next.mode).toBe('worker');
		expect(create().mode).toBe('worker');
	});

	it('shares only between engines given the same factory', async () => {
		setMaxWorkers(4);
		const a = create();
		const b = create(other);
		setMaxWorkers(1);
		const c = create();
		const d = create(other);
		for (const engine of [a, b, c, d]) {
			engine.addSeries('line');
		}
		await idle();
		expect(FakeWorker.created.length).toBe(2);
		expect(engineIds(FakeWorker.created[0]!)).toEqual([0, 1]);
		expect(engineIds(FakeWorker.created[1]!)).toEqual([0, 1]);
		expect(() => setMaxWorkers(0)).toThrow(RangeError);
	});

	it('keeps the data and the command order of each engine apart', async () => {
		const a = create();
		const b = create();
		const eventsA = collect(a);
		const eventsB = collect(b);
		const seriesA = a.addSeries('ohlcv');
		const seriesB = b.addSeries('ohlcv');
		// Same series id in both engines, different data.
		expect(seriesA).toBe(seriesB);
		a.setData(seriesA, ohlcv(100, 0, 60_000, 100), 100);
		b.setData(seriesB, ohlcv(40, 0, 60_000, 5000), 40);
		for (let i = 0; i < 20; i++) {
			a.tick(seriesA, 99 * 60_000, 1, 2, 0, i, 5);
		}
		a.requestWindow(0, 100, 128);
		b.requestWindow(0, 40, 64);
		expect(a.barrier()).toBe(3);
		expect(b.barrier()).toBe(2);
		await idle();
		expect(FakeWorker.created.length).toBe(1);
		expect(eventsA.map(event => event.ack)).toEqual([1, 2, 3, 4]);
		expect(eventsB.map(event => event.ack)).toEqual([1, 2, 3]);
		expect(eventsA[3]!.window!.count).toBe(100);
		expect(eventsA[3]!.window!.series[0]!.data[3 * 128 + 99]).toBe(19);
		expect(eventsB[2]!.window!.count).toBe(40);
		expect(eventsB[2]!.window!.series[0]!.data[0]).toBe(5000);
		expect(a.pending).toBe(0);
		expect(b.dataPending).toBe(false);
	});

	it('hands buffers over in both directions instead of copying them', async () => {
		const a = create();
		const b = create();
		const events = collect(b);
		a.addSeries('line');
		const series = b.addSeries('ohlcv');
		const data = ohlcv(64);
		b.setData(series, data, 64);
		b.requestWindow(0, 64, 64);
		await idle();
		const worker = FakeWorker.created[0]!;
		const set = worker.received.findIndex(message => message.type === 'set');
		expect(worker.transfers[set]).toEqual([data.buffer]);
		const window = events[2]!.window!;
		const answer = worker.events.findIndex(event => event.window !== undefined);
		expect(worker.eventTransfers[answer]).toEqual([window.time.buffer, window.series[0]!.data.buffer]);
	});

	it('answers a command that throws as failed, and only for its engine', async () => {
		const run = EngineCore.prototype.run;
		vi.spyOn(EngineCore.prototype, 'run').mockImplementation(function* (this: EngineCore, command) {
			if (command.type === 'limit' && command.bytes === 13) {
				yield;
				throw new Error('engine failure');
			}
			return yield* run.call(this, command);
		});
		const a = create();
		const b = create();
		const eventsA = collect(a);
		const eventsB = collect(b);
		const seriesA = a.addSeries('ohlcv');
		const seriesB = b.addSeries('ohlcv');
		a.setData(seriesA, ohlcv(50), 50);
		b.setData(seriesB, ohlcv(50), 50);
		a.setMemoryLimit(13);
		a.requestWindow(0, 50, 64);
		b.requestWindow(0, 50, 64);
		await idle();
		expect(eventsA.map(event => event.failed === true)).toEqual([false, false, true, false]);
		expect(eventsA.map(event => event.ack)).toEqual([1, 2, 3, 4]);
		expect(eventsA[3]!.window!.count).toBe(50);
		expect(eventsB.map(event => event.failed === true)).toEqual([false, false, false]);
		expect(eventsB[2]!.window!.count).toBe(50);
	});

	it('lets go of one engine alone, and stops the worker with the last one', async () => {
		const a = create();
		const b = create();
		const eventsB = collect(b);
		a.setData(a.addSeries('ohlcv'), ohlcv(1000), 1000);
		const seriesB = b.addSeries('ohlcv');
		b.setData(seriesB, ohlcv(200), 200);
		await idle();
		const worker = FakeWorker.created[0]!;

		a.destroy();
		expect(worker.terminated).toBe(false);
		expect(worker.received.at(-1)).toEqual({ type: 'close', engine: 0 });
		b.requestWindow(0, 200, 256);
		await idle();
		expect(eventsB.at(-1)!.window!.count).toBe(200);

		b.destroy();
		expect(worker.terminated).toBe(true);
		// Nothing is kept: the next engine starts a worker of its own.
		const c = create();
		c.addSeries('line');
		await idle();
		expect(FakeWorker.created.length).toBe(2);
		expect(c.mode).toBe('worker');
	});

	it('releases the engine in the worker when it is let go', async () => {
		const cores: EngineCore[] = [];
		const run = EngineCore.prototype.run;
		vi.spyOn(EngineCore.prototype, 'run').mockImplementation(function (this: EngineCore, command) {
			if (!cores.includes(this)) {
				cores.push(this);
			}
			return run.call(this, command);
		});
		const a = create();
		const b = create();
		const seriesA = a.addSeries('ohlcv');
		b.addSeries('ohlcv');
		await idle();
		expect(cores.length).toBe(2);

		// A new engine in the same worker starts empty, whatever the one before it held.
		a.setData(seriesA, ohlcv(300), 300);
		a.destroy();
		const c = create();
		const events = collect(c);
		c.addSeries('ohlcv');
		await idle();
		expect(cores.length).toBe(3);
		expect(events[0]!.end).toBe(0);
	});

	it('runs no background work of any engine while a command of any engine waits', async () => {
		// The engines of this test's worker, and whether one of them is inside a command: a command
		// that needs the levels builds them itself, which is not background work.
		const cores = new Set<EngineCore>();
		let inCommand = 0;
		const run = EngineCore.prototype.run;
		vi.spyOn(EngineCore.prototype, 'run').mockImplementation(function (this: EngineCore, command) {
			cores.add(this);
			const generator = run.call(this, command);
			const next = generator.next.bind(generator);
			generator.next = () => {
				inCommand++;
				try {
					return next();
				} finally {
					inCommand--;
				}
			};
			return generator;
		});
		const waitingAtBackground: number[] = [];
		const step = EngineCore.prototype.backgroundStep;
		vi.spyOn(EngineCore.prototype, 'backgroundStep').mockImplementation(function (this: EngineCore) {
			if (inCommand === 0 && cores.has(this) && this.busy) {
				waitingAtBackground.push(firstWorker().delivered - firstWorker().events.length);
			}
			return step.call(this);
		});
		const a = create();
		const b = create();
		// Levels of detail of both engines are left to be built in the background.
		const seriesA = a.addSeries('ohlcv');
		const seriesB = b.addSeries('ohlcv');
		a.setData(seriesA, ohlcv(600_000), 600_000);
		b.setData(seriesB, ohlcv(600_000), 600_000);
		await idle();
		expect(cores.size).toBe(2);
		expect(waitingAtBackground.length).toBe(0);

		// Commands keep arriving while the levels are built; each is answered between two slices.
		const busy = (): boolean => Array.from(cores).some(core => core.busy);
		const sendUntilBuilt = async (remaining: number): Promise<void> => {
			a.requestWindow(0, 100, 128);
			b.requestWindow(0, 100, 128);
			await new Promise(resolve => setTimeout(resolve, 1));
			await idle();
			if (busy() && remaining > 0) {
				await sendUntilBuilt(remaining - 1);
			}
		};
		await sendUntilBuilt(5000);
		expect(busy()).toBe(false);
		expect(waitingAtBackground.length).toBeGreaterThan(2);
		expect(Math.max(...waitingAtBackground)).toBe(0);
	});

	it('starts background work right after a command, without waiting for a timer', async () => {
		// With timers frozen, a host that waited for one before background work would never start it.
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		try {
			const cores = new Set<EngineCore>();
			const run = EngineCore.prototype.run;
			vi.spyOn(EngineCore.prototype, 'run').mockImplementation(function (this: EngineCore, command) {
				cores.add(this);
				return run.call(this, command);
			});
			const background = vi.spyOn(EngineCore.prototype, 'backgroundStep');
			const engine = create();
			const series = engine.addSeries('ohlcv');
			engine.setData(series, ohlcv(600_000), 600_000);
			await engine.whenIdle();
			const busy = (): boolean => Array.from(cores).some(core => core.busy);
			expect(busy()).toBe(true);
			// Tasks only: the host's own message tasks, never a timer.
			const settle = async (remaining: number): Promise<void> => {
				await new Promise(resolve => setImmediate(resolve));
				if (busy() && remaining > 0) {
					await settle(remaining - 1);
				}
			};
			await settle(10_000);
			expect(background).toHaveBeenCalled();
			expect(busy()).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it('lets the other engines in while one engine loads in bulk', async () => {
		const a = create();
		const b = create();
		const order: string[] = [];
		const seriesA = a.addSeries('ohlcv');
		const seriesB = b.addSeries('ohlcv');
		b.setData(seriesB, ohlcv(100), 100);
		await idle();
		a.onevent = () => order.push('load');
		b.onevent = event => order.push(event.window === undefined ? 'tick' : 'window');
		const rows = 1_500_000;
		a.setData(seriesA, ohlcv(rows), rows);
		b.tick(seriesB, 100 * 60_000, 1, 2, 0, 1, 1);
		b.requestWindow(0, 101, 128);
		await idle();
		// The load was started first and takes many slices; the small commands did not wait for it.
		expect(order).toEqual(['tick', 'window', 'load']);
	});

	it('computes the indicators of each engine and sends each its own notices', async () => {
		const a = create();
		const b = create();
		const eventsA = collect(a);
		const eventsB = collect(b);
		const seriesA = a.addSeries('ohlcv');
		const seriesB = b.addSeries('ohlcv');
		a.setData(seriesA, ohlcv(100), 100);
		b.setData(seriesB, ohlcv(60), 60);
		const sma = a.addIndicator('sma', [5], [{ series: seriesA, column: 4 }], 1);
		const highest = b.addIndicator('highest', [3], [{ series: seriesB, column: 2 }], 1);
		await vi.waitFor(() => {
			expect(swapNotice(eventsA)).toBeDefined();
			expect(swapNotice(eventsB)).toBeDefined();
		});
		expect(FakeWorker.created.length).toBe(1);
		// Each notice reached the engine whose data it describes: they differ in length.
		expect(swapNotice(eventsA)!.end).toBe(100);
		expect(swapNotice(eventsB)!.end).toBe(60);
		a.requestWindow(0, 100, 100);
		b.requestWindow(0, 60, 60);
		await idle();
		const smaValues = windowValues(eventsA, sma.outputs[0]!);
		const highestValues = windowValues(eventsB, highest.outputs[0]!);
		expect(Number.isNaN(smaValues[3]!)).toBe(true);
		expect(Number.isNaN(smaValues[4]!)).toBe(false);
		expect(Number.isNaN(highestValues[1]!)).toBe(true);
		expect(Number.isNaN(highestValues[59]!)).toBe(false);
	});

	it('falls back for every engine that waited for a worker that fails', async () => {
		FakeWorker.behavior = 'error';
		const a = create();
		const b = create();
		const eventsA = collect(a);
		const eventsB = collect(b);
		const dataA = ohlcv(50);
		a.setData(a.addSeries('ohlcv'), dataA, 50);
		b.setData(b.addSeries('ohlcv'), ohlcv(70), 70);
		expect(a.mode).toBe('connecting');
		await idle();
		expect(FakeWorker.created.length).toBe(1);
		expect(FakeWorker.created[0]!.terminated).toBe(true);
		expect(FakeWorker.created[0]!.received.length).toBe(0);
		expect([a.mode, b.mode]).toEqual(['local', 'local']);
		// Nothing was given to the failed worker, so each fallback could still load its data.
		expect(eventsA[1]!.end).toBe(50);
		expect(eventsB[1]!.end).toBe(70);

		// The failed worker is not kept: the next engine tries a new one.
		FakeWorker.behavior = 'ok';
		const c = create();
		c.addSeries('line');
		await idle();
		expect(FakeWorker.created.length).toBe(2);
		expect(c.mode).toBe('worker');
	});

	it('keeps a worker that has not answered while any engine still waits for it', async () => {
		FakeWorker.behavior = 'silent';
		const a = create(factory, 30);
		const b = create(factory, 10_000);
		const events = collect(b);
		a.addSeries('line');
		b.addSeries('line');
		a.destroy();
		const worker = FakeWorker.created[0]!;
		expect(worker.terminated).toBe(false);
		// The wait is the one the worker was started with.
		await b.whenIdle();
		expect(worker.terminated).toBe(true);
		expect(b.mode).toBe('local');
		expect(events.length).toBe(1);
	});
});
