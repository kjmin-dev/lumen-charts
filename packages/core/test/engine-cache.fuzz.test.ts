import { type Command, EngineCore, type EngineEvent, levelCount, levelShift } from '@lumen-charts/engine';
import { describe, expect, it } from 'vitest';
import { WindowCache } from '../src/data/window-cache';

type Kind = 'ohlcv' | 'line';
interface MSeries {
	id: number;
	kind: Kind;
	t: number[];
	v: number[][];
	first: number;
}

function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const cols = (k: Kind) => (k === 'ohlcv' ? 5 : 1);
const same = (a: number, b: number) => (a !== a && b !== b) || a === b;

class Model {
	series: MSeries[] = [];
	main(): MSeries | null {
		return this.series.find(s => s.t.length > 0) ?? null;
	}
	get(id: number) {
		return this.series.find(s => s.id === id);
	}
	/** Expected values of series s at main index i. */
	at(s: MSeries, i: number): number[] {
		const m = this.main()!;
		const k = i - m.first;
		if (s === m) {
			return s.v.map(c => c[k]!);
		}
		const lo = m.t[k]!;
		const hi = k + 1 < m.t.length ? m.t[k + 1]! : Infinity;
		const idx: number[] = [];
		let a = 0;
		let b = s.t.length;
		while (a < b) {
			const mid = (a + b) >> 1;
			if (s.t[mid]! < lo) a = mid + 1;
			else b = mid;
		}
		for (let j = a; j < s.t.length && s.t[j]! < hi; j++) idx.push(j);
		const n = cols(s.kind);
		if (idx.length === 0) return Array.from({ length: n }, () => NaN);
		if (s.kind === 'line') {
			let last = NaN;
			for (const j of idx) {
				const x = s.v[0]![j]!;
				if (x === x) last = x;
			}
			return [last];
		}
		let open = NaN;
		let high = NaN;
		let low = NaN;
		let close = NaN;
		let vol = NaN;
		for (const j of idx) {
			const o = s.v[0]![j]!;
			const h = s.v[1]![j]!;
			const l = s.v[2]![j]!;
			const c = s.v[3]![j]!;
			const v = s.v[4]![j]!;
			if (Number.isNaN(open)) open = o;
			if (!Number.isNaN(h) && !(h <= high)) high = h;
			if (!Number.isNaN(l) && !(l >= low)) low = l;
			if (!Number.isNaN(c)) close = c;
			if (!Number.isNaN(v)) vol = Number.isNaN(vol) ? v : vol + v;
		}
		return [open, high, low, close, vol];
	}
}

/**
 * Values of every series on the main timeline, rows `[m.first, m.first + m.t.length)`, computed by
 * walking each series' times next to the main times once.
 */
