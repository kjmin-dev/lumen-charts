import { resolve as resolvePath } from 'node:path';
import {
	BUILTIN_INDICATORS,
	CHUNK_ROWS,
	type Command,
	EngineCore,
	type EngineEvent,
	type IndicatorDefinition,
	type IndicatorInputRef,
	SOURCE_COLUMNS,
	computeIndicator,
	levelCount,
	levelShift,
	resolveParams,
} from '@lumen-charts/engine';
import { describe, expect, it, vi } from 'vitest';
import { counts } from './fixtures/plugin';
import { random, run } from './helpers';

/** Module loading goes through the bundler's transform, which can take a while on a busy machine. */
const WAIT = { timeout: 10_000 };

const MIN = 60_000;

/** Column-major OHLCV rows with times `t0 + i * MIN`, a random walk with a few missing bars. */
function candles(count: number, seed: number, t0 = 0): Float64Array {
	const r = random(seed);
	const data = new Float64Array(count * 6);
	let price = 100;
	for (let i = 0; i < count; i++) {
		const open = price;
		price = Math.max(1, price + (r() - 0.5));
		const missing = r() < 0.003;
		data[i] = t0 + i * MIN;
		data[count + i] = missing ? NaN : open;
		data[2 * count + i] = missing ? NaN : Math.max(open, price) + r();
		data[3 * count + i] = missing ? NaN : Math.min(open, price) - r();
		data[4 * count + i] = missing ? NaN : price;
		data[5 * count + i] = missing ? NaN : Math.round(r() * 100);
	}
	return data;
}

/** Model of the main series: columns by name, growing with ticks and prepends. */
class Model {
	public first = 0;
	public columns: number[][] = [[], [], [], [], [], []];

	public set(data: Float64Array, count: number): void {
		this.first = 0;
		this.columns = this.columns.map((_, c) => Array.from(data.subarray(c * count, (c + 1) * count)));
	}

	public prepend(data: Float64Array, count: number): void {
		this.first -= count;
		this.columns = this.columns.map((column, c) => [
			...Array.from(data.subarray(c * count, (c + 1) * count)),
			...column,
		]);
	}

	public tick(row: number[]): void {
		const time = row[0]!;
		const times = this.columns[0]!;
		const index = times.indexOf(time);
		const at = index < 0 ? times.length : index;
		row.forEach((value, c) => {
			this.columns[c]![at] = value;
		});
	}

	public get end(): number {
		return this.first + this.columns[0]!.length;
	}
}

interface Spec {
	definition: IndicatorDefinition;
	values: Record<string, number>;
	/** Input by column name, or by index of an earlier spec (its first output, or `[spec, output]`). */
	inputs: (string | number | [number, number])[];
}

/** Every built-in on the main series, plus chains: an SMA of the RSI, an EMA of the MACD signal, a WMA of an SMA. */
function specs(): Spec[] {
	const list: Spec[] = BUILTIN_INDICATORS.map(definition => ({
		definition,
		values: {},
		inputs: [...definition.inputs],
	}));
	const byName = (name: string): number => list.findIndex(spec => spec.definition.name === name);
	const smaDef = list[byName('sma')]!.definition;
	list.push({ definition: smaDef, values: { period: 9 }, inputs: [byName('rsi')] });
	list.push({ definition: list[byName('ema')]!.definition, values: { period: 5 }, inputs: [[byName('macd'), 1]] });
	list.push({ definition: list[byName('wma')]!.definition, values: { period: 7 }, inputs: [list.length - 2] });
	list.push({ definition: smaDef, values: { period: 50 }, inputs: ['high'] });
	return list;
}

interface Added {
	spec: Spec;
	id: number;
	outputs: number[];
}

const MAIN = 1;
let nextId = 100;

function add(core: EngineCore, list: Spec[]): Added[] {
	const added: Added[] = [];
	for (const spec of list) {
		const id = nextId++;
		const outputs = spec.definition.outputs.map(() => nextId++);
		const inputs: IndicatorInputRef[] = spec.inputs.map(input => {
			if (typeof input === 'string') {
				return { series: MAIN, column: SOURCE_COLUMNS[input]! };
			}
			const [index, output] = typeof input === 'number' ? [input, 0] : input;
			return { series: added[index]!.outputs[output]!, column: 0 };
		});
		const params = Array.from(resolveParams(spec.definition.params, spec.values));
		run(core, { type: 'indicator', id, name: spec.definition.name, params, inputs, outputs });
		added.push({ spec, id, outputs });
	}
	return added;
}

