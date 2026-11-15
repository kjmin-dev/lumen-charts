import { CHUNK_ROWS, ChunkedStore, SUMMARY_BYTES, TIME } from '@lumen-charts/engine';
import { describe, expect, it } from 'vitest';
import { ohlcv } from './helpers';

function readColumn(store: ChunkedStore, column: number): number[] {
	const out = new Float64Array(store.length);
	store.copyColumn(column, store.first, store.end, out, 0);
	return [...out];
}

describe('ChunkedStore', () => {
	it('appends across chunk boundaries', () => {
		const count = CHUNK_ROWS * 2 + 100;
		const store = new ChunkedStore(6);
		const data = ohlcv(count);
		store.append(data, count, 0, count);
		expect(store.first).toBe(0);
		expect(store.end).toBe(count);
		for (const index of [0, 1, CHUNK_ROWS - 1, CHUNK_ROWS, CHUNK_ROWS * 2, count - 1]) {
			for (let c = 0; c < 6; c++) {
				expect(store.value(c, index)).toBe(data[c * count + index]);
			}
		}
		expect(readColumn(store, 4)).toEqual([...data.subarray(4 * count, 5 * count)]);
	});

	it('appends in slices the same way as in one call', () => {
		const count = CHUNK_ROWS + 500;
		const data = ohlcv(count);
		const whole = new ChunkedStore(6);
		whole.append(data, count, 0, count);
		const sliced = new ChunkedStore(6);
		for (let from = 0; from < count; from += 777) {
			sliced.append(data, count, from, Math.min(count, from + 777));
		}
		for (let c = 0; c < 6; c++) {
			expect(readColumn(sliced, c)).toEqual(readColumn(whole, c));
		}
	});

	it('keeps existing indexes when history is prepended', () => {
		const store = new ChunkedStore(6);
		const recent = ohlcv(1000, 1_000_000_000);
		store.append(recent, 1000, 0, 1000);
		const before = store.value(TIME, 0);

		const olderCount = CHUNK_ROWS + 300;
		const older = ohlcv(olderCount, 0);
		// Slices are handed over from last to first.
		store.prepend(older, olderCount, 5000, olderCount);
		store.prepend(older, olderCount, 0, 5000);

		expect(store.first).toBe(-olderCount);
		expect(store.end).toBe(1000);
		expect(store.value(TIME, 0)).toBe(before);
		expect(store.value(TIME, -1)).toBe(older[olderCount - 1]);
		expect(store.value(TIME, -olderCount)).toBe(older[0]);
		expect(readColumn(store, TIME)).toEqual([...older.subarray(0, olderCount), ...recent.subarray(0, 1000)]);
		expect(store.firstTime()).toBe(0);
	});

	it('prepends into an empty store', () => {
		const store = new ChunkedStore(2);
		const data = new Float64Array([1, 2, 3, 10, 20, 30]);
		store.prepend(data, 3, 0, 3);
		expect(store.length).toBe(3);
		expect(store.end).toBe(0);
		expect(readColumn(store, 1)).toEqual([10, 20, 30]);
	});

	it('appends and overwrites single rows', () => {
		const store = new ChunkedStore(2);
		const row = new Float64Array([99, 5, 50]);
		for (let i = 0; i < CHUNK_ROWS + 3; i++) {
			row[1] = i;
			row[2] = i * 10;
			store.appendRow(row, 1);
		}
		expect(store.length).toBe(CHUNK_ROWS + 3);
		expect(store.value(1, CHUNK_ROWS + 2)).toBe((CHUNK_ROWS + 2) * 10);
		row[1] = CHUNK_ROWS;
		row[2] = -1;
		store.writeRow(CHUNK_ROWS, row, 1);
		expect(store.value(1, CHUNK_ROWS)).toBe(-1);
		expect(store.value(1, CHUNK_ROWS - 1)).toBe((CHUNK_ROWS - 1) * 10);
	});

	it('finds the first row at or after a time', () => {
		const store = new ChunkedStore(6);
		const count = CHUNK_ROWS * 3;
		store.append(ohlcv(count, 0, 10), count, 0, count);
		const older = ohlcv(50, -500, 10);
		store.prepend(older, 50, 0, 50);
		expect(store.lowerBound(-Infinity)).toBe(-50);
		expect(store.lowerBound(-500)).toBe(-50);
		expect(store.lowerBound(-495)).toBe(-49);
		expect(store.lowerBound(0)).toBe(0);
		expect(store.lowerBound(5)).toBe(1);
		expect(store.lowerBound(CHUNK_ROWS * 10)).toBe(CHUNK_ROWS);
		expect(store.lowerBound((count - 1) * 10)).toBe(count - 1);
		expect(store.lowerBound((count - 1) * 10 + 1)).toBe(count);
	});

	it('starts over after clear', () => {
		const store = new ChunkedStore(6);
		store.append(ohlcv(10), 10, 0, 10);
		store.prepend(ohlcv(10, -1e6), 10, 0, 10);
		store.clear();
		expect(store.length).toBe(0);
		store.append(ohlcv(5), 5, 0, 5);
		expect(store.first).toBe(0);
		expect(store.end).toBe(5);
	});
});

