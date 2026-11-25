import { CHUNK_MASK, CHUNK_ROWS, CHUNK_SHIFT, OHLCV_COLUMNS, createChunk } from '@lumen-ticks/engine';
import { describe, expect, it } from 'vitest';

describe('chunk', () => {
	it('allocates one buffer for all columns', () => {
		const chunk = createChunk(OHLCV_COLUMNS);
		expect(chunk.buffer.byteLength).toBe(OHLCV_COLUMNS * CHUNK_ROWS * 8);
		expect(chunk.columns.length).toBe(OHLCV_COLUMNS);
		expect(chunk.start).toBe(0);
		expect(chunk.end).toBe(0);
	});

	it('gives each column its own non-overlapping view over the buffer', () => {
		const chunk = createChunk(OHLCV_COLUMNS);
		chunk.columns.forEach((column, i) => {
			column.fill(i + 1);
		});
		chunk.columns.forEach((column, i) => {
			expect(column.buffer).toBe(chunk.buffer);
			expect(column.length).toBe(CHUNK_ROWS);
			expect(column[0]).toBe(i + 1);
			expect(column[CHUNK_ROWS - 1]).toBe(i + 1);
		});
	});

	it('splits negative indexes into chunk and row like positive ones', () => {
		expect(-1 >> CHUNK_SHIFT).toBe(-1);
		expect(-1 & CHUNK_MASK).toBe(CHUNK_ROWS - 1);
		expect(-CHUNK_ROWS >> CHUNK_SHIFT).toBe(-1);
		expect(-CHUNK_ROWS & CHUNK_MASK).toBe(0);
		expect((-CHUNK_ROWS - 1) >> CHUNK_SHIFT).toBe(-2);
	});
});
