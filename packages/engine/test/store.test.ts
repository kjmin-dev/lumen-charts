import { CHUNK_ROWS, ChunkedStore, TIME } from '@lumen-charts/engine';
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
