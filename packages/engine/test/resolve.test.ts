import { CHUNK_ROWS, EngineCore, transferables } from '@lumen-ticks/engine';
import { describe, expect, it } from 'vitest';
import { line, run } from './helpers';

const MIN = 60_000;

function resolve(core: EngineCore, times: number[]) {
	const event = run(core, { type: 'resolve', times: Float64Array.from(times) });
	return { event, resolved: event.resolved!, positions: [...event.resolved!.positions] };
}

describe('resolving times to logical positions', () => {
	it('maps bar times to indexes and interpolates between bars', () => {
		const core = new EngineCore();
		run(core, { type: 'add', series: 1, kind: 'line' });
		// Bars every minute with one gap of ten minutes after bar 4.
		const times = [0, 1, 2, 3, 4, 14, 15, 16].map(t => t * MIN);
		run(core, {
			type: 'set',
			series: 1,
			count: times.length,
			data: line(
				times,
				times.map(() => 1),
			),
		});
		const { positions, resolved } = resolve(core, [0, 3 * MIN, 14 * MIN, 1.5 * MIN, 9 * MIN, NaN]);
		expect(positions.slice(0, 3)).toEqual([0, 3, 5]);
		expect(positions[3]).toBeCloseTo(1.5);
		// Halfway through the gap between bar 4 and bar 5.
		expect(positions[4]).toBeCloseTo(4.5);
		expect(positions[5]).toBeNaN();
		expect(resolved.firstTime).toBe(0);
		expect(resolved.lastTime).toBe(16 * MIN);
		// The median gap ignores the long one.
		expect(resolved.tailInterval).toBe(MIN);
		expect(resolved.headInterval).toBe(MIN);
	});

	it('extrapolates beyond the ends at the typical spacing of the bars there', () => {
		const core = new EngineCore();
		run(core, { type: 'add', series: 1, kind: 'line' });
		const times = Array.from({ length: 100 }, (_, i) => (1000 + i) * MIN);
		run(core, { type: 'set', series: 1, count: 100, data: line(times, times) });
		const { positions } = resolve(core, [1099 * MIN + 5 * MIN, 1000 * MIN - 3 * MIN, 1099 * MIN + MIN / 2]);
		expect(positions[0]).toBeCloseTo(104);
		expect(positions[1]).toBeCloseTo(-3);
		expect(positions[2]).toBeCloseTo(99.5);
	});

	it('keeps answers right after a prepend, which leaves indexes as they are', () => {
		const core = new EngineCore();
		run(core, { type: 'add', series: 1, kind: 'line' });
		const times = Array.from({ length: 50 }, (_, i) => (100 + i) * MIN);
		run(core, { type: 'set', series: 1, count: 50, data: line(times, times) });
		const before = resolve(core, [120 * MIN, 90 * MIN]).positions;
		expect(before[0]).toBe(20);
		expect(before[1]).toBeCloseTo(-10);
		const older = Array.from({ length: 20 }, (_, i) => (80 + i) * MIN);
		run(core, { type: 'prepend', series: 1, count: 20, data: line(older, older) });
		const after = resolve(core, [120 * MIN, 90 * MIN]).positions;
		expect(after).toEqual([20, -10]);
	});

	it('answers NaN without bars, and hands its buffer over with the event', () => {
		const core = new EngineCore();
		const { event, positions } = resolve(core, [1, 2]);
		expect(positions.every(p => Number.isNaN(p))).toBe(true);
		expect(transferables(event)).toContain(event.resolved!.positions.buffer);
	});

	it('interpolates between the times the levels keep inside history let go', () => {
		const core = new EngineCore();
		const count = CHUNK_ROWS * 24;
		const times = Array.from({ length: count }, (_, i) => 1_000_000 + i * 60);
		run(core, { type: 'add', series: 1, kind: 'line', fetchable: true });
		run(core, { type: 'set', series: 1, count, data: line(times, times) });
		while (core.backgroundStep()) {
			// Build the levels.
		}
		run(core, { type: 'limit', bytes: 1 });
		while (core.backgroundStep()) {
			// Let chunks go.
		}
		const store = (core as unknown as { _main: { store: { timelessCount: number; hasTime(grid: number): boolean } } })
			._main.store;
		expect(store.timelessCount).toBeGreaterThan(0);
		expect(store.hasTime(5)).toBe(false);
		const row = CHUNK_ROWS * 5 + 1234;
		const { positions } = resolve(core, [times[row]!, times[row]! + 30, times[CHUNK_ROWS * 5]!]);
		// Bars are evenly spaced, so interpolating between every 16th time is exact.
		expect(positions[0]).toBeCloseTo(row, 6);
		expect(positions[1]).toBeCloseTo(row + 0.5, 6);
		expect(positions[2]).toBe(CHUNK_ROWS * 5);
	});
});
