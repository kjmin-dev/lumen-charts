import type { GridLineOptions, LineStyle } from '../options';

/** Argument for `setLineDash` that turns dashing off. Shared; don't modify. */
export const NO_DASH: readonly number[] = [];
const dashes = new Map<number, readonly number[]>();

/**
 * Dash and gap lengths in device pixels for a line style, empty for a solid line. `unit` is the
 * length of a dot, normally the line width in device pixels. The arrays are shared; don't modify.
 */
export function dashPattern(style: LineStyle, unit: number): readonly number[] {
	if (style === 'solid') {
		return NO_DASH;
	}
	const size = Math.max(1, Math.round(unit));
	const key = size * 2 + (style === 'dotted' ? 0 : 1);
	let pattern = dashes.get(key);
	if (pattern === undefined) {
		pattern = style === 'dotted' ? [size, size * 2] : [size * 3, size * 3];
		dashes.set(key, pattern);
	}
	return pattern;
}

function gridLines(
	ctx: CanvasRenderingContext2D,
	positions: Float32Array,
	count: number,
	length: number,
	vertical: boolean,
	line: GridLineOptions,
	pixelRatio: number,
): void {
	if (count === 0 || !line.visible) {
		return;
	}
	if (line.style === 'solid') {
		ctx.fillStyle = line.color;
		for (let i = 0; i < count; i++) {
			if (vertical) {
				ctx.fillRect(positions[i]!, 0, 1, length);
			} else {
				ctx.fillRect(0, positions[i]!, length, 1);
			}
		}
		return;
	}
	// One dashed path for all lines: a single stroke instead of a rectangle per dash.
	ctx.beginPath();
	for (let i = 0; i < count; i++) {
		const p = positions[i]! + 0.5;
		if (vertical) {
			ctx.moveTo(p, 0);
			ctx.lineTo(p, length);
		} else {
			ctx.moveTo(0, p);
			ctx.lineTo(length, p);
		}
	}
	ctx.lineWidth = 1;
	ctx.strokeStyle = line.color;
	ctx.setLineDash(dashPattern(line.style, pixelRatio) as number[]);
	ctx.stroke();
	ctx.setLineDash(NO_DASH as number[]);
}

/** Grid lines, one device pixel wide, at the given device-pixel positions. */
export function drawGrid(
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	xs: Float32Array,
	xCount: number,
	ys: Float32Array,
	yCount: number,
	vertical: GridLineOptions,
	horizontal: GridLineOptions,
	pixelRatio: number,
): void {
	gridLines(ctx, xs, xCount, height, true, vertical, pixelRatio);
	gridLines(ctx, ys, yCount, width, false, horizontal, pixelRatio);
}

export interface AxisStyle {
	background: string;
	textColor: string;
	/** CSS font shorthand, already scaled to device pixels. */
	font: string;
	pixelRatio: number;
}

/**
 * Price axis: labels vertically centered on their ticks, next to the border that faces the pane.
 * `side` is the side of the pane the axis is on; an empty `border` draws no border.
 */
export function drawPriceAxis(
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	style: AxisStyle,
	border: string,
	side: 'left' | 'right',
	padding: number,
	ys: Float32Array,
	labels: readonly string[],
	count: number,
	offsetY = 0,
): void {
	ctx.fillStyle = style.background;
	ctx.fillRect(0, 0, width, height);
	if (border !== '') {
		const thickness = Math.max(1, Math.floor(style.pixelRatio));
		ctx.fillStyle = border;
		ctx.fillRect(side === 'right' ? 0 : width - thickness, 0, thickness, height);
	}
	ctx.fillStyle = style.textColor;
	ctx.font = style.font;
	ctx.textAlign = side === 'right' ? 'left' : 'right';
	ctx.textBaseline = 'middle';
	const x = side === 'right' ? padding : width - padding;
	for (let i = 0; i < count; i++) {
		ctx.fillText(labels[i]!, x, ys[i]! - offsetY);
	}
}

/**
 * Time axis: a border on top and labels centered under their bars. `offset` is the left edge of the
 * pane on this canvas, in device pixels.
 */
export function drawTimeAxis(
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	style: AxisStyle,
	border: string,
	offset: number,
	xs: Float32Array,
	labels: readonly string[],
	count: number,
): void {
	ctx.fillStyle = style.background;
	ctx.fillRect(0, 0, width, height);
	if (border !== '') {
		ctx.fillStyle = border;
		ctx.fillRect(0, 0, width, Math.max(1, Math.floor(style.pixelRatio)));
	}
	ctx.fillStyle = style.textColor;
	ctx.font = style.font;
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	const y = height / 2;
	for (let i = 0; i < count; i++) {
		ctx.fillText(labels[i]!, xs[i]! + offset, y);
	}
}

