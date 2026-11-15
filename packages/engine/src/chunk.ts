/** Rows per chunk, as a power of two so an index splits into chunk and row with a shift and a mask. */
export const CHUNK_SHIFT = 13;
export const CHUNK_ROWS = 1 << CHUNK_SHIFT;
export const CHUNK_MASK = CHUNK_ROWS - 1;

/** Column 0 of every store holds the bar time in UTC milliseconds. */
export const TIME = 0;
/** Columns of an OHLCV store. */
export const OPEN = 1;
export const HIGH = 2;
export const LOW = 3;
export const CLOSE = 4;
export const VOLUME = 5;
/** Value column of a line store. */
export const VALUE = 1;

export const OHLCV_COLUMNS = 6;
export const LINE_COLUMNS = 2;

/**
 * One buffer holding every column of up to `CHUNK_ROWS` rows.
 * Rows in use are `[start, end)`: a chunk at the head of a store fills downward, one at the tail fills upward.
 */
export interface Chunk {
	readonly buffer: ArrayBuffer;
	/** One view per column, created once so hot paths never allocate views. */
	readonly columns: readonly Float64Array[];
	start: number;
	end: number;
}

export function createChunk(columnCount: number): Chunk {
	const buffer = new ArrayBuffer(columnCount * CHUNK_ROWS * Float64Array.BYTES_PER_ELEMENT);
	const columns: Float64Array[] = [];
	for (let c = 0; c < columnCount; c++) {
		columns.push(new Float64Array(buffer, c * CHUNK_ROWS * Float64Array.BYTES_PER_ELEMENT, CHUNK_ROWS));
	}
	return { buffer, columns, start: 0, end: 0 };
}
