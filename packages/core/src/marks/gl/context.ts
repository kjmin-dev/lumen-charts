import { canvasFits, trackCanvas } from '../../shared/canvas-budget';
import type { MarkSeriesType } from '../options';
import { heatFragment, heatVertex, scatterFragment, scatterVertex } from './shaders';

export class GlBudget extends Error {}

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
		for (const [unit, name] of ['records', 'ranges', 'style'].entries()) gl.uniform1i(location(name), unit);
		return {
			p,
			pane: location('pane'),
			first: location('first'),
			stamp: location('stamp'),
			circle: location('circle'),
			rows: location('rows'),
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
	private readonly programs = new Map<MarkSeriesType, ReturnType<typeof program>>();
	public readonly limit: number;
	private pixels = 0;
	private corners: WebGLBuffer | null = null;
	private constructor(
		private doc: Document,
		public canvas: HTMLCanvasElement,
		public gl: WebGL2RenderingContext,
	) {
		this.limit = gl.getParameter(gl.MAX_TEXTURE_SIZE);
		canvas.addEventListener('webglcontextlost', this.change);
		canvas.addEventListener('webglcontextrestored', this.change);
	}
	static acquire(doc: Document, listener: () => void): GlContext | null {
		let pool = pools.get(doc);
		if (!pool) {
			const canvas = doc.createElement('canvas');
			canvas.width = canvas.height = 1;
			const gl = canvas.getContext('webgl2', {
				alpha: true,
				antialias: false,
				depth: false,
				stencil: false,
				premultipliedAlpha: false,
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

	begin(listener: () => void, type: MarkSeriesType, width: number, height: number) {
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
		let pipeline = this.programs.get(type);
		if (!pipeline) {
			pipeline =
				type === 'scatter' ? program(gl, scatterVertex, scatterFragment) : program(gl, heatVertex, heatFragment);
			this.programs.set(type, pipeline);
		}
		gl.useProgram(pipeline.p);
		gl.disable(gl.DITHER);
		gl.viewport(0, 0, width, height);
		gl.uniform2i(pipeline.pane, width, height);
		return pipeline;
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
