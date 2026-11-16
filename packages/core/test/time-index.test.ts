import type { TimelineResolution } from '@lumen-charts/engine';
import { describe, expect, it } from 'vitest';
import { LevelWindow } from '../src/data/window-cache';
import { TimeIndex } from '../src/model/time-index';

const MIN = 60_000;

/** A raw window holding bars `[start, start + count)` at one minute each, bar `i` at minute `i`. */
function window(start: number, count: number): LevelWindow {
	const w = new LevelWindow(0);
	w.start = start;
	w.count = count;
	w.capacity = count;
	w.time = Float64Array.from({ length: count }, (_, k) => (start + k) * MIN);
	return w;
}

/** An engine that records what it is asked and answers on demand, a bar a minute from bar `first`. */
class FakeEngine {
	public asked: { seq: number; times: number[] }[] = [];
	private _seq = 0;

	public resolveTimes(times: Float64Array): number {
		this.asked.push({ seq: ++this._seq, times: [...times] });
		return this._seq;
	}

	public answer(index: TimeIndex, first: number, end: number): void {
		const request = this.asked.shift()!;
		const resolution: TimelineResolution = {
			positions: Float64Array.from(request.times, time => time / MIN),
			firstTime: first * MIN,
			lastTime: (end - 1) * MIN,
			headInterval: MIN,
			tailInterval: MIN,
		};
		index.apply(request.seq, resolution);
	}
}

describe('time index', () => {
	it('answers inside the raw window at once, exactly or between bars', () => {
		const index = new TimeIndex();
		index.setTimeline(1, 0, 1000);
		index.setWindow(window(500, 200));
		expect(index.lookup(600 * MIN)).toBe(600);
		expect(index.lookup(600.25 * MIN)).toBeCloseTo(600.25);
		expect(index.timeAt(650, null)).toBe(650 * MIN);
		expect(index.timeAt(650.5, null)).toBe(650.5 * MIN);
	});

	it('asks the engine for times outside it, once, and answers when it replied', () => {
		const index = new TimeIndex();
		const engine = new FakeEngine();
		index.setTimeline(1, 0, 1000);
		index.setWindow(window(500, 200));
		expect(index.lookup(10 * MIN)).toBeNaN();
		expect(index.lookup(10 * MIN)).toBeNaN();
		index.flush(engine);
		index.flush(engine);
		expect(engine.asked.map(a => a.times)).toEqual([[10 * MIN]]);
		const version = index.version;
		engine.answer(index, 0, 1000);
		expect(index.version).toBeGreaterThan(version);
		expect(index.lookup(10 * MIN)).toBe(10);
		// The ends are known now: future times and times before the first bar are answered here.
		expect(index.lookup(1005 * MIN)).toBe(1005);
		expect(index.timeAt(1003, null)).toBe(1003 * MIN);
		expect(index.timeAt(-2, null)).toBe(-2 * MIN);
	});

	it('keeps positions inside the bars both timelines share, and asks again for the others', () => {
		const index = new TimeIndex();
		const engine = new FakeEngine();
		index.setTimeline(1, 0, 1000);
		for (const time of [-50, 10, 990, 1010]) {
			index.lookup(time * MIN);
		}
		index.flush(engine);
		engine.answer(index, 0, 1000);
		// A new bar: the future time is asked again, standing in with its old position meanwhile.
		index.setTimeline(1, 0, 1001);
		index.setWindow(null);
		expect(index.lookup(990 * MIN)).toBe(990);
		expect(index.lookup(1010 * MIN)).toBe(1010);
		expect(index.lookup(-50 * MIN)).toBe(-50);
		index.flush(engine);
		expect(engine.asked[0]!.times).toEqual([1010 * MIN]);
		engine.answer(index, 0, 1001);
		// A prepend: the time before the first bar is asked again; the others stay.
		index.setTimeline(1, -100, 1001);
		index.lookup(-50 * MIN);
		index.lookup(10 * MIN);
		index.flush(engine);
		expect(engine.asked[0]!.times).toEqual([-50 * MIN]);
		engine.answer(index, -100, 1001);
		// Bars cut at the end: the times on them are asked again, the others not.
		index.setTimeline(1, -100, 995);
		index.lookup(990 * MIN);
		index.lookup(10 * MIN);
		index.flush(engine);
		expect(engine.asked).toEqual([]);
		index.setTimeline(1, -100, 980);
		expect(index.lookup(990 * MIN)).toBe(990);
		index.flush(engine);
		expect(engine.asked.at(-1)!.times).toEqual([990 * MIN]);
	});

	it('shows nothing after a new epoch until the positions are known again', () => {
		const index = new TimeIndex();
		const engine = new FakeEngine();
		index.setTimeline(1, 0, 1000);
		index.lookup(10 * MIN);
		index.flush(engine);
		engine.answer(index, 0, 1000);
		index.setTimeline(2, 0, 200);
		expect(index.lookup(10 * MIN)).toBeNaN();
		index.flush(engine);
		engine.answer(index, 0, 200);
		expect(index.lookup(10 * MIN)).toBe(10);
	});

	it('keeps asking for the ends while something uses positions', () => {
		const index = new TimeIndex();
		const engine = new FakeEngine();
		index.flush(engine);
		expect(engine.asked).toEqual([]);
		index.active = true;
		index.setTimeline(1, 0, 10);
		index.flush(engine);
		index.flush(engine);
		expect(engine.asked.length).toBe(1);
		engine.answer(index, 0, 10);
		index.flush(engine);
		expect(engine.asked.length).toBe(0);
		index.setTimeline(1, 0, 11);
		index.flush(engine);
		expect(engine.asked.length).toBe(1);
	});

	it('takes positions it is told, and drops answers of a request the engine failed', () => {
		const index = new TimeIndex();
		const engine = new FakeEngine();
		index.setTimeline(1, 0, 1000);
		index.seed(123 * MIN, 123);
		expect(index.lookup(123 * MIN)).toBe(123);
		index.lookup(5 * MIN);
		index.flush(engine);
		index.cancel(engine.asked[0]!.seq);
		expect(index.lookup(5 * MIN)).toBeNaN();
		index.flush(engine);
		expect(engine.asked.length).toBe(2);
	});

	it('answers approximately from a coarse window where raw rows are not held', () => {
		const index = new TimeIndex();
		index.setTimeline(1, 0, 4096);
		const coarse = new LevelWindow(1);
		coarse.start = 0;
		coarse.count = 256;
		coarse.capacity = 256;
		coarse.time = Float64Array.from({ length: 256 }, (_, k) => k * 16 * MIN);
		expect(index.timeAt(100, null)).toBeNaN();
		expect(index.timeAt(100, coarse)).toBe(100 * MIN);
	});
});
