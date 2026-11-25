import {
	BUILTIN_INDICATORS,
	EngineCore,
	type EngineEvent,
	type HeatmapColumns,
	MARK_COLUMNS,
	type MarkColumn,
	type ScatterRows,
} from '@lumen-ticks/engine';
import { describe, expect, it } from 'vitest';
import { random, run, ticks } from './helpers';

const MIN = 60_000;
const MAIN = 1;
const MARKS = 2;
const sma = BUILTIN_INDICATORS.find(definition => definition.name === 'sma')!;

/** `count` one-minute bars from time 0. */
function bars(count: number): Float64Array {
	const data = new Float64Array(count * 6);
	for (let i = 0; i < count; i++) {
		data[i] = i * MIN;
		for (let c = 1; c <= 4; c++) {
			data[c * count + i] = 100 + (i % 7);
		}
		data[5 * count + i] = 10;
	}
	return data;
}

/** Trades at random times from `from` on, a few per minute, some minutes without any. */
function trades(count: number, seed: number, from = 0): ScatterRows {
	const next = random(seed);
	const time = new Float64Array(count);
	const price = new Float64Array(count);
	const value = new Float32Array(count);
	let t = from;
	for (let i = 0; i < count; i++) {
		t += next() < 0.05 ? 3 * MIN : Math.floor(next() * 30_000);
		time[i] = t;
		price[i] = 100 + Math.round(next() * 400) / 100;
		value[i] = next() < 0.02 ? Number.NaN : 1 + Math.floor(next() * 50);
	}
	return { kind: 'scatter', count, time, price, value };
}

/** Every point held, for the references. */
class Points {
	public time: number[] = [];
	public price: number[] = [];
	public value: number[] = [];

	public add(rows: ScatterRows, front = false): void {
		const time = [...rows.time];
		const price = [...rows.price];
		const value = [...(rows.value ?? new Float32Array(rows.count).fill(Number.NaN))];
		if (front) {
			this.time = time.concat(this.time);
			this.price = price.concat(this.price);
			this.value = value.concat(this.value);
		} else {
			this.time = this.time.concat(time);
			this.price = this.price.concat(price);
			this.value = this.value.concat(value);
		}
	}

	public remove(from: number, to: number): void {
		const keep = this.time.map((t, i) => (t < from || t > to ? i : -1)).filter(i => i >= 0);
		this.time = keep.map(i => this.time[i]!);
		this.price = keep.map(i => this.price[i]!);
		this.value = keep.map(i => this.value[i]!);
	}
}

/** First of the sorted `times` that is not before `time`. */
function lowerBound(times: readonly number[], time: number): number {
	let lo = 0;
	let hi = times.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (times[mid]! < time) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo;
}

/** A scatter column per bar the plain way: the points with times from the bar's to the next bar's. */
function reference(points: Points, barTimes: number[], column: MarkColumn): number[] {
	return barTimes.map((start, k) => {
		const end = k + 1 < barTimes.length ? barTimes[k + 1]! : Infinity;
		const from = lowerBound(points.time, start);
		const rows = Array.from({ length: lowerBound(points.time, end) - from }, (_, i) => from + i);
		const prices = rows.map(i => points.price[i]!);
		const values = rows.map(i => points.value[i]!).filter(v => v === v);
		const sum = values.reduce((a, b) => a + b, 0);
		const weighted = rows.reduce((a, i) => {
			const value = points.value[i]!;
			return value === value ? a + value * points.price[i]! : a;
		}, 0);
		switch (column) {
			case 'count':
				return rows.length;
			case 'sum':
				return sum;
			case 'max':
				return values.length > 0 ? Math.max(...values) : Number.NaN;
			case 'min':
				return values.length > 0 ? Math.min(...values) : Number.NaN;
			case 'mean':
				return values.length > 0 ? sum / values.length : Number.NaN;
			case 'open':
				return prices.length > 0 ? prices[0]! : Number.NaN;
			case 'close':
				return prices.length > 0 ? prices.at(-1)! : Number.NaN;
			case 'high':
				return prices.length > 0 ? Math.max(...prices) : Number.NaN;
			case 'low':
				return prices.length > 0 ? Math.min(...prices) : Number.NaN;
			case 'vwap':
				return sum !== 0 ? weighted / sum : Number.NaN;
			default:
				return Number.NaN;
		}
	});
}

const SCATTER_COLUMNS: MarkColumn[] = ['count', 'sum', 'max', 'min', 'mean', 'open', 'high', 'low', 'close', 'vwap'];

