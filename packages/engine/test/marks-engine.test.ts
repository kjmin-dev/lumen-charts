import { type EngineClient, type EngineEvent, type MarksUpdate, createEngine } from '@lumen-charts/engine';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeWorker } from './fake-worker';
import { heat, request, rows, trades } from './marks-helpers';

afterEach(() => {
	vi.unstubAllGlobals();
	FakeWorker.behavior = 'ok';
});

interface Collected {
	events: EngineEvent[];
	marks: MarksUpdate[];
}

function collect(engine: EngineClient): Collected {
	const collected: Collected = { events: [], marks: [] };
	engine.onevent = event => {
		collected.events.push(event);
	};
	engine.onmarks = updates => {
		collected.marks.push(...updates);
	};
	return collected;
}

/** An update as plain values, to compare two of them. */
function plain(update: MarksUpdate): unknown {
	return { ...update, time: [...update.time], price: [...update.price], values: [...update.values] };
}

describe('marks through the engine client', () => {
	it('answers a window request with the rows of the level the view needs', async () => {
		const engine = createEngine({ worker: false });
		const got = collect(engine);
		const series = engine.addMarks('scatter');
		engine.changeMarks(series, { op: 'set', data: rows([10, 20, 30, 40], [1, 2, 3, 4], [5, 6, 7, 8]) });
		const seq = engine.requestMarks(series, request(15, 35, 1));
		await engine.whenIdle();
		expect(got.events.map(event => event.ack)).toEqual([1, 2, 3]);
		expect(got.marks.length).toBe(1);
		const window = got.marks[0]!;
		expect(window.series).toBe(series);
		expect(window.request).toBe(seq);
		expect(window.generation).toBe(1);
		expect(window.level).toBe(0);
		expect(window.start).toBe(1);
		expect(window.total).toBe(4);
		expect([...window.time]).toEqual([20, 30]);
		expect([...window.price]).toEqual([2, 3]);
		expect([...window.values]).toEqual([6, 7]);
		engine.destroy();
	});

	it('does not count a window request as data, and counts the rows a change refuses', async () => {
		const engine = createEngine({ worker: false });
		const got = collect(engine);
		const series = engine.addMarks('scatter');
		engine.changeMarks(series, { op: 'set', data: rows([10, 5, Number.NaN], [1, 2, 3]) });
		await engine.whenIdle();
		expect(got.events[1]!.rejected).toBe(1);
		engine.requestMarks(series, request(0, 100, 1));
		expect(engine.pending).toBe(1);
		expect(engine.dataPending).toBe(false);
		engine.changeMarks(series, { op: 'append', data: rows([4], [1]) });
		expect(engine.dataPending).toBe(true);
		await engine.whenIdle();
		expect(got.events[3]!.rejected).toBe(1);
		// Changes of a series the engine does not have are refused whole.
		engine.changeMarks(99, { op: 'append', data: rows([4, 5], [1, 2]) });
		await engine.whenIdle();
		expect(got.events[4]!.rejected).toBe(2);
		engine.destroy();
	});

	it('patches the window sent last with what an append changed, while it reaches the last row', async () => {
		const engine = createEngine({ worker: false });
		const got = collect(engine);
		const series = engine.addMarks('scatter');
		engine.changeMarks(series, { op: 'set', data: rows([10, 20, 30, 40], [1, 2, 3, 4]) });
		// Before any window there is nothing to patch.
		engine.changeMarks(series, { op: 'append', data: rows([50], [5]) });
		engine.requestMarks(series, request(25, 1000, 1));
		engine.changeMarks(series, { op: 'append', data: rows([60, 70], [6, 7], [1, 2]) });
		await engine.whenIdle();
		expect(got.marks.length).toBe(2);
		expect([...got.marks[0]!.time]).toEqual([30, 40, 50]);
		const patch = got.marks[1]!;
		expect(patch.request).toBeUndefined();
		expect(patch.start).toBe(5);
		expect(patch.total).toBe(7);
		expect([...patch.time]).toEqual([60, 70]);
		expect([...patch.values]).toEqual([1, 2]);
		expect(patch.valueMax).toBe(2);
		// A window that ends before the last row is not grown by appends.
		engine.requestMarks(series, request(0, 25, 1));
		engine.changeMarks(series, { op: 'append', data: rows([80], [8]) });
		await engine.whenIdle();
		expect(got.marks.length).toBe(3);
		expect([...got.marks[2]!.time]).toEqual([10, 20]);
		engine.destroy();
	});

	it('answers without rows when the client holds what the view needs', async () => {
		const engine = createEngine({ worker: false });
		const got = collect(engine);
		const series = engine.addMarks('scatter');
		engine.changeMarks(series, { op: 'set', data: rows([10, 20, 30, 40], [1, 2, 3, 4]) });
		engine.requestMarks(series, request(0, 100, 1));
		await engine.whenIdle();
		const held = got.marks[0]!;
		engine.requestMarks(
			series,
			request(15, 35, 1, { generation: held.generation, heldLevel: 0, heldStart: 0, heldEnd: 4 }),
		);
		engine.changeMarks(series, { op: 'append', data: rows([50], [5]) });
		await engine.whenIdle();
		expect(got.marks[1]!.kept).toBe(true);
		expect(got.marks[1]!.time.length).toBe(0);
		expect(got.marks[1]!.total).toBe(4);
		// The rows the client holds reach the last row: they go on being patched.
		expect([...got.marks[2]!.time]).toEqual([50]);
		// Rows of another generation are not the client's any more.
		engine.changeMarks(series, { op: 'set', data: rows([1, 2], [1, 2]) });
		engine.requestMarks(
			series,
			request(0, 100, 1, { generation: held.generation, heldLevel: 0, heldStart: 0, heldEnd: 5 }),
		);
		await engine.whenIdle();
		expect(got.marks[3]!.kept).toBeUndefined();
		expect(got.marks[3]!.generation).toBe(held.generation + 1);
		expect([...got.marks[3]!.time]).toEqual([1, 2]);
		engine.destroy();
	});

	it('patches the cells of a coarse level, from the first one an append changed', async () => {
		const engine = createEngine({ worker: false });
		const got = collect(engine);
		const series = engine.addMarks('scatter');
		const count = 200_000;
		engine.changeMarks(series, { op: 'set', data: trades(count, 7, 0, 0.01) });
		const span = count * 1000;
		engine.requestMarks(series, request(0, span * 2, span / 500));
		await engine.whenIdle();
		const window = got.marks[0]!;
		expect(window.level).toBeGreaterThan(0);
		expect(window.count).toBe(window.total);
		// A larger value at the price of the last point: its cell changes, and no cell is added.
		const last = trades(count, 7, 0, 0.01);
		engine.changeMarks(series, {
			op: 'append',
			data: rows([last.time[count - 1]!], [last.price[count - 1]!], [1000]),
		});
		await engine.whenIdle();
		const patch = got.marks[1]!;
		expect(patch.level).toBe(window.level);
		expect(patch.total).toBe(window.total);
		expect(patch.start).toBeLessThan(window.total);
		expect(patch.start + patch.count).toBe(window.total);
		expect(patch.values).toContain(1000);
		expect(patch.valueMax).toBe(1000);
		engine.destroy();
	});

	it('serves heatmap columns, and patches the last column of the level held', async () => {
		const engine = createEngine({ worker: false });
		const got = collect(engine);
		const series = engine.addMarks('heatmap');
		const count = 5000;
		engine.changeMarks(series, { op: 'set', data: heat(count, 3) });
		const span = (count - 1) * 60_000;
		engine.requestMarks(series, request(0, span + 60_000, span / 1000));
		engine.changeMarks(series, { op: 'append', data: heat(1, 3, () => 7, 0, count - 1) });
		engine.changeMarks(series, { op: 'append', data: heat(1, 3, () => 8, 0, count) });
		await engine.whenIdle();
		const window = got.marks[0]!;
		expect(window.level).toBe(1);
		expect(window.rows).toBe(3);
		expect(window.count).toBe(1250);
		expect(window.values.length).toBe(1250 * 3);
		// Column 4999 is in bucket 1249 with 4996 to 4998, whose values are higher.
		expect(got.marks[1]!.start).toBe(1249);
		expect([...got.marks[1]!.values]).toEqual([49_980, 49_981, 49_982]);
		// Column 5000 starts bucket 1250.
		expect(got.marks[2]!.start).toBe(1250);
		expect(got.marks[2]!.total).toBe(1251);
		expect([...got.marks[2]!.values]).toEqual([8, 8, 8]);
		expect(got.marks[2]!.time[0]).toBe(count * 60_000);
		engine.destroy();
	});

	it('forgets a series that was removed', async () => {
		const engine = createEngine({ worker: false });
		const got = collect(engine);
		const series = engine.addMarks('heatmap');
		engine.changeMarks(series, { op: 'set', data: heat(10, 3) });
		engine.changeMarks(series, { op: 'remove' });
		engine.requestMarks(series, request(0, 1e9, 1));
		await engine.whenIdle();
		expect(got.events.length).toBe(4);
		expect(got.marks.length).toBe(0);
		engine.destroy();
	});
});

