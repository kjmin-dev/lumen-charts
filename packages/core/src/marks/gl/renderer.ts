import { canvasFits, trackCanvas } from '../../shared/canvas-budget';
import type { HeatSlots, MarkFrame, MarkRendererReason } from '../backend';
import { heatStyle, scatterBounds, scatterRecords } from '../gpu/geometry';
import { heatEdge, slotColors } from '../render';
import { HeatRanges } from '../heat-ranges';
import type { ScatterOptions } from '../options';
import { parseColor } from '../palette';
import { GlBudget, GlContext, type GlProgram } from './context';
import { WordTexture } from './texture';

class GlLayer {
	private cache: CanvasRenderingContext2D;
	private pixels = 0;
	private records: WordTexture;
	private ranges: WordTexture;
	private style: WordTexture;
	private heat = new HeatRanges();
	private bounds = new Uint32Array(0);
	private packed = new Uint32Array(0);
	private colors = new Uint32Array(512);
	private version = -1;
	private count = -1;
	private revision = -1;
	private projection = '';
	private mapping = '';
	private palette: Uint32Array | null = null;
	private fallback = '';
	/** Whether the records hold the heatmap's palette slots, four to a word, rather than its values. */
	public slots = false;
	/** The slots buffer the records were uploaded from, and the columns uploaded: `[slotsFrom, slotsTo)`. */
	private slotsBuffer: Uint8Array | null = null;
	private slotsFrom = 0;
	private slotsTo = 0;
	constructor(
		private pool: GlContext,
		private listener: () => void,
	) {
		const cache = pool.canvas.ownerDocument.createElement('canvas').getContext('2d');
		if (!cache) throw new Error('Mark layer unavailable');
		this.cache = cache;
		this.records = new WordTexture(pool, 0);
		this.ranges = new WordTexture(pool, 1);
		this.style = new WordTexture(pool, 2);
	}
	get bytes() {
		return 4 * (this.pixels + this.records.words + this.ranges.words + this.style.words);
	}

	private resize(width: number, height: number): boolean {
		const cache = this.cache;
		if (this.pixels && cache.canvas.width === height && cache.canvas.height === width) return false;
		if (!canvasFits(width * height - this.pixels)) throw new GlBudget();
		// Match the transposed Canvas painter. Firefox uses a different opacity
		// rounding path for axis-aligned and transposed drawImage operations.
		cache.canvas.width = height;
		cache.canvas.height = width;
		cache.setTransform(0, 1, 1, 0, 0, 0);
		cache.imageSmoothingEnabled = false;
		trackCanvas(this.pixels, width * height);
		this.pixels = width * height;
		return true;
	}

