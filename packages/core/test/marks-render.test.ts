import { describe, expect, it } from 'vitest';
import { type ValueMapping, buildPalette, packColor, paletteIndex, setValueMapping } from '../src/marks/palette';
import {
	type HeatLayout,
	HeatmapScratch,
	type PixelBox,
	type PriceProjection,
	drawHeatmap,
	drawScatter,
	emptyBox,
	makeStamp,
	priceExtent,
	quantize,
	slotColors,
} from '../src/marks/render';
import { TimeMap } from '../src/marks/time-map';

const MINUTE = 60_000;
const WIDTH = 40;
const HEIGHT = 30;

/** Bars a minute apart; bar `i` is centered at `origin + i * spacing` device pixels. */
function barMap(count: number, origin: number, spacing: number): TimeMap {
	const times = new Float64Array(count);
	for (let i = 0; i < count; i++) {
		times[i] = i * MINUTE;
	}
	const map = new TimeMap();
	map.set(times, 0, count, 0, 0, 0, origin, spacing);
	return map;
}

/** Price `p` on row `30 - p`: price 0 at the bottom edge, one device pixel per unit. */
const LINEAR: PriceProjection = { offset: 30, scale: 1, log: false };

function box(): PixelBox {
	const b = { left: 0, top: 0, right: 0, bottom: 0 };
	emptyBox(b);
	return b;
}

/** The pixels that are set, as `x,y` strings, row by row. The buffer holds the pane column by column. */
function lit(pixels: Uint32Array): string[] {
	const list: string[] = [];
	for (let y = 0; y < HEIGHT; y++) {
		for (let x = 0; x < WIDTH; x++) {
			if (pixels[x * HEIGHT + y] !== 0) {
				list.push(`${x},${y}`);
			}
		}
	}
	return list;
}

const GREY = buildPalette(['#000000', '#ffffff']);
const RED = packColor(255, 0, 0, 255);

function mappingOf(min: number, max: number, log = false): ValueMapping {
	const mapping: ValueMapping = { min: 0, factor: 0, log: false };
	setValueMapping(mapping, min, max, log);
	return mapping;
}

interface Points {
	time: Float64Array;
	price: Float64Array;
	values: Float32Array;
}

function points(list: [number, number, number?][]): Points {
	return {
		time: Float64Array.from(list, p => p[0]),
		price: Float64Array.from(list, p => p[1]),
		values: Float32Array.from(list, p => p[2] ?? Number.NaN),
	};
}

function scatter(
	data: Points,
	map: TimeMap,
	size: number,
	options: { shift?: number; projection?: PriceProjection; circle?: boolean; from?: number; to?: number } = {},
): { pixels: Uint32Array; box: PixelBox } {
	const pixels = new Uint32Array(WIDTH * HEIGHT);
	const b = box();
	drawScatter(
		pixels,
		WIDTH,
		HEIGHT,
		data.time,
		data.price,
		data.values,
		options.from ?? 0,
		options.to ?? data.time.length,
		map,
		options.shift ?? 0,
		options.projection ?? LINEAR,
		GREY,
		mappingOf(0, 100),
		RED,
		makeStamp(size, options.circle === true),
		b,
	);
	return { pixels, box: b };
}

