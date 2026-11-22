import { describe, expect, it } from 'vitest';
import type { MarkFrame } from '../src/marks/backend';
import { packScatterRows } from '../src/marks/gl/density';
import { scatterBounds } from '../src/marks/gpu/geometry';
import { DEFAULT_SCATTER_OPTIONS } from '../src/marks/options';
import { type ValueMapping, buildPalette, packColor, paletteIndex, setValueMapping } from '../src/marks/palette';
import {
	MAX_POINT_PIXELS,
	type PixelBox,
	type PriceProjection,
	StampCache,
	accumulateScatter,
	colorDensity,
	drawScatter,
	emptyBox,
	makeStamp,
	pointPixels,
} from '../src/marks/render';
import { DensityScale, SizeExtent, exactDensitySlot, hitScatter } from '../src/marks/scatter-style';
import { TimeMap } from '../src/marks/time-map';
import { MarksWindow } from '../src/marks/window';

const MINUTE = 60_000;
const WIDTH = 40;
const HEIGHT = 30;

/** Bars a minute apart; bar `i` is centered at `origin + i * spacing` device pixels. */
function barMap(count: number, origin: number, spacing: number): TimeMap {
	const times = Float64Array.from({ length: count }, (_, i) => i * MINUTE);
	const map = new TimeMap();
	map.set(times, 0, count, 0, 0, 0, origin, spacing);
	return map;
}

/** Price `p` on row `30 - p`: one device pixel per unit. */
const LINEAR: PriceProjection = { offset: 30, scale: 1, log: false };
const GREY = buildPalette(['#000000', '#ffffff']);
const RED = packColor(255, 0, 0, 255);

function box(): PixelBox {
	const b = { left: 0, top: 0, right: 0, bottom: 0 };
	emptyBox(b);
	return b;
}

function mappingOf(min: number, max: number, log = false): ValueMapping {
	const mapping: ValueMapping = { min: 0, factor: 0, log: false };
	setValueMapping(mapping, min, max, log);
	return mapping;
}

interface Points {
	time: Float64Array;
	price: Float64Array;
	values: Float32Array;
	sizes: Float32Array;
	counts: Float32Array;
}

/** Points as `[minute, price, size?, count?]`; a size of NaN is the series' size. */
function points(list: [number, number, number?, number?][]): Points {
	return {
		time: Float64Array.from(list, p => p[0] * MINUTE),
		price: Float64Array.from(list, p => p[1]),
		values: Float32Array.from(list, (_, i) => i),
		sizes: Float32Array.from(list, p => p[2] ?? Number.NaN),
		counts: Float32Array.from(list, p => p[3] ?? 1),
	};
}

/** A deterministic sequence in [0, 1). */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 4294967296;
	};
}

/**
 * Random points over the pane and a little beyond it, in time order, some with sizes of their own,
 * and two wide ones centered well outside the pane that reach into it.
 */
function cloud(n: number, seed: number, withSizes = true): Points {
	const next = random(seed);
	const list: [number, number, number?, number?][] = [];
	for (let i = 0; i < n; i++) list.push([next() * 11 - 0.5, next() * 36 - 3]);
	list.sort((a, b) => a[0] - b[0]);
	for (const p of list) {
		if (withSizes && next() < 0.8) p[2] = next() < 0.1 ? 0.2 : next() * 9;
		p[3] = 1 + Math.floor(next() * 4);
	}
	if (withSizes) {
		list.unshift([-2, 12, 15, 2]);
		list.push([12, 20, 15, 3]);
	}
	return points(list);
}

function lit(pixels: Uint32Array): string[] {
	const list: string[] = [];
	for (let y = 0; y < HEIGHT; y++)
		for (let x = 0; x < WIDTH; x++) if (pixels[x * HEIGHT + y] !== 0) list.push(`${x},${y}`);
	return list;
}

