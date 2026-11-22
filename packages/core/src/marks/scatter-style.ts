import type { ScatterOptions } from './options';
import { PALETTE_SIZE, type ValueMapping, paletteIndex } from './palette';
import { type DensitySlots, type PointStamp, type PriceProjection, type StampCache, pointPixels } from './render';
import type { TimeMap } from './time-map';
import type { MarksWindow } from './window';

/**
 * What the scatter's sizes and densities need beyond drawing: the palette entry of a density, the
 * widest point a window holds, and the point drawn at a pixel. All three backends read them, so a
 * density gets the same entry, a window the same padding, and a pixel the same point everywhere.
 */

const bits = new Uint32Array(1);
const scalar = new Float32Array(bits.buffer);

/** Whole densities below this many have their palette entry in a table: one read per pixel. */
const LUT_SIZE = 4096;
/** One past the bits of +Infinity: above every density, so a threshold here is never reached. */
const NEVER = 0x7f800001;
/** The largest float below 2^32: densities are held to it, so they are 32-bit unsigned integers. */
const DENSITY_CAP = 4294967040;
/** Densities that keep `255 * (d - 1)` within 32 bits; larger ones are halved with the top until below. */
const EXACT_RANGE = 2 ** 24;

/**
 * The palette entry of density `density` on a palette that spans from 1 to `top`, the largest
 * density of the frame: `255 (density - 1) / (top - 1)`, rounded half up, in whole numbers only.
 * Densities and the top are whole numbers (sums of counts), so this needs no float: the GPU computes
 * it as Canvas 2D does, from the largest density it found itself, and nothing is read back. Above
 * 2^24 both are halved together until the top is below it, which both renderers do alike. A top of
 * 1 puts every density in the middle of the palette, as a range of values without width does.
 */
export function exactDensitySlot(density: number, top: number): number {
	let a = Math.min(density, DENSITY_CAP) - 1;
	let m = Math.min(top, DENSITY_CAP) - 1;
	if (!(m > 0)) {
		return PALETTE_SIZE >> 1;
	}
	while (m >= EXACT_RANGE) {
		m = Math.floor(m / 2);
		a = Math.floor(a / 2);
	}
	const n = 255 * a;
	const q = Math.floor(n / m);
	const slot = q + (2 * (n - q * m) >= m ? 1 : 0);
	return slot < PALETTE_SIZE - 1 ? slot : PALETTE_SIZE - 1;
}

/**
 * Whether a density series' palette spans from 1 to the frame's largest density on a linear scale,
 * whose entries are `exactDensitySlot`: no option fixes either end, and no logarithm is taken.
 */
export function exactDensities(options: ScatterOptions): boolean {
	return options.valueMin === null && options.valueMax === null && options.valueScale !== 'log';
}

/**
 * The palette entries of densities. A density is a sum of counts in a 32-bit float above 0, and a
 * positive float's bits are ordered as its values are; so the entries are given by 255 thresholds,
 * the bits of the smallest density whose entry is each of 1 to 255, and a density's entry is the
 * number of thresholds at or below its bits.
 *
 * Entries come from a mapping of values as values get theirs (`paletteIndex`, in 64-bit floats), or,
 * for a palette from 1 to the frame's largest density on a linear scale, from `exactDensitySlot`.
 * The WebGL2 renderer searches the same thresholds on the GPU, which compares bits exactly, or
 * computes `exactDensitySlot` itself; either way its colors are those of Canvas 2D.
 */
export class DensityScale implements DensitySlots {
	/** `thresholds[k]` for `k` from 1 to 255; `thresholds[0]` is 0. */
	public readonly thresholds = new Uint32Array(PALETTE_SIZE);
	public readonly lut = new Uint8Array(LUT_SIZE);
	public readonly lutSize = LUT_SIZE;
	private _min = Number.NaN;
	private _factor = Number.NaN;
	private _log = false;
	/** The top of `setExact`; NaN for a mapping of values. */
	private _top = Number.NaN;

	/** Takes a mapping of values; nothing is computed again for the one it has. */
	public set(mapping: ValueMapping): boolean {
		if (
			this._top !== this._top &&
			mapping.min === this._min &&
			mapping.factor === this._factor &&
			mapping.log === this._log
		) {
			return false;
		}
		this._min = mapping.min;
		this._factor = mapping.factor;
		this._log = mapping.log;
		this._top = Number.NaN;
		this._build(density => paletteIndex(mapping, density));
		return true;
	}

	/** Takes a palette from 1 to `top` on a linear scale, the entries of `exactDensitySlot`. */
	public setExact(top: number): boolean {
		if (top === this._top) {
			return false;
		}
		this._top = top;
		this._build(density => exactDensitySlot(density, top));
		return true;
	}

	private _build(entry: (density: number) => number): void {
		const thresholds = this.thresholds;
		thresholds[0] = 0;
		// Entries only grow with the density: each search starts at the threshold before it.
		let previous = 1;
		for (let k = 1; k < PALETTE_SIZE; k++) {
			let lo = previous;
			let hi = NEVER;
			while (lo < hi) {
				const mid = lo + Math.floor((hi - lo) / 2);
				bits[0] = mid;
				if (entry(scalar[0]!) >= k) {
					hi = mid;
				} else {
					lo = mid + 1;
				}
			}
			thresholds[k] = lo;
			previous = lo;
		}
		const lut = this.lut;
		lut[0] = 0;
		let slot = 0;
		for (let d = 1; d < LUT_SIZE; d++) {
			scalar[0] = d;
			const key = bits[0]!;
			while (slot < PALETTE_SIZE - 1 && thresholds[slot + 1]! <= key) {
				slot++;
			}
			lut[d] = slot;
		}
	}

