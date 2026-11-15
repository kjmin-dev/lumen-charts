import {
	CHUNK_ROWS,
	type Command,
	EngineCore,
	type EngineEvent,
	type FetchRequest,
	levelCount,
	levelShift,
} from '@lumen-charts/engine';
import { describe, expect, it } from 'vitest';
import { WindowCache } from '../src/data/window-cache';

type Kind = 'ohlcv' | 'line';

function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const same = (a: number, b: number): boolean => (a !== a && b !== b) || a === b;

/** Brute-force bucket: first / highest / lowest / last of the non-missing members. */
function bucketOf(kind: Kind, columns: number[][], lo: number, hi: number): number[] {
	const pick = (c: number, how: 'first' | 'max' | 'min' | 'last'): number => {
		let result = NaN;
		for (let i = lo; i < hi; i++) {
			const x = columns[c]![i]!;
			if (x !== x) continue;
			if (how === 'first') return x;
			if (how === 'last' || result !== result) result = x;
			else if (how === 'max') result = Math.max(result, x);
			else result = Math.min(result, x);
		}
		return result;
	};
	return kind === 'line'
		? [pick(0, 'first'), pick(0, 'max'), pick(0, 'min'), pick(0, 'last')]
		: [pick(0, 'first'), pick(1, 'max'), pick(2, 'min'), pick(3, 'last'), pick(4, 'max')];
}

/** The truth: every row of one fetchable series, which is the main series. */
interface Truth {
	kind: Kind;
	first: number;
	time: number[];
	columns: number[][];
}

function block(truth: Truth, start: number, end: number): Float64Array {
	const n = end - start;
	const columns = truth.columns.length;
	const data = new Float64Array(n * (columns + 1));
	for (let i = 0; i < n; i++) {
		data[i] = truth.time[start - truth.first + i]!;
		for (let c = 0; c < columns; c++) {
			data[(c + 1) * n + i] = truth.columns[c]![start - truth.first + i]!;
		}
	}
	return data;
}

function value(r: () => number): number {
	return r() < 0.03 ? NaN : Math.round(r() * 10_000) / 100;
}

/** How often each path was taken, over all seeds. */
const seen = { deferred: 0, restored: 0, failed: 0, mismatch: 0, refusedFix: 0 };

