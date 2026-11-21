import {
	ALL_LEVELS,
	type EngineClient,
	EngineCore,
	type EngineEvent,
	type IndicatorInputRef,
	MAX_LEVEL,
	type Patch,
	TIME_PATCH,
	createEngine,
	hasLevel,
	levelCount,
	setMaxWorkers,
} from '@lumen-charts/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeWorker } from './fake-worker';
import { ohlcv, run, ticks } from './helpers';

const MIN = 60_000;
const SERIES = 1;

/** Bit `k` for each level given. */
function levels(...list: number[]): number {
	return list.reduce((mask, level) => mask | (1 << level), 0);
}

function levelsOf(patches: Patch[] | undefined, series?: number): number[] {
	const set = new Set<number>();
	for (const patch of patches ?? []) {
		if (series === undefined || patch.series === series) {
			set.add(patch.level);
		}
	}
	return Array.from({ length: MAX_LEVEL + 1 }, (_, level) => level).filter(level => set.has(level));
}

/** Runs the background work (level builds, indicator computations) to the end. */
function settle(core: EngineCore): void {
	while (core.backgroundStep()) {
		// Every slice until nothing is left.
	}
	core.takeNotice();
}

/** A core with `count` candles, one SMA (output id 3) and its levels built. */
function loaded(count: number): EngineCore {
	const core = new EngineCore();
	run(core, { type: 'add', series: SERIES, kind: 'ohlcv' });
	run(core, { type: 'set', series: SERIES, count, data: ohlcv(count, 0, MIN) });
	run(core, {
		type: 'indicator',
		id: 2,
		name: 'sma',
		params: [5],
		inputs: [{ series: SERIES, column: 4 }],
		outputs: [3],
	});
	settle(core);
	return core;
}

function window(level: number, start: number, mask?: number) {
	return mask === undefined
		? ({ type: 'window', level, start, count: 10, capacity: 10 } as const)
		: ({ type: 'window', level, start, count: 10, capacity: 10, levels: mask } as const);
}

/** A tick on the last bar of `loaded(count)`, or a new bar after it. */
function tick(count: number, newBar: boolean) {
	const time = (newBar ? count : count - 1) * MIN;
	return ticks([SERIES, time, 1, 3, 0.5, 2, 9]);
}

