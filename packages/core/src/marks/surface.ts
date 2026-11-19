import { trackCanvas } from '../shared/canvas-budget';
import { type PixelBox, emptyBox } from './render';

/**
 * The pixels of one heatmap or scatter series: a buffer the size of the pane that the series is
 * written into, and a canvas that holds the same picture for the layer to composite with one
 * `drawImage` (a buffer cannot be blended onto a canvas directly: `putImageData` replaces what is
 * there). Both are kept between frames, so a frame that only adds marks writes and uploads the
 * pixels it changed, and a frame that changes nothing of the series draws the canvas as it is.
 *
 * Buffer and canvas hold the pane transposed: the pixel of the pane at column `x`, row `y` is
 * `pixels[x * height + y]`, the pixel at `(y, x)` of the canvas, which is as wide as the pane is
 * high. Marks arrive in time order, so they are written column after column (see `render.ts`); the
 * canvas is composited with x and y swapped, which moves whole pixels onto whole pixels.
 *
 * The canvas counts toward the canvas budget like a layer's.
 */
export class PixelSurface {
	public width = 0;
	public height = 0;
	/** The pixels, `width * height` of them, column by column; transparent where nothing is drawn. */
	public pixels = new Uint32Array(0);
	/** The pixels that are not transparent lie in this box. */
	public readonly box: PixelBox = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
	private _image: ImageData | null = null;
	private _canvas: HTMLCanvasElement | null = null;
	private _ctx: CanvasRenderingContext2D | null = null;
	private readonly _document: Document;

	public constructor(document: Document) {
		this._document = document;
	}

	/** Sizes the buffer and the canvas to the pane, in device pixels. Returns true if they were made anew (and are empty). */
	public resize(width: number, height: number): boolean {
		if (width === this.width && height === this.height) {
			return false;
		}
		trackCanvas(this.width * this.height, width * height);
		this.width = width;
		this.height = height;
		// The buffer of an `ImageData` where there is one, so handing the pixels over copies nothing.
		const image = typeof ImageData === 'function' && width > 0 && height > 0 ? new ImageData(height, width) : null;
		this._image = image;
		this.pixels = image === null ? new Uint32Array(width * height) : new Uint32Array(image.data.buffer);
		if (this._canvas === null) {
			this._canvas = this._document.createElement('canvas');
			this._ctx = this._canvas.getContext('2d');
		}
		this._canvas.width = height;
		this._canvas.height = width;
		emptyBox(this.box);
		return true;
	}

	/** Makes every pixel transparent again. Returns the box that held pixels, which `commit` must cover. */
	public clear(cleared: PixelBox): void {
		const box = this.box;
		cleared.left = box.left;
		cleared.top = box.top;
		cleared.right = box.right;
		cleared.bottom = box.bottom;
		if (box.right > box.left && box.bottom > box.top) {
			const height = this.height;
			if (box.top === 0 && box.bottom === height) {
				this.pixels.fill(0, box.left * height, box.right * height);
			} else {
				for (let x = box.left; x < box.right; x++) {
					this.pixels.fill(0, x * height + box.top, x * height + box.bottom);
				}
			}
		}
		emptyBox(box);
	}

	/** Hands the pixels of `box` over to the canvas. */
	public commit(box: PixelBox): void {
		const left = Math.max(0, box.left);
		const top = Math.max(0, box.top);
		const right = Math.min(this.width, box.right);
		const bottom = Math.min(this.height, box.bottom);
		if (this._ctx === null || this._image === null || right <= left || bottom <= top) {
			return;
		}
		// Transposed: the pane's rows are the canvas' columns.
		this._ctx.putImageData(this._image, 0, 0, top, left, bottom - top, right - left);
	}

	/** Composites the picture onto a layer, at `opacity`. */
	public draw(ctx: CanvasRenderingContext2D, opacity: number): void {
		const box = this.box;
		const canvas = this._canvas;
		if (canvas === null || !(box.right > box.left && box.bottom > box.top) || !(opacity > 0)) {
			return;
		}
		const width = box.right - box.left;
		const height = box.bottom - box.top;
		ctx.save();
		// Swaps x and y: the canvas' pixel `(y, x)` goes to the pane's `(x, y)`, pixel onto pixel.
		ctx.transform(0, 1, 1, 0, 0, 0);
		ctx.imageSmoothingEnabled = false;
		if (opacity < 1) {
			ctx.globalAlpha *= opacity;
		}
		ctx.drawImage(canvas, box.top, box.left, height, width, box.top, box.left, height, width);
		ctx.restore();
	}

	/** Lets the canvas and the buffer go. */
	public release(): void {
		trackCanvas(this.width * this.height, 0);
		if (this._canvas !== null) {
			// Shrinking the bitmap releases canvas memory right away on iOS Safari.
			this._canvas.width = 1;
			this._canvas.height = 1;
		}
		this._canvas = null;
		this._ctx = null;
		this._image = null;
		this.pixels = new Uint32Array(0);
		this.width = 0;
		this.height = 0;
		emptyBox(this.box);
	}
}
