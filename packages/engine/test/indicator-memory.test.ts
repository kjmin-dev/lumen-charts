import {
	CHUNK_ROWS,
	EngineCore,
	type EngineEvent,
	type FetchRequest,
	computeIndicator,
	ema,
	sma,
} from '@lumen-ticks/engine';
import { describe, expect, it } from 'vitest';
import { line, run } from './helpers';

const COUNT = CHUNK_ROWS * 24;
const times = Array.from({ length: COUNT }, (_, i) => 1_000_000 + i * 60);
const values = Array.from({ length: COUNT }, (_, i) => Math.sin(i / 100) * 10 + i / 1000);

function rows(start: number, end: number): Float64Array {
	return line(times.slice(start, end), values.slice(start, end));
}

/** Bytes of one chunk of a line let go: its times and values. */
const CHUNK = CHUNK_ROWS * 16;

/** A fetchable line of 24 chunks that has let go of most of its rows. */
function loaded(): EngineCore {
	const core = new EngineCore();
	run(core, { type: 'add', series: 1, kind: 'line', fetchable: true });
	run(core, { type: 'set', series: 1, count: COUNT, data: rows(0, COUNT) });
	while (core.backgroundStep()) {
		// Levels first, as a host builds them between commands.
	}
	const floor = core.byteLength - COUNT * 16;
	run(core, { type: 'limit', bytes: floor + CHUNK * 4 });
	return core;
}

/**
 * Runs background work to the end, answering every fetch request from the data set as a datafeed
 * would, and records the most memory held on the way.
 */
function settle(core: EngineCore): { fetched: number; peak: number } {
	let fetched = 0;
	let peak = core.byteLength;
	const answer = (event: EngineEvent | null): void => {
		for (const request of event?.fetch ?? []) {
			fetched += request.end - request.start;
			const data = rows(request.start, request.end);
			answer(run(core, { type: 'rows', request: request.id, count: data.length / 2, data }));
			peak = Math.max(peak, core.byteLength);
		}
	};
	for (let i = 0; i < 10_000; i++) {
		const more = core.backgroundStep();
		peak = Math.max(peak, core.byteLength);
		const notice = core.takeNotice();
		answer(notice);
		if (!more && (notice?.fetch ?? []).length === 0 && !core.busy) {
			break;
		}
	}
	return { fetched, peak };
}

/** Values of a derived series over the whole history, answering the fetches the raw window waits for. */
function derived(core: EngineCore, series: number): Float64Array {
	let event = run(core, { type: 'window', level: 0, start: 0, count: COUNT, capacity: COUNT });
	const requests = [...(event.fetch ?? [])];
	while (event.window === undefined) {
		const request = requests.shift()!;
		const data = rows(request.start, request.end);
		event = run(core, { type: 'rows', request: request.id, count: data.length / 2, data });
		requests.push(...(event.fetch ?? []));
	}
	return event.window.series.find(entry => entry.series === series)!.data;
}

describe('indicators under a memory limit', () => {
	it('fetches rows that were let go to compute an indicator, and lets them go again', () => {
		const core = loaded();
		const { limit } = core.memory;
		expect(core.byteLength).toBeLessThanOrEqual(limit);
		run(core, {
			type: 'indicator',
			id: 10,
			name: 'ema',
			params: [50],
			inputs: [{ series: 1, column: 1 }],
			outputs: [11],
		});
		const { fetched, peak } = settle(core);
		// Most of the history had to come back, a window of chunks at a time.
		expect(fetched).toBeGreaterThan(COUNT / 2);
		const expected = computeIndicator(ema, new Float64Array([50]), [values])[0]!;
		expect(Array.from(derived(core, 11))).toEqual(Array.from(expected));
		// Once the recomputation is past them, values are let go again: all that can go has gone
		// (the outputs, which stay, take up the room), and at no point were more than the chunks the
		// recomputation reads ahead back in memory.
		expect(core.memory.evictable).toBe(0);
		expect(peak - core.byteLength).toBeLessThan(20 * CHUNK);
	});

	it('gives the recomputation up when the rows cannot be fetched, keeping the old values', () => {
		const core = loaded();
		run(core, {
			type: 'indicator',
			id: 10,
			name: 'sma',
			params: [20],
			inputs: [{ series: 1, column: 1 }],
			outputs: [11],
		});
		// Every fetch fails, the ones asked for ahead and the one the recomputation then waits for.
		// Rows still wanted are asked for again at once, as the chart would after its pause.
		let last: EngineEvent | null = null;
		let again: FetchRequest[] = [];
		for (let i = 0; i < 100; i++) {
			core.backgroundStep();
			const requests = [...again, ...(core.takeNotice()?.fetch ?? [])];
			again = [];
			for (const request of requests) {
				last = run(core, { type: 'rows', request: request.id, count: 0, data: null });
				again.push(...(last.fetch ?? []));
			}
		}
		expect(last!.restored!.outcome).toBe('failed');
		expect(last!.computing).toBeUndefined();
		expect(core.busy).toBe(false);
		expect(Array.from(derived(core, 11).subarray(0, 100)).every(v => v !== v)).toBe(true);
		// The next change computes it again, this time with the rows.
		run(core, {
			type: 'indicator',
			id: 10,
			name: 'sma',
			params: [20],
			inputs: [{ series: 1, column: 1 }],
			outputs: [11],
		});
		settle(core);
		const expected = computeIndicator(sma, new Float64Array([20]), [values])[0]!;
		expect(Array.from(derived(core, 11))).toEqual(Array.from(expected));
	});
});
