import { describe, expect, it } from 'vitest';
import {
	PALETTES,
	PALETTE_SIZE,
	type ValueMapping,
	buildPalette,
	packColor,
	paletteIndex,
	parseColor,
	setValueMapping,
	unpackColor,
} from '../src/marks/palette';

describe('colors of marks', () => {
	it('packs a color as the bytes an ImageData holds', () => {
		const pixel = packColor(1, 2, 3, 4);
		expect([...new Uint8Array(new Uint32Array([pixel]).buffer)]).toEqual([1, 2, 3, 4]);
		expect(unpackColor(pixel)).toEqual([1, 2, 3, 4]);
		// Alpha 255 sets the sign bit of a 32-bit number: the pixel is still a positive number.
		expect(packColor(0, 0, 0, 255)).toBeGreaterThan(0);
	});

	it('reads the CSS colors pixels are written from', () => {
		expect(unpackColor(parseColor('#26a69a')!)).toEqual([0x26, 0xa6, 0x9a, 255]);
		expect(unpackColor(parseColor('#FA0')!)).toEqual([0xff, 0xaa, 0, 255]);
		expect(unpackColor(parseColor('#fa08')!)).toEqual([0xff, 0xaa, 0, 0x88]);
		expect(unpackColor(parseColor('#11223380')!)).toEqual([0x11, 0x22, 0x33, 0x80]);
		expect(unpackColor(parseColor('rgb(41, 98, 255)')!)).toEqual([41, 98, 255, 255]);
		expect(unpackColor(parseColor(' rgba(41,98,255,0.5) ')!)).toEqual([41, 98, 255, 128]);
		expect(unpackColor(parseColor('rgb(41 98 255 / 25%)')!)).toEqual([41, 98, 255, 64]);
		expect(unpackColor(parseColor('rgb(300, 0, 12.6)')!)).toEqual([255, 0, 13, 255]);
		expect(parseColor('transparent')).toBe(0);
		expect(parseColor('red')).toBeNull();
		expect(parseColor('#12345')).toBeNull();
		expect(parseColor('')).toBeNull();
	});

	it('builds a table from the first color to the last, interpolating between', () => {
		const table = buildPalette(['#000000', '#ffffff']);
		expect(table.length).toBe(PALETTE_SIZE);
		expect(unpackColor(table[0]!)).toEqual([0, 0, 0, 255]);
		expect(unpackColor(table[255]!)).toEqual([255, 255, 255, 255]);
		expect(unpackColor(table[128]!)).toEqual([128, 128, 128, 255]);
		// Three colors: the middle one is in the middle, and alpha is interpolated like a channel.
		const three = buildPalette(['rgba(255, 0, 0, 0)', '#00ff00', '#0000ff']);
		expect(unpackColor(three[0]!)).toEqual([255, 0, 0, 0]);
		expect(unpackColor(three[255]!)).toEqual([0, 0, 255, 255]);
		const middle = unpackColor(three[127]!);
		expect(middle[1]).toBeGreaterThan(250);
		expect(middle[3]).toBeGreaterThan(250);
		// One color is that color for every value.
		expect(new Set(buildPalette(['#123456'])).size).toBe(1);
	});

	it('has the built-in palettes, and refuses what it cannot read', () => {
		for (const name of Object.keys(PALETTES)) {
			expect(buildPalette(name).length).toBe(PALETTE_SIZE);
		}
		expect(unpackColor(buildPalette('viridis')[0]!)).toEqual([0x44, 0x01, 0x54, 255]);
		// The heat palette starts from nothing, so low values let the chart show through.
		expect(unpackColor(buildPalette('heat')[0]!)[3]).toBe(0);
		expect(() => buildPalette('rainbow')).toThrow(RangeError);
		expect(() => buildPalette(['#000', 'blue'])).toThrow(/blue/);
		expect(() => buildPalette([])).toThrow(RangeError);
	});

	it('maps values onto the table, linearly or by their logarithm', () => {
		const mapping: ValueMapping = { min: 0, factor: 0, log: false };
		setValueMapping(mapping, 10, 20, false);
		expect(paletteIndex(mapping, 10)).toBe(0);
		expect(paletteIndex(mapping, 20)).toBe(255);
		expect(paletteIndex(mapping, 15)).toBe(128);
		// Beyond the range: the ends.
		expect(paletteIndex(mapping, -5)).toBe(0);
		expect(paletteIndex(mapping, 1e9)).toBe(255);
		expect(paletteIndex(mapping, -Infinity)).toBe(0);
		setValueMapping(mapping, 1, 1000, true);
		expect(paletteIndex(mapping, 1)).toBe(0);
		expect(paletteIndex(mapping, 1000)).toBe(255);
		expect(paletteIndex(mapping, 10)).toBe(85);
		expect(paletteIndex(mapping, 0)).toBe(0);
		// A lowest value a logarithm cannot take: three magnitudes below the highest.
		setValueMapping(mapping, 0, 1000, true);
		expect(paletteIndex(mapping, 1)).toBe(0);
		expect(paletteIndex(mapping, 1000)).toBe(255);
		// One value only: the middle of the table.
		setValueMapping(mapping, 7, 7, false);
		expect(paletteIndex(mapping, 7)).toBe(128);
		// No values at all: a mapping all the same, which is the same every time.
		setValueMapping(mapping, Number.NaN, Number.NaN, true);
		expect(mapping).toEqual({ min: -0.5, factor: 255, log: false });
	});
});
