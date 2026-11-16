/**
 * Canvas memory of the page, counted in device pixels of canvas bitmaps (4 bytes each).
 *
 * Mobile browsers cap the memory all canvases of a page may take (iOS Safari at a few hundred
 * megabytes, by device), and a canvas past the cap is not drawn. Split layouts times three layers
 * times the device pixel ratio can get there, so a chart gives up its separate drawings layer when
 * the page is near the budget and draws its drawings into the series layer instead.
 */

/** About 192 MB of bitmaps, under the cap of older iOS devices. */
const DEFAULT_BUDGET = 48 * 1024 * 1024;

let budget = DEFAULT_BUDGET;
let used = 0;

/**
 * Sets the canvas budget of the page, in device pixels (4 bytes each), for layers placed
 * afterwards. Past it, charts draw drawings into their series layer instead of a layer of their
 * own: one canvas fewer per chart, but drawings are then redrawn with the series.
 */
export function setCanvasBudget(pixels: number): void {
	budget = pixels > 0 ? pixels : 0;
}

export function getCanvasBudget(): number {
	return budget;
}

/** Device pixels of all canvas layers of the page. */
export function canvasPixelsInUse(): number {
	return used;
}

/** Whether `pixels` more fit into the budget. */
export function canvasFits(pixels: number): boolean {
	return used + pixels <= budget;
}

/** A layer's bitmap changed from `before` to `after` device pixels. */
export function trackCanvas(before: number, after: number): void {
	used += after - before;
}