function alignAll(model: Model): Map<number, number[][]> {
	const m = model.main()!;
	const out = new Map<number, number[][]>();
	for (const s of model.series) {
		if (s === m) {
			out.set(s.id, s.v);
			continue;
		}
		const n = cols(s.kind);
		const columns: number[][] = Array.from({ length: n }, () => Array.from({ length: m.t.length }, () => NaN));
		let j = 0;
		while (j < s.t.length && s.t[j]! < m.t[0]!) j++;
		for (let k = 0; k < m.t.length && j < s.t.length; k++) {
			const hi = k + 1 < m.t.length ? m.t[k + 1]! : Infinity;
			if (s.t[j]! >= hi) continue;
			let open = NaN;
			let high = NaN;
			let low = NaN;
			let close = NaN;
			let vol = NaN;
			for (; j < s.t.length && s.t[j]! < hi; j++) {
				if (s.kind === 'line') {
					const x = s.v[0]![j]!;
					if (x === x) close = x;
					continue;
				}
				const o = s.v[0]![j]!;
				const h = s.v[1]![j]!;
				const l = s.v[2]![j]!;
				const c = s.v[3]![j]!;
				const v = s.v[4]![j]!;
				if (Number.isNaN(open)) open = o;
				if (!Number.isNaN(h) && !(h <= high)) high = h;
				if (!Number.isNaN(l) && !(l >= low)) low = l;
				if (!Number.isNaN(c)) close = c;
				if (!Number.isNaN(v)) vol = Number.isNaN(vol) ? v : vol + v;
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

/** Brute-force bucket of a level: first / highest / lowest / last of the non-missing members. */
function bucketOf(kind: Kind, values: number[][], lo: number, hi: number): number[] {
	const pick = (c: number, how: 'first' | 'max' | 'min' | 'last'): number => {
		let result = NaN;
		for (let i = lo; i < hi; i++) {
			const x = values[c]![i]!;
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

function genTimes(r: () => number, n: number, start: number): number[] {
	const out: number[] = [];
	let t = start;
	for (let i = 0; i < n; i++) {
		t += 1 + Math.floor(r() * 3);
		out.push(t);
	}
	return out;
}

function value(r: () => number) {
	return r() < 0.05 ? NaN : Math.round(r() * 1000) / 10;
}

function runOne(seed: number, steps: number): string | null {
	const r = rng(seed);
	const core = new EngineCore();
	const cache = new WindowCache();
	const model = new Model();
	let seq = 0;
	let nextId = 1;
	const log: string[] = [];
	const exec = (body: Omit<Command, 'seq'> & { type: string }): EngineEvent => {
		const g = core.run({ ...body, seq: ++seq } as Command);
		let st = g.next();
		while (st.done !== true) st = g.next();
		return st.value;
	};
	const columnCount = (id: number, level: number) => {
		const s = model.get(id);
		return s ? (level === 0 ? cols(s.kind) : s.kind === 'line' ? 4 : 5) : 1;
	};
	const check = (ev: EngineEvent, what: string): string | null => {
		cache.apply(ev, columnCount);
		const m = model.main();
		const ef = m ? m.first : 0;
		const ee = m ? m.first + m.t.length : 0;
		if (ev.first !== ef || ev.end !== ee) return `${what}: extent ${ev.first},${ev.end} expected ${ef},${ee}`;
		if (m === null) return null;
		let aligned: Map<number, number[][]> | null = null;
		for (let level = 0; level <= levelCount(m.t.length) + 1; level++) {
			const window = cache.held(level);
			if (window === null || window.stale) continue;
			aligned ??= alignAll(model);
			const size = 2 ** levelShift(level);
			const firstBucket = Math.floor(m.first / size);
			const lastBucket = Math.floor((ee - 1) / size);
			for (let row = 0; row < window.count; row++) {
				const b = window.start + row;
				if (b < firstBucket || b > lastBucket) return `${what}: level ${level} item ${b} outside extent`;
				const lo = Math.max(b * size, m.first) - m.first;
				const hi = Math.min((b + 1) * size, ee) - m.first;
				if (window.time[row] !== m.t[lo])
					return `${what}: level ${level} time at ${b} = ${window.time[row]} expected ${m.t[lo]}`;
				for (const s of model.series) {
					const block = window.blocks.get(s.id);
					const values = aligned.get(s.id)!;
					const exp = level === 0 ? values.map(column => column[lo]!) : bucketOf(s.kind, values, lo, hi);
					if (block === undefined) {
						if (exp.some(x => x === x)) return `${what}: level ${level} series ${s.id} has no block but value at ${b}`;
						continue;
					}
					for (let c = 0; c < exp.length; c++) {
						const got = block[c * window.capacity + row]!;
						if (!same(got, exp[c]!)) {
							return `${what}: level ${level} series ${s.id}(${s.kind}) col ${c} at ${b} = ${got} expected ${exp[c]} (window ${window.start}+${window.count}/${window.capacity})`;
						}
					}
				}
			}
		}
		return null;
	};

	for (let step = 0; step < steps; step++) {
		const p = r();
		let ev: EngineEvent;
		let what: string;
		if (model.series.length === 0 || (p < 0.06 && model.series.length < 4)) {
			const kind: Kind = r() < 0.5 ? 'ohlcv' : 'line';
			const id = nextId++;
			model.series.push({ id, kind, t: [], v: Array.from({ length: cols(kind) }, () => []), first: 0 });
			what = `add ${id} ${kind}`;
			ev = exec({ type: 'add', series: id, kind } as never);
		} else if (p < 0.09 && model.series.length > 1) {
			const s = model.series[Math.floor(r() * model.series.length)]!;
			model.series = model.series.filter(x => x !== s);
			what = `remove ${s.id}`;
			ev = exec({ type: 'remove', series: s.id } as never);
		} else if (p < 0.2) {
			const s = model.series[Math.floor(r() * model.series.length)]!;
			const big = r() < 0.15;
			const n = big ? 8000 + Math.floor(r() * 12000) : Math.floor(r() * 200);
			const times = genTimes(r, n, Math.floor(r() * 300));
			const n2 = n;
			const data = new Float64Array(n2 * (cols(s.kind) + 1));
			const vals: number[][] = Array.from({ length: cols(s.kind) }, () => []);
			for (let i = 0; i < n2; i++) {
				data[i] = times[i]!;
				for (let c = 0; c < cols(s.kind); c++) {
					const v = value(r);
					data[(c + 1) * n2 + i] = v;
					vals[c]!.push(v);
				}
			}
			// engine accepts the increasing prefix (always all here)
			s.t = times.slice();
			s.v = vals;
			s.first = 0;
			what = `set ${s.id} n=${n}`;
			ev = exec({ type: 'set', series: s.id, count: n2, data } as never);
		} else if (p < 0.3) {
			const s = model.series[Math.floor(r() * model.series.length)]!;
			if (s.t.length === 0) continue;
			const big = r() < 0.15;
			const n = 1 + (big ? 8000 + Math.floor(r() * 9000) : Math.floor(r() * 300));
			const firstT = s.t[0]!;
			// times strictly below firstT
			const times: number[] = [];
			let t = firstT;
			for (let i = 0; i < n; i++) {
				t -= 1 + Math.floor(r() * 3);
				times.unshift(t);
			}
			const data = new Float64Array(n * (cols(s.kind) + 1));
			const vals: number[][] = Array.from({ length: cols(s.kind) }, () => []);
			for (let i = 0; i < n; i++) {
				data[i] = times[i]!;
				for (let c = 0; c < cols(s.kind); c++) {
					const v = value(r);
					data[(c + 1) * n + i] = v;
					vals[c]!.push(v);
				}
			}
			s.t = times.concat(s.t);
			s.v = s.v.map((col, c) => vals[c]!.concat(col));
			s.first -= n;
			what = `prepend ${s.id} n=${n}`;
			ev = exec({ type: 'prepend', series: s.id, count: n, data } as never);
		} else if (p < 0.75) {
			const nt = 1 + Math.floor(r() * 6);
			const data = new Float64Array(nt * 7).fill(NaN);
			const descr: string[] = [];
			for (let k = 0; k < nt; k++) {
				const s = model.series[Math.floor(r() * model.series.length)]!;
				const q = r();
				let time: number;
				if (s.t.length === 0) {
					time = Math.floor(r() * 1000);
				} else if (q < 0.4) {
					time = s.t[s.t.length - 1]!;
				} else if (q < 0.7) {
					time = s.t[s.t.length - 1]! + 1 + Math.floor(r() * 3);
				} else if (q < 0.85) {
					time = s.t[Math.floor(r() * s.t.length)]!;
				} else {
					time = s.t[0]! + Math.floor(r() * (s.t[s.t.length - 1]! - s.t[0]! + 1)); // maybe invalid
				}
				const vs: number[] = [];
				for (let c = 0; c < cols(s.kind); c++) vs.push(value(r));
				data[k * 7] = s.id;
				data[k * 7 + 1] = time;
				for (let c = 0; c < 5; c++) data[k * 7 + 2 + c] = c < vs.length ? vs[c]! : NaN;
				// model
				if (s.t.length === 0 || time > s.t[s.t.length - 1]!) {
					s.t.push(time);
					s.v.forEach((col, c) => col.push(vs[c]!));
				} else {
					const j = s.t.indexOf(time);
					if (j >= 0) s.v.forEach((col, c) => (col[j] = vs[c]!));
				}
				descr.push(`${s.id}@${time}`);
			}
			what = `ticks ${descr.join(',')}`;
			ev = exec({ type: 'ticks', count: nt, data } as never);
		} else {
			const m = model.main();
			const f = m ? m.first : 0;
			const e = m ? m.first + m.t.length : 0;
			// Every level the timeline has, and now and then one it does not have (yet).
			const level = Math.floor(r() * (levelCount(Math.max(0, e - f)) + 2));
			const size = 2 ** levelShift(level);
			const lo = Math.floor(f / size);
			const span = Math.max(1, Math.ceil((e - f) / size));
			const start = lo + Math.floor(r() * span) - Math.ceil(50 / size);
			const count = 1 + Math.floor(r() * Math.min(span + 100, 3000));
			const capacity = count + (r() < 0.5 ? Math.floor(r() * 100) : 0);
			what = `window L${level} ${start}+${count}/${capacity}`;
			ev = exec({ type: 'window', level, start, count, capacity } as never);
		}
		log.push(what);
		if (r() < 0.3) {
			// Between commands a host runs slices of the background build.
			for (let k = Math.floor(r() * 4); k > 0 && core.backgroundStep(); k--);
		}
		const err = check(ev, what);
		if (err !== null) {
			return `seed ${seed} step ${step}: ${err}\nlast ops:\n${log.slice(-8).join('\n')}`;
		}
	}
	return null;
}

/**
 * Random sequences of setData, prepend, ticks, removals and window requests at every level of
 * detail go through the real engine and the real window cache, with slices of the engine's
 * background build in between. After every event, each cached row or bucket the cache does not report as
 * stale is compared with a straightforward model of what the engine should hold.
 */
describe('engine and window cache against a model', () => {
	it('never shows a row that differs from the model', () => {
		const failures: string[] = [];
		for (let seed = 1; seed <= 40 && failures.length < 3; seed++) {
			const failure = runOne(seed, 150);
			if (failure !== null) {
				failures.push(failure);
			}
		}
		expect(failures).toEqual([]);
	}, 120_000);
});
