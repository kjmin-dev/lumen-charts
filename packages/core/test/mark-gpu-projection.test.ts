import { describe, expect, it } from 'vitest';
import type { MarkFrame } from '../src/marks/backend';
import { scatterBounds } from '../src/marks/gpu/geometry';
import { MIN_UNPROJECTED_SHARE, startRows } from '../src/marks/gpu/renderer';
import { TimeMap } from '../src/marks/time-map';

describe('WebGPU scatter rows projected when a column draw starts over', () => {
	it('projects the rows in view when they leave out enough of the rows held', () => {
		// A trade-history pan: about half of the held rows in view.
		expect(startRows(100_000, 280_000, 360_000)).toEqual([100_000, 280_000]);
		// Exactly the minimum share left out still projects the view only.
		const count = 1_000_000,
			left = MIN_UNPROJECTED_SHARE * count;
		expect(startRows(left, count, count)).toEqual([left, count]);
	});

	it('projects every row held when the view would leave out fewer than the minimum share', () => {
		const count = 2_000_000;
		const view = Math.ceil((1 - MIN_UNPROJECTED_SHARE) * count) + 1;
		expect(startRows(count - view, count, count)).toEqual([0, count]);
		expect(startRows(0, count, count)).toEqual([0, count]);
	});

	it('keeps an empty view and an empty window empty', () => {
		expect(startRows(5, 5, 10)).toEqual([5, 5]);
		expect(startRows(0, 0, 0)).toEqual([0, 0]);
	});
});

/** `scatterBounds` as it searched every row of the window for each column. */
function boundsByBinarySearch(f: MarkFrame, size: number): number[] {
	const w = f.window,
		map = f.map;
	const shift = (f.options as { barAlign: string }).barAlign === 'start' ? -map.spacing / 2 : 0;
	const pad = size - 1 - (size >> 1);
	const center = (id: number) => {
		const t = w.time[id]!;
		map.segment(t);
		return Math.round(map.x0 + shift + (t - map.t0) * map.pace);
	};
	const out: number[] = [];
	let previous = f.from;
	for (let i = 0; i < f.width + size; i++) {
		const x = i - pad;
		const t = map.time(x - 0.5 - shift);
		let id = Math.max(previous, Math.min(f.to, w.lowerBound(t)));
		if ((id > previous && center(id - 1) >= x) || (id < f.to && center(id) < x)) {
			let lo = previous,
				hi = f.to;
			while (lo < hi) {
				const mid = (lo + hi) >>> 1;
				if (center(mid) < x) lo = mid + 1;
				else hi = mid;
			}
			id = lo;
		}
		out.push(id);
		previous = id;
	}
	return out;
}

describe('scatter column ranges', () => {
	const MINUTE = 60_000;
	/** Rows over bars with a night between them, several at one time, and the frame of a part of them. */
	function frame(rows: number, from: number, to: number, barAlign: 'center' | 'start'): MarkFrame {
		const bars = Float64Array.from({ length: 40 }, (_, i) => (i < 20 ? i : i + 600) * MINUTE);
		const map = new TimeMap();
		map.set(bars, 0, bars.length, 0, 0, 0, 3.25, 7.5);
		let seed = 11;
		const time = new Float64Array(rows);
		let t = -2 * MINUTE;
		for (let i = 0; i < rows; i++) {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			// Mostly a few seconds apart, sometimes at the same time, and across the night.
			t += seed % 7 === 0 ? 0 : seed % 97 === 0 ? 300 * MINUTE : (seed % 9000) + 1;
			time[i] = t;
		}
		const lowerBound = (value: number): number => {
			let lo = 0,
				hi = rows;
			while (lo < hi) {
				const mid = (lo + hi) >>> 1;
				if (time[mid]! < value) lo = mid + 1;
				else hi = mid;
			}
			return lo;
		};
		return {
			window: { time, count: rows, lowerBound },
			map,
			options: { barAlign },
			width: 330,
			from,
			to,
		} as unknown as MarkFrame;
	}

	it('finds the rows a binary search over the window finds, for every column', () => {
		for (const barAlign of ['center', 'start'] as const)
			for (const size of [1, 2, 3, 4, 9])
				for (const [from, to] of [
					[0, 4000],
					[700, 3100],
					[1500, 1500],
				] as const) {
					const f = frame(4000, from, to, barAlign);
					const out = new Uint32Array(f.width + size);
					scatterBounds(f, size, out);
					expect([...out]).toEqual(boundsByBinarySearch(f, size));
				}
	});

	it('writes the columns from a start the same as all of them', () => {
		const f = frame(3000, 0, 3000, 'center');
		const all = new Uint32Array(f.width + 3);
		scatterBounds(f, 3, all);
		for (const start of [1, 57, 200, f.width + 2]) {
			const part = all.slice();
			part.fill(0, start);
			scatterBounds(f, 3, part, start);
			expect([...part]).toEqual([...all]);
		}
	});
});

