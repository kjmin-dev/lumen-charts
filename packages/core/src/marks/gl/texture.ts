import { canvasFits, trackCanvas } from '../../shared/canvas-budget';
import { GlBudget, type GlContext } from './context';

// Linear uint32 storage. Split a dirty upload into at most three rectangles
// (first partial row, complete rows, last partial row).
export class WordTexture {
	private texture: WebGLTexture | null = null;
	private stride = 0;
	public words = 0;
	constructor(
		private pool: GlContext,
		private unit: number,
	) {}
	bind(count: number): boolean {
		const { gl, limit } = this.pool;
		gl.activeTexture(gl.TEXTURE0 + this.unit);
		if (this.texture && count <= this.words) {
			gl.bindTexture(gl.TEXTURE_2D, this.texture);
			return false;
		}
		const width = Math.min(Math.max(1, count), limit, 2048);
		const height = Math.max(1, Math.ceil(count / width));
		if (height > limit || !canvasFits(width * height - this.words)) throw new GlBudget();
		this.release();
		this.texture = gl.createTexture();
		if (!this.texture) throw new GlBudget();
		gl.bindTexture(gl.TEXTURE_2D, this.texture);
		gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32UI, width, height);
		if (gl.getError() !== gl.NO_ERROR) throw new GlBudget();
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		this.stride = width;
		this.words = width * height;
		trackCanvas(0, this.words);
		return true;
	}
	write(data: Uint32Array<ArrayBuffer>, from: number, to: number) {
		const gl = this.pool.gl;
		while (from < to) {
			const x = from % this.stride;
			const width = Math.min(this.stride - x, to - from);
			const height = width === this.stride ? Math.floor((to - from) / width) : 1;
			gl.texSubImage2D(
				gl.TEXTURE_2D,
				0,
				x,
				Math.floor(from / this.stride),
				width,
				height,
				gl.RED_INTEGER,
				gl.UNSIGNED_INT,
				data,
				from,
			);
			from += width * height;
		}
	}
	release() {
		this.pool.gl.deleteTexture(this.texture);
		this.texture = null;
		trackCanvas(this.words, 0);
		this.words = 0;
	}
}
