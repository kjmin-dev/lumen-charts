import { PALETTE_SIZE, packColor, unpackColor } from './palette';

/**
 * How the Canvas 2D of a document premultiplies the pixels `putImageData` hands it: `table[a * 256 +
 * c]` is what a channel `c` at alpha `a` becomes. The Canvas 2D path of a mark series writes its
 * pixels with `putImageData`; the WebGL2 and WebGPU paths write colors premultiplied by this table
 * into premultiplied images, so all three retain the same bytes. Browsers round differently here:
 * Chromium and WebKit to the nearest byte, Firefox up.
 *
 * A WebGL2 drawing buffer of straight colors would leave the conversion to the browser when the
 * buffer is drawn into a 2D canvas, where it can take another path than `putImageData` (a GPU pass,
 * at a precision and rounding of its own); a WebGPU kernel that premultiplied in floats would round
 * to the nearest byte whatever the browser's Canvas 2D does.
 */
const tables = new WeakMap<Document, Uint8Array>();

/** The table of a document: measured once, or rounded to the nearest byte where it cannot be. */
export function premultiplyTable(doc: Document): Uint8Array {
	let table = tables.get(doc);
	if (table === undefined) {
		table = measure(doc) ?? nearestTable();
		tables.set(doc, table);
	}
	return table;
}

/** Each channel times alpha over 255, rounded to the nearest byte. */
export function nearestTable(): Uint8Array {
	const table = new Uint8Array(256 * 256);
	for (let a = 0; a < 256; a++) {
		for (let c = 0; c < 256; c++) {
			table[a * 256 + c] = Math.floor((c * a + 127) / 255);
		}
	}
	return table;
}

/**
 * Puts every channel value at every alpha into a canvas, as a mark series' pixels are put, and
 * reads back what the canvas holds by drawing it over an opaque black one: there a premultiplied
 * color is the color itself. Null where that cannot be done, or reads back what no premultiplication
 * gives (a value above its alpha, or a change of an opaque color).
 */
function measure(doc: Document): Uint8Array | null {
	let source: HTMLCanvasElement | null = null,
		target: HTMLCanvasElement | null = null;
	try {
		if (typeof ImageData !== 'function') return null;
		source = doc.createElement('canvas');
		target = doc.createElement('canvas');
		source.width = source.height = target.width = target.height = 256;
		const put = source.getContext('2d');
		const read = target.getContext('2d', { alpha: false, willReadFrequently: true });
		if (put === null || read === null) return null;
		const image = new ImageData(256, 256);
		const pixels = new Uint32Array(image.data.buffer);
		for (let a = 0; a < 256; a++) {
			for (let c = 0; c < 256; c++) {
				pixels[a * 256 + c] = packColor(c, c, c, a);
			}
		}
		put.putImageData(image, 0, 0);
		read.fillStyle = '#000';
		read.fillRect(0, 0, 256, 256);
		read.drawImage(source, 0, 0);
		const data = read.getImageData(0, 0, 256, 256).data;
		const table = new Uint8Array(256 * 256);
		for (let i = 0; i < 256 * 256; i++) {
			const value = data[i * 4]!;
			const a = i >> 8,
				c = i & 255;
			if (value !== data[i * 4 + 1] || value !== data[i * 4 + 2] || value > a || (a === 255 && value !== c))
				return null;
			table[i] = value;
		}
		return table;
	} catch {
		return null;
	} finally {
		// Shrinking a canvas lets its bitmap go at once.
		if (source) source.width = source.height = 1;
		if (target) target.width = target.height = 1;
	}
}

/**
 * Premultiplies straight colors (as `ImageData` holds them) as a document's Canvas 2D does. Opaque
 * and fully transparent colors come out the same under every rounding, so the table is measured
 * only with the first translucent color, and a page whose colors are all opaque never measures it.
 */
export class Premultiplier {
	private table: Uint8Array | null = null;
	private readonly doc: Document;

	public constructor(doc: Document) {
		this.doc = doc;
	}

	/** Whether a translucent color has needed the table. */
	public get measured(): boolean {
		return this.table !== null;
	}

	public color(color: number): number {
		const [r, g, b, a] = unpackColor(color);
		if (a === 255) return color;
		if (a === 0) return 0;
		const table = (this.table ??= premultiplyTable(this.doc));
		const row = a * 256;
		return packColor(table[row + r]!, table[row + g]!, table[row + b]!, a);
	}

	/** Colors `[0, count)` of `colors`, premultiplied in place. */
	public palette(colors: Uint32Array, count = PALETTE_SIZE): void {
		for (let i = 0; i < count; i++) colors[i] = this.color(colors[i]!);
	}
}
