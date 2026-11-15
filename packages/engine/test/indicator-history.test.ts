import {
	CHUNK_ROWS,
	EngineCore,
	type EngineEvent,
	type FetchRequest,
	computeIndicator,
	ema,
	sma,
} from '@lumen-charts/engine';
import { describe, expect, it } from 'vitest';
import { line, run, ticks } from './helpers';

const COUNT = CHUNK_ROWS * 24;
const MAIN = 1;
const SECOND = 2;

/** A series as its datafeed serves it: bars by time, changed at the source before the engine is told. */
interface Source {
	times: number[];
	values: number[];
}

function source(scale: number): Source {
	return {
		times: Array.from({ length: COUNT }, (_, i) => 1_000_000 + i * 60),
		values: Array.from({ length: COUNT }, (_, i) => Math.sin(i / (90 * scale)) * 10 + i / 997),
	};
}

/** The source's bars with times in `[from, to]`, column-major. */
function bars(feed: Source, from: number, to: number): Float64Array {
	const times: number[] = [];
	const values: number[] = [];
	feed.times.forEach((time, i) => {
		if (time >= from && time <= to) {
			times.push(time);
			values.push(feed.values[i]!);
		}
	});
	return line(times, values);
}

/** Removes the bars with times in `[from, to]` at the source. */
function remove(feed: Source, from: number, to: number): void {
	for (let i = feed.times.length - 1; i >= 0; i--) {
		if (feed.times[i]! >= from && feed.times[i]! <= to) {
			feed.times.splice(i, 1);
			feed.values.splice(i, 1);
		}
	}
}

/**
 * An engine with the given series (the first is the main one), all with datafeeds, whose limit
 * leaves room for four chunks beyond the levels: most rows are let go.
 */
function engine(feeds: Map<number, Source>): EngineCore {
	const core = new EngineCore();
	for (const [series, feed] of feeds) {
		run(core, { type: 'add', series, kind: 'line', fetchable: true });
		run(core, { type: 'set', series, count: feed.times.length, data: bars(feed, -Infinity, Infinity) });
	}
	while (core.backgroundStep()) {
		// Levels first, as a host builds them between commands.
	}
	const raw = [...feeds.values()].reduce((sum, feed) => sum + feed.times.length * 16, 0);
	run(core, { type: 'limit', bytes: core.byteLength - raw + CHUNK_ROWS * 16 * 4 });
	while (core.backgroundStep()) {
		// Rows over the limit go between commands.
	}
	return core;
}

/** Answers the fetch requests of an event, and of the events the answers bring, from the sources. */
function answer(core: EngineCore, feeds: Map<number, Source>, event: EngineEvent | null): EngineEvent | null {
	let last = event;
	const queue: FetchRequest[] = [...(event?.fetch ?? [])];
	while (queue.length > 0) {
		const request = queue.shift()!;
		const data = bars(feeds.get(request.series)!, request.from, request.to);
		last = run(core, { type: 'rows', request: request.id, count: data.length / 2, data });
		queue.push(...(last.fetch ?? []));
	}
	return last;
}

/** Runs a command, then background work to the end, answering every fetch as a datafeed would. */
function settle(core: EngineCore, feeds: Map<number, Source>, event: EngineEvent): void {
	answer(core, feeds, event);
	for (let i = 0; i < 10_000; i++) {
		const more = core.backgroundStep();
		const notice = core.takeNotice();
		answer(core, feeds, notice);
		if (!more && (notice?.fetch ?? []).length === 0 && !core.busy) {
			return;
		}
	}
	throw new Error('background work did not end');
}

/** Every value of a derived series, from a raw window over the whole history. */
function derived(core: EngineCore, feeds: Map<number, Source>, series: number): number[] {
	const event = answer(core, feeds, run(core, { type: 'window', level: 0, start: -1e9, count: 2e9, capacity: 0 }))!;
	const window = event.window!;
	expect(window.count).toBe(feeds.get(MAIN)!.times.length);
	const values = Array.from(window.series.find(entry => entry.series === series)!.data.subarray(0, window.count));
	// Back to a view of the latest bars, so the rows of the whole history can go again.
	run(core, { type: 'window', level: 0, start: event.end - 100, count: 100, capacity: 100 });
	while (core.backgroundStep()) {
		// Rows over the limit go between commands.
	}
	return values;
}

/** Values of a secondary series on the main timeline: NaN where it has no bar. */
function aligned(main: Source, other: Source): number[] {
	const byTime = new Map(other.times.map((time, i) => [time, other.values[i]!]));
	return main.times.map(time => byTime.get(time) ?? NaN);
}

function indicator(core: EngineCore, id: number, name: string, period: number, series: number, output: number) {
	return run(core, {
		type: 'indicator',
		id,
		name,
		params: [period],
		inputs: [{ series, column: 1 }],
		outputs: [output],
	});
}

/**
 * The first difference between two series of values, bit for bit (NaN equals NaN), or null. Large
 * arrays are compared here rather than by `toEqual`, whose report of a difference would list them.
 */