describe('drawScatter', () => {
	it('writes each point onto the device pixel its time and price round to', () => {
		const map = barMap(10, 2, 4);
		// Bar 3 is centered at pixel 14; price 20 is on row 10.
		const { pixels, box: b } = scatter(points([[3 * MINUTE, 20]]), map, 1);
		expect(lit(pixels)).toEqual(['14,10']);
		expect(pixels[14 * HEIGHT + 10]).toBe(RED);
		expect(b).toEqual({ left: 14, top: 10, right: 15, bottom: 11 });
		// Between two bars, and between two rows: rounded to the nearest pixel.
		expect(lit(scatter(points([[3.4 * MINUTE, 20.4]]), map, 1).pixels)).toEqual(['16,10']);
		expect(lit(scatter(points([[3.4 * MINUTE, 20.6]]), map, 1).pixels)).toEqual(['16,9']);
	});

	it('stamps a square of the point size around the pixel', () => {
		const map = barMap(10, 2, 4);
		const { pixels, box: b } = scatter(points([[3 * MINUTE, 20]]), map, 3);
		expect(lit(pixels)).toEqual(['13,9', '14,9', '15,9', '13,10', '14,10', '15,10', '13,11', '14,11', '15,11']);
		expect(b).toEqual({ left: 13, top: 9, right: 16, bottom: 12 });
		// An even size reaches one pixel further up and left.
		expect(lit(scatter(points([[3 * MINUTE, 20]]), map, 2).pixels)).toEqual(['13,9', '14,9', '13,10', '14,10']);
	});

	it('stamps a disc for a circle of three pixels or more, a square below', () => {
		expect([...makeStamp(5, true).spans]).toEqual([1, 4, 0, 5, 0, 5, 0, 5, 1, 4]);
		expect([...makeStamp(2, true).spans]).toEqual([0, 2, 0, 2]);
		expect([...makeStamp(3, false).spans]).toEqual([0, 3, 0, 3, 0, 3]);
		const map = barMap(10, 2, 4);
		const { pixels } = scatter(points([[3 * MINUTE, 20]]), map, 5, { circle: true });
		// 21 of the 25 pixels: the corners are left out.
		expect(lit(pixels).length).toBe(21);
		expect(pixels[12 * HEIGHT + 8]).toBe(0);
		expect(pixels[13 * HEIGHT + 8]).toBe(RED);
	});

	it('colors a point by its value, and with the series color without one', () => {
		const map = barMap(10, 2, 4);
		const { pixels } = scatter(
			points([
				[1 * MINUTE, 5, 0],
				[2 * MINUTE, 5, 100],
				[3 * MINUTE, 5, 50],
				[4 * MINUTE, 5],
				[5 * MINUTE, 5, 1e9],
			]),
			map,
			1,
		);
		expect(pixels[6 * HEIGHT + 25]).toBe(GREY[0]);
		expect(pixels[10 * HEIGHT + 25]).toBe(GREY[255]);
		expect(pixels[14 * HEIGHT + 25]).toBe(GREY[paletteIndex(mappingOf(0, 100), 50)]);
		expect(pixels[18 * HEIGHT + 25]).toBe(RED);
		expect(pixels[22 * HEIGHT + 25]).toBe(GREY[255]);
	});

	it('lets a later point overwrite an earlier one, and draws only the rows asked for', () => {
		const map = barMap(10, 2, 4);
		const data = points([
			[3 * MINUTE, 20, 0],
			[3 * MINUTE, 20, 100],
			[5 * MINUTE, 20, 100],
		]);
		expect(scatter(data, map, 1).pixels[14 * HEIGHT + 10]).toBe(GREY[255]);
		expect(lit(scatter(data, map, 1, { from: 2, to: 3 }).pixels)).toEqual(['22,10']);
		expect(lit(scatter(data, map, 1, { from: 1, to: 1 }).pixels)).toEqual([]);
	});

	it('clips points at the edges of the pane and skips those outside', () => {
		const map = barMap(10, 0, 4);
		const { pixels, box: b } = scatter(
			points([
				[0, 30],
				[-MINUTE, 15],
				[9.75 * MINUTE, 0],
				[20 * MINUTE, 15],
				[5 * MINUTE, 500],
				[5 * MINUTE, -500],
			]),
			map,
			3,
		);
		// Top left corner: the lower right four pixels of the first point. Bottom right: one pixel
		// of the third (centered on the pixel right of the pane, one row below it).
		expect(lit(pixels)).toEqual(['0,0', '1,0', '0,1', '1,1', '38,29', '39,29']);
		expect(b).toEqual({ left: 0, top: 0, right: 40, bottom: 30 });
	});

	it('shifts points placed from the start of their bar, and follows a logarithmic or inverted scale', () => {
		const map = barMap(10, 2, 4);
		// Half a bar to the left: bar 3 starts at pixel 12.
		expect(lit(scatter(points([[3 * MINUTE, 20]]), map, 1, { shift: -2 }).pixels)).toEqual(['12,10']);
		// A point half a minute into the bar is in the middle of it.
		expect(lit(scatter(points([[3.5 * MINUTE, 20]]), map, 1, { shift: -2 }).pixels)).toEqual(['14,10']);
		// log10(100) = 2: row 30 - 2 * 10.
		const log: PriceProjection = { offset: 30, scale: 10, log: true };
		expect(lit(scatter(points([[3 * MINUTE, 100]]), map, 1, { projection: log }).pixels)).toEqual(['14,10']);
		// A price a logarithmic scale cannot show is not drawn.
		expect(
			lit(
				scatter(
					points([
						[3 * MINUTE, 0],
						[3 * MINUTE, -5],
					]),
					map,
					1,
					{ projection: log },
				).pixels,
			),
		).toEqual([]);
		const inverted: PriceProjection = { offset: 0, scale: -1, log: false };
		expect(lit(scatter(points([[3 * MINUTE, 20]]), map, 1, { projection: inverted }).pixels)).toEqual(['14,20']);
	});

	it('walks many points through the bars in one pass', () => {
		const map = barMap(10, 0, 4);
		const list: [number, number][] = [];
		for (let i = 0; i < 1000; i++) {
			list.push([(i / 1000) * 9 * MINUTE, 15]);
		}
		const { pixels, box: b } = scatter(points(list), map, 1);
		// Every pixel column from bar 0 to bar 9 has a point.
		const columns = new Set(lit(pixels).map(at => Number(at.split(',')[0])));
		expect(columns.size).toBe(37);
		expect(b).toEqual({ left: 0, top: 15, right: 37, bottom: 16 });
	});

	it('takes the lowest and highest price of a range of points', () => {
		const out = { low: 0, high: 0 };
		priceExtent(Float64Array.of(5, 3, 9, 1, 7), 1, 3, out);
		expect(out).toEqual({ low: 3, high: 9 });
		priceExtent(Float64Array.of(5, 3), 1, 1, out);
		expect(out.low > out.high).toBe(true);
	});
});

