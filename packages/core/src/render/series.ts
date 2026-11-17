import type { SeriesView } from '../views/series-view';
import { NO_DASH } from './chrome';

/**
 * Every function here draws items `[from, to)` of a view, all of them by default. A frame that
 * redraws a range of columns passes the items that can reach into it (see `PaneRenderer.render`):
 * rectangles are drawn per item, and a line drawn from a later item on is the same path from there.
 */

/**
 * Fills one rectangle per item of the given direction from `top` to `bottom` (inclusive), `width`
 * wide and starting `half` left of the item. `inset` shrinks every side; items too short to keep a
 * pixel after that are skipped.
 */
function rects(
	ctx: CanvasRenderingContext2D,
	view: SeriesView,
	direction: number,
	top: Float32Array,
	bottom: Float32Array,
	half: number,
	width: number,
	inset: number,
	from: number,
	to: number,
): void {
	const { x, up } = view;
	const left = inset - half;
	const shrink = 2 * inset;
	for (let k = from; k < to; k++) {
		if (up[k] !== direction) {
			continue;
		}
		const y = top[k]!;
		// An item without a value has NaN coordinates.
		if (y !== y) {
			continue;
		}
		const height = bottom[k]! - y + 1 - shrink;
		if (height > 0) {
			ctx.fillRect(x[k]! + left, y + inset, width - shrink, height);
		}
	}
}

export interface CandleStyle {
	upColor: string;
	downColor: string;
	wickVisible: boolean;
	wickUpColor: string;
	wickDownColor: string;
	borderVisible: boolean;
	borderUpColor: string;
	borderDownColor: string;
}

/**
 * Wicks of the items of one direction, without the part inside the body: `top` and `bottom` are the
 * body rows. Drawn this way when bodies are outlined, so a transparent body shows no wick through it.
 */
function outerWicks(
	ctx: CanvasRenderingContext2D,
	view: SeriesView,
	direction: number,
	top: Float32Array,
	bottom: Float32Array,
	half: number,
	width: number,
	from: number,
	to: number,
): void {
	const { x, up, yHigh, yLow } = view;
	for (let k = from; k < to; k++) {
		if (up[k] !== direction) {
			continue;
		}
		const high = yHigh[k]!;
		if (high !== high) {
			continue;
		}
		const left = x[k]! - half;
		const bodyTop = top[k]!;
		const bodyBottom = bottom[k]!;
		if (bodyTop > high) {
			ctx.fillRect(left, high, width, bodyTop - high);
		}
		const low = yLow[k]!;
		if (low > bodyBottom) {
			ctx.fillRect(left, bodyBottom + 1, width, low - bodyBottom);
		}
	}
}

/**
 * Outlines of the bodies of one direction as a single path, stroked once. Each rectangle is laid
 * half a line width inside the body, so the stroke covers exactly the outer `border` pixels.
 */
function outlines(
	ctx: CanvasRenderingContext2D,
	view: SeriesView,
	direction: number,
	top: Float32Array,
	bottom: Float32Array,
	half: number,
	width: number,
	border: number,
	from: number,
	to: number,
): void {
	const { x, up } = view;
	const offset = border / 2;
	ctx.beginPath();
	for (let k = from; k < to; k++) {
		if (up[k] !== direction) {
			continue;
		}
		const y = top[k]!;
		if (y !== y) {
			continue;
		}
		const height = bottom[k]! - y + 1;
		ctx.rect(x[k]! - half + offset, y + offset, width - border, Math.max(0, height - border));
	}
	ctx.lineWidth = border;
	ctx.stroke();
}

/**
 * Draws candles from projected items: one pass per color, so the fill style changes at most six
 * times however many candles there are. All coordinates are whole device pixels. With outlines,
 * the body color fills only the inside, so a transparent or translucent body works as expected.
 * On an `inverted` scale the open of a rising candle is its upper row.
 */
