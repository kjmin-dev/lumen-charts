import type { MarkFrame } from './backend';
import { heatGeometry, HeatmapScratch } from './render';

export class HeatRanges {
	private readonly scratch = new HeatmapScratch();
	public data: Uint32Array<ArrayBuffer> = new Uint32Array(0);
	public project(f: Pick<MarkFrame, 'window' | 'width' | 'height' | 'map' | 'projection' | 'from' | 'to'>): void {
		const n = (f.width + f.height) * 2;
		if (this.data.length < n) this.data = new Uint32Array(n);
		else this.data.fill(0, 0, n);
		const w = f.window,
			s = this.scratch;
		if (
			!heatGeometry(
				f.height,
				w.time,
				w.rows,
				w.count,
				f.from,
				f.to,
				w.priceStart,
				w.priceStep,
				f.map,
				f.projection,
				s,
				0,
				f.width,
			)
		)
			return;
		let first = f.from;
		for (let c = f.from; c < f.to; c++) {
			const left = s.edges[c - f.from]!,
				right = s.edges[c - f.from + 1]!;
			if (right === 0) {
				first = c + 1;
				continue;
			}
			if (left === right) continue;
			for (let x = left; x < right; x++) {
				this.data[x * 2] = first;
				this.data[x * 2 + 1] = c + 1;
			}
			first = c + 1;
		}
		first = s.firstRow;
		for (let r = s.firstRow; r < s.endRow; r++) {
			const top = s.rowTop[r]!,
				bottom = s.rowBottom[r]!;
			if (top === bottom) continue;
			for (let y = top; y < bottom; y++) {
				const i = (f.width + y) * 2;
				this.data[i] = first;
				this.data[i + 1] = r + 1;
			}
			first = r + 1;
		}
	}
}

/** Find an exact translation of the previously drawn source bins. Comparing the ranges
 * also catches newly loaded rows, fractional edges, subpixel reduction and session gaps. */
export class HeatPan {
	private anchor = NaN;
	private previous = new Uint32Array(0);
	public translation(
		anchor: number,
		ranges: Uint32Array,
		width: number,
		height: number,
		compatible: boolean,
	): number | null {
		const n = 2 * (width + height),
			delta = anchor - this.anchor;
		let reuse = compatible && Number.isInteger(delta) && Math.abs(delta) < width && this.previous.length === n;
		const left = Math.max(0, delta) * 2,
			right = Math.min(width, width + delta) * 2;
		for (let i = width * 2; i < n && reuse; i++) reuse = this.previous[i] === ranges[i];
		for (let i = left; i < right && reuse; i++) reuse = this.previous[i - delta * 2] === ranges[i];
		if (this.previous.length !== n) this.previous = new Uint32Array(n);
		this.previous.set(ranges.subarray(0, n));
		this.anchor = anchor;
		return reuse ? delta : null;
	}
}
