import { EngineCore, type ScatterRows } from '@lumen-ticks/engine';
import { describe, expect, it } from 'vitest';
import { heat, rows } from './marks-helpers';
import { run } from './helpers';

const MIN = 60_000;
const LINE = 1;
const MARKS = 2;

/** The times of the main timeline's bars. */
function timeline(core: EngineCore): number[] {
	const window = run(core, { type: 'window', level: 0, start: -(1 << 20), count: 1 << 21, capacity: 1 << 21 }).window!;
	return [...window.time.subarray(0, window.count)];
}

function minutes(...list: number[]): number[] {
	return list.map(m => m * MIN);
}

function points(times: number[]): ScatterRows {
	return rows(
		times,
		times.map(() => 100),
	);
}

describe('a timeline made from marks', () => {
	it('has a bar for each minute that holds points, following appends, prepends and removals', () => {
		const core = new EngineCore();
		run(core, { type: 'add', series: LINE, kind: 'line' });
		run(core, {
			type: 'marks',
			series: MARKS,
			change: { op: 'add', kind: 'scatter', timeline: { series: LINE, interval: MIN } },
		});
		run(core, {
			type: 'marks',
			series: MARKS,
			change: { op: 'set', data: points([10, 20, 2 * MIN + 5, 2 * MIN + 50, 5 * MIN, 9 * MIN + 1]) },
		});
		expect(timeline(core)).toEqual(minutes(0, 2, 5, 9));
		// Into the last bar, then into new minutes: ticks of the line.
		const event = run(core, {
			type: 'marks',
			series: MARKS,
			change: { op: 'append', data: points([9 * MIN + 30, 11 * MIN, 12 * MIN + 59_999]) },
		});
		expect(event.patches ?? event.packedPatches).toBeDefined();
		expect(timeline(core)).toEqual(minutes(0, 2, 5, 9, 11, 12));
		run(core, { type: 'marks', series: MARKS, change: { op: 'prepend', data: points([-3 * MIN + 7, -MIN, 0]) } });
		expect(timeline(core)).toEqual(minutes(-3, -1, 0, 2, 5, 9, 11, 12));
		// Minutes 2 and 5 lose every point; minute 9 keeps the one after the range.
		run(core, { type: 'marks', series: MARKS, change: { op: 'delete', from: MIN + 1, to: 9 * MIN + 10 } });
		expect(timeline(core)).toEqual(minutes(-3, -1, 0, 9, 11, 12));
		// Minute 0 keeps the points before the range.
		run(core, { type: 'marks', series: MARKS, change: { op: 'delete', from: 15, to: 9 * MIN + 40 } });
		expect(timeline(core)).toEqual(minutes(-3, -1, 0, 11, 12));
		run(core, { type: 'marks', series: MARKS, change: { op: 'set', data: points([4 * MIN]) } });
		expect(timeline(core)).toEqual(minutes(4));
	});

	it('has a bar for each heatmap column', () => {
		const core = new EngineCore();
		run(core, { type: 'add', series: LINE, kind: 'line' });
		run(core, {
			type: 'marks',
			series: MARKS,
			change: { op: 'add', kind: 'heatmap', timeline: { series: LINE, interval: 0 } },
		});
		run(core, { type: 'marks', series: MARKS, change: { op: 'set', data: heat(5, 3) } });
		expect(timeline(core)).toEqual(minutes(0, 1, 2, 3, 4));
		run(core, { type: 'marks', series: MARKS, change: { op: 'append', data: heat(2, 3, undefined, 0, 4) } });
		expect(timeline(core)).toEqual(minutes(0, 1, 2, 3, 4, 5));
		run(core, { type: 'marks', series: MARKS, change: { op: 'delete', from: MIN, to: 2 * MIN } });
		expect(timeline(core)).toEqual(minutes(0, 3, 4, 5));
	});
});
