import {
	CHUNK_ROWS,
	type Command,
	EngineCore,
	type EngineEvent,
	type IndicatorDefinition,
	bollinger,
	computeIndicator,
	ema,
	highest,
	levelCount,
	levelShift,
	macd,
	resolveParams,
	rsi,
	sma,
	stochastic,
	wma,
} from '@lumen-charts/engine';
import { describe, expect, it } from 'vitest';
import { WindowCache } from '../src/data/window-cache';

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

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const MAIN = 1;
const MIN = 60_000;
const same = (a: number, b: number): boolean => Object.is(a, b) || (a !== a && b !== b);

interface Spec {
	definition: IndicatorDefinition;
	values: Record<string, number>;
	/** Main-series column per input, or the index of an earlier spec whose first output it reads. */
	inputs: (number | { from: number })[];
}

/** Model of the main series and the indicators on it. */
class Model {
	public first = 0;
	public columns: number[][] = [[], [], [], [], [], []];
	public specs: Spec[] = [];
	public ids: { id: number; outputs: number[] }[] = [];

	public get end(): number {
		return this.first + this.columns[0]!.length;
	}

	/** Expected outputs of every indicator, from scratch. */
	public expected(): Float64Array[][] {
		const results: Float64Array[][] = [];
		for (const spec of this.specs) {
			const inputs = spec.inputs.map(input =>
				typeof input === 'number' ? this.columns[input]! : results[input.from]![0]!,
			);
			results.push(
				computeIndicator(spec.definition, resolveParams(spec.definition.params, spec.values), inputs, this.first),
			);
		}
		return results;
	}
}

function bar(r: () => number, time: number, price: number): number[] {
	const missing = r() < 0.03;
	const next = price + (r() - 0.5) * 2;
	return [
		time,
		missing ? NaN : price,
		missing ? NaN : Math.max(price, next) + r(),
		missing ? NaN : Math.min(price, next) - r(),
		missing ? NaN : next,
		missing ? NaN : Math.round(r() * 100),
	];
}

function block(count: number, startTime: number, r: () => number): Float64Array {
	const data = new Float64Array(count * 6);
	let price = 100 + r() * 10;
	for (let i = 0; i < count; i++) {
		const row = bar(r, startTime + i * MIN, price);
		const close = row[4]!;
		if (close === close) {
			price = close;
		}
		for (let c = 0; c < 6; c++) {
			data[c * count + i] = row[c]!;
		}
	}
	return data;
}

function columnsOf(data: Float64Array, count: number): number[][] {
	return Array.from({ length: 6 }, (_, c) => Array.from(data.subarray(c * count, (c + 1) * count)));
}

