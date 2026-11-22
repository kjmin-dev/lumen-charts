import { afterEach, describe, expect, it, vi } from 'vitest';
import { nearestTable, premultiplyColor, premultiplyPalette, premultiplyTable } from '../src/marks/gl/premultiply';
import { buildPalette, packColor } from '../src/marks/palette';

/** Stands in for `ImageData`, which the test environment lacks. */
class FakeImageData {
	public readonly data: Uint8ClampedArray;
	public constructor(
		public readonly width: number,
		public readonly height: number,
	) {
		this.data = new Uint8ClampedArray(width * height * 4);
	}
}

/**
 * A document whose canvases premultiply what `putImageData` hands them by `rule`, and draw a
 * canvas over an opaque one as the premultiplied color: what a browser's Canvas 2D does.
 */
function documentPremultiplying(rule: (c: number, a: number) => number) {
	const canvases: { width: number; height: number }[] = [];
	let stored = new Uint8ClampedArray(0);
	const doc = {
		createElement() {
			const canvas = {
				width: 300,
				height: 150,
				getContext: () => ({
					putImageData(image: FakeImageData) {
						stored = new Uint8ClampedArray(image.data.length);
						for (let i = 0; i < image.data.length; i += 4) {
							const a = image.data[i + 3]!;
							for (let k = 0; k < 3; k++) stored[i + k] = rule(image.data[i + k]!, a);
							stored[i + 3] = 255;
						}
					},
					fillRect() {},
					drawImage() {},
					getImageData: () => ({ data: stored }),
				}),
			};
			canvases.push(canvas);
			return canvas;
		},
	};
	return { doc: doc as unknown as Document, canvases };
}

/** Each channel times alpha over 255, rounded up, as Firefox premultiplies. */
const up = (c: number, a: number) => Math.ceil((c * a) / 255);

describe('premultiplication of WebGL2 mark colors', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('rounds each channel times alpha over 255 to the nearest byte where it cannot measure', () => {
		const table = nearestTable();
		for (const [c, a, value] of [
			[255, 255, 255],
			[0, 200, 0],
			[200, 0, 0],
			[1, 128, 1],
			[1, 127, 0],
			[3, 85, 1],
			[128, 2, 1],
			[127, 2, 1],
			[127, 1, 0],
		] as const)
			expect(table[a * 256 + c]).toBe(value);
		// A document whose canvases cannot be measured.
		expect(premultiplyTable({} as Document)).toEqual(table);
	});

	it("measures the document's own rounding, and lets its canvases go", () => {
		vi.stubGlobal('ImageData', FakeImageData);
		const { doc, canvases } = documentPremultiplying(up);
		const table = premultiplyTable(doc);
		expect(table[1 * 256 + 1]).toBe(1);
		expect(table[128 * 256 + 3]).toBe(up(3, 128));
		expect(table).not.toEqual(nearestTable());
		expect(canvases.map(canvas => [canvas.width, canvas.height])).toEqual([
			[1, 1],
			[1, 1],
		]);
		// Once per document.
		expect(premultiplyTable(doc)).toBe(table);
	});

	it('rounds to the nearest byte where the measure reads back what no premultiplication gives', () => {
		vi.stubGlobal('ImageData', FakeImageData);
		// An opaque color that changes, a value above its alpha.
		for (const rule of [(c: number, a: number) => (a === 255 ? 255 - c : c), (c: number) => c])
			expect(premultiplyTable(documentPremultiplying(rule).doc)).toEqual(nearestTable());
	});

	it('premultiplies translucent colors and keeps opaque ones', () => {
		const table = nearestTable();
		expect(premultiplyColor(table, packColor(200, 100, 3, 128))).toBe(packColor(100, 50, 2, 128));
		expect(premultiplyColor(table, packColor(200, 100, 3, 255))).toBe(packColor(200, 100, 3, 255));
		expect(premultiplyColor(table, packColor(200, 100, 3, 0))).toBe(0);
		const palette = buildPalette('heat');
		const colors = palette.slice();
		premultiplyPalette(table, colors);
		expect(colors[0]).toBe(0);
		expect(colors[255]).toBe(palette[255]);
		expect(colors[100]).toBe(premultiplyColor(table, palette[100]!));
	});
});