/** The same commands to an engine, and the rows it sent. */
async function session(engine: EngineClient): Promise<{ marks: unknown[]; rejected: number[] }> {
	const got = collect(engine);
	const scatter = engine.addMarks('scatter');
	const heatmap = engine.addMarks('heatmap');
	const count = 150_000;
	engine.changeMarks(scatter, { op: 'set', data: trades(count, 3, 0, 0.01) });
	engine.changeMarks(heatmap, { op: 'set', data: heat(3000, 8, (c, r) => Math.sin(c * 0.1 + r) * 50) });
	const span = count * 1000;
	engine.requestMarks(scatter, request(0, span * 2, span / 800));
	engine.requestMarks(scatter, request(1_000_000, 1_200_000, 200));
	engine.requestMarks(heatmap, request(0, 3000 * 60_000, (3000 * 60_000) / 600));
	engine.changeMarks(scatter, { op: 'append', data: trades(500, 9, span, 0.01) });
	engine.changeMarks(scatter, { op: 'append', data: rows([span - 1], [100]) });
	engine.changeMarks(heatmap, { op: 'append', data: heat(2, 8, () => 3, 0, 2999) });
	engine.requestMarks(scatter, request(span - 100_000, span * 2, 100));
	await engine.whenIdle();
	return { marks: got.marks.map(plain), rejected: got.events.map(event => event.rejected) };
}