export function drawCandles(
	ctx: CanvasRenderingContext2D,
	view: SeriesView,
	body: number,
	wick: number,
	border: number,
	style: CandleStyle,
	inverted = false,
	from = 0,
	to = view.count,
): void {
	const wickHalf = wick >> 1;
	const bodyHalf = body >> 1;
	const outlined = style.borderVisible && body > 2 * border;
	for (let direction = 1; direction >= 0; direction--) {
		const up = direction === 1;
		const bodyColor = up ? style.upColor : style.downColor;
		const wickColor = up ? style.wickUpColor : style.wickDownColor;
		const top = up !== inverted ? view.yClose : view.yOpen;
		const bottom = up !== inverted ? view.yOpen : view.yClose;
		if (outlined) {
			if (style.wickVisible) {
				ctx.fillStyle = wickColor;
				outerWicks(ctx, view, direction, top, bottom, wickHalf, wick, from, to);
			}
			ctx.fillStyle = bodyColor;
			rects(ctx, view, direction, top, bottom, bodyHalf, body, border, from, to);
			ctx.strokeStyle = up ? style.borderUpColor : style.borderDownColor;
			outlines(ctx, view, direction, top, bottom, bodyHalf, body, border, from, to);
			continue;
		}
		if (style.wickVisible) {
			ctx.fillStyle = wickColor;
			rects(ctx, view, direction, view.yHigh, view.yLow, wickHalf, wick, 0, from, to);
		}
		if (!style.wickVisible || body > wick || bodyColor !== wickColor) {
			// When the body is no wider than the wick and has its color, the wick already covers it.
			ctx.fillStyle = bodyColor;
			rects(ctx, view, direction, top, bottom, bodyHalf, body, 0, from, to);
		}
	}
}

/**
 * Draws histogram bars from projected items, `width` device pixels wide, from the `base` row to the
 * value: the part above the base in `color`, the part below in `negativeColor`, one pass per color.
 * An item that merges several bars (a pixel column, or a bucket of a coarse level) spans its
 * highest and lowest value, so spikes survive zooming out. Items are on whole pixels. On an
 * `inverted` scale values above the base are below its row.
 */
export function drawHistogram(
	ctx: CanvasRenderingContext2D,
	view: SeriesView,
	base: number,
	width: number,
	color: string,
	negativeColor: string,
	inverted = false,
	from = 0,
	to = view.count,
): void {
	const { x, yHigh, yLow } = view;
	const half = width >> 1;
	ctx.fillStyle = inverted ? negativeColor : color;
	for (let k = from; k < to; k++) {
		const top = yHigh[k]!;
		// Rows grow downward: values above the base are above its row. NaN fails the test.
		if (top < base) {
			ctx.fillRect(x[k]! - half, top, width, base - top);
		}
	}
	ctx.fillStyle = inverted ? color : negativeColor;
	for (let k = from; k < to; k++) {
		const bottom = yLow[k]!;
		if (bottom > base) {
			ctx.fillRect(x[k]! - half, base, width, bottom - base);
		}
	}
}

/**
 * Adds the path of a line over items `[from, to)` to the current path of `ctx` (see `drawLine`).
 * Returns the number of segments added. With `leadX`, the path starts at that x with a level
 * segment to its first point (see `dashLead`); NaN for none.
 */
function traceLine(
	ctx: CanvasRenderingContext2D,
	view: SeriesView,
	step: boolean,
	from: number,
	to: number,
	leadX: number,
): number {
	const { x, yOpen, yHigh, yLow, yClose, merged } = view;
	let segments = 0;
	let drawing = false;
	let previous = 0;
	if (merged) {
		for (let k = from; k < to; k++) {
			const first = yOpen[k]!;
			if (first !== first) {
				drawing = false;
				continue;
			}
			const px = x[k]! + 0.5;
			if (drawing) {
				if (step) {
					ctx.lineTo(px, previous);
					segments++;
				}
				ctx.lineTo(px, first);
				segments++;
			} else {
				if (leadX === leadX) {
					ctx.moveTo(leadX, first);
					ctx.lineTo(px, first);
					segments++;
					leadX = NaN;
				} else {
					ctx.moveTo(px, first);
				}
				drawing = true;
			}
			const top = yHigh[k]!;
			const bottom = yLow[k]!;
			let pen = first;
			if (bottom - top >= 1) {
				// Rows grow downward: `top` is the highest value.
				const near = first - top <= bottom - first ? top : bottom;
				const far = near === top ? bottom : top;
				if (Math.abs(near - pen) >= 0.5) {
					ctx.lineTo(px, near);
					segments++;
				}
				ctx.lineTo(px, far);
				segments++;
				pen = far;
			}
			previous = yClose[k]!;
			if (Math.abs(previous - pen) >= 0.5) {
				ctx.lineTo(px, previous);
				segments++;
			}
		}
	} else {
		for (let k = from; k < to; k++) {
			const y = yClose[k]!;
			if (y !== y) {
				drawing = false;
				continue;
			}
			if (drawing) {
				if (step) {
					ctx.lineTo(x[k]!, previous);
					segments++;
				}
				ctx.lineTo(x[k]!, y);
				segments++;
			} else {
				if (leadX === leadX) {
					ctx.moveTo(leadX, y);
					ctx.lineTo(x[k]!, y);
					segments++;
					leadX = NaN;
				} else {
					ctx.moveTo(x[k]!, y);
				}
				drawing = true;
			}
			previous = y;
		}
	}
	return segments;
}

