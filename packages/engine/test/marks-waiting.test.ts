import {
	type EngineEvent,
	type HeatmapColumns,
	type HeatmapStore,
	type MarksChange,
	MarksEngine,
	type MarksFetchRequest,
	type MarksOutcome,
	type MarksUpdate,
	type ScatterRows,
	ScatterColumns,
	type ScatterStore,
	createEngine,
} from '@lumen-ticks/engine';
import { describe, expect, it } from 'vitest';
import { blankUpdate, drain, heat, request, trades } from './marks-helpers';

/**
 * Removals and corrections that wait for marks let go under the memory limit, answered by a datafeed
 * that already serves the changed history (an application changes its source first, then tells the
 * chart): they run, fetch what they need and no more, never read or write rows let go, and a change
 * whose marks fit nothing is dropped after three rounds instead of holding the series up for good.
 */

function outcome(): MarksOutcome {
	return { rejected: 0 };
}

function points(data: ScatterRows, keep: (t: number) => boolean): ScatterRows {
	const kept: number[] = [];
	for (let i = 0; i < data.count; i++) {
		if (keep(data.time[i]!)) {
			kept.push(i);
		}
	}
	return {
		kind: 'scatter',
		count: kept.length,
		time: Float64Array.from(kept, i => data.time[i]!),
		price: Float64Array.from(kept, i => data.price[i]!),
		value: data.value === null ? null : Float32Array.from(kept, i => data.value![i]!),
	};
}

const between = (data: ScatterRows, from: number, to: number): ScatterRows => points(data, t => t >= from && t <= to);
const without = (data: ScatterRows, from: number, to: number): ScatterRows =>
	points(data, t => !(t >= from && t <= to));

function join<T extends Float64Array | Float32Array>(a: T, b: T, c: T): T {
	const out = new (a.constructor as new (n: number) => T)(a.length + b.length + c.length);
	out.set(a);
	out.set(b, a.length);
	out.set(c, a.length + b.length);
	return out;
}

/** `data` with the points of `[from, to]` replaced by `put` (in time order, inside the range). */
function replaced(data: ScatterRows, from: number, to: number, put: ScatterRows): ScatterRows {
	const before = points(data, t => t < from);
	const after = points(data, t => t > to);
	return {
		kind: 'scatter',
		count: before.count + put.count + after.count,
		time: join(before.time, put.time, after.time),
		price: join(before.price, put.price, after.price),
		value: join(before.value!, put.value!, after.value!),
	};
}

function columns(data: HeatmapColumns, keep: (t: number) => boolean): HeatmapColumns {
	const kept: number[] = [];
	for (let i = 0; i < data.count; i++) {
		if (keep(data.time[i]!)) {
			kept.push(i);
		}
	}
	const values = new Float32Array(kept.length * data.rows);
	kept.forEach((c, i) => values.set(data.values.subarray(c * data.rows, (c + 1) * data.rows), i * data.rows));
	return {
		...data,
		count: kept.length,
		time: Float64Array.from(kept, i => data.time[i]!),
		offsets: data.offsets == null ? null : Int32Array.from(kept, i => data.offsets![i]!),
		values,
	};
}

/** A series with a datafeed and the view at its end, every chunk it can let go let go. */
function letGo(kind: 'scatter' | 'heatmap', data: ScatterRows | HeatmapColumns): MarksEngine {
	const engine = new MarksEngine();
	drain(engine.change(1, { op: 'add', kind, fetchable: true }, outcome()));
	drain(
		engine.change(
			1,
			{
				op: 'set',
				data:
					kind === 'scatter'
						? between(data as ScatterRows, -Infinity, Infinity)
						: columns(data as HeatmapColumns, () => true),
			},
			outcome(),
		),
	);
	const last = data.time[data.count - 1]!;
	const span = last - data.time[0]!;
	engine.window(1, 1, request(last - span / 1000, last, 1), outcome());
	engine.evict(Infinity, Infinity);
	return engine;
}

interface Answered {
	rounds: number;
	fetched: number[];
	outcomes: string[];
	rejected: number;
}

/**
 * Answers the requests of a series from `feed` until nothing is asked for, asking again with the
 * view where a change still waits (as the client does after its pause), at most `rounds` rounds.
 */
