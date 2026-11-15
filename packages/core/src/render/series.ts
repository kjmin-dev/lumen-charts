import type { SeriesView } from '../views/series-view';

function rects(
	ctx: CanvasRenderingContext2D,
	view: SeriesView,
	direction: number,
	top: Float32Array,
	bottom: Float32Array,
	half: number,
	width: number,
): void {
	const { x, up, count } = view;
	for (let k = 0; k < count; k++) {
		if (up[k] !== direction) {
			continue;
		}
		const y = top[k]!;
		// An item without a value has NaN coordinates.
		if (y !== y) {
			continue;
		}
		ctx.fillRect(x[k]! - half, y, width, bottom[k]! - y + 1);
	}
}

export interface CandleColors {
	upColor: string;
	downColor: string;
	wickUpColor: string;
	wickDownColor: string;
}

/**
 * Draws candles from projected items: one pass per color, so the fill style changes at most four
 * times however many candles there are. All coordinates are whole device pixels.
 */
export function drawCandles(
	ctx: CanvasRenderingContext2D,
	view: SeriesView,
	body: number,
	wick: number,
	colors: CandleColors,
): void {
	const wickHalf = wick >> 1;
	const bodyHalf = body >> 1;
	// When the body is no wider than the wick and has its color, the wick already covers it.
	ctx.fillStyle = colors.wickUpColor;
	rects(ctx, view, 1, view.yHigh, view.yLow, wickHalf, wick);
	if (body > wick || colors.upColor !== colors.wickUpColor) {
		ctx.fillStyle = colors.upColor;
		rects(ctx, view, 1, view.yClose, view.yOpen, bodyHalf, body);
	}
	ctx.fillStyle = colors.wickDownColor;
	rects(ctx, view, 0, view.yHigh, view.yLow, wickHalf, wick);
	if (body > wick || colors.downColor !== colors.wickDownColor) {
		ctx.fillStyle = colors.downColor;
		rects(ctx, view, 0, view.yOpen, view.yClose, bodyHalf, body);
	}
}

/**
 * Draws a line from projected items as one path. For merged pixel columns the path visits the
 * first value, both extremes and the last value of each column, so spikes survive zooming out.
 */
export function drawLine(ctx: CanvasRenderingContext2D, view: SeriesView, color: string, width: number): void {
	const { x, yOpen, yHigh, yLow, yClose, count, merged } = view;
	ctx.beginPath();
	let drawing = false;
	if (merged) {
		for (let k = 0; k < count; k++) {
			const first = yOpen[k]!;
			if (first !== first) {
				drawing = false;
				continue;
			}
			const px = x[k]! + 0.5;
			if (drawing) {
				ctx.lineTo(px, first);
			} else {
				ctx.moveTo(px, first);
				drawing = true;
			}
			const top = yHigh[k]!;
			const bottom = yLow[k]!;
			if (bottom - top >= 1) {
				ctx.lineTo(px, top);
				ctx.lineTo(px, bottom);
			}
			ctx.lineTo(px, yClose[k]!);
		}
	} else {
		for (let k = 0; k < count; k++) {
			const y = yClose[k]!;
			if (y !== y) {
				drawing = false;
				continue;
			}
			if (drawing) {
				ctx.lineTo(x[k]!, y);
			} else {
				ctx.moveTo(x[k]!, y);
				drawing = true;
			}
		}
	}
	ctx.lineWidth = width;
	ctx.lineJoin = 'round';
	ctx.strokeStyle = color;
	ctx.stroke();
}
