import { canvasFits, trackCanvas } from '../../shared/canvas-budget';
import type { MarkFrame } from '../backend';
import type { ScatterOptions } from '../options';
import { PALETTE_SIZE, type ValueMapping, setValueMapping } from '../palette';
import { MAX_POINT_PIXELS } from '../render';
import { DensityScale, exactDensities } from '../scatter-style';
import { GlBudget, type GlContext, type GlProgram, GlUnsupported } from './context';
import { WordTexture } from './texture';

/** Texels of the level below that one texel of a reduction pass takes the largest of, across and down. */
const TILE = 16;

/** Rows further above or below the pane than this are as far as a record says. */
const ROW_LIMIT = 0x3fffffff;

/**
 * The records of scatter rows that have sizes of their own or are summed as densities: per row the
 * pixel row of its center, then its color or, for densities, its count as a float (written through
 * `floats`, a view of `packed`'s buffer), then with `words` 3 its width in device pixels (0 for the
 * series' size, which the shader takes from a uniform, so a change of `pointSize` uploads nothing).
 * Rows without either keep the two words of `scatterRecords`, which the WebGPU renderer shares.
 *
 * Every row of a new window is packed in the frame it arrives, a million or more: the loop holds no
 * call and no store through another view than `floats`, and its branches on the kind of record are
 * the same for every row.
 */
export function packScatterRows(
	f: MarkFrame,
	packed: Uint32Array,
	floats: Float32Array,
	from: number,
	to: number,
	fallback: number,
	words: number,
	density: boolean,
): void {
	const { window: w, projection: p, palette, mapping, ratio } = f;
	const prices = w.price;
	const values = w.values;
	const sizes = w.sizes;
	const counts = w.counts;
	const counted = counts.length > 0;
	const sized = words > 2;
	const { offset, scale, log } = p;
	const valueMin = mapping.min;
	const factor = mapping.factor;
	const valueLog = mapping.log;
	const top = PALETTE_SIZE - 1;
	for (let i = from, at = from * words; i < to; i++, at += words) {
		const price = prices[i]!;
		const y = Math.round(offset - (log ? Math.log10(price) : price) * scale);
		packed[at] = y === y ? (y > ROW_LIMIT ? ROW_LIMIT : y < -ROW_LIMIT ? -ROW_LIMIT : y) : ROW_LIMIT;
		if (density) {
			floats[at + 1] = counted ? counts[i]! : 1;
		} else {
			// As `paletteIndex`, written out.
			const v = values[i]!;
			if (v === v) {
				const index = ((valueLog ? (v > 0 ? Math.log10(v) : -Infinity) : v) - valueMin) * factor + 0.5;
				packed[at + 1] = palette[index >= top ? top : index > 0 ? index | 0 : 0]!;
			} else {
				packed[at + 1] = fallback;
			}
		}
		if (sized) {
			// As `pointPixels`, written out; 0 for the series' size.
			const css = sizes[i]!;
			const size = Math.round(css * ratio);
			packed[at + 2] = css === css ? (size >= 1 ? (size <= MAX_POINT_PIXELS ? size : MAX_POINT_PIXELS) : 1) : 0;
		}
	}
}

interface Target {
	texture: WebGLTexture;
	framebuffer: WebGLFramebuffer;
	width: number;
	height: number;
}

/**
 * The densities of a scatter on WebGL2 (`colorBy: 'density'`), in three passes:
 *
 * 1. Sum: every point adds its count to the pixels it covers, in a 32-bit float texture the size of
 *    the pane, with additive blending. The texture is kept, so appended points are added to it.
 * 2. Largest: unless `valueMax` fixes the top of the palette, passes of 16 by 16 texels bring the
 *    texture's largest density to one texel.
 * 3. Color: from 1 to the largest density on a linear scale (the default), each pixel computes its
 *    entry from its density and that texel in whole numbers (`exactDensitySlot`), on the GPU: the
 *    CPU waits for nothing. Otherwise the entries come from the mapping of values, which a GPU
 *    computing in 32-bit floats would round into the entry next to Canvas 2D's for some densities:
 *    their thresholds are computed on the CPU in 64-bit floats as Canvas 2D computes them
 *    (`DensityScale`), and each pixel searches its density among them. With a top that is the
 *    largest density (a logarithmic scale, or a fixed `valueMin`), the texel is read back first:
 *    four bytes, at the cost of waiting for the GPU to finish the frame's passes.
 *
 * Sums are exact below 2^24 points on a pixel, as counts are whole numbers; the largest, the search
 * and the whole-number entries are exact. So the picture is Canvas 2D's, pixel for pixel.
 */
export class GlDensity {
	private targets: Target[] = [];
	private words = 0;
	private readonly style: WordTexture;
	private readonly table = new Uint32Array(PALETTE_SIZE * 2);
	private readonly scale = new DensityScale();
	private readonly mapping: ValueMapping = { min: 0, factor: 1, log: false };
	private readonly peakPixel = new Float32Array(4);
	private palette: Uint32Array | null = null;
	/** Whether the table holds only colors (`exactDensitySlot`), or thresholds for the last mapping too. */
	private exact = false;
	/** The largest density of the texture, as last read. */
	private peak = 0;

	constructor(private readonly pool: GlContext) {
		this.style = new WordTexture(pool, 2);
	}

	get bytes(): number {
		return 4 * (this.words + this.style.words);
	}

