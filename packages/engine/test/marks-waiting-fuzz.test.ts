import {
	type HeatmapColumns,
	type HeatmapStore,
	type MarksChange,
	MarksEngine,
	type MarksFetchRequest,
	type MarksOutcome,
	type MarksUpdate,
	type ScatterRows,
	type ScatterStore,
} from '@lumen-charts/engine';
import { describe, expect, it } from 'vitest';
import { blankUpdate, drain, random, request } from './marks-helpers';

/**
 * Random histories of a scatter and a heatmap with a datafeed, under a memory limit that lets go of
 * points, columns and intermediate levels: sets, appends, prepends, removals and corrections anywhere,
 * each made at the source first (as an application does) and then sent. The datafeed answers at
 * random with the marks as they went, as they are after the waiting changes (some or all of them),
 * or now and then with marks that are neither. After every settle the series must not be stalled,
 * level 0 must be the source, every level must be what level 0 makes, and nothing may be zero or NaN
 * that was not given.
 */

function outcome(): MarksOutcome {
	return { rejected: 0 };
}

/** Every row of a level, made first where coarse chunks were let go (level 0 must be held). */
function readLevel(store: ScatterStore | HeatmapStore, l: number): MarksUpdate {
	expect(store.materialize(l, store.first(l), store.first(l) + store.total(l)), `level ${l} made`).toBe(true);
	const update = blankUpdate();
	store.read(l, store.first(l), store.first(l) + store.total(l), update);
	return update;
}

// The source: what the application holds, changed as the engine changes the series.

interface Points {
	time: number[];
	price: number[];
	value: number[];
}

function pointsOf(points: Points, from = -Infinity, to = Infinity): ScatterRows {
	const keep: number[] = [];
	for (let i = 0; i < points.time.length; i++) {
		if (points.time[i]! >= from && points.time[i]! <= to) {
			keep.push(i);
		}
	}
	return {
		kind: 'scatter',
		count: keep.length,
		time: Float64Array.from(keep, i => points.time[i]!),
		price: Float64Array.from(keep, i => points.price[i]!),
		value: Float32Array.from(keep, i => points.value[i]!),
	};
}

function copyPoints(points: Points): Points {
	return { time: points.time.slice(), price: points.price.slice(), value: points.value.slice() };
}

/** Applies a change to the points as the store does (a correction over a range without points is refused). */
function changePoints(points: Points, change: MarksChange): Points {
	if (change.op === 'set') {
		const data = change.data as ScatterRows;
		return { time: [...data.time], price: [...data.price], value: [...data.value!] };
	}
	const next = copyPoints(points);
	if (change.op === 'append') {
		const data = change.data as ScatterRows;
		next.time.push(...data.time);
		next.price.push(...data.price);
		next.value.push(...data.value!);
		return next;
	}
	if (change.op === 'prepend') {
		const data = change.data as ScatterRows;
		next.time.unshift(...data.time);
		next.price.unshift(...data.price);
		next.value.unshift(...data.value!);
		return next;
	}
	if (change.op === 'delete' || change.op === 'correct') {
		const from = change.op === 'delete' ? change.from : change.from!;
		const to = change.op === 'delete' ? change.to : change.to!;
		let a = 0;
		while (a < next.time.length && next.time[a]! < from) a++;
		let b = a;
		while (b < next.time.length && next.time[b]! <= to) b++;
		if (change.op === 'correct' && b === a) {
			return points;
		}
		const data = change.op === 'correct' ? (change.data as ScatterRows) : null;
		next.time.splice(a, b - a, ...(data === null ? [] : data.time));
		next.price.splice(a, b - a, ...(data === null ? [] : data.price));
		next.value.splice(a, b - a, ...(data === null ? [] : data.value!));
		return next;
	}
	return points;
}

interface Column {
	time: number;
	offset: number;
	values: Float32Array;
}

const ROWS = 32;