interface Heat {
	time: Float64Array;
	slots: Uint8Array;
	rows: number;
	count: number;
}

/** `count` columns a minute apart from minute `first`, slot `slot(c, r)` in cell `r` of column `c`. */
function heat(count: number, rows: number, slot: (c: number, r: number) => number, first = 0, step = 1): Heat {
	const time = new Float64Array(count);
	const slots = new Uint8Array(count * rows);
	for (let c = 0; c < count; c++) {
		time[c] = (first + c * step) * MINUTE;
		for (let r = 0; r < rows; r++) {
			slots[c * rows + r] = slot(c, r);
		}
	}
	return { time, slots, rows, count };
}

/** Slot `s` is drawn as the number `s`, so a pixel tells which cell it shows. */
const IDENTITY = Uint32Array.from({ length: 256 }, (_, i) => i);

/** Cells of `rows` per column from grid row 0: a grid that does not follow the price. */
function layoutOf(rows: number, priceStart: number, priceStep: number): HeatLayout {
	return {
		rows,
		priceStart,
		priceStep,
		varying: false,
		cellStart: column => column * rows,
		cellOffset: () => 0,
		cellLength: () => rows,
	};
}

function heatmap(
	data: Heat,
	map: TimeMap,
	options: {
		priceStart?: number;
		priceStep?: number;
		projection?: PriceProjection;
		from?: number;
		to?: number;
		clipLeft?: number;
		clipRight?: number;
		pixels?: Uint32Array;
	} = {},
): { pixels: Uint32Array; box: PixelBox } {
	const pixels = options.pixels ?? new Uint32Array(WIDTH * HEIGHT);
	const b = box();
	drawHeatmap(
		pixels,
		WIDTH,
		HEIGHT,
		data.time,
		data.slots,
		layoutOf(data.rows, options.priceStart ?? 0, options.priceStep ?? 5),
		data.count,
		options.from ?? 0,
		options.to ?? data.count,
		map,
		options.projection ?? LINEAR,
		IDENTITY,
		new HeatmapScratch(),
		options.clipLeft ?? 0,
		options.clipRight ?? WIDTH,
		b,
	);
	return { pixels, box: b };
}

/** The pixel at `(x, y)`. */
function pixelAt(pixels: Uint32Array, x: number, y: number): number {
	return pixels[x * HEIGHT + y]!;
}

