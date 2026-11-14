export interface ChartOptions {
	/** Width in CSS pixels. Ignored while `autoSize` is on. */
	width: number;
	/** Height in CSS pixels. Ignored while `autoSize` is on. */
	height: number;
	/** Follow the size of the container element. */
	autoSize: boolean;
	/** Background color (any CSS color). */
	background: string;
}

export interface ChartApi {
	/** Merges options. Applying values equal to the current ones does nothing. */
	applyOptions(options: Partial<ChartOptions>): void;
	options(): Readonly<ChartOptions>;
	/** Sets an explicit size in CSS pixels. Has no effect while `autoSize` is on. */
	resize(width: number, height: number): void;
	/** Root element created by the chart inside the container. */
	element(): HTMLElement;
	/** Removes the chart from the DOM and releases its resources. */
	destroy(): void;
}

const DEFAULT_OPTIONS: ChartOptions = {
	width: 600,
	height: 300,
	autoSize: true,
	background: '#ffffff',
};

type FrameHandle = number;

class Chart implements ChartApi {
	private readonly _container: HTMLElement;
	private readonly _root: HTMLDivElement;
	private readonly _canvas: HTMLCanvasElement;
	private _options: ChartOptions;
	private _width = 0;
	private _height = 0;
	private _frame: FrameHandle | null = null;
	private _resizeObserver: ResizeObserver | null = null;
	private _destroyed = false;

	public constructor(container: HTMLElement, options: Partial<ChartOptions>) {
		this._container = container;
		this._options = { ...DEFAULT_OPTIONS, ...definedOnly(options) };

		const doc = container.ownerDocument;
		this._root = doc.createElement('div');
		this._root.style.position = 'relative';
		this._root.style.overflow = 'hidden';
		this._canvas = doc.createElement('canvas');
		this._canvas.style.display = 'block';
		this._root.appendChild(this._canvas);
		container.appendChild(this._root);

		this._syncSizing();
	}

	public applyOptions(options: Partial<ChartOptions>): void {
		if (this._destroyed) {
			return;
		}
		const next = { ...this._options, ...definedOnly(options) };
		if (shallowEqual(this._options, next)) {
			return;
		}
		this._options = next;
		this._syncSizing();
		this._invalidate();
	}

	public options(): Readonly<ChartOptions> {
		return this._options;
	}

	public resize(width: number, height: number): void {
		if (this._destroyed || this._options.autoSize) {
			return;
		}
		this.applyOptions({ width, height });
	}

	public element(): HTMLElement {
		return this._root;
	}

	public destroy(): void {
		if (this._destroyed) {
			return;
		}
		this._destroyed = true;
		this._resizeObserver?.disconnect();
		this._resizeObserver = null;
		if (this._frame !== null) {
			cancelFrame(this._frame);
			this._frame = null;
		}
		// Shrinking the bitmap releases canvas memory right away on iOS Safari.
		this._canvas.width = 1;
		this._canvas.height = 1;
		this._root.remove();
	}

	private _syncSizing(): void {
		if (this._options.autoSize) {
			this._root.style.width = '100%';
			this._root.style.height = '100%';
			if (this._resizeObserver === null && typeof ResizeObserver !== 'undefined') {
				this._resizeObserver = new ResizeObserver(() => this._measure());
				this._resizeObserver.observe(this._container);
			}
			this._measure();
		} else {
			this._resizeObserver?.disconnect();
			this._resizeObserver = null;
			this._root.style.width = `${this._options.width}px`;
			this._root.style.height = `${this._options.height}px`;
			this._setSize(this._options.width, this._options.height);
		}
	}

	private _measure(): void {
		const rect = this._container.getBoundingClientRect();
		this._setSize(Math.floor(rect.width), Math.floor(rect.height));
	}

	private _setSize(width: number, height: number): void {
		if (width === this._width && height === this._height) {
			return;
		}
		this._width = width;
		this._height = height;
		this._invalidate();
	}

	/** Coalesces any number of changes into one draw per animation frame. */
	private _invalidate(): void {
		if (this._destroyed || this._frame !== null) {
			return;
		}
		this._frame = requestFrame(() => {
			this._frame = null;
			this._draw();
		});
	}

	private _draw(): void {
		const ratio = this._container.ownerDocument.defaultView?.devicePixelRatio ?? 1;
		const bitmapWidth = Math.max(1, Math.round(this._width * ratio));
		const bitmapHeight = Math.max(1, Math.round(this._height * ratio));
		if (this._canvas.width !== bitmapWidth || this._canvas.height !== bitmapHeight) {
			this._canvas.width = bitmapWidth;
			this._canvas.height = bitmapHeight;
			this._canvas.style.width = `${this._width}px`;
			this._canvas.style.height = `${this._height}px`;
		}
		const ctx = this._canvas.getContext('2d');
		if (ctx === null) {
			return;
		}
		ctx.fillStyle = this._options.background;
		ctx.fillRect(0, 0, bitmapWidth, bitmapHeight);
	}
}

function requestFrame(callback: () => void): FrameHandle {
	return requestAnimationFrame(callback);
}

function cancelFrame(handle: FrameHandle): void {
	cancelAnimationFrame(handle);
}

function definedOnly<T extends object>(value: Partial<T>): Partial<T> {
	const result: Partial<T> = {};
	for (const key of Object.keys(value) as (keyof T)[]) {
		if (value[key] !== undefined) {
			result[key] = value[key];
		}
	}
	return result;
}

function shallowEqual<T extends object>(a: T, b: T): boolean {
	for (const key of Object.keys(a) as (keyof T)[]) {
		if (a[key] !== b[key]) {
			return false;
		}
	}
	return true;
}

/** Creates a chart inside `container`. */
export function createChart(container: HTMLElement, options: Partial<ChartOptions> = {}): ChartApi {
	return new Chart(container, options);
}
