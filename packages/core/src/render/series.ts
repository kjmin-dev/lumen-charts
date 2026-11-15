import type { SeriesView } from '../views/series-view';
import { NO_DASH } from './chrome';

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
): void {
	const { x, up, count } = view;
	const left = inset - half;
	const shrink = 2 * inset;
	for (let k = 0; k < count; k++) {
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
): void {
	const { x, up, yHigh, yLow, count } = view;
	for (let k = 0; k < count; k++) {
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
): void {
	const { x, up, count } = view;
	const offset = border / 2;
	ctx.beginPath();
	for (let k = 0; k < count; k++) {
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
 */
export function drawCandles(
	ctx: CanvasRenderingContext2D,
	view: SeriesView,
	body: number,
	wick: number,
	border: number,
	style: CandleStyle,
): void {
	const wickHalf = wick >> 1;
	const bodyHalf = body >> 1;
	const outlined = style.borderVisible && body > 2 * border;
	for (let direction = 1; direction >= 0; direction--) {
		const up = direction === 1;
		const bodyColor = up ? style.upColor : style.downColor;
		const wickColor = up ? style.wickUpColor : style.wickDownColor;
		const top = up ? view.yClose : view.yOpen;
		const bottom = up ? view.yOpen : view.yClose;
		if (outlined) {
			if (style.wickVisible) {
				ctx.fillStyle = wickColor;
				outerWicks(ctx, view, direction, top, bottom, wickHalf, wick);
			}
			ctx.fillStyle = bodyColor;
			rects(ctx, view, direction, top, bottom, bodyHalf, body, border);
			ctx.strokeStyle = up ? style.borderUpColor : style.borderDownColor;
			outlines(ctx, view, direction, top, bottom, bodyHalf, body, border);
			continue;
		}
		if (style.wickVisible) {
			ctx.fillStyle = wickColor;
			rects(ctx, view, direction, view.yHigh, view.yLow, wickHalf, wick, 0);
		}
		if (!style.wickVisible || body > wick || bodyColor !== wickColor) {
			// When the body is no wider than the wick and has its color, the wick already covers it.
			ctx.fillStyle = bodyColor;
			rects(ctx, view, direction, top, bottom, bodyHalf, body, 0);
		}
	}
}

/**
 * Draws histogram bars from projected items, `width` device pixels wide, from the `base` row to the
 * value: the part above the base in `color`, the part below in `negativeColor`, one pass per color.
 * An item that merges several bars (a pixel column, or a bucket of a coarse level) spans its
 * highest and lowest value, so spikes survive zooming out. Items are on whole pixels.
 */
export function drawHistogram(
	ctx: CanvasRenderingContext2D,
	view: SeriesView,
	base: number,
	width: number,
	color: string,
	negativeColor: string,
): void {
	const { x, yHigh, yLow, count } = view;
	const half = width >> 1;
	ctx.fillStyle = color;
	for (let k = 0; k < count; k++) {
		const top = yHigh[k]!;
		// Rows grow downward: values above the base are above its row. NaN fails the test.
		if (top < base) {
			ctx.fillRect(x[k]! - half, top, width, base - top);
		}
	}
	ctx.fillStyle = negativeColor;
	for (let k = 0; k < count; k++) {
		const bottom = yLow[k]!;
		if (bottom > base) {
			ctx.fillRect(x[k]! - half, base, width, bottom - base);
		}
	}
}

/**
 * Draws a line from projected items as one path. For merged pixel columns the path covers the
 * first value, both extremes and the last value of each column, so spikes survive zooming out: it
 * enters at the first value, sweeps to the extreme nearer to it and then to the other one, and ends
 * at the last value, leaving out every point within half a pixel of where the pen already is. The
 * column covers the same pixels with two calls instead of four in the common case of a smooth line.
 * A step line runs level to the next item and then jumps. `dash` is empty for a solid line.
 */
export function drawLine(
	ctx: CanvasRenderingContext2D,
	view: SeriesView,
	color: string,
	width: number,
	dash: readonly number[],
	step: boolean,
): void {
	const { x, yOpen, yHigh, yLow, yClose, count, merged } = view;
	ctx.beginPath();
	let drawing = false;
	let previous = 0;
	if (merged) {
		for (let k = 0; k < count; k++) {
			const first = yOpen[k]!;
			if (first !== first) {
				drawing = false;
				continue;
			}
			const px = x[k]! + 0.5;
			if (drawing) {
				if (step) {
					ctx.lineTo(px, previous);
				}
				ctx.lineTo(px, first);
			} else {
				ctx.moveTo(px, first);
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
				}
				ctx.lineTo(px, far);
				pen = far;
			}
			previous = yClose[k]!;
			if (Math.abs(previous - pen) >= 0.5) {
				ctx.lineTo(px, previous);
			}
		}
	} else {
		for (let k = 0; k < count; k++) {
			const y = yClose[k]!;
			if (y !== y) {
				drawing = false;
				continue;
			}
			if (drawing) {
				if (step) {
					ctx.lineTo(x[k]!, previous);
				}
				ctx.lineTo(x[k]!, y);
			} else {
				ctx.moveTo(x[k]!, y);
				drawing = true;
			}
			previous = y;
		}
	}
	ctx.lineWidth = width;
	ctx.lineJoin = step ? 'miter' : 'round';
	ctx.strokeStyle = color;
	if (dash.length > 0) {
		ctx.setLineDash(dash as number[]);
		ctx.stroke();
		ctx.setLineDash(NO_DASH as number[]);
	} else {
		ctx.stroke();
	}
}
