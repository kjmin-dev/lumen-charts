import { PALETTE_SIZE, type ValueMapping } from './palette';
import type { TimeMap } from './time-map';

/**
 * Drawing marks into a pixel buffer: 32-bit pixels of the pane that one `putImageData` hands over.
 * Canvas 2D draws 100,000 rectangles in 18 ms; written into a buffer, a million points take a few
 * milliseconds.
 *
 * The buffer holds the pane column by column: the pixel at device column `x` and row `y` is
 * `pixels[x * height + y]`. Marks come in time order and a heatmap is stored column by column, so
 * drawing them walks the buffer from one end to the other, and everything of one device column lies
 * within a few kilobytes. Row by row, as an `ImageData` of the pane would be, every point of a
 * scatter lands in another part of a buffer of several megabytes. The canvas that takes the buffer
 * is the pane transposed, and is composited with x and y swapped (see `PixelSurface`).
 *
 * Everything here works on typed arrays alone and allocates nothing.
 */

/** The rectangle of device pixels a call wrote into: `[left, right)` by `[top, bottom)`; empty when `right <= left`. */
export interface PixelBox {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export function emptyBox(box: PixelBox): void {
	box.left = Infinity;
	box.top = Infinity;
	box.right = -Infinity;
	box.bottom = -Infinity;
}

/** Where prices fall down the pane, in device pixels: `y = offset - value * scale`, of `log10(price)` when `log`. */
export interface PriceProjection {
	offset: number;
	scale: number;
	log: boolean;
}

/**
 * The shape of a scatter point: for each of its `size` rows, the pixels `[from, to)` it covers,
 * counted from the left edge of the point's box. A shape is the same across and down, so the spans
 * also are the pixels it covers of each of its columns, counted from the top.
 */
export interface PointStamp {
	size: number;
	/** `from` and `to` of each row. */
	spans: Int32Array;
	/** Every row is the whole width: a square. */
	square: boolean;
}

/** A square of `size` device pixels, or a disc of that diameter (a square below 3 pixels). */
export function makeStamp(size: number, circle: boolean): PointStamp {
	const spans = new Int32Array(size * 2);
	const radius = size / 2;
	let square = true;
	for (let row = 0; row < size; row++) {
		let from = 0;
		let to = size;
		if (circle && size >= 3) {
			// The pixels whose centers are inside the disc.
			const dy = row + 0.5 - radius;
			const half = Math.sqrt(Math.max(0, radius * radius - dy * dy));
			from = Math.max(0, Math.round(radius - half));
			to = Math.min(size, Math.round(radius + half));
		}
		spans[row * 2] = from;
		spans[row * 2 + 1] = to;
		square &&= from === 0 && to === size;
	}
	return { size, spans, square };
}

/**
 * Draws points `[from, to)` of a scatter window, which are in time order. A point is stamped with
 * its center on the device pixel its time and price round to; a later point overwrites an earlier
 * one where they overlap. Its color is the palette's for its value, or `color` without one. `shift`
 * is added to every x (half a bar to the left for points placed from the start of their bar).
 * `box` grows by the pixels written.
 */
export function drawScatter(
	pixels: Uint32Array,
	width: number,
	height: number,
	time: Float64Array,
	price: Float64Array,
	values: Float32Array,
	from: number,
	to: number,
	map: TimeMap,
	shift: number,
	projection: PriceProjection,
	palette: Uint32Array,
	mapping: ValueMapping,
	color: number,
	stamp: PointStamp,
	box: PixelBox,
): void {
	if (to <= from || map.count === 0) {
		return;
	}
	const { offset, scale, log } = projection;
	const size = stamp.size;
	const spans = stamp.spans;
	// The sizes most points have are written without a loop.
	const shape = !stamp.square || size > 3 ? 0 : size;
	const half = size >> 1;
	const maxX = width - size;
	const maxY = height - size;
	const valueMin = mapping.min;
	const factor = mapping.factor;
	const valueLog = mapping.log;
	const top = PALETTE_SIZE - 1;
	let left = width;
	let right = -size - 1;
	let minY = height;
	let maxRow = -size - 1;
	map.segment(time[from]!);
	let t0 = map.t0;
	let t1 = map.t1;
	let x0 = map.x0 + shift;
	let pace = map.pace;
	for (let i = from; i < to; i++) {
		const t = time[i]!;
		while (t >= t1) {
			map.next();
			t0 = map.t0;
			t1 = map.t1;
			x0 = map.x0 + shift;
			pace = map.pace;
		}
		const p = price[i]!;
		const px = Math.round(x0 + (t - t0) * pace) - half;
		const py = Math.round(offset - (log ? Math.log10(p) : p) * scale) - half;
		// Also false for a price the scale cannot show, whose row is not a number.
		if (!(px > -size && px < width && py > -size && py < height)) {
			continue;
		}
		const v = values[i]!;
		let c = color;
		if (v === v) {
			const index = ((valueLog ? (v > 0 ? Math.log10(v) : -Infinity) : v) - valueMin) * factor + 0.5;
			c = palette[index >= top ? top : index > 0 ? index | 0 : 0]!;
		}
		if (px >= 0 && px <= maxX && py >= 0 && py <= maxY) {
			let base = px * height + py;
			if (shape === 3) {
				pixels[base] = c;
				pixels[base + 1] = c;
				pixels[base + 2] = c;
				base += height;
				pixels[base] = c;
				pixels[base + 1] = c;
				pixels[base + 2] = c;
				base += height;
				pixels[base] = c;
				pixels[base + 1] = c;
				pixels[base + 2] = c;
			} else if (shape === 1) {
				pixels[base] = c;
			} else if (shape === 2) {
				pixels[base] = c;
				pixels[base + 1] = c;
				pixels[base + height] = c;
				pixels[base + height + 1] = c;
			} else {
				// A stamp is the same across and down: its spans are read as runs down each column.
				for (let column = 0; column < size; column++) {
					const end = base + spans[column * 2 + 1]!;
					for (let at = base + spans[column * 2]!; at < end; at++) {
						pixels[at] = c;
					}
					base += height;
				}
			}
		} else {
			// At an edge of the pane: the part of the point inside it.
			for (let column = 0; column < size; column++) {
				const x = px + column;
				if (x < 0 || x >= width) {
					continue;
				}
				const end = x * height + Math.min(height, py + spans[column * 2 + 1]!);
				for (let at = x * height + Math.max(0, py + spans[column * 2]!); at < end; at++) {
					pixels[at] = c;
				}
			}
		}
		// Points are in time order, so the first one drawn is the leftmost and the last the rightmost.
		if (left > px) {
			left = px;
		}
		right = px;
		if (py < minY) {
			minY = py;
		}
		if (py > maxRow) {
			maxRow = py;
		}
	}
	if (right >= left) {
		box.left = Math.min(box.left, Math.max(0, left));
		box.right = Math.max(box.right, Math.min(width, right + size));
		box.top = Math.min(box.top, Math.max(0, minY));
		box.bottom = Math.max(box.bottom, Math.min(height, maxRow + size));
	}
}

/** The lowest and highest price of points `[from, to)`, into `out`; `low > high` without one. */
export function priceExtent(price: Float64Array, from: number, to: number, out: { low: number; high: number }): void {
	let low = Infinity;
	let high = -Infinity;
	for (let i = from; i < to; i++) {
		const p = price[i]!;
		low = Math.min(low, p);
		high = Math.max(high, p);
	}
	out.low = low;
	out.high = high;
}

/**
 * Turns the values of heatmap cells `[from, to)` into slots of a color table: 0 for a cell without
 * a value, 1 to 255 from the lowest value to the highest. `slots` is laid out like `values`.
 */
export function quantize(
	values: Float32Array,
	slots: Uint8Array,
	from: number,
	to: number,
	mapping: ValueMapping,
): void {
	const min = mapping.min;
	const factor = (mapping.factor * (PALETTE_SIZE - 2)) / (PALETTE_SIZE - 1);
	const log = mapping.log;
	for (let i = from; i < to; i++) {
		const v = values[i]!;
		if (v !== v) {
			slots[i] = 0;
			continue;
		}
		const index = ((log ? (v > 0 ? Math.log10(v) : -Infinity) : v) - min) * factor + 1.5;
		slots[i] = index >= PALETTE_SIZE - 1 ? PALETTE_SIZE - 1 : index > 1 ? index | 0 : 1;
	}
}

/** The color table of slots: slot 0 is transparent, slots 1 to 255 span the palette. */
export function slotColors(palette: Uint32Array, out: Uint32Array): void {
	out[0] = 0;
	for (let slot = 1; slot < PALETTE_SIZE; slot++) {
		out[slot] = palette[Math.round(((slot - 1) * (PALETTE_SIZE - 1)) / (PALETTE_SIZE - 2))]!;
	}
}

/**
 * Where a heatmap window's cells are, column by column: what `MarksWindow` tells of them. Cell `r`
 * of held column `c` is grid row `cellOffset(c) + r`, for `r` below `cellLength(c)`, and is
 * `values[cellStart(c) + r]`. Row `g` of the grid covers prices `[priceStart + g * priceStep, ...)`.
 */
export interface HeatLayout {
	rows: number;
	priceStart: number;
	priceStep: number;
	/** Columns start at grid rows of their own: `cellOffset` is not always 0. */
	readonly varying: boolean;
	cellStart(column: number): number;
	cellOffset(column: number): number;
	cellLength(column: number): number;
}

/** Buffers a heatmap is drawn with, kept between frames. */
export class HeatmapScratch {
	/** Device x of the left edge of each column drawn, and of the right edge of the last. */
	public edges = new Int32Array(0);
	/**
	 * Grid row that the rows below count from: the lowest first row of the columns drawn (0 on a grid
	 * that does not follow the price). `firstRow`, `endRow`, `rowTop` and `rowBottom` count from it.
	 */
	public rowBase = 0;
	public firstRow = 0;
	public endRow = 0;
	public top = 0;
	public bottom = 0;
	/** The pixel rows `[rowTop, rowBottom)` each cell row covers; none where they are equal. */
	public rowTop = new Int32Array(0);
	public rowBottom = new Int32Array(0);
	/** Slots of the columns narrower than a pixel that share the next pixel column: the highest per cell row. */
	public merged = new Uint8Array(0);

