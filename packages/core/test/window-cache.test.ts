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
	return event({
		end: start + count,
		window: { level: 0, start, count, capacity, time, series: [{ series: 1, data }] },
	});
}

describe('WindowCache', () => {
	it('requests two screens on each side of the visible range', () => {
		const cache = new WindowCache();
		cache.apply(event({ end: 10_000, stale: true }), columns);
		const request = cache.plan(0, 5000, 5100, 0, 10_000)!;
		// The visible bars are 5000 to 5100: a screen of 101.
		expect(request.start).toBe(5000 - 2 * 101);
		expect(request.start + request.count).toBe(5101 + 2 * 101);
		expect(request.capacity).toBe(request.count);
		expect(cache.raw.loading).toBe(true);
		// Nothing more is requested while the answer is on its way.
		expect(cache.plan(0, 0, 100, 0, 10_000)).toBeNull();
	});

	it('leaves room to append when the window reaches the last bar', () => {
		const cache = new WindowCache();
		cache.apply(event({ end: 10_000, stale: true }), columns);
		const request = cache.plan(0, 9900, 10_000.5, 0, 10_000)!;
		expect(request.start + request.count).toBe(10_000);
		expect(request.capacity).toBe(request.count + 1024);
		// The spare room does not grow with the number of visible bars.
		const all = new WindowCache();
		all.apply(event({ end: 1_000_000, stale: true }), columns);
		const whole = all.plan(0, -0.5, 999_999.5, 0, 1_000_000)!;
		expect(whole.capacity).toBe(1_000_000 + 1024);
	});

	it('extends only from the last bar of the timeline', () => {
		const cache = new WindowCache();
		// A snapshot that stops one bar short of the end, with spare room.
		const snapshot = windowEvent(0, 10, 16);
		snapshot.end = 11;
		cache.apply(snapshot, columns);
		// A patch for bar 10 follows the cached rows directly, but other series' values for that
		// bar were never delivered, so the row must not become visible.
		cache.apply(
			event({
				end: 11,
				patches: [
					{ series: TIME_PATCH, level: 0, start: 10, count: 1, data: new Float64Array([100]) },
					{ series: 1, level: 0, start: 10, count: 1, data: new Float64Array([1, 1, 1, 1, 1]) },
				],
			}),
			columns,
		);
		expect(cache.raw.count).toBe(10);
		expect(cache.plan(0, 0, 10.5, 0, 11)).not.toBeNull();
	});

	it('lets go of a request the engine failed to answer', () => {
		const cache = new WindowCache();
		cache.apply(event({ end: 100, stale: true }), columns);
		expect(cache.plan(0, 0, 50, 0, 100)).not.toBeNull();
		expect(cache.raw.loading).toBe(true);
		cache.apply(event({ end: 100, stale: true, failed: true }), columns);
		expect(cache.raw.loading).toBe(false);
	});

	it('does not request again until less than half a screen is left', () => {
		const cache = new WindowCache();
		cache.apply(windowEvent(4000, 2000, 2000), columns);
		expect(cache.raw.loading).toBe(false);
		expect(cache.plan(0, 5000, 5100, 0, 10_000)).toBeNull();
		expect(cache.plan(0, 4060, 4160, 0, 10_000)).toBeNull();
		expect(cache.plan(0, 4040, 4140, 0, 10_000)).not.toBeNull();
	});

	it('requests again when the engine says the window is stale', () => {
		const cache = new WindowCache();
		cache.apply(windowEvent(4000, 2000, 2000), columns);
		cache.apply(event({ end: 6000, stale: true }), columns);
		expect(cache.plan(0, 5000, 5100, 0, 6000)).not.toBeNull();
	});

	it('patches rows in place and tracks what changed', () => {
		const cache = new WindowCache();
		cache.apply(windowEvent(100, 50, 64), columns);
		cache.apply(
			event({
				end: 150,
				patches: [{ series: 1, level: 0, start: 149, count: 1, data: new Float64Array([1, 2, 3, 4, 5]) }],
			}),
			columns,
		);
		const block = cache.raw.blocks.get(1)!;
		expect([0, 1, 2, 3, 4].map(c => block[c * 64 + 49])).toEqual([1, 2, 3, 4, 5]);
		expect([cache.raw.dirtyLo, cache.raw.dirtyHi]).toEqual([149, 150]);
		cache.clearDirty();
		expect(cache.raw.dirtyHi).toBeLessThanOrEqual(cache.raw.dirtyLo);
	});

	it('grows with appended bars until its buffers are full', () => {
		const cache = new WindowCache();
		cache.apply(windowEvent(100, 50, 52), columns);
		const version = cache.raw.version;
		const append = (index: number): void => {
			cache.apply(
				event({
					end: index + 1,
					patches: [
						{ series: TIME_PATCH, level: 0, start: index, count: 1, data: new Float64Array([index * 10]) },
						{ series: 1, level: 0, start: index, count: 1, data: new Float64Array([9, 9, 9, index, 9]) },
					],
				}),
				columns,
			);
		};
		append(150);
		append(151);
		expect(cache.raw.count).toBe(52);
		expect(cache.raw.time[51]).toBe(1510);
		expect(cache.raw.blocks.get(1)![3 * 52 + 51]).toBe(151);
		expect(cache.raw.version).toBe(version);
		// No room for a third bar: the window stays as it is and a new one is requested.
		append(152);
		expect(cache.raw.count).toBe(52);
		expect(cache.plan(0, 140, 152.5, 0, 153)).not.toBeNull();
	});

	it('reads rows past the snapshot as missing until a patch fills them', () => {
		const cache = new WindowCache();
		cache.apply(windowEvent(0, 10, 16), columns);
		const block = cache.raw.blocks.get(1)!;
		expect(block[3 * 16 + 9]).toBe(9);
		expect(block[3 * 16 + 10]).toBeNaN();
	});

	it('creates a block for a series first seen in a patch', () => {
		const cache = new WindowCache();
		cache.apply(windowEvent(0, 10, 16), columns);
		const version = cache.raw.version;
		cache.apply(
			event({ end: 10, patches: [{ series: 2, level: 0, start: 4, count: 1, data: new Float64Array([7]) }] }),
			() => 1,
		);
		const block = cache.raw.blocks.get(2)!;
		expect(block.length).toBe(16);
		expect(block[4]).toBe(7);
		expect(block[3]).toBeNaN();
		expect(cache.raw.version).toBeGreaterThan(version);
	});

	it('ignores patches that would leave a gap', () => {
		const cache = new WindowCache();
		cache.apply(windowEvent(0, 10, 16), columns);
		cache.apply(
			event({
				end: 1000,
				patches: [{ series: TIME_PATCH, level: 0, start: 999, count: 1, data: new Float64Array([1]) }],
			}),
			columns,
		);
		expect(cache.raw.count).toBe(10);
	});

	it('drops everything when the epoch changes', () => {
		const cache = new WindowCache();
		cache.apply(windowEvent(0, 10, 16), columns);
		cache.apply(event({ epoch: 2, end: 500 }), columns);
		expect(cache.raw.count).toBe(0);
		expect(cache.raw.blocks.size).toBe(0);
		expect(cache.plan(0, 400, 500, 0, 500)).not.toBeNull();
	});
});

