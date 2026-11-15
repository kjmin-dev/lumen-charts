import { CHUNK_ROWS, EngineCore, type EngineEvent, type FetchRequest } from '@lumen-charts/engine';
import { describe, expect, it } from 'vitest';
import { line, run, ticks } from './helpers';

const COUNT = CHUNK_ROWS * 24;
const times = Array.from({ length: COUNT }, (_, i) => 1_000_000 + i * 60);
const values = Array.from({ length: COUNT }, (_, i) => Math.sin(i / 100) * 10 + i / 1000);

/** Column-major rows `[start, end)` of the line, time first, as a datafeed would hand them back. */
function rows(start: number, end: number): Float64Array {
	return line(times.slice(start, end), values.slice(start, end));
}

/** A fetchable line of 24 chunks under a limit that leaves room for a few chunks of values. */
function loaded(limitChunks = 4): EngineCore {
	const core = new EngineCore();
	run(core, { type: 'add', series: 1, kind: 'line', fetchable: true });
	run(core, { type: 'set', series: 1, count: COUNT, data: rows(0, COUNT) });
	while (core.backgroundStep()) {
		// Build the levels, as a host does between commands.
	}
	const time = CHUNK_ROWS * 8;
	// Levels and time columns always stay; on top of them, room for `limitChunks` chunks of values.
	const floor = core.byteLength - COUNT * 8;
	run(core, { type: 'limit', bytes: floor + time * limitChunks });
	return core;
}

/** A row in the third chunk: the first chunk always stays, since prepends rebuild its bucket. */
const OLD = CHUNK_ROWS * 2 + 1000;

function rawWindow(core: EngineCore, start: number, count: number): EngineEvent {
	return run(core, { type: 'window', level: 0, start, count, capacity: count });
}

function answer(core: EngineCore, request: FetchRequest, data: Float64Array | null): EngineEvent {
	const count = data === null ? 0 : data.length / 2;
	return run(core, { type: 'rows', series: request.series, start: request.start, count, data });
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

	it('ignores an answer nothing waits for', () => {
		const core = loaded();
		const request = rawWindow(core, OLD, 100).fetch![0]!;
		run(core, { type: 'set', series: 1, count: 10, data: rows(0, 10) });
		const late = answer(core, request, rows(request.start, request.end));
		expect(late.restored).toMatchObject({ outcome: 'failed', expected: 0 });
		expect(late.end).toBe(10);
	});

	it('refuses corrections of bars whose values were let go', () => {
		const core = loaded();
		const event = run(core, ticks([1, times[OLD]!, 999], [1, times[COUNT - 1]!, 5]));
		expect(event.rejected).toBe(1);
	});

	it('keeps everything while another series has data or the series has no datafeed', () => {
		const shared = loaded(1_000_000);
		run(shared, { type: 'add', series: 2, kind: 'line' });
		run(shared, { type: 'set', series: 2, count: 3, data: line([times[0]!, times[1]!, times[2]!], [1, 2, 3]) });
		run(shared, { type: 'limit', bytes: 1 });
		while (shared.backgroundStep()) {
			// Levels of the second series.
		}
		expect(shared.memory.evictable).toBe(0);
		expect(rawWindow(shared, 0, 100).window!.count).toBe(100);

		const plain = new EngineCore();
		run(plain, { type: 'add', series: 1, kind: 'line' });
		run(plain, { type: 'set', series: 1, count: COUNT, data: rows(0, COUNT) });
		run(plain, { type: 'limit', bytes: 1 });
		while (plain.backgroundStep()) {
			// Levels.
		}
		expect(rawWindow(plain, 0, 100).window!.count).toBe(100);
	});
});
