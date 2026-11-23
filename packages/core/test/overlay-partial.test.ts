import {
	type ChartApi,
	type ChartOptions,
	type DeepPartial,
	type DrawingInput,
	type DrawTarget,
	type PanePrimitive,
	type SeriesApi,
	createChart,
} from '@lumen-charts/core';
import { afterEach, assert, describe, expect, it, vi } from 'vitest';

// A cursor frame clears and draws again only where the crosshair and the highlights of drawings
// were and are (`OverlayRenderer`). The layer must end up as a full redraw leaves it. No canvas
// rasterizes here, so the test rasterizes a model: every pixel keeps a hash of what was drawn on it
// since it was last cleared, in order, so a pixel drawn twice, drawn in another order, not cleared or
// left out differs from a full redraw. A shape colors the pixels a canvas can color with it: a
// rectangle its pixels, text a box wider and taller than its glyphs (more than half the font size
// above and below the middle), a circle its box and a pixel more for antialiasing, all through the
// clip. The pixels themselves are compared in a browser by `pnpm bench:pixels --case overlay`.

interface State {
	fillStyle: string;
	strokeStyle: string;
	lineWidth: number;
	font: string;
	textAlign: string;
	textBaseline: string;
	globalAlpha: number;
	lineDash: string;
	tx: number;
	ty: number;
	/** Pixels the clip lets through, or null for all. */
	clip: Uint8Array | null;
	/** The clip is made of several rectangles, under which a browser rasterizes shapes otherwise. */
	complex: boolean;
}

type Shape =
	| { kind: 'rect'; x: number; y: number; w: number; h: number }
	| { kind: 'arc'; x: number; y: number; r: number }
	| { kind: 'line'; points: number[] };

function hash(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
	}
	return (h >>> 0) | 1;
}

/** A 2D context that rasterizes the model described above into `pixels`. */
class ModelContext {
	public pixels = new Uint32Array(0);
	public width = 0;
	public height = 0;
	/** Calls of the frames since the last `take`, by name, with the arguments of `clearRect`. */
	public clears: number[][] = [];
	public clips = 0;
	private _state: State = {
		fillStyle: '#000000',
		strokeStyle: '#000000',
		lineWidth: 1,
		font: '10px sans-serif',
		textAlign: 'start',
		textBaseline: 'alphabetic',
		globalAlpha: 1,
		lineDash: '',
		tx: 0,
		ty: 0,
		clip: null,
		complex: false,
	};
	private readonly _stack: State[] = [];
	/** Which pixels the current paint has colored, by the stamp of that paint. */
	private _seen = new Uint32Array(0);
	private _stamp = 0;
	private _path: Shape[] = [];
	private readonly _canvas: HTMLCanvasElement;

	private readonly _models: ReadonlyMap<HTMLCanvasElement, ModelContext>;

	public constructor(canvas: HTMLCanvasElement, models: ReadonlyMap<HTMLCanvasElement, ModelContext>) {
		this._canvas = canvas;
		this._models = models;
	}

	/** Takes the size of the canvas; a new size clears it, as it clears a canvas. */
	private _sync(): void {
		const { width, height } = this._canvas;
		if (width !== this.width || height !== this.height) {
			this.width = width;
			this.height = height;
			this.pixels = new Uint32Array(width * height);
			this._state.clip = null;
		}
	}

	private _region(x0: number, y0: number, x1: number, y1: number, visit: (index: number) => void): void {
		this._sync();
		const left = Math.max(0, Math.floor(x0));
		const top = Math.max(0, Math.floor(y0));
		const right = Math.min(this.width, Math.ceil(x1));
		const bottom = Math.min(this.height, Math.ceil(y1));
		const clip = this._state.clip;
		for (let y = top; y < bottom; y++) {
			for (let x = left; x < right; x++) {
				const index = y * this.width + x;
				if (clip === null || clip[index] === 1) {
					visit(index);
				}
			}
		}
	}