function answer(
	engine: MarksEngine,
	first: readonly MarksFetchRequest[] | undefined,
	feed: (from: number, to: number) => ScatterRows | HeatmapColumns,
	rounds = 10,
	at = 1,
): Answered {
	const result: Answered = { rounds: 0, fetched: [], outcomes: [], rejected: 0 };
	let fetches = [...(first ?? [])];
	for (; result.rounds < rounds && (fetches.length > 0 || engine.waiting > 0); result.rounds++) {
		const cancelled = new Set<number>();
		const next: MarksFetchRequest[] = [];
		for (const fetch of fetches) {
			if (cancelled.has(fetch.id)) {
				continue;
			}
			const back = outcome();
			drain(engine.restore(fetch.id, feed(fetch.from, fetch.to), back));
			result.fetched.push(fetch.from);
			result.outcomes.push(back.marksRestored?.outcome ?? 'none');
			result.rejected += back.rejected;
			for (const id of back.marksCancel ?? []) {
				cancelled.add(id);
			}
			next.push(...(back.marksFetch ?? []));
		}
		fetches = next.filter(fetch => !cancelled.has(fetch.id));
		if (fetches.length === 0 && engine.waiting > 0) {
			const view = outcome();
			engine.window(1, 100 + result.rounds, request(at, at, 1), view);
			fetches = view.marksFetch ?? [];
		}
	}
	return result;
}

/** Every row of a level, the coarse chunks let go made from what is held. */
function level(store: ScatterStore | HeatmapStore, l: number): MarksUpdate {
	expect(store.materialize(l, store.first(l), store.first(l) + store.total(l))).toBe(true);
	const update = blankUpdate();
	store.read(l, store.first(l), store.first(l) + store.total(l), update);
	return update;
}

/** Fetches every chunk let go back from `feed`, then checks level 0 is `expected` and every level is made from it. */
function expectScatter(engine: MarksEngine, expected: ScatterRows): void {
	const all = outcome();
	engine.window(1, 900, request(-Infinity, Infinity, 1, { limit: Infinity }), all);
	answer(engine, all.marksFetch, (from, to) => between(expected, from, to));
	const store = engine.store(1) as ScatterStore;
	const raw = level(store, 0);
	expect(raw.count).toBe(expected.count);
	let wrong = 0;
	for (let i = 0; i < raw.count; i++) {
		if (
			raw.time[i] !== expected.time[i] ||
			raw.price[i] !== expected.price[i] ||
			raw.values[i] !== expected.value![i]
		) {
			wrong++;
		}
	}
	expect(wrong).toBe(0);
	for (let l = 1; l <= store.levels; l++) {
		const cells = level(store, l);
		const want = new Map<string, { value: number; count: number }>();
		for (let i = 0; i < raw.count; i++) {
			const key = `${Math.floor(raw.time[i]! / cells.timeStep)}:${Math.floor(raw.price[i]! / cells.priceStep)}`;
			const cell = want.get(key);
			if (cell === undefined) {
				want.set(key, { value: raw.values[i]!, count: 1 });
			} else {
				cell.value = Math.max(cell.value, raw.values[i]!);
				cell.count++;
			}
		}
		expect(cells.count).toBe(want.size);
		let bad = 0;
		for (let i = 0; i < cells.count; i++) {
			const key = `${Math.floor(cells.time[i]! / cells.timeStep)}:${Math.floor(cells.price[i]! / cells.priceStep)}`;
			const cell = want.get(key);
			if (
				cell === undefined ||
				cell.value !== cells.values[i] ||
				cell.count !== cells.counts[i] ||
				!(cells.time[i]! > 0)
			) {
				bad++;
			}
			want.delete(key);
		}
		expect(bad, `level ${l}`).toBe(0);
	}
}

/** Level 0 is `expected` (fetched back where it was let go), and every coarse level its direct merge. */
function expectHeat(engine: MarksEngine, expected: HeatmapColumns): void {
	const all = outcome();
	engine.window(1, 900, request(-Infinity, Infinity, 1, { limit: Infinity }), all);
	answer(engine, all.marksFetch, (from, to) => columns(expected, t => t >= from && t <= to));
	const store = engine.store(1) as HeatmapStore;
	const raw = level(store, 0);
	const rows = expected.rows;
	expect(raw.count).toBe(expected.count);
	expect([...raw.time]).toEqual([...expected.time]);
	expect(raw.values.every((v, i) => Object.is(v, expected.values[i]))).toBe(true);
	for (let l = 1; l <= store.levels; l++) {
		const got = level(store, l);
		const size = 4 ** l;
		let bad = 0;
		for (let k = 0; k < got.count; k++) {
			const bucket = got.start + k;
			const from = Math.max(raw.first, bucket * size) - raw.first;
			const to = Math.min(raw.first + raw.count, (bucket + 1) * size) - raw.first;
			for (let r = 0; r < rows; r++) {
				let max = Number.NaN;
				for (let c = from; c < to; c++) {
					const v = raw.values[c * rows + r]!;
					if (v === v && !(max >= v)) {
						max = v;
					}
				}
				if (!Object.is(got.values[k * rows + r], max) || got.time[k] !== raw.time[from]) {
					bad++;
				}
			}
		}
		expect(bad, `level ${l}`).toBe(0);
	}
}

