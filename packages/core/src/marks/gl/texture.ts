import { canvasFits, trackCanvas } from '../../shared/canvas-budget';
import { GlBudget, type GlContext } from './context';

/** Widest row of a word texture: a power of two, as every row width is. */
const MAX_STRIDE = 2048;

// Linear uint32 storage. Rows are a power of two wide, so shaders find word `i` at
// (i & mask, i >> shift) without a division. Split a dirty upload into at most three
// rectangles (first partial row, complete rows, last partial row).
export class WordTexture {
	private texture: WebGLTexture | null = null;
	/** Log2 of the row width. */
	public shift = 0;
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
		let shift = 0;
		while (1 << shift < count && 2 << shift <= Math.min(limit, MAX_STRIDE)) shift++;
		const width = 1 << shift;
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
		this.shift = shift;
		this.words = width * height;
		trackCanvas(0, this.words);
		return true;
	}
	/** Sets the program's `ivec2` of this texture: log2 of the row width, and the row width less one. */
	layout(location: WebGLUniformLocation | null) {
		this.pool.gl.uniform2i(location, this.shift, (1 << this.shift) - 1);
	}
	/** Uploads words `[from, to)` of `data` to the texture's words from `at` on (where they are in `data`, by default). */
	write(data: Uint32Array<ArrayBuffer>, from: number, to: number, at = from) {
		const gl = this.pool.gl;
		const stride = 1 << this.shift;
		let target = at;
		while (from < to) {
			const x = target & (stride - 1);
			const width = Math.min(stride - x, to - from);
			const height = width === stride ? Math.floor((to - from) / width) : 1;
			gl.texSubImage2D(
				gl.TEXTURE_2D,
				0,
				x,
				Math.floor(target / stride),
				width,
				height,
				gl.RED_INTEGER,
				gl.UNSIGNED_INT,
				data,
				from,
			);
			from += width * height;
			target += width * height;
		}
	}
	release() {
		this.pool.gl.deleteTexture(this.texture);
		this.texture = null;
		trackCanvas(this.words, 0);
		this.words = 0;
	}
}