/**
 * Length of the segment from `(ax, ay)` to `(bx, by)` as a canvas measures a path to place dashes
 * along it: in single precision, each product and the sum rounded on their own. Measured against
 * Chromium, whose dashes a path with a lead of such lengths continues to the pixel (see `dashLead`);
 * with the squares summed before rounding, 2 of 384 such paths differed in a pixel.
 */
function segmentLength(ax: number, ay: number, bx: number, by: number): number {
	const dx = Math.fround(bx - ax);
	const dy = Math.fround(by - ay);
	return Math.fround(Math.sqrt(Math.fround(Math.fround(dx * dx) + Math.fround(dy * dy))));
}

/**
 * For each item up to `upTo` (inclusive), the length of the path `traceLine` draws from where the
 * item's subpath starts (the first item, or the first one after a gap) to where it arrives at the
 * item: what a path that starts at the item has to have before it to continue the dashes of the
 * whole one (see `dashLead`). The lengths are kept in the view, and only those from the first item
 * rebuilt or projected since are computed again, so a tick on the last bar computes none for a path
 * that starts left of it.
 *
 * Lengths are summed in single precision segment by segment, as the rasterizer sums them when it
 * measures the whole path, so the sum is the one it has there and not a more exact one: the two
 * are hundredths of a pixel apart at a length of 100,000 pixels and tenths at 500,000.
 */
export function lineLengths(view: SeriesView, step: boolean, upTo: number): Float32Array {
	if (view.pathLength.length < view.x.length) {
		view.pathLength = new Float32Array(view.x.length);
		view.pathLengthCount = 0;
	}
	if (view.pathLengthStep !== step) {
		view.pathLengthStep = step;
		view.pathLengthCount = 0;
	}
	const lengths = view.pathLength;
	const known = view.pathLengthCount;
	if (known > upTo) {
		return lengths;
	}
	const { x, yOpen, yHigh, yLow, yClose, merged } = view;
	const entry = merged ? yOpen : yClose;
	const shift = merged ? 0.5 : 0;
	// The path through the last item with a known length is walked again, to where it leaves the item.
	let resumed = known > 0;
	let drawing = false;
	let penX = 0;
	let penY = 0;
	let previous = 0;
	let length = 0;
	for (let k = Math.max(0, known - 1); k <= upTo; k++) {
		const first = entry[k]!;
		if (first !== first) {
			drawing = false;
			resumed = false;
			lengths[k] = 0;
			continue;
		}
		const px = x[k]! + shift;
		if (resumed) {
			length = lengths[k]!;
			resumed = false;
		} else if (!drawing) {
			length = 0;
		} else if (step) {
			length = Math.fround(length + segmentLength(penX, penY, px, previous));
			length = Math.fround(length + segmentLength(px, previous, px, first));
		} else {
			length = Math.fround(length + segmentLength(penX, penY, px, first));
		}
		lengths[k] = length;
		drawing = true;
		let pen = first;
		if (merged) {
			const top = yHigh[k]!;
			const bottom = yLow[k]!;
			if (bottom - top >= 1) {
				const near = first - top <= bottom - first ? top : bottom;
				const far = near === top ? bottom : top;
				if (Math.abs(near - pen) >= 0.5) {
					length = Math.fround(length + segmentLength(px, pen, px, near));
					pen = near;
				}
				length = Math.fround(length + segmentLength(px, pen, px, far));
				pen = far;
			}
			previous = yClose[k]!;
			if (Math.abs(previous - pen) >= 0.5) {
				length = Math.fround(length + segmentLength(px, pen, px, previous));
				pen = previous;
			}
		} else {
			previous = first;
		}
		penX = px;
		penY = pen;
	}
	view.pathLengthCount = upTo + 1;
	return lengths;
}

