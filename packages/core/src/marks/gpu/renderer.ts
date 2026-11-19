import { HeatRanges, HeatPan } from '../heat-ranges';
import { canvasFits, trackCanvas } from '../../shared/canvas-budget';
import type { GpuBackend, MarkFrame } from '../backend';
import type { ScatterOptions } from '../options';
import { parseColor, paletteIndex, unpackColor } from '../palette';
import type { GpuPath, GpuResources } from './device';
import { heatStyle, PriceBands, scatterBounds, scatterRecords, fitsTileIndex } from './geometry';

// WebGPU IDL flag values. The DOM declarations shipped by the supported TypeScript
// compilers agree on the interfaces but differ on these global flag namespaces.
const BUFFER_COPY_DST = 0x08,
	BUFFER_UNIFORM = 0x40,
	BUFFER_STORAGE = 0x80;
const TEXTURE_STORAGE = 0x08,
	TEXTURE_ATTACHMENT = 0x10;
class Budget extends Error {}

interface Upload {
	newWindow: boolean;
	styleChanged: boolean;
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
	constructor(device: GPUDevice, uniform = false) {
		this.device = device;
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
			size: bytes,
			usage: BUFFER_COPY_DST | (this.uniform ? BUFFER_UNIFORM : BUFFER_STORAGE),
		});
		this.buffer?.destroy();
		trackCanvas(this.capacity / 4, bytes / 4);
		this.buffer = buffer;
		this.capacity = bytes;
		return true;
	}
	public write(data: Uint32Array | Float32Array, start = 0, end = data.length): void {
		if (end > start)
			this.device.queue.writeBuffer(
				this.buffer!,
				start * 4,
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
	private readonly params = new Uint32Array(8);
	private readonly style = new Uint32Array(512);
	private bounds = new Uint32Array(0);
	private packed = new Uint32Array(0);
	private bands = new PriceBands();
	private heat = new HeatRanges();
	private width = 0;
	private height = 0;
	private gpu: GPUCanvasContext | null = null;
	private cache: CanvasRenderingContext2D | null = null;
	private version = -1;
	private revision = -1;
	private projection = '';
	private mapping = '';
	private palette: Uint32Array | null = null;
	private fallback = '';
	private bandsKey = '';
	private count = 0;
	private pending = Infinity;
	private readonly cssColors = new Map<number, string>();
	private lastPath: GpuPath | null = null;
	private heatPan = new HeatPan();
	public get bytes(): number {
		return this.width * this.height * 8 + this.slots.reduce((n, s) => n + s.capacity, 0);
	}
	private readonly doc: Document;
	private readonly resources: GpuResources;
	constructor(doc: Document, resources: GpuResources) {
		this.doc = doc;
		this.resources = resources;
		const buffer = () => new BufferSlot(resources.device);
		this.buffers = {
			uniform: new BufferSlot(resources.device, true),
			data: buffer(),
			spans: buffer(),
			style: buffer(),
			bands: buffer(),
			ids: buffer(),
		};
		this.slots = Object.values(this.buffers);
	}
	private resize(width: number, height: number): boolean {
		const pixels = width * height;
		if (
			width > this.resources.device.limits.maxTextureDimension2D ||
			height > this.resources.device.limits.maxTextureDimension2D ||
			!canvasFits(Math.max(0, pixels - this.width * this.height) * 2)
		)
			throw new Budget();
		if (width === this.width && height === this.height && this.cache) return false;
		if (!this.gpu) {
			const context = this.doc.createElement('canvas').getContext('webgpu');
			this.gpu = context && 'configure' in context ? context : null;
			this.cache = this.doc.createElement('canvas').getContext('2d');
			if (!this.gpu || !this.cache) throw new Error('mark canvas unavailable');
		}
		this.gpu.canvas.width = width;
		this.gpu.canvas.height = height;
		this.gpu.configure({
			device: this.resources.device,
			format: this.resources.format,
			alphaMode: 'premultiplied',
			usage: TEXTURE_STORAGE | TEXTURE_ATTACHMENT,
		});
		this.cache!.canvas.width = width;
		this.cache!.canvas.height = height;
		trackCanvas(this.width * this.height * 2, pixels * 2);
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
			cache.fillRect(x, y, size, size);
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
		full ||= fresh || this.lastPath !== path || this.version !== w.version;
		if (!full && scatter && this.revision !== w.revision) this.appendPatch(f, size);
		if (full || this.revision !== w.revision) {
			const { uniform, data, style } = this.buffers;
			const newData = data.reserve(scatter ? w.capacity * 8 : w.capacity * w.rows * 4);
			const mapping = [f.mapping.min, f.mapping.factor, Number(f.mapping.log)].join(',');
			const projection = [f.projection.offset, f.projection.scale, Number(f.projection.log)].join(',');
			const newWindow = newData || this.version !== w.version;
			const styleChanged = mapping !== this.mapping || this.palette !== f.palette;
			uniform.reserve(32);
			style.reserve(this.style.byteLength);
			const dirtyFrom = newWindow ? 0 : Math.min(this.pending, w.dirtyFrom),
				dirtyTo = newWindow ? w.count : Math.max(w.dirtyTo, this.pending < Infinity ? this.count : 0);
			const change = { newWindow, styleChanged, projection, dirtyFrom, dirtyTo };
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
		ctx.save();
		ctx.globalAlpha *= Math.min(1, f.options.opacity);
		ctx.drawImage(this.cache!.canvas, 0, 0);
		ctx.restore();
		return path;
	}
	private prepareScatter(f: MarkFrame, path: GpuPath, size: number, full: boolean, change: Upload): Strip {
		const w = f.window;
		const { data, spans, bands, ids } = this.buffers;
		const { newWindow, styleChanged, projection, dirtyFrom, dirtyTo } = change;
		let left = 0,
			right = f.width;

		const fallback = (f.options as ScatterOptions).color;
		const all = newWindow || styleChanged || projection !== this.projection || fallback !== this.fallback;
		const from = all ? 0 : dirtyFrom,
			to = all ? w.count : dirtyTo;
		if (this.packed.length < w.capacity * 2) this.packed = new Uint32Array(w.capacity * 2);
		if (to > from) {
			scatterRecords(f, this.packed, from, to, parseColor(fallback) ?? 0);
			data.write(this.packed, from * 2, to * 2);
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
	private prepareHeatmap(f: MarkFrame, full: boolean, fresh: boolean, change: Upload): Strip {
		const w = f.window;
		const { data, spans, style } = this.buffers;
		const { newWindow, styleChanged, projection, dirtyFrom, dirtyTo } = change;
		let left = 0,
			right = f.width;

		data.write(w.values, dirtyFrom * w.rows, dirtyTo * w.rows);
		if (styleChanged || newWindow || fresh) {
			heatStyle(f.palette, f.mapping, this.style);
			style.write(this.style);
		}
		this.heat.project(f);
		const n = (f.width + f.height) * 2;
		spans.reserve(n * 4);
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
		);
		if (delta !== null) {
			if (delta !== 0) {
				const cache = this.cache!;
				cache.save();
				cache.globalCompositeOperation = 'copy';
				cache.drawImage(cache.canvas, delta, 0);
				cache.restore();
			}
			if (delta >= 0) right = delta;
			else left = f.width + delta;
		}
		return { left, right };
	}
	private dispatch(f: MarkFrame, path: GpuPath, size: number, { left, right }: Strip): void {
		const w = f.window,
			device = this.resources.device;
		const { uniform, data, spans, style, bands, ids } = this.buffers;

		this.params.set([f.width, f.height, left, right, size, w.rows, 0, 0]);
		uniform.write(this.params);
		const pipeline = this.resources.pipelines[path];
		const entries: GPUBindGroupEntry[] = [
			{ binding: 0, resource: { buffer: uniform.buffer! } },
			{ binding: 1, resource: { buffer: data.buffer! } },
			{ binding: 2, resource: { buffer: spans.buffer! } },
			{ binding: 4, resource: this.gpu!.getCurrentTexture().createView() },
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
		const stride = path === 'heatmap' ? 8 : path === 'scatter-tiles' ? 16 : 1;
		pass.dispatchWorkgroups(
			Math.ceil((right - left) / stride),
			Math.ceil(f.height / (path === 'scatter-columns' ? 1024 : stride)),
		);
		pass.end();
		device.queue.submit([encoder.finish()]);
		const cache = this.cache!;
		cache.clearRect(left, 0, right - left, f.height);
		cache.drawImage(this.gpu!.canvas, left, 0, right - left, f.height, left, 0, right - left, f.height);
	}
	public release(): void {
		for (const slot of this.slots) slot.release();
		this.gpu?.unconfigure();
		if (this.gpu) {
			this.gpu.canvas.width = 1;
			this.gpu.canvas.height = 1;
		}
		if (this.cache) {
			this.cache.canvas.width = 1;
			this.cache.canvas.height = 1;
		}
		trackCanvas(this.width * this.height * 2, 0);
		this.width = 0;
		this.height = 0;
		this.gpu = null;
		this.cache = null;
		this.pending = Infinity;
		this.count = 0;
		this.lastPath = null;
		this.palette = null;
		this.version = -1;
		this.bandsKey = '';
		this.heatPan = new HeatPan();
		this.packed = new Uint32Array(0);

		this.bounds = new Uint32Array(0);
		this.bands = new PriceBands();
		this.heat = new HeatRanges();
	}
}
