/** Rows per chunk. Chunks are linked in a deque so both ends grow in O(1). */
export const CHUNK_ROWS = 8192;

/** Column order inside a chunk buffer. */
export const COLUMNS = ['time', 'open', 'high', 'low', 'close', 'volume'] as const;
export type ColumnName = (typeof COLUMNS)[number];

const BYTES_PER_VALUE = Float64Array.BYTES_PER_ELEMENT;

/** One buffer holding every column of up to `CHUNK_ROWS` bars. */
export interface Chunk {
	readonly buffer: ArrayBuffer;
	/** Number of rows in use, counted from the start of each column. */
	length: number;
}

export function createChunk(): Chunk {
	return { buffer: new ArrayBuffer(COLUMNS.length * CHUNK_ROWS * BYTES_PER_VALUE), length: 0 };
}

/** Zero-copy view over one column of a chunk. */
export function columnView(chunk: Chunk, column: ColumnName): Float64Array {
	const offset = COLUMNS.indexOf(column) * CHUNK_ROWS * BYTES_PER_VALUE;
	return new Float64Array(chunk.buffer, offset, CHUNK_ROWS);
}