/** Adds an SMA of period 1 (each bar's input as it is) over every column; returns the output ids by column. */
function readers(core: EngineCore, columns: readonly MarkColumn[], first = 100): Map<MarkColumn, number> {
	const outputs = new Map<MarkColumn, number>();
	columns.forEach((column, i) => {
		const output = first + i * 2 + 1;
		run(core, {
			type: 'indicator',
			id: first + i * 2,
			name: 'sma',
			params: [1],
			inputs: [{ series: MARKS, column: MARK_COLUMNS[column] }],
			outputs: [output],
		});
		outputs.set(column, output);
	});
	return outputs;
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

/** The first output value of the raw window that differs from the reference, or null. */
function check(
	core: EngineCore,
	outputs: Map<MarkColumn, number>,
	expected: (column: MarkColumn, times: number[]) => number[],
): string | null {
	const window = run(core, { type: 'window', level: 0, start: 0, count: 1 << 20, capacity: 1 << 20 }).window!;
	const times = [...window.time.subarray(0, window.count)];
	for (const [column, output] of outputs) {
		const data = window.series.find(block => block.series === output)!.data;
		const want = expected(column, times);
		for (let k = 0; k < window.count; k++) {
			const got = data[k]!;
			const value = want[k]!;
			if (!(got === value || (got !== got && value !== value) || Math.abs(got - value) <= 1e-9 * Math.abs(value))) {
				return `${column} bar ${k}: ${got} instead of ${value}`;
			}
		}
	}
	return null;
}

describe('indicators over a scatter series', () => {
	it('read each bar of the main timeline as the points from its time to the next bar', () => {
		expect(sma).toBeDefined();
		const core = new EngineCore();
		run(core, { type: 'add', series: MAIN, kind: 'ohlcv' });
		run(core, { type: 'set', series: MAIN, count: 600, data: bars(600) });
		run(core, { type: 'marks', series: MARKS, change: { op: 'add', kind: 'scatter' } });
		const points = new Points();
		const data = trades(5000, 3);
		points.add(data);
		run(core, { type: 'marks', series: MARKS, change: { op: 'set', data: trades(5000, 3) } });
		const outputs = readers(core, SCATTER_COLUMNS);
		drain(core);
		expect(check(core, outputs, (column, times) => reference(points, times, column))).toBeNull();
	});

	it('follow appended points and new bars in place, and other changes in the background', () => {
		const core = new EngineCore();
		run(core, { type: 'add', series: MAIN, kind: 'ohlcv' });
		run(core, { type: 'set', series: MAIN, count: 300, data: bars(300) });
		run(core, { type: 'marks', series: MARKS, change: { op: 'add', kind: 'scatter' } });
		const points = new Points();
		// About 230 minutes of trades: the last bars have none yet.
		const first = trades(600, 5);
		expect(first.time[599]!).toBeLessThan(290 * MIN);
		points.add(first);
		run(core, { type: 'marks', series: MARKS, change: { op: 'set', data: trades(600, 5) } });
		const outputs = readers(core, ['count', 'sum', 'close', 'vwap']);
		drain(core);
		const want = (column: MarkColumn, times: number[]) => reference(points, times, column);
		expect(check(core, outputs, want)).toBeNull();
		// Trades in the last bar and after it: the last bar takes them all, in the same message.
		const live: ScatterRows = {
			kind: 'scatter',
			count: 3,
			time: Float64Array.of(299 * MIN + 10_000, 300 * MIN + 5000, 300 * MIN + 9000),
			price: Float64Array.of(101, 102, 103),
			value: Float32Array.of(4, 5, 6),
		};
		points.add(live);
		const event = run(core, {
			type: 'marks',
			series: MARKS,
			change: {
				op: 'append',
				data: { ...live, time: live.time.slice(), price: live.price.slice(), value: live.value!.slice() },
			},
		});
		expect(event.patches !== undefined || event.packedPatches !== undefined).toBe(true);
		expect(check(core, outputs, want)).toBeNull();
		// A new bar takes the trades from its time on from the bar before it, also in place.
		run(core, { ...ticks([300 * MIN, 100, 100, 100, 100, 1]) });
		expect(check(core, outputs, want)).toBeNull();
		// Older points, removed ones, a new history: recomputed in the background.
		const older = trades(400, 9, -40 * MIN);
		const kept = [...older.time].filter(t => t <= points.time[0]!);
		const rows: ScatterRows = {
			kind: 'scatter',
			count: kept.length,
			time: older.time.slice(0, kept.length),
			price: older.price.slice(0, kept.length),
			value: older.value!.slice(0, kept.length),
		};
		points.add(rows, true);
		run(core, {
			type: 'marks',
			series: MARKS,
			change: {
				op: 'prepend',
				data: { ...rows, time: rows.time.slice(), price: rows.price.slice(), value: rows.value!.slice() },
			},
		});
		drain(core);
		expect(check(core, outputs, want)).toBeNull();
		points.remove(100 * MIN, 150 * MIN);
		run(core, { type: 'marks', series: MARKS, change: { op: 'delete', from: 100 * MIN, to: 150 * MIN } });
		drain(core);
		expect(check(core, outputs, want)).toBeNull();
	});

	it('fetch points let go under the memory limit before recomputing over them', () => {
		const core = new EngineCore();
		run(core, { type: 'add', series: MAIN, kind: 'ohlcv' });
		run(core, { type: 'set', series: MAIN, count: 9000, data: bars(9000) });
		run(core, { type: 'marks', series: MARKS, change: { op: 'add', kind: 'scatter', fetchable: true } });
		const data = trades(400_000, 7);
		const points = new Points();
		points.add(data);
		run(core, { type: 'marks', series: MARKS, change: { op: 'set', data: trades(400_000, 7) } });
		const tail = data.time[data.count - 1]!;
		run(core, {
			type: 'marksWindow',
			series: MARKS,
			request: {
				from: tail - MIN,
				to: tail,
				step: 1,
				priceStep: 0,
				limit: Infinity,
				generation: -1,
				heldLevel: -1,
				heldStart: 0,
				heldEnd: 0,
			},
		});
		run(core, { type: 'limit', bytes: 1 });
		const before = core.memory.bytes;
		drain(core);
		// Every chunk but the first, the last and the view's went.
		expect(core.memory.bytes).toBeLessThan(before - 3 * 65_536 * 20);
		// An indicator added now reads every bar: it asks for the points let go, and waits for them.
		const outputs = readers(core, ['count', 'sum']);
		let requests = 0;
		for (let round = 0; round < 50; round++) {
			const notices = drain(core);
			const fetches = notices.flatMap(notice => notice.marksFetch ?? []);
			if (fetches.length === 0 && core.memory.requests === 0) {
				break;
			}
			for (const fetch of fetches) {
				requests++;
				const from = lowerBound(points.time, fetch.from);
				const keep = Array.from({ length: lowerBound(points.time, fetch.to + 0.5) - from }, (_, i) => from + i);
				run(core, {
					type: 'marksRows',
					request: fetch.id,
					data: {
						kind: 'scatter',
						count: keep.length,
						time: Float64Array.from(keep, i => points.time[i]!),
						price: Float64Array.from(keep, i => points.price[i]!),
						value: Float32Array.from(keep, i => points.value[i]!),
					},
				});
			}
		}
		expect(requests).toBeGreaterThan(0);
		expect(check(core, outputs, (column, times) => reference(points, times, column))).toBeNull();
	}, 60_000);
});

/** Heatmap columns a minute and a half apart, on rows that wander, with a few missing cells. */
function book(count: number): HeatmapColumns {
	const rows = 6;
	const time = new Float64Array(count);
	const offsets = new Int32Array(count);
	const values = new Float32Array(count * rows);
	for (let c = 0; c < count; c++) {
		time[c] = c * 90_000;
		offsets[c] = (c % 9) - 4;
		for (let r = 0; r < rows; r++) {
			values[c * rows + r] = (c + r) % 5 === 0 ? Number.NaN : ((c * 7 + r * 3) % 40) + 1;
		}
	}
	return { kind: 'heatmap', count, rows, priceStart: 100, priceStep: 0.5, offsets, time, values };
}

describe('indicators over a heatmap series', () => {
	it('read each bar as the book stood in it: its last column, or the last one before it', () => {
		const core = new EngineCore();
		run(core, { type: 'add', series: MAIN, kind: 'ohlcv' });
		run(core, { type: 'set', series: MAIN, count: 400, data: bars(400) });
		run(core, { type: 'marks', series: MARKS, change: { op: 'add', kind: 'heatmap' } });
		const data = book(200);
		run(core, { type: 'marks', series: MARKS, change: { op: 'set', data: book(200) } });
		const outputs = readers(core, ['sum', 'max', 'min', 'center']);
		drain(core);
		const rows = data.rows;
		const expected = (column: MarkColumn, times: number[]): number[] =>
			times.map((start, k) => {
				const end = k + 1 < times.length ? times[k + 1]! : Infinity;
				const inside = [...data.time].map((t, c) => (t >= start && t < end ? c : -1)).filter(c => c >= 0);
				const before = [...data.time].map((t, c) => (t < start ? c : -1)).filter(c => c >= 0);
				const columns = inside.length > 0 ? inside : before.length > 0 ? [before.at(-1)!] : [];
				if (columns.length === 0) {
					return Number.NaN;
				}
				const cells = (c: number) => [...data.values.subarray(c * rows, (c + 1) * rows)];
				const all = columns.flatMap(cells).filter(v => v === v);
				const last = columns.at(-1)!;
				const lastCells = cells(last);
				const sum = lastCells.filter(v => v === v).reduce((a, b) => a + b, 0);
				const weighted = lastCells.reduce(
					(a, v, r) => (v === v ? a + v * (100 + (data.offsets![last]! + r + 0.5) * 0.5) : a),
					0,
				);
				switch (column) {
					case 'sum':
						return sum;
					case 'max':
						return all.length > 0 ? Math.max(...all) : Number.NaN;
					case 'min':
						return all.length > 0 ? Math.min(...all) : Number.NaN;
					case 'center':
						return sum !== 0 ? weighted / sum : Number.NaN;
					default:
						return Number.NaN;
				}
			});
		expect(check(core, outputs, expected)).toBeNull();
	});
});
