import {
	type EngineClient,
	type EngineEvent,
	type HeatmapColumns,
	MARK_COLUMNS,
	type MarksFetchRequest,
	type MarksUpdate,
	MarksEngine,
	type MarksOutcome,
	type ScatterRows,
	createEngine,
} from '@lumen-ticks/engine';
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

/** A scatter of `count` points with the view at its end and every chunk it can let go let go. */
function letGo(count = 400_000): { engine: MarksEngine; data: ScatterRows } {
	const engine = new MarksEngine();
	const data = trades(count);
	drain(engine.change(1, { op: 'add', kind: 'scatter', fetchable: true }, outcome()));
	drain(engine.change(1, { op: 'set', data: copy(data) }, outcome()));
	engine.window(1, 1, request(data.time[count - 1000]!, data.time[count - 1]!, 1), outcome());
	evictAll(engine);
	return { engine, data };
}

/** The view at the end of `data`, asked for again. */
function viewAtEnd(engine: MarksEngine, data: ScatterRows, seq: number): MarksOutcome {
	const asked = outcome();
	engine.window(1, seq, request(data.time[data.count - 1000]!, data.time[data.count - 1]!, 1), asked);
	return asked;
}

describe('changes waiting for marks under a memory limit', () => {
	it('asks again for what a waiting removal needs when the view asks after a failure', () => {
		const { engine, data } = letGo();
		const asked = outcome();
		drain(engine.change(1, { op: 'delete', from: data.time[70_000]!, to: data.time[90_000]! }, asked));
		const fetches = asked.marksFetch!;
		const failed = outcome();
		drain(engine.restore(fetches[0]!.id, null, failed));
		expect(failed.marksRestored!.outcome).toBe('failed');
		drain(engine.change(1, { op: 'append', data: trades(1, 9, data.time[data.count - 1]! + 1000) }, outcome()));
		expect(engine.waiting).toBe(2);
		// The client asks for its view again after its pause: the failed chunk is asked for again.
		const again = viewAtEnd(engine, data, 10);
		const retry = again.marksFetch ?? [];
		expect(retry.map(fetch => fetch.from)).toEqual([fetches[0]!.from]);
		let pending = [...retry, ...fetches.slice(1)];
		for (let round = 0; pending.length > 0 && round < 20; round++) {
			const back = outcome();
			for (const fetch of pending) {
				drain(engine.restore(fetch.id, between(data, fetch.from, fetch.to), back));
			}
			pending = back.marksFetch ?? [];
		}
		expect(engine.waiting).toBe(0);
	}, 60_000);

	it('keeps the chunks a waiting removal got back while the others come', () => {
		const { engine, data } = letGo();
		const asked = outcome();
		drain(engine.change(1, { op: 'delete', from: data.time[140_000]!, to: data.time[150_000]! }, asked));
		const fetches = asked.marksFetch!;
		expect(fetches.length).toBeGreaterThanOrEqual(2);
		const first = fetches[0]!;
		drain(engine.restore(first.id, between(data, first.from, first.to), outcome()));
		const before = engine.evicted;
		// A pass of the memory limit after the command: the chunk that came back stays.
		engine.evict(Infinity, Infinity);
		expect(engine.evicted).toBe(before);
		let again: MarksFetchRequest[] = [];
		for (const fetch of fetches.slice(1)) {
			const last = outcome();
			drain(engine.restore(fetch.id, between(data, fetch.from, fetch.to), last));
			again = again.concat(last.marksFetch ?? []);
		}
		expect(again).toEqual([]);
		expect(engine.waiting).toBe(0);
		// Done waiting: they may go again.
		engine.evict(Infinity, Infinity);
		expect(engine.evicted).toBeGreaterThan(0);
	}, 60_000);

	it('does not cancel what an indicator recomputation asked for when the view asks again', () => {
		const { engine, data } = letGo();
		const asked = outcome();
		expect(engine.held(1, data.time[100_000]!, data.time[200_000]!, asked)).toBe(false);
		expect(asked.marksFetch!.length).toBeGreaterThan(0);
		const view = viewAtEnd(engine, data, 5);
		expect(view.marksCancel).toBeUndefined();
		expect(engine.requests).toBe(asked.marksFetch!.length);
	}, 60_000);

	it('cancels what was asked for once a removal moves rows, so no answer is taken for other rows', () => {
		const { engine, data } = letGo();
		const asked = outcome();
		engine.window(1, 2, request(data.time[100_000]!, data.time[100_100]!, 1), asked);
		const out = asked.marksFetch![0]!;
		// A removal at the end, which reads nothing let go, moves nothing either: but its generation
		// changes the client's rows, and requests out are dropped with them.
		const removal = outcome();
		drain(engine.change(1, { op: 'delete', from: data.time[data.count - 10]!, to: Infinity }, removal));
		expect(removal.marksCancel).toEqual([out.id]);
		const late = outcome();
		drain(engine.restore(out.id, between(data, out.from, out.to), late));
		expect(late.marksRestored).toBeUndefined();
	}, 60_000);

	it('counts no bar as held, nor as empty, whose marks lie in a chunk let go', () => {
		const engine = new MarksEngine();
		const data = trades(400_000);
		drain(engine.change(1, { op: 'add', kind: 'scatter', fetchable: true }, outcome()));
		drain(engine.change(1, { op: 'set', data: copy(data) }, outcome()));
		engine.window(1, 1, request(data.time[100_000]!, data.time[100_100]!, 1), outcome());
		evictAll(engine);
		// Two bars inside chunk 2 (rows 131,072 to 196,607), which went.
		const out = new Float64Array(2);
		engine.aggregate(
			1,
			MARK_COLUMNS.count,
			Float64Array.of(data.time[150_000]!, data.time[150_060]!, data.time[150_120]!),
			2,
			out,
			0,
		);
		expect([...out]).toEqual([Number.NaN, Number.NaN]);
		// A bar from a chunk held into one let go.
		const t0 = data.time[100_000]!;
		const t1 = data.time[150_000]!;
		expect(engine.held(1, t0, t1, null)).toBe(false);
		const one = new Float64Array(1);
		engine.aggregate(1, MARK_COLUMNS.count, Float64Array.of(t0, t1), 1, one, 0);
		expect(one[0]).toBeNaN();
		// Within the chunk held, exact.
		engine.aggregate(1, MARK_COLUMNS.count, Float64Array.of(t0, data.time[110_000]!), 1, one, 0);
		expect(one[0]).toBe(10_000);
	}, 60_000);

	it('sends the rows a prepend changed in the first bucket of a coarse level the client holds', () => {
		const engine = new MarksEngine();
		drain(engine.change(1, { op: 'add', kind: 'heatmap' }, outcome()));
		drain(engine.change(1, { op: 'set', data: heat(4000, 4, (c, r) => c + r) }, outcome()));
		drain(engine.change(1, { op: 'prepend', data: heat(100, 4, () => 1, 0, -100) }, outcome()));
		const ask = (seq: number, held?: MarksUpdate): MarksUpdate => {
			const asked = outcome();
			engine.window(
				1,
				seq,
				request(-Infinity, Infinity, 1, {
					limit: 2000,
					generation: held?.generation ?? -1,
					heldLevel: held?.level ?? -1,
					heldStart: held?.start ?? 0,
					heldEnd: held === undefined ? 0 : held.start + held.count,
				}),
				asked,
			);
			return asked.marks![0]!;
		};
		const first = ask(1);
		expect(first.level).toBe(2);
		const prepend = outcome();
		drain(engine.change(1, { op: 'prepend', data: heat(10, 4, () => 99, 0, -110) }, prepend));
		expect(prepend.marks![0]!.notice).toBe(true);
		expect(prepend.marks![0]!.generation).not.toBe(first.generation);
		const again = ask(2, first);
		expect(again.kept).toBeUndefined();
		expect(again.values[0]).toBe(99);
	}, 60_000);
});