function columnsOf(columns: readonly Column[], from = -Infinity, to = Infinity): HeatmapColumns {
	const kept = columns.filter(column => column.time >= from && column.time <= to);
	const values = new Float32Array(kept.length * ROWS);
	kept.forEach((column, i) => values.set(column.values, i * ROWS));
	return {
		kind: 'heatmap',
		count: kept.length,
		rows: ROWS,
		priceStart: 90,
		priceStep: 0.5,
		time: Float64Array.from(kept, column => column.time),
		offsets: Int32Array.from(kept, column => column.offset),
		values,
	};
}

function unpack(data: HeatmapColumns): Column[] {
	return Array.from({ length: data.count }, (_, i) => ({
		time: data.time[i]!,
		offset: data.offsets![i]!,
		values: data.values.slice(i * ROWS, (i + 1) * ROWS),
	}));
}

function changeColumns(columns: readonly Column[], change: MarksChange): Column[] {
	switch (change.op) {
		case 'set':
			return unpack(change.data as HeatmapColumns);
		case 'append':
			return [...columns, ...unpack(change.data as HeatmapColumns)];
		case 'prepend':
			return [...unpack(change.data as HeatmapColumns), ...columns];
		case 'delete':
			return columns.filter(column => !(column.time >= change.from && column.time <= change.to));
		case 'correct': {
			const byTime = new Map(unpack(change.data as HeatmapColumns).map(column => [column.time, column]));
			return columns.map(column => byTime.get(column.time) ?? column);
		}
		default:
			return columns.slice();
	}
}

// The checks.

/** Level 0 is the source, and every coarse level holds exactly the cells level 0 makes, in their order. */
function expectScatter(store: ScatterStore, points: Points): void {
	const raw = readLevel(store, 0);
	expect(raw.count).toBe(points.time.length);
	let wrong = 0;
	for (let i = 0; i < raw.count; i++) {
		if (
			raw.time[i] !== points.time[i] ||
			raw.price[i] !== points.price[i] ||
			!Object.is(raw.values[i], Math.fround(points.value[i]!))
		) {
			wrong++;
		}
	}
	expect(wrong).toBe(0);
	for (let l = 1; l <= store.levels; l++) {
		const cells = readLevel(store, l);
		// The cells in the order the points first fall in them, bucket by bucket.
		const order: string[] = [];
		const expected = new Map<
			string,
			{ value: number; count: number; t0: number; t1: number; p0: number; p1: number }
		>();
		for (let i = 0; i < raw.count; i++) {
			const t = raw.time[i]!;
			const p = raw.price[i]!;
			const v = raw.values[i]!;
			const key = `${Math.floor(t / cells.timeStep)}:${Math.floor(p / cells.priceStep)}`;
			const cell = expected.get(key);
			if (cell === undefined) {
				order.push(key);
				expected.set(key, { value: v, count: 1, t0: t, t1: t, p0: p, p1: p });
			} else {
				if (v === v && !(cell.value >= v)) cell.value = v;
				cell.count++;
				cell.t0 = Math.min(cell.t0, t);
				cell.t1 = Math.max(cell.t1, t);
				cell.p0 = Math.min(cell.p0, p);
				cell.p1 = Math.max(cell.p1, p);
			}
		}
		expect(cells.count).toBe(order.length);
		// Buckets in order; within one, each cell once (a bucket a prepend merged into in place keeps
		// its cells in their old order, not the points').
		let bad = 0;
		const seen = new Set<string>();
		for (let i = 0; i < cells.count; i++) {
			const key = `${Math.floor(cells.time[i]! / cells.timeStep)}:${Math.floor(cells.price[i]! / cells.priceStep)}`;
			const cell = expected.get(key);
			if (
				cell === undefined ||
				seen.has(key) ||
				(i > 0 && cells.time[i]! < cells.time[i - 1]!) ||
				!Object.is(cells.values[i], cell.value) ||
				cells.counts[i] !== cell.count ||
				cells.bounds[i * 4] !== cell.t0 ||
				cells.bounds[i * 4 + 1] !== cell.t1 ||
				cells.bounds[i * 4 + 2] !== cell.p0 ||
				cells.bounds[i * 4 + 3] !== cell.p1
			) {
				bad++;
			}
			seen.add(key);
		}
		expect(bad, `level ${l}`).toBe(0);
	}
}

