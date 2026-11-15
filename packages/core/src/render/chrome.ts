/** Grid lines, one device pixel wide, at the given device-pixel positions. */
export function drawGrid(
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	color: string,
	xs: Float32Array,
	xCount: number,
	ys: Float32Array,
	yCount: number,
): void {
	ctx.fillStyle = color;
	for (let i = 0; i < xCount; i++) {
		ctx.fillRect(xs[i]!, 0, 1, height);
	}
	for (let i = 0; i < yCount; i++) {
		ctx.fillRect(0, ys[i]!, width, 1);
	}
}

export interface AxisStyle {
	background: string;
	textColor: string;
	borderColor: string;
	/** CSS font shorthand, already scaled to device pixels. */
	font: string;
	pixelRatio: number;
}

/** Price axis: a border on the left and labels next to it, vertically centered on their ticks. */
export function drawPriceAxis(
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	style: AxisStyle,
	padding: number,
	ys: Float32Array,
	labels: readonly string[],
	count: number,
): void {
	ctx.fillStyle = style.background;
	ctx.fillRect(0, 0, width, height);
	ctx.fillStyle = style.borderColor;
	ctx.fillRect(0, 0, Math.max(1, Math.floor(style.pixelRatio)), height);
	ctx.fillStyle = style.textColor;
	ctx.font = style.font;
	ctx.textAlign = 'left';
	ctx.textBaseline = 'middle';
	for (let i = 0; i < count; i++) {
		ctx.fillText(labels[i]!, padding, ys[i]!);
	}
}

/** Time axis: a border on top and labels centered under their bars. */
export function drawTimeAxis(
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	style: AxisStyle,
	xs: Float32Array,
	labels: readonly string[],
	count: number,
): void {
	ctx.fillStyle = style.background;
	ctx.fillRect(0, 0, width, height);
	ctx.fillStyle = style.borderColor;
	ctx.fillRect(0, 0, width, Math.max(1, Math.floor(style.pixelRatio)));
	ctx.fillStyle = style.textColor;
	ctx.font = style.font;
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	const y = height / 2;
	for (let i = 0; i < count; i++) {
		ctx.fillText(labels[i]!, xs[i]!, y);
	}
}

/** Dashed horizontal line, one device pixel thick. */
export function drawDashedRow(
	ctx: CanvasRenderingContext2D,
	y: number,
	width: number,
	color: string,
	dash: number,
	thickness: number,
): void {
	ctx.fillStyle = color;
	for (let x = 0; x < width; x += dash * 2) {
		ctx.fillRect(x, y, Math.min(dash, width - x), thickness);
	}
}

/** Dashed vertical line, one device pixel thick. */
export function drawDashedColumn(
	ctx: CanvasRenderingContext2D,
	x: number,
	height: number,
	color: string,
	dash: number,
	thickness: number,
): void {
	ctx.fillStyle = color;
	for (let y = 0; y < height; y += dash * 2) {
		ctx.fillRect(x, y, thickness, Math.min(dash, height - y));
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
	text: string,
	textX: number,
	align: CanvasTextAlign,
	font: string,
): void {
	ctx.fillStyle = background;
	ctx.fillRect(left, top, width, height);
	ctx.fillStyle = '#ffffff';
	ctx.font = font;
	ctx.textAlign = align;
	ctx.textBaseline = 'middle';
	ctx.fillText(text, textX, top + height / 2);
}
