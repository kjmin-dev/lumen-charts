import { describe, expect, it } from 'vitest';
import { heatStyle } from '../src/marks/gpu/geometry';
import { buildPalette, setValueMapping } from '../src/marks/palette';
import { quantize } from '../src/marks/render';
import { resolveOptions } from '../src/options';

describe('mark renderer selection', () => {
	it('defaults to WebGL2, accepts explicit backends and resolves the legacy auto setting', () => {
		expect(resolveOptions({}, false).markRenderer).toBe('webgl2');
		expect(resolveOptions({ markRenderer: 'auto' }, false).markRenderer).toBe('webgl2');
		for (const markRenderer of ['webgl2', 'webgpu', 'canvas2d'] as const)
			expect(resolveOptions({ markRenderer }, false).markRenderer).toBe(markRenderer);
		expect(() => resolveOptions({ markRenderer: 'no' as 'auto' }, false)).toThrow(RangeError);
	});
});

describe('WebGPU heatmap palette thresholds', () => {
	it('matches Canvas quantization for floats at bin boundaries, gaps, subnormals and infinities', () => {
		const palette = buildPalette('heat'),
			style = new Uint32Array(512);
		const bits = new Uint32Array(1),
			floats = new Float32Array(bits.buffer);
		for (const [min, max, log] of [
			[-15, 112, false],
			[1, 1, false],
			[0, 300, true],
			[0.001, 128, true],
		] as const) {
			const mapping = { min: 0, factor: 0, log: false };
			setValueMapping(mapping, min, max, log);
			heatStyle(palette, mapping, style);
			const inputs = [-Infinity, Infinity, NaN, -0, 0, 1e-43, -1e-42];
			for (let i = 2; i < 256; i++) {
				const key = style[256 + i]!;
				if (key > 0xff800000) continue;
				for (let j = -1; j <= 1; j++) {
					const k = key + j;
					bits[0] = k < 0x80000000 ? ~k : k ^ 0x80000000;
					inputs.push(floats[0]!);
				}
			}
			const values = Float32Array.from(inputs),
				slots = new Uint8Array(inputs.length);
			quantize(values, slots, 1, 0, values.length, mapping);
			for (let i = 0; i < values.length; i++) {
				const value = values[i]!;
				floats[0] = value;
				const key = (bits[0]! >= 0x80000000 ? ~bits[0]! : bits[0]! ^ 0x80000000) >>> 0;
				let slot = Number.isNaN(value) ? 0 : 1;
				if (slot) while (slot < 255 && key >= style[257 + slot]!) slot++;
				expect(slot).toBe(slots[i]);
			}
		}
	});
});
