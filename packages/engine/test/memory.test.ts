import { CHUNK_ROWS, EngineCore, type EngineEvent, type FetchRequest } from '@lumen-ticks/engine';
import { describe, expect, it } from 'vitest';
import { line, run, ticks } from './helpers';

const COUNT = CHUNK_ROWS * 24;
const times = Array.from({ length: COUNT }, (_, i) => 1_000_000 + i * 60);
const values = Array.from({ length: COUNT }, (_, i) => Math.sin(i / 100) * 10 + i / 1000);

/** Column-major rows `[start, end)` of the line, time first, as a datafeed would hand them back. */
function rows(start: number, end: number, source = values): Float64Array {
	return line(times.slice(start, end), source.slice(start, end));
}

/** Bytes of one chunk of a line: time and value. */
const CHUNK = CHUNK_ROWS * 16;

/** A fetchable line of 24 chunks under a limit that leaves room for `limitChunks` whole chunks. */
function loaded(limitChunks = 4): EngineCore {
	const core = new EngineCore();
	run(core, { type: 'add', series: 1, kind: 'line', fetchable: true });
	run(core, { type: 'set', series: 1, count: COUNT, data: rows(0, COUNT) });
	while (core.backgroundStep()) {
		// Build the levels, as a host does between commands.
	}
	// Levels always stay; on top of them, room for `limitChunks` chunks.
	const floor = core.byteLength - COUNT * 16;
	run(core, { type: 'limit', bytes: floor + CHUNK * limitChunks });
	return core;
}

/** A row in the third chunk: the first chunk always stays, since prepends rebuild its bucket. */
const OLD = CHUNK_ROWS * 2 + 1000;

function rawWindow(core: EngineCore, start: number, count: number): EngineEvent {
	return run(core, { type: 'window', level: 0, start, count, capacity: count });
}

function answer(core: EngineCore, request: FetchRequest, data: Float64Array | null): EngineEvent {
	const count = data === null ? 0 : data.length / 2;
	return run(core, { type: 'rows', request: request.id, count, data });
}

/** Answers every request of an event, and of the events that answers bring, with the source's rows. */
function answerAll(core: EngineCore, first: EngineEvent, source = values): EngineEvent[] {
	const events: EngineEvent[] = [];
	const queue = [...(first.fetch ?? [])];
	while (queue.length > 0) {
		const request = queue.shift()!;
		const event = answer(core, request, rows(request.start, request.end, source));
		events.push(event);
		queue.push(...(event.fetch ?? []));
	}
	return events;
}

function windowValues(event: EngineEvent): number[] {
	const window = event.window!;
	return [...window.series[0]!.data.subarray(0, window.count)];
}

