import type { MarkFrame } from '../backend';
import { paletteIndex, type ValueMapping } from '../palette';
import { slotColors } from '../render';
import type { ScatterOptions } from '../options';

const bits = new Uint32Array(1);
const scalar = new Float32Array(bits.buffer);

/** The first IEEE-754 float32 that belongs to each slot. Source values use the same
 * scalar ordering on the GPU, including infinities, subnormals and a collapsed range. */
export function heatStyle(palette: Uint32Array, mapping: ValueMapping, out: Uint32Array): void {
	slotColors(palette, out);
	const factor = (mapping.factor * 254) / 255;
	for (let slot = 2; slot < 256; slot++) {
		let lo = 0x007fffff,
			hi = 0xff800001;
		while (lo < hi) {
			const mid = lo + Math.floor((hi - lo) / 2);
			bits[0] = mid < 0x80000000 ? ~mid : mid ^ 0x80000000;
			const value = scalar[0]!;
			const scaled = ((mapping.log ? (value > 0 ? Math.log10(value) : -Infinity) : value) - mapping.min) * factor + 1.5;
			if (scaled >= slot) hi = mid;
			else lo = mid + 1;
		}
		out[256 + slot] = lo;
	}
}

/**
 * The first of rows `[from, to)` whose time is `time` or later, or `to`. The search starts at
 * `guess` and doubles its step away from it, so for a guess near the row it reads a few rows close
 * together: the rows of a large window are megabytes, and a binary search across them misses the
 * cache at nearly every step, which costs more than the comparisons.
 */
function firstAtOrAfter(times: Float64Array, from: number, to: number, time: number, guess: number): number {
	if (from >= to || !(times[from]! < time)) return from;
	// Rows before `lo` are earlier than `time`; `hi` is `to` or a row at `time` or later.
	let lo = from + 1,
		hi: number,
		step = 1;
	const at = Math.min(Math.max(guess, lo), to);
	if (at < to && times[at]! < time) {
		lo = at + 1;
		hi = lo;
		while (hi < to && times[hi]! < time) {
			lo = hi + 1;
			step *= 2;
			hi = at + step;
		}
		if (hi > to) hi = to;
	} else {
		hi = at;
		let probe = at - 1;
		while (probe >= lo && !(times[probe]! < time)) {
			hi = probe;
			step *= 2;
			probe = at - step;
		}
		if (probe >= lo) lo = probe + 1;
	}
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (times[mid]! < time) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/**
 * Binary64 time comparisons keep session gaps and fractional pixel ties on the same side as Canvas
 * 2D. The GPU receives original row indices, never epoch milliseconds.
 *
 * `out[i]` is the first row in view whose center is at or right of column `i - pad`. Columns from
 * `start` on are written; those before it must hold what a call for all of them would have written
 * (the rows they find did not change).
 */
export function scatterBounds(f: MarkFrame, size: number, out: Uint32Array, start = 0): void {
	const w = f.window,
		map = f.map,
		times = w.time;
	const shift = (f.options as ScatterOptions).barAlign === 'start' ? -map.spacing / 2 : 0;
	const pad = size - 1 - (size >> 1);
	let previous = start > 0 ? out[start - 1]! : f.from;
	// Columns are equally wide: the rows of a column are a guess for those of the next.
	let gap = 0;
	const center = (id: number) => {
		const t = times[id]!;
		map.segment(t);
		return Math.round(map.x0 + shift + (t - map.t0) * map.pace);
	};
	for (let i = start; i < f.width + size; i++) {
		const x = i - pad;
		const t = map.time(x - 0.5 - shift);
		// As `max(previous, min(f.to, w.lowerBound(t)))`: the rows are in time order.
		let id = firstAtOrAfter(times, previous, f.to, t, previous + gap);
		if ((id > previous && center(id - 1) >= x) || (id < f.to && center(id) < x)) {
			let lo = previous,
				hi = f.to;
			while (lo < hi) {
				const mid = (lo + hi) >>> 1;
				if (center(mid) < x) lo = mid + 1;
				else hi = mid;
			}
			id = lo;
		}
		out[i] = id;
		gap = id - previous;
		previous = id;
	}
}

export function scatterRecords(f: MarkFrame, packed: Uint32Array, from: number, to: number, fallback: number): void {
	const { window: w, projection: p, palette, mapping } = f;
	for (let i = from; i < to; i++) {
		const price = w.price[i]!,
			value = w.values[i]!;
		const y = Math.round(p.offset - (p.log ? Math.log10(price) : price) * p.scale);
		packed[2 * i] = Number.isNaN(y) ? 0x3fffffff : Math.max(-0x3fffffff, Math.min(0x3fffffff, y));
		packed[2 * i + 1] = value === value ? palette[paletteIndex(mapping, value)]! : fallback;
	}
}

/** Limit index build cost by held rows. A burst that packs an eighth of the
 * visible IDs into 1/64 of the pixel span favors the column kernel. */
export function fitsTileIndex(f: MarkFrame): boolean {
	if (f.window.count > 300_000) return false;
	const n = f.to - f.from;
	if (n < 1024) return true;
	const time = f.window.time,
		map = f.map;
	const span = map.x(time[f.to - 1]!) - map.x(time[f.from]!);
	const step = Math.floor(n / 8);
	let x = map.x(time[f.from]!);
	for (let i = f.from + step; i < f.to; i += step) {
		const next = map.x(time[i]!);
		if (next - x <= span / 64) return false;
		x = next;
	}
	return true;
}

export class PriceBands {
	public offsets: Uint32Array<ArrayBuffer> = new Uint32Array(0);
	public ids: Uint32Array<ArrayBuffer> = new Uint32Array(0);
	private cursors = new Uint32Array(0);
	public build(records: Uint32Array, count: number, height: number, size: number): void {
		const n = Math.ceil(height / 16);
		if (this.offsets.length < n + 1) {
			this.offsets = new Uint32Array(n + 1);
			this.cursors = new Uint32Array(n);
		} else this.offsets.fill(0, 0, n + 1);
		const half = size >> 1;
		for (let pass = 0; pass < 2; pass++) {
			for (let i = 0; i < count; i++) {
				const top = (records[2 * i]! | 0) - half;
				const a = Math.max(0, top >> 4),
					b = Math.min(n - 1, (top + size - 1) >> 4);
				for (let band = a; band <= b; band++) {
					if (pass === 0) this.offsets[band + 1] = this.offsets[band + 1]! + 1;
					else {
						const at = this.cursors[band]!;
						this.ids[at] = i;
						this.cursors[band] = at + 1;
					}
				}
			}
			if (pass === 0) {
				for (let i = 1; i <= n; i++) this.offsets[i] = this.offsets[i]! + this.offsets[i - 1]!;
				this.cursors.set(this.offsets.subarray(0, n));
				const required = this.offsets[n]!;
				if (this.ids.length < required) this.ids = new Uint32Array(required);
			}
		}
	}
}
