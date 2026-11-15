import { LEVEL_CHUNK_SHIFT } from './chunk';
import { levelShift } from './protocol';
import { ChunkedStore } from './store';

/** How a level column is aggregated from its members. Missing values (NaN) are always skipped. */
export const FIRST = 0;
export const MAX = 1;
export const MIN = 2;
export const LAST = 3;

/** Time of a bucket: the time of its first row. */
export const TIME_AGGREGATES: readonly number[] = [FIRST];
/** Line: first, highest, lowest and last value, in the column order of open, high, low and close. */
export const LINE_AGGREGATES: readonly number[] = [FIRST, MAX, MIN, LAST];
/**
 * OHLCV: first open, highest high, lowest low, last close, and the largest volume. A sum would make
 * volume bars grow fourfold at every level change.
 */
export const OHLCV_AGGREGATES: readonly number[] = [FIRST, MAX, MIN, LAST, MAX];

/**
 * Level-of-detail buckets of one column set over the main timeline: level `k` sits in
 * `levels[k - 1]`, a store of buckets addressed by `index >> levelShift(k)`.
 *
 * Every level of every pyramid spans the buckets of the whole main timeline, so the same bucket
 * index means the same rows in all of them. Level stores use their own chunk grid
 * (`LEVEL_CHUNK_SHIFT`) aligned with raw chunks, which keeps per-chunk bookkeeping possible.
 */
export class Pyramid {
	public readonly aggregates: readonly number[];
	public readonly levels: ChunkedStore[] = [];

	public constructor(aggregates: readonly number[]) {
		this.aggregates = aggregates;
	}

	public get columnCount(): number {
		return this.aggregates.length;
	}

	/** Bytes held by all levels. */
	public get byteLength(): number {
		let bytes = 0;
		for (const level of this.levels) {
			bytes += level.byteLength;
		}
		return bytes;
	}

	/** Empties the pyramid and gives it `count` levels for a timeline starting at index `first`. */
	public reset(count: number, first: number): void {
		this.levels.length = 0;
		for (let k = 1; k <= count; k++) {
			this.addLevel(first);
		}
	}

	/** Adds an empty level above the current top one. */
	public addLevel(first: number): ChunkedStore {
		const level = new ChunkedStore(this.aggregates.length, LEVEL_CHUNK_SHIFT);
		level.clear(first >> levelShift(this.levels.length + 1));
		this.levels.push(level);
		return level;
	}
}

/**
 * Aggregates source rows `[lo, hi)` into groups of `2^g` rows aligned on multiples of `2^g`, one
 * output column per entry of `aggregates`. Global row `r` of output column `c` is read from
 * `sources[c][r - bases[c]]`. The group holding `lo` is written to `out[c * stride + at]`, the next
 * one after it, and so on. `lo` and `hi` must not cut a group except at the ends of the data.
 * Returns the number of groups written.
 */
export function aggregate(
	sources: readonly Float64Array[],
	bases: readonly number[],
	lo: number,
	hi: number,
	g: number,
	aggregates: readonly number[],
	out: Float64Array,
	stride: number,
	at: number,
): number {
	let written = 0;
	const columns = aggregates.length;
	for (let c = 0; c < columns; c++) {
		const source = sources[c]!;
		const base = bases[c]!;
		const kind = aggregates[c]!;
		const offset = c * stride + at;
		// A line reads one source for its highest and lowest value: both come out of one pass.
		const fused =
			kind === MAX &&
			c + 1 < columns &&
			aggregates[c + 1] === MIN &&
			sources[c + 1] === source &&
			bases[c + 1] === base;
		let k = 0;
		let r = lo;
		while (r < hi) {
			const next = ((r >> g) + 1) << g;
			const end = next < hi ? next : hi;
			const from = r - base;
			const to = end - base;
			if (fused) {
				let max = -Infinity;
				let min = Infinity;
				for (let i = from; i < to; i++) {
					const value = source[i]!;
					// Comparisons with NaN are false, so missing values are skipped.
					if (value > max) {
						max = value;
					}
					if (value < min) {
						min = value;
					}
				}
				out[offset + k] = max === -Infinity ? NaN : max;
				out[offset + stride + k] = min === Infinity ? NaN : min;
			} else if (kind === MAX) {
				let max = -Infinity;
				for (let i = from; i < to; i++) {
					const value = source[i]!;
					if (value > max) {
						max = value;
					}
				}
				out[offset + k] = max === -Infinity ? NaN : max;
			} else if (kind === MIN) {
				let min = Infinity;
				for (let i = from; i < to; i++) {
					const value = source[i]!;
					if (value < min) {
						min = value;
					}
				}
				out[offset + k] = min === Infinity ? NaN : min;
			} else if (kind === FIRST) {
				let value = NaN;
				for (let i = from; i < to; i++) {
					const v = source[i]!;
					if (v === v) {
						value = v;
						break;
					}
				}
				out[offset + k] = value;
			} else {
				let value = NaN;
				for (let i = to - 1; i >= from; i--) {
					const v = source[i]!;
					if (v === v) {
						value = v;
						break;
					}
				}
				out[offset + k] = value;
			}
			k++;
			r = end;
		}
		if (fused) {
			c++;
		}
		written = k;
	}
	return written;
}

/**
 * Stores buckets `[lo, hi)` of `block` (column-major, columns `total` long, bucket `lo` first) in a
 * level: buckets the level holds are overwritten, the others are linked at either end. The range
 * must overlap or touch the buckets held.
 */
export function storeBuckets(level: ChunkedStore, block: Float64Array, total: number, lo: number, hi: number): void {
	const first = level.first;
	const end = level.end;
	const from = Math.max(lo, first);
	const to = Math.min(hi, end);
	if (from < to) {
		level.write(block, total, from - lo, to - lo, from);
	}
	if (hi > end) {
		level.append(block, total, Math.max(end, lo) - lo, hi - lo);
	}
	if (lo < first) {
		level.prepend(block, total, 0, Math.min(first, hi) - lo);
	}
}