/** Returned by `dashLead` when the path needs no lead, and when no lead can give it its dashes. */
const NO_LEAD = Number.NaN;
const NO_EXACT_LEAD = Number.NEGATIVE_INFINITY;

/**
 * Where the path of items `[from, to)` of a dashed line has to start, left of its first point and
 * level with it, so that its dashes continue those of the whole path: as far left as the whole path
 * is long before that point, from where its subpath starts (`lineLengths`).
 *
 * A dash offset of that length would do the same in exact arithmetic, and does not in a browser.
 * The rasterizer sums the lengths of the segments in single precision and places each dash by that
 * sum, so where a dash falls depends on how the sum was rounded on the way; a path that starts later
 * rounds its sum otherwise, and its dashes land thousandths of a pixel off, which shows in the
 * antialiasing of hundreds of them. With a lead of exactly the length the rasterizer has summed up to
 * the first point, it goes on from the same sum to the same dashes, in every pixel. The dashes
 * along the lead are left of the columns redrawn, like the join at its end.
 *
 * `NO_LEAD` when the path starts where its subpath does. `NO_EXACT_LEAD` when no point left of the
 * first one is exactly that far from it in single precision (a short piece of a line far from the
 * left edge): then the line has to be drawn from its first item.
 */
function dashLead(view: SeriesView, step: boolean, from: number, to: number): number {
	const entry = view.merged ? view.yOpen : view.yClose;
	let first = from;
	while (first < to && entry[first]! !== entry[first]!) {
		first++;
	}
	if (first === to) {
		return NO_LEAD;
	}
	const length = lineLengths(view, step, first)[first]!;
	if (length === 0) {
		return NO_LEAD;
	}
	const x = view.x[first]! + (view.merged ? 0.5 : 0);
	const start = Math.fround(x - length);
	return Math.fround(x - start) === length ? start : NO_EXACT_LEAD;
}

/**
 * Draws a line from projected items as one path. For merged pixel columns the path covers the
 * first value, both extremes and the last value of each column, so spikes survive zooming out: it
 * enters at the first value, sweeps to the extreme nearer to it and then to the other one, and ends
 * at the last value, leaving out every point within half a pixel of where the pen already is. The
 * column covers the same pixels with two calls instead of four in the common case of a smooth line.
 * A step line runs level to the next item and then jumps. `dash` is empty for a solid line.
 *
 * From a later item on, the path starts where the whole path arrives at that item, so it covers the
 * same pixels wherever the stroke around its first and last item does not reach. Dashes are counted
 * from the start of each subpath: a dashed line drawn from a later item gets a lead as long as the
 * whole path before that item (`dashLead`), and is drawn from its first item after all when no lead
 * has exactly that length.
 *
 * A range that holds a single segment is widened until it holds two, or is the whole line. Browsers
 * stroke a path of one segment as another shape than a longer path (Chromium antialiases the ends
 * of the one beyond the cap, and not those of the other), so part of a line must never be one
 * segment unless the whole line is.
 */
export function drawLine(
	ctx: CanvasRenderingContext2D,
	view: SeriesView,
	color: string,
	width: number,
	dash: readonly number[],
	step: boolean,
	from = 0,
	to = view.count,
): void {
	const count = view.count;
	const dashed = dash.length > 0;
	for (let grow = 4; ; grow *= 4) {
		let lead = dashed && from > 0 ? dashLead(view, step, from, to) : NO_LEAD;
		if (lead === NO_EXACT_LEAD) {
			from = 0;
			lead = NO_LEAD;
		}
		ctx.beginPath();
		const segments = traceLine(ctx, view, step, from, to, lead);
		if (segments !== 1 || (from === 0 && to === count)) {
			break;
		}
		from = Math.max(0, from - grow);
		to = Math.min(count, to + grow);
	}
	ctx.lineWidth = width;
	ctx.lineJoin = step ? 'miter' : 'round';
	ctx.strokeStyle = color;
	if (dashed) {
		ctx.setLineDash(dash as number[]);
		ctx.stroke();
		ctx.setLineDash(NO_DASH as number[]);
	} else {
		ctx.stroke();
	}
}