function runOne(seed: number, steps: number): string | null {
	const r = rng(seed);
	const core = new EngineCore();
	const cache = new WindowCache();
	const model = new Model();
	let seq = 0;
	let nextId = 10;
	const exec = (body: DistributiveOmit<Command, 'seq'>): EngineEvent => {
		const generator = core.run({ ...body, seq: ++seq } as Command);
		let step = generator.next();
		while (step.done !== true) {
			step = generator.next();
		}
		return step.value;
	};
	const derived = new Set<number>();
	let compared = 0;
	const columnCount = (id: number, level: number): number =>
		derived.has(id) ? (level === 0 ? 1 : 4) : level === 0 ? 5 : 5;
	const apply = (event: EngineEvent): void => {
		cache.apply(event, columnCount);
	};
	const addIndicator = (spec: Spec): void => {
		const id = nextId++;
		const outputs = spec.definition.outputs.map(() => nextId++);
		for (const output of outputs) {
			derived.add(output);
		}
		model.specs.push(spec);
		model.ids.push({ id, outputs });
		exec_indicator(model.specs.length - 1, id, outputs);
	};
	const exec_indicator = (index: number, id: number, outputs: number[]): void => {
		const spec = model.specs[index]!;
		const inputs = spec.inputs.map(input =>
			typeof input === 'number'
				? { series: MAIN, column: input }
				: { series: model.ids[input.from]!.outputs[0]!, column: 0 },
		);
		apply(
			exec({
				type: 'indicator',
				id,
				name: spec.definition.name,
				params: Array.from(resolveParams(spec.definition.params, spec.values)),
				inputs,
				outputs,
			}),
		);
	};
	const background = (slices: number): void => {
		for (let i = 0; i < slices && core.backgroundStep(); i++) {
			// One slice of background work at a time, as a host runs it between commands.
		}
		const notice = core.takeNotice();
		if (notice !== null) {
			apply(notice);
		}
	};
	/** Requests a window of `level` over the visible range the way the chart plans one. */
	const view = (level: number, from: number, to: number): void => {
		const request = cache.plan(level, from, to, model.first, model.end);
		if (request !== null) {
			apply(exec({ type: 'window', ...request }));
		}
	};
	/** Compares every derived value the cache holds with the model, bit for bit. */
	const check = (what: string): string | null => {
		const expected = model.expected();
		for (let level = 0; level <= levelCount(model.end - model.first); level++) {
			const window = cache.held(level);
			if (window === null || window.stale) {
				continue;
			}
			const shift = levelShift(level);
			for (let i = 0; i < model.ids.length; i++) {
				for (let o = 0; o < model.ids[i]!.outputs.length; o++) {
					const data = window.blocks.get(model.ids[i]!.outputs[o]!);
					if (data === undefined) {
						return `${what}: level ${level} holds no block for indicator ${i}`;
					}
					const values = expected[i]![o]!;
					for (let k = 0; k < window.count; k++) {
						const item = window.start + k;
						let want: number[];
						if (level === 0) {
							want = [values[item - model.first]!];
						} else {
							const from = Math.max(item << shift, model.first) - model.first;
							const to = Math.min((item + 1) << shift, model.end) - model.first;
							const members = Array.from(values.subarray(from, to)).filter(v => v === v);
							want =
								members.length === 0
									? [NaN, NaN, NaN, NaN]
									: [members[0]!, Math.max(...members), Math.min(...members), members[members.length - 1]!];
						}
						compared++;
						for (let c = 0; c < want.length; c++) {
							const got = data[c * window.capacity + k]!;
							if (!same(got, want[c]!)) {
								return `${what}: level ${level} item ${item} of ${model.specs[i]!.definition.name}.${o} column ${c}: ${got} instead of ${want[c]}`;
							}
						}
					}
				}
			}
		}
		return null;
	};

	exec({ type: 'add', series: MAIN, kind: 'ohlcv' });
	const count = 500 + Math.floor(r() * CHUNK_ROWS * 1.5);
	const data = block(count, 10_000 * MIN, r);
	model.columns = columnsOf(data, count);
	apply(exec({ type: 'set', series: MAIN, count, data }));
	const pool: Spec[] = [
		{ definition: sma, values: { period: 1 + Math.floor(r() * 30) }, inputs: [4] },
		{ definition: ema, values: { period: 1 + Math.floor(r() * 30) }, inputs: [4] },
		{ definition: rsi, values: {}, inputs: [4] },
		{ definition: macd, values: {}, inputs: [4] },
		{ definition: bollinger, values: {}, inputs: [4] },
		{ definition: stochastic, values: { kPeriod: 5, kSmooth: 2, dPeriod: 3 }, inputs: [2, 3, 4] },
		{ definition: highest, values: { period: 1 + Math.floor(r() * 40) }, inputs: [2] },
		{ definition: wma, values: { period: 5 }, inputs: [1] },
	];
	for (const spec of pool) {
		if (r() < 0.6) {
			addIndicator(spec);
		}
	}
	// A chain: an average of an earlier indicator's first output.
	if (model.specs.length > 0) {
		addIndicator({ definition: sma, values: { period: 4 }, inputs: [{ from: Math.floor(r() * model.specs.length) }] });
	}
	background(Infinity);
	let level = 0;
	let center = model.end - 50;
	let span = 200;

	for (let step = 0; step < steps; step++) {
		const op = r();
		if (op < 0.4) {
			// A tick batch: updates of the last bar, new bars, now and then a correction of a recent one.
			const rows: number[][] = [];
			for (let k = 0, n = 1 + Math.floor(r() * 3); k < n; k++) {
				const times = model.columns[0]!;
				const lastTime = times[times.length - 1]!;
				const close = model.columns[4]![times.length - 1]!;
				const price = close === close ? close : 100;
				const kind = r();
				let time = lastTime;
				if (kind < 0.35) {
					time = lastTime + MIN;
				} else if (kind > 0.95 && times.length > 30) {
					time = times[times.length - 1 - Math.floor(r() * 25)]!;
				}
				const row = bar(r, time, price);
				const index = times.indexOf(time);
				const at = index < 0 ? times.length : index;
				for (let c = 0; c < 6; c++) {
					model.columns[c]![at] = row[c]!;
				}
				rows.push(row);
			}
			const tickData = new Float64Array(rows.length * 7).fill(NaN);
			rows.forEach((row, i) => {
				tickData[i * 7] = MAIN;
				tickData.set(row, i * 7 + 1);
			});
			apply(exec({ type: 'ticks', count: rows.length, data: tickData }));
		} else if (op < 0.47) {
			const batch = 1 + Math.floor(r() * (r() < 0.3 ? CHUNK_ROWS : 300));
			const firstTime = model.columns[0]![0]!;
			const prepended = block(batch, firstTime - batch * MIN, r);
			const columns = columnsOf(prepended, batch);
			model.first -= batch;
			model.columns = model.columns.map((column, c) => [...columns[c]!, ...column]);
			apply(exec({ type: 'prepend', series: MAIN, count: batch, data: prepended }));
		} else if (op < 0.52 && model.specs.length > 0) {
			// A parameter change of an indicator with a period.
			const index = Math.floor(r() * model.specs.length);
			const spec = model.specs[index]!;
			if (spec.definition.params[0]?.name === 'period') {
				spec.values = { ...spec.values, period: 1 + Math.floor(r() * 25) };
				exec_indicator(index, model.ids[index]!.id, model.ids[index]!.outputs);
			}
		} else if (op < 0.75) {
			// Some background work, sometimes all of it.
			background(r() < 0.5 ? 1 + Math.floor(r() * 4) : Infinity);
		} else {
			// The view moves or zooms, and asks for what it needs.
			const rows = model.end - model.first;
			level = r() < 0.6 ? 0 : Math.min(levelCount(rows), 1 + Math.floor(r() * 3));
			span = Math.max(20, Math.floor(r() * (level === 0 ? 2000 : rows)));
			center = model.first + Math.floor(r() * rows);
		}
		view(level, center - span / 2, center + span / 2);
		if (step % 25 === 24 || step === steps - 1) {
			// Quiet: everything computed, every window brought up to date, then compared.
			background(Infinity);
			view(level, center - span / 2, center + span / 2);
			const problem = check(`seed ${seed} step ${step}`);
			if (problem !== null) {
				return problem;
			}
		}
	}
	return model.ids.length > 0 && compared === 0 ? `seed ${seed}: nothing compared` : null;
}

describe('engine and window cache with indicators', () => {
	it('hold exactly the values of a full computation after any mix of ticks, prepends and changes', () => {
		const failures: string[] = [];
		for (let seed = 1; seed <= 12; seed++) {
			const problem = runOne(seed, 120);
			if (problem !== null) {
				failures.push(problem);
			}
		}
		expect(failures).toEqual([]);
	});
});
