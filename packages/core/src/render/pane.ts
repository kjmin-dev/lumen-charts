import type { Crosshair } from '../model/crosshair';
import type { PanePrimitives } from '../drawings/pane-primitives';
import type { FrameModel } from '../model/frame-model';
import type { TimeDisplay } from '../model/time-display';
import type { CandlestickOptions, ChartOptions, HistogramOptions, LineOptions } from '../options';
import { AXIS_PADDING, type PriceAxes, type PriceAxis } from '../price-axes';
import type { Series } from '../series';
import type { ChartSettings } from '../settings';
import { type Geometry, candleWidths } from '../views/series-view';
import { dashPattern, drawGrid, deviceThickness } from './chrome';
import type { ChartLayout } from './layout';
import { drawCandles, drawHistogram, drawLine } from './series';
import { drawExtendedHours, drawSessionBreaks } from './sessions';

/**
 * Draws the series layer: background, session shading, grid, watermark, primitives below the series,
 * the series, and drawings while they are merged into it. A frame in which only data changed
 * redraws the columns of the changed items instead of the whole layer.
 */
export class PaneRenderer {
	/**
	 * The series layer cannot be brought up to date by redrawing the columns of changed items: set
	 * by every change other than data changed in place, and until the layer is drawn in full.
	 */
	public stale = true;
	private readonly _widths = { body: 1, wick: 1 };
	private _watermarkLines: string[] = [];
	/** What the series layer was last drawn with, besides the series (see `Series.isDrawn`). */
	private readonly _paneGeometry: Geometry = { origin: NaN, spacing: NaN, from: 0, to: 0, shift: 0, firstRow: 0 };
	private _paneSource = -1;
	/**
	 * Where the layer has its vertical grid lines, session breaks and session shading. A new bar
	 * computes the time ticks again, mostly to the same positions: the positions decide.
	 */
	private readonly _paneTickXs = new DrawnPositions();
	private readonly _paneBreaks = new DrawnPositions();
	private readonly _paneShadeLeft = new DrawnPositions();
	private readonly _paneShadeRight = new DrawnPositions();
	private _paneGrid: PriceAxis | null = null;
	private _paneGridTicks = -1;
	/** Device columns `[_clipLeft, _clipRight)` the frame redraws, set by `_dirtyColumns`. */
	private _clipLeft = 0;
	private _clipRight = 0;
	private readonly _settings: ChartSettings;
	private readonly _layout: ChartLayout;
	private readonly _series: readonly Series[];
	private readonly _axes: PriceAxes;
	private readonly _model: FrameModel;
	private readonly _time: TimeDisplay;
	private readonly _primitives: PanePrimitives;
	private readonly _crosshair: Crosshair;

	public constructor(
		settings: ChartSettings,
		layout: ChartLayout,
		series: readonly Series[],
		axes: PriceAxes,
		model: FrameModel,
		time: TimeDisplay,
		primitives: PanePrimitives,
		crosshair: Crosshair,
	) {
		this._settings = settings;
		this._layout = layout;
		this._series = series;
		this._axes = axes;
		this._model = model;
		this._time = time;
		this._primitives = primitives;
		this._crosshair = crosshair;
	}

	/** Takes over the options the renderer keeps a copy of: the lines of the watermark. */
	public applyOptions(options: ChartOptions): void {
		const watermark = options.watermark;
		this._watermarkLines = watermark.visible && watermark.text !== '' ? watermark.text.split('\n') : [];
	}