	/** Colors the union of `boxes` once with `id`. */
	private _paint(boxes: number[][], id: number): void {
		this._sync();
		if (this._seen.length !== this.pixels.length) {
			this._seen = new Uint32Array(this.pixels.length);
		}
		const seen = this._seen;
		const stamp = ++this._stamp;
		for (const [x0, y0, x1, y1] of boxes) {
			this._region(x0!, y0!, x1!, y1!, index => {
				if (seen[index] !== stamp) {
					seen[index] = stamp;
					this.pixels[index] = (Math.imul(this.pixels[index]!, 31) + id) >>> 0;
				}
			});
		}
	}

	/**
	 * What a shape is drawn with. Through a clip of several rectangles Chromium antialiases the edges
	 * of shapes otherwise (by up to a whole value): such a shape colors its pixels otherwise.
	 */
	private _style(kind: string): string {
		const s = this._state;
		const clip = s.complex ? '|complex clip' : '';
		return kind === 'fill'
			? `${s.fillStyle}|${s.globalAlpha}${clip}`
			: `${s.strokeStyle}|${s.globalAlpha}|${s.lineWidth}|${s.lineDash}${clip}`;
	}

	private _fontSize(): number {
		const match = /(\d+(?:\.\d+)?)px/.exec(this._state.font);
		return match === null ? 10 : Number(match[1]);
	}

	/** Boxes a path colors when filled (`reach` 0) or stroked (`reach` half the line width). */
	private _boxes(reach: number): number[][] {
		const boxes: number[][] = [];
		for (const shape of this._path) {
			if (shape.kind === 'rect') {
				boxes.push([shape.x - reach, shape.y - reach, shape.x + shape.w + reach, shape.y + shape.h + reach]);
			} else if (shape.kind === 'arc') {
				const r = shape.r + reach + 1;
				boxes.push([shape.x - r, shape.y - r, shape.x + r, shape.y + r]);
			} else {
				const p = shape.points;
				for (let i = 0; i + 3 < p.length; i += 2) {
					const r = reach + 1;
					boxes.push([
						Math.min(p[i]!, p[i + 2]!) - r,
						Math.min(p[i + 1]!, p[i + 3]!) - r,
						Math.max(p[i]!, p[i + 2]!) + r,
						Math.max(p[i + 1]!, p[i + 3]!) + r,
					]);
				}
			}
		}
		return boxes;
	}

