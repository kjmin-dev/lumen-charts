/** Plane geometry for drawings, on plain numbers so hot paths allocate nothing. */

/** Squared distance from `(px, py)` to the segment `(ax, ay)`-`(bx, by)`. */
export function segmentDistance2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
	const dx = bx - ax;
	const dy = by - ay;
	const length2 = dx * dx + dy * dy;
	let t = length2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / length2 : 0;
	t = t < 0 ? 0 : t > 1 ? 1 : t;
	const ex = ax + t * dx - px;
	const ey = ay + t * dy - py;
	return ex * ex + ey * ey;
}

/** Whether `(px, py)` lies within `distance` of the segment. */
export function nearSegment(
	px: number,
	py: number,
	ax: number,
	ay: number,
	bx: number,
	by: number,
	distance: number,
): boolean {
	return segmentDistance2(px, py, ax, ay, bx, by) <= distance * distance;
}

/** Parameter range of the line being clipped, kept between the edges `clipLine` tests. */
let clipFrom = 0;
let clipTo = 0;

/** Narrows the parameter range by one edge of the rectangle (Liang-Barsky); false when nothing is left. */
function clipEdge(p: number, q: number): boolean {
	if (p === 0) {
		return q >= 0;
	}
	const r = q / p;
	if (p < 0) {
		if (r > clipTo) {
			return false;
		}
		if (r > clipFrom) {
			clipFrom = r;
		}
	} else {
		if (r < clipFrom) {
			return false;
		}
		if (r < clipTo) {
			clipTo = r;
		}
	}
	return true;
}

/**
 * Clips the line through `(ax, ay)` and `(bx, by)` to the rectangle `[0, width] x [0, height]`,
 * extended past `a` when `back` and past `b` when `forward` (a segment, a ray or a whole line). Writes
 * the visible part to `out[at..at + 3]` and returns false when none of it is visible. A line whose
 * two points coincide is a point.
 */
export function clipLine(
	ax: number,
	ay: number,
	bx: number,
	by: number,
	back: boolean,
	forward: boolean,
	width: number,
	height: number,
	out: Float64Array,
	at: number,
): boolean {
	const dx = bx - ax;
	const dy = by - ay;
	const point = dx === 0 && dy === 0;
	clipFrom = back && !point ? -Infinity : 0;
	clipTo = forward && !point ? Infinity : point ? 0 : 1;
	if (
		!clipEdge(-dx, ax) ||
		!clipEdge(dx, width - ax) ||
		!clipEdge(-dy, ay) ||
		!clipEdge(dy, height - ay) ||
		!(clipFrom <= clipTo) ||
		clipFrom === Infinity ||
		clipTo === -Infinity
	) {
		return false;
	}
	out[at] = ax + clipFrom * dx;
	out[at + 1] = ay + clipFrom * dy;
	out[at + 2] = ax + clipTo * dx;
	out[at + 3] = ay + clipTo * dy;
	return true;
}

/** Device-pixel position of a CSS coordinate, on a pixel center for odd line widths so lines stay sharp. */
export function crisp(value: number, pixelRatio: number, lineWidth: number): number {
	return Math.round(value * pixelRatio) + (lineWidth & 1 ? 0.5 : 0);
}