/** Draws with the per-row sizes in one call. */
function sized(data: Points, map: TimeMap, base: number, circle: boolean, ratio = 1) {
	const pixels = new Uint32Array(WIDTH * HEIGHT);
	const b = box();
	const stamps = new StampCache();
	stamps.setCircle(circle);
	drawScatter(
		pixels,
		WIDTH,
		HEIGHT,
		data.time,
		data.price,
		data.values,
		0,
		data.time.length,
		map,
		0,
		LINEAR,
		GREY,
		mappingOf(0, data.time.length),
		RED,
		makeStamp(base, circle),
		b,
		data.sizes,
		ratio,
		stamps,
	);
	return { pixels, box: b };
}

/** The reference: every point drawn alone, in order, with a stamp of its own size. */
function oneByOne(data: Points, map: TimeMap, base: number, circle: boolean, ratio = 1) {
	const pixels = new Uint32Array(WIDTH * HEIGHT);
	const b = box();
	for (let i = 0; i < data.time.length; i++) {
		const css = data.sizes[i]!;
		const size = css === css ? pointPixels(css, ratio) : base;
		drawScatter(
			pixels,
			WIDTH,
			HEIGHT,
			data.time,
			data.price,
			data.values,
			i,
			i + 1,
			map,
			0,
			LINEAR,
			GREY,
			mappingOf(0, data.time.length),
			RED,
			makeStamp(size, circle),
			b,
		);
	}
	return { pixels, box: b };
}

describe('scatter points with sizes of their own', () => {
	it('rounds a size to device pixels, keeps at least one and at most the cap', () => {
		expect(pointPixels(3, 1)).toBe(3);
		expect(pointPixels(1.5, 2)).toBe(3);
		expect(pointPixels(2.4, 1)).toBe(2);
		expect(pointPixels(0.2, 1)).toBe(1);
		expect(pointPixels(0, 2)).toBe(1);
		expect(pointPixels(-4, 2)).toBe(1);
		expect(pointPixels(1e9, 1)).toBe(MAX_POINT_PIXELS);
		expect(pointPixels(Infinity, 1)).toBe(MAX_POINT_PIXELS);
	});

	it('stamps each point at its own size, and at the series size without one', () => {
		const map = barMap(10, 2, 4);
		// Bar 1 at x 6, bar 4 at 18, bar 7 at 30; price 20 on row 10.
		const data = points([
			[1, 20],
			[4, 20, 5],
			[7, 20, 0.3],
		]);
		const { pixels, box: b } = sized(data, map, 3, false);
		const on = lit(pixels);
		expect(on.length).toBe(9 + 25 + 1);
		expect(on).toContain('5,9');
		expect(on).toContain('16,8');
		expect(on).toContain('20,12');
		expect(on).toContain('30,10');
		expect(on).not.toContain('29,10');
		expect(b).toEqual({ left: 5, top: 8, right: 31, bottom: 13 });
	});

	it('reaches the box of a wide point drawn before narrow ones', () => {
		const map = barMap(10, 2, 4);
		const data = points([
			[4, 20, 11],
			[4.2, 15, 1],
		]);
		const { box: b } = sized(data, map, 1, false);
		// The first point covers columns 13 to 23; the second, later, sits at 19.
		expect(b).toEqual({ left: 13, top: 5, right: 24, bottom: 16 });
	});

	it('draws what stamping every point alone at its size draws, squares and discs, at the edges too', () => {
		for (const [seed, circle, base, ratio] of [
			[1, false, 3, 1],
			[2, true, 3, 1],
			[3, true, 1, 2],
			[4, false, 2, 1.5],
		] as const) {
			const data = cloud(300, seed);
			const map = barMap(12, 1, 3.7);
			const one = sized(data, map, base, circle, ratio);
			const reference = oneByOne(data, map, base, circle, ratio);
			expect(lit(one.pixels).length).toBeGreaterThan(100);
			expect(one.pixels).toEqual(reference.pixels);
			expect(one.box).toEqual(reference.box);
		}
	});
});