	private scatter(f: MarkFrame, p: GlProgram, full: boolean, styleChanged: boolean) {
		const { window: w, width, height, projection } = f;
		const options = f.options as ScatterOptions;
		const key = [projection.offset, projection.scale, projection.log].join(',');
		const fresh = this.records.bind(w.capacity * 2) || w.version !== this.version;
		const all = fresh || styleChanged || key !== this.projection || options.color !== this.fallback;
		const from = all ? 0 : w.dirtyFrom,
			to = all ? w.count : w.dirtyTo;
		if (to > from) {
			if (this.packed.length < w.capacity * 2) this.packed = new Uint32Array(w.capacity * 2);
			scatterRecords(f, this.packed, from, to, parseColor(options.color) ?? 0);
			this.records.write(this.packed, from * 2, to * 2);
		}
		this.projection = key;
		this.fallback = options.color;

		const size = Math.max(1, Math.round(options.pointSize * f.ratio));
		const n = width + size;
		this.ranges.bind(n);
		if (this.bounds.length < n) this.bounds = new Uint32Array(n);
		scatterBounds(f, size, this.bounds);
		this.ranges.write(this.bounds, 0, n);
		let left = 0,
			right = width;
		if (!full && !all && w.level === 0 && to > from) {
			const shift = options.barAlign === 'start' ? -f.map.spacing / 2 : 0;
			left = Math.min(width, Math.max(0, Math.floor(f.map.x(w.time[from]!) + shift) - size));
			right = Math.max(left, Math.min(width, Math.ceil(f.map.x(w.time[to - 1]!) + shift) + size + 1));
		}
		const gl = this.pool.gl;
		const first = this.bounds[left]!,
			end = this.bounds[right + size - 1]!;
		this.records.layout(p.recordsStride);
		this.ranges.layout(p.rangesStride);
		gl.uniform1i(p.first, first);
		gl.uniform1i(p.stamp, size);
		gl.uniform1i(p.circle, Number(options.shape === 'circle'));
		gl.scissor(left, 0, right - left, height);
		gl.clear(gl.COLOR_BUFFER_BIT);
		if (right > left && end > first) gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, end - first);
		this.copy(left, right, height);
	}

	/**
	 * Uploads the slots of the columns in view that the records lack, and of those a patch changed.
	 * The records hold the slots of columns `[slotsFrom, slotsTo)`, a range that grows with the view
	 * and starts over when the view leaves it: a pan uploads the columns that come into view.
	 */
	private uploadSlots(f: MarkFrame, slots: HeatSlots, mappingChanged: boolean): boolean {
		const w = f.window,
			rows = w.rows;
		const cells = slots.update(f.from, f.to);
		const fresh =
			this.records.bind(Math.ceil((w.capacity * rows) / 4)) ||
			w.version !== this.version ||
			!this.slots ||
			mappingChanged ||
			cells !== this.slotsBuffer ||
			!slots.holds(this.slotsFrom, this.slotsTo);
		const words = new Uint32Array(cells.buffer, cells.byteOffset, cells.length >> 2);
		const upload = (from: number, to: number) => {
			if (to > from) this.records.write(words, Math.floor((from * rows) / 4), Math.ceil((to * rows) / 4));
		};
		if (fresh || f.to <= this.slotsFrom || f.from >= this.slotsTo) {
			upload(f.from, f.to);
			this.slotsFrom = f.from;
			this.slotsTo = f.to;
		} else {
			upload(Math.max(w.dirtyFrom, this.slotsFrom), Math.min(w.dirtyTo, this.slotsTo));
			if (f.from < this.slotsFrom) upload(f.from, this.slotsFrom);
			if (f.to > this.slotsTo) upload(this.slotsTo, f.to);
			this.slotsFrom = Math.min(this.slotsFrom, f.from);
			this.slotsTo = Math.max(this.slotsTo, f.to);
		}
		this.slotsBuffer = cells;
		return fresh;
	}

	private heatmap(f: MarkFrame, p: GlProgram, full: boolean, styleChanged: boolean, mappingChanged: boolean) {
		const { window: w, width, height } = f;
		const slots = f.slots ?? null;
		const modeChanged = (slots !== null) !== this.slots;
		// Slots take a quarter of the words of values: the records are made again at their size.
		if (modeChanged) this.records.release();
		let fresh: boolean;
		if (slots) {
			fresh = this.uploadSlots(f, slots, mappingChanged);
		} else {
			fresh = this.records.bind(w.capacity * w.rows) || w.version !== this.version || modeChanged;
			const from = fresh ? 0 : w.dirtyFrom,
				to = fresh ? w.count : w.dirtyTo;
			if (to > from) {
				const data = new Uint32Array(w.values.buffer as ArrayBuffer, w.values.byteOffset, w.values.length);
				this.records.write(data, from * w.rows, to * w.rows);
			}
			this.slotsBuffer = null;
		}
		this.slots = slots !== null;
		const from = fresh ? 0 : w.dirtyFrom,
			to = fresh ? w.count : w.dirtyTo;
		const n = (width + height) * 2;
		const sameGrid = !this.ranges.bind(n) && !full && !fresh && w.count === this.count;
		if (!sameGrid) {
			this.heat.project(f);
			this.ranges.write(this.heat.data, 0, n);
		}
		if (this.style.bind(512) || styleChanged || modeChanged) {
			// Slots need only their colors; values the first value of each slot too.
			if (slots) slotColors(f.palette, this.colors);
			else heatStyle(f.palette, f.mapping, this.colors);
			this.style.write(this.colors, 0, slots ? 256 : 512);
		}
		let left = 0,
			right = width;
		if (sameGrid && from === w.count - 1 && to === w.count) {
			left = Math.max(0, Math.min(width, heatEdge(w.time, w.count, from, f.map)));
			right = Math.max(left, Math.min(width, heatEdge(w.time, w.count, to, f.map)));
		} else if (!full && !fresh && to > from) {
			// The column before an append or replacement shares its edge.
			left = Math.max(0, Math.min(width, Math.round(f.map.x(w.time[Math.max(0, from - 1)]!) - f.map.spacing / 2)));
		}
		const gl = this.pool.gl;
		this.records.layout(p.recordsStride);
		this.ranges.layout(p.rangesStride);
		this.style.layout(p.styleStride);
		gl.uniform1i(p.rows, w.rows);
		gl.scissor(left, 0, right - left, height);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		this.copy(left, right, height);
	}

	private copy(left: number, right: number, height: number) {
		const width = right - left;
		if (width <= 0) return;
		this.cache.clearRect(left, 0, width, height);
		this.cache.drawImage(
			this.pool.canvas,
			left,
			this.pool.canvas.height - height,
			width,
			height,
			left,
			0,
			width,
			height,
		);
	}

	paint(f: MarkFrame, target: CanvasRenderingContext2D, full: boolean) {
		const { width, height, window: w } = f;
		if (full || this.version !== w.version || this.revision !== w.revision) {
			const kind = f.type === 'scatter' ? 'scatter' : f.slots ? 'heatmap-slots' : 'heatmap';
			const program = this.pool.begin(this.listener, kind, width, height);
			full = this.resize(width, height) || full;
			const mapping = [f.mapping.min, f.mapping.factor, f.mapping.log].join(',');
			const mappingChanged = mapping !== this.mapping;
			const styleChanged = this.palette !== f.palette || mappingChanged;
			this.pool.gl.enable(this.pool.gl.SCISSOR_TEST);
			if (f.type === 'scatter') this.scatter(f, program, full, styleChanged);
			else this.heatmap(f, program, full, styleChanged, mappingChanged);
			this.count = w.count;
			this.version = w.version;
			this.revision = w.revision;
			this.mapping = mapping;
			this.palette = f.palette;
		}
		if (f.options.opacity > 0) {
			target.save();
			target.transform(0, 1, 1, 0, 0, 0);
			target.imageSmoothingEnabled = false;
			target.globalAlpha *= Math.min(1, f.options.opacity);
			target.drawImage(this.cache.canvas, 0, 0);
			target.restore();
		}
	}
	/** Frames were drawn without this layer: the records may have missed patches. */
	stale() {
		this.version = -1;
	}
	release() {
		this.records.release();
		this.ranges.release();
		this.style.release();
		this.cache.canvas.width = this.cache.canvas.height = 1;
		trackCanvas(this.pixels, 0);
		this.pixels = 0;
	}
}