describe('marks in a worker and on the calling thread', () => {
	it('send the same rows, and hand their buffers over', async () => {
		const local = createEngine({ worker: false });
		const here = await session(local);
		expect(local.mode).toBe('local');
		local.destroy();

		vi.stubGlobal('Worker', FakeWorker);
		let worker: FakeWorker | undefined;
		const remote = createEngine({
			worker: () => {
				worker = new FakeWorker();
				return worker as unknown as Worker;
			},
		});
		const there = await session(remote);
		expect(remote.mode).toBe('worker');
		expect(there.marks.length).toBe(5);
		expect(there).toEqual(here);

		// Data goes to the worker, and rows come back, by transfer: nothing is copied on the way.
		const sets = worker!.received.flatMap((message, i) =>
			message.type === 'marks' && message.change.op !== 'add' ? [worker!.transfers[i]!.length] : [],
		);
		expect(sets).toEqual([3, 2, 3, 2, 2]);
		const sent = worker!.events.flatMap((event, i) =>
			event.marks === undefined ? [] : [worker!.eventTransfers[i]!.length],
		);
		// Time, price, values, counts, sizes, bounds, offsets and lengths: each update has buffers of its own.
		expect(sent).toEqual([8, 8, 8, 8, 8]);
		remote.destroy();
	});
});
