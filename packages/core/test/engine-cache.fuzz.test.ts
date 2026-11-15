import { type Command, EngineCore, type EngineEvent } from '@lumen-charts/engine';
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
	const valueCols = (id: number) => {
		const s = model.get(id);
		return s ? cols(s.kind) : 1;
	};
	const check = (ev: EngineEvent, what: string): string | null => {
		cache.apply(ev, valueCols);
		const m = model.main();
		const ef = m ? m.first : 0;
		const ee = m ? m.first + m.t.length : 0;
		if (ev.first !== ef || ev.end !== ee) return `${what}: extent ${ev.first},${ev.end} expected ${ef},${ee}`;
		if ((cache as unknown as { _stale: boolean })._stale || m === null) return null;
		for (let row = 0; row < cache.count; row++) {
			const i = cache.start + row;
			if (i < m.first || i >= m.first + m.t.length) return `${what}: cache row ${i} outside extent`;
			if (cache.time[row] !== m.t[i - m.first])
				return `${what}: time at ${i} = ${cache.time[row]} expected ${m.t[i - m.first]}`;
			for (const s of model.series) {
				const block = cache.blocks.get(s.id);
				const exp = model.at(s, i);
				if (block === undefined) {
					if (exp.some(x => x === x)) return `${what}: series ${s.id} has no block but value at ${i}`;
					continue;
				}
				for (let c = 0; c < exp.length; c++) {
					const got = block[c * cache.capacity + row]!;
					if (!same(got, exp[c]!)) {
						return `${what}: series ${s.id}(${s.kind}) col ${c} at index ${i} = ${got} expected ${exp[c]} (cache ${cache.start}+${cache.count}/${cache.capacity})`;
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
			const span = Math.max(1, e - f);
			const start = f + Math.floor(r() * span) - 50;
			const count = 1 + Math.floor(r() * Math.min(span + 100, 3000));
			const capacity = count + (r() < 0.5 ? Math.floor(r() * 100) : 0);
			what = `window ${start}+${count}/${capacity}`;
			ev = exec({ type: 'window', start, count, capacity } as never);
		}
		log.push(what);
		const err = check(ev, what);
		if (err !== null) {
			return `seed ${seed} step ${step}: ${err}\nlast ops:\n${log.slice(-8).join('\n')}`;
		}
	}
	return null;
}

/**
 * Random sequences of setData, prepend, ticks, removals and window requests go through the real
 * engine and the real window cache. After every event, each cached row the cache does not report as
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
