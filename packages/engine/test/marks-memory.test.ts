import {
	type EngineClient,
	type EngineEvent,
	type HeatmapColumns,
	type MarksFetchRequest,
	type MarksUpdate,
	MarksEngine,
	type MarksOutcome,
	type ScatterRows,
	createEngine,
} from '@lumen-charts/engine';
import { describe, expect, it } from 'vitest';
import { drain, heat, request, trades } from './marks-helpers';

function outcome(): MarksOutcome {
	return { rejected: 0 };
}

/** The points of `data` with times in `[from, to]`, as a datafeed would return them. */
function between(data: ScatterRows, from: number, to: number): ScatterRows {
	const keep: number[] = [];
	for (let i = 0; i < data.count; i++) {
		if (data.time[i]! >= from && data.time[i]! <= to) {
			keep.push(i);
		}
	}
	return {
		kind: 'scatter',
		count: keep.length,
		time: Float64Array.from(keep, i => data.time[i]!),
		price: Float64Array.from(keep, i => data.price[i]!),
		value: data.value === null ? null : Float32Array.from(keep, i => data.value![i]!),
		size: data.size == null ? null : Float32Array.from(keep, i => data.size![i]!),
	};
}

function columnsBetween(data: HeatmapColumns, from: number, to: number): HeatmapColumns {
	const keep: number[] = [];
	for (let i = 0; i < data.count; i++) {
		if (data.time[i]! >= from && data.time[i]! <= to) {
			keep.push(i);
		}
	}
	const values = new Float32Array(keep.length * data.rows);
	keep.forEach((c, i) => values.set(data.values.subarray(c * data.rows, (c + 1) * data.rows), i * data.rows));
	return {
		...data,
		count: keep.length,
		time: Float64Array.from(keep, i => data.time[i]!),
		offsets: data.offsets == null ? null : Int32Array.from(keep, i => data.offsets![i]!),
		values,
	};
}

/** A copy of scatter rows, which a change hands over. */
function copy(data: ScatterRows): ScatterRows {
	return between(data, -Infinity, Infinity);
}

/** Lets go of every chunk the engine can, and returns how many went. */
function evictAll(engine: MarksEngine): number {
	engine.evict(Infinity, Infinity);
	return engine.evicted;
}

/** Ties of times across chunk edges: a few points at each of a run of times. */
function tied(count: number): ScatterRows {
	const data = trades(count, 3, 0, 0.05);
	for (let i = 0; i < count; i++) {
		data.time[i] = Math.floor(i / 3) * 1000;
	}
	return data;
}