describe('memory limit', () => {
	it('keeps no more than the limit, the levels and the rows around the view', () => {
		const core = loaded();
		const { bytes, limit, evictable } = core.memory;
		expect(bytes).toBeLessThanOrEqual(limit);
		expect(evictable).toBeGreaterThan(0);
		// Zoomed-out views still draw: every level is complete.
		const level = run(core, { type: 'window', level: 3, start: -1e9, count: 2e9, capacity: 0 }).window!;
		expect(level.count).toBe(Math.ceil(COUNT / 256));
		// The latest rows are still there.
		expect(windowValues(rawWindow(core, COUNT - 100, 100))).toEqual(values.slice(COUNT - 100));
	});

	it('lets go of the time column too, down to the levels and three chunks', () => {
		const core = loaded(0);
		run(core, { type: 'limit', bytes: 1 });
		const memory = core.memory;
		expect(memory.evictable).toBe(0);
		// What stays: the levels, the first and last chunk and the chunk of the last raw window (here
		// the last one), and a summary per chunk let go. With its times kept it would be COUNT * 8 more.
		const levels = memory.bytes - 2 * CHUNK;
		expect(levels).toBeLessThan(COUNT * 4);
		expect(memory.bytes).toBeLessThan(COUNT * 8);
	});

	it('fetches rows that were let go and shows them only once they are back', () => {
		const core = loaded();
		const waiting = rawWindow(core, OLD, 20_000);
		expect(waiting.window).toBeUndefined();
		const requests = waiting.fetch!;
		expect(requests.length).toBeGreaterThan(0);
		const firstRequest = requests[0]!;
		expect(firstRequest).toMatchObject({ series: 1, start: CHUNK_ROWS * 2, from: times[CHUNK_ROWS * 2] });
		expect(firstRequest.to).toBe(times[firstRequest.end - 1]);
		// Asking again while the rows are on their way does not ask for them twice.
		expect(rawWindow(core, OLD, 20_000).fetch).toBeUndefined();

		let shown: EngineEvent | null = null;
		for (const request of requests) {
			const event = answer(core, request, rows(request.start, request.end));
			expect(event.restored).toMatchObject({ outcome: 'restored', expected: request.end - request.start });
			if (event.window !== undefined) {
				shown = event;
			}
		}
		expect(shown).not.toBeNull();
		expect(shown!.window!.start).toBe(OLD);
		expect(windowValues(shown!)).toEqual(values.slice(OLD, OLD + 20_000));
		// The limit is a target: the window's rows, the first and the last chunk stay even when they
		// alone exceed it, and then nothing else is held.
		const memory = core.memory;
		expect(memory.bytes <= memory.limit || memory.evictable === 0).toBe(true);
		expect([memory.requests, memory.waiting]).toEqual([0, 0]);
	});

	it('refuses rows that are not the ones let go, and answers the window empty', () => {
		const core = loaded();
		const request = rawWindow(core, OLD, 100).fetch![0]!;
		const wrong = rows(request.start, request.end);
		// One bar a minute late.
		wrong[17] = wrong[17]! + 1;
		const refused = answer(core, request, wrong);
		expect(refused.restored!.outcome).toBe('mismatch');
		expect(refused.window).toMatchObject({ level: 0, count: 0, incomplete: true });

		// One bar short.
		const again = rawWindow(core, OLD, 100).fetch![0]!;
		const short = answer(core, again, rows(again.start, again.end - 1));
		expect(short.restored).toMatchObject({ outcome: 'mismatch', received: again.end - again.start - 1 });

		// A failed fetch, then a good one: the rows are back as they were.
		const third = rawWindow(core, OLD, 100).fetch![0]!;
		expect(answer(core, third, null).restored!.outcome).toBe('failed');
		const fourth = rawWindow(core, OLD, 100).fetch![0]!;
		const good = answer(core, fourth, rows(fourth.start, fourth.end));
		expect(windowValues(good)).toEqual(values.slice(OLD, OLD + 100));
	});

	it('cancels the requests of a new history and ignores their answers', () => {
		const core = loaded();
		const request = rawWindow(core, OLD, 100).fetch![0]!;
		const reload = run(core, { type: 'set', series: 1, count: 10, data: rows(0, 10) });
		expect(reload.cancel).toEqual([request.id]);
		// The raw window that waited is answered empty: its indexes mean other bars now.
		expect(reload.window).toMatchObject({ level: 0, count: 0 });
		const late = answer(core, request, rows(request.start, request.end));
		expect(late.restored).toMatchObject({ outcome: 'failed', expected: 0 });
		expect(late.end).toBe(10);
	});

	it('cancels requests once the view moved away from their rows', () => {
		const core = loaded();
		const old = rawWindow(core, OLD, 100);
		const ids = old.fetch!.map(request => request.id);
		// The view goes back to the latest bars, which are in memory: nothing waits for the old rows.
		const latest = rawWindow(core, COUNT - 100, 100);
		expect(latest.window!.count).toBe(100);
		expect(latest.cancel).toEqual(ids);
		expect(core.memory.requests).toBe(0);
		expect(answer(core, old.fetch![0]!, rows(OLD - 1000, OLD + 7192)).restored!.expected).toBe(0);
	});

	it('corrects a bar let go once it is back, and rebuilds its buckets from all members', () => {
		const core = loaded();
		const index = OLD + 5;
		const event = run(core, ticks([1, times[index]!, 1e6], [1, times[COUNT - 1]!, 5]));
		// The correction waits for its chunk; the update of the last bar does not wait for it.
		expect(event.waiting).toEqual([0]);
		expect(event.rejected).toBe(0);
		expect(event.patches!.some(patch => patch.level === 0 && patch.start === COUNT - 1)).toBe(true);
		expect(event.fetch!.length).toBe(1);
		const [restored] = answerAll(core, event);
		expect(restored!.applied).toEqual([event.ack, 0]);
		const level1 = restored!.patches!.find(patch => patch.series === 1 && patch.level === 1)!;
		// The bucket's highest value is the correction now.
		expect(level1.start).toBe(index >> 4);
		expect(level1.data[1]).toBe(1e6);
		// Corrected back down (after the chunk is fetched again: the limit let it go once more), the
		// bucket's highest value is rebuilt from its other members.
		const down = run(core, ticks([1, times[index]!, -1]));
		answerAll(core, down);
		const bucket = run(core, { type: 'window', level: 1, start: index >> 4, count: 1, capacity: 1 }).window!;
		const members = values.slice(index & ~15, (index & ~15) + 16);
		members[index & 15] = -1;
		expect(bucket.series[0]!.data[1]).toBe(Math.max(...members));
		expect(bucket.series[0]!.data[2]).toBe(-1);
	});

	it('refuses a correction between two chunks at once, and one inside a chunk once it is back', () => {
		const core = loaded();
		// Between the last bar of a chunk let go and the first of the next one: no bar has that time.
		const between = run(core, ticks([1, times[CHUNK_ROWS * 3 - 1]! + 30, 1]));
		expect(between.rejected).toBe(1);
		expect(between.waiting).toBeUndefined();
		// Inside a chunk let go, only its times tell; it waits for them.
		const inside = run(core, ticks([1, times[OLD]! + 30, 1]));
		expect(inside.waiting).toEqual([0]);
		const [back] = answerAll(core, inside);
		expect(back!.refused).toEqual([inside.ack, 0]);
		expect(back!.rejected).toBe(1);
	});

	it('takes over values changed at the source while their bars were let go', () => {
		const core = loaded();
		const changed = values.slice();
		changed[OLD + 3] = 777;
		const events = answerAll(core, rawWindow(core, OLD, 100), changed);
		const last = events.at(-1)!;
		expect(windowValues(last)[3]).toBe(777);
		const level1 = events.flatMap(event => event.patches ?? []).find(p => p.level === 1 && p.series === 1)!;
		const bucket = (OLD + 3) >> 4;
		expect(level1.data[1 * level1.count + bucket - level1.start]).toBe(777);
	});

	it('removes bars at either end without moving any, and in the middle with a new epoch', () => {
		const core = new EngineCore();
		run(core, { type: 'add', series: 1, kind: 'line' });
		const set = run(core, { type: 'set', series: 1, count: 1000, data: rows(0, 1000) });
		const head = run(core, { type: 'delete', series: 1, from: -Infinity, to: times[9]! });
		expect([head.first, head.end, head.epoch, head.stale]).toEqual([10, 1000, set.epoch, true]);
		const tail = run(core, { type: 'delete', series: 1, from: times[990]!, to: Infinity });
		expect([tail.first, tail.end, tail.epoch]).toEqual([10, 990, set.epoch]);
		// Nothing has a time between two bars.
		expect(run(core, { type: 'delete', series: 1, from: times[500]! + 1, to: times[500]! + 2 }).end).toBe(990);
		// Bars 100 to 199 go: the shorter side, the 90 bars before them, moves up.
		const middle = run(core, { type: 'delete', series: 1, from: times[100]!, to: times[199]! });
		expect([middle.first, middle.end]).toEqual([110, 990]);
		expect(middle.epoch).toBeGreaterThan(set.epoch);
		const window = rawWindow(core, 195, 10).window!;
		expect([...window.time.subarray(0, 10)]).toEqual([...times.slice(95, 100), ...times.slice(200, 205)]);
		// New bars still append after the last one, and every level matches the bars that are left.
		run(core, ticks([1, times[999]! + 60, 42]));
		const all = run(core, { type: 'window', level: 1, start: -1e9, count: 2e9, capacity: 0 }).window!;
		expect(all.time[0]).toBe(times[10]);
		expect(all.series[0]!.data[3 * all.capacity + all.count - 1]).toBe(42);
	});

	it('waits with a deletion for the rows it moves, and holds later updates of the series behind it', () => {
		const core = loaded(1);
		const from = times[CHUNK_ROWS * 12]!;
		const to = times[CHUNK_ROWS * 12 + 9]!;
		const deletion = run(core, { type: 'delete', series: 1, from, to });
		expect(deletion.waiting).toEqual([0]);
		expect(deletion.fetch!.length).toBeGreaterThan(0);
		// An update of the last bar made after it waits too, so it takes effect after the deletion.
		const tick = run(core, ticks([1, times[COUNT - 1]!, 9]));
		expect(tick.waiting).toEqual([0]);
		const events = answerAll(core, deletion);
		const applied = events.flatMap(event => event.applied ?? []);
		expect(applied).toEqual([deletion.ack, 0, tick.ack, 0]);
		expect(events.at(-1)!.end - events.at(-1)!.first).toBe(COUNT - 10);
		expect(core.memory.waiting).toBe(0);
	});
});