/** Densities summed one pixel at a time: what `accumulateScatter` must give. */
function referenceDensity(data: Points, map: TimeMap, base: number, circle: boolean, counted: boolean): Float32Array {
	const density = new Float32Array(WIDTH * HEIGHT);
	for (let i = 0; i < data.time.length; i++) {
		const css = data.sizes[i]!;
		const size = css === css ? pointPixels(css, 1) : base;
		const stamp = makeStamp(size, circle);
		const half = size >> 1;
		const left = Math.round(map.x(data.time[i]!)) - half;
		const top = Math.round(30 - data.price[i]!) - half;
		for (let c = 0; c < size; c++) {
			for (let r = stamp.spans[c * 2]!; r < stamp.spans[c * 2 + 1]!; r++) {
				const x = left + c;
				const y = top + r;
				if (x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT) density[x * HEIGHT + y]! += counted ? data.counts[i]! : 1;
			}
		}
	}
	return density;
}

function accumulate(data: Points, map: TimeMap, base: number, circle: boolean, counted: boolean) {
	const density = new Float32Array(WIDTH * HEIGHT);
	const b = box();
	const stamps = new StampCache();
	stamps.setCircle(circle);
	const peak = accumulateScatter(
		density,
		WIDTH,
		HEIGHT,
		data.time,
		data.price,
		counted ? data.counts : new Float32Array(0),
		0,
		data.time.length,
		map,
		0,
		LINEAR,
		makeStamp(base, circle),
		b,
		data.sizes,
		1,
		stamps,
	);
	return { density, peak, box: b };
}

/** 255 (d - 1) / (top - 1) rounded half up, in BigInt, both halved below 2^24 as the shader does. */
function exactReference(d: number, top: number): number {
	let a = BigInt(Math.min(d, 4294967040) - 1);
	let m = BigInt(Math.min(top, 4294967040) - 1);
	if (m === 0n) return 128;
	while (m >= 1n << 24n) {
		m >>= 1n;
		a >>= 1n;
	}
	const n = 255n * a;
	const q = n / m;
	return Math.min(255, Number(q) + (2n * (n - q * m) >= m ? 1 : 0));
}

