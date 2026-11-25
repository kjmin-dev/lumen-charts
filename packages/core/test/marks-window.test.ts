import type { MarksUpdate } from '@lumen-ticks/engine';
import { describe, expect, it } from 'vitest';
import { MarksWindow } from '../src/marks/window';

function update(fields: Partial<MarksUpdate> & { time?: Float64Array }): MarksUpdate {
	const time = fields.time ?? new Float64Array(0);
	const rows = fields.rows ?? 1;
	return {
		series: 1,
		generation: 1,
		level: 0,
		start: 0,
		count: time.length,
		first: 0,
		total: time.length,
		timeStep: 0,
		priceStep: 0,
		priceStart: 0,
		rows,
		valueMin: Number.NaN,
		valueMax: Number.NaN,
		price: rows === 1 && fields.price === undefined ? time.map(t => t / 10) : new Float64Array(0),
		values: new Float32Array(time.length * rows),
		counts: new Float32Array(0),
		sizes: new Float32Array(0),
		bounds: new Float64Array(0),
		offsets: new Int32Array(0),
		lengths: new Int32Array(0),
		...fields,
		time,
	};
}

/** A window that asked for `[from, to]` with request `seq` and was answered with `rows`. */
function held(rows: Partial<MarksUpdate> & { time: Float64Array }, from = 0, to = 100, step = 1): MarksWindow {
	const window = new MarksWindow();
	expect(window.plan(from, to, step, 0, 1000, 1, 0)).not.toBeNull();
	window.sent(5, 0);
	expect(window.apply(update({ request: 5, ...rows }))).toBe(true);
	return window;
}