describe('marks under a memory limit', () => {
	it('lets go of chunks far from the view, answers a view of them from a level, and takes them back', () => {
		const engine = new MarksEngine();
		const data = tied(400_000);
		drain(engine.change(1, { op: 'add', kind: 'scatter', fetchable: true }, outcome()));
		drain(engine.change(1, { op: 'set', data: copy(data) }, outcome()));
		const bytes = engine.byteLength;
		// The view is at the end: the chunks before it go, the first and last stay.
		const tail = data.time[data.count - 1]!;
		engine.window(1, 1, request(tail - 10_000, tail, 1), outcome());
		const evicted = evictAll(engine);
		expect(evicted).toBeGreaterThan(2);
		// Each chunk let go frees its points, all but a summary; the levels stay.
		expect(engine.byteLength).toBeLessThanOrEqual(bytes - evicted * 65_536 * 20 + evicted * 128);
		// A narrow view of points let go: a coarse level now, and the chunks asked for.
		const middle = data.time[150_000]!;
		const asked = outcome();
		engine.window(1, 2, request(middle, middle + 30_000, 1), asked);
		const answer = asked.marks![0]!;
		expect(answer.partial).toBe(true);
		expect(answer.level).toBeGreaterThan(0);
		const fetches = asked.marksFetch!;
		expect(fetches.length).toBe(1);
		const fetch = fetches[0]!;
		expect(fetch.count).toBe(65_536);
		// The datafeed answers with every point of those times, ties beyond the chunk included.
		const back = outcome();
		drain(engine.restore(fetch.id, between(data, fetch.from, fetch.to), back));
		expect(back.marksRestored).toEqual({ request: fetch.id, series: 1, outcome: 'restored' });
		expect(back.marks![0]!.notice).toBe(true);
		expect(engine.evicted).toBe(evicted - 1);
		// Asked again: the points themselves, as they were.
		const again = outcome();
		engine.window(1, 3, request(middle, middle + 30_000, 1), again);
		const rows = again.marks![0]!;
		expect(rows.partial).toBeUndefined();
		expect(rows.level).toBe(0);
		const from = data.time.indexOf(middle);
		expect([...rows.time]).toEqual([...data.time.subarray(from, from + rows.count)]);
		expect([...rows.price]).toEqual([...data.price.subarray(from, from + rows.count)]);
		expect(again.marksFetch).toBeUndefined();
	}, 30_000);

	it('refuses marks that are not those let go, and keeps answering from a level', () => {
		const engine = new MarksEngine();
		const data = trades(300_000);
		drain(engine.change(1, { op: 'add', kind: 'scatter', fetchable: true }, outcome()));
		drain(engine.change(1, { op: 'set', data: copy(data) }, outcome()));
		engine.window(1, 1, request(data.time[299_000]!, data.time[299_999]!, 1), outcome());
		evictAll(engine);
		const asked = outcome();
		engine.window(1, 2, request(data.time[100_000]!, data.time[100_100]!, 1), asked);
		const fetch = asked.marksFetch![0]!;
		const changed = between(data, fetch.from, fetch.to);
		changed.price[10] = changed.price[10]! + 1;
		const back = outcome();
		drain(engine.restore(fetch.id, changed, back));
		expect(back.marksRestored!.outcome).toBe('mismatch');
		expect(back.marks).toBeUndefined();
		// Fewer points than were let go, or a failure, are refused too; the view keeps asking.
		const retry = outcome();
		engine.window(1, 3, request(data.time[100_000]!, data.time[100_100]!, 1), retry);
		expect(retry.marks![0]!.partial).toBe(true);
		const fewer = between(data, retry.marksFetch![0]!.from, retry.marksFetch![0]!.to - 1000);
		const short = outcome();
		drain(engine.restore(retry.marksFetch![0]!.id, fewer, short));
		expect(short.marksRestored!.outcome).toBe('mismatch');
		const failing = outcome();
		engine.window(1, 4, request(data.time[100_000]!, data.time[100_100]!, 1), failing);
		const failed = outcome();
		drain(engine.restore(failing.marksFetch![0]!.id, null, failed));
		expect(failed.marksRestored!.outcome).toBe('failed');
	}, 30_000);

	it('cancels requests the view left, and lets nothing go without a datafeed', () => {
		const engine = new MarksEngine();
		const data = trades(300_000);
		drain(engine.change(1, { op: 'add', kind: 'scatter', fetchable: true }, outcome()));
		drain(engine.change(1, { op: 'set', data: copy(data) }, outcome()));
		drain(engine.change(2, { op: 'add', kind: 'scatter' }, outcome()));
		drain(engine.change(2, { op: 'set', data: copy(data) }, outcome()));
		engine.window(1, 1, request(data.time[299_000]!, data.time[299_999]!, 1), outcome());
		engine.window(2, 2, request(data.time[299_000]!, data.time[299_999]!, 1), outcome());
		evictAll(engine);
		expect(engine.evicted).toBeGreaterThan(0);
		const first = outcome();
		engine.window(1, 3, request(data.time[100_000]!, data.time[100_100]!, 1), first);
		const id = first.marksFetch![0]!.id;
		expect(engine.requests).toBe(1);
		const moved = outcome();
		engine.window(1, 4, request(data.time[299_000]!, data.time[299_999]!, 1), moved);
		expect(moved.marksCancel).toEqual([id]);
		expect(engine.requests).toBe(0);
		// The marks of the cancelled request come anyway: nothing is done with them.
		const late = outcome();
		drain(engine.restore(id, between(data, first.marksFetch![0]!.from, first.marksFetch![0]!.to), late));
		expect(late.marksRestored).toBeUndefined();
		// The series without a datafeed kept everything.
		const whole = outcome();
		engine.window(2, 5, request(data.time[100_000]!, data.time[100_100]!, 1), whole);
		expect(whole.marks![0]!.partial).toBeUndefined();
	}, 30_000);

	it('removes points over chunks let go once those it moves are back, and applies later changes after it', () => {
		const engine = new MarksEngine();
		const data = trades(400_000);
		drain(engine.change(1, { op: 'add', kind: 'scatter', fetchable: true }, outcome()));
		drain(engine.change(1, { op: 'set', data: copy(data) }, outcome()));
		engine.window(1, 1, request(data.time[399_000]!, data.time[399_999]!, 1), outcome());
		evictAll(engine);
		// Removing points of the second chunk moves the first; the rows beside the gap are let go.
		const from = data.time[70_000]!;
		const to = data.time[90_000]!;
		const asked = outcome();
		drain(engine.change(1, { op: 'delete', from, to }, asked));
		expect(engine.waiting).toBe(1);
		const tick = trades(1, 9, data.time[399_999]! + 1000);
		drain(engine.change(1, { op: 'append', data: tick }, outcome()));
		expect(engine.waiting).toBe(2);
		let fetches: MarksFetchRequest[] = asked.marksFetch ?? [];
		expect(fetches.length).toBeGreaterThan(0);
		while (fetches.length > 0) {
			const back = outcome();
			for (const fetch of fetches) {
				drain(engine.restore(fetch.id, between(data, fetch.from, fetch.to), back));
			}
			fetches = back.marksFetch ?? [];
		}
		expect(engine.waiting).toBe(0);
		// Everything comes back, and holds the points left with the tick after them: a view of
		// everything at level 0 asks for every chunk let go.
		let view = outcome();
		engine.window(1, 9, request(-Infinity, Infinity, 1, { limit: Infinity }), view);
		for (let round = 0; view.marksFetch !== undefined && round < 20; round++) {
			const back = outcome();
			for (const fetch of view.marksFetch) {
				drain(engine.restore(fetch.id, between(data, fetch.from, fetch.to), back));
			}
			view = outcome();
			engine.window(1, 9, request(-Infinity, Infinity, 1, { limit: Infinity }), view);
		}
		expect(view.marksFetch).toBeUndefined();
		const rows = view.marks![0]!;
		const kept = [...data.time].filter(t => t < from || t > to);
		expect(rows.count).toBe(kept.length + 1);
		expect([...rows.time.subarray(0, kept.length)]).toEqual(kept);
		expect(rows.time[kept.length]).toBe(tick.time[0]);
	}, 30_000);

	it('lets go of heatmap cells far from the view and takes back the columns on their own rows', () => {
		const engine = new MarksEngine();
		const offsets = Int32Array.from({ length: 6000 }, (_, c) => Math.round(Math.sin(c / 50) * 10));
		const data: HeatmapColumns = { ...heat(6000, 100, (c, r) => (c * 3 + r) % 70), offsets };
		const clone = () => columnsBetween(data, -Infinity, Infinity);
		drain(engine.change(1, { op: 'add', kind: 'heatmap', fetchable: true }, outcome()));
		drain(engine.change(1, { op: 'set', data: clone() }, outcome()));
		const last = data.time[5999]!;
		engine.window(1, 1, request(last - 600_000, last, 60_000), outcome());
		const bytes = engine.byteLength;
		expect(evictAll(engine)).toBeGreaterThan(5);
		expect(engine.byteLength).toBeLessThan(bytes / 2);
		const asked = outcome();
		const at = data.time[2000]!;
		engine.window(1, 2, request(at, at + 60_000 * 50, 60_000), asked);
		expect(asked.marks![0]!.partial).toBe(true);
		const back = outcome();
		for (const fetch of asked.marksFetch!) {
			drain(engine.restore(fetch.id, columnsBetween(data, fetch.from, fetch.to), back));
		}
		expect(back.marksRestored!.outcome).toBe('restored');
		expect(back.marks!.at(-1)!.notice).toBe(true);
		const again = outcome();
		engine.window(1, 3, request(at, at + 60_000 * 50, 60_000), again);
		const rows: MarksUpdate = again.marks![0]!;
		expect(rows.level).toBe(0);
		expect([...rows.offsets]).toEqual([...offsets.subarray(rows.start, rows.start + rows.count)]);
		expect([...rows.values.subarray(0, 100)]).toEqual([
			...data.values.subarray(rows.start * 100, rows.start * 100 + 100),
		]);
		// Columns on other rows than those let go are refused.
		const other = outcome();
		const far = data.time[1500]!;
		engine.window(1, 4, request(far, far + 60_000 * 5, 60_000), other);
		const fetch = other.marksFetch![0]!;
		const moved = columnsBetween(data, fetch.from, fetch.to);
		moved.offsets![0] = moved.offsets![0]! + 1;
		const refused = outcome();
		drain(engine.restore(fetch.id, moved, refused));
		expect(refused.marksRestored!.outcome).toBe('mismatch');
	}, 30_000);
});

