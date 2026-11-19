/**
 * Pane primitives: user code that draws into a layer of the price pane, with the coordinate
 * conversions the chart uses itself. The built-in drawings are primitives too.
 */

/**
 * Which canvas a primitive draws into:
 * - `bottom`: the series layer, above the grid and below the series. Redrawn with the series.
 * - `normal`: the drawings layer above the series, the default. Redrawn only when the view or one of
 *   its primitives changes, never for pointer moves.
 * - `top`: the overlay with the crosshair, redrawn with every pointer move: keep it cheap.
 */
export type PrimitiveZOrder = 'bottom' | 'normal' | 'top';

/** What `hitTest` returns for a miss. */
export const HIT_NONE = -1;
/** What `hitTest` returns for a hit on the primitive itself rather than on one of its handles. */
export const HIT_BODY = 0;

/**
 * Box a primitive covers, in CSS pixels from the pane's top left corner. A primitive that leaves it
 * as it is covers the whole pane; one that sets `left > right` covers nothing and is neither drawn
 * nor hit-tested.
 */
export interface PrimitiveBounds {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/**
 * The mapping between data and the pane, as of the frame being drawn. Positions are CSS pixels from
 * the pane's top left corner; logical positions are bar indexes on the main timeline, with fractions
 * between bars (bar `i` covers `[i - 0.5, i + 0.5)`).
 */
export interface PaneView {
	/** Size of the pane in CSS pixels. */
	readonly width: number;
	readonly height: number;
	/** Device pixels per CSS pixel of the canvases. */
	readonly pixelRatio: number;
	/** Logical positions at the left and right edge of the pane. */
	readonly from: number;
	readonly to: number;
	/** CSS pixels between two bars. */
	readonly barSpacing: number;
	/** First and last logical position with a bar; `lastBar < firstBar` without data. */
	readonly firstBar: number;
	readonly lastBar: number;
	/**
	 * Changes whenever `timeToLogical` may answer differently: data loaded, prepended or removed, or
	 * an answer from the data engine (see `timeToLogical`).
	 */
	readonly timelineVersion: number;
	logicalToX(logical: number): number;
	xToLogical(x: number): number;
	/**
	 * Logical position of a time (UTC milliseconds): the bar's index for the time of a bar, a fraction
	 * of the way between two bars for a time between them, and beyond the first or last bar at the
	 * typical spacing of the bars there. The chart holds only the bars around the view, so a time
	 * elsewhere is looked up in the data engine: until the answer arrives this returns NaN (or the
	 * position before the data changed), and `update` is called again once it is known.
	 */
	timeToLogical(time: number): number;
	/**
	 * Time at a logical position: exact for a bar in or near the view, interpolated between bars,
	 * extrapolated beyond the ends. NaN where the bars are not held.
	 */
	logicalToTime(logical: number): number;
	/** `logicalToX(timeToLogical(time))`. */
	timeToX(time: number): number;
	/** `logicalToTime(xToLogical(x))`. */
	xToTime(x: number): number;
	/** y of a price on the primitive's price scale; NaN for a price the scale cannot show. */
	priceToY(price: number): number;
	yToPrice(y: number): number;
	/** A price formatted as the price axis formats it. */
	formatPrice(price: number): string;
	/** Changes whenever `formatPrice` may format differently, so labels can be cached until then. */
	readonly priceFormatVersion: number;
}

/**
 * What `PanePrimitive.autoscale` is asked with and answers in: the part of the timeline in view, and
 * the prices the primitive wants kept in view there.
 */
export interface AutoscaleRange {
	/** Logical positions at the left and right edge of the pane, in the frame being computed. */
	readonly from: number;
	readonly to: number;
	/** The lowest and the highest price to keep in view, on the primitive's price scale. */
	low: number;
	high: number;
	/**
	 * Optional, for an answer that does not depend on the view: the logical positions the primitive
	 * spans (a span of `Infinity` to `-Infinity` for one with nothing to keep in view). The chart then
	 * keeps the answer, counts it in the frames whose view overlaps the span, and asks again only
	 * after `host.requestUpdate()` or when the timeline or the chart's options changed. Left as they
	 * are, the primitive is asked in every frame that computes price ranges.
	 */
	spanFrom: number;
	spanTo: number;
}

/** What a primitive draws into. */
export interface DrawTarget {
	/**
	 * The layer's context, in device pixels with the origin at the pane's top left corner (multiply
	 * CSS positions by `pixelRatio`). Leave it as you found it: restore what you change.
	 */
	readonly context: CanvasRenderingContext2D;
	readonly pixelRatio: number;
	/** Size of the pane in CSS pixels. */
	readonly width: number;
	readonly height: number;
}

/** What a primitive gets from the chart it is attached to. */
export interface PrimitiveHost {
	/** The view the primitive is drawn with. */
	readonly view: PaneView;
	/**
	 * Asks for `update` and a redraw of the primitive's layer in the next frame, after its data or
	 * style changed. Calls between two frames give one redraw.
	 */
	requestUpdate(): void;
}

/**
 * Something drawn on the price pane by user code. Implement `draw`, and `update` to keep the screen
 * geometry it draws from: the chart calls `update` only when the view or the primitive changed, so
 * a frame that redraws the layer for another reason reuses it. Neither should allocate: they run
 * in frames.
 */
export interface PanePrimitive {
	/** The layer it is drawn into, read when it is attached (default `normal`). */
	readonly zOrder?: PrimitiveZOrder;
	/**
	 * Order within the layer, read when attached and on `requestUpdate`: higher is drawn later, on
	 * top; equal ones in the order they were attached.
	 */
	readonly zIndex?: number;
	attached?(host: PrimitiveHost): void;
	detached?(): void;
	/**
	 * Brings the primitive's screen geometry up to date with `view`, and sets `bounds` to the box it
	 * covers (left as it is, the whole pane). Called before drawing when the view changed (pan, zoom,
	 * resize, new data, a new price range) or after `requestUpdate`.
	 */
	update?(view: PaneView, bounds: PrimitiveBounds): void;
	draw(target: DrawTarget, view: PaneView): void;
	/**
	 * Takes part in the autoscale of the primitive's price scale: sets `range.low` and `range.high`
	 * to the prices to keep in view while the pane shows the logical positions `range.from` to
	 * `range.to`, and returns true; false for nothing (out of view, say). A primitive without this
	 * method leaves autoscale alone, which is the default; whether it has it is read when it is
	 * attached and on `requestUpdate`.
	 *
	 * Called in every frame that computes price ranges (a pan, a zoom, new data: not a pointer move),
	 * before `update` and before the scale has its range of that frame: of `view`, the time
	 * conversions are current, but `from`, `to`, `priceToY` and `yToPrice` are still those of the
	 * frame before. It must not allocate. The range is joined with that of the series on the scale,
	 * and the scale's margins go around the whole; it counts only while the scale autoscales and has
	 * a visible series. Call `host.requestUpdate()` when the answer changes for another reason than
	 * the view. An answer that holds whatever the view is can say so (`AutoscaleRange.spanFrom`), and
	 * the primitive is then not asked again until something changes.
	 */
	autoscale?(range: AutoscaleRange, view: PaneView): boolean;
	/**
	 * Drawn on the overlay above the layer while the pointer hovers the primitive (`hovered`) or the
	 * chart has it selected (the built-in drawings only): handles, a highlight.
	 */
	drawHighlight?(target: DrawTarget, view: PaneView, hovered: boolean, selected: boolean): void;
	/**
	 * Whether the point `(x, y)` (CSS pixels in the pane) hits the primitive, within `tolerance`
	 * pixels: `HIT_NONE` (-1), `HIT_BODY` (0), or `1 + k` for handle `k` (of the built-in drawings, the
	 * handle of point `k`, then those derived from the points: the other corners and the edges of a
	 * box). Only called where `bounds`, grown by the tolerance, contain the point.
	 */
	hitTest?(x: number, y: number, tolerance: number): number;
}

/** Items of a series as drawn, for a custom renderer. Read-only; valid during `draw`. */
export interface SeriesItems {
	/** Number of items. */
	readonly count: number;
	/**
	 * True when an item is a pixel column that merges several bars (more bars than device pixels):
	 * its open is the first bar's, close the last bar's, high and low the extremes.
	 */
	readonly merged: boolean;
	/** Center of each item, device pixels from the pane's left edge. */
	readonly x: Float32Array;
	/** Prices per item; a line or histogram has its value in all four. NaN where a bar has no value. */
	readonly open: Float64Array;
	readonly high: Float64Array;
	readonly low: Float64Array;
	readonly close: Float64Array;
	/** Device-pixel rows of those prices. */
	readonly yOpen: Float32Array;
	readonly yHigh: Float32Array;
	readonly yLow: Float32Array;
	readonly yClose: Float32Array;
	/** Width of a candle body at this zoom, in device pixels. */
	readonly barWidth: number;
}

/**
 * Draws a series in place of its built-in style, for example an indicator output as dots or a
 * band. The series keeps everything else: its data, autoscale, last-value line and label.
 */
export interface SeriesRenderer {
	draw(target: DrawTarget, items: SeriesItems, view: PaneView): void;
}