describe('MarksWindow', () => {
	it('asks for the view with a margin on first use, and takes the rows that answer', () => {
		const window = new MarksWindow();
		const request = window.plan(100, 200, 2, 0.5, 1000, 0.5, 0)!;
		expect(request).toEqual({
			from: 50,
			to: 250,
			step: 2,
			priceStep: 0.5,
			limit: 1000,
			generation: -1,
			heldLevel: -1,
			heldStart: 0,
			heldEnd: 0,
		});
		expect(window.loading).toBe(true);
		// The same view again while the rows are on their way: nothing more to ask.
		expect(window.plan(100, 200, 2, 0.5, 1000, 0.5, 10)).toBeNull();
		window.sent(7, 0);
		const version = window.version;
		expect(
			window.apply(
				update({
					request: 7,
					level: 2,
					start: 10,
					total: 50,
					time: Float64Array.of(60, 70, 80),
					valueMin: 1,
					valueMax: 9,
				}),
			),
		).toBe(true);
		expect(window.loading).toBe(false);
		expect(window.version).toBe(version + 1);
		expect([window.level, window.start, window.count, window.total]).toEqual([2, 10, 3, 50]);
		expect([...window.time]).toEqual([60, 70, 80]);
		expect([window.valueMin, window.valueMax]).toEqual([1, 9]);
		expect(window.lowerBound(70)).toBe(1);
		expect(window.upperBound(70)).toBe(2);
		expect(window.lowerBound(0)).toBe(0);
		expect(window.upperBound(1000)).toBe(3);
	});

	it('asks again when the view nears the edge of what it holds, was zoomed, or the data was replaced', () => {
		const window = held({ time: Float64Array.of(10, 20, 30), total: 9, start: 3 }, 100, 200);
		// Covered: [0, 300].
		expect(window.plan(100, 200, 1, 0, 1000, 1, 0)).toBeNull();
		expect(window.plan(40, 140, 1, 0, 1000, 1, 0)).toBeNull();
		// Less than a quarter of a screen left on the left.
		const moved = window.plan(20, 120, 1, 0, 1000, 1, 0)!;
		expect([moved.from, moved.to]).toEqual([-80, 220]);
		expect([moved.generation, moved.heldLevel, moved.heldStart, moved.heldEnd]).toEqual([1, 0, 3, 6]);
		window.sent(6, 0);
		window.apply(update({ request: 6, kept: true, start: 3, count: 3, total: 9 }));
		expect(window.count).toBe(3);
		expect(window.plan(20, 120, 1, 0, 1000, 1, 0)).toBeNull();
		// Zoomed out by two, or in by two: another level may fit.
		expect(window.plan(20, 120, 1.9, 0, 1000, 1, 0)).toBeNull();
		expect(window.plan(20, 120, 2, 0, 1000, 1, 0)).not.toBeNull();
		window.sent(7, 0);
		window.apply(update({ request: 7, kept: true, start: 3, count: 3, total: 9 }));
		expect(window.plan(20, 120, 1, 0, 1000, 1, 0)).not.toBeNull();
		window.sent(8, 0);
		window.apply(update({ request: 8, kept: true, start: 3, count: 3, total: 9 }));
		// The price axis was zoomed: price bins may show.
		expect(window.plan(20, 120, 1, 0.5, 1000, 1, 0)).not.toBeNull();
		window.sent(9, 0);
		window.apply(update({ request: 9, kept: true, start: 3, count: 3, total: 9 }));
		expect(window.plan(20, 120, 1, 0.6, 1000, 1, 0)).toBeNull();
		// New data: what is held is of the old one, and the engine is not told it is held.
		window.invalidate();
		const fresh = window.plan(20, 120, 1, 0.6, 1000, 1, 0)!;
		expect([fresh.generation, fresh.heldLevel]).toEqual([-1, -1]);
	});

	it('ignores the answer to a request that was superseded, and asks again when the view left the one out', () => {
		const window = new MarksWindow();
		window.plan(0, 100, 1, 0, 1000, 1, 0);
		window.sent(3, 0);
		// The view jumped while the rows were on their way.
		expect(window.plan(1000, 1100, 1, 0, 1000, 1, 1)).not.toBeNull();
		window.sent(4, 1);
		expect(window.apply(update({ request: 3, time: Float64Array.of(1, 2) }))).toBe(false);
		expect(window.loading).toBe(true);
		expect(window.count).toBe(0);
		expect(window.apply(update({ request: 4, time: Float64Array.of(1001, 1002) }))).toBe(true);
		expect(window.loading).toBe(false);
		expect([...window.time]).toEqual([1001, 1002]);
	});

	it('gives up on a request that was never answered', () => {
		const window = new MarksWindow();
		expect(window.plan(0, 100, 1, 0, 1000, 1, 0)).not.toBeNull();
		window.sent(3, 0);
		expect(window.plan(0, 100, 1, 0, 1000, 1, 1999)).toBeNull();
		expect(window.plan(0, 100, 1, 0, 1000, 1, 2000)).not.toBeNull();
	});

	it('takes a patch that follows on the rows it holds, growing its buffers', () => {
		const window = held({ time: Float64Array.of(10, 20, 30), total: 3, valueMax: 4, valueMin: 0 });
		const version = window.version;
		const revision = window.revision;
		expect(
			window.apply(
				update({
					start: 2,
					total: 5,
					time: Float64Array.of(30, 40, 50),
					price: Float64Array.of(3.5, 4, 5),
					values: Float32Array.of(7, 8, 9),
					valueMin: 0,
					valueMax: 9,
				}),
			),
		).toBe(true);
		expect([window.start, window.count, window.total]).toEqual([0, 5, 5]);
		expect([...window.time.subarray(0, 5)]).toEqual([10, 20, 30, 40, 50]);
		expect([...window.price.subarray(0, 5)]).toEqual([1, 2, 3.5, 4, 5]);
		expect([...window.values.subarray(0, 5)]).toEqual([0, 0, 7, 8, 9]);
		expect([window.dirtyFrom, window.dirtyTo]).toEqual([2, 5]);
		expect(window.valueMax).toBe(9);
		expect(window.revision).toBe(revision + 1);
		// Larger buffers hold the same rows: nothing derived from them starts over.
		expect(window.version).toBe(version);
		expect(window.capacity).toBeGreaterThanOrEqual(5);
		// Room is left, so the next patch changes no buffer.
		window.clearDirty();
		window.apply(update({ start: 5, total: 6, time: Float64Array.of(60), price: Float64Array.of(6) }));
		expect(window.version).toBe(version);
		expect(window.capacity).toBeGreaterThanOrEqual(6);
		expect([window.dirtyFrom, window.dirtyTo]).toEqual([5, 6]);
		expect(window.count).toBe(6);
		// A window that ended with the last row covers whatever comes after it.
		expect(window.plan(1000, 1100, 1, 0, 1000, 1, 0)).toBeNull();
	});

	it('takes only the part of a patch that is in the rows it holds', () => {
		const window = held({ start: 10, total: 13, time: Float64Array.of(10, 20, 30) });
		// Rows 8 to 11 changed: 10 and 11 are held.
		window.apply(
			update({ start: 8, total: 13, time: Float64Array.of(1, 2, 11, 21), price: Float64Array.of(0, 0, 5, 6) }),
		);
		expect([...window.time]).toEqual([11, 21, 30]);
		expect([...window.price]).toEqual([5, 6, 3]);
		expect([window.dirtyFrom, window.dirtyTo]).toEqual([0, 2]);
	});

	it('drops a patch of another level, another generation, or one that leaves a gap', () => {
		const window = held({ time: Float64Array.of(10, 20, 30), total: 9 });
		const revision = window.revision;
		expect(window.apply(update({ level: 1, start: 3, time: Float64Array.of(40) }))).toBe(false);
		expect(window.apply(update({ generation: 2, start: 3, time: Float64Array.of(40) }))).toBe(false);
		expect(window.apply(update({ start: 5, time: Float64Array.of(60) }))).toBe(false);
		expect(window.count).toBe(3);
		expect(window.revision).toBe(revision);
		// Before any rows there is nothing to patch.
		expect(new MarksWindow().apply(update({ start: 0, time: Float64Array.of(1) }))).toBe(false);
	});

	it('holds heatmap columns, several values to a row', () => {
		const window = held({
			rows: 3,
			total: 2,
			priceStart: 90,
			priceStep: 0.5,
			time: Float64Array.of(10, 20),
			values: Float32Array.of(1, 2, 3, 4, 5, 6),
		});
		expect([window.rows, window.priceStart, window.priceStep]).toEqual([3, 90, 0.5]);
		// The last column replaced, and one added.
		window.apply(
			update({
				rows: 3,
				start: 1,
				total: 3,
				time: Float64Array.of(20, 30),
				values: Float32Array.of(7, 8, 9, 10, 11, 12),
			}),
		);
		expect(window.count).toBe(3);
		expect([...window.values.subarray(0, 9)]).toEqual([1, 2, 3, 7, 8, 9, 10, 11, 12]);
		expect([window.dirtyFrom, window.dirtyTo]).toEqual([1, 3]);
	});

	it('asks again once appends have grown it by half', () => {
		const window = held({ time: Float64Array.of(10, 20), total: 2 });
		const many = 70_000;
		const time = new Float64Array(many).map((_, i) => 30 + i);
		window.apply(update({ start: 2, total: many + 2, time, price: time }));
		expect(window.count).toBe(many + 2);
		expect(window.plan(0, 100, 1, 0, 1000, 1, 0)).not.toBeNull();
	});
});
