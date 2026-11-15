/** Rows per chunk, as a power of two so an index splits into chunk and row with a shift and a mask. */
export const CHUNK_SHIFT = 13;
export const CHUNK_ROWS = 1 << CHUNK_SHIFT;
export const CHUNK_MASK = CHUNK_ROWS - 1;

/**
 * Buckets per chunk of a level-of-detail store. With 16-row buckets at the finest level, one level
 * chunk covers exactly one raw chunk (512 × 16 = 8,192 rows), and every coarser level covers a
 * whole number of raw chunks, so level chunks stay aligned with raw chunks on the same fixed grid.
 */
export const LEVEL_CHUNK_SHIFT = 9;

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
 * What a store keeps of a chunk whose columns it let go: enough to place a time before, inside or
 * after the chunk, and to check rows that come back.
 */
export interface ChunkSummary {
	readonly firstTime: number;
	readonly lastTime: number;
	/** 64-bit checksum of the times, as two 32-bit halves. */
	readonly timeHash: number;
	readonly timeHash2: number;
	/** 32-bit checksum of the values, to tell whether rows that come back changed at the source. */
	readonly valueHash: number;
	/** Times of the rows whose index is a multiple of 16, when kept (see `ChunkedStore.anchors`). */
	readonly anchors?: Float64Array;
}

/**
 * One buffer holding every column of up to `rows` rows (`CHUNK_ROWS` unless the store says otherwise).
 * Rows in use are `[start, end)`: a chunk at the head of a store fills downward, one at the tail fills upward.
 * A chunk let go of holds only its time column, or no column at all, and a summary.
 */
export interface Chunk {
	readonly buffer: ArrayBuffer;
	/** One view per column, created once so hot paths never allocate views. */
	readonly columns: readonly Float64Array[];
	start: number;
	end: number;
	readonly summary?: ChunkSummary;
}

export function createChunk(columnCount: number, rows: number = CHUNK_ROWS): Chunk {
	const buffer = new ArrayBuffer(columnCount * rows * Float64Array.BYTES_PER_ELEMENT);
	const columns: Float64Array[] = [];
	for (let c = 0; c < columnCount; c++) {
		columns.push(new Float64Array(buffer, c * rows * Float64Array.BYTES_PER_ELEMENT, rows));
	}
	return { buffer, columns, start: 0, end: 0 };
}