/** Snapshot of `level` with buckets `[start, start + count)`; the close of bucket `b` is `b`. */
function levelEvent(level: number, start: number, count: number, capacity: number, end: number): EngineEvent {
	const time = new Float64Array(capacity);
	const data = new Float64Array(capacity * 5);
	for (let i = 0; i < count; i++) {
		time[i] = (start + i) * 160;
		data[3 * capacity + i] = start + i;
	}
	return event({ end, window: { level, start, count, capacity, time, series: [{ series: 1, data }] } });
}

describe('WindowCache by level', () => {
	it('plans a coarse level in buckets, with tail room in buckets', () => {
		const cache = new WindowCache();
		cache.apply(event({ end: 1_000_000, stale: true }), columns);
		// Rows 500,000 to 600,000 at level 2 (64 rows per bucket): buckets 7812 to 9375.
		const request = cache.plan(2, 500_000, 600_000, 0, 1_000_000)!;
		const screen = 9376 - 7812;
		expect(request).toEqual({ level: 2, start: 7812 - 2 * screen, count: 5 * screen, capacity: 5 * screen });
		expect(cache.level(2).loading).toBe(true);
		// Other levels plan on their own.
		expect(cache.plan(0, 500_000, 500_100, 0, 1_000_000)).not.toBeNull();
		const tail = cache.plan(1, 990_000, 999_999.5, 0, 1_000_000)!;
		expect(tail.start + tail.count).toBe(62_500);
		expect(tail.capacity).toBe(tail.count + 64);
	});

	it('patches each window only with the patches of its level, and grows it from the tail', () => {
		const cache = new WindowCache();
		// 1,000 rows: buckets 0 to 62 at level 1, the last one partial.
		cache.apply(levelEvent(1, 0, 63, 80, 1000), columns);
		cache.apply(windowEvent(900, 100, 200), columns);
		const raw = cache.raw;
		const level = cache.level(1);
		cache.apply(
			event({
				end: 1009,
				patches: [
					{ series: TIME_PATCH, level: 0, start: 1000, count: 9, data: new Float64Array(9).fill(7) },
					{ series: 1, level: 0, start: 1000, count: 9, data: new Float64Array(45).fill(1) },
					// Bucket 62 (rows 992 to 1007) changed and bucket 63 opened with row 1008.
					{ series: TIME_PATCH, level: 1, start: 62, count: 2, data: new Float64Array([9920, 10_080]) },
					{ series: 1, level: 1, start: 62, count: 2, data: new Float64Array([0, 0, 0, 0, 0, 0, 62.5, 63.5, 0, 0]) },
				],
			}),
			columns,
		);
		expect(raw.count).toBe(109);
		expect(level.count).toBe(64);
		const block = level.blocks.get(1)!;
		expect([block[3 * 80 + 61], block[3 * 80 + 62], block[3 * 80 + 63]]).toEqual([61, 62.5, 63.5]);
		expect(level.time[63]).toBe(10_080);
		expect([level.dirtyLo, level.dirtyHi]).toEqual([62, 64]);
		expect([raw.dirtyLo, raw.dirtyHi]).toEqual([1000, 1009]);
	});

	it('draws from the level wanted, else the nearest level that covers the view', () => {
		const cache = new WindowCache();
		cache.apply(levelEvent(1, 0, 6250, 6250, 100_000), columns);
		cache.apply(levelEvent(3, 0, 391, 391, 100_000), columns);
		cache.apply(windowEvent(40_000, 20_000, 20_000), columns);
		const source = (level: number, from: number, to: number) => cache.source(level, from, to, 0, 100_000)?.level;
		expect(source(1, 0, 100_000)).toBe(1);
		// Level 2 is missing: levels 1 and 3 are as near, and the coarser one is cheaper to draw.
		expect(source(2, 0, 100_000)).toBe(3);
		expect(source(0, 45_000, 50_000)).toBe(0);
		// The raw rows do not cover this view; level 1 is the nearest that does.
		expect(source(0, 30_000, 50_000)).toBe(1);
		cache.retain(0, 0);
		expect(cache.held(1)).not.toBeNull();
		expect(cache.held(3)).toBeNull();
		// Nothing covers it: the window that shows most of it.
		cache.level(1).release();
		expect(source(0, 30_000, 50_000)).toBe(0);
		expect(source(0, 70_000, 80_000)).toBeUndefined();
	});

	it('keeps the window drawn even when it is far from the level wanted', () => {
		const cache = new WindowCache();
		cache.apply(windowEvent(0, 1000, 1000), columns);
		cache.apply(levelEvent(1, 0, 63, 63, 1000), columns);
		cache.retain(4, 0);
		expect(cache.held(0)).not.toBeNull();
		expect(cache.held(1)).toBeNull();
	});
});