	public get context(): CanvasRenderingContext2D {
		const methods: Record<string, (...args: never[]) => unknown> = {
			save: () => this._stack.push({ ...this._state }),
			restore: () => {
				this._state = this._stack.pop() ?? this._state;
			},
			translate: (x: number, y: number) => {
				this._state.tx += x;
				this._state.ty += y;
			},
			setTransform: (a = 1, b = 0, c = 0, d = 1, e = 0, f = 0) => {
				if (typeof a === 'number' && a === 1 && b === 0 && c === 0 && d === 1) {
					this._state.tx = e;
					this._state.ty = f;
				}
			},
			beginPath: () => {
				this._path = [];
			},
			moveTo: (x: number, y: number) =>
				this._path.push({ kind: 'line', points: [x + this._state.tx, y + this._state.ty] }),
			lineTo: (x: number, y: number) => {
				const last = this._path.at(-1);
				if (last?.kind === 'line') last.points.push(x + this._state.tx, y + this._state.ty);
			},
			closePath: () => {},
			rect: (x: number, y: number, w: number, h: number) =>
				this._path.push({ kind: 'rect', x: x + this._state.tx, y: y + this._state.ty, w, h }),
			arc: (x: number, y: number, r: number) =>
				this._path.push({ kind: 'arc', x: x + this._state.tx, y: y + this._state.ty, r }),
			clip: () => {
				this._sync();
				this.clips++;
				const mask = new Uint8Array(this.width * this.height);
				for (const shape of this._path) {
					// The chart clips to rectangles only.
					assert.equal(shape.kind, 'rect');
				}
				const outer = this._state.clip;
				this._state.clip = null;
				for (const [x0, y0, x1, y1] of this._boxes(0)) {
					this._region(x0!, y0!, x1!, y1!, index => {
						if (outer === null || outer[index] === 1) mask[index] = 1;
					});
				}
				this._state.clip = mask;
				if (this._path.length > 1) this._state.complex = true;
			},
			fill: () => {
				const id = hash(`fill|${this._style('fill')}|${JSON.stringify(this._path)}`);
				this._paint(this._boxes(0), id);
			},
			stroke: () => {
				const id = hash(`stroke|${this._style('stroke')}|${JSON.stringify(this._path)}`);
				this._paint(this._boxes(this._state.lineWidth / 2), id);
			},
			fillRect: (x: number, y: number, w: number, h: number) => {
				if (!(w > 0 && h > 0)) return;
				const x0 = x + this._state.tx;
				const y0 = y + this._state.ty;
				// A rectangle of whole pixels covers each of them fully: its color is all that counts,
				// so the pieces of a rectangle color its pixels as it does. Otherwise its edges count.
				const whole = [x0, y0, w, h].every(Number.isInteger);
				const id = hash(`fillRect|${this._style('fill')}${whole ? '' : `|${x0},${y0},${w},${h}`}`);
				this._paint([[x0, y0, x0 + w, y0 + h]], id);
			},
			strokeRect: (x: number, y: number, w: number, h: number) => {
				const kept = this._path;
				this._path = [{ kind: 'rect', x: x + this._state.tx, y: y + this._state.ty, w, h }];
				methods['stroke']!();
				this._path = kept;
			},
			clearRect: (x: number, y: number, w: number, h: number) => {
				const x0 = x + this._state.tx;
				const y0 = y + this._state.ty;
				this.clears.push([x0, y0, w, h]);
				this._region(x0, y0, x0 + w, y0 + h, index => {
					this.pixels[index] = 0;
				});
			},
			fillText: (text: string, x: number, y: number) => {
				const s = this._state;
				const size = this._fontSize();
				const width = text.length * size * 0.6;
				const x0 = x + s.tx;
				const y0 = y + s.ty;
				const left =
					s.textAlign === 'center'
						? x0 - width / 2
						: s.textAlign === 'right' || s.textAlign === 'end'
							? x0 - width
							: x0;
				// Taller than the glyphs of a font: more than half the size above and below the middle.
				const top = s.textBaseline === 'middle' ? y0 - size * 0.75 : y0 - size;
				const id = hash(
					`text|${text}|${s.fillStyle}|${s.font}|${s.textAlign}|${s.textBaseline}|${x0},${y0}|${s.complex}`,
				);
				this._paint([[left, top, left + width, top + size * 1.5]], id);
			},
			// A copy of pixels of another canvas, one to one: each pixel drawn there is drawn here as it
			// was drawn there, and a transparent one leaves what is here.
			drawImage: (...args: unknown[]) => {
				const [source, sx, sy, sw, sh, dx, dy, dw, dh] = args as [HTMLCanvasElement, ...number[]];
				assert.lengthOf(args, 9);
				assert.deepEqual([dw, dh], [sw, sh]);
				const model = this._models.get(source)!;
				const x0 = dx! + this._state.tx;
				const y0 = dy! + this._state.ty;
				this._region(x0, y0, x0 + dw!, y0 + dh!, index => {
					const x = (index % this.width) - x0 + sx!;
					const y = Math.floor(index / this.width) - y0 + sy!;
					const value =
						x >= 0 && y >= 0 && x < model.width && y < model.height ? model.pixels[y * model.width + x]! : 0;
					if (value !== 0) {
						this.pixels[index] = (Math.imul(this.pixels[index]!, 31) + value) >>> 0;
					}
				});
			},
			measureText: (text: string) => ({ width: text.length * this._fontSize() * 0.6 }),
			setLineDash: (dash: number[]) => {
				this._state.lineDash = dash.join(',');
			},
			getLineDash: () => [],
		};
		return new Proxy({} as Record<string, unknown>, {
			get: (_target, property: string) => {
				if (property in this._state && property !== 'clip') {
					return this._state[property as keyof State];
				}
				if (property === 'canvas') return this._canvas;
				// Anything else the chart calls draws nothing on the overlay.
				return methods[property] ?? (() => undefined);
			},
			set: (_target, property: string, value) => {
				(this._state as unknown as Record<string, unknown>)[property] = value;
				return true;
			},
		}) as unknown as CanvasRenderingContext2D;
	}
}