/** A fetchable main line, a fetchable secondary line and one without a datafeed, on the same times. */
function several(): EngineCore {
	const core = new EngineCore();
	run(core, { type: 'add', series: 1, kind: 'line', fetchable: true });
	run(core, { type: 'add', series: 2, kind: 'line', fetchable: true });
	run(core, { type: 'add', series: 3, kind: 'line' });
	for (const series of [1, 2, 3]) {
		run(core, { type: 'set', series, count: COUNT, data: rows(0, COUNT) });
	}
	while (core.backgroundStep()) {
		// Levels.
	}
	run(core, { type: 'limit', bytes: 1 });
	while (core.backgroundStep()) {
		// Chunks over the limit beyond the first slice go between commands, as a host runs them.
	}
	return core;
}

/** The store of a series, to look at what it let go. */
const storeOf = (core: EngineCore, series: number) =>
	(core as unknown as { _series: Map<number, { store: { evictedCount: number; timelessCount: number } }> })._series.get(
		series,
	)!.store;

describe('memory limit with several series', () => {
	it('lets go of series with a datafeed, never of one without, and keeps the main times', () => {
		const core = several();
		expect(storeOf(core, 1).evictedCount).toBeGreaterThan(10);
		expect(storeOf(core, 2).evictedCount).toBeGreaterThan(10);
		expect(storeOf(core, 3).evictedCount).toBe(0);
		// Other series are merged into main bars by time, so the main series keeps its times.
		expect(storeOf(core, 1).timelessCount).toBe(0);
		expect(storeOf(core, 2).timelessCount).toBe(storeOf(core, 2).evictedCount);
		expect(core.memory.evictable).toBe(0);
	});

	it('lets go of many chunks a slice at a time, between commands', () => {
		const core = new EngineCore();
		run(core, { type: 'add', series: 1, kind: 'line', fetchable: true });
		run(core, { type: 'add', series: 2, kind: 'line', fetchable: true });
		for (const series of [1, 2]) {
			run(core, { type: 'set', series, count: COUNT, data: rows(0, COUNT) });
		}
		while (core.backgroundStep()) {
			// Levels.
		}
		run(core, { type: 'limit', bytes: 1 });
		// A summary takes a pass over the chunk: one command lets go of 32 chunks at most.
		const evicted = () => storeOf(core, 1).evictedCount + storeOf(core, 2).evictedCount;
		expect(evicted()).toBe(32);
		expect(core.busy).toBe(true);
		while (core.backgroundStep()) {
			// The rest, as a host runs it.
		}
		expect(core.busy).toBe(false);
		expect(evicted()).toBeGreaterThan(32);
		expect(core.memory.evictable).toBe(0);
	});

	it('waits with a raw window for the rows of every series it shows', () => {
		const core = several();
		const waiting = rawWindow(core, OLD, 500);
		expect(waiting.window).toBeUndefined();
		expect(new Set(waiting.fetch!.map(request => request.series))).toEqual(new Set([1, 2]));
		const events = answerAll(core, waiting);
		const window = events.at(-1)!.window!;
		expect(window.start).toBe(OLD);
		for (const block of window.series) {
			expect([...block.data.subarray(0, 500)]).toEqual(values.slice(OLD, OLD + 500));
		}
	});

	it('fetches the main times back before another series is drawn on them', () => {
		const core = loaded(0);
		run(core, { type: 'limit', bytes: 1 });
		expect(storeOf(core, 1).timelessCount).toBeGreaterThan(0);
		run(core, { type: 'add', series: 2, kind: 'line' });
		const set = run(core, { type: 'set', series: 2, count: COUNT, data: rows(0, COUNT) });
		expect(set.waiting).toEqual([0]);
		const events = answerAll(core, set);
		expect(events.flatMap(event => event.applied ?? [])).toEqual([set.ack, 0]);
		expect(storeOf(core, 1).timelessCount).toBe(0);
	});

	it('hands the timeline to another series only once its rows are back', () => {
		const core = several();
		const removed = run(core, { type: 'remove', series: 1 });
		// No main timeline while series 2 fetches the rows its levels are rebuilt from.
		expect([removed.first, removed.end, removed.stale]).toEqual([0, 0, true]);
		expect(removed.fetch!.every(request => request.series === 2)).toBe(true);
		const tick = run(core, ticks([2, times[COUNT - 1]! + 60, 1]));
		expect(tick.waiting).toEqual([0]);
		const events = answerAll(core, removed);
		const last = events.at(-1)!;
		expect([last.first, last.end]).toEqual([0, COUNT + 1]);
		expect(events.flatMap(event => event.applied ?? [])).toEqual([tick.ack, 0]);
	});
});