describe('scatter densities', () => {
	it('sums the count of every point that covers a pixel, with sizes, discs and edges', () => {
		for (const [seed, circle, counted] of [
			[5, false, false],
			[6, true, true],
			[7, false, true],
		] as const) {
			const data = cloud(400, seed);
			const map = barMap(12, 1, 3.7);
			const { density, peak, box: b } = accumulate(data, map, 3, circle, counted);
			const reference = referenceDensity(data, map, 3, circle, counted);
			expect(density).toEqual(reference);
			expect(peak).toBe(Math.max(...reference));
			expect(peak).toBeGreaterThan(counted ? 4 : 2);
			// The box holds every density above 0, and the pixels drawn there.
			const colored = sized(data, map, 3, circle);
			expect(b).toEqual(colored.box);
			for (let i = 0; i < density.length; i++) expect(density[i]! > 0).toBe(colored.pixels[i] !== 0);
		}
	});

	it('sums whole numbers exactly below 2^24, in 32-bit floats as a GPU blends them', () => {
		const map = barMap(10, 2, 4);
		const big = 2 ** 23;
		const data = points([
			[3, 20, 1, big],
			[3, 20, 1, big - 1],
			[3, 20, 1, 1],
		]);
		const { density, peak } = accumulate(data, map, 1, false, true);
		expect(peak).toBe(2 ** 24);
		expect(density[14 * HEIGHT + 10]).toBe(2 ** 24);
		// One more cannot be told apart in a float: as on the GPU, the sum stays.
		const over = points([
			[3, 20, 1, 2 ** 24],
			[3, 20, 1, 1],
		]);
		expect(accumulate(over, map, 1, false, true).peak).toBe(2 ** 24);
	});

	it('gives every density the palette entry its value would get, from the thresholds and the table', () => {
		const mappings = [
			mappingOf(1, 7),
			mappingOf(1, 1),
			mappingOf(1, 3000),
			mappingOf(1, 1e6, true),
			mappingOf(5, 50),
			mappingOf(1, 0.5),
			mappingOf(1, 2 ** 24, true),
		];
		const bits = new Uint32Array(1);
		const floats = new Float32Array(bits.buffer);
		const scale = new DensityScale();
		for (const mapping of mappings) {
			expect(scale.set(mapping)).toBe(true);
			expect(scale.set({ ...mapping })).toBe(false);
			const densities: number[] = [];
			for (let d = 1; d <= 5000; d++) densities.push(d);
			for (let k = 1; k < 256; k++) {
				const t = scale.thresholds[k]!;
				if (t >= 0x7f800000) continue;
				for (const key of [t - 1, t, t + 1]) {
					bits[0] = key;
					if (floats[0]! > 0) densities.push(floats[0]!);
				}
			}
			for (const d of [2 ** 20 + 1, 2 ** 24, 123456789]) densities.push(d);
			const wrong = densities.filter(
				d =>
					scale.slot(d) !== paletteIndex(mapping, Math.fround(d)) ||
					(d < scale.lutSize && Number.isInteger(d) && scale.lut[d] !== scale.slot(d)),
			);
			expect(wrong).toEqual([]);
			for (let k = 2; k < 256; k++) expect(scale.thresholds[k]!).toBeGreaterThanOrEqual(scale.thresholds[k - 1]!);
		}
	});

	it('computes the entries from 1 to the largest density in whole numbers, as the GPU does', () => {
		const next = random(21);
		const scale = new DensityScale();
		const wrong: string[] = [];
		for (const top of [1, 2, 3, 5, 255, 256, 511, 4097, 65535, 2 ** 24 - 1, 2 ** 24, 2 ** 24 + 2, 3e8, 4294967040]) {
			expect(scale.setExact(top)).toBe(true);
			expect(scale.setExact(top)).toBe(false);
			const densities = [1, 2, top, Math.max(1, top - 1), Math.ceil(top / 2), Math.floor(top / 2) + 1];
			for (let k = 0; k < 400; k++) densities.push(1 + Math.floor(next() * top));
			for (let k = 1; k < 256; k++) {
				// Around every threshold, as floats: the densities a pixel can hold.
				const bits = new Uint32Array([scale.thresholds[k]!]);
				const floats = new Float32Array(bits.buffer);
				if (floats[0]! >= 1 && floats[0]! <= top) densities.push(floats[0]!);
			}
			for (const raw of densities) {
				const d = Math.fround(Math.max(1, Math.min(raw, top)));
				if (!Number.isInteger(d)) continue;
				const expected = exactReference(d, top);
				if (exactDensitySlot(d, top) !== expected || scale.slot(d) !== expected) wrong.push(`${d}/${top}`);
				if (d < scale.lutSize && scale.lut[d] !== expected) wrong.push(`lut ${d}/${top}`);
			}
		}
		expect(wrong).toEqual([]);
		// Halves go up, as a value's entry does: 2 of 1 to 3 is the middle of the palette.
		expect(exactDensitySlot(2, 3)).toBe(128);
		expect(exactDensitySlot(1, 1)).toBe(128);
		expect(exactDensitySlot(7, 7)).toBe(255);
	});

	it('colors pixels with a density and leaves the others transparent', () => {
		const palette = buildPalette('viridis');
		const density = Float32Array.of(0, 1, 2, 3, 5000, 0);
		const pixels = new Uint32Array(6);
		const scale = new DensityScale();
		const mapping = mappingOf(1, 5000, true);
		scale.set(mapping);
		colorDensity(density, pixels, 6, { left: 0, right: 1, top: 0, bottom: 6 }, scale, palette);
		expect(pixels[0]).toBe(0);
		expect(pixels[5]).toBe(0);
		for (let i = 1; i < 5; i++) expect(pixels[i]).toBe(palette[paletteIndex(mapping, density[i]!)]);
		expect(pixels[4]).toBe(palette[255]);
	});
});

