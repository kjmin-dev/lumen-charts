import { describe, expect, it } from 'vitest';
import { TimeMap } from '../src/marks/time-map';

const MINUTE = 60_000;

/** The segment a map loaded last. */
function segmentOf(map: TimeMap): number[] {
	return [map.t0, map.t1, map.x0, map.pace];
}

/** A map of `count` one-minute bars from index `start`, bar `i` centered at `10 + 4 * i` device pixels. */
function minutes(count: number, start = 0): TimeMap {
	const times = new Float64Array(count);
	for (let i = 0; i < count; i++) {
		times[i] = (start + i) * MINUTE;
	}
	const map = new TimeMap();
	map.set(times, 0, count, start, 0, 0, 10, 4);
	return map;
}

describe('TimeMap', () => {
	it('puts a bar time at the center of its bar and times between bars between their centers', () => {
		const map = minutes(100);
		expect(map.x(0)).toBe(10);
		expect(map.x(7 * MINUTE)).toBe(38);
		expect(map.x(7.5 * MINUTE)).toBe(40);
		expect(map.x(7.25 * MINUTE)).toBe(39);
		expect(map.x(99 * MINUTE)).toBe(406);
	});

	it('goes on beyond the bars it holds at their pace', () => {
		const map = minutes(100, 50);
		expect(map.x(49 * MINUTE)).toBe(10 + 4 * 49);
		expect(map.x(0)).toBe(10);
		expect(map.x(150 * MINUTE)).toBe(10 + 4 * 150);
		expect(map.x(149.5 * MINUTE)).toBe(10 + 4 * 149.5);
	});

	it('spreads a gap in trading between the two bars around it, and does not pace the future by it', () => {
		// Five bars, a night, five bars.
		const times = Float64Array.from([0, 1, 2, 3, 4, 1000, 1001, 1002, 1003, 1004], minute => minute * MINUTE);
		const map = new TimeMap();
		map.set(times, 0, 10, 0, 0, 0, 0, 10);
		expect(map.x(4 * MINUTE)).toBe(40);
		expect(map.x(502 * MINUTE)).toBe(45);
		expect(map.x(1000 * MINUTE)).toBe(50);
		expect(map.x(1005 * MINUTE)).toBe(100);
		// The last gap held is the night: the pace beyond is still a bar a minute.
		const short = new TimeMap();
		short.set(times, 0, 6, 0, 0, 0, 0, 10);
		expect(short.x(1001 * MINUTE)).toBe(60);
	});

	it('maps the buckets of a coarse level by their first row', () => {
		// Buckets of 16 rows from bucket 2; the timeline starts at row 40, inside bucket 2.
		const times = Float64Array.from([40, 48, 64, 80], row => row * MINUTE);
		const map = new TimeMap();
		map.set(times, 0, 4, 2, 4, 40, 0, 0.5);
		expect(map.knotX(0)).toBe(20);
		expect(map.knotX(1)).toBe(24);
		expect(map.x(48 * MINUTE)).toBe(24);
		expect(map.x(56 * MINUTE)).toBe(28);
		expect(map.x(44 * MINUTE)).toBe(22);
		expect(map.x(96 * MINUTE)).toBe(48);
	});

	it('walks its segments in time order', () => {
		const map = minutes(4);
		map.segment(-30_000);
		expect(map.t1).toBe(0);
		expect(map.x0 + (-30_000 - map.t0) * map.pace).toBe(8);
		map.next();
		expect([map.t0, map.t1, map.x0]).toEqual([0, MINUTE, 10]);
		map.next();
		map.next();
		map.next();
		expect(map.t0).toBe(3 * MINUTE);
		expect(map.t1).toBe(Infinity);
		expect(map.x0 + (4 * MINUTE - map.t0) * map.pace).toBe(26);
	});

	it('gives the time at a pixel, the inverse of the mapping', () => {
		const map = minutes(100);
		for (const x of [-20, 10, 11, 37.5, 406, 500]) {
			expect(map.x(map.time(x))).toBeCloseTo(x, 9);
		}
		expect(map.time(10)).toBe(0);
		expect(map.time(40)).toBe(7.5 * MINUTE);
	});

	it('has a pace with a single bar, and nothing without bars', () => {
		const one = new TimeMap();
		one.set(Float64Array.of(5 * MINUTE), 0, 1, 5, 0, 5, 0, 4);
		expect(one.x(5 * MINUTE)).toBe(20);
		expect(one.x(6 * MINUTE)).toBe(24);
		expect(one.x(4 * MINUTE)).toBe(16);
		const none = new TimeMap();
		expect(none.x(0)).toBeNaN();
		expect(none.time(0)).toBeNaN();
	});

	it('loads the segment of a time or a position the same whatever it loaded before', () => {
		// Duplicate times, a gap and buckets that start before the timeline: knots at the same x.
		const times = Float64Array.from([3, 3, 4, 5, 9, 9, 9, 10, 400, 401, 402, 410], minute => minute * MINUTE);
		const fresh = (): TimeMap => {
			const map = new TimeMap();
			map.set(times, 0, times.length, 0, 1, 5, 7, 3.5);
			return map;
		};
		const walked = fresh();
		const walkedStates: number[][] = [];
		const freshStates: number[][] = [];
		let seed = 7;
		const random = (): number => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return seed / 4294967296;
		};
		for (let i = 0; i < 2000; i++) {
			const pick = random();
			const map = fresh();
			if (i % 2 === 0) {
				// Knot times themselves, times between them and beyond both ends.
				const time = pick < 0.3 ? times[Math.floor(random() * times.length)]! : (random() * 430 - 10) * MINUTE;
				walked.segment(time);
				map.segment(time);
				walkedStates.push(segmentOf(walked));
				freshStates.push(segmentOf(map));
			} else {
				const x = pick < 0.3 ? walked.knotX(Math.floor(random() * times.length)) : random() * 100 - 20;
				walkedStates.push([walked.time(x), ...segmentOf(walked)]);
				freshStates.push([map.time(x), ...segmentOf(map)]);
			}
		}
		expect(walkedStates).toEqual(freshStates);
	});
});
