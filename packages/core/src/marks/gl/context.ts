import { canvasFits, trackCanvas } from '../../shared/canvas-budget';
import { Premultiplier } from '../premultiply';
import {
	densityColorFragment,
	densityFragment,
	heatFragment,
	heatSlotsFragment,
	heatVertex,
	reduceFragment,
	scatterFragment,
	scatterVertex,
} from './shaders';

/**
 * The programs: a scatter, its densities summed, their largest found tile by tile, and colored; a
 * heatmap from its values, a heatmap from its palette slots.
 */
export type GlProgramKind =
	| 'scatter'
	| 'scatter-density'
	| 'density-reduce'
	| 'density-color'
	| 'heatmap'
	| 'heatmap-slots';
const SOURCES: Record<GlProgramKind, [string, string]> = {
	scatter: [scatterVertex, scatterFragment],
	'scatter-density': [scatterVertex, densityFragment],
	'density-reduce': [heatVertex, reduceFragment],
	'density-color': [heatVertex, densityColorFragment],
	heatmap: [heatVertex, heatFragment],
	'heatmap-slots': [heatVertex, heatSlotsFragment],
};

export class GlBudget extends Error {}
/** The context cannot draw what was asked (a scatter's densities without float blending). */
export class GlUnsupported extends Error {}

function program(gl: WebGL2RenderingContext, vertex: string, fragment: string) {
	const p = gl.createProgram();
	if (!p) throw new Error('WebGL2 program unavailable');
	const shaders: WebGLShader[] = [];
	try {
		for (const [type, source] of [
			[gl.VERTEX_SHADER, vertex],
			[gl.FRAGMENT_SHADER, fragment],
		] as const) {
			const shader = gl.createShader(type);
			if (!shader) throw new Error('WebGL2 shader unavailable');
			shaders.push(shader);
			gl.shaderSource(shader, source);
			gl.compileShader(shader);
			gl.attachShader(p, shader);
		}
		gl.linkProgram(p);
		if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'WebGL2 link failed');
		const location = (name: string) => gl.getUniformLocation(p, name);
		gl.useProgram(p);
		for (const [unit, name] of ['records', 'ranges', 'style', 'density', 'peak'].entries())
			gl.uniform1i(location(name), unit);
		return {
			p,
			pane: location('pane'),
			first: location('first'),
			stamp: location('stamp'),
			guard: location('guard'),
			base: location('base'),
			recordWords: location('recordWords'),
			circle: location('circle'),
			extent: location('extent'),
			tile: location('tile'),
			exact: location('exact'),
			rows: location('rows'),
			table: location('table'),
			rowBase: location('rowBase'),
			recordsStride: location('recordsStride'),
			rangesStride: location('rangesStride'),
			styleStride: location('styleStride'),
		};
	} catch (error) {
		gl.deleteProgram(p);
		throw error;
	} finally {
		for (const shader of shaders) gl.deleteShader(shader);
	}
}

export type GlProgram = ReturnType<typeof program>;

// A page can contain many mark series. They take turns drawing on one GL canvas,
// then copy their result to their own cached image before the next series draws.
const pools = new WeakMap<Document, GlContext>();
export class GlContext {
	private readonly listeners = new Map<() => void, { width: number; height: number }>();
	private readonly programs = new Map<GlProgramKind, ReturnType<typeof program>>();
	public readonly limit: number;
	private pixels = 0;
	/** Premultiplies the colors uploaded as the document's Canvas 2D does. */
	public readonly premultiply: Premultiplier;
	/** The largest point sprite and viewport the context draws; null until asked. */
	private _pointLimits: { point: number; width: number; height: number } | null = null;
	/** Whether 32-bit float targets can be drawn and blended into; null until asked. */
	private _floatBlend: boolean | null = null;
	private corners: WebGLBuffer | null = null;
	private constructor(
		private doc: Document,
		public canvas: HTMLCanvasElement,
		public gl: WebGL2RenderingContext,
	) {
		this.limit = gl.getParameter(gl.MAX_TEXTURE_SIZE);
		this.premultiply = new Premultiplier(doc);
		canvas.addEventListener('webglcontextlost', this.change);
		canvas.addEventListener('webglcontextrestored', this.change);
	}
	static acquire(doc: Document, listener: () => void): GlContext | null {
		let pool = pools.get(doc);
		if (!pool) {
			const canvas = doc.createElement('canvas');
			canvas.width = canvas.height = 1;
			// Premultiplied, as the colors the shaders write are (see marks/premultiply.ts).
			const gl = canvas.getContext('webgl2', {
				alpha: true,
				antialias: false,
				depth: false,
				stencil: false,
				premultipliedAlpha: true,
			});
			if (!gl || typeof gl.createProgram !== 'function') return null;
			pool = new GlContext(doc, canvas, gl);
			pools.set(doc, pool);
		}
		pool.listeners.set(listener, { width: 0, height: 0 });
		return pool;
	}
	private readonly change = (event: Event) => {
		event.preventDefault();
		this.programs.clear();
		// A restored context has its extensions to enable again.
		this._floatBlend = null;
		this._pointLimits = null;
		this.corners = null;
		trackCanvas(this.pixels, 0);
		this.pixels = 0;
		for (const listener of this.listeners.keys()) listener();
	};
	private preferredSize() {
		let width = 1,
			height = 1;
		for (const size of this.listeners.values()) {
			width = Math.max(width, size.width);
			height = Math.max(height, size.height);
		}
		return { width, height };
	}

