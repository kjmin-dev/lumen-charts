import { heatEdge, heatRowSpan, slotColors } from '../render';
import { HeatRanges, HeatPan } from '../heat-ranges';
import { canvasFits, trackCanvas } from '../../shared/canvas-budget';
import type { GpuBackend, HeatSlots, MarkFrame } from '../backend';
import type { ScatterOptions } from '../options';
import { PALETTE_SIZE, parseColor, paletteIndex, unpackColor } from '../palette';
import { Premultiplier } from '../premultiply';
import type { GpuKernel, GpuPath, GpuResources } from './device';
import { heatStyle, PriceBands, scatterBounds, scatterRecords, fitsTileIndex } from './geometry';

// WebGPU IDL flag values. The DOM declarations shipped by the supported TypeScript
// compilers agree on the interfaces but differ on these global flag namespaces.
const BUFFER_COPY_DST = 0x08,
	BUFFER_UNIFORM = 0x40,
	BUFFER_STORAGE = 0x80;
const TEXTURE_COPY_SRC = 0x01,
	TEXTURE_COPY_DST = 0x02,
	TEXTURE_STORAGE = 0x08;
class Budget extends Error {}

const SPAN = { low: 0, high: 0 };
/**
 * From this square size (device pixels) a whole column draw takes one atomic per point and reads
 * the marker's rows back, rather than one atomic per row a marker covers. Smaller squares and the
 * strips of a patch keep the row kernel, which costs less there.
 */
const WIDE_COLUMNS = 5;
/**
 * A column draw that starts over projects the scatter rows in view, and later pans project those
 * that come into view, unless that would leave out fewer than this share of the rows held: then it
 * projects them all at once, because pans would soon project most of them anyway, one strip per
 * frame. Calibrated on the 1M cloud and the 5M trade-history pan (docs/benchmarks/projection-threshold.md).
 */
export const MIN_UNPROJECTED_SHARE = 0.4;

/**
 * The rows `[from, to)` that a column draw starting over projects: the rows in view,
 * `[viewFrom, viewTo)`, or all `count` rows held when the rows left out would be fewer than
 * `MIN_UNPROJECTED_SHARE` of them.
 */
export function startRows(viewFrom: number, viewTo: number, count: number): [number, number] {
	return count - (viewTo - viewFrom) < MIN_UNPROJECTED_SHARE * count ? [0, count] : [viewFrom, viewTo];
}

interface Upload {
	newWindow: boolean;
	styleChanged: boolean;
	mappingChanged: boolean;
	projection: string;
	dirtyFrom: number;
	dirtyTo: number;
}
interface Strip {
	left: number;
	right: number;
}
class BufferSlot {
	public buffer: GPUBuffer | null = null;
	public capacity = 0;
	private readonly device: GPUDevice;
	private readonly uniform: boolean;
	/** Names the buffer in GPU tools and to the qualification suite, which counts uploads by it. */
	private readonly label: string;
	constructor(device: GPUDevice, label: string, uniform = false) {
		this.device = device;
		this.label = label;
		this.uniform = uniform;
	}
	public reserve(bytes: number): boolean {
		bytes = Math.max(4, bytes);
		if (bytes <= this.capacity) return false;
		if (
			bytes > this.device.limits.maxStorageBufferBindingSize ||
			bytes > this.device.limits.maxBufferSize ||
			!canvasFits((bytes - this.capacity) / 4)
		)
			throw new Budget();
		const buffer = this.device.createBuffer({
			label: this.label,
			size: bytes,
			usage: BUFFER_COPY_DST | (this.uniform ? BUFFER_UNIFORM : BUFFER_STORAGE),
		});
		this.buffer?.destroy();
		trackCanvas(this.capacity / 4, bytes / 4);
		this.buffer = buffer;
		this.capacity = bytes;
		return true;
	}
	/** Writes words `[start, end)` of `data` to the buffer's words from `at` on (where they are in `data`, by default). */
	public write(data: Uint32Array | Float32Array, start = 0, end = data.length, at = start): void {
		if (end > start)
			this.device.queue.writeBuffer(
				this.buffer!,
				at * 4,
				data.buffer as ArrayBuffer,
				data.byteOffset + start * 4,
				(end - start) * 4,
			);
	}
	public release(): void {
		this.buffer?.destroy();
		this.buffer = null;
		trackCanvas(this.capacity / 4, 0);
		this.capacity = 0;
	}
}