const MINUTE = 60_000;

function candles(count: number) {
	const time = new Float64Array(count);
	const open = new Float64Array(count);
	const high = new Float64Array(count);
	const low = new Float64Array(count);
	const close = new Float64Array(count);
	for (let i = 0; i < count; i++) {
		const base = 100 + Math.sin(i / 50) * 10 + Math.sin(i * 1.7) * 0.8;
		time[i] = i * MINUTE;
		open[i] = base;
		close[i] = base + (i % 3 === 0 ? 1.3 : -0.9);
		high[i] = base + 2;
		low[i] = base - 2;
	}
	return { time, open, high, low, close };
}

const COUNT = 600;

const point = (bar: number, price: number) => ({ time: bar * MINUTE, price });

/** The drawings of the tests: every tool, over the bars in view. */
function drawings(): DrawingInput[] {
	return [
		{ type: 'trendLine', points: [point(470, 95), point(540, 108)] },
		{ type: 'ray', points: [point(480, 104), point(500, 101)], options: { color: 'rgba(200, 30, 30, 0.5)' } },
		{ type: 'extendedLine', points: [point(500, 92), point(520, 96)] },
		{ type: 'horizontalLine', points: [point(510, 103)], options: { lineStyle: 'dashed' } },
		{ type: 'verticalLine', points: [point(560, 100)] },
		{ type: 'rectangle', points: [point(490, 99), point(530, 94)], options: { fillColor: 'rgba(0, 0, 255, 0.2)' } },
		{ type: 'parallelChannel', points: [point(450, 97), point(500, 99), point(450, 101)] },
		{ type: 'fibRetracement', points: [point(545, 92), point(585, 106)] },
		{ type: 'text', points: [point(465, 107)], options: { text: 'Note' } },
		{ type: 'priceRange', points: [point(570, 96), point(590, 102)] },
	];
}

/** A chart on model contexts, stepped frame by frame. */
class Harness {
	public readonly chart: ChartApi;
	private readonly _container: HTMLDivElement;
	private readonly _models = new Map<HTMLCanvasElement, ModelContext>();
	private readonly _frames: ((now: number) => void)[] = [];
	private _now = 0;
	public partial = 0;
	public full = 0;
	public kept = 0;
	public series: {
		bars: SeriesApi<'candlestick'>;
		near: SeriesApi<'line'>;
		left: SeriesApi<'line'>;
	} | null = null;