describe('patches of the levels a client holds', () => {
	const COUNT = 5000;
	const LEVELS = levelCount(COUNT);

	it('come for every level when no window names its levels', () => {
		const core = loaded(COUNT);
		run(core, window(2, 0));
		const event = run(core, tick(COUNT, true));
		const every = Array.from({ length: LEVELS + 1 }, (_, level) => level);
		expect(levelsOf(event.patches, TIME_PATCH)).toEqual(every);
		expect(levelsOf(event.patches, SERIES)).toEqual(every);
		expect(levelsOf(event.patches, 3)).toEqual(every);
	});

	it('come for the raw rows, the levels named and the level asked for alone', () => {
		const core = loaded(COUNT);
		run(core, window(2, 0, levels(4)));
		for (const newBar of [false, true]) {
			const event = run(core, tick(COUNT + (newBar ? 0 : 1), newBar));
			expect(levelsOf(event.patches, SERIES)).toEqual([0, 2, 4]);
			// Indicator outputs follow the same levels.
			expect(levelsOf(event.patches, 3)).toEqual([0, 2, 4]);
		}
	});

	it('come for every level again after a window that names none', () => {
		const core = loaded(COUNT);
		run(core, window(1, 0, levels(0)));
		expect(levelsOf(run(core, tick(COUNT, false)).patches)).toEqual([0, 1]);
		run(core, window(1, 0));
		expect(levelsOf(run(core, tick(COUNT, false)).patches)).toEqual(
			Array.from({ length: LEVELS + 1 }, (_, level) => level),
		);
	});

	it('are kept apart per engine', () => {
		const a = loaded(COUNT);
		const b = loaded(COUNT);
		run(a, window(0, 0, levels(0)));
		run(b, window(3, 0));
		expect(levelsOf(run(a, tick(COUNT, false)).patches)).toEqual([0]);
		expect(levelsOf(run(b, tick(COUNT, false)).patches)).toHaveLength(LEVELS + 1);
	});

	it('leave the other levels current, so a window asked for later has every tick', () => {
		const masked = loaded(COUNT);
		const full = loaded(COUNT);
		run(masked, window(0, COUNT - 10, levels(0)));
		for (let i = 0; i < 40; i++) {
			// New bars and updates of the last one.
			const bar = ticks([SERIES, (COUNT + (i >> 1)) * MIN, i, i + 2, i - 2, i + 1, i]);
			const a = run(masked, bar);
			run(full, bar);
			expect(levelsOf(a.patches)).toEqual([0]);
		}
		for (let level = 1; level <= LEVELS; level++) {
			const end = Math.ceil((COUNT + 20) / 2 ** (2 * level + 2));
			const a = run(masked, window(level, end - 10)).window!;
			const b = run(full, window(level, end - 10)).window!;
			expect(a.count).toBeGreaterThan(0);
			expect(a.time).toEqual(b.time);
			expect(a.series).toEqual(b.series);
		}
	});

	it('leave out the times of coarse buckets when ticks add no bar', () => {
		const core = loaded(COUNT);
		const update = run(core, tick(COUNT, false));
		// A bucket's time is its first row's time, which an update of a bar does not change.
		expect(levelsOf(update.patches, TIME_PATCH)).toEqual([0]);
		expect(levelsOf(update.patches, SERIES)).toHaveLength(LEVELS + 1);
		const newBar = run(core, tick(COUNT, true));
		expect(levelsOf(newBar.patches, TIME_PATCH)).toHaveLength(LEVELS + 1);
	});

	it('cover the first bucket after a prepend at the levels named alone', () => {
		const core = loaded(COUNT);
		// Rows before row 0 first, so the next prepend ends inside a bucket of every level.
		run(core, { type: 'prepend', series: SERIES, count: 7, data: ohlcv(7, -7 * MIN, MIN) });
		run(core, window(1, 0, levels(3)));
		const prepended = run(core, { type: 'prepend', series: SERIES, count: 5, data: ohlcv(5, -12 * MIN, MIN) });
		expect(levelsOf(prepended.patches)).toEqual([1, 3]);
	});

	it('fit every level in the bits of a mask', () => {
		// Ten levels exist at 10M bars; a mask has room for every level there is.
		expect(levelCount(10_000_000)).toBe(10);
		expect(MAX_LEVEL).toBeLessThan(31);
		for (let level = 0; level <= MAX_LEVEL; level++) {
			expect(hasLevel(ALL_LEVELS, level)).toBe(true);
			expect(hasLevel(levels(level), level)).toBe(true);
			expect(hasLevel(levels(level), level + 1)).toBe(false);
		}
	});
});

/**
 * The twenty indicators of the benchmarks' `ind-apply` cases (benchmarks/src/indicators.ts), with
 * their 25 outputs. Inputs are candle columns (1 open to 5 volume, 0 time) or, as `{ from }`, the
 * first output of an earlier entry.
 */
const INDICATOR_SET: [string, number[], (number | { from: number })[]][] = [
	['sma', [20], [4]],
	['sma', [50], [4]],
	['sma', [200], [4]],
	['ema', [12], [4]],
	['ema', [26], [4]],
	['ema', [100], [4]],
	['wma', [20], [4]],
	['rsi', [14], [4]],
	['macd', [12, 26, 9], [4]],
	['bollinger', [20, 2], [4]],
	['atr', [14], [2, 3, 4]],
	['stochastic', [14, 1, 3], [2, 3, 4]],
	['vwap', [86_400_000], [2, 3, 4, 5, 0]],
	['highest', [20], [2]],
	['lowest', [20], [3]],
	['sma', [9], [{ from: 7 }]],
	['ema', [9], [{ from: 10 }]],
	['wma', [9], [{ from: 8 }]],
	['ema', [50], [2]],
	['rsi', [7], [4]],
];
const OUTPUTS: Record<string, number> = { macd: 3, bollinger: 3, stochastic: 2 };