function expectHeat(store: HeatmapStore, columns: readonly Column[]): void {
	const raw = readLevel(store, 0);
	expect(raw.count).toBe(columns.length);
	const varying = raw.offsets.length > 0;
	let wrong = 0;
	for (let c = 0; c < raw.count; c++) {
		const column = columns[c]!;
		const offset = varying ? raw.offsets[c]! : 0;
		const cells = raw.values.subarray(c * ROWS, (c + 1) * ROWS);
		if (
			raw.time[c] !== column.time ||
			offset !== column.offset ||
			cells.some((v, r) => !Object.is(v, column.values[r]))
		) {
			wrong++;
		}
	}
	expect(wrong).toBe(0);
	for (let l = 1; l <= store.levels; l++) {
		const level = readLevel(store, l);
		const size = 4 ** l;
		const first = Math.floor(raw.first / size);
		expect(level.first).toBe(first);
		expect(level.count).toBe(Math.floor((raw.first + raw.count - 1) / size) - first + 1);
		let at = 0;
		let bad = 0;
		for (let k = 0; k < level.count; k++) {
			const bucket = first + k;
			const members = columns.slice(
				Math.max(0, bucket * size - raw.first),
				Math.min(columns.length, (bucket + 1) * size - raw.first),
			);
			let low = Infinity;
			let high = -Infinity;
			for (const member of members) {
				low = Math.min(low, member.offset);
				high = Math.max(high, member.offset + ROWS);
			}
			const merged = new Float32Array(high - low).fill(Number.NaN);
			for (const member of members) {
				member.values.forEach((v, r) => {
					const i = member.offset - low + r;
					if (v === v && !(merged[i]! >= v)) merged[i] = v;
				});
			}
			const length = varying ? level.lengths[k]! : ROWS;
			const offset = varying ? level.offsets[k]! : 0;
			const got = level.values.subarray(at, at + length);
			at += length;
			if (
				level.time[k] !== members[0]!.time ||
				offset !== low ||
				length !== merged.length ||
				got.some((v, r) => !Object.is(v, merged[r]))
			) {
				bad++;
			}
		}
		expect(bad, `level ${l}`).toBe(0);
	}
}

// The driver.

interface Harness<S> {
	kind: 'scatter' | 'heatmap';
	initial(next: () => number): S;
	data(source: S): MarksChange;
	answer(source: S, from: number, to: number): ScatterRows | HeatmapColumns;
	apply(source: S, change: MarksChange): S;
	/** A random change made to the source. */
	change(source: S, next: () => number): MarksChange | null;
	/** Marks that fit no reading of what went and what changed since: refused, whatever waits. */
	wrong(answer: ScatterRows | HeatmapColumns, next: () => number): ScatterRows | HeatmapColumns | null;
	span(source: S): [number, number];
	check(engine: MarksEngine, source: S): void;
}