/** Five chunks of a line with bar `i` at time `10 * i`, starting at index -100. */
function lineStore(): { store: ChunkedStore; data: Float64Array; count: number } {
	const count = CHUNK_ROWS * 5 - 200;
	const data = new Float64Array(count * 2);
	for (let i = 0; i < count; i++) {
		data[i] = 10 * i;
		data[count + i] = Math.sin(i);
	}
	const store = new ChunkedStore(2);
	store.clear(-100);
	store.append(data, count, 0, count);
	return { store, data, count };
}

/** Time of the bar at index `index` of `lineStore`. */
const timeOf = (index: number): number => 10 * (index + 100);

/** Index of row `row` of the chunk with grid number `grid`. */
const at = (grid: number, row: number): number => grid * CHUNK_ROWS + row;

/** A `lineStore` and its times. */
function withTimes(): { store: ChunkedStore; times: number[] } {
	const { store, count } = lineStore();
	const out = new Float64Array(count);
	store.copyColumn(0, store.first, store.end, out, 0);
	return { store, times: [...out] };
}

/** Every time a store holds. */
function timesOf(store: ChunkedStore): number[] {
	const out = new Float64Array(store.length);
	store.copyColumn(0, store.first, store.end, out, 0);
	return [...out];
}

describe('ChunkedStore with chunks let go', () => {
	it('frees the time column too and keeps a summary of it', () => {
		const { store } = lineStore();
		const before = store.byteLength;
		expect(store.evict(1, true)).toBe(CHUNK_ROWS * 8);
		expect(store.isEvicted(1)).toBe(true);
		expect(store.hasTime(1)).toBe(true);
		// Then the time column: only the summary is left.
		expect(store.evict(1, false)).toBe(CHUNK_ROWS * 8 - SUMMARY_BYTES);
		expect(store.hasTime(1)).toBe(false);
		expect(store.byteLength).toBe(before - CHUNK_ROWS * 16 + SUMMARY_BYTES);
		expect(store.evict(1, false)).toBe(0);
		expect([store.evictedCount, store.timelessCount]).toEqual([1, 1]);
		expect(store.chunkFirstTime(1)).toBe(timeOf(CHUNK_ROWS));
		expect(store.chunkLastTime(1)).toBe(timeOf(2 * CHUNK_ROWS - 1));
	});

	it('finds times across chunks without their times, or says they fall inside one', () => {
		const { store } = lineStore();
		store.evict(1, false);
		store.evict(2, false);
		// Before, at and after the edges of the chunks let go: exact, from their first and last times.
		expect(store.lowerBound(timeOf(at(0, CHUNK_ROWS - 1)))).toBe(at(0, CHUNK_ROWS - 1));
		expect(store.lowerBound(timeOf(at(0, CHUNK_ROWS - 1)) + 1)).toBe(at(1, 0));
		expect(store.lowerBound(timeOf(at(1, 0)))).toBe(at(1, 0));
		expect(store.lowerBound(timeOf(at(2, CHUNK_ROWS - 1)) + 1)).toBe(at(3, 0));
		expect(store.upperBound(timeOf(at(2, CHUNK_ROWS - 1)))).toBe(at(3, 0));
		expect(store.upperBound(timeOf(at(0, CHUNK_ROWS - 1)))).toBe(at(1, 0));
		// Inside a chunk without its times the row is unknown.
		expect(store.lowerBound(timeOf(at(1, 5)))).toBeNaN();
		expect(store.upperBound(timeOf(at(2, 0)))).toBeNaN();
		// Held chunks around them are searched as before; so are the ends.
		expect(store.lowerBound(timeOf(at(3, 77)))).toBe(at(3, 77));
		expect(store.lowerBound(-Infinity)).toBe(store.first);
		expect(store.lowerBound(Infinity)).toBe(store.end);
		// The chunk a time would be in, and none between two chunks or outside the data.
		expect(store.chunkOf(timeOf(at(1, 5)))).toBe(1);
		expect(store.chunkOf(timeOf(at(1, 5)) + 3)).toBe(1);
		expect(store.chunkOf(timeOf(at(1, CHUNK_ROWS - 1)) + 5)).toBeNaN();
		expect(store.chunkOf(timeOf(store.first) - 1)).toBeNaN();
		expect(store.chunkAtOrAfter(timeOf(at(1, CHUNK_ROWS - 1)) + 5)).toBe(2);
		// The first time of a chunk let go is known, any other is not.
		expect(store.timeAt(at(2, 0))).toBe(timeOf(at(2, 0)));
		expect(store.timeAt(at(2, 1))).toBeNaN();
		expect(store.timeAt(at(3, 1))).toBe(timeOf(at(3, 1)));
	});

	it('checks rows that come back against the times kept or summarized', () => {
		const { store, data, count } = lineStore();
		store.evict(1, true);
		store.evict(2, false);
		const rows = (grid: number): { block: Float64Array; n: number } => {
			const from = grid * CHUNK_ROWS + 100;
			const block = new Float64Array(CHUNK_ROWS * 2);
			block.set(data.subarray(from, from + CHUNK_ROWS), 0);
			block.set(data.subarray(count + from, count + from + CHUNK_ROWS), CHUNK_ROWS);
			return { block, n: CHUNK_ROWS };
		};
		for (const grid of [1, 2]) {
			const { block, n } = rows(grid);
			expect(store.matches(grid, block, n, 0, n)).toBe(true);
			// One bar a millisecond late, at the end or in the middle: refused either way.
			for (const late of [n - 1, 4321]) {
				const wrong = block.slice();
				wrong[late] = wrong[late]! + 1;
				expect(store.matches(grid, wrong, n, 0, n)).toBe(false);
			}
			// One bar short.
			expect(store.matches(grid, block, n, 0, n - 1)).toBe(false);
		}
		// The same values come back unchanged; changed ones are reported.
		const same = rows(1);
		expect(store.restore(1, same.block, same.n, 0)).toBe(false);
		const changed = rows(2);
		changed.block[CHUNK_ROWS + 10] = 1e6;
		expect(store.restore(2, changed.block, changed.n, 0)).toBe(true);
		expect([store.evictedCount, store.timelessCount]).toEqual([0, 0]);
		expect(store.value(1, 2 * CHUNK_ROWS + 10)).toBe(1e6);
		expect(store.lowerBound(timeOf(2 * CHUNK_ROWS + 5))).toBe(2 * CHUNK_ROWS + 5);
	});

	it('removes rows in the middle by moving either side, and cuts rows off at either end', () => {
		for (const moveHead of [false, true]) {
			const { store, times } = withTimes();
			const from = CHUNK_ROWS + 50;
			const to = 3 * CHUNK_ROWS + 7;
			const first = store.first;
			const end = store.end;
			store.removeRows(from, to, moveHead);
			const expected = times.filter((_, i) => i + first < from || i + first >= to);
			expect(timesOf(store)).toEqual(expected);
			expect([store.first, store.end]).toEqual(moveHead ? [first + to - from, end] : [first, end - to + from]);
			// Rows still append at the end and are found by time.
			store.appendRow(new Float64Array([1e9, 1]), 0);
			expect(store.lowerBound(1e9)).toBe(store.end - 1);
			expect(store.lowerBound(times[from - first]! - 10)).toBe(from - 1 + (moveHead ? to - from : 0));
		}
		const { store, times } = withTimes();
		store.truncate(store.first + 9000, store.end - 3);
		expect(timesOf(store)).toEqual(times.slice(9000, times.length - 3));
		expect(store.first).toBe(-100 + 9000);
	});
});