	/**
	 * Finds the device columns a frame has to redraw when only data changed, into `_clipLeft` and
	 * `_clipRight`. Returns `PANE_FULL` when the series layer has to be drawn as a whole, `PANE_KEPT`
	 * when it shows everything already, `PANE_PARTIAL` otherwise.
	 *
	 * The layer can be patched when it was drawn with this geometry, window, grid and price mappings,
	 * and everything on it is drawn by the chart itself: then it differs from a full redraw only where
	 * the items the views rebuilt are drawn. A changed item moves the line from its neighbor on either
	 * side, so the columns reach from the item before the first one to the item after the last, plus
	 * what the stroke or the bar covers around them. A new price range, a scrolled view, a replaced
	 * window, a custom renderer or a primitive below the series fail the test, and so does the option
	 * that asks for full redraws (`ChartOptions.redraw`).
	 */
	private _dirtyColumns(width: number): number {
		const geometry = this._model.geometry;
		const drawn = this._paneGeometry;
		const grid = this._axes.grid;
		const layers = this._primitives.layers;
		const marks = this._time.marks;
		if (
			this.stale ||
			this._settings.options.redraw === 'full' ||
			geometry.origin !== drawn.origin ||
			geometry.spacing !== drawn.spacing ||
			geometry.from !== drawn.from ||
			geometry.to !== drawn.to ||
			geometry.shift !== drawn.shift ||
			geometry.firstRow !== drawn.firstRow ||
			(this._model.drawn === null ? -1 : this._model.drawn.version) !== this._paneSource ||
			!this._paneTickXs.match(this._model.tickXs, this._model.timeTicks.count) ||
			!this._paneBreaks.match(marks.breakX, marks.breakCount) ||
			!this._paneShadeLeft.match(marks.shadeLeft, marks.shadeCount) ||
			!this._paneShadeRight.match(marks.shadeRight, marks.shadeCount) ||
			grid !== this._paneGrid ||
			grid.scale.ticksGeneration !== this._paneGridTicks ||
			layers.bottom.entries.length > 0 ||
			(this._primitives.merged && layers.normal.entries.length > 0)
		) {
			return PANE_FULL;
		}
		const ratio = this._layout.pixelRatio;
		const body = this._widths.body;
		let left = Infinity;
		let right = -Infinity;
		for (const series of this._series) {
			if (!series.isDrawn()) {
				return PANE_FULL;
			}
			const view = series.view;
			const count = view.count;
			if (count === 0) {
				continue;
			}
			if (series.renderer !== null) {
				return PANE_FULL;
			}
			if (view.dirtyTo <= view.dirtyFrom) {
				continue;
			}
			const reach = seriesReach(series, ratio, body);
			const from = view.x[Math.max(0, view.dirtyFrom - 1)]! - reach;
			// Dashes are counted along the path, so a change of its length moves every dash after it.
			const to = isDashed(series) ? width : view.x[Math.min(count - 1, view.dirtyTo)]! + reach;
			if (from < left) {
				left = from;
			}
			if (to > right) {
				right = to;
			}
		}
		left = Math.max(0, Math.floor(left));
		right = Math.min(width, Math.ceil(right));
		if (!(right > left)) {
			return PANE_KEPT;
		}
		if (left === 0 && right === width) {
			return PANE_FULL;
		}
		this._clipLeft = left;
		this._clipRight = right;
		return PANE_PARTIAL;
	}

	/**
	 * Draws the series layer: all of it, or only the columns in which a tick changed something
	 * (`_dirtyColumns`). Those are cleared and drawn through a clip with the same calls in the same
	 * order as the whole layer, so the result is the full redraw's, pixel for pixel: each series is
	 * drawn from the last item whose stroke or bar ends left of the columns to the first one that
	 * starts right of them, which leaves every pixel inside with the same shapes over it.
	 */
	public render(): void {
		const layer = this._layout.pane;
		const ctx = layer.ctx;
		if (ctx === null) {
			return;
		}
		const options = this._settings.options;
		const ratio = this._layout.pixelRatio;
		const widths = this._widths;
		// A bucket drawn as one candle (a coarse level shown wider than a pixel) is as wide as its bars.
		candleWidths(this._model.geometry.spacing * 2 ** this._model.geometry.shift, ratio, widths);
		const mode = this._dirtyColumns(layer.width);
		const partial = mode === PANE_PARTIAL;
		if (mode === PANE_KEPT) {
			return;
		}
		if (partial) {
			ctx.save();
			ctx.beginPath();
			ctx.rect(this._clipLeft, 0, this._clipRight - this._clipLeft, layer.height);
			ctx.clip();
		}
		ctx.fillStyle = options.layout.background;
		ctx.fillRect(0, 0, layer.width, layer.height);
		const grid = this._axes.grid;
		const marks = this._time.marks;
		const sessions = options.sessions;
		if (marks.shadeCount > 0) {
			drawExtendedHours(
				ctx,
				marks.shadeLeft,
				marks.shadeRight,
				marks.shadeCount,
				layer.height,
				sessions.extendedHours.color,
			);
		}
		drawGrid(
			ctx,
			layer.width,
			layer.height,
			this._model.tickXs,
			this._model.timeTicks.count,
			grid.tickYs,
			grid.scale.tickCount,
			options.grid.vertLines,
			options.grid.horzLines,
			ratio,
		);
		if (marks.breakCount > 0) {
			const breaks = sessions.breaks;
			drawSessionBreaks(
				ctx,
				marks.breakX,
				marks.breakCount,
				layer.height,
				breaks.color,
				deviceThickness(breaks.width, ratio),
				breaks.style,
			);
		}
		if (this._watermarkLines.length > 0) {
			this._renderWatermark(ctx, layer.width, layer.height);
		}
		const layers = this._primitives.layers;
		const primitives = layers.size > 0;
		if (primitives) {
			this._primitives.syncPaneView();
			if (layers.bottom.entries.length > 0) {
				layers.bottom.update(this._primitives.bounds);
				layers.bottom.draw(this._primitives.targetOf(ctx));
			}
		}
		const border = Math.max(1, Math.floor(ratio));
		for (const series of this._series) {
			const view = series.view;
			series.markDrawn();
			if (view.count === 0 || !series.seriesOptions.visible) {
				continue;
			}
			if (series.renderer !== null) {
				view.barWidth = widths.body;
				const axis = series.axis;
				series.renderer.draw(
					this._primitives.targetOf(ctx),
					view,
					axis === null ? this._primitives.view : this._primitives.viewFor(axis.id),
				);
				continue;
			}
			let from = 0;
			let to = view.count;
			if (partial) {
				const reach = seriesReach(series, ratio, widths.body);
				// One item more on either side: where a line starts or ends it has a cap, not a join.
				// A dashed line too: `drawLine` gives its path the length the whole one has before it.
				from = Math.max(0, view.firstAfter(this._clipLeft - reach) - 1);
				to = Math.min(to, view.firstAfter(this._clipRight + reach) + 1);
				if (to <= from) {
					continue;
				}
			}
			const inverted = series.deviceScale < 0;
			if (series.kind === 'ohlcv') {
				drawCandles(
					ctx,
					view,
					widths.body,
					widths.wick,
					border,
					series.seriesOptions as CandlestickOptions,
					inverted,
					from,
					to,
				);
			} else if (series.type === 'histogram') {
				const histogram = series.seriesOptions as HistogramOptions;
				let base = Math.round(series.deviceY(histogram.base));
				if (!Number.isFinite(base)) {
					// A base a logarithmic scale cannot show: the bars grow from the edge of the pane.
					base = inverted ? 0 : layer.height;
				}
				drawHistogram(
					ctx,
					view,
					base,
					widths.body,
					histogram.color,
					histogram.negativeColor || histogram.color,
					inverted,
					from,
					to,
				);
			} else {
				const line = series.seriesOptions as LineOptions;
				const width = Math.max(1, line.lineWidth * ratio);
				drawLine(ctx, view, line.color, width, dashPattern(line.lineStyle, width), line.lineType === 'step', from, to);
			}
		}
		if (primitives && this._primitives.merged) {
			if (layers.normal.update(this._primitives.bounds)) {
				this._crosshair.hoverDirty = true;
			}
			layers.normal.draw(this._primitives.targetOf(ctx));
		}
		if (partial) {
			ctx.restore();
			return;
		}
		const geometry = this._model.geometry;
		const drawn = this._paneGeometry;
		drawn.origin = geometry.origin;
		drawn.spacing = geometry.spacing;
		drawn.from = geometry.from;
		drawn.to = geometry.to;
		drawn.shift = geometry.shift;
		drawn.firstRow = geometry.firstRow;
		this._paneSource = this._model.drawn === null ? -1 : this._model.drawn.version;
		this._paneTickXs.take(this._model.tickXs, this._model.timeTicks.count);
		this._paneBreaks.take(marks.breakX, marks.breakCount);
		this._paneShadeLeft.take(marks.shadeLeft, marks.shadeCount);
		this._paneShadeRight.take(marks.shadeRight, marks.shadeCount);
		this._paneGrid = grid;
		this._paneGridTicks = grid.scale.ticksGeneration;
		this.stale = false;
	}

