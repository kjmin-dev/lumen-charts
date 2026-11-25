import type { EngineClient, EngineEvent, MarksData } from '@lumen-ticks/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FetchingSeries, MarkFetches } from '../src/marks/fetches';

function event(fields: Partial<EngineEvent>): EngineEvent {
	return { ack: 1, epoch: 0, first: 0, end: 0, stale: false, rejected: 0, ...fields };
}

const ROWS: MarksData = {
	kind: 'scatter',
	count: 1,
	time: Float64Array.of(5),
	price: Float64Array.of(1),
	value: null,
};

describe('marks fetched again from a datafeed', () => {
	let restored: [number, MarksData | null][];
	let engine: EngineClient;
	let series: FetchingSeries & { retries: number };
	let settled: number;
	let fetches: MarkFetches;

	beforeEach(() => {
		vi.useFakeTimers();
		restored = [];
		settled = 0;
		engine = {
			restoreMarks: (id: number, data: MarksData | null) => {
				restored.push([id, data]);
				return 0;
			},
		} as unknown as EngineClient;
		series = {
			engineId: 7,
			datafeed: null,
			packFetched: data => data as MarksData,
			retries: 0,
			retry() {
				this.retries++;
			},
			fetchBackoff: 0,
		};
		fetches = new MarkFetches(
			() => engine,
			id => (id === 7 ? series : undefined),
			() => settled++,
		);
	});

	afterEach(() => {
		fetches.destroy();
		vi.useRealTimers();
	});

	it('hands back what the datafeed returns for the times asked, and counts the requests out', async () => {
		const calls: { from: number; to: number }[] = [];
		series.datafeed = {
			getMarks: ({ from, to }) => {
				calls.push({ from, to });
				return Promise.resolve(ROWS);
			},
		};
		fetches.handle(event({ marksFetch: [{ id: 3, series: 7, from: 1, to: 9, count: 1 }] }));
		expect(fetches.fetching).toBe(1);
		expect(calls).toEqual([{ from: 1, to: 9 }]);
		await vi.runAllTicks();
		await Promise.resolve();
		expect(fetches.fetching).toBe(0);
		expect(restored).toEqual([[3, ROWS]]);
		expect(settled).toBe(1);
		// The engine took them: no pause after.
		fetches.handle(event({ marksRestored: { request: 3, series: 7, outcome: 'restored' } }));
		expect(series.fetchBackoff).toBe(0);
	});

	it('answers for a series without a datafeed, and ignores requests of series it does not know', () => {
		fetches.handle(
			event({
				marksFetch: [
					{ id: 1, series: 7, from: 1, to: 2, count: 1 },
					{ id: 2, series: 99, from: 1, to: 2, count: 1 },
				],
			}),
		);
		expect(restored).toEqual([[1, null]]);
		expect(fetches.fetching).toBe(0);
	});

	it('pauses a series after a failure, from 1 s doubling to 30 s, then asks for its view again', async () => {
		series.datafeed = { getMarks: () => Promise.reject(new Error('offline')) };
		const fail = async (id: number, pause: number): Promise<void> => {
			fetches.handle(event({ marksFetch: [{ id, series: 7, from: 1, to: 2, count: 1 }] }));
			await vi.advanceTimersByTimeAsync(0);
			expect(restored.at(-1)).toEqual([id, null]);
			expect(series.fetchBackoff).toBe(pause);
			const before = series.retries;
			vi.advanceTimersByTime(pause - 1);
			expect(series.retries).toBe(before);
			vi.advanceTimersByTime(1);
			expect(series.retries).toBe(before + 1);
		};
		await fail(1, 1000);
		await fail(2, 2000);
		await fail(3, 4000);
		series.fetchBackoff = 20_000;
		fetches.handle(event({ marksFetch: [{ id: 9, series: 7, from: 1, to: 2, count: 1 }] }));
		await Promise.resolve();
		await Promise.resolve();
		expect(series.fetchBackoff).toBe(30_000);
	});

	it('warns of marks that differ from those let go, and pauses before asking again', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		series.datafeed = { getMarks: () => Promise.resolve(ROWS) };
		fetches.handle(event({ marksFetch: [{ id: 4, series: 7, from: 1, to: 2, count: 1 }] }));
		return Promise.resolve()
			.then(() => Promise.resolve())
			.then(() => {
				fetches.handle(event({ marksRestored: { request: 4, series: 7, outcome: 'mismatch' } }));
				expect(warn).toHaveBeenCalledOnce();
				expect(series.fetchBackoff).toBe(1000);
				warn.mockRestore();
			});
	});

	it('aborts a request the engine cancels, and drops its answer', async () => {
		let signal: AbortSignal | null = null;
		const answer: { resolve: (data: MarksData) => void } = { resolve: () => {} };
		const promise = new Promise<MarksData>(resolve => {
			answer.resolve = resolve;
		});
		series.datafeed = {
			getMarks: request => {
				signal = request.signal;
				return promise;
			},
		};
		fetches.handle(event({ marksFetch: [{ id: 5, series: 7, from: 1, to: 2, count: 1 }] }));
		fetches.handle(event({ marksCancel: [5] }));
		expect(signal!.aborted).toBe(true);
		expect(fetches.fetching).toBe(0);
		answer.resolve(ROWS);
		await Promise.resolve();
		expect(restored).toEqual([]);
	});
});