export class GpuMarkBackend implements GpuBackend {
	private readonly buffers: {
		uniform: BufferSlot;
		data: BufferSlot;
		spans: BufferSlot;
		style: BufferSlot;
		bands: BufferSlot;
		ids: BufferSlot;
	};
	private readonly slots: BufferSlot[];
	private readonly params = new Uint32Array(12);
	private readonly style = new Uint32Array(512);
	/** Colors go to the GPU premultiplied, as the page's Canvas 2D premultiplies them (see shaders.ts). */
	private readonly premultiply: Premultiplier;
	/** The palette of the scatter records, and its colors premultiplied. */
	private straight: Uint32Array | null = null;
	private readonly premultiplied = new Uint32Array(PALETTE_SIZE);
	private bounds = new Uint32Array(0);
	private packed = new Uint32Array(0);
	private bands = new PriceBands();
	private heat = new HeatRanges();
	private width = 0;
	private height = 0;
	private gpu: GPUCanvasContext | null = null;
	/**
	 * The image the kernels write, kept between frames: the pane transposed (see shaders.ts). A frame
	 * copies the strip it drew into the canvas's texture, which is configured without storage usage.
	 * Chrome on Android copies the whole texture of a canvas with storage usage into a second one
	 * every time it hands out a new texture (and logs, once, that the canvas's format is not the
	 * preferred one, whatever the format).
	 */
	private image: GPUTexture | null = null;
	private imageView: GPUTextureView | null = null;
	private cache: CanvasRenderingContext2D | null = null;
	private version = -1;
	private revision = -1;
	private projection = '';
	private mapping = '';
	private palette: Uint32Array | null = null;
	private fallback = '';
	/**
	 * Rows `[projectedFrom, projectedTo)` of a scatter's window have records on the GPU, at the
	 * projection, style and colors of the last draw. A pan projects the rows that come into view.
	 */
	private projectedFrom = 0;
	private projectedTo = 0;
	private bandsKey = '';
	/** Whether a heatmap's data holds its palette slots, four to a word, rather than its values. */
	private heatSlots = false;
	/** The slots the data was uploaded from, and its columns that hold them: `[slotsFrom, slotsTo)`. */
	private slotsBuffer: Uint8Array | null = null;
	private slotsFrom = 0;
	private slotsTo = 0;
	private count = 0;
	private pending = Infinity;
	private readonly cssColors = new Map<number, string>();
	private lastPath: GpuPath | null = null;
	private heatPan = new HeatPan();
	/** A grid that follows the price: the column table, the window it was written for, and where. */
	private table = new Uint32Array(0);
	private tableVersion = -1;
	private tableAt = -1;
	/** The grid rows the columns in view spanned when the pixel ranges were made. */
	private span = '';
	/** The kernel of the last dispatch, read by the benchmark harness. */
	public kernel: GpuKernel | null = null;
	public get bytes(): number {
		return this.width * this.height * 12 + this.slots.reduce((n, s) => n + s.capacity, 0);
	}
	private readonly doc: Document;
	private readonly resources: GpuResources;
	constructor(doc: Document, resources: GpuResources) {
		this.doc = doc;
		this.resources = resources;
		this.premultiply = new Premultiplier(doc);
		const buffer = (name: string) => new BufferSlot(resources.device, 'lumen-marks-' + name);
		this.buffers = {
			uniform: new BufferSlot(resources.device, 'lumen-marks-uniform', true),
			data: buffer('data'),
			spans: buffer('spans'),
			style: buffer('style'),
			bands: buffer('bands'),
			ids: buffer('ids'),
		};
		this.slots = Object.values(this.buffers);
	}
	private resize(width: number, height: number): boolean {
		const pixels = width * height;
		if (
			width > this.resources.device.limits.maxTextureDimension2D ||
			height > this.resources.device.limits.maxTextureDimension2D ||
			!canvasFits(Math.max(0, pixels - this.width * this.height) * 3)
		)
			throw new Budget();
		if (width === this.width && height === this.height && this.cache) return false;
		const { device, format } = this.resources;
		if (!this.gpu) {
			const context = this.doc.createElement('canvas').getContext('webgpu');
			this.gpu = context && 'configure' in context ? context : null;
			this.cache = this.doc.createElement('canvas').getContext('2d');
			if (!this.gpu || !this.cache) throw new Error('mark canvas unavailable');
		}
		// Transposed, as the image: the canvas is as wide as the pane is high.
		this.gpu.canvas.width = height;
		this.gpu.canvas.height = width;
		this.gpu.configure({ device, format, alphaMode: 'premultiplied', usage: TEXTURE_COPY_DST });
		this.image?.destroy();
		this.image = device.createTexture({
			label: 'lumen-marks-image',
			size: [height, width],
			format,
			usage: TEXTURE_STORAGE | TEXTURE_COPY_SRC,
		});
		this.imageView = this.image.createView();
		this.cache!.canvas.width = height;
		this.cache!.canvas.height = width;
		trackCanvas(this.width * this.height * 3, pixels * 3);
		this.width = width;
		this.height = height;
		return true;
	}
	public paint(f: MarkFrame, ctx: CanvasRenderingContext2D, full: boolean): GpuPath | 'budget' {
		try {
			return this.draw(f, ctx, full);
		} catch (e) {
			if (!(e instanceof Budget)) throw e;
			this.release();
			return 'budget';
		}
	}
	private appendPatch(f: MarkFrame, size: number): boolean {
		const w = f.window;
		if (
			w.level !== 0 ||
			w.dirtyFrom < this.count ||
			w.dirtyTo <= w.dirtyFrom ||
			w.dirtyTo - w.dirtyFrom > 32 ||
			w.version !== this.version
		)
			return false;
		const options = f.options as ScatterOptions,
			shift = options.barAlign === 'start' ? -f.map.spacing / 2 : 0;
		const fallback = parseColor(options.color) ?? 0;
		const first = Math.max(f.from, w.dirtyFrom),
			end = Math.min(f.to, w.dirtyTo);
		const cache = this.cache!;
		for (let i = first; i < end; i++) {
			const val = w.values[i]!,
				color = val === val ? f.palette[paletteIndex(f.mapping, val)]! : fallback;
			let css = this.cssColors.get(color);
			if (css === undefined) {
				const [r, g, b, a] = unpackColor(color);
				// A fresh GPU strip will replace the entire patch if any color needs alpha.
				if (a !== 255) return false;
				css = `rgb(${r},${g},${b})`;
				if (this.cssColors.size >= 257) this.cssColors.clear();
				this.cssColors.set(color, css);
			}
			const t = w.time[i]!;
			f.map.segment(t);
			const x = Math.round(f.map.x0 + shift + (t - f.map.t0) * f.map.pace) - (size >> 1);
			const price = w.price[i]!,
				y =
					Math.round(f.projection.offset - (f.projection.log ? Math.log10(price) : price) * f.projection.scale) -
					(size >> 1);
			cache.fillStyle = css;
			// Transposed.
			cache.fillRect(y, x, size, size);
		}
		this.pending = Math.min(this.pending, w.dirtyFrom);
		this.count = w.count;
		this.revision = w.revision;
		return true;
	}
	private draw(f: MarkFrame, ctx: CanvasRenderingContext2D, full: boolean): GpuPath {
		const w = f.window;
		const fresh = this.resize(f.width, f.height);
		const scatter = f.type === 'scatter';
		const size = scatter ? Math.max(1, Math.round((f.options as ScatterOptions).pointSize * f.ratio)) : 1;
		const path: GpuPath = scatter ? (fitsTileIndex(f) ? 'scatter-tiles' : 'scatter-columns') : 'heatmap';
		// A heatmap that goes over to its slots, or back to its values, is drawn again from them.
		full ||=
			fresh || this.lastPath !== path || this.version !== w.version || (!scatter && !!f.slots !== this.heatSlots);
		if (!full && scatter && this.revision !== w.revision) this.appendPatch(f, size);
		if (full || this.revision !== w.revision) {
			const { uniform, data, style } = this.buffers;
			const slots = !scatter && !!f.slots;
			// Slots take a quarter of the bytes of values: the data is made again at its size.
			const modeChanged = !scatter && slots !== this.heatSlots;
			if (modeChanged) data.release();
			const newData = data.reserve(
				scatter ? w.capacity * 8 : slots ? Math.ceil(w.cellCapacity / 4) * 4 : w.cellCapacity * 4,
			);
			const mapping = [f.mapping.min, f.mapping.factor, Number(f.mapping.log)].join(',');
			const projection = [f.projection.offset, f.projection.scale, Number(f.projection.log)].join(',');
			const newWindow = newData || this.version !== w.version;
			const mappingChanged = mapping !== this.mapping;
			const styleChanged = mappingChanged || this.palette !== f.palette || modeChanged;
			uniform.reserve(48);
			style.reserve(this.style.byteLength);
			const dirtyFrom = newWindow ? 0 : Math.min(this.pending, w.dirtyFrom),
				dirtyTo = newWindow ? w.count : Math.max(w.dirtyTo, this.pending < Infinity ? this.count : 0);
			const change = { newWindow, styleChanged, mappingChanged, projection, dirtyFrom, dirtyTo };
			const strip = scatter
				? this.prepareScatter(f, path, size, full, change)
				: this.prepareHeatmap(f, full, fresh, change);
			if (strip.right > strip.left) this.dispatch(f, path, size, strip);
			this.pending = Infinity;
			this.count = w.count;
			this.version = w.version;
			this.revision = w.revision;
			this.projection = projection;
			this.mapping = mapping;
			this.palette = f.palette;
			this.lastPath = path;
		}
		if (f.options.opacity > 0) {
			// As the Canvas 2D and WebGL2 paths draw their transposed images: x and y swapped, pixel
			// onto pixel.
			ctx.save();
			ctx.transform(0, 1, 1, 0, 0, 0);
			ctx.imageSmoothingEnabled = false;
			ctx.globalAlpha *= Math.min(1, f.options.opacity);
			ctx.drawImage(this.cache!.canvas, 0, 0);
			ctx.restore();
		}
		return path;
	}
	private prepareScatter(f: MarkFrame, path: GpuPath, size: number, full: boolean, change: Upload): Strip {
		const w = f.window;
		const { spans, bands, ids } = this.buffers;
		const { newWindow, styleChanged, projection, dirtyFrom, dirtyTo } = change;
		let left = 0,
			right = f.width;

		const fallback = (f.options as ScatterOptions).color,
			color = this.premultiply.color(parseColor(fallback) ?? 0);
		const grown = this.packed.length < w.capacity * 2;
		if (grown) this.packed = new Uint32Array(w.capacity * 2);
		const all = grown || newWindow || styleChanged || projection !== this.projection || fallback !== this.fallback;
		// The column kernel reads the rows in view only; the tile index is built from all of them.
		const from = path === 'scatter-tiles' ? 0 : f.from,
			to = path === 'scatter-tiles' ? w.count : f.to;
		if (all || this.projectedTo <= from || to <= this.projectedFrom) {
			const [first, end] = startRows(from, to, w.count);
			this.project(f, first, end, color);
			this.projectedFrom = first;
			this.projectedTo = end;
		} else {
			// A patch can change rows projected before, in view or not.
			this.project(f, Math.max(dirtyFrom, this.projectedFrom), Math.min(dirtyTo, this.projectedTo), color);
			this.project(f, from, this.projectedFrom, color);
			this.project(f, this.projectedTo, to, color);
			this.projectedFrom = Math.min(this.projectedFrom, from);
			this.projectedTo = Math.max(this.projectedTo, to);
		}
		if (this.bounds.length < f.width + size) this.bounds = new Uint32Array(f.width + size);
		scatterBounds(f, size, this.bounds);
		spans.reserve((f.width + size) * 4);
		spans.write(this.bounds, 0, f.width + size);
		if (path === 'scatter-tiles') {
			const key = [w.version, w.revision, f.height, size, projection].join(':');
			if (key !== this.bandsKey || !bands.buffer) {
				this.bands.build(this.packed, w.count, f.height, size);
				const n = Math.ceil(f.height / 16) + 1,
					entries = this.bands.offsets[n - 1]!;
				bands.reserve(n * 4);
				ids.reserve(entries * 4);
				bands.write(this.bands.offsets, 0, n);
				ids.write(this.bands.ids, 0, entries);
				this.bandsKey = key;
			}
		}
		if (!full && w.level === 0 && dirtyTo > dirtyFrom) {
			const shift = (f.options as ScatterOptions).barAlign === 'start' ? -f.map.spacing / 2 : 0;
			left = Math.max(0, Math.floor(f.map.x(w.time[dirtyFrom]!) + shift) - size);
			right = Math.min(f.width, Math.ceil(f.map.x(w.time[dirtyTo - 1]!) + shift) + size + 1);
		}
		this.fallback = fallback;
		return { left, right };
	}
	/** Projects rows `[from, to)` into their records and uploads them. */
	private project(f: MarkFrame, from: number, to: number, fallback: number): void {
		if (to <= from) return;
		if (this.straight !== f.palette) {
			this.premultiplied.set(f.palette);
			this.premultiply.palette(this.premultiplied);
			this.straight = f.palette;
		}
		scatterRecords({ ...f, palette: this.premultiplied }, this.packed, from, to, fallback);
		this.buffers.data.write(this.packed, from * 2, to * 2);
	}
	private prepareHeatmap(f: MarkFrame, full: boolean, fresh: boolean, change: Upload): Strip {
		const w = f.window;
		const { data, spans, style } = this.buffers;
		const { newWindow, styleChanged, projection, dirtyFrom, dirtyTo } = change;
		let left = 0,
			right = f.width;

		const slots = f.slots ?? null;
		if (slots) {
			this.uploadSlots(f, slots, change);
		} else {
			data.write(w.values, w.cellStart(dirtyFrom), w.cellStart(dirtyTo));
			this.slotsBuffer = null;
		}
		this.heatSlots = slots !== null;
		if (styleChanged || newWindow || fresh) {
			// Slots need their colors only; values the first value of each slot too.
			if (slots) slotColors(f.palette, this.style);
			else heatStyle(f.palette, f.mapping, this.style);
			this.premultiply.palette(this.style);
			style.write(this.style, 0, slots ? 256 : 512);
		}
		const n = (f.width + f.height) * 2;
		const varying = w.varying;
		const rebound = spans.reserve((n + (varying ? w.capacity * 3 : 0)) * 4);
		if (varying) this.uploadTable(f, n, rebound || newWindow || fresh || this.tableAt !== n, dirtyFrom, dirtyTo);
		this.tableAt = varying ? n : -1;
		// Where the grid follows the price, the rows a pixel row reads change with the rows in view.
		let span = '';
		if (varying) {
			heatRowSpan(w, f.from, f.to, SPAN);
			span = `${SPAN.low},${SPAN.high}`;
		}
		if (
			!full &&
			!fresh &&
			!newWindow &&
			!rebound &&
			span === this.span &&
			this.count === w.count &&
			dirtyFrom === w.count - 1 &&
			dirtyTo === w.count
		) {
			left = Math.max(0, Math.min(f.width, heatEdge(w.time, w.count, dirtyFrom, f.map)));
			right = Math.max(left, Math.min(f.width, heatEdge(w.time, w.count, dirtyTo, f.map)));
			return { left, right };
		}
		this.heat.project(f);
		this.span = span;
		spans.write(this.heat.data, 0, n);
		if (!full && dirtyTo > dirtyFrom) {
			left = Math.max(
				0,
				Math.min(f.width, Math.round(f.map.x(w.time[Math.max(0, dirtyFrom - 1)]!) - f.map.spacing / 2)),
			);
		}
		// Reuse an integer pan only if every overlapping source range still matches.
		const anchor = f.map.x(w.time[0]!);
		const delta = this.heatPan.translation(
			anchor,
			this.heat.data,
			f.width,
			f.height,
			!fresh && !newWindow && !styleChanged && this.revision === w.revision && projection === this.projection,
			this.heat.rowBase,
		);
		if (delta !== null) {
			if (delta !== 0) {
				const cache = this.cache!;
				cache.save();
				cache.globalCompositeOperation = 'copy';
				// Transposed: the pane's columns are the image's rows.
				cache.drawImage(cache.canvas, 0, delta);
				cache.restore();
			}
			if (delta >= 0) right = delta;
			else left = f.width + delta;
		}
		return { left, right };
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
		this.buffers.spans.write(table, from * 3, to * 3, at + from * 3);
	}
	/**
	 * Uploads the slots of the columns in view that the data lacks, and of those a patch changed.
	 * The data holds the slots of columns `[slotsFrom, slotsTo)`, a range that grows with the view
	 * and starts over when the view leaves it: a pan uploads the columns that come into view.
	 */
	private uploadSlots(f: MarkFrame, slots: HeatSlots, change: Upload): void {
		const w = f.window,
			data = this.buffers.data;
		const cells = slots.update(f.from, f.to);
		const fresh =
			change.newWindow ||
			change.mappingChanged ||
			cells !== this.slotsBuffer ||
			!slots.holds(this.slotsFrom, this.slotsTo);
		const words = new Uint32Array(cells.buffer, cells.byteOffset, cells.length >> 2);
		const upload = (from: number, to: number) => {
			if (to > from) data.write(words, Math.floor(w.cellStart(from) / 4), Math.ceil(w.cellStart(to) / 4));
		};
		if (fresh || f.to <= this.slotsFrom || f.from >= this.slotsTo) {
			upload(f.from, f.to);
			this.slotsFrom = f.from;
			this.slotsTo = f.to;
		} else {
			upload(Math.max(change.dirtyFrom, this.slotsFrom), Math.min(change.dirtyTo, this.slotsTo));
			if (f.from < this.slotsFrom) upload(f.from, this.slotsFrom);
			if (f.to > this.slotsTo) upload(this.slotsTo, f.to);
			this.slotsFrom = Math.min(this.slotsFrom, f.from);
			this.slotsTo = Math.max(this.slotsTo, f.to);
		}
		this.slotsBuffer = cells;
	}
	private dispatch(f: MarkFrame, path: GpuPath, size: number, { left, right }: Strip): void {
		const w = f.window,
			device = this.resources.device;
		const { uniform, data, spans, style, bands, ids } = this.buffers;

		const table = path === 'heatmap' && w.varying ? this.tableAt : 0xffffffff;
		this.params.set([f.width, f.height, left, right, size, w.rows, 0, 0, table, this.heat.rowBase + 0x40000000, 0, 0]);
		uniform.write(this.params);
		const kernel: GpuKernel =
			path === 'scatter-columns' && size >= WIDE_COLUMNS && left === 0 && right === f.width
				? 'scatter-columns-wide'
				: path === 'heatmap' && this.heatSlots
					? 'heatmap-slots'
					: path;
		this.kernel = kernel;
		const pipeline = this.resources.pipelines[kernel];
		const entries: GPUBindGroupEntry[] = [
			{ binding: 0, resource: { buffer: uniform.buffer! } },
			{ binding: 1, resource: { buffer: data.buffer! } },
			{ binding: 2, resource: { buffer: spans.buffer! } },
			{ binding: 4, resource: this.imageView! },
		];
		if (path === 'heatmap') entries.push({ binding: 3, resource: { buffer: style.buffer! } });
		if (path === 'scatter-tiles')
			entries.push(
				{ binding: 5, resource: { buffer: bands.buffer! } },
				{ binding: 6, resource: { buffer: ids.buffer! } },
			);
		const encoder = device.createCommandEncoder();
		const pass = encoder.beginComputePass({ label: 'lumen-marks' });
		pass.setPipeline(pipeline);
		pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }));
		if (path === 'heatmap')
			// Pixel rows across the first dimension: neighboring invocations read neighboring cells
			// of a column and store neighboring texels of the transposed image.
			pass.dispatchWorkgroups(Math.ceil(f.height / 8), Math.ceil((right - left) / 8));
		else {
			const stride = path === 'scatter-tiles' ? 16 : 1;
			pass.dispatchWorkgroups(
				Math.ceil((right - left) / stride),
				Math.ceil(f.height / (path === 'scatter-columns' ? 1024 : stride)),
			);
		}
		pass.end();
		// The strip drawn, from the image into the canvas: rows `[left, right)` of both.
		const width = right - left;
		encoder.copyTextureToTexture(
			{ texture: this.image!, origin: { x: 0, y: left } },
			{ texture: this.gpu!.getCurrentTexture(), origin: { x: 0, y: left } },
			{ width: f.height, height: width },
		);
		device.queue.submit([encoder.finish()]);
		const cache = this.cache!;
		cache.clearRect(0, left, f.height, width);
		cache.drawImage(this.gpu!.canvas, 0, left, f.height, width, 0, left, f.height, width);
	}
	public release(): void {
		for (const slot of this.slots) slot.release();
		this.image?.destroy();
		this.image = null;
		this.imageView = null;
		this.gpu?.unconfigure();
		if (this.gpu) {
			this.gpu.canvas.width = 1;
			this.gpu.canvas.height = 1;
		}
		if (this.cache) {
			this.cache.canvas.width = 1;
			this.cache.canvas.height = 1;
		}
		trackCanvas(this.width * this.height * 3, 0);
		this.width = 0;
		this.height = 0;
		this.gpu = null;
		this.cache = null;
		this.pending = Infinity;
		this.count = 0;
		this.lastPath = null;
		this.kernel = null;
		this.palette = null;
		this.version = -1;
		this.bandsKey = '';
		this.heatSlots = false;
		this.slotsBuffer = null;
		this.projectedFrom = 0;
		this.projectedTo = 0;
		this.heatPan = new HeatPan();
		this.packed = new Uint32Array(0);

		this.bounds = new Uint32Array(0);
		this.bands = new PriceBands();
		this.heat = new HeatRanges();
		this.tableVersion = -1;
		this.tableAt = -1;
		this.span = '';
	}
}
