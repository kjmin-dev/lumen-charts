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
const valueColumns = (kind: Kind): number => (kind === 'line' ? 1 : 5);
const levelColumns = (kind: Kind): number => (kind === 'line' ? 4 : 5);

/** One series as the engine has applied it, plus what its datafeed would answer. */
interface Model {
	id: number;
	kind: Kind;
	fetchable: boolean;
	time: number[];
	/** Value columns. */
	values: number[][];
	/** Index of the first bar in the series' own store; NaN after a deletion moved bars either way. */
	first: number;
	/** Values at the source that differ from `values` (the main series only): what a refetch brings. */
	source: Map<number, number[]>;
}

type Op =
	| { type: 'set'; model: Model; time: number[]; values: number[][]; fetchable: boolean | undefined }
	| { type: 'prepend'; model: Model; time: number[]; values: number[][] }
	| { type: 'tick'; model: Model; time: number; values: number[] }
	| { type: 'delete'; model: Model; from: number; to: number };

/** First index whose time is not less than `t`. */
function lowerBound(times: readonly number[], t: number): number {
	let lo = 0;
	let hi = times.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (times[mid]! < t) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** Values of every series on the main timeline (slot merge as in the engine), column by column. */
function align(main: Model, all: readonly Model[]): Map<number, Float64Array[]> {
	const n = main.time.length;
	const out = new Map<number, Float64Array[]>();
	for (const s of all) {
		if (s === main) {
			out.set(
				s.id,
				s.values.map(column => Float64Array.from(column)),
			);
			continue;
		}
		const columns = Array.from({ length: valueColumns(s.kind) }, () => new Float64Array(n).fill(NaN));
		let j = lowerBound(s.time, main.time[0]!);
		for (let k = 0; k < n && j < s.time.length; k++) {
			const hi = k + 1 < n ? main.time[k + 1]! : Infinity;
			if (s.time[j]! >= hi) continue;
			let open = NaN;
			let high = NaN;
			let low = NaN;
			let close = NaN;
			let vol = NaN;
			for (; j < s.time.length && s.time[j]! < hi; j++) {
				if (s.kind === 'line') {
					const x = s.values[0]![j]!;
					if (x === x) close = x;
					continue;
				}
				const [o, h, l, c, v] = [0, 1, 2, 3, 4].map(col => s.values[col]![j]!) as [
					number,
					number,
					number,
					number,
					number,
				];
				if (open !== open) open = o;
				if (h === h && !(h <= high)) high = h;
				if (l === l && !(l >= low)) low = l;
				if (c === c) close = c;
				if (v === v) vol = vol === vol ? vol + v : v;
			}
			if (s.kind === 'line') {
				columns[0]![k] = close;
			} else {
				columns[0]![k] = open;
				columns[1]![k] = high;
				columns[2]![k] = low;
				columns[3]![k] = close;
				columns[4]![k] = vol;
			}
		}
		out.set(s.id, columns);
	}
	return out;
}

/** Buckets of one level from aligned rows: first / highest / lowest / last (and largest volume), skipping missing values. */
function bucketsOf(kind: Kind, rows: Float64Array[], first: number, n: number, shift: number): Float64Array[] {
	const size = 2 ** shift;
	const start = Math.floor(first / size);
	const end = Math.floor((first + n - 1) / size) + 1;
	const count = end - start;
	const out = Array.from({ length: levelColumns(kind) }, () => new Float64Array(count).fill(NaN));
	const sources = kind === 'line' ? [0, 0, 0, 0] : [0, 1, 2, 3, 4];
	const how = kind === 'line' ? ['first', 'max', 'min', 'last'] : ['first', 'max', 'min', 'last', 'max'];
	for (let b = 0; b < count; b++) {
		const lo = Math.max((start + b) * size, first) - first;
		const hi = Math.min((start + b + 1) * size, first + n) - first;
		for (let c = 0; c < out.length; c++) {
			const source = rows[sources[c]!]!;
			let result = NaN;
			for (let i = lo; i < hi; i++) {
				const x = source[i]!;
				if (x !== x) continue;
				if (how[c] === 'first') {
					result = x;
					break;
				}
				if (how[c] === 'last' || result !== result) result = x;
				else if (how[c] === 'max') result = Math.max(result, x);
				else result = Math.min(result, x);
			}
			out[c]![b] = result;
		}
	}
	return out;
}

/** Column-major rows, time first. */
function block(time: readonly number[], values: readonly number[][]): Float64Array {
	const n = time.length;
	const data = new Float64Array(n * (values.length + 1));
	data.set(time, 0);
	values.forEach((column, c) => data.set(column, (c + 1) * n));
	return data;
}

/** How often each path was taken, over all seeds. */
const seen = {
	deferred: 0,
	restored: 0,
	failed: 0,
	mismatch: 0,
	lateAfterCancel: 0,
	cancelled: 0,
	correctionWaited: 0,
	correctionRefused: 0,
	deleteHead: 0,
	deleteTail: 0,
	deleteMiddle: 0,
	deleteWaited: 0,
	sourceChange: 0,
	reload: 0,
	takeover: 0,
	secondaryEvicted: 0,
	sourceRemoved: 0,
};

function runOne(seed: number, steps: number): string | null {
	const r = rng(seed);
	const core = new EngineCore();
	const cache = new WindowCache();
	let seq = 0;
	const log: string[] = [];
	const models: Model[] = [];
	let nextId = 1;
	let version = 0;
	const value = (): number => (r() < 0.03 ? NaN : Math.round(r() * 10_000) / 100);
	const row = (kind: Kind): number[] => Array.from({ length: valueColumns(kind) }, value);
	const history = (kind: Kind, count: number, t0: number, step: number): { time: number[]; values: number[][] } => {
		const time: number[] = [];
		const values: number[][] = Array.from({ length: valueColumns(kind) }, () => []);
		let t = t0;
		for (let i = 0; i < count; i++) {
			t += 1 + Math.floor(r() * step);
			time.push(t);
			const v = row(kind);
			values.forEach((column, c) => column.push(v[c]!));
		}
		return { time, values };
	};
	const exec = (body: Record<string, unknown>): EngineEvent => {
		const generator = core.run({ ...body, seq: ++seq } as Command);
		let step = generator.next();
		while (step.done !== true) step = generator.next();
		return step.value;
	};
	const live = (): Model[] => models;
	const mainOf = (): Model | null => models.find(m => m.time.length > 0) ?? null;
	const byId = (id: number): Model | undefined => models.find(m => m.id === id);
	const columns = (id: number, level: number): number => {
		const kind = byId(id)?.kind ?? 'line';
		return level === 0 ? valueColumns(kind) : levelColumns(kind);
	};

	/** Operations of commands that wait, by `${seq}:${row}`. */
	const waiting = new Map<string, Op>();
	/** Fetch requests out, by id. */
	const requests = new Map<number, { request: FetchRequest; due: number; cancelled: boolean }>();
	let takeover = false;

	const applyOp = (op: Op): void => {
		const m = op.model;
		version++;
		switch (op.type) {
			case 'set':
				m.time = op.time.slice();
				m.values = op.values.map(column => column.slice());
				m.first = 0;
				m.source.clear();
				if (op.fetchable !== undefined) m.fetchable = op.fetchable;
				return;
			case 'prepend':
				if (m.time.length === 0) {
					m.time = op.time.slice();
					m.values = op.values.map(column => column.slice());
					m.first = 0;
					return;
				}
				m.time = op.time.concat(m.time);
				m.values = m.values.map((column, c) => op.values[c]!.concat(column));
				m.first -= op.time.length;
				return;
			case 'tick': {
				const n = m.time.length;
				if (n === 0 || op.time > m.time[n - 1]!) {
					if (n === 0) m.first = 0;
					m.time.push(op.time);
					m.values.forEach((column, c) => column.push(op.values[c]!));
					return;
				}
				const k = lowerBound(m.time, op.time);
				if (m.time[k] !== op.time) {
					seen.correctionRefused++;
					return;
				}
				m.values.forEach((column, c) => (column[k] = op.values[c]!));
				m.source.delete(op.time);
				return;
			}
			case 'delete': {
				const d0 = lowerBound(m.time, op.from);
				let d1 = lowerBound(m.time, op.to);
				if (d1 < m.time.length && m.time[d1] === op.to) d1++;
				if (d1 <= d0) return;
				const n = m.time.length;
				if (d0 === 0 && d1 === n) {
					m.first = 0;
				} else if (d0 === 0) {
					m.first += d1 - d0;
					seen.deleteHead++;
				} else if (d1 === n) {
					seen.deleteTail++;
				} else {
					m.first = NaN;
					seen.deleteMiddle++;
				}
				for (const time of m.time.slice(d0, d1)) m.source.delete(time);
				m.time.splice(d0, d1 - d0);
				m.values.forEach(column => column.splice(d0, d1 - d0));
				return;
			}
		}
	};

	let alignedVersion = -1;
	let aligned = new Map<number, Float64Array[]>();
	const levelMemo = new Map<string, Float64Array[]>();

	const check = (event: EngineEvent, what: string, ops: Op[]): string | null => {
		cache.apply(event, columns);
		// The command's own operations take effect first, unless they wait; then the ones that waited.
		const held = new Set(event.waiting ?? []);
		ops.forEach((op, i) => {
			if (held.has(i)) waiting.set(`${event.ack}:${i}`, op);
			else applyOp(op);
		});
		const applied = event.applied ?? [];
		for (let i = 0; i < applied.length; i += 2) {
			const key = `${applied[i]}:${applied[i + 1]}`;
			const op = waiting.get(key);
			if (op === undefined) return `${what}: applied ${key}, which was not waiting`;
			waiting.delete(key);
			if (op.type === 'tick' && op.time < (op.model.time.at(-1) ?? -Infinity)) seen.correctionWaited++;
			if (op.type === 'delete') seen.deleteWaited++;
			applyOp(op);
		}
		const refused = event.refused ?? [];
		for (let i = 0; i < refused.length; i += 2) {
			// A correction that waited for its bar, which an operation made after it removed meanwhile.
			const key = `${refused[i]}:${refused[i + 1]}`;
			if (!waiting.delete(key)) return `${what}: refused ${key}, which was not waiting`;
			seen.correctionRefused++;
		}
		for (const id of event.cancel ?? []) {
			const out = requests.get(id);
			if (out !== undefined && !out.cancelled) {
				out.cancelled = true;
				seen.cancelled++;
			}
		}
		for (const request of event.fetch ?? []) {
			const m = byId(request.series);
			if (m === undefined) return `${what}: request for series ${request.series}, which is gone`;
			if (!m.fetchable) return `${what}: request for series ${m.id}, which has no datafeed`;
			for (const out of requests.values()) {
				if (
					!out.cancelled &&
					out.request.series === request.series &&
					request.from <= out.request.to &&
					request.to >= out.request.from
				) {
					return `${what}: asked again for ${request.from}..${request.to} while ${out.request.from}..${out.request.to} is out`;
				}
			}
			const lo = lowerBound(m.time, request.from);
			const hi = lowerBound(m.time, request.to) + 1;
			if (m.time[lo] !== request.from || m.time[hi - 1] !== request.to || hi - lo !== request.end - request.start) {
				return `${what}: request ${request.start}..${request.end} has times ${request.from}..${request.to}`;
			}
			if (m !== mainOf()) seen.secondaryEvicted++;
			requests.set(request.id, { request, due: 1 + Math.floor(r() * 5), cancelled: false });
		}
		const main = mainOf();
		const end = main === null ? 0 : main.time.length;
		if (main !== null && event.first === 0 && event.end === 0 && end > 0) {
			// No main timeline while another series fetches rows its levels need.
			if (!takeover) seen.takeover++;
			takeover = true;
			return null;
		}
		takeover = false;
		if (main === null) {
			return event.end - event.first === 0 ? null : `${what}: extent ${event.first},${event.end} without data`;
		}
		if (main.first !== main.first || event.end - event.first !== end) {
			// After a deletion in the middle, the bars on one side moved; any other change is wrong.
			if (event.end - event.first !== end) return `${what}: extent ${event.first},${event.end} for ${end} bars`;
		}
		if (main.first === main.first && event.first !== main.first) {
			return `${what}: extent ${event.first},${event.end} expected ${main.first},${main.first + end}`;
		}
		main.first = event.first;
		if (!core.busy) {
			const memory = core.memory;
			if (memory.bytes > memory.limit && memory.evictable > 0) {
				return `${what}: ${memory.bytes} bytes over the limit ${memory.limit} with ${memory.evictable} that could go`;
			}
		}
		if (alignedVersion !== version) {
			aligned = align(main, live());
			alignedVersion = version;
			levelMemo.clear();
		}
		for (let level = 0; level <= levelCount(end); level++) {
			const window = cache.held(level);
			if (window === null || window.stale) continue;
			const shift = levelShift(level);
			const size = 2 ** shift;
			const levelStart = Math.floor(main.first / size);
			for (let k = 0; k < window.count; k++) {
				const b = window.start + k;
				const lo = Math.max(b * size, main.first) - main.first;
				const hi = Math.min((b + 1) * size, main.first + end) - main.first;
				if (lo < 0 || hi > end || hi <= lo) return `${what}: level ${level} item ${b} outside the data`;
				if (window.time[k] !== main.time[lo]) return `${what}: level ${level} time at ${b}`;
			}
			for (const m of live()) {
				const got = window.blocks.get(m.id);
				if (got === undefined) continue;
				let want: Float64Array[];
				if (level === 0) {
					want = aligned.get(m.id)!;
				} else {
					const key = `${m.id}:${level}`;
					let memo = levelMemo.get(key);
					if (memo === undefined) {
						memo = bucketsOf(m.kind, aligned.get(m.id)!, main.first, end, shift);
						levelMemo.set(key, memo);
					}
					want = memo;
				}
				const offset = level === 0 ? main.first : levelStart;
				for (let k = 0; k < window.count; k++) {
					const at = window.start + k - offset;
					for (let c = 0; c < want.length; c++) {
						const g = got[c * window.capacity + k]!;
						if (!same(g, want[c]![at]!)) {
							return `${what}: level ${level} series ${m.id} col ${c} at ${window.start + k} = ${g} expected ${want[c]![at]}`;
						}
					}
				}
			}
		}
		return null;
	};

	/** Answers one fetch request: the source's bars, a failure, or bars that do not match. */
	const answer = (id: number, outcome: 'good' | 'fail' | 'bad'): { event: EngineEvent; what: string } => {
		const out = requests.get(id)!;
		requests.delete(id);
		const { request } = out;
		const m = byId(request.series);
		let data: Float64Array | null = null;
		let count = 0;
		if (outcome !== 'fail' && m !== undefined) {
			const lo = lowerBound(m.time, request.from);
			let hi = lowerBound(m.time, request.to);
			if (hi < m.time.length && m.time[hi] === request.to) hi++;
			let time = m.time.slice(lo, hi);
			let values = m.values.map(column => column.slice(lo, hi));
			time.forEach((t, k) => {
				const source = m.source.get(t);
				if (source !== undefined) values.forEach((column, c) => (column[k] = source[c]!));
			});
			// The source has usually removed bars a deletion that still waits removes.
			if (r() < 0.6) {
				const removed = (t: number): boolean =>
					[...waiting.values()].some(op => op.model === m && op.type === 'delete' && t >= op.from && t <= op.to);
				const kept = time.map((t, k) => (removed(t) ? -1 : k)).filter(k => k >= 0);
				if (kept.length < time.length) {
					seen.sourceRemoved++;
					time = kept.map(k => time[k]!);
					values = values.map(column => kept.map(k => column[k]!));
				}
			}
			// A request for bars deletions remove is checked by the times kept, every 16th bar: a time
			// slightly off elsewhere would pass (see `FetchRequest.removing`), so it only gets a bar short.
			if (outcome === 'bad' && request.removing !== undefined && time.length > 1) {
				time.splice(0, 1);
				values.forEach(column => column.splice(0, 1));
			} else if (outcome === 'bad' && time.length > 1) {
				if (r() < 0.5) time[Math.floor(r() * time.length)]! += 0.5;
				else {
					time.pop();
					values.forEach(column => column.pop());
				}
			}
			data = block(time, values);
			count = time.length;
		}
		// Bars the engine still holds keep its values (a deletion's request can span a chunk it holds):
		// only those of chunks it let go take the source's values.
		const store = (
			core as unknown as {
				_series: Map<number, { store: { first: number; end: number; isEvicted(grid: number): boolean } }>;
			}
		)._series.get(request.series)?.store;
		const wasLetGo = new Set<number>();
		if (m !== undefined && m === mainOf() && store !== undefined && store.end - store.first === m.time.length) {
			for (let k = lowerBound(m.time, request.from); k < m.time.length && m.time[k]! <= request.to; k++) {
				if (store.isEvicted((store.first + k) >> 13)) wasLetGo.add(k);
			}
		}
		const event = exec({ type: 'rows', request: id, count, data });
		const what = `answer ${request.series}:${request.from} ${outcome}${out.cancelled ? ' late' : ''}`;
		const result = event.restored!;
		if (out.cancelled) {
			seen.lateAfterCancel++;
		} else if (result.expected > 0) {
			seen[result.outcome]++;
			if (result.outcome === 'restored' && m !== undefined && m === mainOf()) {
				// Values that changed at the source while the bars were let go come back with them.
				const lo = lowerBound(m.time, request.from);
				for (let k = lo; k < m.time.length && m.time[k]! <= request.to; k++) {
					const source = m.source.get(m.time[k]!);
					if (source !== undefined && wasLetGo.has(k)) {
						m.values.forEach((column, c) => (column[k] = source[c]!));
						m.source.delete(m.time[k]!);
						version++;
						seen.sourceChange++;
					}
				}
			}
		}
		return { event, what };
	};

	const addSeries = (fetchable: boolean): Model => {
		const kind: Kind = r() < 0.5 ? 'line' : 'ohlcv';
		const values = Array.from({ length: valueColumns(kind) }, (): number[] => []);
		const m: Model = { id: nextId++, kind, fetchable, time: [], values, first: 0, source: new Map() };
		models.push(m);
		version++;
		exec({ type: 'add', series: m.id, kind, fetchable });
		return m;
	};

	// Two or three series: the first always with a datafeed, the others with or without one.
	const seriesCount = 2 + Math.floor(r() * 2);
	for (let i = 0; i < seriesCount; i++) addSeries(i === 0 || r() < 0.6);
	const t0 = 1_000_000;
	for (const m of models) {
		const count =
			m === models[0]
				? CHUNK_ROWS * (4 + Math.floor(r() * 4)) + Math.floor(r() * CHUNK_ROWS)
				: CHUNK_ROWS * (2 + Math.floor(r() * 4));
		const start = m === models[0] ? t0 : t0 + Math.floor((r() - 0.3) * CHUNK_ROWS * 4);
		const h = history(m.kind, count, start, m === models[0] ? 3 : 1 + Math.floor(r() * 6));
		const event = exec({ type: 'set', series: m.id, count, data: block(h.time, h.values) });
		const failure = check(event, `set ${m.id}`, [{ type: 'set', model: m, ...h, fetchable: undefined }]);
		if (failure !== null) return `seed ${seed}: ${failure}`;
	}
	while (core.backgroundStep());
	const limit = Math.floor(core.byteLength * (0.25 + r() * 0.35));
	check(exec({ type: 'limit', bytes: limit }), 'limit', []);

	for (let step = 0; step < steps; step++) {
		for (const out of requests.values()) out.due--;
		const due = [...requests.keys()].filter(id => requests.get(id)!.due <= 0);
		const main = mainOf();
		// Changes at the source are modeled for the main series only (see `answer`).
		for (const m of models) if (m !== main) m.source.clear();
		const withData = models.filter(m => m.time.length > 0);
		let what = '';
		let event: EngineEvent;
		let ops: Op[] = [];
		const p = r();
		if (due.length > 0 && r() < 0.5) {
			const roll = r();
			const outcome = roll < 0.72 ? 'good' : roll < 0.88 ? 'fail' : 'bad';
			const answered = answer(due[Math.floor(r() * due.length)]!, outcome);
			event = answered.event;
			what = answered.what;
		} else if (p < 0.02 && models.length > 1) {
			// A series goes; later a new one may come. Removing the main hands the timeline to another.
			const m = models[Math.floor(r() * models.length)]!;
			what = `remove ${m.id}`;
			models.splice(models.indexOf(m), 1);
			for (const [key, op] of waiting) if (op.model === m) waiting.delete(key);
			version++;
			event = exec({ type: 'remove', series: m.id });
		} else if (p < 0.035 && models.length < 3) {
			const m = addSeries(r() < 0.6);
			const count = CHUNK_ROWS * (1 + Math.floor(r() * 3));
			const anchor = main?.time[Math.floor(r() * main.time.length)] ?? t0;
			const h = history(m.kind, count, anchor - Math.floor(r() * CHUNK_ROWS), 1 + Math.floor(r() * 4));
			what = `add ${m.id} ${count}`;
			ops = [{ type: 'set', model: m, ...h, fetchable: undefined }];
			event = exec({ type: 'set', series: m.id, count, data: block(h.time, h.values) });
		} else if (p < 0.07 && withData.length > 0) {
			// A new history, as at another resolution, with or without a datafeed from now on.
			const m = withData[Math.floor(r() * withData.length)]!;
			const count = CHUNK_ROWS * (2 + Math.floor(r() * 4)) + Math.floor(r() * 1000);
			const h = history(m.kind, count, m.time[0]! + Math.floor((r() - 0.5) * 1000), 1 + Math.floor(r() * 5));
			const fetchable = r() < 0.3 ? !m.fetchable : undefined;
			for (const [key, op] of waiting) if (op.model === m) waiting.delete(key);
			what = `reload ${m.id} ${count}${fetchable === undefined ? '' : ` fetchable ${fetchable}`}`;
			seen.reload++;
			ops = [{ type: 'set', model: m, ...h, fetchable }];
			event = exec({
				type: 'set',
				series: m.id,
				count,
				data: block(h.time, h.values),
				...(fetchable === undefined ? {} : { fetchable }),
			});
		} else if (p < 0.13 && withData.length > 0) {
			const m = withData[Math.floor(r() * withData.length)]!;
			const n = 1 + Math.floor(r() * (r() < 0.2 ? 2 * CHUNK_ROWS : 400));
			const h = history(m.kind, n, 0, 3);
			// Older than every bar the series has once the operations still waiting have run.
			let oldest = m.time[0]!;
			for (const op of waiting.values()) {
				if (op.model === m && (op.type === 'prepend' || op.type === 'set') && op.time.length > 0) {
					oldest = Math.min(oldest, op.time[0]!);
				}
			}
			const shiftBy = oldest - h.time[n - 1]! - 1;
			h.time = h.time.map(t => t + shiftBy);
			what = `prepend ${m.id} ${n}`;
			ops = [{ type: 'prepend', model: m, ...h }];
			event = exec({ type: 'prepend', series: m.id, count: n, data: block(h.time, h.values) });
		} else if (p < 0.2 && withData.length > 0) {
			// Bars removed at either end or in the middle, or none at all between two bars.
			const m = withData[Math.floor(r() * withData.length)]!;
			const n = m.time.length;
			const span = 1 + Math.floor(r() * (r() < 0.3 ? CHUNK_ROWS * 1.5 : 50));
			const roll = r();
			let from: number;
			let to: number;
			if (roll < 0.25) {
				from = m.time[0]! - 5;
				to = m.time[Math.min(n - 1, span)]!;
			} else if (roll < 0.5) {
				from = m.time[Math.max(0, n - 1 - span)]!;
				to = m.time[n - 1]! + 5;
			} else if (roll < 0.9) {
				const a = Math.floor(r() * n);
				from = m.time[a]!;
				to = m.time[Math.min(n - 1, a + span)]!;
			} else {
				const a = Math.floor(r() * (n - 1));
				from = m.time[a]! + 0.25;
				to = from + 0.5;
			}
			if (r() < 0.02 && n < 3 * CHUNK_ROWS) {
				from = -Infinity;
				to = Infinity;
			}
			what = `delete ${m.id} ${from}..${to}`;
			ops = [{ type: 'delete', model: m, from, to }];
			event = exec({ type: 'delete', series: m.id, from, to });
		} else if (p < 0.24 && main !== null && main.fetchable) {
			// Bars change at the source; the chart sees them once it fetches them again.
			for (let k = 0; k < 1 + Math.floor(r() * 20); k++) {
				const at = main.time[Math.floor(r() * main.time.length)]!;
				main.source.set(at, row(main.kind));
			}
			what = 'source changes';
			event = exec({ type: 'window', level: 1, start: 0, count: 0, capacity: 0 });
		} else if (p < 0.55 && withData.length > 0) {
			// Ticks on the last bar or new ones, and corrections of older bars, also of bars let go.
			const batch: number[][] = [];
			const nt = 1 + Math.floor(r() * 4);
			for (let k = 0; k < nt; k++) {
				const m = withData[Math.floor(r() * withData.length)]!;
				const values = row(m.kind);
				const last = m.time.at(-1)!;
				const roll = r();
				let time: number;
				if (roll < 0.35) time = last;
				else if (roll < 0.6) time = last + 1 + Math.floor(r() * 3) + k * 4;
				else if (roll < 0.95) time = m.time[Math.floor(r() * (m.time.length - 1))]!;
				else time = m.time[Math.floor(r() * (m.time.length - 1))]! + 0.5;
				batch.push([m.id, time, ...values, ...Array.from({ length: 5 - values.length }, () => NaN)]);
				ops.push({ type: 'tick', model: m, time, values });
				if (time < last && m === main && m.time[lowerBound(m.time, time)] === time) {
					// The source has the correction too.
					m.source.set(time, values);
				}
			}
			const data = new Float64Array(batch.length * 7).fill(NaN);
			batch.forEach((entry, i) => data.set(entry, i * 7));
			what = `ticks ${batch.map(entry => `${entry[0]}@${entry[1]}`).join(',')}`;
			event = exec({ type: 'ticks', count: batch.length, data });
		} else if (main !== null) {
			const length = main.time.length;
			const level = Math.floor(r() * (levelCount(length) + 1));
			const size = 2 ** levelShift(level);
			const lo = Math.floor(main.first / size);
			const span = Math.ceil(length / size);
			const start = lo + Math.floor(r() * span);
			const count = 1 + Math.floor(r() * Math.min(span, 3000));
			what = `window L${level} ${start}+${count}`;
			event = exec({ type: 'window', level, start, count, capacity: count + 16 });
			if (level === 0 && event.window === undefined) seen.deferred++;
		} else {
			continue;
		}
		log.push(what);
		if (r() < 0.3) for (let k = Math.floor(r() * 4); k > 0 && core.backgroundStep(); k--);
		const failure = check(event, what, ops);
		if (failure !== null) return `seed ${seed} step ${step}: ${failure}\nlast ops:\n${log.slice(-10).join('\n')}`;
	}

	// Every answer arrives: then nothing waits, no request is left, and every bar let go comes back.
	for (let round = 0; round < 400; round++) {
		const open = [...requests.entries()].filter(([, out]) => !out.cancelled).map(([id]) => id);
		for (const [id, out] of requests) if (out.cancelled) requests.delete(id);
		if (open.length === 0) break;
		const { event, what } = answer(open[0]!, 'good');
		const failure = check(event, `drain ${what}`, []);
		if (failure !== null) return `seed ${seed}: ${failure}\nlast ops:\n${log.slice(-10).join('\n')}`;
	}
	const memory = core.memory;
	if (memory.requests !== 0 || memory.waiting !== 0 || waiting.size !== 0) {
		return `seed ${seed}: ${memory.requests} requests and ${memory.waiting} operations (${waiting.size} in the model) left after every answer`;
	}
	const main = mainOf();
	if (main === null) return null;
	const all = main.time.length;
	let event = exec({ type: 'window', level: 0, start: main.first, count: all, capacity: all });
	let failure = check(event, 'all rows', []);
	for (let round = 0; failure === null && round < 400 && requests.size > 0; round++) {
		const { event: answered, what } = answer([...requests.keys()][0]!, 'good');
		event = answered;
		failure = check(event, `all rows ${what}`, []);
	}
	if (failure !== null) return `seed ${seed}: ${failure}`;
	const raw = cache.held(0);
	if (raw === null || raw.start !== main.first || raw.count !== all) {
		return `seed ${seed}: the full raw window did not come back (${raw?.start}+${raw?.count})`;
	}
	return null;
}

/**
 * Several series, the first with a datafeed and the others with or without one, under a memory limit,
 * driven through the real engine and window cache with a fake datafeed whose answers come late, in
 * any order, fail, do not match, or arrive after the request was cancelled. Bars are corrected (also
 * bars let go), removed at either end or in the middle, replaced by a new history (as at another
 * resolution), changed at the source, and series come and go. After every event: every row and
 * bucket the cache holds equals the model (operations that wait take effect when the engine says
 * so), no rows are asked for twice, and the engine is within its limit unless nothing more can go.
 * At the end no request or waiting operation is left, and every bar let go comes back.
 */
describe('memory limit with datafeeds against a model', () => {
	it('never shows a wrong row, never leaks a request and stays within the limit', () => {
		const failures: string[] = [];
		for (let seed = 1; seed <= 14 && failures.length < 3; seed++) {
			const failure = runOne(seed, 140);
			if (failure !== null) failures.push(failure);
		}
		expect(failures).toEqual([]);
		// Every path was taken.
		expect(Object.entries(seen).filter(([, count]) => count === 0)).toEqual([]);
	}, 240_000);
});
