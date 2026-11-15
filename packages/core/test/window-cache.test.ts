import { type EngineEvent, TIME_PATCH } from '@lumen-charts/engine';
import { describe, expect, it } from 'vitest';
import { WindowCache } from '../src/data/window-cache';

const columns = (): number => 5;

function event(partial: Partial<EngineEvent>): EngineEvent {
	return { ack: 0, epoch: 1, first: 0, end: 0, stale: false, rejected: 0, ...partial };
}

function windowEvent(start: number, count: number, capacity: number): EngineEvent {
	const time = new Float64Array(capacity);
	const data = new Float64Array(capacity * 5);
	for (let i = 0; i < count; i++) {
		time[i] = (start + i) * 10;
		data[3 * capacity + i] = start + i;
	}
	return event({ end: start + count, window: { start, count, capacity, time, series: [{ series: 1, data }] } });
}

describe('WindowCache', () => {
	it('requests two screens on each side of the visible range', () => {
		const cache = new WindowCache();
		cache.apply(event({ end: 10_000, stale: true }), columns);
		const request = cache.plan(5000, 5100, 0, 10_000)!;
		// The visible bars are 5000 to 5100: a screen of 101.
		expect(request.start).toBe(5000 - 2 * 101);
		expect(request.start + request.count).toBe(5101 + 2 * 101);
		expect(request.capacity).toBe(request.count);
		expect(cache.loading).toBe(true);
		// Nothing more is requested while the answer is on its way.
		expect(cache.plan(0, 100, 0, 10_000)).toBeNull();
	});

	it('leaves room to append when the window reaches the last bar', () => {
		const cache = new WindowCache();
		cache.apply(event({ end: 10_000, stale: true }), columns);
		const request = cache.plan(9900, 10_000.5, 0, 10_000)!;
		expect(request.start + request.count).toBe(10_000);
		expect(request.capacity).toBeGreaterThanOrEqual(request.count + 1024);
	});

	it('does not request again until less than half a screen is left', () => {
		const cache = new WindowCache();
		cache.apply(windowEvent(4000, 2000, 2000), columns);
		expect(cache.loading).toBe(false);
		expect(cache.plan(5000, 5100, 0, 10_000)).toBeNull();
		expect(cache.plan(4060, 4160, 0, 10_000)).toBeNull();
		expect(cache.plan(4040, 4140, 0, 10_000)).not.toBeNull();
	});

	it('requests again when the engine says the window is stale', () => {
		const cache = new WindowCache();
		cache.apply(windowEvent(4000, 2000, 2000), columns);
		cache.apply(event({ end: 6000, stale: true }), columns);
		expect(cache.plan(5000, 5100, 0, 6000)).not.toBeNull();
	});

	it('patches rows in place and tracks what changed', () => {
		const cache = new WindowCache();
		cache.apply(windowEvent(100, 50, 64), columns);
		cache.apply(
			event({
				end: 150,
				patches: [{ series: 1, start: 149, count: 1, data: new Float64Array([1, 2, 3, 4, 5]) }],
			}),
			columns,
		);
		const block = cache.blocks.get(1)!;
		expect([0, 1, 2, 3, 4].map(c => block[c * 64 + 49])).toEqual([1, 2, 3, 4, 5]);
		expect([cache.dirtyLo, cache.dirtyHi]).toEqual([149, 150]);
		cache.clearDirty();
		expect(cache.dirtyHi).toBeLessThanOrEqual(cache.dirtyLo);
	});

	it('grows with appended bars until its buffers are full', () => {
		const cache = new WindowCache();
		cache.apply(windowEvent(100, 50, 52), columns);
		const version = cache.version;
		const append = (index: number): void => {
			cache.apply(
				event({
					end: index + 1,
					patches: [
						{ series: TIME_PATCH, start: index, count: 1, data: new Float64Array([index * 10]) },
						{ series: 1, start: index, count: 1, data: new Float64Array([9, 9, 9, index, 9]) },
					],
				}),
				columns,
			);
		};
		append(150);
		append(151);
		expect(cache.count).toBe(52);
		expect(cache.time[51]).toBe(1510);
		expect(cache.blocks.get(1)![3 * 52 + 51]).toBe(151);
		expect(cache.version).toBe(version);
		// No room for a third bar: the window stays as it is and a new one is requested.
		append(152);
		expect(cache.count).toBe(52);
		expect(cache.plan(140, 152.5, 0, 153)).not.toBeNull();
	});

	it('reads rows past the snapshot as missing until a patch fills them', () => {
		const cache = new WindowCache();
		cache.apply(windowEvent(0, 10, 16), columns);
		const block = cache.blocks.get(1)!;
		expect(block[3 * 16 + 9]).toBe(9);
		expect(block[3 * 16 + 10]).toBeNaN();
	});

	it('creates a block for a series first seen in a patch', () => {
		const cache = new WindowCache();
		cache.apply(windowEvent(0, 10, 16), columns);
		const version = cache.version;
		cache.apply(event({ end: 10, patches: [{ series: 2, start: 4, count: 1, data: new Float64Array([7]) }] }), () => 1);
		const block = cache.blocks.get(2)!;
		expect(block.length).toBe(16);
		expect(block[4]).toBe(7);
		expect(block[3]).toBeNaN();
		expect(cache.version).toBeGreaterThan(version);
	});

	it('ignores patches that would leave a gap', () => {
		const cache = new WindowCache();
		cache.apply(windowEvent(0, 10, 16), columns);
		cache.apply(
			event({
				end: 1000,
				patches: [{ series: TIME_PATCH, start: 999, count: 1, data: new Float64Array([1]) }],
			}),
			columns,
		);
		expect(cache.count).toBe(10);
	});

	it('drops everything when the epoch changes', () => {
		const cache = new WindowCache();
		cache.apply(windowEvent(0, 10, 16), columns);
		cache.apply(event({ epoch: 2, end: 500 }), columns);
		expect(cache.count).toBe(0);
		expect(cache.blocks.size).toBe(0);
		expect(cache.plan(400, 500, 0, 500)).not.toBeNull();
	});
});