	public reserve(columns: number, rows: number): void {
		if (this.edges.length < columns + 1) {
			this.edges = new Int32Array((columns + 1) * 2);
		}
		if (this.rowTop.length < rows) {
			this.rowTop = new Int32Array(rows);
			this.rowBottom = new Int32Array(rows);
			this.merged = new Uint8Array(rows);
		}
	}
}

/** Exclusive end of the final column, in the same time coordinates as its start. */
export function heatEndTime(time: Float64Array, count: number, map: TimeMap): number {
	const last = time[count - 1]!;
	return count > 1 ? last + (last - time[count - 2]!) : map.barEnd(last);
}

/** Device edge before a column, or after the final column. */
export function heatEdge(time: Float64Array, count: number, column: number, map: TimeMap): number {
	const t = column < count ? time[column]! : heatEndTime(time, count, map);
	return Math.round(map.x(t) - map.spacing / 2);
}

/**
 * The grid rows columns `[from, to)` span: `[low, high)`, written to `out`. On a grid that does not
 * follow the price, `[0, rows)`.
 */
export function heatRowSpan(layout: HeatLayout, from: number, to: number, out: { low: number; high: number }): void {
	if (!layout.varying) {
		out.low = 0;
		out.high = layout.rows;
		return;
	}
	let low = Infinity;
	let high = -Infinity;
	for (let c = from; c < to; c++) {
		const length = layout.cellLength(c);
		if (length > 0) {
			const offset = layout.cellOffset(c);
			low = Math.min(low, offset);
			high = Math.max(high, offset + length);
		}
	}
	out.low = low < high ? low : 0;
	out.high = low < high ? high : 0;
}

const SPAN = { low: 0, high: 0 };

/** Shared pixel boundaries for Canvas 2D, WebGL2 and WebGPU. */
export function heatGeometry(
	height: number,
	time: Float64Array,
	layout: HeatLayout,
	count: number,
	from: number,
	to: number,
	map: TimeMap,
	projection: PriceProjection,
	scratch: HeatmapScratch,
	clipLeft: number,
	clipRight: number,
): boolean {
	if (to <= from || map.count === 0 || clipRight <= clipLeft) {
		return false;
	}
	const columns = to - from;
	heatRowSpan(layout, from, to, SPAN);
	const base = SPAN.low;
	const rows = SPAN.high - SPAN.low;
	scratch.reserve(columns, rows);
	scratch.rowBase = base;
	const edges = scratch.edges;
	const rowTop = scratch.rowTop;
	const rowBottom = scratch.rowBottom;
	for (let c = 0; c <= columns; c++) {
		const x = heatEdge(time, count, from + c, map);
		edges[c] = Math.max(clipLeft, Math.min(clipRight, x));
	}
	const left = edges[0]!;
	const right = edges[columns]!;
	if (right <= left || rows <= 0) {
		return false;
	}
	// The cell rows that are in the pane, `[firstRow, endRow)`, and the pixel rows they cover.
	const { offset, scale, log } = projection;
	const { priceStart, priceStep } = layout;
	let firstRow = rows;
	let endRow = 0;
	let top = height;
	let bottom = 0;
	let previous = 0;
	for (let r = 0; r <= rows; r++) {
		const price = priceStart + (base + r) * priceStep;
		const y = offset - (log ? Math.log10(price) : price) * scale;
		// A price a logarithmic scale cannot show is below everything it can.
		const edge = y === y ? Math.round(y) : scale > 0 ? Infinity : -Infinity;
		if (r > 0) {
			const above = Math.max(0, Math.min(previous, edge));
			const below = Math.min(height, Math.max(previous, edge));
			rowTop[r - 1] = above;
			rowBottom[r - 1] = Math.max(above, below);
			if (Math.max(previous, edge) > 0 && Math.min(previous, edge) < height) {
				if (r - 1 < firstRow) {
					firstRow = r - 1;
				}
				endRow = r;
				top = Math.min(top, above);
				bottom = Math.max(bottom, below);
			}
		}
		previous = edge;
	}
	if (endRow <= firstRow || bottom <= top) {
		return false;
	}
	scratch.firstRow = firstRow;
	scratch.endRow = endRow;
	scratch.top = top;
	scratch.bottom = bottom;
	return true;
}

/**
 * Draws columns `[from, to)` of a heatmap window into device columns `[clipLeft, clipRight)`.
 *
 * A column covers the pixels from where its time falls (the left edge of the bar at that time) to
 * where the next column's does; the last column is as wide in time as the one before it, or one bar
 * wide when it is the only one. Cell `r` covers the pixels between the rows of its two prices. Edges
 * are rounded to device pixels once, so neighbors share an edge and leave no seam. Where several
 * cells fall into one pixel (more columns than pixels across, or more rows than pixels down), the
 * pixel takes the highest of them, so a peak survives zooming out. Grid rows a column has no cell
 * on (where the grid follows the price) are transparent in it.
 *
 * The cost is one pass over the cells in view and a copy of the pixels they cover: a column of
 * pixels is computed once per heatmap column, from the cell rows that are in the pane, and copied
 * across the pixel columns the heatmap column covers.
 */
export function drawHeatmap(
	pixels: Uint32Array,
	width: number,
	height: number,
	time: Float64Array,
	slots: Uint8Array,
	layout: HeatLayout,
	count: number,
	from: number,
	to: number,
	map: TimeMap,
	projection: PriceProjection,
	colors: Uint32Array,
	scratch: HeatmapScratch,
	clipLeft: number,
	clipRight: number,
	box: PixelBox,
): void {
	if (!heatGeometry(height, time, layout, count, from, to, map, projection, scratch, clipLeft, clipRight)) {
		return;
	}
	const { edges, rowTop, rowBottom, merged, firstRow, endRow, top, bottom, rowBase } = scratch;
	const columns = to - from;
	const left = edges[0]!;
	const right = edges[columns]!;
	// Columns narrower than a pixel are gathered in `merged` until a column has a pixel.
	let gathered = false;
	for (let c = 0; c < columns; c++) {
		const x0 = edges[c]!;
		const x1 = edges[c + 1]!;
		const column = from + c;
		// The column's cells as rows counted from `rowBase`: `[lo, hi)`, cell `g - lo` at `at + g - lo`.
		const lo = layout.cellOffset(column) - rowBase;
		const hi = lo + layout.cellLength(column);
		let source = slots;
		let at = layout.cellStart(column) - lo;
		let low = Math.max(firstRow, lo);
		let high = Math.min(endRow, hi);
		if (x1 <= x0 || gathered) {
			if (x1 <= clipLeft) {
				// Left of the columns drawn: it shares no pixel with them.
				continue;
			}
			if (gathered) {
				for (let r = low; r < high; r++) {
					const s = slots[at + r]!;
					if (s > merged[r]!) {
						merged[r] = s;
					}
				}
			} else {
				merged.fill(0, firstRow, endRow);
				for (let r = low; r < high; r++) {
					merged[r] = slots[at + r]!;
				}
				gathered = true;
			}
			if (x1 <= x0) {
				continue;
			}
			gathered = false;
			source = merged;
			at = 0;
			low = firstRow;
			high = endRow;
		}
		// The first pixel column of this heatmap column. Cell rows shorter than a pixel share the
		// pixel of the next row that has one, which takes the highest of them.
		const base = x0 * height;
		let slot = 0;
		for (let r = firstRow; r < endRow; r++) {
			if (r >= low && r < high) {
				const s = source[at + r]!;
				if (s > slot) {
					slot = s;
				}
			}
			const y0 = rowTop[r]!;
			const y1 = rowBottom[r]!;
			if (y1 === y0) {
				continue;
			}
			const color = colors[slot]!;
			if (y1 - y0 === 1) {
				pixels[base + y0] = color;
			} else if (y1 - y0 < 16) {
				for (let i = base + y0; i < base + y1; i++) {
					pixels[i] = color;
				}
			} else {
				pixels.fill(color, base + y0, base + y1);
			}
			slot = 0;
		}
		for (let x = x0 + 1; x < x1; x++) {
			pixels.copyWithin(x * height + top, base + top, base + bottom);
		}
	}
	box.left = Math.min(box.left, left);
	box.right = Math.max(box.right, right);
	box.top = Math.min(box.top, top);
	box.bottom = Math.max(box.bottom, bottom);
}