function run<S>(
	harness: Harness<S>,
	seed: number,
	steps: number,
): { applied: number; refused: number; waited: number } {
	const next = random(seed);
	const engine = new MarksEngine();
	drain(engine.change(1, { op: 'add', kind: harness.kind, fetchable: true }, outcome()));
	let source = harness.initial(next);
	// What the engine holds: the history as the changes it applied left it. The datafeed answers with
	// that history (the marks as they went) or with the source (as they are after the changes waiting).
	let held = source;
	const out = new Map<number, MarksFetchRequest>();
	let seq = 1;
	let refused = 0;
	let waited = 0;
	// One answer that fits nothing per change that runs: three rounds of them drop a change.
	let wrongAllowed = true;
	let waitingAtWrong = 0;
	const take = (result: MarksOutcome): void => {
		for (const { change } of result.appliedMarks ?? []) {
			held = harness.apply(held, change);
		}
		for (const id of result.marksCancel ?? []) {
			out.delete(id);
		}
		for (const fetch of result.marksFetch ?? []) {
			out.set(fetch.id, fetch);
		}
		expect(result.rejected, 'a waiting change was dropped').toBe(0);
		if (engine.waiting < waitingAtWrong || engine.waiting === 0) {
			wrongAllowed = true;
		}
	};
	const send = (change: MarksChange): void => {
		const result = outcome();
		drain(engine.change(1, change, result));
		take(result);
	};
	send(harness.data(source));
	const view = (): void => {
		const [first, last] = harness.span(source);
		const at = first + next() * (last - first);
		const width = (last - first) * (next() < 0.5 ? 0.002 : 0.05);
		const result = outcome();
		engine.window(1, seq++, request(at, at + width, next() < 0.5 ? 1 : (last - first) / 2000), result);
		take(result);
	};
	const answerOne = (): void => {
		const ids = [...out.keys()];
		const id = ids[Math.floor(next() * ids.length)]!;
		const fetch = out.get(id)!;
		out.delete(id);
		const waiting = engine.waiting;
		// As they went, or as they are now, after the changes waiting.
		const now = next() < 0.6;
		let data: ScatterRows | HeatmapColumns | null = harness.answer(now ? source : held, fetch.from, fetch.to);
		if (next() < 0.03) {
			data = null;
		} else if (waiting > 0 && wrongAllowed && next() < 0.15) {
			const wrong = harness.wrong(data, next);
			if (wrong !== null) {
				data = wrong;
				wrongAllowed = false;
				waitingAtWrong = waiting;
			}
		}
		const result = outcome();
		drain(engine.restore(id, data, result));
		if (result.marksRestored?.outcome === 'mismatch') {
			refused++;
		}
		take(result);
	};
	/** Answers everything, asking again as the view would after a pause, until nothing waits. */
	const settle = (): void => {
		for (let round = 0; ; round++) {
			while (out.size > 0) {
				answerOne();
			}
			if (engine.waiting === 0) {
				return;
			}
			expect(round, 'the series is stalled').toBeLessThan(12);
			view();
		}
	};
	let applied = 0;
	for (let step = 0; step < steps; step++) {
		const roll = next();
		if (roll < 0.55) {
			const change = harness.change(source, next);
			if (change !== null) {
				// The source changes first; then the change is sent.
				source = harness.apply(source, change);
				if (engine.waiting > 0) {
					waited++;
				}
				send(change);
				applied++;
			}
		} else if (roll < 0.75) {
			view();
		} else if (roll < 0.9) {
			// Under the memory limit: points, columns and intermediate levels go, far from the view first.
			engine.evict(next() < 0.5 ? Infinity : engine.byteLength * next() * 0.5, Infinity);
		} else {
			for (let k = 0; k < 3 && out.size > 0; k++) {
				answerOne();
			}
		}
		if (step % 8 === 7 || step === steps - 1) {
			settle();
			// Everything back, every level made: then they must be exactly what the source makes.
			const store = engine.store(1)!;
			const left: number[] = [];
			for (let round = 0; ; round++) {
				left.length = 0;
				store.missing(0, store.first(0), store.first(0) + store.total(0), left);
				if (left.length === 0) {
					break;
				}
				expect(round, 'marks let go do not come back').toBeLessThan(10);
				const all = outcome();
				engine.window(1, seq++, request(-Infinity, Infinity, 1, { limit: Infinity }), all);
				take(all);
				settle();
			}
			harness.check(engine, source);
			engine.evict(Infinity, Infinity);
		}
	}
	return { applied, refused, waited };
}