describe('patches per tick with twenty indicators', () => {
	// As many levels as 1M bars have (eight), at a quarter of the rows.
	const COUNT = 262_144;

	/** Patches and values of an update of the last bar and of a new bar, after a window naming `mask`. */
	function perTick(mask: number | undefined): { patches: number; values: number }[] {
		const core = new EngineCore();
		run(core, { type: 'add', series: SERIES, kind: 'ohlcv' });
		run(core, { type: 'set', series: SERIES, count: COUNT, data: ohlcv(COUNT, 0, MIN) });
		let next = 10;
		const firsts: number[] = [];
		for (const [name, params, inputs] of INDICATOR_SET) {
			const id = next++;
			const outputs = Array.from({ length: OUTPUTS[name] ?? 1 }, () => next++);
			firsts.push(outputs[0]!);
			const refs: IndicatorInputRef[] = inputs.map(input =>
				typeof input === 'number' ? { series: SERIES, column: input } : { series: firsts[input.from]!, column: 0 },
			);
			run(core, { type: 'indicator', id, name, params, inputs: refs, outputs });
		}
		settle(core);
		run(core, mask === undefined ? window(0, COUNT - 10) : window(0, COUNT - 10, mask));
		return [run(core, tick(COUNT, false)), run(core, tick(COUNT, true))].map((event: EngineEvent) => ({
			patches: event.patches!.length,
			values: event.patches!.reduce((sum, patch) => sum + patch.data.length, 0),
		}));
	}

	it('drop from one per series and level to one per series and level held', () => {
		expect(levelCount(COUNT)).toBe(levelCount(1_000_000));
		// Every level: time, candles and 25 outputs at the raw level and each of the eight coarse ones.
		// Before the client could name its levels an update was 243 patches and 879 values as well; it
		// now leaves out the 8 coarse times. A new bar patches two rows of most outputs.
		expect(perTick(undefined)).toEqual([
			{ patches: 235, values: 871 },
			{ patches: 243, values: 1704 },
		]);
		// The latest bars: the cache holds the raw rows and at most level 1 next to them.
		expect(perTick(levels(0, 1))).toEqual([
			{ patches: 53, values: 136 },
			{ patches: 54, values: 262 },
		]);
		// All of 1M bars on a wide screen draws level 3; the cache keeps levels 2 to 4.
		expect(perTick(levels(0, 2, 3, 4))).toEqual([
			{ patches: 105, values: 346 },
			{ patches: 108, values: 674 },
		]);
	}, 60_000);
});

const factory = (): Worker => new FakeWorker() as unknown as Worker;

describe('levels named through a client', () => {
	let engines: EngineClient[];

	beforeEach(() => {
		engines = [];
		FakeWorker.created = [];
		vi.stubGlobal('Worker', FakeWorker);
		setMaxWorkers(1);
	});

	afterEach(() => {
		for (const engine of engines) {
			engine.destroy();
		}
		vi.unstubAllGlobals();
		setMaxWorkers(4);
	});

	it('travel with window requests, and each engine on a shared worker keeps its own', async () => {
		const create = (): { engine: EngineClient; events: EngineEvent[] } => {
			const engine = createEngine({ worker: factory });
			engines.push(engine);
			const events: EngineEvent[] = [];
			engine.onevent = event => {
				events.push(event);
			};
			return { engine, events };
		};
		const a = create();
		const b = create();
		for (const { engine } of [a, b]) {
			engine.addSeries('ohlcv');
			engine.setData(SERIES, ohlcv(5000, 0, MIN), 5000);
		}
		a.engine.requestWindow(4990, 10, 10, 0, levels(0, 1));
		// An engine that never names its levels.
		b.engine.requestWindow(4990, 10, 10, 0);
		a.engine.tick(SERIES, 5000 * MIN, 1, 3, 0.5, 2, 9);
		b.engine.tick(SERIES, 5000 * MIN, 1, 3, 0.5, 2, 9);
		await Promise.all(engines.map(engine => engine.whenIdle()));
		expect(FakeWorker.created).toHaveLength(1);
		const windows = FakeWorker.created[0]!.received.filter(message => message.type === 'window');
		expect(windows.map(message => ('levels' in message ? message.levels : undefined))).toEqual([
			levels(0, 1),
			undefined,
		]);
		expect(levelsOf(a.events.at(-1)!.patches)).toEqual([0, 1]);
		expect(levelsOf(b.events.at(-1)!.patches)).toHaveLength(levelCount(5001) + 1);
	});
});