/** The row `hitScatter` finds at a pixel, and the density there. */
function hit(data: Points, map: TimeMap, x: number, y: number, base = 3, circle = false) {
	const stamps = new StampCache();
	stamps.setCircle(circle);
	let largest = base;
	for (const size of data.sizes) if (size === size) largest = Math.max(largest, pointPixels(size, 1));
	const out = { row: -1, density: 0 };
	hitScatter(
		data.time,
		data.price,
		data.sizes,
		data.counts,
		0,
		data.time.length,
		map,
		0,
		LINEAR,
		makeStamp(base, circle),
		stamps,
		1,
		largest,
		x,
		y,
		out,
	);
	return out;
}

describe('the point at a pixel', () => {
	it('finds the last point drawn there, and sums the counts of all that cover it', () => {
		const map = barMap(10, 2, 4);
		const data = points([
			[3, 20, Number.NaN, 2],
			[3.25, 20, Number.NaN, 5],
			[6, 4],
		]);
		// Columns 13 to 15 and 14 to 16, rows 9 to 11.
		expect(hit(data, map, 14, 10)).toEqual({ row: 1, density: 7 });
		expect(hit(data, map, 13, 10)).toEqual({ row: 0, density: 2 });
		expect(hit(data, map, 16, 11)).toEqual({ row: 1, density: 5 });
		expect(hit(data, map, 17, 10).row).toBe(-1);
		expect(hit(data, map, 26, 26).row).toBe(2);
	});

	it('reaches a wide point centered far from the pixel, and leaves the corners of a disc out', () => {
		const map = barMap(10, 2, 4);
		const narrow: [number, number, number?, number?][] = [];
		for (let i = 0; i < 40; i++) narrow.push([4 + i / 40, 2]);
		const data = points([[3, 20, 17], ...narrow]);
		// The wide point covers columns 6 to 22; the narrow ones sit at the bottom.
		expect(hit(data, map, 6, 10).row).toBe(0);
		expect(hit(data, map, 22, 2).row).toBe(0);
		expect(hit(data, map, 23, 10).row).toBe(-1);
		const disc = points([[3, 20, 7]]);
		// Columns and rows 11 to 17: the corner pixel is outside the disc.
		expect(hit(disc, map, 11, 7, 3, true).row).toBe(-1);
		expect(hit(disc, map, 14, 7, 3, true).row).toBe(0);
		expect(hit(disc, map, 11, 7, 3, false).row).toBe(0);
	});

	it('agrees with the pixels drawn and the densities summed, everywhere', () => {
		const data = cloud(250, 9);
		const map = barMap(12, 1, 3.7);
		for (const circle of [false, true]) {
			const { pixels } = sized(data, map, 3, circle);
			const { density } = accumulate(data, map, 3, circle, true);
			for (let x = 0; x < WIDTH; x++) {
				for (let y = 0; y < HEIGHT; y++) {
					const found = hit(data, map, x, y, 3, circle);
					const pixel = pixels[x * HEIGHT + y]!;
					// The color of a point is that of its value, which is its index here.
					expect(found.row < 0 ? 0 : GREY[paletteIndex(mappingOf(0, data.time.length), found.row)]).toBe(pixel);
					expect(found.density).toBe(density[x * HEIGHT + y]);
				}
			}
		}
	});
});

