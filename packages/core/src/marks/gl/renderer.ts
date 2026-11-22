import { canvasFits, trackCanvas } from '../../shared/canvas-budget';
import type { HeatSlots, MarkFrame, MarkRendererReason } from '../backend';
import { heatStyle, scatterBounds, scatterRecords } from '../gpu/geometry';
import { heatEdge, heatRowSpan, pointPixels, slotColors, StampCache } from '../render';
import { HeatPan, HeatRanges } from '../heat-ranges';
import type { ScatterOptions } from '../options';
import { PALETTE_SIZE, paletteIndex, parseColor, unpackColor } from '../palette';
import { GlBudget, GlContext, type GlProgram, GlUnsupported } from './context';
import { GlDensity, packScatterRows } from './density';
import { WordTexture } from './texture';

const SPAN = { low: 0, high: 0 };

/** The most rows one frame's append writes into the retained image in Canvas 2D (see `GlLayer.appendPatch`). */
const PATCH_ROWS = 32;

class GlLayer {
	private cache: CanvasRenderingContext2D;
	private pixels = 0;
	private records: WordTexture;
	private ranges: WordTexture;
	private style: WordTexture;
	/** A scatter's densities (`colorBy: 'density'`), made with the first frame that has them. */
	private density: GlDensity | null = null;
	private heat = new HeatRanges();
	private bounds = new Uint32Array(0);
	private packed = new Uint32Array(0);
	/** `packed` as floats, for the counts of densities. */
	private packedFloats = new Float32Array(0);
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
	/** A grid that follows the price: the column table, the window it was written for, and where. */
	private table = new Uint32Array(0);
	private tableVersion = -1;
	private tableAt = -1;
	/** The grid rows the columns in view spanned when the pixel ranges were made. */
	private span = '';
	/** A heatmap's integer pans, which translate the retained image, and the projection it was drawn at. */
	private heatPan = new HeatPan();
	private heatProjection = '';
	/** Words per scatter record of the last draw: 2, or 3 with sizes; 0 for none. */
	private words = 0;
	/**
	 * Rows `[pendingFrom, pendingTo)` were appended into the retained image in Canvas 2D: their
	 * records are uploaded with the next WebGL2 draw.
	 */
	private pendingFrom = Infinity;
	private pendingTo = -Infinity;
	private readonly stamps = new StampCache();
	/** The palette of the scatter records, and its colors premultiplied. */
	private straight: Uint32Array | null = null;
	private readonly premultiplied = new Uint32Array(PALETTE_SIZE);
	private readonly cssColors = new Map<number, string>();
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
		return 4 * (this.pixels + this.records.words + this.ranges.words + this.style.words) + (this.density?.bytes ?? 0);
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
		const { window: w, width, height, projection, ratio } = f;
		const options = f.options as ScatterOptions;
		const density = options.colorBy === 'density';
		// A size per row takes a third word; densities put the count where the color was.
		const words = w.sizes.length > 0 ? 3 : 2;
		const key = [projection.offset, projection.scale, projection.log, words, density, words > 2 ? ratio : 0].join(',');
		const fresh = this.records.bind(w.capacity * words) || w.version !== this.version;
		const all = fresh || key !== this.projection || (!density && (styleChanged || options.color !== this.fallback));
		// Rows appended in Canvas 2D since the last draw have their records uploaded now.
		const from = all ? 0 : Math.min(w.dirtyFrom, this.pendingFrom),
			to = all ? w.count : Math.max(w.dirtyTo, this.pendingTo);
		this.pendingFrom = Infinity;
		this.pendingTo = -Infinity;
		this.words = words;
		if (to > from) {
			if (this.packed.length < w.capacity * words) {
				this.packed = new Uint32Array(w.capacity * words);
				this.packedFloats = new Float32Array(this.packed.buffer);
			}
			// Records hold colors premultiplied, as the drawing buffer takes them.
			const premultiply = this.pool.premultiply;
			const fallback = premultiply.color(parseColor(options.color) ?? 0);
			if (this.straight !== f.palette) {
				this.premultiplied.set(f.palette);
				premultiply.palette(this.premultiplied);
				this.straight = f.palette;
			}
			const frame = { ...f, palette: this.premultiplied };
			if (words === 2 && !density) scatterRecords(frame, this.packed, from, to, fallback);
			else packScatterRows(frame, this.packed, this.packedFloats, from, to, fallback, words, density);
			this.records.write(this.packed, from * words, to * words);
		}
		this.projection = key;
		this.fallback = options.color;

