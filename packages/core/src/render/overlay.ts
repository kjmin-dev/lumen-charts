import type { PanePrimitives } from '../drawings/pane-primitives';
import type { Crosshair } from '../model/crosshair';
import type { FrameModel } from '../model/frame-model';
import type { TimeDisplay } from '../model/time-display';
import type { TimeScale } from '../model/time-scale';
import type { CandlestickOptions, HistogramOptions, LineOptions } from '../options';
import { AXIS_PADDING, type PriceAxes, type PriceAxis } from '../price-axes';
import type { Series } from '../series';
import type { ChartSettings } from '../settings';
import { drawColumn, drawRow, drawTag, isFaint, textColorOn, deviceThickness } from './chrome';
import type { ChartLayout } from './layout';

/**
 * Draws the layer above everything else: price lines and value labels of the series, primitives
 * and drawings on top, and the crosshair with its labels and markers.
 */
export class OverlayRenderer {
	private readonly _settings: ChartSettings;
	private readonly _layout: ChartLayout;
	private readonly _scale: TimeScale;
	private readonly _series: readonly Series[];
	private readonly _axes: PriceAxes;
	private readonly _model: FrameModel;
	private readonly _time: TimeDisplay;
	private readonly _primitives: PanePrimitives;
	private readonly _crosshair: Crosshair;

	public constructor(
		settings: ChartSettings,
		layout: ChartLayout,
		scale: TimeScale,
		series: readonly Series[],
		axes: PriceAxes,
		model: FrameModel,
		time: TimeDisplay,
		primitives: PanePrimitives,
		crosshair: Crosshair,
	) {
		this._settings = settings;
		this._layout = layout;
		this._scale = scale;
		this._series = series;
		this._axes = axes;
		this._model = model;
		this._time = time;
		this._primitives = primitives;
		this._crosshair = crosshair;
	}

	/** Price lines, value labels and the crosshair, on a transparent canvas above everything else. */
	public render(): void {
		const layer = this._layout.overlay;
		const ctx = layer.ctx;
		if (ctx === null) {
			return;
		}
		ctx.clearRect(0, 0, layer.width, layer.height);
		const ratio = this._layout.pixelRatio;
		const options = this._settings.options;
		const paneLeft = Math.round(this._layout.paneLeft * ratio);
		const paneWidth = this._layout.pane.width;
		const paneHeight = this._layout.pane.height;
		const tagHeight = Math.round((options.layout.fontSize + 8) * ratio);
		const font = this._layout.font;
		// Value labels of overlays go on the default scale's axis, or on the first visible one.
		let overlayAxis: PriceAxis | null = null;
		for (const axis of this._axes.list) {
			if (axis.settings.visible) {
				overlayAxis = axis;
				break;
			}
		}

		for (const series of this._series) {
			const seriesOptions = series.seriesOptions;
			const value = series.lastValue;
			const axis = series.axis;
			if (value !== value || !seriesOptions.visible || axis === null) {
				continue;
			}
			const labelAxis = axis.settings.visible ? axis : overlayAxis;
			const showLine = seriesOptions.priceLineVisible;
			const showLabel = seriesOptions.lastValueVisible && labelAxis !== null;
			if (!showLine && !showLabel) {
				continue;
			}
			const y = Math.round(series.deviceY(value));
			// NaN (a value the scale cannot show) fails too.
			if (!(y >= 0 && y < paneHeight)) {
				continue;
			}
			const color = seriesColor(ctx, series);
			if (showLine) {
				drawRow(
					ctx,
					y,
					paneLeft,
					paneWidth,
					seriesOptions.priceLineColor !== '' ? seriesOptions.priceLineColor : color,
					deviceThickness(seriesOptions.priceLineWidth, ratio),
					seriesOptions.priceLineStyle,
				);
			}
			if (showLabel) {
				this._axisTag(ctx, labelAxis!, y - (tagHeight >> 1), tagHeight, color, series.valueLabel(axis.scale, value));
			}
		}

		const drawings = this._primitives.drawings;
		if (this._primitives.layers.top.entries.length > 0 || (drawings !== null && drawings.overlayInUse)) {
			// Pane coordinates, clipped to the pane, like the layers below.
			ctx.save();
			ctx.beginPath();
			ctx.rect(paneLeft, 0, paneWidth, paneHeight);
			ctx.clip();
			ctx.translate(paneLeft, 0);
			const target = this._primitives.targetOf(ctx);
			this._primitives.layers.top.draw(target);
			drawings?.drawOverlay(target);
			ctx.restore();
		}

		const crosshair = options.crosshair;
		const scale = this._scale;
		if (!this._crosshair.visible || scale.isEmpty || crosshair.mode === 'hidden') {
			return;
		}
		const geometry = this._model.geometry;
		const index = Math.min(scale.end - 1, Math.max(scale.first, Math.round(scale.xToLogical(this._crosshair.x))));
		const x = paneLeft + Math.round(geometry.origin + index * geometry.spacing);
		const drawn = this._model.drawn;
		const row = drawn === null ? -1 : Math.floor(index / 2 ** drawn.shift) - drawn.start;
		const inCache = drawn !== null && row >= 0 && row < drawn.count;
		let cssY = this._crosshair.y;
		let magnet: Series | null = null;
		if (crosshair.mode === 'magnet' && inCache) {
			magnet = this._magnetSeries(row);
			const snapped = magnet === null ? Number.NaN : magnet.deviceY(magnet.close[row]!);
			if (Number.isFinite(snapped)) {
				cssY = snapped / ratio;
			} else {
				magnet = null;
			}
		}
		const y = Math.round(cssY * ratio);
		const { vertLine, horzLine } = crosshair;
		if (vertLine.visible) {
			drawColumn(ctx, x, paneHeight, vertLine.color, deviceThickness(vertLine.width, ratio), vertLine.style);
		}
		const yInPane = y >= 0 && y < paneHeight;
		if (horzLine.visible && yInPane) {
			drawRow(ctx, y, paneLeft, paneWidth, horzLine.color, deviceThickness(horzLine.width, ratio), horzLine.style);
		}
		if (inCache) {
			this._renderMarkers(ctx, x, row);
		}
		if (horzLine.labelVisible && yInPane) {
			// A label on every axis with something on it, each in its own values.
			const background = horzLine.labelBackgroundColor;
			const top = y - (tagHeight >> 1);
			for (const axis of this._axes.list) {
				const priceScale = axis.scale;
				if (!axis.settings.visible || axis.count === 0 || !priceScale.hasRange) {
					continue;
				}
				const text =
					magnet !== null && magnet.axis === axis
						? priceScale.format(
								magnet.close[row]!,
								magnet.base,
								magnet.seriesOptions.minMove,
								magnet.seriesOptions.precision,
							)
						: priceScale.formatValue(priceScale.yToValue(cssY));
				this._axisTag(ctx, axis, top, tagHeight, background, text);
			}
		}
		if (vertLine.labelVisible && options.timeScale.visible && inCache) {
			const time = drawn!.time[row]!;
			// Daily bars are dates, shown as they are (see `TimeTicks.dates`).
			const label = this._time.format.crosshair(time, this._model.timeTicks.dates ? time : this._time.zone.wall(time));
			const width = Math.ceil((label.length * this._layout.digitWidth + 2 * AXIS_PADDING) * ratio);
			const left = Math.min(Math.max(paneLeft, x - (width >> 1)), Math.max(paneLeft, paneLeft + paneWidth - width));
			const background = vertLine.labelBackgroundColor;
			drawTag(
				ctx,
				left,
				paneHeight,
				width,
				layer.height - paneHeight,
				background,
				textColorOn(ctx, background),
				label,
				left + width / 2,
				'center',
				font,
			);
		}
	}

