// What scanning the engine's chunked store costs against one contiguous buffer per column: the
// claim of the design's adversarial review (section 1.3, "1.4 to 1.8 times slower ... negligible in
// absolute terms"). The store is the engine's own `ChunkedStore`, 8,192 rows per chunk. Bundled by
// `scan-cost.mjs` and run in Node and in each browser engine.

import { CHUNK_SHIFT, HIGH, LOW, OHLCV_COLUMNS } from '../../../packages/engine/src/chunk';
import { ChunkedStore } from '../../../packages/engine/src/store';

export interface ScanResult {
	scan: string;
	rows: number;
	/** Median over the passes, nanoseconds per row. */
	chunkedNsPerRow: number;
	contiguousNsPerRow: number;
	/** chunked / contiguous, of the medians. */
	ratio: number;
	/** Median time of one scan in microseconds. */
	chunkedUs: number;
	contiguousUs: number;
	passes: number;
}

function median(values: number[]): number {
	const sorted = values.toSorted((a, b) => a - b);
	const middle = sorted.length >> 1;
	return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * A copy of `fn` compiled from its source, with a JIT state of its own. Each case gets fresh copies
 * of the loops: otherwise the code a loop was optimized into over 1M rows serves the short views
 * too, and the case run first sets the speed of the others. The loops take everything as
 * arguments, so their source stands alone.
 */
function fresh<T extends (...args: never[]) => number>(fn: T): T {
	return new Function(`return (${fn.toString()})`)() as T;
}

/** Highest high and lowest low of rows `[from, to)`, chunk by chunk, as the engine's loops read the store. */
function chunkedExtremes(store: ChunkedStore, high0: number, low0: number, from: number, to: number): number {
	let high = -Infinity,
		low = Infinity;
	let i = from;
	while (i < to) {
		const chunk = store.chunkAt(i);
		const highs = chunk.columns[high0]!,
			lows = chunk.columns[low0]!;
		const start = i & store.mask;
		const end = Math.min(store.rows, start + (to - i));
		for (let r = start; r < end; r++) {
			const h = highs[r]!,
				l = lows[r]!;
			if (h > high) high = h;
			if (l < low) low = l;
		}
		i += end - start;
	}
	return high - low;
}

function contiguousExtremes(highs: Float64Array, lows: Float64Array, from: number, to: number): number {
	let high = -Infinity,
		low = Infinity;
	for (let r = from; r < to; r++) {
		const h = highs[r]!,
			l = lows[r]!;
		if (h > high) high = h;
		if (l < low) low = l;
	}
	return high - low;
}

/** The same, one row at a time through the store's index (`value`: a shift, a mask and two lookups). */
function indexedExtremes(store: ChunkedStore, high0: number, low0: number, from: number, to: number): number {
	let high = -Infinity,
		low = Infinity;
	for (let i = from; i < to; i++) {
		const h = store.value(high0, i),
			l = store.value(low0, i);
		if (h > high) high = h;
		if (l < low) low = l;
	}
	return high - low;
}

/**
 * Scans `rows` random-walk candles in both layouts: the whole series, and a 2,000-row view that
 * crosses a chunk boundary. Each pass alternates the two layouts; the first `warmup` passes are
 * left out.
 */
export function run(rows = 1_000_000, passes = 15, warmup = 5): ScanResult[] {
	const total = rows;
	const data = new Float64Array(OHLCV_COLUMNS * total);
	let price = 100,
		seed = 7;
	for (let i = 0; i < total; i++) {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		price += (seed / 4294967296 - 0.5) * 0.2;
		data[i] = 1_700_000_000_000 + i * 60_000;
		data[total + i] = price;
		data[2 * total + i] = price + 0.1;
		data[3 * total + i] = price - 0.1;
		data[4 * total + i] = price + 0.05;
		data[5 * total + i] = 1;
	}
	const store = new ChunkedStore(OHLCV_COLUMNS, CHUNK_SHIFT);
	store.append(data, total, 0, total);
	// One buffer per column, as a contiguous store would hold them.
	const highs = data.slice(2 * total, 3 * total),
		lows = data.slice(3 * total, 4 * total);

	const view = 2_000;
	// Starts 500 rows before the chunk boundary nearest the middle, as a view anywhere in the series
	// does now and then.
	const viewFrom = Math.floor(total / 2 / (1 << CHUNK_SHIFT)) * (1 << CHUNK_SHIFT) - 500;
	const cases: [string, number, number, typeof chunkedExtremes][] = [
		['whole series, chunk by chunk', 0, total, chunkedExtremes],
		['2,000-row view, chunk by chunk', viewFrom, viewFrom + view, chunkedExtremes],
		['whole series, row by row through the index', 0, total, indexedExtremes],
	];
	const results: ScanResult[] = [];
	let sink = 0;
	for (const [scan, from, to, loop] of cases) {
		const chunked = fresh(loop),
			contiguous = fresh(contiguousExtremes);
		// Each timed sample covers 10M rows, so even a 1 ms timer step (browsers without isolation)
		// stays under a tenth of it.
		const repeat = Math.max(1, Math.round(10_000_000 / (to - from)));
		const timesChunked: number[] = [],
			timesContiguous: number[] = [];
		for (let pass = 0; pass < passes + warmup; pass++) {
			// Alternate which layout goes first, so drift and caches affect both alike.
			for (const first of pass % 2 ? ['chunked', 'contiguous'] : ['contiguous', 'chunked']) {
				const start = performance.now();
				for (let k = 0; k < repeat; k++)
					sink += first === 'chunked' ? chunked(store, HIGH, LOW, from, to) : contiguous(highs, lows, from, to);
				const elapsed = (performance.now() - start) / repeat;
				if (pass >= warmup) (first === 'chunked' ? timesChunked : timesContiguous).push(elapsed);
			}
		}
		const n = to - from;
		const chunkedMs = median(timesChunked),
			contiguousMs = median(timesContiguous);
		results.push({
			scan,
			rows: n,
			chunkedNsPerRow: (chunkedMs * 1e6) / n,
			contiguousNsPerRow: (contiguousMs * 1e6) / n,
			ratio: chunkedMs / contiguousMs,
			chunkedUs: chunkedMs * 1000,
			contiguousUs: contiguousMs * 1000,
			passes,
		});
	}
	if (sink === 42) console.log(sink);
	return results;
}