function runOne(seed: number, steps: number): string | null {
	const r = rng(seed);
	const kind: Kind = r() < 0.5 ? 'line' : 'ohlcv';
	const columnCount = kind === 'line' ? 1 : 5;
	const core = new EngineCore();
	const cache = new WindowCache();
	let seq = 0;
	const log: string[] = [];
	const exec = (body: Record<string, unknown>): EngineEvent => {
		const generator = core.run({ ...body, seq: ++seq } as Command);
		let step = generator.next();
		while (step.done !== true) step = generator.next();
		return step.value;
	};
	const truth: Truth = { kind, first: 0, time: [], columns: Array.from({ length: columnCount }, () => []) };
	const load = (count: number): Float64Array => {
		truth.first = 0;
		truth.time = [];
		truth.columns = Array.from({ length: columnCount }, () => []);
		let t = 1_000_000 + Math.floor(r() * 1000);
		for (let i = 0; i < count; i++) {
			t += 1 + Math.floor(r() * 3);
			truth.time.push(t);
			for (const column of truth.columns) column.push(value(r));
		}
		return block(truth, 0, count);
	};

	/** Fetch requests out, answered after a random number of steps, in any order. */
	let pending: { request: FetchRequest; due: number; epoch: number }[] = [];
	let epoch = 0;
	let awaitingRaw = false;
	const columns = (_series: number, level: number) => (level === 0 ? columnCount : kind === 'line' ? 4 : 5);

	const check = (event: EngineEvent, what: string): string | null => {
		cache.apply(event, columns);
		for (const request of event.fetch ?? []) {
			// The same rows are never asked for twice while a request for them is out.
			for (const out of pending) {
				if (out.epoch === epoch && request.start < out.request.end && request.end > out.request.start) {
					return `${what}: asked again for rows ${request.start}..${request.end} while ${out.request.start}..${out.request.end} is out`;
				}
			}
			if (
				request.from !== truth.time[request.start - truth.first] ||
				request.to !== truth.time[request.end - 1 - truth.first]
			) {
				return `${what}: request ${request.start}..${request.end} has times ${request.from}..${request.to}`;
			}
			pending.push({ request, due: 1 + Math.floor(r() * 6), epoch });
		}
		if (event.window?.level === 0) {
			awaitingRaw = false;
		}
		const end = truth.first + truth.time.length;
		if (event.first !== truth.first || event.end !== end) {
			return `${what}: extent ${event.first},${event.end} expected ${truth.first},${end}`;
		}
		if (!core.busy) {
			const memory = core.memory;
			if (memory.bytes > memory.limit && memory.evictable > 0) {
				return `${what}: ${memory.bytes} bytes over the limit ${memory.limit} with ${memory.evictable} that could go`;
			}
		}
		for (let level = 0; level <= levelCount(truth.time.length); level++) {
			const window = cache.held(level);
			if (window === null || window.stale) continue;
			const size = 2 ** levelShift(level);
			for (let row = 0; row < window.count; row++) {
				const b = window.start + row;
				const lo = Math.max(b * size, truth.first) - truth.first;
				const hi = Math.min((b + 1) * size, end) - truth.first;
				if (lo < 0 || hi > truth.time.length || hi <= lo) return `${what}: level ${level} item ${b} outside the data`;
				if (window.time[row] !== truth.time[lo]) return `${what}: level ${level} time at ${b}`;
				const want = level === 0 ? truth.columns.map(column => column[lo]!) : bucketOf(kind, truth.columns, lo, hi);
				const got = window.blocks.get(1);
				if (got === undefined) return `${what}: level ${level} has no block`;
				for (let c = 0; c < want.length; c++) {
					if (!same(got[c * window.capacity + row]!, want[c]!)) {
						return `${what}: level ${level} col ${c} at ${b} = ${got[c * window.capacity + row]} expected ${want[c]}`;
					}
				}
			}
		}
		return null;
	};

	/** Answers one fetch request: the right rows, a failure, or rows that do not match. */
	const answer = (index: number, outcome: 'good' | 'fail' | 'bad'): EngineEvent => {
		const { request } = pending.splice(index, 1)[0]!;
		let data: Float64Array | null = null;
		let count = 0;
		if (outcome !== 'fail' && request.start >= truth.first && request.end <= truth.first + truth.time.length) {
			data = block(truth, request.start, request.end);
			count = request.end - request.start;
			if (outcome === 'bad') {
				if (r() < 0.5) {
					data[Math.floor(r() * count)]! += 0.5;
				} else {
					data = block(truth, request.start, request.end - 1);
					count--;
				}
			}
		}
		const result = exec({ type: 'rows', series: 1, start: request.start, count, data });
		const outcomeSeen = result.restored?.outcome;
		if (outcomeSeen !== undefined && result.restored!.expected > 0) seen[outcomeSeen]++;
		return result;
	};

	exec({ type: 'add', series: 1, kind, fetchable: true });
	const initial = CHUNK_ROWS * (6 + Math.floor(r() * 10)) + Math.floor(r() * CHUNK_ROWS);
	let event = exec({ type: 'set', series: 1, count: initial, data: load(initial) });
	let failure = check(event, 'set');
	if (failure !== null) return `seed ${seed}: ${failure}`;
	while (core.backgroundStep());
	const valueBytes = initial * 8 * columnCount;
	const limit = core.byteLength - valueBytes + CHUNK_ROWS * 8 * columnCount * (2 + Math.floor(r() * 5));
	event = exec({ type: 'limit', bytes: limit });

	for (let step = 0; step < steps; step++) {
		let what: string;
		for (const out of pending) out.due--;
		const dueIndex = pending.findIndex(out => out.due <= 0);
		const answering = dueIndex >= 0 && r() < 0.5;
		const p = r();
		if (answering) {
			const roll = r();
			const outcome = roll < 0.75 ? 'good' : roll < 0.9 ? 'fail' : 'bad';
			what = `answer ${pending[dueIndex]!.request.start} ${outcome}`;
			event = answer(dueIndex, outcome);
			if (
				outcome === 'bad' &&
				event.restored?.outcome !== 'mismatch' &&
				pending.length >= 0 &&
				event.restored?.expected !== 0
			) {
				return `seed ${seed} step ${step}: rows that do not match were not refused (${event.restored?.outcome})`;
			}
		} else if (p < 0.03) {
			// A new load: answers still out for the old rows must be ignored.
			const count = CHUNK_ROWS * (4 + Math.floor(r() * 6));
			what = `set ${count}`;
			epoch++;
			event = exec({ type: 'set', series: 1, count, data: load(count) });
		} else if (p < 0.15) {
			const n = 1 + Math.floor(r() * (r() < 0.2 ? 3 * CHUNK_ROWS : 500));
			const times: number[] = [];
			let t = truth.time[0]!;
			for (let i = 0; i < n; i++) {
				t -= 1 + Math.floor(r() * 3);
				times.unshift(t);
			}
			const values = Array.from({ length: columnCount }, () => Array.from({ length: n }, () => value(r)));
			truth.time = times.concat(truth.time);
			truth.columns = truth.columns.map((column, c) => values[c]!.concat(column));
			truth.first -= n;
			what = `prepend ${n}`;
			event = exec({ type: 'prepend', series: 1, count: n, data: block(truth, truth.first, truth.first + n) });
		} else if (p < 0.5) {
			// Ticks on the last bar or a new one, and now and then a correction of an older bar.
			const batch: number[][] = [];
			const updates: { index: number; values: number[] }[] = [];
			const nt = 1 + Math.floor(r() * 4);
			for (let k = 0; k < nt; k++) {
				const values = Array.from({ length: columnCount }, () => value(r));
				const last = truth.time.length - 1;
				if (r() < 0.5) {
					batch.push([1, truth.time[last]!, ...values]);
					updates.push({ index: last, values });
				} else {
					const t = truth.time[last]! + 1 + Math.floor(r() * 3);
					batch.push([1, t, ...values]);
					truth.time.push(t);
					for (const column of truth.columns) column.push(NaN);
					updates.push({ index: last + 1, values });
				}
			}
			const correction = r() < 0.3 ? Math.floor(r() * (truth.time.length - 1)) : -1;
			const fixed = Array.from({ length: columnCount }, () => value(r));
			if (correction >= 0) batch.push([1, truth.time[correction]!, ...fixed]);
			const data = new Float64Array(batch.length * 7).fill(NaN);
			batch.forEach((row, i) => data.set(row, i * 7));
			what = `ticks ${batch.length}${correction >= 0 ? ` fix ${correction + truth.first}` : ''}`;
			event = exec({ type: 'ticks', count: batch.length, data });
			for (const { index, values } of updates) {
				truth.columns.forEach((column, c) => (column[index] = values[c]!));
			}
			// A correction of a bar whose values were let go is refused; the engine says so.
			if (correction >= 0 && event.rejected === 0) {
				truth.columns.forEach((column, c) => (column[correction] = fixed[c]!));
			} else if (correction >= 0) {
				seen.refusedFix++;
			}
		} else {
			const length = truth.time.length;
			const level = Math.floor(r() * (levelCount(length) + 1));
			const size = 2 ** levelShift(level);
			const lo = Math.floor(truth.first / size);
			const span = Math.ceil(length / size);
			const start = lo + Math.floor(r() * span);
			const count = 1 + Math.floor(r() * Math.min(span, 3000));
			what = `window L${level} ${start}+${count}`;
			event = exec({ type: 'window', level, start, count, capacity: count + 16 });
			if (level === 0 && event.window === undefined) {
				awaitingRaw = true;
				seen.deferred++;
			}
		}
		log.push(what);
		if (r() < 0.3) for (let k = Math.floor(r() * 4); k > 0 && core.backgroundStep(); k--);
		failure = check(event, what);
		if (failure !== null) return `seed ${seed} step ${step}: ${failure}\nlast ops:\n${log.slice(-8).join('\n')}`;
	}

	// Every answer arrives; then nothing may still wait, and the rows let go come back as they were.
	pending = pending.filter(out => out.epoch === epoch);
	while (pending.length > 0) {
		failure = check(answer(0, 'good'), 'drain');
		if (failure !== null) return `seed ${seed}: ${failure}`;
	}
	if (awaitingRaw) return `seed ${seed}: a raw window still waits after every fetch was answered`;
	const all = truth.time.length;
	event = exec({ type: 'window', level: 0, start: truth.first, count: all, capacity: all });
	failure = check(event, 'all rows');
	while (failure === null && pending.length > 0) {
		failure = check(answer(0, 'good'), 'all rows back');
	}
	if (failure !== null) return `seed ${seed}: ${failure}`;
	const raw = cache.held(0);
	if (raw === null || raw.start !== truth.first || raw.count !== all) {
		return `seed ${seed}: the full raw window did not come back (${raw?.start}+${raw?.count})`;
	}
	return null;
}

/**
 * A fetchable series under a memory limit, driven through the real engine and window cache with a
 * fake datafeed whose answers come late, in any order, fail, or do not match. After every event:
 * every row and bucket the cache holds equals the truth, no rows are asked for twice, and the
 * engine is within its limit unless nothing more can go. At the end, every row let go comes back.
 */
describe('memory limit with a datafeed against a model', () => {
	it('never shows a wrong row and stays within the limit', () => {
		const failures: string[] = [];
		for (let seed = 1; seed <= 16 && failures.length < 3; seed++) {
			const failure = runOne(seed, 100);
			if (failure !== null) failures.push(failure);
		}
		expect(failures).toEqual([]);
		// Every path was taken.
		expect(Object.entries(seen).filter(([, count]) => count === 0)).toEqual([]);
	}, 120_000);
});
