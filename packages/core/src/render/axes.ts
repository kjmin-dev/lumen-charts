import type { FrameModel } from '../model/frame-model';
import { AXIS_PADDING, type PriceAxes } from '../price-axes';
import type { ChartSettings } from '../settings';
import { type AxisStyle, drawPriceAxis, drawTimeAxis } from './chrome';
import type { ChartLayout } from './layout';

/** Draws the price axes and the time axis, each on its own canvas and only when its ticks changed. */
export class AxisRenderer {
	/** What the time axis last showed; -1 forces a redraw. */
	private _timeAxisDrawn = -1;
	private _timeAxisOrigin = 0;
	private readonly _axisStyle: AxisStyle = { background: '', textColor: '', font: '', pixelRatio: 1 };
	private readonly _settings: ChartSettings;
	private readonly _layout: ChartLayout;
	private readonly _axes: PriceAxes;
	private readonly _model: FrameModel;

	public constructor(settings: ChartSettings, layout: ChartLayout, axes: PriceAxes, model: FrameModel) {
		this._settings = settings;
		this._layout = layout;
		this._axes = axes;
		this._model = model;
	}

	/** The canvases were placed again, which clears them: the time axis is drawn whatever its state. */
	public reset(): void {
		this._timeAxisDrawn = -1;
	}

	/** Axes are redrawn only when their ticks changed: a tick that leaves the scales alone skips them. */
	public render(): void {
		const ratio = this._layout.pixelRatio;
		const options = this._settings.options;
		const style = this._axisStyle;
		style.background = options.layout.background;
		style.textColor = options.layout.textColor;
		style.font = this._layout.font;
		style.pixelRatio = ratio;
		for (const axis of this._axes.list) {
			const priceScale = axis.scale;
			const layer = axis.layer;
			if (!axis.settings.visible || layer === null || axis.drawn === priceScale.ticksGeneration) {
				continue;
			}
			const priceOptions = axis.settings;
			if (layer.ctx !== null) {
				drawPriceAxis(
					layer.ctx,
					layer.width,
					layer.height,
					style,
					priceOptions.borderVisible ? priceOptions.borderColor : '',
					priceOptions.position,
					AXIS_PADDING * ratio,
					axis.tickYs,
					priceScale.tickLabels,
					priceScale.tickCount,
					Math.round(priceScale.top * ratio),
				);
			}
			axis.drawn = priceScale.ticksGeneration;
		}
		const timeOptions = options.timeScale;
		const origin = this._model.geometry.origin;
		if (
			timeOptions.visible &&
			(this._timeAxisDrawn !== this._model.ticksGeneration || this._timeAxisOrigin !== origin)
		) {
			const layer = this._layout.timeAxis;
			if (layer.ctx !== null) {
				drawTimeAxis(
					layer.ctx,
					layer.width,
					layer.height,
					style,
					timeOptions.borderVisible ? timeOptions.borderColor : '',
					Math.round(this._layout.paneLeft * ratio),
					this._model.tickXs,
					this._model.timeTicks.labels,
					this._model.timeTicks.count,
				);
			}
			this._timeAxisDrawn = this._model.ticksGeneration;
			this._timeAxisOrigin = origin;
		}
	}
}