describe('a waiting removal or correction answered with the changed history (1)', () => {
	it('removes points over chunks let go when the datafeed already leaves them out, and runs the append behind it', () => {
		const data = trades(400_000);
		const engine = letGo('scatter', data);
		const from = data.time[70_000]!;
		const to = data.time[90_000]!;
		const tick = trades(1, 9, data.time[399_999]! + 1000);
		// The source changed first: the datafeed answers without the points removed.
		const source = without(data, from, to);
		const asked = outcome();
		drain(engine.change(1, { op: 'delete', from, to }, asked));
		drain(engine.change(1, { op: 'append', data: between(tick, -Infinity, Infinity) }, outcome()));
		expect(engine.waiting).toBe(2);
		const answered = answer(engine, asked.marksFetch, (f, t) => between(source, f, t), 10, data.time[399_000]!);
		expect(engine.waiting).toBe(0);
		expect(answered.outcomes.every(o => o === 'restored')).toBe(true);
		expect(answered.rounds).toBe(1);
		expectScatter(engine, replaced(source, tick.time[0]!, tick.time[0]!, tick));
	}, 60_000);

	it('corrects points over chunks let go when the datafeed already holds the corrected ones', () => {
		const data = trades(400_000);
		const engine = letGo('scatter', data);
		const from = data.time[120_000]!;
		const to = data.time[140_000]!;
		const put = trades(500, 4, from, 0.5);
		const correction = between(put, from, to);
		const source = replaced(data, from, to, correction);
		const asked = outcome();
		drain(engine.change(1, { op: 'correct', data: between(correction, -Infinity, Infinity), from, to }, asked));
		expect(engine.waiting).toBe(1);
		const answered = answer(engine, asked.marksFetch, (f, t) => between(source, f, t), 10, data.time[399_000]!);
		expect(engine.waiting).toBe(0);
		expect(answered.outcomes.every(o => o === 'restored')).toBe(true);
		expectScatter(engine, source);
	}, 60_000);

	it('takes an answer after the first change and others behind it in the same chunk, merged', () => {
		const data = trades(400_000);
		const engine = letGo('scatter', data);
		// A removal and a correction in the same chunk let go, at different times: the datafeed returns both.
		const r1 = { from: data.time[150_000]!, to: data.time[150_400]! };
		const r2 = { from: data.time[170_000]!, to: data.time[170_300]! };
		const put = between(trades(50, 8, r2.from, 0.5), r2.from, r2.to);
		const source = replaced(without(data, r1.from, r1.to), r2.from, r2.to, put);
		const asked = outcome();
		drain(engine.change(1, { op: 'delete', ...r1 }, asked));
		drain(engine.change(1, { op: 'correct', data: between(put, -Infinity, Infinity), ...r2 }, outcome()));
		expect(engine.waiting).toBe(2);
		const answered = answer(engine, asked.marksFetch, (f, t) => between(source, f, t), 10, data.time[399_000]!);
		expect(engine.waiting).toBe(0);
		expect(answered.outcomes.every(o => o === 'restored')).toBe(true);
		expectScatter(engine, source);
	}, 60_000);

	it('removes and corrects heatmap columns let go when the datafeed already holds the changed ones', () => {
		const data = heat(6000, 100, (c, r) => (c * 3 + r) % 70);
		for (const change of ['delete', 'correct'] as const) {
			const engine = letGo('heatmap', data);
			const at = data.time[2000]!;
			let source: HeatmapColumns;
			let sent: MarksChange;
			if (change === 'delete') {
				source = columns(data, t => !(t >= at && t <= data.time[2100]!));
				sent = { op: 'delete', from: at, to: data.time[2100]! };
			} else {
				const fix = heat(2, 100, () => 999, 0, 2000);
				const values = data.values.slice();
				values.set(fix.values, 2000 * 100);
				source = { ...data, values };
				sent = { op: 'correct', data: fix };
			}
			const asked = outcome();
			drain(engine.change(1, sent, asked));
			expect(engine.waiting).toBe(1);
			const answered = answer(
				engine,
				asked.marksFetch,
				(f, t) => columns(source, x => x >= f && x <= t),
				10,
				data.time[5999]!,
			);
			expect(engine.waiting).toBe(0);
			expect(answered.outcomes.every(o => o === 'restored')).toBe(true);
			expect(answered.rounds).toBe(1);
			expectHeat(engine, source);
		}
	}, 60_000);

	it('drops a change whose marks fit nothing after three rounds, reports it, and runs those behind it', async () => {
		const data = trades(400_000);
		const client = createEngine({ worker: false });
		const events: EngineEvent[] = [];
		const fetches: MarksFetchRequest[] = [];
		client.onevent = event => events.push(event);
		client.onmarksfetch = event => fetches.push(...(event.marksFetch ?? []));
		const marks: MarksUpdate[] = [];
		client.onmarks = updates => marks.push(...updates);
		const series = client.addMarks('scatter', true);
		client.changeMarks(series, { op: 'set', data: between(data, -Infinity, Infinity) });
		const tail = data.time[399_999]!;
		client.requestMarks(series, request(tail - 10_000, tail, 1));
		client.setMemoryLimit(1);
		await client.whenIdle();
		const from = data.time[70_000]!;
		const to = data.time[90_000]!;
		client.changeMarks(series, { op: 'delete', from, to });
		const tick = trades(1, 9, tail + 1000);
		client.changeMarks(series, { op: 'append', data: between(tick, -Infinity, Infinity) });
		await client.whenIdle();
		// A datafeed that returns points inside the removed range: neither as they went nor after it.
		const wrong = (f: number, t: number): ScatterRows => {
			const returned = between(data, f, t);
			returned.value![0] = returned.value![0]! + 1;
			return returned;
		};
		let refusedRounds = 0;
		for (let round = 0; round < 6 && fetches.length > 0; round++) {
			const out = fetches.splice(0);
			events.length = 0;
			for (const fetch of out) {
				client.restoreMarks(fetch.id, wrong(fetch.from, fetch.to));
			}
			// oxlint-disable-next-line no-await-in-loop
			await client.whenIdle();
			if (events.some(event => event.marksRestored?.outcome === 'mismatch')) {
				refusedRounds++;
			}
			if (events.some(event => event.rejectedSeries !== undefined)) {
				break;
			}
			// The client asks again with its view after its pause.
			client.requestMarks(series, request(tail - 10_000, tail, 1));
			// oxlint-disable-next-line no-await-in-loop
			await client.whenIdle();
		}
		expect(refusedRounds).toBe(3);
		const dropped = events.find(event => event.rejectedSeries !== undefined)!;
		expect(dropped.rejectedSeries).toEqual([series, 1]);
		// The append behind it ran, and the removal asks for nothing more.
		marks.length = 0;
		fetches.length = 0;
		client.requestMarks(series, request(tail - 10_000, tail + 2000, 1));
		await client.whenIdle();
		const rows = marks.at(-1)!;
		expect(rows.level).toBe(0);
		expect(rows.time[rows.count - 1]).toBe(tick.time[0]);
		expect(rows.first + rows.total).toBe(rows.start + rows.count);
		expect(fetches).toEqual([]);
		client.destroy();
	}, 60_000);
});

