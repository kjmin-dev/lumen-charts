/**
 * Colors of heatmap cells and scatter points, as the pixels of an `ImageData` hold them: one 32-bit
 * number per pixel whose bytes in memory are red, green, blue and alpha (not premultiplied).
 */

/** Entries of a color table. */
export const PALETTE_SIZE = 256;

/** Whether this machine stores the low byte of a 32-bit number first, as nearly all do. */
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** The pixel of a color given as bytes 0 to 255. */
export function packColor(red: number, green: number, blue: number, alpha: number): number {
	return LITTLE_ENDIAN
		? ((alpha << 24) | (blue << 16) | (green << 8) | red) >>> 0
		: ((red << 24) | (green << 16) | (blue << 8) | alpha) >>> 0;
}

/** Red, green, blue and alpha of a pixel, as bytes. */
export function unpackColor(pixel: number): [number, number, number, number] {
	return LITTLE_ENDIAN
		? [pixel & 255, (pixel >>> 8) & 255, (pixel >>> 16) & 255, pixel >>> 24]
		: [pixel >>> 24, (pixel >>> 16) & 255, (pixel >>> 8) & 255, pixel & 255];
}

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i;

function byte(value: string): number {
	return Math.max(0, Math.min(255, Math.round(Number.parseFloat(value))));
}

/**
 * The pixel of a CSS color written as `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(r, g, b)`,
 * `rgba(r, g, b, a)` (also with spaces and a slash) or `transparent`; null for anything else. The
 * pixels are written by this code, not by the canvas, so the forms it reads are these.
 */
export function parseColor(color: string): number | null {
	const text = color.trim();
	if (text === 'transparent') {
		return 0;
	}
	const hex = HEX.exec(text);
	if (hex !== null) {
		const digits = hex[1]!;
		const short = digits.length <= 4;
		const channel = (i: number): number =>
			short ? Number.parseInt(digits[i]! + digits[i]!, 16) : Number.parseInt(digits.slice(2 * i, 2 * i + 2), 16);
		const hasAlpha = digits.length === 4 || digits.length === 8;
		return packColor(channel(0), channel(1), channel(2), hasAlpha ? channel(3) : 255);
	}
	const rgb = RGB.exec(text);
	if (rgb !== null) {
		let alpha = 1;
		if (rgb[4] !== undefined) {
			alpha = rgb[4].endsWith('%') ? Number.parseFloat(rgb[4]) / 100 : Number.parseFloat(rgb[4]);
		}
		return packColor(byte(rgb[1]!), byte(rgb[2]!), byte(rgb[3]!), Math.max(0, Math.min(255, Math.round(alpha * 255))));
	}
	return null;
}

/** The built-in palettes, as colors evenly spaced from the lowest value to the highest. */
export const PALETTES: Readonly<Record<string, readonly string[]>> = {
	viridis: ['#440154', '#472d7b', '#3b528b', '#2c728e', '#21918c', '#28ae80', '#5ec962', '#addc30', '#fde725'],
	inferno: [
		'#000004',
		'#1b0c41',
		'#4a0c6b',
		'#781c6d',
		'#a52c60',
		'#cf4446',
		'#ed6925',
		'#fb9b06',
		'#f7d13d',
		'#fcffa4',
	],
	turbo: ['#30123b', '#4662d7', '#36aaf9', '#1ae4b6', '#72fe5e', '#c7ef34', '#faba39', '#f66b19', '#cb2a04', '#7a0403'],
	greys: ['#f7f7f7', '#252525'],
	/** From nothing to a strong color: low values let the chart show through. */
	heat: ['rgba(41, 98, 255, 0)', 'rgba(41, 98, 255, 0.55)', '#f6c343', '#ef5350'],
	/** Diverging: low values blue, high values red. */
	'blue-red': ['#2166ac', '#92c5de', '#f7f7f7', '#f4a582', '#b2182b'],
};

/** A palette: the name of a built-in one, or two or more CSS colors from the lowest value to the highest. */
export type Palette = string | readonly string[];

/**
 * The color table of a palette: `PALETTE_SIZE` pixels from the lowest value to the highest, each
 * channel interpolated between the two colors around it. Throws a RangeError for an unknown name or
 * a color `parseColor` cannot read.
 */
export function buildPalette(palette: Palette): Uint32Array {
	const stops = typeof palette === 'string' ? PALETTES[palette] : palette;
	if (stops === undefined) {
		throw new RangeError(
			`lumen-ticks: unknown palette "${String(palette)}" (built in: ${Object.keys(PALETTES).join(', ')})`,
		);
	}
	if (!Array.isArray(stops) || stops.length === 0) {
		throw new RangeError('lumen-ticks: a palette is a name or an array of at least one color');
	}
	const channels = stops.map(stop => {
		const pixel = typeof stop === 'string' ? parseColor(stop) : null;
		if (pixel === null) {
			throw new RangeError(`lumen-ticks: cannot read the palette color "${String(stop)}"`);
		}
		return unpackColor(pixel);
	});
	const table = new Uint32Array(PALETTE_SIZE);
	const last = channels.length - 1;
	for (let i = 0; i < PALETTE_SIZE; i++) {
		const at = last === 0 ? 0 : (i / (PALETTE_SIZE - 1)) * last;
		const lo = Math.min(last, Math.floor(at));
		const hi = Math.min(last, lo + 1);
		const t = at - lo;
		const a = channels[lo]!;
		const b = channels[hi]!;
		table[i] = packColor(
			Math.round(a[0] + (b[0] - a[0]) * t),
			Math.round(a[1] + (b[1] - a[1]) * t),
			Math.round(a[2] + (b[2] - a[2]) * t),
			Math.round(a[3] + (b[3] - a[3]) * t),
		);
	}
	return table;
}

/** How values map to the entries of a color table. */
export interface ValueMapping {
	/** `index = (value - min) * factor`, rounded and held within the table; on a `log` scale of `log10(value)`. */
	min: number;
	factor: number;
	log: boolean;
}

/**
 * Sets `mapping` for values from `min` to `max`. A range without width puts every value in the
 * middle of the table; on a `log` scale a range that starts at 0 or below starts three magnitudes
 * below its highest value instead.
 */
export function setValueMapping(mapping: ValueMapping, min: number, max: number, log: boolean): void {
	if (!(min <= max)) {
		// No values, or a range given the wrong way around: nothing to spread the palette over.
		min = 0;
		max = 0;
		log = false;
	}
	if (log) {
		const high = max > 0 ? Math.log10(max) : 0;
		const low = min > 0 ? Math.log10(min) : high - 3;
		min = low;
		max = high;
	}
	mapping.log = log;
	if (max > min) {
		mapping.min = min;
		mapping.factor = (PALETTE_SIZE - 1) / (max - min);
	} else {
		// Every value is the one value there is.
		mapping.min = min - 0.5;
		mapping.factor = PALETTE_SIZE - 1;
	}
}

/** The table entry of a value, 0 to `PALETTE_SIZE - 1`; values outside the range take its ends. */
export function paletteIndex(mapping: ValueMapping, value: number): number {
	const v = mapping.log ? (value > 0 ? Math.log10(value) : -Infinity) : value;
	const index = (v - mapping.min) * mapping.factor + 0.5;
	return index >= PALETTE_SIZE ? PALETTE_SIZE - 1 : index > 0 ? index | 0 : 0;
}