	/** The palette entry of a density above 0. */
	public slot(density: number): number {
		scalar[0] = density;
		const key = bits[0]!;
		const thresholds = this.thresholds;
		let lo = 0;
		let hi = PALETTE_SIZE;
		while (lo + 1 < hi) {
			const mid = (lo + hi) >> 1;
			if (key >= thresholds[mid]!) {
				lo = mid;
			} else {
				hi = mid;
			}
		}
		return lo;
	}
}

/** Largest number among `sizes[from, to)`, NaN for none: a size that is not a number is the series'. */
function largestOf(sizes: Float32Array, from: number, to: number): number {
	let largest = -Infinity;
	for (let i = from; i < to; i++) {
		const size = sizes[i]!;
		if (size > largest) {
			largest = size;
		}
	}
	return largest === -Infinity ? Number.NaN : largest;
}

/**
 * The largest size (CSS pixels) among the rows of a window, kept up to date as patches change them:
 * how far beyond the view a series asks for rows, how wide the WebGL2 column ranges are padded, and
 * how far a hit test looks. Taken over every row held rather than those in view, which never
 * clips a point and costs a scan of the window only when its rows are replaced. A patch only adds
 * points (level 0) or merges them into cells (coarser levels), whose size is the largest of theirs,
 * so the largest never goes down until the rows are replaced.
 */
export class SizeExtent {
	private _version = -1;
	private _revision = -1;
	private _count = 0;
	private _largest = Number.NaN;

	/**
	 * Must see every revision of the window before its patches are cleared (`clearDirty`), so the
	 * rows they changed are read.
	 */
	public largest(window: MarksWindow): number {
		const sizes = window.sizes;
		if (window.version !== this._version) {
			this._version = window.version;
			this._largest = sizes.length > 0 ? largestOf(sizes, 0, window.count) : Number.NaN;
		} else if (window.revision !== this._revision && sizes.length > 0) {
			const from = Math.max(0, Math.min(window.dirtyFrom, this._count));
			const to = Math.min(window.count, Math.max(window.dirtyTo, window.count));
			const largest = largestOf(sizes, from, to);
			// NaN (none yet) gives way to any size.
			if (largest > this._largest || (this._largest !== this._largest && largest === largest)) {
				this._largest = largest;
			}
		}
		this._revision = window.revision;
		this._count = window.count;
		return this._largest;
	}
}

/** What `hitScatter` found: the topmost row at the pixel (-1 for none) and the density there. */
export interface ScatterHitRow {
	row: number;
	density: number;
}

/**
 * The rows of `[from, to)` whose stamps cover device pixel `(x, y)`, as `drawScatter` places and
 * shapes them: the last of them (the one drawn on top) into `out.row`, and the sum of their counts
 * into `out.density`, added as `accumulateScatter` adds them. `largest` is the widest stamp of the
 * rows in device pixels: rows are in time order, so the ones whose center is within that of `x`
 * are found by a binary search, and only they are looked at.
 */
export function hitScatter(
	time: Float64Array,
	price: Float64Array,
	sizes: Float32Array,
	counts: Float32Array,
	from: number,
	to: number,
	map: TimeMap,
	shift: number,
	projection: PriceProjection,
	stamp: PointStamp,
	stamps: StampCache,
	ratio: number,
	largest: number,
	x: number,
	y: number,
	out: ScatterHitRow,
): void {
	out.row = -1;
	out.density = 0;
	if (to <= from || map.count === 0) {
		return;
	}
	const center = (i: number): number => {
		const t = time[i]!;
		map.segment(t);
		return Math.round(map.x0 + shift + (t - map.t0) * map.pace);
	};
	let lo = from;
	let hi = to;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (center(mid) < x - largest) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	const { offset, scale, log } = projection;
	const sized = sizes.length > 0;
	const counted = counts.length > 0;
	let density = 0;
	for (let i = lo; i < to; i++) {
		const cx = center(i);
		if (cx > x + largest) {
			break;
		}
		const css = sized ? sizes[i]! : Number.NaN;
		const own = css === css ? stamps.get(pointPixels(css, ratio)) : stamp;
		const size = own.size;
		const half = size >> 1;
		const left = cx - half;
		if (x < left || x >= left + size) {
			continue;
		}
		const p = price[i]!;
		const top = Math.round(offset - (log ? Math.log10(p) : p) * scale) - half;
		// False for a price the scale cannot show, as it is not drawn.
		if (!(y >= top && y < top + size)) {
			continue;
		}
		const column = x - left;
		const row = y - top;
		if (row < own.spans[column * 2]! || row >= own.spans[column * 2 + 1]!) {
			continue;
		}
		out.row = i;
		density = Math.fround(density + (counted ? counts[i]! : 1));
	}
	out.density = density;
}
