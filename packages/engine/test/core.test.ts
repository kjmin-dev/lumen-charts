import { CHUNK_ROWS, EngineCore, type EngineEvent, TIME_PATCH } from '@lumen-charts/engine';
import { describe, expect, it } from 'vitest';
import { line, ohlcv, random, run, ticks } from './helpers';

const MIN = 60_000;

function column(event: EngineEvent, series: number, c: number): number[] {
	const window = event.window!;
	const block = window.series.find(entry => entry.series === series)!;
	return [...block.data.subarray(c * window.capacity, c * window.capacity + window.count)];
}

describe('EngineCore', () => {
	it('loads a series and reports the extent', () => {
		const core = new EngineCore();
		run(core, { type: 'add', series: 1, kind: 'ohlcv' });
		const count = CHUNK_ROWS * 2 + 5;
		const event = run(core, { type: 'set', series: 1, count, data: ohlcv(count) });
		expect(event.first).toBe(0);
		expect(event.end).toBe(count);
		expect(event.stale).toBe(true);
		expect(event.rejected).toBe(0);
		expect(event.epoch).toBe(1);
	});

	it('stops loading at the first row whose time does not increase', () => {
		const core = new EngineCore();
		run(core, { type: 'add', series: 1, kind: 'line' });
		const event = run(core, { type: 'set', series: 1, count: 5, data: line([1, 2, 2, 4, 5], [1, 2, 3, 4, 5]) });
		expect(event.end).toBe(2);
		expect(event.rejected).toBe(3);
	});

	it('returns a window clamped to the extent with room to grow', () => {
		const core = new EngineCore();
		run(core, { type: 'add', series: 1, kind: 'ohlcv' });
		const data = ohlcv(100);
		run(core, { type: 'set', series: 1, count: 100, data });
		const event = run(core, { type: 'window', start: 90, count: 50, capacity: 64 });
		const window = event.window!;
		expect(window.start).toBe(90);
		expect(window.count).toBe(10);
		expect(window.capacity).toBe(64);
		expect(window.time.length).toBe(64);
		expect([...window.time.subarray(0, 10)]).toEqual([...data.subarray(90, 100)]);
		expect(column(event, 1, 3)).toEqual([...data.subarray(400 + 90, 500)]);

		const before = run(core, { type: 'window', start: -20, count: 10, capacity: 0 }).window!;
		expect(before.start).toBe(0);
		expect(before.count).toBe(0);
	});

	it('patches the tail on ticks and appends new bars', () => {
		const core = new EngineCore();
		run(core, { type: 'add', series: 1, kind: 'ohlcv' });
		run(core, { type: 'set', series: 1, count: 10, data: ohlcv(10, 0, MIN) });
		const update = run(core, ticks([1, 9 * MIN, 1, 2, 0.5, 1.5, 7]));
		expect(update.end).toBe(10);
		expect(update.stale).toBe(false);
		const [time, values] = update.patches!;
		expect(time).toMatchObject({ series: TIME_PATCH, start: 9, count: 1 });
		expect(values).toMatchObject({ series: 1, start: 9, count: 1 });
		expect([...values!.data]).toEqual([1, 2, 0.5, 1.5, 7]);

		// One batch that updates the tail, opens two bars and updates the newest again.
		const batch = run(
			core,
			ticks(
				[1, 9 * MIN, 1, 3, 0.5, 2.5, 8],
				[1, 10 * MIN, 5, 5, 5, 5, 1],
				[1, 11 * MIN, 6, 6, 6, 6, 1],
				[1, 11 * MIN, 6, 7, 6, 7, 2],
			),
		);
		expect(batch.end).toBe(12);
		const patch = batch.patches!.find(entry => entry.series === 1)!;
		expect(patch.start).toBe(9);
		expect(patch.count).toBe(3);
		// Column-major: three closes sit after three opens, highs and lows.
		expect([...patch.data.subarray(9, 12)]).toEqual([2.5, 5, 7]);
		expect([...batch.patches!.find(entry => entry.series === TIME_PATCH)!.data]).toEqual([9 * MIN, 10 * MIN, 11 * MIN]);
	});

	it('corrects an older bar and refuses to insert one', () => {
		const core = new EngineCore();
		run(core, { type: 'add', series: 1, kind: 'ohlcv' });
		run(core, { type: 'set', series: 1, count: 10, data: ohlcv(10, 0, MIN) });
		const fixed = run(core, ticks([1, 4 * MIN, 9, 9, 9, 9, 9]));
		expect(fixed.rejected).toBe(0);
		expect(fixed.patches!.find(entry => entry.series === 1)!.start).toBe(4);
		const refused = run(core, ticks([1, 4.5 * MIN, 9, 9, 9, 9, 9], [7, 0, 1], [1, NaN, 1]));
		expect(refused.rejected).toBe(3);
		expect(refused.patches).toBeUndefined();
		expect(refused.end).toBe(10);
	});

	it('keeps indexes stable when history is prepended to the main series', () => {
		const core = new EngineCore();
		run(core, { type: 'add', series: 1, kind: 'ohlcv' });
		const first = run(core, { type: 'set', series: 1, count: 10, data: ohlcv(10, 100 * MIN, MIN) });
		const older = CHUNK_ROWS + 7;
		const event = run(core, {
			type: 'prepend',
			series: 1,
			count: older,
			data: ohlcv(older, (100 - older) * MIN, MIN),
		});
		expect(event.first).toBe(-older);
		expect(event.end).toBe(10);
		expect(event.stale).toBe(false);
		expect(event.epoch).toBe(first.epoch);
		const window = run(core, { type: 'window', start: -2, count: 4, capacity: 0 }).window!;
		expect([...window.time.subarray(0, 4)]).toEqual([98 * MIN, 99 * MIN, 100 * MIN, 101 * MIN]);
	});

	it('rejects prepended rows that overlap existing history', () => {
		const core = new EngineCore();
		run(core, { type: 'add', series: 1, kind: 'line' });
		run(core, { type: 'set', series: 1, count: 2, data: line([10, 11], [1, 2]) });
		const event = run(core, { type: 'prepend', series: 1, count: 4, data: line([7, 8, 12, 9], [1, 2, 3, 4]) });
		// Walking backward from the newest row: 9 fits, 12 does not, and everything older is dropped with it.
		expect(event.rejected).toBe(3);
		expect(event.first).toBe(-1);
	});

	it('starts a new epoch when the main timeline is replaced', () => {
		const core = new EngineCore();
		run(core, { type: 'add', series: 1, kind: 'ohlcv' });
		run(core, { type: 'add', series: 2, kind: 'line' });
		const a = run(core, { type: 'set', series: 2, count: 2, data: line([1, 2], [1, 2]) });
		// Series 1 was created first, so once it has data it becomes the main series.
		const b = run(core, { type: 'set', series: 1, count: 3, data: ohlcv(3) });
		expect(b.epoch).toBeGreaterThan(a.epoch);
		expect(b.end).toBe(3);
		const c = run(core, { type: 'set', series: 1, count: 4, data: ohlcv(4) });
		expect(c.epoch).toBeGreaterThan(b.epoch);
		const d = run(core, { type: 'remove', series: 1 });
		expect(d.epoch).toBeGreaterThan(c.epoch);
		expect(d.stale).toBe(true);
		expect(d.end).toBe(2);
	});

	it('maps a secondary series onto the main timeline', () => {
		const core = new EngineCore();
		run(core, { type: 'add', series: 1, kind: 'ohlcv' });
		run(core, { type: 'add', series: 2, kind: 'line' });
		run(core, { type: 'add', series: 3, kind: 'ohlcv' });
		// Main bars at 10, 20, 30, 40.
		run(core, { type: 'set', series: 1, count: 4, data: ohlcv(4, 10, 10) });
		// 5 comes before the first main bar and is not shown; 12 and 19 share bar 0; 30 hits bar 2; 55 joins the last.
		run(core, { type: 'set', series: 2, count: 5, data: line([5, 12, 19, 30, 55], [1, 2, 3, 4, 5]) });
		const secondary = new Float64Array(3 * 6);
		secondary.set([21, 25, 40]); // times
		secondary.set([7, 8, 9], 3); // open
		secondary.set([9, 12, 9], 6); // high
		secondary.set([6, 5, 9], 9); // low
		secondary.set([8, 11, 9], 12); // close
		secondary.set([100, 50, 1], 15); // volume
		run(core, { type: 'set', series: 3, count: 3, data: secondary });

		const event = run(core, { type: 'window', start: 0, count: 4, capacity: 8 });
		expect(column(event, 2, 0)).toEqual([3, NaN, 4, 5]);
		expect(column(event, 3, 0)).toEqual([NaN, 7, NaN, 9]);
		expect(column(event, 3, 1)).toEqual([NaN, 12, NaN, 9]);
		expect(column(event, 3, 2)).toEqual([NaN, 5, NaN, 9]);
		expect(column(event, 3, 3)).toEqual([NaN, 11, NaN, 9]);
		expect(column(event, 3, 4)).toEqual([NaN, 150, NaN, 1]);
	});

	it('patches secondary ticks at the main bar they belong to', () => {
		const core = new EngineCore();
		run(core, { type: 'add', series: 1, kind: 'ohlcv' });
		run(core, { type: 'add', series: 2, kind: 'line' });
		run(core, { type: 'set', series: 1, count: 4, data: ohlcv(4, 10, 10) });
		run(core, { type: 'set', series: 2, count: 1, data: line([10], [1]) });

		const inside = run(core, ticks([2, 25, 42]));
		expect(inside.patches).toEqual([{ series: 2, start: 1, count: 1, data: new Float64Array([42]) }]);
		const beyond = run(core, ticks([2, 47, 43]));
		expect(beyond.patches).toEqual([{ series: 2, start: 3, count: 1, data: new Float64Array([43]) }]);

		// A new main bar at 45 takes over the secondary bar at 47 from the previous main bar.
		const moved = run(core, ticks([1, 45, 1, 1, 1, 1, 1]));
		const patch = moved.patches!.find(entry => entry.series === 2)!;
		expect(patch.start).toBe(3);
		expect([...patch.data]).toEqual([NaN, 43]);
	});

	it('marks the window stale when a secondary series is replaced', () => {
		const core = new EngineCore();
		run(core, { type: 'add', series: 1, kind: 'ohlcv' });
		run(core, { type: 'add', series: 2, kind: 'line' });
		const main = run(core, { type: 'set', series: 1, count: 4, data: ohlcv(4, 10, 10) });
		const secondary = run(core, { type: 'set', series: 2, count: 1, data: line([10], [1]) });
		expect(secondary.stale).toBe(true);
		expect(secondary.epoch).toBe(main.epoch);
	});

	it('aligns large secondary series like a straightforward reference', () => {
		const next = random(7);
		const mainCount = CHUNK_ROWS * 2 + 321;
		const mainTimes: number[] = [];
		let t = 1000;
		for (let i = 0; i < mainCount; i++) {
			t += 1 + Math.floor(next() * 5);
			mainTimes.push(t);
		}
		const secondaryTimes: number[] = [];
		const secondaryValues: number[] = [];
		t = 900;
		while (t < mainTimes[mainCount - 1]! + 50) {
			t += 1 + Math.floor(next() * 9);
			secondaryTimes.push(t);
			secondaryValues.push(next());
		}
		const mainData = ohlcv(mainCount);
		mainData.set(mainTimes, 0);

		const core = new EngineCore();
		run(core, { type: 'add', series: 1, kind: 'ohlcv' });
		run(core, { type: 'add', series: 2, kind: 'line' });
		run(core, { type: 'set', series: 1, count: mainCount, data: mainData });
		run(core, {
			type: 'set',
			series: 2,
			count: secondaryTimes.length,
			data: line(secondaryTimes, secondaryValues),
		});

		const expected = Array.from({ length: mainCount }, () => NaN);
		for (let j = 0; j < secondaryTimes.length; j++) {
			let index = -1;
			for (let lo = 0, hi = mainCount; lo < hi;) {
				const mid = (lo + hi) >> 1;
				if (mainTimes[mid]! <= secondaryTimes[j]!) {
					index = mid;
					lo = mid + 1;
				} else {
					hi = mid;
				}
			}
			if (index >= 0) {
				expected[index] = secondaryValues[j]!;
			}
		}
		const whole = run(core, { type: 'window', start: 0, count: mainCount, capacity: 0 });
		expect(column(whole, 2, 0)).toEqual(expected);
		const from = CHUNK_ROWS - 3;
		const part = run(core, { type: 'window', start: from, count: 100, capacity: 0 });
		expect(column(part, 2, 0)).toEqual(expected.slice(from, from + 100));
	});
});