	/**
	 * Sums rows `[first, end)` into the densities, which are made 0 first unless `patch` (the rows were
	 * appended since the densities were summed), then colors pixel columns `[left, right)` of the
	 * pane, or all of them when the palette's mapping may have changed. The scatter program `p` is
	 * current, with its records and ranges bound and its uniforms set but `first`; `guard` draws the
	 * points as sprites (see `GlContext.pointGuard`). Returns the columns colored.
	 */
	draw(
		f: MarkFrame,
		p: GlProgram,
		first: number,
		end: number,
		patch: boolean,
		left: number,
		right: number,
		guard: number,
	): { left: number; right: number } {
		const { width, height } = f;
		const options = f.options as ScatterOptions;
		const exact = exactDensities(options);
		const gl = this.pool.gl;
		const fresh = this.reserve(width, height);
		patch &&= !fresh;
		try {
			gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets[0]!.framebuffer);
			gl.scissor(0, 0, width, height);
			if (!patch) {
				gl.clear(gl.COLOR_BUFFER_BIT);
				this.peak = 0;
			}
			const summed = end > first;
			if (summed) {
				gl.uniform1i(p.first, first);
				gl.enable(gl.BLEND);
				gl.blendEquation(gl.FUNC_ADD);
				gl.blendFunc(gl.ONE, gl.ONE);
				this.pool.drawScatter(guard, width, height, end - first);
				gl.disable(gl.BLEND);
			}
			let remapped = false;
			if (exact) {
				// The top may move with any point summed: every pixel is colored again.
				if (summed || !patch) {
					this.reduce();
					remapped = true;
				}
			} else {
				if (summed && options.valueMax === null) {
					this.reduce();
					gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, this.peakPixel);
					this.peak = this.peakPixel[0]!;
				}
				setValueMapping(
					this.mapping,
					options.valueMin ?? 1,
					options.valueMax ?? this.peak,
					options.valueScale === 'log',
				);
				remapped = this.scale.set(this.mapping);
			}
			if (
				this.style.bind(PALETTE_SIZE * 2) ||
				exact !== this.exact ||
				this.palette !== f.palette ||
				(remapped && !exact)
			) {
				// The thresholds, unless the entries are computed on the GPU; then the colors.
				if (!exact) this.table.set(this.scale.thresholds);
				this.table.set(f.palette, PALETTE_SIZE);
				this.pool.premultiply.palette(this.table.subarray(PALETTE_SIZE));
				this.style.write(this.table, 0, PALETTE_SIZE * 2);
				this.palette = f.palette;
				this.exact = exact;
				remapped = true;
			}
			if (remapped || !patch) {
				left = 0;
				right = width;
			}
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			const color = this.pool.use('density-color', width, height);
			this.style.layout(color.styleStride);
			gl.uniform1i(color.exact, Number(exact));
			gl.activeTexture(gl.TEXTURE3);
			gl.bindTexture(gl.TEXTURE_2D, this.targets[0]!.texture);
			gl.activeTexture(gl.TEXTURE4);
			gl.bindTexture(gl.TEXTURE_2D, this.targets[this.targets.length - 1]!.texture);
			gl.scissor(left, 0, right - left, height);
			if (right > left) gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		} finally {
			gl.disable(gl.BLEND);
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		}
		return { left, right };
	}

	/**
	 * Brings the largest density of the pane's texture to the one texel of the last level, on the
	 * GPU, and leaves that level's framebuffer bound; the pass after sets its own viewport.
	 */
	private reduce(): void {
		const gl = this.pool.gl;
		const reduce = this.pool.use('density-reduce', 1, 1);
		gl.uniform1i(reduce.tile, TILE);
		gl.activeTexture(gl.TEXTURE3);
		let below = this.targets[0]!;
		for (let k = 1; k < this.targets.length; k++) {
			const level = this.targets[k]!;
			gl.bindFramebuffer(gl.FRAMEBUFFER, level.framebuffer);
			gl.viewport(0, 0, level.width, level.height);
			gl.scissor(0, 0, level.width, level.height);
			gl.uniform2i(reduce.extent, below.width, below.height);
			gl.bindTexture(gl.TEXTURE_2D, below.texture);
			gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
			below = level;
		}
	}

	/**
	 * Makes the textures for a pane `width` by `height`: the densities, and the levels of the
	 * reduction down to one texel. Returns true if they were made anew (and hold nothing).
	 */
	private reserve(width: number, height: number): boolean {
		const main = this.targets[0];
		if (main && main.width === width && main.height === height) return false;
		this.releaseTargets();
		const sizes: [number, number][] = [[width, height]];
		let words = width * height;
		for (let w = width, h = height; w > 1 || h > 1;) {
			w = Math.ceil(w / TILE);
			h = Math.ceil(h / TILE);
			sizes.push([w, h]);
			words += w * h;
		}
		if (!canvasFits(words)) throw new GlBudget();
		const gl = this.pool.gl;
		try {
			for (const [w, h] of sizes) {
				const texture = gl.createTexture();
				const framebuffer = gl.createFramebuffer();
				if (!texture || !framebuffer) {
					gl.deleteTexture(texture);
					gl.deleteFramebuffer(framebuffer);
					throw new GlBudget();
				}
				this.targets.push({ texture, framebuffer, width: w, height: h });
				gl.activeTexture(gl.TEXTURE3);
				gl.bindTexture(gl.TEXTURE_2D, texture);
				gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, w, h);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
				gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
				gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
				if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
					this.pool.noFloatBlend();
					throw new GlUnsupported();
				}
			}
		} catch (error) {
			this.releaseTargets();
			throw error;
		} finally {
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		}
		trackCanvas(0, words);
		this.words = words;
		return true;
	}

	private releaseTargets(): void {
		const gl = this.pool.gl;
		for (const target of this.targets) {
			gl.deleteFramebuffer(target.framebuffer);
			gl.deleteTexture(target.texture);
		}
		this.targets = [];
		trackCanvas(this.words, 0);
		this.words = 0;
	}

	release(): void {
		this.releaseTargets();
		this.style.release();
		this.palette = null;
	}
}