describe('the largest size of a window', () => {
	it('is read from the rows, then from the rows patches change, and starts over with new rows', () => {
		const window = new MarksWindow();
		const extent = new SizeExtent();
		window.version = 1;
		window.count = 3;
		window.sizes = Float32Array.of(2, Number.NaN, 7, Number.NaN);
		expect(extent.largest(window)).toBe(7);
		window.sizes[3] = 12;
		window.count = 4;
		window.dirtyFrom = 3;
		window.dirtyTo = 4;
		window.revision++;
		expect(extent.largest(window)).toBe(12);
		window.clearDirty();
		expect(extent.largest(window)).toBe(12);
		window.version++;
		window.sizes = Float32Array.of(Number.NaN, Number.NaN);
		window.count = 2;
		expect(extent.largest(window)).toBeNaN();
		window.version++;
		window.sizes = new Float32Array(0);
		expect(extent.largest(window)).toBeNaN();
	});
});

/** A frame of the window's rows for the GL helpers. */
function frameOf(data: Points, map: TimeMap, options: Partial<typeof DEFAULT_SCATTER_OPTIONS>, ratio = 1): MarkFrame {
	const window = new MarksWindow();
	window.count = data.time.length;
	window.capacity = window.count;
	window.level = 0;
	window.time = data.time;
	window.price = data.price;
	window.values = data.values;
	window.sizes = data.sizes;
	window.counts = data.counts;
	const mapping = mappingOf(0, data.time.length);
	return {
		type: 'scatter',
		window,
		map,
		projection: LINEAR,
		mapping,
		palette: GREY,
		options: { ...DEFAULT_SCATTER_OPTIONS, ...options },
		width: WIDTH,
		height: HEIGHT,
		ratio,
		from: 0,
		to: window.count,
	};
}

/**
 * What the WebGL2 scatter kernel draws (`scatterVertex` and `scatterFragment`), run on the CPU:
 * each instance finds its column in the ranges, its row and size in the records, and covers the
 * pixels of its square, or of its disc as the fragment shader computes it in 32-bit floats.
 */
function emulateKernel(
	pixels: Uint32Array,
	ranges: Uint32Array,
	records: Uint32Array,
	words: number,
	stamp: number,
	base: number,
	circle: boolean,
	first: number,
	end: number,
	left: number,
	right: number,
): void {
	for (let id = first; id < end; id++) {
		let lo = 0;
		let hi = WIDTH + stamp - 1;
		while (lo + 1 < hi) {
			const mid = (lo + hi) >> 1;
			if (ranges[mid]! <= id) lo = mid;
			else hi = mid;
		}
		const at = words * id;
		const own = words > 2 ? records[at + 2]! : 0;
		const size = own > 0 ? own : base;
		const center = lo - (stamp - 1 - (stamp >> 1));
		const ox = center - (size >> 1);
		const oy = (records[at]! | 0) - (size >> 1);
		for (let x = Math.max(left, ox); x < Math.min(right, ox + size); x++) {
			for (let y = Math.max(0, oy); y < Math.min(HEIGHT, oy + size); y++) {
				if (circle && size >= 3) {
					const f = Math.fround;
					const r = f(size / 2);
					const d = f(f(x - ox + 0.5) - r);
					const span = f(Math.sqrt(f(Math.max(0, f(f(r * r) - f(d * d))))));
					if (y - oy < Math.floor(f(f(r - span) + 0.5)) || y - oy >= Math.floor(f(f(r + span) + 0.5))) continue;
				}
				pixels[x * HEIGHT + y] = records[at + 1]!;
			}
		}
	}
}