		// The column ranges are padded by the widest point, so none that reaches a column is left out.
		const base = pointPixels(options.pointSize, ratio);
		const size = Math.max(base, f.stampMax ?? base);
		const n = width + size;
		this.ranges.bind(n);
		if (this.bounds.length < n) this.bounds = new Uint32Array(n);
		scatterBounds(f, size, this.bounds);
		this.ranges.write(this.bounds, 0, n);
		// Densities add up: a patch can only add the rows appended since they were summed.
		const patch = !full && !all && w.level === 0 && to > from && (!density || from >= this.count);
		let left = 0,
			right = width;
		if (patch) {
			const shift = options.barAlign === 'start' ? -f.map.spacing / 2 : 0;
			left = Math.min(width, Math.max(0, Math.floor(f.map.x(w.time[from]!) + shift) - size));
			right = Math.max(left, Math.min(width, Math.ceil(f.map.x(w.time[to - 1]!) + shift) + size + 1));
		}
		const gl = this.pool.gl;
		this.records.layout(p.recordsStride);
		this.ranges.layout(p.rangesStride);
		gl.uniform1i(p.stamp, size);
		gl.uniform1i(p.base, base);
		gl.uniform1i(p.recordWords, words);
		gl.uniform1i(p.circle, Number(options.shape === 'circle'));
		// Point sprites where the context draws them as large as the widest point: one search per point.
		const guard = this.pool.pointGuard(size, width, height);
		gl.uniform1i(p.guard, guard);
		if (density) {
			// Every row of the pane, or those appended that are in it.
			let first = this.bounds[0]!,
				end = this.bounds[n - 1]!;
			if (patch) {
				first = Math.max(first, from);
				end = Math.min(end, to);
			}
			this.density ??= new GlDensity(this.pool);
			const strip = this.density.draw(f, p, first, end, patch, left, right, guard);
			this.copy(strip.left, strip.right, height);
			return;
		}
		this.density?.release();
		this.density = null;
		const first = this.bounds[left]!,
			end = this.bounds[right + size - 1]!;
		gl.uniform1i(p.first, first);
		gl.scissor(left, 0, right - left, height);
		gl.clear(gl.COLOR_BUFFER_BIT);
		if (right > left && end > first) this.pool.drawScatter(guard, width, height, end - first);
		this.copy(left, right, height);
	}

	/**
	 * Uploads the slots of the columns in view that the records lack, and of those a patch changed.
	 * The records hold the slots of columns `[slotsFrom, slotsTo)`, a range that grows with the view
	 * and starts over when the view leaves it: a pan uploads the columns that come into view.
	 */
	private uploadSlots(f: MarkFrame, slots: HeatSlots, mappingChanged: boolean): boolean {
		const w = f.window;
		const cells = slots.update(f.from, f.to);
		const fresh =
			this.records.bind(Math.ceil(w.cellCapacity / 4)) ||
			w.version !== this.version ||
			!this.slots ||
			mappingChanged ||
			cells !== this.slotsBuffer ||
			!slots.holds(this.slotsFrom, this.slotsTo);
		const words = new Uint32Array(cells.buffer, cells.byteOffset, cells.length >> 2);
		const upload = (from: number, to: number) => {
			if (to > from) this.records.write(words, Math.floor(w.cellStart(from) / 4), Math.ceil(w.cellStart(to) / 4));
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

	/**
	 * Where the grid follows the price, writes the column table after the pixel ranges: where each
	 * column's cells start, its first grid row plus 2^30, and its number of cells. Columns
	 * `[from, to)` are written, or all held after a new window.
	 */
	private uploadTable(f: MarkFrame, at: number, all: boolean, from: number, to: number): void {
		const w = f.window;
		if (all || this.tableVersion !== w.version) {
			from = 0;
			to = w.count;
		}
		this.tableVersion = w.version;
		if (to <= from) return;
		if (this.table.length < w.capacity * 3) this.table = new Uint32Array(w.capacity * 3);
		const table = this.table;
		for (let c = from; c < to; c++) {
			table[c * 3] = w.cellStart(c);
			table[c * 3 + 1] = w.cellOffset(c) + 0x40000000;
			table[c * 3 + 2] = w.cellLength(c);
		}
		this.ranges.write(table, from * 3, to * 3, at + from * 3);
	}

	private heatmap(
		f: MarkFrame,
		p: GlProgram,
		full: boolean,
		styleChanged: boolean,
		mappingChanged: boolean,
		resized: boolean,
	) {
		const { window: w, width, height } = f;
		const slots = f.slots ?? null;
		const modeChanged = (slots !== null) !== this.slots;
		// Slots take a quarter of the words of values: the records are made again at their size.
		if (modeChanged) this.records.release();
		let fresh: boolean;
		if (slots) {
			fresh = this.uploadSlots(f, slots, mappingChanged);
		} else {
			fresh = this.records.bind(w.cellCapacity) || w.version !== this.version || modeChanged;
			const from = fresh ? 0 : w.dirtyFrom,
				to = fresh ? w.count : w.dirtyTo;
			if (to > from) {
				const data = new Uint32Array(w.values.buffer as ArrayBuffer, w.values.byteOffset, w.values.length);
				this.records.write(data, w.cellStart(from), w.cellStart(to));
			}
			this.slotsBuffer = null;
		}
		this.slots = slots !== null;
		const from = fresh ? 0 : w.dirtyFrom,
			to = fresh ? w.count : w.dirtyTo;
		const n = (width + height) * 2;
		const varying = w.varying;
		const rebound = this.ranges.bind(n + (varying ? w.capacity * 3 : 0));
		// Where the grid follows the price, the rows a pixel row reads change with the rows in view.
		let span = '';
		if (varying) {
			heatRowSpan(w, f.from, f.to, SPAN);
			span = `${SPAN.low},${SPAN.high}`;
		}
		const sameGrid = !rebound && !full && !fresh && w.count === this.count && span === this.span;
		const projection = `${f.projection.offset},${f.projection.scale},${f.projection.log}`;
		let delta: number | null = null;
		if (!sameGrid) {
			this.heat.project(f);
			this.ranges.write(this.heat.data, 0, n);
			this.span = span;
			// As the WebGPU path: an integer pan whose overlapping columns and rows read the cells they
			// read before translates the retained image, and draws the columns it exposes.
			delta = this.heatPan.translation(
				f.map.x(w.time[0]!),
				this.heat.data,
				width,
				height,
				!resized &&
					!fresh &&
					!styleChanged &&
					!modeChanged &&
					this.revision === w.revision &&
					projection === this.heatProjection,
				this.heat.rowBase,
			);
		}
		this.heatProjection = projection;
		if (varying) this.uploadTable(f, n, rebound || fresh || this.tableAt !== n, from, to);
		this.tableAt = varying ? n : -1;
		if (this.style.bind(512) || styleChanged || modeChanged) {
			// Slots need only their colors; values the first value of each slot too.
			if (slots) slotColors(f.palette, this.colors);
			else heatStyle(f.palette, f.mapping, this.colors);
			this.pool.premultiply.palette(this.colors);
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
		} else if (delta !== null) {
			if (delta !== 0) {
				// The image is transposed: the pane's columns are its rows.
				const cache = this.cache;
				cache.save();
				cache.setTransform(1, 0, 0, 1, 0, 0);
				cache.globalCompositeOperation = 'copy';
				cache.drawImage(cache.canvas, 0, delta);
				cache.restore();
			}
			if (delta >= 0) right = delta;
			else left = width + delta;
		}
		if (right <= left) return;
		const gl = this.pool.gl;
		this.records.layout(p.recordsStride);
		this.ranges.layout(p.rangesStride);
		this.style.layout(p.styleStride);
		gl.uniform1i(p.rows, w.rows);
		gl.uniform1i(p.table, varying ? n : -1);
		gl.uniform1i(p.rowBase, this.heat.rowBase);
		gl.scissor(left, 0, right - left, height);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		this.copy(left, right, height);
	}

	/**
	 * Writes the rows of a scatter append into the retained image in Canvas 2D, as the Canvas 2D and
	 * WebGPU paths do, rather than drawing a strip of the pane and copying it back from the GL
	 * canvas; their records wait for the next draw. A WebGL2 draw writes each pixel of a point as the
	 * color of the last row that covers it: for opaque colors, a `fillRect` of each point over the
	 * image in row order writes the same bytes. Returns false, having drawn nothing, where that does
	 * not hold or the patch is not one of appended rows at the finest level: the frame is drawn in
	 * WebGL2.
	 */
	private appendPatch(f: MarkFrame): boolean {
		const w = f.window;
		const options = f.options as ScatterOptions;
		if (
			options.colorBy === 'density' ||
			w.level !== 0 ||
			w.version !== this.version ||
			w.dirtyFrom < this.count ||
			!(w.dirtyTo > w.dirtyFrom) ||
			w.dirtyTo - w.dirtyFrom > PATCH_ROWS ||
			(w.sizes.length > 0 ? 3 : 2) !== this.words ||
			this.cache.canvas.width !== f.height ||
			this.cache.canvas.height !== f.width
		)
			return false;
		const first = Math.max(f.from, w.dirtyFrom),
			end = Math.min(f.to, w.dirtyTo);
		const fallback = parseColor(options.color) ?? 0;
		for (let i = first; i < end; i++) {
			const value = w.values[i]!;
			const color = value === value ? f.palette[paletteIndex(f.mapping, value)]! : fallback;
			if (unpackColor(color)[3] !== 255) return false;
		}
		const map = f.map;
		const { offset, scale, log } = f.projection;
		const shift = options.barAlign === 'start' ? -map.spacing / 2 : 0;
		const base = pointPixels(options.pointSize, f.ratio);
		const sizes = w.sizes;
		this.stamps.setCircle(options.shape === 'circle');
		const cache = this.cache;
		for (let i = first; i < end; i++) {
			const value = w.values[i]!;
			const color = value === value ? f.palette[paletteIndex(f.mapping, value)]! : fallback;
			let css = this.cssColors.get(color);
			if (css === undefined) {
				const [r, g, b] = unpackColor(color);
				css = `rgb(${r},${g},${b})`;
				if (this.cssColors.size >= 257) this.cssColors.clear();
				this.cssColors.set(color, css);
			}
			const own = sizes.length > 0 ? sizes[i]! : Number.NaN;
			const stamp = this.stamps.get(own === own ? pointPixels(own, f.ratio) : base);
			const size = stamp.size,
				half = size >> 1;
			// The pixel the point is centered on, as the column ranges and records place it.
			const t = w.time[i]!;
			map.segment(t);
			const x = Math.round(map.x0 + shift + (t - map.t0) * map.pace) - half;
			const price = w.price[i]!;
			const y = Math.round(offset - (log ? Math.log10(price) : price) * scale) - half;
			if (!(x > -size && x < f.width && y > -size && y < f.height)) continue;
			cache.fillStyle = css;
			if (stamp.square) cache.fillRect(x, y, size, size);
			else
				for (let c = 0; c < size; c++) {
					const top = stamp.spans[c * 2]!,
						bottom = stamp.spans[c * 2 + 1]!;
					if (bottom > top) cache.fillRect(x + c, y + top, 1, bottom - top);
				}
		}
		this.pendingFrom = Math.min(this.pendingFrom, w.dirtyFrom);
		this.pendingTo = Math.max(this.pendingTo, w.dirtyTo);
		this.count = w.count;
		this.revision = w.revision;
		return true;
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
		// A heatmap that goes over to its slots, or back to its values, is drawn again from them.
		const modeChanged = f.type === 'heatmap' && (f.slots != null) !== this.slots;
		const patched =
			!full && f.type === 'scatter' && this.revision !== w.revision && this.pixels > 0 && this.appendPatch(f);
		if (!patched && (full || modeChanged || this.version !== w.version || this.revision !== w.revision)) {
			const kind =
				f.type === 'scatter'
					? (f.options as ScatterOptions).colorBy === 'density'
						? 'scatter-density'
						: 'scatter'
					: f.slots
						? 'heatmap-slots'
						: 'heatmap';
			const program = this.pool.begin(this.listener, kind, width, height);
			const resized = this.resize(width, height);
			full ||= resized;
			const mapping = [f.mapping.min, f.mapping.factor, f.mapping.log].join(',');
			const mappingChanged = mapping !== this.mapping;
			const styleChanged = this.palette !== f.palette || mappingChanged;
			this.pool.gl.enable(this.pool.gl.SCISSOR_TEST);
			if (f.type === 'scatter') this.scatter(f, program, full, styleChanged);
			else this.heatmap(f, program, full, styleChanged, mappingChanged, resized);
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
		this.heatPan = new HeatPan();
		this.pendingFrom = Infinity;
		this.pendingTo = -Infinity;
	}
	release() {
		this.records.release();
		this.ranges.release();
		this.style.release();
		this.density?.release();
		this.density = null;
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
			if (f.type === 'scatter' && (f.options as ScatterOptions).colorBy === 'density' && !this.pool.floatBlend()) {
				// Densities need float blending: Canvas 2D sums them instead.
				this.resetLayer();
				return 'unsupported-style';
			}
			this.layer ??= new GlLayer(this.pool, this.change);
			this.layer.paint(f, target, full);
			return null;
		} catch (error) {
			this.resetLayer();
			if (this.pool?.gl.isContextLost()) return 'context-lost';
			if (error instanceof GlBudget) return 'budget';
			if (error instanceof GlUnsupported) return 'unsupported-style';
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
