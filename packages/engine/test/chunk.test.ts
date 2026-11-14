import { CHUNK_ROWS, COLUMNS, columnView, createChunk } from '@lumen-charts/engine';
import { describe, expect, it } from 'vitest';

describe('chunk', () => {
	it('allocates one buffer for all columns', () => {
		const chunk = createChunk();
		expect(chunk.buffer.byteLength).toBe(COLUMNS.length * CHUNK_ROWS * 8);
		expect(chunk.length).toBe(0);
	});

	it('gives each column its own non-overlapping view', () => {
		const chunk = createChunk();
		COLUMNS.forEach((name, i) => {
			columnView(chunk, name).fill(i + 1);
		});
		COLUMNS.forEach((name, i) => {
			const view = columnView(chunk, name);
			expect(view.length).toBe(CHUNK_ROWS);
			expect(view[0]).toBe(i + 1);
			expect(view[CHUNK_ROWS - 1]).toBe(i + 1);
		});
	});

	it('views share memory with the chunk buffer', () => {
		const chunk = createChunk();
		columnView(chunk, 'close')[5] = 42;
		expect(columnView(chunk, 'close')[5]).toBe(42);
	});
});