	private resize(width: number, height: number) {
		// Shrink first when one dimension grows and the other shrinks.
		if (height < this.canvas.height) this.canvas.height = height;
		if (width !== this.canvas.width) this.canvas.width = width;
		if (height !== this.canvas.height) this.canvas.height = height;
		trackCanvas(this.pixels, width * height);
		this.pixels = width * height;
	}

	begin(listener: () => void, type: GlProgramKind, width: number, height: number) {
		if (width > this.limit || height > this.limit) throw new GlBudget();
		const size = this.listeners.get(listener)!;
		if (
			size.width !== width ||
			size.height !== height ||
			this.canvas.width < width ||
			this.canvas.height < height ||
			!this.pixels ||
			!canvasFits(0)
		) {
			size.width = width;
			size.height = height;
			const preferred = this.preferredSize();
			if (canvasFits(preferred.width * preferred.height - this.pixels)) this.resize(preferred.width, preferred.height);
			else if (canvasFits(width * height - this.pixels)) this.resize(width, height);
			else throw new GlBudget();
		}
		const gl = this.gl;
		if (gl.drawingBufferWidth < width || gl.drawingBufferHeight < height) throw new GlBudget();
		// A real attribute at location zero also avoids desktop GL's emulated vertex buffer.
		if (!this.corners) {
			this.corners = gl.createBuffer();
			if (!this.corners) throw new GlBudget();
			gl.bindBuffer(gl.ARRAY_BUFFER, this.corners);
			gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
			gl.vertexAttribPointer(0, 2, gl.UNSIGNED_BYTE, false, 0, 0);
			gl.enableVertexAttribArray(0);
		}
		gl.disable(gl.DITHER);
		return this.use(type, width, height);
	}
	/** Makes a program current, drawing `width` by `height` pixels of the framebuffer bound. */
	use(type: GlProgramKind, width: number, height: number) {
		const gl = this.gl;
		let pipeline = this.programs.get(type);
		if (!pipeline) {
			pipeline = program(gl, ...SOURCES[type]);
			this.programs.set(type, pipeline);
		}
		gl.useProgram(pipeline.p);
		gl.viewport(0, 0, width, height);
		gl.uniform2i(pipeline.pane, width, height);
		return pipeline;
	}
	/**
	 * Whether a scatter's densities can be summed here: drawn into a 32-bit float texture
	 * (EXT_color_buffer_float) with blending (EXT_float_blend). Half floats would hold whole numbers
	 * only up to 2048, so there is no lesser format to fall back to.
	 */
	floatBlend(): boolean {
		if (this._floatBlend === null) {
			const gl = this.gl;
			this._floatBlend = !!gl.getExtension('EXT_color_buffer_float') && !!gl.getExtension('EXT_float_blend');
		}
		return this._floatBlend;
	}
	/**
	 * How far beyond a `width` by `height` pane the viewport reaches when a scatter's points of at
	 * most `size` device pixels are drawn as point sprites (see `scatterVertex`): `size`, or 0 to draw
	 * them as quads, where the context's sprites or viewports are not that large.
	 */
	pointGuard(size: number, width: number, height: number): number {
		if (this._pointLimits === null) {
			const gl = this.gl;
			const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array | null;
			const dims = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array | null;
			this._pointLimits = { point: range?.[1] ?? 0, width: dims?.[0] ?? 0, height: dims?.[1] ?? 0 };
		}
		const { point, width: maxWidth, height: maxHeight } = this._pointLimits;
		return size <= point && width + 2 * size <= maxWidth && height + 2 * size <= maxHeight ? size : 0;
	}
	/**
	 * Draws `count` scatter points of the current program into a `width` by `height` pane: point
	 * sprites, one vertex each, in a viewport `guard` pixels larger on each side (see `pointGuard`),
	 * or instances of a four-corner quad.
	 *
	 * The sprites are drawn without instancing: on the M1 (ANGLE on Metal), a million instances of one
	 * vertex took twice as long as a million instanced quads, and a million vertices a quarter of it.
	 * The corner attribute stays bound for the quads, read once per instance (a divisor of 1) so that
	 * a draw of more vertices than its buffer holds is valid.
	 */
	drawScatter(guard: number, width: number, height: number, count: number) {
		const gl = this.gl;
		if (guard > 0) {
			gl.vertexAttribDivisor(0, 1);
			gl.viewport(-guard, -guard, width + 2 * guard, height + 2 * guard);
			gl.drawArrays(gl.POINTS, 0, count);
			gl.viewport(0, 0, width, height);
			gl.vertexAttribDivisor(0, 0);
		} else gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
	}
	/** Float targets turned out not to work (an incomplete framebuffer): densities go to Canvas 2D. */
	noFloatBlend() {
		this._floatBlend = false;
	}
	release(listener: () => void) {
		if (!this.listeners.delete(listener)) return;
		if (this.listeners.size) {
			const size = this.preferredSize();
			if (this.pixels) this.resize(Math.min(size.width, this.canvas.width), Math.min(size.height, this.canvas.height));
			return;
		}
		pools.delete(this.doc);
		this.canvas.removeEventListener('webglcontextlost', this.change);
		this.canvas.removeEventListener('webglcontextrestored', this.change);
		this.gl.deleteBuffer(this.corners);
		for (const { p } of this.programs.values()) this.gl.deleteProgram(p);
		this.canvas.width = this.canvas.height = 1;
		trackCanvas(this.pixels, 0);
		this.gl.getExtension('WEBGL_lose_context')?.loseContext();
	}
}
