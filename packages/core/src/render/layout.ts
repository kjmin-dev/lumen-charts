import type { Invalidation } from '../model/invalidation';
import { INVALIDATE_FULL } from '../model/invalidation';
import type { TimeScale } from '../model/time-scale';
import type { PriceAxis } from '../price-axes';
import type { ChartSettings } from '../settings';
import { observeSize, unobserveSize } from '../shared/observers';
import { Layer } from './layer';

/** What the layout needs from the chart. */
export interface LayoutHost {
	invalidate(level: Invalidation): void;
	/** The price scales with their axes, in layout order (see `PriceAxes.list`). */
	priceAxes(): readonly PriceAxis[];
	/** The chart got another size, and its pane with it. */
	resized(): void;
}

/** The used value of a length, in CSS pixels, or NaN for anything else (`auto`, a percentage). */
function pixels(value: string): number {
	return value.endsWith('px') ? Number.parseFloat(value) : Number.NaN;
}

/**
 * The element of a chart with its canvases, the size of the chart and how it is split into the pane
 * and the axes. Sizes are CSS pixels; canvases follow the numbers in the write phase of a frame.
 */
export class ChartLayout {
	/** Root element created by the chart inside the container. */
	public readonly root: HTMLDivElement;
	/** The series layer, the time axis, and the transparent layer above everything else. */
	public readonly pane: Layer;
	public readonly timeAxis: Layer;
	public readonly overlay: Layer;
	/** The canvas of the default scale's axis, which is there from the start. */
	public readonly mainAxis: Layer;
	public width = 0;
	public height = 0;
	public paneLeft = 0;
	public paneWidth = 0;
	public paneHeight = 0;
	public axisHeight = 0;
	/** The device pixel ratio the canvases were last placed with. */
	public pixelRatio = 1;
	public digitWidth = 0;
	/** Font of the axis labels in device pixels; emptied, the next frame places the canvases again. */
	public font = '';
	public watermarkFont = '';
	/** The canvases have to be placed again before they are drawn. */
	public dirty = true;

	private readonly _container: HTMLElement;
	private readonly _settings: ChartSettings;
	private readonly _scale: TimeScale;
	private readonly _host: LayoutHost;
	/** Whether the shared resize observer reports the size of the root element. */
	private _sizeObserved = false;
	/** With `autoSize`: the size has to be measured before it is used (see `ensureSize`). */
	private _sizeStale = false;
	private _destroyed = false;

	public constructor(container: HTMLElement, settings: ChartSettings, scale: TimeScale, host: LayoutHost) {
		this._container = container;
		this._settings = settings;
		this._scale = scale;
		this._host = host;
		const doc = container.ownerDocument;
		this.root = doc.createElement('div');
		this.root.style.position = 'relative';
		this.root.style.overflow = 'hidden';
		this.pane = new Layer(doc, true);
		this.mainAxis = axisLayer(doc);
		this.timeAxis = new Layer(doc, true);
		this.overlay = new Layer(doc, false);
		this.overlay.canvas.style.pointerEvents = 'none';
		this.root.append(this.pane.canvas, this.mainAxis.canvas, this.timeAxis.canvas, this.overlay.canvas);
		container.appendChild(this.root);
	}

	/** The device pixel ratio of the window right now. */
	public devicePixelRatio(): number {
		return this._container.ownerDocument.defaultView?.devicePixelRatio ?? 1;
	}

	/** Makes the canvas of an axis shown for the first time, below the overlay; null once destroyed. */
	public addAxisLayer(): Layer | null {
		if (this._destroyed) {
			return null;
		}
		const layer = axisLayer(this.root.ownerDocument);
		this.root.insertBefore(layer.canvas, this.overlay.canvas);
		this.dirty = true;
		return layer;
	}

	/** Stops following the size of the container. */
	public destroy(): void {
		this._destroyed = true;
		unobserveSize(this.root);
	}

	/** Releases the canvases of the pane, the axes and the overlay. */
	public release(): void {
		this.pane.release();
		for (const axis of this._host.priceAxes()) {
			axis.layer?.release();
		}
		this.timeAxis.release();
		this.overlay.release();
	}

	/** Follows the `autoSize`, `width` and `height` options. */
	public syncSizing(): void {
		const root = this.root;
		if (this._settings.options.autoSize) {
			root.style.width = '100%';
			root.style.height = '100%';
			if (!this._sizeObserved) {
				// The observer reports after a layout, which is after the next frame's draw. That draw
				// measures instead, in its read phase, so the first paint already has the right size.
				// Without an observer nothing reports later changes, so every options change measures.
				this._sizeObserved = observeSize(root, this._onSize);
				this._sizeStale = true;
				this._host.invalidate(INVALIDATE_FULL);
			}
		} else {
			if (this._sizeObserved) {
				unobserveSize(root);
				this._sizeObserved = false;
			}
			this._sizeStale = false;
			root.style.width = `${this._settings.options.width}px`;
			root.style.height = `${this._settings.options.height}px`;
			this._setSize(this._settings.options.width, this._settings.options.height);
		}
	}