	private _renderWatermark(ctx: CanvasRenderingContext2D, width: number, height: number): void {
		const watermark = this._settings.options.watermark;
		const lines = this._watermarkLines;
		const ratio = this._layout.pixelRatio;
		const lineHeight = watermark.fontSize * ratio * 1.2;
		const padding = 2 * AXIS_PADDING * ratio;
		const block = lineHeight * lines.length;
		const { horzAlign, vertAlign } = watermark;
		const x = horzAlign === 'left' ? padding : horzAlign === 'right' ? width - padding : width / 2;
		let y = vertAlign === 'top' ? padding : vertAlign === 'bottom' ? height - padding - block : (height - block) / 2;
		y += lineHeight / 2;
		ctx.font = this._layout.watermarkFont;
		ctx.fillStyle = watermark.color;
		ctx.textAlign = horzAlign;
		ctx.textBaseline = 'middle';
		for (const line of lines) {
			ctx.fillText(line, x, y);
			y += lineHeight;
		}
	}
}

/** Device positions the series layer was drawn with, to tell whether they are still the same. */
class DrawnPositions {
	private _values = new Float32Array(16);
	private _count = -1;

	public match(values: Float32Array, count: number): boolean {
		if (count !== this._count) {
			return false;
		}
		const own = this._values;
		for (let i = 0; i < count; i++) {
			if (values[i] !== own[i]) {
				return false;
			}
		}
		return true;
	}

	public take(values: Float32Array, count: number): void {
		if (this._values.length < count) {
			this._values = new Float32Array(count * 2);
		}
		this._values.set(values.subarray(0, count));
		this._count = count;
	}
}

/** What a frame does with the series layer (see `PaneRenderer._dirtyColumns`). */
const PANE_FULL = 0;
const PANE_PARTIAL = 1;
const PANE_KEPT = 2;

/** A line series drawn with dashes or dots. */
function isDashed(series: Series): boolean {
	return series.type === 'line' && (series.seriesOptions as LineOptions).lineStyle !== 'solid';
}

/**
 * How far from the x of an item, in device pixels, anything drawn for that item alone can color a
 * pixel: a bar is narrower than `body` on either side; a line's stroke, joins and caps stay within
 * half its width of the path, which runs up to half a pixel beside the item, and antialiasing
 * spreads an edge by less than a pixel.
 */
function seriesReach(series: Series, pixelRatio: number, body: number): number {
	if (series.type !== 'line') {
		return body + 1;
	}
	return Math.max(1, (series.seriesOptions as LineOptions).lineWidth * pixelRatio) / 2 + 2;
}