/** Expected outputs of every added indicator over the model, computed from scratch. */
function expected(model: Model, added: Added[]): Float64Array[][] {
	const results: Float64Array[][] = [];
	for (const { spec } of added) {
		const inputs = spec.inputs.map(input => {
			if (typeof input === 'string') {
				return model.columns[SOURCE_COLUMNS[input]!]!;
			}
			const [index, output] = typeof input === 'number' ? [input, 0] : input;
			return results[index]![output]!;
		});
		results.push(
			computeIndicator(spec.definition, resolveParams(spec.definition.params, spec.values), inputs, model.first),
		);
	}
	return results;
}

function drain(core: EngineCore): EngineEvent[] {
	const notices: EngineEvent[] = [];
	while (core.backgroundStep()) {
		const notice = core.takeNotice();
		if (notice !== null) {
			notices.push(notice);
		}
	}
	const notice = core.takeNotice();
	if (notice !== null) {
		notices.push(notice);
	}
	return notices;
}

function block(event: EngineEvent, series: number): Float64Array {
	const found = event.window!.series.find(entry => entry.series === series);
	if (found === undefined) {
		throw new Error(`no block for series ${series}`);
	}
	return found.data;
}

const same = (a: number, b: number): boolean => Object.is(a, b) || (a !== a && b !== b);

/** The first derived value of a raw window over the whole timeline that differs in any bit, or null. */
function checkRaw(core: EngineCore, model: Model, added: Added[]): string | null {
	const count = model.end - model.first;
	const event = run(core, { type: 'window', level: 0, start: model.first, count, capacity: count });
	const results = expected(model, added);
	for (let i = 0; i < added.length; i++) {
		const { spec, outputs } = added[i]!;
		for (let o = 0; o < outputs.length; o++) {
			const data = block(event, outputs[o]!);
			const want = results[i]![o]!;
			for (let k = 0; k < count; k++) {
				if (!same(data[k]!, want[k]!)) {
					return `${spec.definition.name} output ${o} row ${model.first + k}: ${data[k]} instead of ${want[k]}`;
				}
			}
		}
	}
	return null;
}

/** The first bucket of a coarse level of a derived series that differs from the buckets of the expected values, or null. */
function checkLevel(core: EngineCore, model: Model, added: Added[], level: number): string | null {
	const shift = levelShift(level);
	const lo = model.first >> shift;
	const hi = ((model.end - 1) >> shift) + 1;
	const event = run(core, { type: 'window', level, start: lo, count: hi - lo, capacity: hi - lo });
	const results = expected(model, added);
	for (let i = 0; i < added.length; i++) {
		const { outputs } = added[i]!;
		for (let o = 0; o < outputs.length; o++) {
			const data = block(event, outputs[o]!);
			const values = results[i]![o]!;
			for (let b = lo; b < hi; b++) {
				const from = Math.max(b << shift, model.first) - model.first;
				const to = Math.min((b + 1) << shift, model.end) - model.first;
				const members = Array.from(values.subarray(from, to)).filter(v => v === v);
				const want =
					members.length === 0
						? [NaN, NaN, NaN, NaN]
						: [members[0]!, Math.max(...members), Math.min(...members), members[members.length - 1]!];
				for (let c = 0; c < 4; c++) {
					if (!same(data[c * (hi - lo) + b - lo]!, want[c]!)) {
						return `level ${level} bucket ${b} column ${c}`;
					}
				}
			}
		}
	}
	return null;
}

function loaded(count: number, list = specs()): { core: EngineCore; model: Model; added: Added[] } {
	const core = new EngineCore();
	const model = new Model();
	run(core, { type: 'add', series: MAIN, kind: 'ohlcv' });
	const data = candles(count, 11);
	model.set(data, count);
	run(core, { type: 'set', series: MAIN, count, data: data.slice() });
	const added = add(core, list);
	drain(core);
	return { core, model, added };
}

function tickRow(model: Model, r: () => number, newBar: boolean): number[] {
	const times = model.columns[0]!;
	const last = times[times.length - 1]!;
	const close = model.columns[4]![times.length - 1]!;
	const price = (close === close ? close : 100) + (r() - 0.5);
	const missing = r() < 0.02;
	return [
		newBar ? last + MIN : last,
		missing ? NaN : price,
		missing ? NaN : price + r(),
		missing ? NaN : price - r(),
		missing ? NaN : price + (r() - 0.5) * 0.1,
		missing ? NaN : Math.round(r() * 50),
	];
}

function tickCommand(rows: number[][]): Omit<Extract<Command, { type: 'ticks' }>, 'seq'> {
	const data = new Float64Array(rows.length * 7).fill(NaN);
	rows.forEach((row, i) => {
		data[i * 7] = MAIN;
		data.set(row, i * 7 + 1);
	});
	return { type: 'ticks', count: rows.length, data };
}