	/** A label on a price axis, `top` and `height` in device pixels. */
	private _axisTag(
		ctx: CanvasRenderingContext2D,
		axis: PriceAxis,
		top: number,
		height: number,
		background: string,
		text: string,
	): void {
		const ratio = this._layout.pixelRatio;
		const left = Math.round(axis.axisLeft * ratio);
		const width = Math.round((axis.axisLeft + axis.axisWidth) * ratio) - left;
		const onLeft = axis.settings.position === 'left';
		const padding = AXIS_PADDING * ratio;
		drawTag(
			ctx,
			left,
			top,
			width,
			height,
			background,
			textColorOn(ctx, background),
			text,
			onLeft ? left + width - padding : left + padding,
			onLeft ? 'right' : 'left',
			this._layout.font,
		);
	}

	/** The first visible series with a value at a cache row, for the magnet crosshair. */
	private _magnetSeries(row: number): Series | null {
		for (const series of this._series) {
			if (series.seriesOptions.visible && series.axis !== null && row < series.close.length) {
				const value = series.close[row]!;
				if (value === value) {
					return series;
				}
			}
		}
		return null;
	}

	/** Dots where the crosshair crosses line series, ringed in the background color. */
	private _renderMarkers(ctx: CanvasRenderingContext2D, x: number, row: number): void {
		const ratio = this._layout.pixelRatio;
		const background = this._settings.options.layout.background;
		for (const series of this._series) {
			if (series.type !== 'line' || row >= series.close.length) {
				continue;
			}
			const line = series.seriesOptions as LineOptions;
			const value = series.close[row]!;
			if (!line.visible || !line.crosshairMarkerVisible || value !== value) {
				continue;
			}
			const y = series.deviceY(value);
			if (!Number.isFinite(y)) {
				continue;
			}
			const radius = line.crosshairMarkerRadius * ratio;
			ctx.fillStyle = background;
			ctx.beginPath();
			ctx.arc(x, y, radius + ratio, 0, 2 * Math.PI);
			ctx.fill();
			ctx.fillStyle = line.color;
			ctx.beginPath();
			ctx.arc(x, y, radius, 0, 2 * Math.PI);
			ctx.fill();
		}
	}
}

/**
 * Color of the latest value: the line color, or the body color of the last bar's direction. A
 * hollow body (a faint color with an outline) gives way to its outline color.
 */
function seriesColor(ctx: CanvasRenderingContext2D, series: Series): string {
	if (series.type === 'histogram') {
		const histogram = series.seriesOptions as HistogramOptions;
		return series.lastValue < histogram.base && histogram.negativeColor !== ''
			? histogram.negativeColor
			: histogram.color;
	}
	if (series.kind !== 'ohlcv') {
		return (series.seriesOptions as LineOptions).color;
	}
	const candle = series.seriesOptions as CandlestickOptions;
	const body = series.lastUp ? candle.upColor : candle.downColor;
	if (candle.borderVisible && isFaint(ctx, body)) {
		return series.lastUp ? candle.borderUpColor : candle.borderDownColor;
	}
	return body;
}