describe('scatter splices never read or write rows let go (2)', () => {
	it('throws instead of reading a row let go or writing a chunk let go in part', () => {
		const held = new ScatterColumns();
		for (let i = 0; i < 3 * 65_536; i++) {
			held.push(i * 1000, 100, 1);
		}
		expect(held.evict(1)).toBeGreaterThan(0);
		expect(() => held.timeAt(70_000)).toThrow(/let go/);
		// Moving the rows before a removal over a chunk let go would read it.
		expect(() => held.splice(140_000, 140_010, null, 0, 0, 'left')).toThrow(/let go/);
		// Removing rows inside it in place would write it in part.
		expect(() => held.splice(70_000, 70_010, null, 0, 0, 'right')).toThrow(/let go/);
		// Nothing changed.
		expect(held.count).toBe(3 * 65_536);
		expect(held.isEvicted(1)).toBe(true);
	});

	it('decides the side a removal moves only once its edges are back, and never makes rows of zero', () => {
		const count = 1_000_000;
		const flat: ScatterRows = {
			kind: 'scatter',
			count,
			time: Float64Array.from({ length: count }, (_, i) => i * 1000),
			price: new Float64Array(count).fill(100),
			value: Float32Array.from({ length: count }, (_, i) => 1 + (i % 97)),
		};
		for (const post of [false, true]) {
			const engine = letGo('scatter', flat);
			const from = 510_000 * 1000;
			const to = 510_009 * 1000;
			const source = without(flat, from, to);
			const asked = outcome();
			drain(engine.change(1, { op: 'delete', from, to }, asked));
			// The middle: which side is shorter is only known with the chunk of the edges.
			expect((asked.marksFetch ?? []).map(fetch => Math.floor(fetch.from / 1000 / 65_536))).toEqual([7, 8]);
			const answered = answer(
				engine,
				asked.marksFetch,
				(f, t) => between(post ? source : flat, f, t),
				10,
				flat.time[count - 1]!,
			);
			expect(engine.waiting).toBe(0);
			expect(answered.outcomes.every(o => o === 'restored')).toBe(true);
			// The edges, then the shorter side (after the removal: the points after it).
			expect(new Set(answered.fetched).size).toBeLessThanOrEqual(8);
			expectScatter(engine, source);
		}
	}, 120_000);
});