const scatter: Harness<Points> = {
	kind: 'scatter',
	initial(next) {
		const points: Points = { time: [], price: [], value: [] };
		let t = 1_000_000;
		for (let i = 0; i < 300_000; i++) {
			t += next() < 0.2 ? 0 : 1000;
			points.time.push(t);
			points.price.push(100 + (i % 40) * 0.25 + Math.floor(next() * 4) * 0.01);
			points.value.push(1 + Math.floor(next() * 100));
		}
		return points;
	},
	data: points => ({ op: 'set', data: pointsOf(points) }),
	answer: (points, from, to) => pointsOf(points, from, to),
	apply: changePoints,
	change(points, next) {
		const n = points.time.length;
		if (n < 100_000) {
			return null;
		}
		const first = points.time[0]!;
		const last = points.time[n - 1]!;
		const fresh = (count: number, from: number, to: number): ScatterRows => {
			const time = Array.from({ length: count }, () => from + Math.floor(next() * (to - from + 1)));
			time.sort((a, b) => a - b);
			return {
				kind: 'scatter',
				count,
				time: Float64Array.from(time),
				price: Float64Array.from(time, () => 99 + next() * 12),
				value: Float32Array.from(time, () => 1 + Math.floor(next() * 100)),
			};
		};
		const roll = next();
		if (roll < 0.15) {
			return { op: 'append', data: fresh(1 + Math.floor(next() * 2000), last, last + 2_000_000) };
		}
		if (roll < 0.3) {
			return { op: 'prepend', data: fresh(1 + Math.floor(next() * 2000), first - 2_000_000, first) };
		}
		// Anywhere: a few points, or tens of thousands.
		const from = points.time[Math.floor(next() * n)]!;
		const to = from + (next() < 0.6 ? Math.floor(next() * 40_000) : Math.floor(next() * 40_000_000));
		if (roll < 0.65) {
			return { op: 'delete', from, to };
		}
		const count = next() < 0.2 ? 0 : 1 + Math.floor(next() * (next() < 0.5 ? 50 : 30_000));
		return { op: 'correct', data: fresh(count, from, to), from, to };
	},
	wrong(answer, next) {
		// A point without a price.
		const data = answer as ScatterRows;
		if (data.count === 0) {
			return null;
		}
		const price = data.price.slice();
		price[Math.floor(next() * data.count)] = Number.NaN;
		return { ...data, price };
	},
	span: points => [points.time[0]!, points.time[points.time.length - 1]!],
	check(engine, points) {
		expectScatter(engine.store(1) as ScatterStore, points);
	},
};