	/** Size of the root element's content box, from the shared resize observer. */
	private readonly _onSize = (width: number, height: number): void => {
		if (this._destroyed || !this._settings.options.autoSize) {
			return;
		}
		this._sizeStale = false;
		this._setSize(Math.floor(width), Math.floor(height));
	};

	/**
	 * Measures the chart if its size is not known yet. This reads the layout, and so can force one:
	 * it happens in the read phase of a frame, where every chart reads before any chart writes, or
	 * earlier when a call or arriving data needs the size, but not when the chart is created: charts
	 * created in a loop would each lay the page out again.
	 *
	 * The size is that of the root element, which fills the content box of the container. The
	 * container's bounding rectangle would include its padding and borders and follow its CSS
	 * transforms, and the canvases would no longer fit the root.
	 */
	public ensureSize(): void {
		if (!this._sizeStale) {
			return;
		}
		this._sizeStale = false;
		const root = this.root;
		// The used width and height keep their fractions, like the sizes the observer reports;
		// `clientWidth` is rounded, and the two would disagree by a pixel.
		const style = this._container.ownerDocument.defaultView?.getComputedStyle(root);
		const width = style === undefined ? Number.NaN : pixels(style.width);
		const height = style === undefined ? Number.NaN : pixels(style.height);
		this._setSize(
			Math.floor(width === width ? width : root.clientWidth),
			Math.floor(height === height ? height : root.clientHeight),
		);
	}

	private _setSize(width: number, height: number): void {
		if (width === this.width && height === this.height) {
			return;
		}
		this.width = width;
		this.height = height;
		this.compute();
		this._host.resized();
		this._host.invalidate(INVALIDATE_FULL);
	}

	/**
	 * Splits the chart into pane and axes, the price axes of each side laid out from the pane outward.
	 * Only numbers change here; canvases follow in the next draw.
	 */
	public compute(): void {
		const { timeScale, layout } = this._settings.options;
		const axes = this._host.priceAxes();
		let left = 0;
		let right = 0;
		for (const axis of axes) {
			if (axis.settings.visible) {
				if (axis.settings.position === 'left') {
					left += axis.axisWidth;
				} else {
					right += axis.axisWidth;
				}
			}
		}
		this.axisHeight = timeScale.visible ? Math.round(layout.fontSize + 16) : 0;
		this.paneLeft = left;
		this.paneWidth = Math.max(0, this.width - left - right);
		this.paneHeight = Math.max(0, this.height - this.axisHeight);
		let leftEdge = left;
		let rightEdge = left + this.paneWidth;
		for (const axis of axes) {
			if (axis.settings.visible) {
				if (axis.settings.position === 'left') {
					leftEdge -= axis.axisWidth;
					axis.axisLeft = leftEdge;
				} else {
					axis.axisLeft = rightEdge;
					rightEdge += axis.axisWidth;
				}
			}
			axis.scale.setHeight(this.paneHeight);
		}
		this._scale.setWidth(this.paneWidth);
		this.dirty = true;
	}

	/**
	 * Places the series layer and the axes with the device pixel ratio of the window. The chart places
	 * the drawings layer next, then `placeOverlay` ends the pass.
	 */
	public placePanes(): void {
		this.dirty = false;
		const ratio = this.devicePixelRatio();
		this.pixelRatio = ratio;
		const { paneLeft, paneWidth, paneHeight } = this;
		this.pane.place(paneLeft, 0, paneWidth, paneHeight, ratio);
		for (const axis of this._host.priceAxes()) {
			if (axis.settings.visible) {
				axis.layer?.place(axis.axisLeft, 0, axis.axisWidth, paneHeight, ratio);
			}
			// Resizing a canvas clears it, so the axes are drawn again whatever their state.
			axis.drawn = -1;
		}
		if (this._settings.options.timeScale.visible) {
			this.timeAxis.place(0, paneHeight, this.width, this.axisHeight, ratio);
		}
	}

	/** Places the overlay and takes over the fonts, measured at the device pixel ratio. */
	public placeOverlay(): void {
		const ratio = this.pixelRatio;
		const options = this._settings.options;
		this.overlay.place(0, 0, this.width, this.height, ratio);
		const { fontSize, fontFamily } = options.layout;
		const font = `${fontSize * ratio}px ${fontFamily}`;
		if (font !== this.font) {
			this.font = font;
			const ctx = this.overlay.ctx;
			if (ctx === null) {
				this.digitWidth = fontSize * 0.6;
			} else {
				ctx.font = font;
				this.digitWidth = ctx.measureText('0').width / ratio;
			}
		}
		this.watermarkFont = `${options.watermark.fontSize * ratio}px ${fontFamily}`;
	}
}

/** The canvas of a price axis; dragging it scales the axis. */
function axisLayer(doc: Document): Layer {
	const layer = new Layer(doc, true);
	layer.canvas.style.cursor = 'ns-resize';
	return layer;
}
