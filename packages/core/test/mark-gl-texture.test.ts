import { describe, expect, it } from 'vitest';
import type { GlContext } from '../src/marks/gl/context';
import { WordTexture } from '../src/marks/gl/texture';
import { canvasPixelsInUse } from '../src/shared/canvas-budget';
import { FakeWebGl } from './fake-webgl';

function pool(limit = 4096): { gl: FakeWebGl; pool: GlContext } {
	const gl = new FakeWebGl(document.createElement('canvas'));
	gl.maxTextureSize = limit;
	return { gl, pool: { gl, limit } as unknown as GlContext };
}

describe('WebGL2 word textures', () => {
	it('makes rows a power of two wide, at most 2048 and the texture size limit', () => {
		const { gl, pool: p } = pool();
		const texture = new WordTexture(p, 0);
		const sizes: [number, number, number, number][] = [];
		for (const count of [1, 5, 512, 513, 2048, 7200]) {
			texture.bind(count);
			const t = gl.bound(0)!;
			sizes.push([count, texture.shift, t.width, t.height]);
			expect(texture.words).toBe(t.width * t.height);
			expect(texture.words).toBeGreaterThanOrEqual(count);
			texture.release();
		}
		expect(sizes).toEqual([
			[1, 0, 1, 1],
			[5, 3, 8, 1],
			[512, 9, 512, 1],
			[513, 10, 1024, 1],
			[2048, 11, 2048, 1],
			[7200, 11, 2048, 4],
		]);
		const small = pool(1000);
		const narrow = new WordTexture(small.pool, 0);
		narrow.bind(3000);
		expect([narrow.shift, small.gl.bound(0)!.width, small.gl.bound(0)!.height]).toEqual([9, 512, 6]);
		narrow.release();
	});

	it('uploads a range as a partial first row, whole rows and a partial last row', () => {
		const { gl, pool: p } = pool();
		const texture = new WordTexture(p, 1);
		texture.bind(20_000);
		const data = Uint32Array.from({ length: 20_000 }, (_, i) => i + 1);
		gl.uploads.length = 0;
		texture.write(data, 1000, 9000);
		expect(gl.uploads).toEqual([
			{ unit: 1, x: 1000, y: 0, width: 1048, height: 1 },
			{ unit: 1, x: 0, y: 1, width: 2048, height: 3 },
			{ unit: 1, x: 0, y: 4, width: 808, height: 1 },
		]);
		const t = gl.bound(1)!;
		expect(FakeWebGl.words(t, 999, 9001)).toEqual([0, ...data.subarray(1000, 9000), 0]);
		texture.release();
	});

	it('charts its words to the canvas budget and gives them back', () => {
		const before = canvasPixelsInUse();
		const { pool: p } = pool();
		const texture = new WordTexture(p, 0);
		texture.bind(3000);
		expect(canvasPixelsInUse() - before).toBe(4096);
		// A smaller count fits the texture there is.
		expect(texture.bind(100)).toBe(false);
		expect(texture.bind(5000)).toBe(true);
		expect(canvasPixelsInUse() - before).toBe(6144);
		texture.release();
		expect(canvasPixelsInUse()).toBe(before);
	});
});