describe('drawHeatmap', () => {
	it('fills each cell from its bar edge to the next and between the rows of its prices', () => {
		// Bars 4 pixels wide, bar 0 centered at 6: column 0 covers pixels 4 to 7. Cells 5 high in
		// price: cell 0 covers rows 25 to 29.
		const map = barMap(10, 6, 4);
		const { pixels, box: b } = heatmap(
			heat(3, 2, (c, r) => 1 + c * 2 + r),
			map,
		);
		expect(b).toEqual({ left: 4, top: 20, right: 16, bottom: 30 });
		for (let c = 0; c < 3; c++) {
			for (let r = 0; r < 2; r++) {
				const slot = 1 + c * 2 + r;
				for (let x = 4 + c * 4; x < 8 + c * 4; x++) {
					for (let y = 25 - r * 5; y < 30 - r * 5; y++) {
						expect(pixelAt(pixels, x, y)).toBe(slot);
					}
				}
			}
		}
		// Nothing outside the grid.
		expect(lit(pixels).length).toBe(12 * 10);
	});

	it('leaves no seam between cells whose edges are not whole pixels', () => {
		// Bars 3.3 pixels wide, cells 3.7 pixels high: every pixel inside the grid belongs to one cell.
		const map = barMap(12, 1.65, 3.3);
		const { pixels, box: b } = heatmap(
			heat(10, 6, () => 9),
			map,
			{ priceStep: 3.7 },
		);
		expect(b).toEqual({ left: 0, top: 8, right: 33, bottom: 30 });
		expect(lit(pixels).length).toBe(33 * 22);
	});

	it('gives the last column the width of the one before it, or of a bar when it is alone', () => {
		const map = barMap(10, 6, 4);
		// Columns two bars apart: the last is two bars wide as well.
		expect(
			heatmap(
				heat(2, 1, () => 1, 0, 2),
				map,
			).box,
		).toEqual({ left: 4, top: 25, right: 20, bottom: 30 });
		expect(
			heatmap(
				heat(1, 1, () => 1, 3),
				map,
			).box,
		).toEqual({ left: 16, top: 25, right: 20, bottom: 30 });
		// A range that ends before the last column ends where the next column starts.
		expect(
			heatmap(
				heat(3, 1, () => 1),
				map,
				{ to: 2 },
			).box,
		).toEqual({ left: 4, top: 25, right: 12, bottom: 30 });
	});

	it('takes the highest of the cells that share a pixel across', () => {
		// Four columns per pixel: bars a quarter of a pixel wide.
		const map = barMap(200, 0.125, 0.25);
		const data = heat(160, 1, c => (c === 41 ? 200 : 1 + (c % 4)));
		const { pixels, box: b } = heatmap(data, map);
		expect(b).toEqual({ left: 0, top: 25, right: 40, bottom: 30 });
		// Columns 40 to 43 share pixel 10: the peak in column 41 shows.
		expect(pixelAt(pixels, 10, 27)).toBe(200);
		expect(pixelAt(pixels, 9, 27)).toBe(4);
		expect(pixelAt(pixels, 11, 27)).toBe(4);
	});

	it('takes the highest of the cells that share a pixel down', () => {
		// Four cells per pixel row.
		const map = barMap(10, 6, 4);
		const data = heat(1, 80, (_c, r) => (r === 41 ? 200 : 1 + (r % 4)));
		const { pixels, box: b } = heatmap(data, map, { priceStep: 0.25 });
		expect(b).toEqual({ left: 4, top: 10, right: 8, bottom: 30 });
		// Cells 40 to 43 cover prices 10 to 11, the pixel row 19.
		expect(pixelAt(pixels, 5, 19)).toBe(200);
		expect(pixelAt(pixels, 5, 18)).toBe(4);
		expect(pixelAt(pixels, 5, 20)).toBe(4);
	});

	it('draws a cell without a value as nothing', () => {
		const map = barMap(10, 6, 4);
		const { pixels } = heatmap(
			heat(2, 2, (c, r) => (c === r ? 0 : 7)),
			map,
		);
		expect(pixelAt(pixels, 5, 27)).toBe(0);
		expect(pixelAt(pixels, 5, 22)).toBe(7);
		expect(pixelAt(pixels, 9, 27)).toBe(7);
		expect(pixelAt(pixels, 9, 22)).toBe(0);
	});

	it('clips the grid to the pane without letting cells outside it bleed in', () => {
		// The grid is taller and wider than the pane; cells outside have the highest slot.
		const map = barMap(40, -38, 4);
		const data = heat(30, 20, (c, r) => (c < 10 || c >= 20 || r < 4 || r >= 10 ? 250 : 1 + r));
		// Cells 5 high from price -20: cells 4 to 9 cover prices 0 to 30, the pane.
		const { pixels, box: b } = heatmap(data, map, { priceStart: -20 });
		expect(b).toEqual({ left: 0, top: 0, right: 40, bottom: 30 });
		// Columns 10 to 19 cover pixels 0 to 39.
		for (let x = 0; x < WIDTH; x++) {
			for (let r = 4; r < 10; r++) {
				expect(pixelAt(pixels, x, 29 - (r - 4) * 5)).toBe(1 + r);
				expect(pixelAt(pixels, x, 25 - (r - 4) * 5)).toBe(1 + r);
			}
		}
	});

	it('draws only the device columns asked for', () => {
		const map = barMap(10, 6, 4);
		const pixels = new Uint32Array(WIDTH * HEIGHT).fill(99);
		const { box: b } = heatmap(
			heat(5, 1, c => 1 + c),
			map,
			{ pixels, clipLeft: 10, clipRight: 18 },
		);
		expect(b).toEqual({ left: 10, top: 25, right: 18, bottom: 30 });
		expect([8, 9, 10, 11, 12, 15, 16, 17, 18, 19].map(x => pixelAt(pixels, x, 27))).toEqual([
			99, 99, 2, 2, 3, 3, 4, 4, 99, 99,
		]);
	});

	it('follows a logarithmic and an inverted price scale', () => {
		const map = barMap(10, 6, 4);
		// Cells at prices 1, 10, 100 on a logarithmic scale are not evenly high; here cells are 30
		// wide in price from 10: edges at 10, 40, 70, 100 are rows 20, 14, 12, 10.
		const log: PriceProjection = { offset: 30, scale: 10, log: true };
		const { pixels, box: b } = heatmap(
			heat(1, 3, (_c, r) => 1 + r),
			map,
			{ priceStart: 10, priceStep: 30, projection: log },
		);
		expect(b).toEqual({ left: 4, top: 10, right: 8, bottom: 20 });
		expect([19, 14, 13, 12, 11, 10].map(y => pixelAt(pixels, 5, y))).toEqual([1, 1, 2, 2, 3, 3]);
		// A grid that starts at 0, which a logarithmic scale cannot show: its lowest cell reaches the bottom.
		const fromZero = heatmap(
			heat(1, 2, (_c, r) => 1 + r),
			map,
			{ priceStart: 0, priceStep: 10, projection: log },
		);
		expect(fromZero.box).toEqual({ left: 4, top: 17, right: 8, bottom: 30 });
		const inverted: PriceProjection = { offset: 0, scale: -1, log: false };
		const down = heatmap(
			heat(1, 2, (_c, r) => 1 + r),
			map,
			{ projection: inverted },
		);
		expect(down.box).toEqual({ left: 4, top: 0, right: 8, bottom: 10 });
		expect(pixelAt(down.pixels, 5, 2)).toBe(1);
		expect(pixelAt(down.pixels, 5, 7)).toBe(2);
	});
});

describe('slots of heatmap cells', () => {
	it('turns values into slots 1 to 255, and a cell without a value into slot 0', () => {
		const values = Float32Array.of(0, 50, 100, Number.NaN, -10, 1000);
		const slots = new Uint8Array(6);
		quantize(values, slots, 0, 6, mappingOf(0, 100));
		expect([...slots]).toEqual([1, 128, 255, 0, 1, 255]);
		// Only the columns asked for.
		const part = new Uint8Array(6);
		quantize(values, part, 2, 4, mappingOf(0, 100));
		expect([...part]).toEqual([0, 0, 255, 0, 0, 0]);
		const log = new Uint8Array(3);
		quantize(Float32Array.of(1, 10, 100), log, 0, 3, mappingOf(1, 100, true));
		expect([...log]).toEqual([1, 128, 255]);
	});

	it('spans the palette over the slots, with slot 0 transparent', () => {
		const colors = new Uint32Array(256);
		slotColors(GREY, colors);
		expect(colors[0]).toBe(0);
		expect(colors[1]).toBe(GREY[0]);
		expect(colors[255]).toBe(GREY[255]);
		expect(colors[128]).toBe(GREY[128]);
	});
});