describe('the WebGL2 scatter kernel, run on the CPU', () => {
	it('rounds every disc up to the cap as makeStamp does, with a square root a few units off', () => {
		const f = Math.fround;
		const bits = new Uint32Array(1);
		const floats = new Float32Array(bits.buffer);
		const wrong: string[] = [];
		for (let size = 3; size <= MAX_POINT_PIXELS; size++) {
			const stamp = makeStamp(size, true);
			const r = f(size / 2);
			for (let column = 0; column < size; column++) {
				const d = f(f(column + 0.5) - r);
				floats[0] = f(Math.sqrt(f(Math.max(0, f(f(r * r) - f(d * d))))));
				const exact = bits[0]!;
				for (let error = -4; error <= 4; error++) {
					bits[0] = exact + error;
					const span = floats[0]!;
					const from = Math.max(0, Math.floor(f(f(r - span) + 0.5)));
					const to = Math.min(size, Math.floor(f(f(r + span) + 0.5)));
					if (from !== stamp.spans[column * 2] || to !== stamp.spans[column * 2 + 1])
						wrong.push(`${size}/${column}/${error}`);
				}
			}
		}
		expect(wrong).toEqual([]);
	});

	it('draws the Canvas 2D pixels from records with sizes, padded by the widest point, and in strips', () => {
		for (const circle of [false, true]) {
			const data = cloud(300, circle ? 11 : 12);
			const map = barMap(12, 1, 3.7);
			const frame = frameOf(data, map, { shape: circle ? 'circle' : 'square', pointSize: 3 });
			let stamp = 3;
			for (const size of data.sizes) if (size === size) stamp = Math.max(stamp, pointPixels(size, 1));
			const words = 3;
			const records = new Uint32Array(data.time.length * words);
			packScatterRows(frame, records, 0, data.time.length, RED, words, false);
			// Colors of the records are the palette's for each value, as Canvas 2D has them.
			for (let i = 0; i < data.time.length; i++)
				expect(records[i * words + 1]).toBe(GREY[paletteIndex(frame.mapping, data.values[i]!)]);
			const ranges = new Uint32Array(WIDTH + stamp);
			scatterBounds(frame, stamp, ranges);
			const gpu = new Uint32Array(WIDTH * HEIGHT);
			emulateKernel(gpu, ranges, records, words, stamp, 3, circle, ranges[0]!, ranges[WIDTH + stamp - 1]!, 0, WIDTH);
			const canvas = sized(data, map, 3, circle);
			expect(gpu).toEqual(canvas.pixels);
			// A strip drawn again from the rows its ranges name gives the same pixels.
			for (const [left, right] of [
				[0, 7],
				[13, 21],
				[33, WIDTH],
			] as const) {
				const strip = gpu.slice();
				for (let x = left; x < right; x++) strip.fill(0, x * HEIGHT, (x + 1) * HEIGHT);
				emulateKernel(
					strip,
					ranges,
					records,
					words,
					stamp,
					3,
					circle,
					ranges[left]!,
					ranges[right + stamp - 1]!,
					left,
					right,
				);
				expect(strip).toEqual(canvas.pixels);
			}
			// Padded by the series' size alone, wide points near a strip's edge would be left out.
			const short = new Uint32Array(WIDTH + 3);
			scatterBounds(frame, 3, short);
			const clipped = new Uint32Array(WIDTH * HEIGHT);
			emulateKernel(clipped, short, records, words, 3, 3, circle, short[0]!, short[WIDTH + 2]!, 0, WIDTH);
			expect(clipped).not.toEqual(canvas.pixels);
		}
	});

	it('packs counts as float bits for densities, and the series size as 0', () => {
		const map = barMap(10, 2, 4);
		const data = points([
			[1, 20, Number.NaN, 3],
			[2, 18.4, 4.6, 1],
			[3, -2, 0.1, 70000],
		]);
		const frame = frameOf(data, map, {}, 2);
		const records = new Uint32Array(9);
		packScatterRows(frame, records, 0, 3, RED, 3, true);
		const counts = new Float32Array(records.buffer);
		expect([records[0], records[3], records[6]! | 0]).toEqual([10, 12, 32]);
		expect([counts[1], counts[4], counts[7]]).toEqual([3, 1, 70000]);
		expect([records[2], records[5], records[8]]).toEqual([0, 9, 1]);
	});
});