	public constructor(options: DeepPartial<ChartOptions>, ratio: number) {
		vi.spyOn(window, 'devicePixelRatio', 'get').mockImplementation(() => ratio);
		this._container = document.body.appendChild(document.createElement('div'));
		vi.stubGlobal('requestAnimationFrame', (callback: (now: number) => void) => this._frames.push(callback));
		vi.stubGlobal('cancelAnimationFrame', () => {});
		const models = this._models;
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
			let model = models.get(this);
			if (model === undefined) {
				model = new ModelContext(this, models);
				models.set(this, model);
			}
			return model.context;
		} as unknown as HTMLCanvasElement['getContext']);
		this.chart = createChart(this._container, { autoSize: false, width: 480, height: 300, worker: false, ...options });
		vi.spyOn(this.chart.element(), 'getBoundingClientRect').mockImplementation(
			() => ({ left: 0, top: 0, width: 480, height: 300 }) as DOMRect,
		);
	}

	public destroy(): void {
		this.chart.destroy();
		this._container.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	}

	private get _overlay(): ModelContext {
		const canvases = this.chart.element().querySelectorAll('canvas');
		return this._models.get(canvases[canvases.length - 1]!)!;
	}

	public async settle(): Promise<void> {
		const state = { done: false };
		void this.chart.whenIdle().then(() => {
			state.done = true;
		});
		for (let i = 0; i < 500 && !state.done; i++) {
			for (const frame of this._frames.splice(0)) {
				this._now += 16;
				frame(this._now);
			}
			// oxlint-disable-next-line no-await-in-loop
			await new Promise(resolve => setTimeout(resolve, 0));
		}
		assert.isTrue(state.done, 'the chart settles');
	}

	public pointer(type: string, x: number, y: number, init: PointerEventInit = {}): void {
		this.chart
			.element()
			.dispatchEvent(
				new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', bubbles: true, ...init }),
			);
	}

	/** Classifies what the overlay's frames did since the last call: cleared all of it, some, or nothing. */
	public classify(): 'full' | 'partial' | 'kept' {
		const overlay = this._overlay;
		const clears = overlay.clears;
		overlay.clears = [];
		const whole = clears.some(([x, y, w, h]) => x === 0 && y === 0 && w === overlay.width && h === overlay.height);
		const mode = whole ? 'full' : clears.length > 0 ? 'partial' : 'kept';
		this[mode]++;
		return mode;
	}

	public pixels(): Uint32Array {
		return this._overlay.pixels.slice();
	}

	/** Draws everything again without changing anything: two changes of an option that cancel out. */
	public async redraw(): Promise<Uint32Array> {
		const visible = this.chart.options().grid.vertLines.visible;
		this.chart.applyOptions({ grid: { vertLines: { visible: !visible } } });
		this.chart.applyOptions({ grid: { vertLines: { visible } } });
		await this.settle();
		assert.equal(this.classify(), 'full', 'a redraw clears the whole overlay');
		this.full--;
		return this.pixels();
	}

	/** The first pixel at which two snapshots of the overlay differ, or null. */
	public difference(a: Uint32Array, b: Uint32Array): string | null {
		const width = this._overlay.width;
		for (let i = 0; i < a.length; i++) {
			if (a[i] !== b[i]) {
				return `pixel ${i % width}, ${Math.floor(i / width)} of ${width} × ${a.length / width}`;
			}
		}
		return a.length === b.length ? null : 'another size';
	}

	/** Pane position of a bar and a price, CSS pixels from the chart's top left corner. */
	public at(bar: number, price: number): { x: number; y: number } {
		const x = this.chart.timeScale().logicalToCoordinate(bar)!;
		const y = this.chart.priceScale().priceToCoordinate(price)!;
		const left = Number.parseFloat(this.chart.element().querySelectorAll('canvas')[0]!.style.left);
		return { x: x + left, y };
	}
}

/** A chart with candles, two lines with markers on two axes, and the drawings, in view. */
async function setup(options: DeepPartial<ChartOptions>, ratio: number): Promise<Harness> {
	const h = new Harness(options, ratio);
	const data = candles(COUNT);
	const bars = h.chart.addSeries('candlestick');
	bars.setData(data);
	const close = data.close;
	const near = h.chart.addSeries('line', { color: 'rgba(30, 120, 220, 0.8)' });
	near.setData({ time: data.time, value: close.map(value => value + 1.5) });
	const left = h.chart.addSeries('line', { priceScaleId: 'left', color: '#d08020', priceLineStyle: 'dotted' });
	left.setData({ time: data.time, value: close.map((value, i) => value * 10 + i) });
	h.series = { bars, near, left };
	h.chart.timeScale().setVisibleLogicalRange({ from: 440, to: 610 });
	await h.settle();
	const set = h.chart.drawings();
	for (const drawing of drawings()) {
		set.add(drawing);
	}
	await h.settle();
	return h;
}

/** Pointer positions that cross the drawings, their handles and the last price, and leave the pane. */
function path(h: Harness): (readonly [number, number] | 'leave')[] {
	const steps: (readonly [number, number] | 'leave')[] = [];
	const on = (bar: number, price: number, dx = 0, dy = 0) => {
		const { x, y } = h.at(bar, price);
		steps.push([x + dx, y + dy]);
	};
	on(470, 95); // a handle of the trend line
	on(505, 101.5); // on the trend line
	on(505, 101.5, 0, 9); // beside it
	on(480, 104); // the ray's handle
	on(510, 103, 7, 0); // the horizontal line
	on(510, 103, 7, 20);
	on(560, 98); // the vertical line
	on(490, 99); // a corner of the rectangle
	on(510, 96.5); // inside it
	on(545, 92); // the Fibonacci retracement
	on(580, 99); // the price range
	on(599, 100); // the last bar
	steps.push('leave');
	on(450, 97); // the channel
	on(465, 107, 4, -4); // the text
	const last = h.chart.priceScale().coordinateToPrice(0);
	assert.isNotNull(last);
	// Along the price line of the candles, where the crosshair's label covers the last value's.
	on(599, candles(COUNT).close[COUNT - 1]!, -40, 0);
	on(599, candles(COUNT).close[COUNT - 1]!, -60, 3);
	// Over the price axis and below the pane: the crosshair goes.
	steps.push([470, 150], [200, 295]);
	on(530, 100);
	steps.push('leave');
	return steps;
}