/** What a client receives: its events, the rows of marks, and the marks to fetch again. */
function collect(engine: EngineClient): {
	events: EngineEvent[];
	marks: MarksUpdate[];
	fetches: MarksFetchRequest[];
} {
	const got = { events: [] as EngineEvent[], marks: [] as MarksUpdate[], fetches: [] as MarksFetchRequest[] };
	engine.onevent = event => got.events.push(event);
	engine.onmarks = updates => got.marks.push(...updates);
	engine.onmarksfetch = event => got.fetches.push(...(event.marksFetch ?? []));
	return got;
}

describe('marks under a memory limit through the engine client', () => {
	it('lets go under the limit, asks for marks to fetch, and takes them back', async () => {
		const engine = createEngine({ worker: false });
		const got = collect(engine);
		const data = trades(400_000);
		const series = engine.addMarks('scatter', true);
		engine.changeMarks(series, { op: 'set', data: copy(data) });
		const tail = data.time[399_999]!;
		engine.requestMarks(series, request(tail - 10_000, tail, 1));
		engine.setMemoryLimit(1);
		await engine.whenIdle();
		engine.requestMarks(series, request(data.time[100_000]!, data.time[100_100]!, 1));
		await engine.whenIdle();
		expect(got.fetches.length).toBe(1);
		expect(got.marks.at(-1)!.partial).toBe(true);
		const fetch = got.fetches[0]!;
		engine.restoreMarks(fetch.id, between(data, fetch.from, fetch.to));
		await engine.whenIdle();
		expect(got.events.at(-1)!.marksRestored!.outcome).toBe('restored');
		expect(got.marks.at(-1)!.notice).toBe(true);
		engine.destroy();
	}, 30_000);
});