/** Horizontal line from `left`, `thickness` device pixels thick and centered on `y`. */
export function drawRow(
	ctx: CanvasRenderingContext2D,
	y: number,
	left: number,
	width: number,
	color: string,
	thickness: number,
	style: LineStyle,
): void {
	ctx.fillStyle = color;
	const top = y - (thickness >> 1);
	const pattern = dashPattern(style, thickness);
	if (pattern.length === 0) {
		ctx.fillRect(left, top, width, thickness);
		return;
	}
	const dash = pattern[0]!;
	const period = dash + pattern[1]!;
	const right = left + width;
	for (let x = left; x < right; x += period) {
		ctx.fillRect(x, top, Math.min(dash, right - x), thickness);
	}
}

/** Vertical line from the top, `thickness` device pixels thick and centered on `x`. */
export function drawColumn(
	ctx: CanvasRenderingContext2D,
	x: number,
	height: number,
	color: string,
	thickness: number,
	style: LineStyle,
): void {
	ctx.fillStyle = color;
	const left = x - (thickness >> 1);
	const pattern = dashPattern(style, thickness);
	if (pattern.length === 0) {
		ctx.fillRect(left, 0, thickness, height);
		return;
	}
	const dash = pattern[0]!;
	const period = dash + pattern[1]!;
	for (let y = 0; y < height; y += period) {
		ctx.fillRect(left, y, thickness, Math.min(dash, height - y));
	}
}

/** Filled box with text, used for crosshair and last-value labels on the axes. */
export function drawTag(
	ctx: CanvasRenderingContext2D,
	left: number,
	top: number,
	width: number,
	height: number,
	background: string,
	textColor: string,
	text: string,
	textX: number,
	align: CanvasTextAlign,
	font: string,
): void {
	ctx.fillStyle = background;
	ctx.fillRect(left, top, width, height);
	ctx.fillStyle = textColor;
	ctx.font = font;
	ctx.textAlign = align;
	ctx.textBaseline = 'middle';
	ctx.fillText(text, textX, top + height / 2);
}

const DARK_TEXT = '#0e1116';
const LIGHT_TEXT = '#ffffff';

/** What labels need to know about a color. */
interface ColorInfo {
	/** Text color for labels on it. */
	text: string;
	/** Opacity from 0 to 1; 1 when the color could not be read. */
	alpha: number;
}

const colors = new Map<string, ColorInfo>();

/** Reads a CSS color through the context, which normalizes it. Results are cached per string. */
function colorInfo(ctx: CanvasRenderingContext2D, color: string): ColorInfo {
	let info = colors.get(color);
	if (info !== undefined) {
		return info;
	}
	info = { text: LIGHT_TEXT, alpha: 1 };
	ctx.fillStyle = '#000000';
	ctx.fillStyle = color;
	const rgba = parseColor(String(ctx.fillStyle));
	if (rgba !== null) {
		const luminance = 0.2126 * linear(rgba[0]) + 0.7152 * linear(rgba[1]) + 0.0722 * linear(rgba[2]);
		// Equal contrast with white and black is at 0.179. The threshold sits higher so the usual
		// saturated candle and line colors keep white text, and only light colors switch to dark.
		if (luminance > 0.4) {
			info.text = DARK_TEXT;
		}
		info.alpha = rgba[3];
	}
	if (colors.size > 256) {
		colors.clear();
	}
	colors.set(color, info);
	return info;
}

/** Text color for labels on `background`: white, or near-black on light colors. */
export function textColorOn(ctx: CanvasRenderingContext2D, background: string): string {
	return colorInfo(ctx, background).text;
}

/** True for a color that is less than half opaque, such as the body of a hollow candle. */
export function isFaint(ctx: CanvasRenderingContext2D, color: string): boolean {
	return colorInfo(ctx, color).alpha < 0.5;
}

/** Channels of the forms a 2D context reports colors in: `#rrggbb` and `rgba(r, g, b, a)`. */
function parseColor(color: string): [number, number, number, number] | null {
	if (/^#[0-9a-f]{6}$/i.test(color)) {
		const value = Number.parseInt(color.slice(1), 16);
		return [(value >> 16) & 255, (value >> 8) & 255, value & 255, 1];
	}
	const match = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?/i.exec(color);
	if (match === null) {
		return null;
	}
	return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? 1 : Number(match[4])];
}

function linear(channel: number): number {
	const c = channel / 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Device-pixel thickness of a line `width` CSS pixels wide. */
export function deviceThickness(width: number, pixelRatio: number): number {
	return Math.max(1, Math.floor(width * pixelRatio));
}

/** Clip global device coordinates to one price pane. The caller restores the context when true. */
export function clipPricePane(
	ctx: CanvasRenderingContext2D,
	width: number,
	ratio: number,
	top: number,
	height: number,
	total: number,
): boolean {
	if (top === 0 && height === total) return false;
	const y = Math.round(top * ratio);
	ctx.save();
	ctx.beginPath();
	ctx.rect(0, y, width, Math.round((top + height) * ratio) - y);
	ctx.clip();
	return true;
}
