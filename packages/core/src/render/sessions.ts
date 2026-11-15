import type { LineStyle } from '../options';
import { NO_DASH, dashPattern } from './chrome';

/** Background behind runs of bars, from `left[i]` to `right[i]` (device pixels), the full height. */
export function drawExtendedHours(
	ctx: CanvasRenderingContext2D,
	left: Float32Array,
	right: Float32Array,
	count: number,
	height: number,
	color: string,
): void {
	ctx.fillStyle = color;
	for (let i = 0; i < count; i++) {
		const x = left[i]!;
		const width = right[i]! - x;
		if (width > 0) {
			ctx.fillRect(x, 0, width, height);
		}
	}
}

/** Vertical lines at device x `xs[i]`, `thickness` device pixels thick; dashed ones as one stroke. */
export function drawSessionBreaks(
	ctx: CanvasRenderingContext2D,
	xs: Float32Array,
	count: number,
	height: number,
	color: string,
	thickness: number,
	style: LineStyle,
): void {
	const left = thickness >> 1;
	if (style === 'solid') {
		ctx.fillStyle = color;
		for (let i = 0; i < count; i++) {
			ctx.fillRect(xs[i]! - left, 0, thickness, height);
		}
		return;
	}
	ctx.beginPath();
	for (let i = 0; i < count; i++) {
		const x = xs[i]! - left + thickness / 2;
		ctx.moveTo(x, 0);
		ctx.lineTo(x, height);
	}
	ctx.lineWidth = thickness;
	ctx.strokeStyle = color;
	ctx.setLineDash(dashPattern(style, thickness) as number[]);
	ctx.stroke();
	ctx.setLineDash(NO_DASH as number[]);
}