export class GlMarkClient {
	private pool: GlContext | null = null;
	private layer: GlLayer | null = null;
	private failure: MarkRendererReason | null = null;
	constructor(
		private doc: Document,
		private invalidate: () => void,
	) {}
	private readonly change = () => {
		this.resetLayer();
		this.invalidate();
	};
	private resetLayer() {
		this.layer?.release();
		this.layer = null;
	}
	get bytes() {
		return this.layer?.bytes ?? 0;
	}
	/** What the last heatmap paint drew from: its values or its palette slots. */
	get heatPath(): 'values' | 'slots' | null {
		return this.layer ? (this.layer.slots ? 'slots' : 'values') : null;
	}
	/** A frame drew the series another way, and cleared the patches the layer would have uploaded. */
	stale() {
		this.layer?.stale();
	}
	paint(f: MarkFrame, target: CanvasRenderingContext2D, full: boolean): MarkRendererReason | null {
		if (this.failure) return this.failure;
		try {
			this.pool ??= GlContext.acquire(this.doc, this.change);
			if (!this.pool) return (this.failure = 'unavailable');
			if (this.pool.gl.isContextLost()) return 'context-lost';
			this.layer ??= new GlLayer(this.pool, this.change);
			this.layer.paint(f, target, full);
			return null;
		} catch (error) {
			this.resetLayer();
			if (this.pool?.gl.isContextLost()) return 'context-lost';
			if (error instanceof GlBudget) return 'budget';
			this.release();
			return (this.failure = 'render-failed');
		}
	}
	release() {
		this.resetLayer();
		this.pool?.release(this.change);
		this.pool = null;
		this.failure = null;
	}
}
