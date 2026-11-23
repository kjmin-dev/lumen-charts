// Costs of the engine's mark operations, on the thread that runs the engine (the worker, in a
// chart): `npx vitest run --config benchmarks/engine/vitest.config.ts`. Each operation runs on a
// fresh store five times after one warm-up; the median and the range are reported.
import { writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { formatJson } from '../src/json.ts';
import {
	EngineCore,
	type HeatmapColumns,
	HeatmapStore,
	MARK_COLUMNS,
	type MarksChunk,
	type ScatterRows,
	ScatterStore,
} from '@lumen-charts/engine';
import { expect, it } from 'vitest';

const MIN = 60_000;
const RUNS = 5;

function trades(count: number, t0 = 0): ScatterRows {
	const time = new Float64Array(count);
	const price = new Float64Array(count);
	const value = new Float32Array(count);
	let seed = 7;
	let mid = 100;
	for (let i = 0; i < count; i++) {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		mid += (seed / 2 ** 32 - 0.5) * 0.02;
		time[i] = t0 + i * 1000;
		price[i] = mid + ((seed >>> 8) % 100) / 400;
		value[i] = 1 + (seed % 100);
	}
	return { kind: 'scatter', count, time, price, value };
}

function book(columns: number, rows: number, varying: boolean): HeatmapColumns {
	const time = Float64Array.from({ length: columns }, (_, c) => c * MIN);
	const values = Float32Array.from({ length: columns * rows }, (_, i) => (i * 31) % 997);
	const offsets = varying ? Int32Array.from({ length: columns }, (_, c) => Math.round(Math.sin(c / 300) * 200)) : null;
	return { kind: 'heatmap', count: columns, rows, priceStart: 90, priceStep: 0.01, offsets, time, values };
}

function drain<T>(run: Generator<undefined, T, undefined>): T {
	let step = run.next();
	while (step.done !== true) {
		step = run.next();
	}
	return step.value;
}

interface Result {
	name: string;
	median: number;
	min: number;
	max: number;
}

/** Milliseconds of `measured` after `setup`, median and range of `RUNS` runs after a warm-up. */
function measure<T>(name: string, setup: () => T, measured: (state: T) => void): Result {
	const times: number[] = [];
	for (let run = 0; run <= RUNS; run++) {
		const state = setup();
		const start = performance.now();
		measured(state);
		const time = performance.now() - start;
		if (run > 0) {
			times.push(time);
		}
	}
	times.sort((a, b) => a - b);
	return { name, median: times[RUNS >> 1]!, min: times[0]!, max: times[RUNS - 1]! };
}

function core(): { core: EngineCore; run: (body: object) => void } {
	const engine = new EngineCore();
	let seq = 0;
	return {
		core: engine,
		run: body => {
			const generator = engine.run({ ...body, seq: ++seq } as never);
			while (generator.next().done !== true) {}
		},
	};
}

it('measures the mark operations', () => {
	const load = loadavg();
	const results: Result[] = [];
	const million = trades(1_000_000);
	const loaded = (): ScatterStore => {
		const store = new ScatterStore();
		drain(store.set({ ...million }));
		return store;
	};
	results.push(
		measure(
			'scatter 1M: set',
			() => new ScatterStore(),
			store => drain(store.set({ ...million })),
		),
	);
	results.push(
		measure('scatter 1M: prepend 100k', loaded, store => drain(store.prepend(trades(100_000, -100_000_000)))),
	);
	results.push(measure('scatter 1M: remove 10% in the middle', loaded, store => drain(store.delete(450e6, 550e6))));
	results.push(measure('scatter 1M: remove 10% at the start', loaded, store => drain(store.delete(0, 100e6))));
	results.push(
		measure('scatter 1M: let every chunk go but the edges', loaded, store => {
			const out: MarksChunk[] = [];
			store.evictable(Infinity, -Infinity, out);
			for (const { chunk } of out) {
				store.evict(chunk);
			}
		}),
	);
	results.push(
		measure(
			'scatter 1M: take one chunk back',
			() => {
				const store = loaded();
				store.evict(5);
				const range = store.fetchRange(5)!;
				const from = million.time.indexOf(range.from);
				const data: ScatterRows = {
					kind: 'scatter',
					count: range.count,
					time: million.time.slice(from, from + range.count),
					price: million.price.slice(from, from + range.count),
					value: million.value!.slice(from, from + range.count),
				};
				return { store, data };
			},
			({ store, data }) => expect(store.restore(5, data)).toBe(true),
		),
	);
	for (const varying of [false, true]) {
		const data = book(2400, 600, varying);
		results.push(
			measure(
				`heatmap 2,400 × 600: set, ${varying ? 'grid following the price' : 'one grid'}`,
				() => new HeatmapStore(),
				store => drain(store.set({ ...data })),
			),
		);
	}
	const bars = 16_667;
	const block = new Float64Array(bars * 6);
	for (let i = 0; i < bars; i++) {
		block[i] = i * MIN;
		for (let c = 1; c < 6; c++) block[c * bars + i] = 100;
	}
	results.push(
		measure(
			'indicators over 1M trades: count and vwap of 16,667 bars from scratch',
			() => {
				const engine = core();
				engine.run({ type: 'add', series: 1, kind: 'ohlcv' });
				engine.run({ type: 'set', series: 1, count: bars, data: block.slice() });
				engine.run({ type: 'marks', series: 2, change: { op: 'add', kind: 'scatter' } });
				engine.run({ type: 'marks', series: 2, change: { op: 'set', data: { ...million } } });
				return engine;
			},
			({ core: engine, run }) => {
				for (const [id, column] of [
					[10, MARK_COLUMNS.count],
					[12, MARK_COLUMNS.vwap],
				] as const) {
					run({ type: 'indicator', id, name: 'sma', params: [1], inputs: [{ series: 2, column }], outputs: [id + 1] });
				}
				while (engine.backgroundStep()) engine.takeNotice();
			},
		),
	);
	results.push(
		measure(
			'indicators over 1M trades: a trade appended, both updated in place',
			() => {
				const engine = core();
				engine.run({ type: 'add', series: 1, kind: 'ohlcv' });
				engine.run({ type: 'set', series: 1, count: bars, data: block.slice() });
				engine.run({ type: 'marks', series: 2, change: { op: 'add', kind: 'scatter' } });
				engine.run({ type: 'marks', series: 2, change: { op: 'set', data: { ...million } } });
				for (const [id, column] of [
					[10, MARK_COLUMNS.count],
					[12, MARK_COLUMNS.vwap],
				] as const) {
					engine.run({
						type: 'indicator',
						id,
						name: 'sma',
						params: [1],
						inputs: [{ series: 2, column }],
						outputs: [id + 1],
					});
				}
				while (engine.core.backgroundStep()) engine.core.takeNotice();
				return engine;
			},
			({ run }) =>
				run({
					type: 'marks',
					series: 2,
					change: { op: 'append', data: trades(1, 1_000_000_000) },
				}),
		),
	);
	const out = process.env['LUMEN_MEASURE_OUT'];
	const report = { node: process.version, load: load.map(value => Math.round(value * 10) / 10), runs: RUNS, results };
	if (out !== undefined) {
		writeFileSync(out, formatJson(report));
	}
	for (const result of results) {
		process.stdout.write(
			`${result.name}: ${result.median.toFixed(1)} ms (${result.min.toFixed(1)}–${result.max.toFixed(1)})\n`,
		);
	}
	expect(results.every(result => result.median >= 0)).toBe(true);
});
