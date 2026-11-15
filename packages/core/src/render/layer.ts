/** One canvas of the chart, positioned in CSS pixels and backed by a bitmap in device pixels. */
export class Layer {
	public readonly canvas: HTMLCanvasElement;
	public readonly ctx: CanvasRenderingContext2D | null;
	/** Bitmap size in device pixels. */
	public width = 0;
	public height = 0;
	private _left = -1;
	private _top = -1;
	private _cssWidth = -1;
	private _cssHeight = -1;

	public constructor(doc: Document, opaque: boolean) {
		const canvas = doc.createElement('canvas');
		canvas.style.position = 'absolute';
		canvas.style.display = 'block';
		this.canvas = canvas;
		// An opaque canvas skips blending with what is behind it.
		this.ctx = canvas.getContext('2d', { alpha: !opaque });
	}

	/** Moves and sizes the canvas. Returns true if the bitmap was reallocated (and so cleared). */
	public place(left: number, top: number, width: number, height: number, pixelRatio: number): boolean {
		const style = this.canvas.style;
		if (left !== this._left || top !== this._top) {
			this._left = left;
			this._top = top;
			style.left = `${left}px`;
			style.top = `${top}px`;
		}
		if (width !== this._cssWidth || height !== this._cssHeight) {
			this._cssWidth = width;
			this._cssHeight = height;
			style.width = `${width}px`;
			style.height = `${height}px`;
		}
		const bitmapWidth = Math.max(1, Math.round(width * pixelRatio));
		const bitmapHeight = Math.max(1, Math.round(height * pixelRatio));
		if (bitmapWidth === this.width && bitmapHeight === this.height) {
			return false;
		}
		this.width = bitmapWidth;
		this.height = bitmapHeight;
		this.canvas.width = bitmapWidth;
		this.canvas.height = bitmapHeight;
		return true;
	}

	public release(): void {
		// Shrinking the bitmap releases canvas memory right away on iOS Safari.
		this.canvas.width = 1;
		this.canvas.height = 1;
		this.width = 0;
		this.height = 0;
	}
}