function difference(got: number[], want: number[]): string | null {
	if (got.length !== want.length) {
		return `${got.length} values instead of ${want.length}`;
	}
	for (let i = 0; i < got.length; i++) {
		if (!Object.is(got[i], want[i])) {
			return `value ${i}: ${got[i]} instead of ${want[i]}`;
		}
	}
	return null;
}

/** First row of the main timeline: not 0 once bars were removed at the head. */
function firstRow(core: EngineCore): number {
	return run(core, { type: 'window', level: 1, start: 0, count: 0, capacity: 0 }).first;
}

/**
 * What a computation from scratch gives over the source's values now, starting at row `first` as
 * the engine does: the slices a kernel runs in follow the chunks, and a windowed kernel sums from
 * the start of a slice, so a computation that starts elsewhere differs in the last bits.
 */
function scratch(definition: typeof ema, period: number, values: number[], first: number): number[] {
	return Array.from(computeIndicator(definition, new Float64Array([period]), [values], first)[0]!);
}

describe('indicators after corrections and deletions', () => {
	it('recompute a corrected bar, held or let go, to the bits of a computation from scratch', () => {
		const feed = source(1);
		const feeds = new Map([[MAIN, feed]]);
		const core = engine(feeds);
		settle(core, feeds, indicator(core, 10, 'ema', 30, MAIN, 11));
		expect(difference(derived(core, feeds, 11), scratch(ema, 30, feed.values, firstRow(core)))).toBeNull();

		// A recent bar, held: recomputed in place with the tick.
		const recent = COUNT - 200;
		feed.values[recent] = 123.25;
		settle(core, feeds, run(core, ticks([MAIN, feed.times[recent]!, 123.25])));
		const afterRecent = derived(core, feeds, 11);
		expect(difference(afterRecent, scratch(ema, 30, feed.values, firstRow(core)))).toBeNull();

		// An old bar that was let go: the correction waits for it, then everything after it changes.
		const old = CHUNK_ROWS * 5 + 77;
		feed.values[old] = -50.5;
		const waiting = run(core, ticks([MAIN, feed.times[old]!, -50.5]));
		expect(waiting.waiting).toEqual([0]);
		settle(core, feeds, waiting);
		const afterOld = derived(core, feeds, 11);
		expect(difference(afterOld, scratch(ema, 30, feed.values, firstRow(core)))).toBeNull();
		expect(afterOld[old + 1]).not.toBe(afterRecent[old + 1]);
		expect(core.memory.requests).toBe(0);
	});

	it('recompute after bars removed in the middle, at the head and at the tail', () => {
		const feed = source(1);
		const feeds = new Map([[MAIN, feed]]);
		const core = engine(feeds);
		settle(core, feeds, indicator(core, 10, 'ema', 20, MAIN, 11));
		// A chain: an average of the first indicator.
		settle(
			core,
			feeds,
			run(core, {
				type: 'indicator',
				id: 12,
				name: 'sma',
				params: [5],
				inputs: [{ series: 11, column: 0 }],
				outputs: [13],
			}),
		);
		const check = (): void => {
			const at = firstRow(core);
			const average = scratch(ema, 20, feed.values, at);
			expect(difference(derived(core, feeds, 11), average)).toBeNull();
			expect(difference(derived(core, feeds, 13), scratch(sma, 5, average, at))).toBeNull();
		};
		check();
		const removeBars = (from: number, to: number): void => {
			const range = { from: feed.times[from]!, to: feed.times[to]! };
			remove(feed, range.from, range.to);
			settle(core, feeds, run(core, { type: 'delete', series: MAIN, ...range }));
		};
		// In the middle, where rows were let go: the bars on one side move, a new epoch.
		removeBars(CHUNK_ROWS * 9 + 10, CHUNK_ROWS * 9 + 19);
		check();
		// At the head and at the tail: the other bars keep their indexes.
		removeBars(0, 4);
		check();
		removeBars(feed.times.length - 6, feed.times.length - 1);
		check();
		expect(core.memory.requests).toBe(0);
	});

	it('recompute an indicator of another series after its bars are removed or corrected', () => {
		const main = source(1);
		const other = source(2);
		const feeds = new Map([
			[MAIN, main],
			[SECOND, other],
		]);
		const core = engine(feeds);
		settle(core, feeds, indicator(core, 10, 'sma', 10, SECOND, 11));
		expect(difference(derived(core, feeds, 11), scratch(sma, 10, aligned(main, other), firstRow(core)))).toBeNull();

		// Bars of the other series removed: those main bars have no value of it any more.
		const from = other.times[CHUNK_ROWS * 7 + 3]!;
		const to = other.times[CHUNK_ROWS * 7 + 40]!;
		remove(other, from, to);
		settle(core, feeds, run(core, { type: 'delete', series: SECOND, from, to }));
		expect(difference(derived(core, feeds, 11), scratch(sma, 10, aligned(main, other), firstRow(core)))).toBeNull();

		// A correction of one of its bars far from the view.
		const at = CHUNK_ROWS * 12 + 5;
		other.values[at] = 77.125;
		settle(core, feeds, run(core, ticks([SECOND, other.times[at]!, 77.125])));
		expect(difference(derived(core, feeds, 11), scratch(sma, 10, aligned(main, other), firstRow(core)))).toBeNull();
		expect(core.memory.requests).toBe(0);
	});
});