describe.each([1, 1.5, 2])('a cursor frame of the overlay at pixel ratio %s', { timeout: 30_000 }, ratio => {
	let h: Harness | null = null;
	afterEach(() => {
		h?.destroy();
		h = null;
	});

	/**
	 * Walks the path: after every step (`each`), or after every fourth and at the end (`run`), the
	 * overlay must hold what a full redraw of the same state draws.
	 */
	async function walk(harness: Harness, every: number): Promise<void> {
		await harness.redraw();
		const steps = path(harness);
		for (let i = 0; i < steps.length; i++) {
			const step = steps[i]!;
			if (step === 'leave') {
				harness.pointer('pointerleave', 0, 0);
			} else {
				harness.pointer('pointermove', step[0], step[1]);
			}
			// oxlint-disable-next-line no-await-in-loop
			await harness.settle();
			harness.classify();
			if (i % every === every - 1 || i === steps.length - 1) {
				const frame = harness.pixels();
				// oxlint-disable-next-line no-await-in-loop
				const full = await harness.redraw();
				assert.isNull(harness.difference(frame, full), `step ${i}`);
			}
		}
	}

	it.each([
		['default crosshair', {}],
		[
			'magnet, dotted and solid lines, large text',
			{
				crosshair: {
					mode: 'magnet',
					vertLine: { style: 'dotted', width: 2 },
					horzLine: { style: 'solid', width: 3 },
				},
				layout: { fontSize: 28 },
			},
		],
		[
			'no labels, nearest mode',
			{ crosshair: { mode: 'nearest', vertLine: { labelVisible: false }, horzLine: { labelVisible: false } } },
		],
		[
			'time axis hidden, vertical line hidden',
			{ timeScale: { visible: false }, crosshair: { vertLine: { visible: false } } },
		],
	] as [string, DeepPartial<ChartOptions>][])('%s', async (_name, options) => {
		h = await setup(
			{ priceScales: { left: { visible: true, position: 'left' } }, ...options } as DeepPartial<ChartOptions>,
			ratio,
		);
		await walk(h, 1);
		assert.isAbove(h.partial, 10, 'cursor frames clear part of the overlay');
		await walk(h, 4);
	});

	it('with a selected drawing, and while one is dragged', async () => {
		h = await setup({}, ratio);
		const harness = h;
		await harness.redraw();
		const check = async (label: string) => {
			const frame = harness.pixels();
			const full = await harness.redraw();
			assert.isNull(harness.difference(frame, full), label);
		};
		// Select the trend line, then hover elsewhere: two highlights, then one.
		const { x, y } = harness.at(505, 101.5);
		harness.pointer('pointermove', x, y);
		await harness.settle();
		harness.pointer('pointerdown', x, y, { buttons: 1, button: 0 });
		await harness.settle();
		harness.pointer('pointerup', x, y, { buttons: 0, button: 0 });
		await harness.settle();
		await check('selected');
		for (const [bar, price] of [
			[480, 104],
			[520, 100],
			[490, 99],
		] as const) {
			const at = harness.at(bar, price);
			harness.pointer('pointermove', at.x, at.y);
			// oxlint-disable-next-line no-await-in-loop
			await harness.settle();
			expect(harness.classify()).toBe('partial');
			// oxlint-disable-next-line no-await-in-loop
			await check(`hover ${bar}`);
		}
		// Drag the selected line: the overlay draws it, in full frames.
		const start = harness.at(505, 101.5);
		harness.pointer('pointermove', start.x, start.y);
		await harness.settle();
		harness.pointer('pointerdown', start.x, start.y, { buttons: 1, button: 0 });
		await harness.settle();
		for (let k = 1; k <= 3; k++) {
			harness.pointer('pointermove', start.x + 10 * k, start.y + 6 * k, { buttons: 1 });
			// oxlint-disable-next-line no-await-in-loop
			await harness.settle();
			expect(harness.classify()).toBe('full');
		}
		harness.pointer('pointerup', start.x + 30, start.y + 18, { buttons: 0 });
		await harness.settle();
		// The frame after an edit clears it all: what the edit drew is not bounded.
		harness.pointer('pointermove', start.x + 60, start.y);
		await harness.settle();
		expect(harness.classify()).toBe('full');
		await check('after the drag');
		// Escape lets the selection go: its handles go.
		harness.chart.element().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await harness.settle();
		await check('deselected');
	});

	it('draws everything while a primitive is on top, and clears it after', async () => {
		h = await setup({}, ratio);
		const harness = h;
		const primitive: PanePrimitive = {
			zOrder: 'top',
			draw(target: DrawTarget) {
				const ctx = target.context;
				ctx.fillStyle = 'rgba(0, 200, 0, 0.3)';
				ctx.fillRect(40, 30, 120 * target.pixelRatio, 50);
			},
		};
		harness.chart.attachPrimitive(primitive);
		await harness.settle();
		await harness.redraw();
		for (const [bar, price] of [
			[470, 95],
			[520, 100],
		] as const) {
			const at = harness.at(bar, price);
			harness.pointer('pointermove', at.x, at.y);
			// oxlint-disable-next-line no-await-in-loop
			await harness.settle();
			expect(harness.classify()).toBe('full');
		}
		harness.chart.detachPrimitive(primitive);
		await harness.settle();
		const frame = harness.pixels();
		const full = await harness.redraw();
		expect(harness.difference(frame, full)).toBeNull();
		const at = harness.at(540, 99);
		harness.pointer('pointermove', at.x, at.y);
		await harness.settle();
		expect(harness.classify()).toBe('partial');
	});

	it('compares price lines and value labels in frames of new data', async () => {
		h = await setup({ priceScales: { left: { visible: true, position: 'left' } } }, ratio);
		const harness = h;
		const { bars, near, left } = harness.series!;
		const at = harness.at(560, 100);
		harness.pointer('pointermove', at.x, at.y);
		await harness.settle();
		await harness.redraw();
		const data = candles(COUNT + 4);
		let partial = 0;
		for (let k = 0; k < 12; k++) {
			// Ticks on the last bar, a new bar every fourth, the lines with them; once a price beyond the
			// range, which moves the scale.
			const i = COUNT - 1 + Math.floor(k / 4);
			const close = data.close[i]! + (k % 4) * 0.37 + (k === 9 ? 30 : 0);
			bars.update({
				time: data.time[i]!,
				open: data.open[i]!,
				high: Math.max(data.high[i]!, close),
				low: data.low[i]!,
				close,
			});
			near.update({ time: data.time[i]!, value: close + 1.5 });
			if (k % 2 === 0) left.update({ time: data.time[i]!, value: close * 10 + i });
			// oxlint-disable-next-line no-await-in-loop
			await harness.settle();
			if (harness.classify() === 'partial') partial++;
			const frame = harness.pixels();
			// oxlint-disable-next-line no-await-in-loop
			const full = await harness.redraw();
			assert.isNull(harness.difference(frame, full), `tick ${k}`);
		}
		assert.isAbove(partial, 6, 'ticks compare the labels instead of drawing all of them');
		// A price line that goes, a label that comes back alone.
		near.applyOptions({ priceLineVisible: false });
		await harness.settle();
		harness.classify();
		const frame = harness.pixels();
		assert.isNull(harness.difference(frame, await harness.redraw()), 'price line hidden');
	});

	it('leaves the overlay alone when nothing on it moved', async () => {
		h = await setup({}, ratio);
		const at = h.at(530, 100);
		h.pointer('pointermove', at.x, at.y);
		await h.settle();
		h.classify();
		// Within the same bar and device row: the same crosshair.
		h.pointer('pointermove', at.x + 0.1 / ratio, at.y);
		await h.settle();
		expect(h.classify()).toBe('kept');
	});
});