describe('a heatmap removal that leaves fewer levels (3)', () => {
	for (const [label, count, rows, a, b] of [
		['in the middle', 40_000, 256, 17_000, 24_299],
		['of the oldest columns', 50_000, 512, 0, 19_999],
	] as const) {
		it(`runs in one round and fetches only columns that stay, removing ${label}`, () => {
			const data = heat(count, rows, (c, r) => (c * 7 + r * 3) % 90);
			for (const post of [false, true]) {
				const engine = letGo('heatmap', data);
				const from = data.time[a]!;
				const to = data.time[b]!;
				const source = columns(data, t => !(t >= from && t <= to));
				const asked = outcome();
				drain(engine.change(1, { op: 'delete', from, to }, asked));
				const fetches = asked.marksFetch ?? [];
				expect(fetches.length).toBeGreaterThan(0);
				// Nothing inside the removed range is asked for.
				expect(fetches.filter(fetch => fetch.from >= from && fetch.to <= to)).toEqual([]);
				const answered = answer(engine, fetches, (f, t) => columns(post ? source : data, x => x >= f && x <= t));
				expect(engine.waiting).toBe(0);
				expect(answered.rounds).toBe(1);
				expect(answered.outcomes.every(o => o === 'restored')).toBe(true);
				// Cutting the oldest moves nothing: only the columns beside the cut. In the middle, the
				// shorter side moves.
				expect(answered.fetched.length).toBeLessThanOrEqual(a === 0 ? 2 : 64);
				expectHeat(engine, source);
			}
		}, 120_000);
	}
});

describe('what a small change fetches (4)', () => {
	it('removes 30 points in the middle of a million let go with the shorter side and the chunks beside the gap', () => {
		const data = trades(1_000_000);
		for (const [at, most] of [
			[200_000, 4],
			[480_000, 9],
			[800_000, 6],
		] as const) {
			const engine = letGo('scatter', data);
			const from = data.time[at]!;
			const to = data.time[at + 29]!;
			const source = without(data, from, to);
			const asked = outcome();
			drain(engine.change(1, { op: 'delete', from, to }, asked));
			const answered = answer(engine, asked.marksFetch, (f, t) => between(source, f, t), 10, data.time[999_000]!);
			expect(engine.waiting).toBe(0);
			// Chunks of 65,536 points: the side that moves, the edges, the cells of the coarse
			// chunks at the gap; nowhere near all fourteen let go.
			expect(new Set(answered.fetched).size, `at ${at}`).toBeLessThanOrEqual(most);
		}
	}, 120_000);

	it('corrects one heatmap column with the chunk that holds it', () => {
		for (const [count, rows] of [
			[3000, 1024],
			[40_000, 256],
			[200_000, 64],
		] as const) {
			const data = heat(count, rows, (c, r) => (c * 3 + r) % 80);
			const engine = letGo('heatmap', data);
			const c = Math.floor(count * 0.4);
			const fix = heat(1, rows, () => 500, 0, c);
			const asked = outcome();
			drain(engine.change(1, { op: 'correct', data: fix }, asked));
			expect(asked.marksFetch?.length, `${count} x ${rows}`).toBe(1);
			const values = data.values.slice();
			values.set(fix.values, c * rows);
			const source = { ...data, values };
			answer(engine, asked.marksFetch, (f, t) => columns(source, x => x >= f && x <= t));
			expect(engine.waiting).toBe(0);
			if (count === 3000) {
				expectHeat(engine, source);
			}
		}
	}, 120_000);
});
