import type { AnyMarkOptions, MarkSeriesType } from './options';
import type { ValueMapping } from './palette';
import type { PriceProjection } from './render';
import type { TimeMap } from './time-map';
import type { MarksWindow } from './window';

/** The legacy 'auto' preference resolves to the WebGL2 default. */
export type MarkRenderer = 'canvas2d' | 'webgl2' | 'webgpu' | 'auto';
export type MarkRendererReason =
	| 'initializing'
	| 'unavailable'
	| 'device-lost'
	| 'initialization-failed'
	| 'render-failed'
	| 'unsupported-style'
	| 'budget'
	| 'context-lost';
export interface MarkRendererStatus {
	requested: MarkRenderer;
	effective: 'canvas2d' | 'webgl2' | 'webgpu';
	reason: MarkRendererReason | null;
	path: 'canvas2d' | 'webgl2' | 'heatmap' | 'scatter-tiles' | 'scatter-columns';
	/** Estimated per-series GPU storage and backend bitmaps, excluding shared GL resources. */
	bytes: number;
	/** Highest observed allocation after a completed draw on this series. */
	peakBytes: number;
}
export interface MarkFrame {
	type: MarkSeriesType;
	window: MarksWindow;
	map: TimeMap;
	projection: PriceProjection;
	mapping: ValueMapping;
	palette: Uint32Array;
	options: AnyMarkOptions;
	width: number;
	height: number;
	ratio: number;
	from: number;
	to: number;
}

export interface GpuBackend {
	paint(
		frame: MarkFrame,
		context: CanvasRenderingContext2D,
		full: boolean,
	): 'heatmap' | 'scatter-tiles' | 'scatter-columns' | 'budget';
	readonly bytes: number;
	release(): void;
}

export interface GpuLease {
	release(): void;
}
type Ready = (backend: GpuBackend | null, reason: MarkRendererReason | null) => void;

/** A series owns one lease. Import and adapter callbacks may finish after a chart is gone. */
export class MarkGpuClient {
	public backend: GpuBackend | null = null;
	public reason: MarkRendererReason | null = null;
	private _lease: GpuLease | null = null;
	private _generation = 0;
	private _started = false;

	public start(doc: Document, invalidate: () => void): void {
		if (this._started) return;
		this._started = true;
		if (!doc.defaultView?.navigator.gpu) {
			this.reason = 'unavailable';
			return;
		}
		this.reason = 'initializing';
		const generation = this._generation;
		const ready: Ready = (backend, reason) => {
			if (this._generation !== generation) {
				backend?.release();
				return;
			}
			this.backend?.release();
			this.backend = backend;
			this.reason = reason;
			invalidate();
		};
		void import('./gpu/device.js')
			.then(module => {
				if (this._generation === generation) this._lease = module.acquire(doc, ready);
			})
			.catch(() => ready(null, 'initialization-failed'));
	}

	public disable(reason: MarkRendererReason): void {
		this._started = true;
		this.reason = reason;
	}

	public release(): void {
		if (!this._started) return;
		this._generation++;
		this.backend?.release();
		this.backend = null;
		this._lease?.release();
		this._lease = null;
		this.reason = null;
		this._started = false;
	}
}