describe('indicator engine', () => {
	it('computes every indicator in the background and swaps the values in at once', () => {
		const core = new EngineCore();
		const model = new Model();
		run(core, { type: 'add', series: MAIN, kind: 'ohlcv' });
		const count = 2 * CHUNK_ROWS + 500;
		const data = candles(count, 3);
		model.set(data, count);
		run(core, { type: 'set', series: MAIN, count, data: data.slice() });
		const added = add(core, specs());
		const answer = run(core, { type: 'window', level: 0, start: 0, count: 10, capacity: 10 });
		expect(answer.computing).toBe(added.length);
		// Nothing computed yet: no values rather than partial ones.
		expect(Array.from(block(answer, added[0]!.outputs[0]!))).toEqual(Array.from({ length: 10 }, () => NaN));
		const notices = drain(core);
		expect(notices.length).toBeGreaterThan(0);
		expect(notices.every(notice => notice.stale)).toBe(true);
		expect(notices[notices.length - 1]!.computing).toBeUndefined();
		expect(checkRaw(core, model, added)).toBeNull();
		for (let level = 1; level <= levelCount(count); level++) {
			expect(checkLevel(core, model, added, level)).toBeNull();
		}
	});

	it('updates incrementally on ticks with the same bits as a full computation', () => {
		const { core, model, added } = loaded(CHUNK_ROWS - 40);
		const r = random(5);
		const mismatches: (string | null)[] = [];
		// Crosses a chunk boundary, where windowed kernels restart, while ticking.
		for (let batch = 0; batch < 60; batch++) {
			const rows: number[][] = [];
			for (let k = 0, n = 1 + Math.floor(r() * 4); k < n; k++) {
				const row = tickRow(model, r, r() < 0.4);
				model.tick(row);
				rows.push(row);
			}
			const event = run(core, tickCommand(rows));
			const end = model.end;
			// The patch of every output carries its latest value, in the same message as the bar.
			for (const { outputs } of added) {
				for (const series of outputs) {
					expect(event.patches!.some(p => p.series === series && p.level === 0 && p.start + p.count === end)).toBe(
						true,
					);
				}
			}
			if (batch % 15 === 14) {
				mismatches.push(checkRaw(core, model, added));
			}
		}
		expect(mismatches).toEqual([null, null, null, null]);
		expect(checkRaw(core, model, added)).toBeNull();
		expect(checkLevel(core, model, added, 1)).toBeNull();
		expect(checkLevel(core, model, added, 2)).toBeNull();
	});

	it('recomputes after a correction of an older bar', () => {
		const { core, model, added } = loaded(CHUNK_ROWS + 300);
		const times = model.columns[0]!;
		const index = times.length - 120;
		const row = [times[index]!, 90, 91, 89, 90.5, 7];
		model.tick(row);
		run(core, tickCommand([row]));
		expect(checkRaw(core, model, added)).toBeNull();
	});

	it('keeps the old values on screen until a prepend is recomputed, then matches a full computation', () => {
		const { core, model, added } = loaded(CHUNK_ROWS + 1000);
		const before = run(core, { type: 'window', level: 0, start: 0, count: 50, capacity: 50 });
		const batch = 5000;
		const data = candles(batch, 21, -batch * MIN);
		model.prepend(data, batch);
		const answer = run(core, { type: 'prepend', series: MAIN, count: batch, data: data.slice() });
		expect(answer.computing).toBe(added.length);
		// Until the recomputation is done, old rows show the old values and new rows nothing.
		const during = run(core, { type: 'window', level: 0, start: -batch, count: batch + 50, capacity: batch + 50 });
		for (const { outputs } of added) {
			for (const series of outputs) {
				const values = block(during, series);
				expect(Array.from(values.subarray(0, batch)).every(v => v !== v)).toBe(true);
				expect(Array.from(values.subarray(batch))).toEqual(Array.from(block(before, series)));
			}
		}
		drain(core);
		expect(checkRaw(core, model, added)).toBeNull();
		expect(checkLevel(core, model, added, 1)).toBeNull();
		expect(checkLevel(core, model, added, 3)).toBeNull();
	});

	it('recomputes a windowed indicator only near the old first bar, a cumulative one in full', async () => {
		const core = new EngineCore();
		run(core, { type: 'add', series: MAIN, kind: 'ohlcv' });
		const count = 6 * CHUNK_ROWS;
		const data = candles(count, 4);
		run(core, { type: 'set', series: MAIN, count, data: data.slice() });
		core.onwake = () => undefined;
		run(core, { type: 'plugin', url: resolvePath('packages/engine/test/fixtures/plugin.ts') });
		await vi.waitFor(() => {
			expect(core.takeNotice()?.plugins?.[0]?.indicators?.length).toBe(2);
		}, WAIT);
		run(core, {
			type: 'indicator',
			id: 50,
			name: 'test-momentum',
			params: [10],
			inputs: [{ series: MAIN, column: 4 }],
			outputs: [51],
		});
		run(core, {
			type: 'indicator',
			id: 52,
			name: 'test-range',
			params: [],
			inputs: [
				{ series: MAIN, column: 2 },
				{ series: MAIN, column: 3 },
			],
			outputs: [53],
		});
		drain(core);
		counts.momentum = 0;
		counts.range = 0;
		const batch = 1000;
		run(core, { type: 'prepend', series: MAIN, count: batch, data: candles(batch, 8, -batch * MIN) });
		drain(core);
		// The new rows and the rest of the old first chunk, against everything for the running sum.
		expect(counts.momentum).toBe(batch + CHUNK_ROWS);
		expect(counts.range).toBe(count + batch);
		// The momentum of the first old bars now reaches into the prepended ones.
		const window = run(core, { type: 'window', level: 0, start: 0, count: 2, capacity: 2 });
		expect(block(window, 51)[0]).not.toBeNaN();
	});

	it('recomputes on a parameter change and keeps the old values until then', () => {
		const { core, model, added } = loaded(3000);
		const target = added.find(entry => entry.spec.definition.name === 'ema')!;
		const old = block(
			run(core, { type: 'window', level: 0, start: 2990, count: 10, capacity: 10 }),
			target.outputs[0]!,
		);
		target.spec.values = { period: 50 };
		run(core, {
			type: 'indicator',
			id: target.id,
			name: 'ema',
			params: [50],
			inputs: [{ series: MAIN, column: 4 }],
			outputs: target.outputs,
		});
		const during = run(core, { type: 'window', level: 0, start: 2990, count: 10, capacity: 10 });
		// The indicator and everything it feeds recompute; the old values stay meanwhile.
		expect(during.computing).toBeGreaterThanOrEqual(1);
		expect(Array.from(block(during, target.outputs[0]!))).toEqual(Array.from(old));
		drain(core);
		expect(checkRaw(core, model, added)).toBeNull();
	});

	it('reads missing values once an input indicator is removed', () => {
		const { core, model, added } = loaded(500);
		const rsiIndex = added.findIndex(entry => entry.spec.definition.name === 'rsi');
		const chained = added.find(entry => entry.spec.inputs[0] === rsiIndex)!;
		run(core, { type: 'removeIndicator', id: added[rsiIndex]!.id });
		drain(core);
		const event = run(core, { type: 'window', level: 0, start: 0, count: 500, capacity: 500 });
		expect(Array.from(block(event, chained.outputs[0]!)).every(v => v !== v)).toBe(true);
		expect(event.window!.series.some(entry => entry.series === added[rsiIndex]!.outputs[0])).toBe(false);
		expect(model.end).toBe(500);
	});

	it('recomputes everything when the main series gets new data', () => {
		const { core, model, added } = loaded(800);
		const data = candles(1200, 99);
		model.set(data, 1200);
		run(core, { type: 'set', series: MAIN, count: 1200, data: data.slice() });
		drain(core);
		expect(checkRaw(core, model, added)).toBeNull();
	});

	it('reads a secondary series aligned to the main timeline', () => {
		const core = new EngineCore();
		run(core, { type: 'add', series: MAIN, kind: 'ohlcv' });
		run(core, { type: 'add', series: 2, kind: 'line' });
		run(core, { type: 'set', series: MAIN, count: 6, data: candles(6, 1) });
		// One point per two minutes: every other main bar has no value.
		run(core, { type: 'set', series: 2, count: 3, data: new Float64Array([0, 2 * MIN, 4 * MIN, 10, 20, 30]) });
		run(core, {
			type: 'indicator',
			id: 60,
			name: 'sma',
			params: [1],
			inputs: [{ series: 2, column: 1 }],
			outputs: [61],
		});
		drain(core);
		const event = run(core, { type: 'window', level: 0, start: 0, count: 6, capacity: 6 });
		expect(Array.from(block(event, 61))).toEqual([10, NaN, 20, NaN, 30, NaN]);
	});

	it('reports a plugin that fails to load', async () => {
		const core = new EngineCore();
		let woken = 0;
		core.onwake = () => {
			woken++;
		};
		run(core, { type: 'plugin', url: resolvePath('packages/engine/test/fixtures/missing.js') });
		await vi.waitFor(() => {
			expect(woken).toBeGreaterThan(0);
		}, WAIT);
		const notice = core.takeNotice()!;
		expect(notice.plugins![0]!.error).toBeTypeOf('string');
		expect(notice.plugins![0]!.indicators).toBeUndefined();
	});
});