const heatmap: Harness<Column[]> = {
	kind: 'heatmap',
	initial(next) {
		return Array.from({ length: 30_000 }, (_, c) => ({
			time: (100_000 + c) * 60_000,
			offset: Math.round(Math.sin(c / 300) * 20) + Math.floor(next() * 3),
			values: Float32Array.from({ length: ROWS }, (__, r) => ((c * 7 + r * 3) % 90) + (next() < 0.05 ? Number.NaN : 0)),
		}));
	},
	data: columns => ({ op: 'set', data: columnsOf(columns) }),
	answer: (columns, from, to) => columnsOf(columns, from, to),
	apply: changeColumns,
	change(columns, next) {
		const n = columns.length;
		if (n < 5000) {
			return null;
		}
		const make = (times: number[]): HeatmapColumns =>
			columnsOf(
				times.map(time => ({
					time,
					offset: Math.floor(next() * 40) - 20,
					values: Float32Array.from({ length: ROWS }, () => (next() < 0.05 ? Number.NaN : Math.floor(next() * 120))),
				})),
			);
		const roll = next();
		if (roll < 0.15) {
			const last = columns[n - 1]!.time;
			return {
				op: 'append',
				data: make(Array.from({ length: 1 + Math.floor(next() * 600) }, (_, i) => last + (i + 1) * 60_000)),
			};
		}
		if (roll < 0.3) {
			const first = columns[0]!.time;
			const count = 1 + Math.floor(next() * 600);
			return { op: 'prepend', data: make(Array.from({ length: count }, (_, i) => first - (count - i) * 60_000)) };
		}
		const at = Math.floor(next() * n);
		if (roll < 0.65) {
			const span = next() < 0.6 ? Math.floor(next() * 20) : Math.floor(next() * 12_000);
			return { op: 'delete', from: columns[at]!.time, to: columns[Math.min(n - 1, at + span)]!.time };
		}
		const count = 1 + Math.floor(next() * (next() < 0.7 ? 3 : 400));
		const times = new Set<number>();
		for (let k = 0; k < count; k++) {
			times.add(columns[Math.min(n - 1, at + Math.floor(next() * count * 4))]!.time);
		}
		const sorted = [...times];
		sorted.sort((a, b) => a - b);
		return { op: 'correct', data: make(sorted) };
	},
	wrong(answer, next) {
		// A column at a time the chunk never held.
		const data = answer as HeatmapColumns;
		if (data.count < 2) {
			return null;
		}
		const at = 1 + Math.floor(next() * (data.count - 1));
		const t = (data.time[at - 1]! + data.time[at]!) / 2;
		if (!(t > data.time[at - 1]! && t < data.time[at]!)) {
			return null;
		}
		const values = new Float32Array((data.count + 1) * ROWS);
		values.set(data.values.subarray(0, at * ROWS));
		values.fill(3, at * ROWS, (at + 1) * ROWS);
		values.set(data.values.subarray(at * ROWS), (at + 1) * ROWS);
		const time = new Float64Array(data.count + 1);
		time.set(data.time.subarray(0, at));
		time[at] = t;
		time.set(data.time.subarray(at), at + 1);
		const offsets = new Int32Array(data.count + 1);
		offsets.set(data.offsets!.subarray(0, at));
		offsets[at] = 0;
		offsets.set(data.offsets!.subarray(at), at + 1);
		return { ...data, count: data.count + 1, time, offsets, values };
	},
	span: columns => [columns[0]!.time, columns[columns.length - 1]!.time],
	check(engine, columns) {
		expectHeat(engine.store(1) as HeatmapStore, columns);
	},
};

/** `run`, naming the seed of a failure. */
function runSeed<S>(harness: Harness<S>, seed: number, steps: number): ReturnType<typeof run> {
	try {
		return run(harness, seed, steps);
	} catch (error) {
		(error as Error).message = `${harness.kind} seed ${seed}: ${(error as Error).message}`;
		throw error;
	}
}

/** The seeds to run: these, or `FUZZ_SEEDS` (`first..last`) to look further. */
function seeds(fixed: number[]): number[] {
	const range = /^(\d+)\.\.(\d+)$/.exec(process.env.FUZZ_SEEDS ?? '');
	if (range === null) {
		return fixed;
	}
	return Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, i) => Number(range[1]) + i);
}

describe('marks waiting for a datafeed, at random', () => {
	it(
		'keeps a scatter exact and moving through random changes, evictions and answers',
		() => {
			let total = { applied: 0, refused: 0, waited: 0 };
			const list = seeds([10, 12]);
			for (const seed of list) {
				const result = runSeed(scatter, seed, 48);
				total = {
					applied: total.applied + result.applied,
					refused: total.refused + result.refused,
					waited: total.waited + result.waited,
				};
			}
			// The runs did what they are for: changes waited behind others, and marks were refused.
			expect(total.applied).toBeGreaterThan(12 * list.length);
			expect(total.waited).toBeGreaterThan(0);
			expect(total.refused).toBeGreaterThan(0);
		},
		60_000 * Math.max(2, seeds([10, 12]).length),
	);

	it(
		'keeps a heatmap exact and moving through random changes, evictions and answers',
		() => {
			let total = { applied: 0, refused: 0, waited: 0 };
			const list = seeds([4, 11]);
			for (const seed of list) {
				const result = runSeed(heatmap, seed, 48);
				total = {
					applied: total.applied + result.applied,
					refused: total.refused + result.refused,
					waited: total.waited + result.waited,
				};
			}
			expect(total.applied).toBeGreaterThan(12 * list.length);
			expect(total.waited).toBeGreaterThan(0);
			expect(total.refused).toBeGreaterThan(0);
		},
		60_000 * Math.max(2, seeds([4, 11]).length),
	);
});
