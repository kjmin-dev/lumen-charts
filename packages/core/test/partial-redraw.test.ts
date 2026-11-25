import {
	type ChartApi,
	type ChartOptions,
	type DeepPartial,
	type DrawTarget,
	type PanePrimitive,
	type SeriesApi,
	createChart,
} from '@lumen-ticks/core';
import { afterEach, assert, describe, expect, it, vi } from 'vitest';

// A frame that redraws only the columns a tick changed must leave the pixels of a full redraw
// (design section 6.2). No canvas rasterizes here, so the test works on what is drawn: a context
// that keeps every shape with its style and the clip it was drawn through, and a model of which
// shapes can color the pixels of a range of columns. Two frames color a range alike when the
// shapes that can reach it are equal, in order, with equal joins and caps inside it and equal dash
// phases: the length of the path before a segment, summed in single precision as a canvas sums it,
// so a path that starts later has to bring that very sum along. The pixels themselves are compared
// in a browser by `pnpm bench:pixels`.

type Point = readonly [number, number];

interface Shape {
	kind: 'fillRect' | 'fillText' | 'stroke' | 'other';
	/** Everything of the context's state the shape is drawn with. */
	style: string;
	args: readonly unknown[];
	/** For a stroke: polylines, and rectangles as `[x, y, width, height]`. */
	lines: Point[][];
	rects: (readonly number[])[];
	lineWidth: number;
	dashed: boolean;
	/** Device columns `[left, right)` of the clip the shape was drawn through, or null. */
	clip: readonly [number, number] | null;
}

interface State {
	fillStyle: string;
	strokeStyle: string;
	lineWidth: number;
	lineJoin: string;
	font: string;
	textAlign: string;
	textBaseline: string;
	globalAlpha: number;
	dash: readonly number[];
	lineDashOffset: number;
	columns: readonly [number, number] | null;
}

/**
 * Stands in for a 2D context: keeps the shapes drawn, with the state and the clip they had. Only the
 * series layer's clips are checked: the overlay clips to boxes of its own (`overlay-partial.test.ts`).
 */
function modelContext(strict: boolean): { shapes: Shape[]; ctx: CanvasRenderingContext2D } {
	const shapes: Shape[] = [];
	let state: State = {
		fillStyle: '',
		strokeStyle: '',
		lineWidth: 1,
		lineJoin: 'miter',
		font: '10px sans-serif',
		textAlign: 'start',
		textBaseline: 'alphabetic',
		globalAlpha: 1,
		dash: [],
		lineDashOffset: 0,
		columns: null,
	};
	const stack: State[] = [];
	let lines: Point[][] = [];
	let rects: (readonly number[])[] = [];
	const push = (kind: Shape['kind'], style: string, args: readonly unknown[], stroke = false): void => {
		shapes.push({
			kind,
			style: `${style}|${state.globalAlpha}`,
			args,
			lines: stroke ? lines.map(line => [...line]) : [],
			rects: stroke ? [...rects] : [],
			lineWidth: state.lineWidth,
			dashed: stroke && state.dash.length > 0,
			clip: state.columns,
		});
	};
	const methods: Record<string, (...args: never[]) => unknown> = {
		save: () => stack.push({ ...state }),
		restore: () => {
			state = stack.pop() ?? state;
		},
		beginPath: () => {
			lines = [];
			rects = [];
		},
		moveTo: (x: number, y: number) => lines.push([[x, y]]),
		lineTo: (x: number, y: number) => lines.at(-1)!.push([x, y]),
		rect: (x: number, y: number, width: number, height: number) => rects.push([x, y, width, height]),
		clip: () => {
			if (!strict) {
				return;
			}
			// The chart clips to whole columns of the layer and nothing else.
			assert.deepEqual(lines, []);
			assert.lengthOf(rects, 1);
			const [x, y, width] = rects[0]!;
			assert.equal(y, 0);
			assert.isTrue(Number.isInteger(x) && Number.isInteger(width));
			assert.isNull(state.columns);
			state.columns = [x!, x! + width!];
		},
		setLineDash: (dash: number[]) => {
			state.dash = [...dash];
		},
		stroke: () => {
			// A path of a single segment is stroked as another shape than a longer one (see `drawLine`).
			const segments = lines.reduce((sum, line) => sum + line.length - 1, 0);
			const shape = segments === 1 && rects.length === 0 ? 'segment' : 'path';
			// Dashes are continued by the length of the path, never by an offset (see `dashLead`).
			assert.equal(state.lineDashOffset, 0);
			push(
				'stroke',
				`${state.strokeStyle}|${state.lineWidth}|${state.lineJoin}|${state.dash.join(',')}|${shape}`,
				[],
				true,
			);
		},
		fillRect: (...args: number[]) => push('fillRect', state.fillStyle, args),
		fillText: (...args: unknown[]) =>
			push('fillText', `${state.fillStyle}|${state.font}|${state.textAlign}|${state.textBaseline}`, args),
		clearRect: (...args: number[]) => push('other', 'clearRect', args),
		measureText: (text: string) => ({ width: text.length * 7 }),
	};
	const ctx = new Proxy({} as Record<string, unknown>, {
		get(_target, property: string) {
			if (property in state) {
				return state[property as keyof State];
			}
			return methods[property] ?? ((...args: unknown[]) => push('other', property, args));
		},
		set(_target, property: string, value) {
			(state as unknown as Record<string, unknown>)[property] = value;
			return true;
		},
	});
	return { shapes, ctx: ctx as unknown as CanvasRenderingContext2D };
}

/**
 * What of `shapes` can color a pixel of device columns `[left, right)`, in drawing order. A filled
 * rectangle counts when it overlaps the columns. A stroke reaches half its width from its path, and
 * one pixel more for antialiasing: its segments count when they come that close, each with the
 * neighbor it joins at an end that is itself that close (none: a cap), and with the length of its
 * line before it when the line is dashed. Text counts always.
 */
function reaching(shapes: readonly Shape[], left: number, right: number): unknown[] {
	const out: unknown[] = [];
	if (right <= left) {
		return out;
	}
	for (const shape of shapes) {
		if (shape.kind === 'fillRect') {
			const [x, y, width, height] = shape.args as number[];
			if (width! > 0 && height! > 0 && x! < right && x! + width! > left) {
				out.push(['fillRect', shape.style, x, y, width, height]);
			}
		} else if (shape.kind === 'stroke') {
			const reach = shape.lineWidth / 2 + 1;
			const near = (x: number): boolean => x + reach > left && x - reach < right;
			for (const [x, y, width, height] of shape.rects) {
				if (x! - reach < right && x! + width! + reach > left) {
					out.push(['strokeRect', shape.style, x, y, width, height]);
				}
			}
			for (const line of shape.lines) {
				let length = 0;
				for (let i = 0; i + 1 < line.length; i++) {
					const a = line[i]!;
					const b = line[i + 1]!;
					if (Math.min(a[0], b[0]) - reach < right && Math.max(a[0], b[0]) + reach > left) {
						const before = near(a[0]) ? (line[i - 1] ?? 'cap') : 'far';
						const after = near(b[0]) ? (line[i + 2] ?? 'cap') : 'far';
						out.push(['segment', shape.style, a, b, before, after, shape.dashed ? length : 0]);
					}
					length = Math.fround(length + singleLength(a, b));
				}
			}
		} else {
			out.push([shape.kind, shape.style, ...shape.args]);
		}
	}
	return out;
}

/** The length of a segment as a canvas measures it for dashes: in single precision, step by step. */
function singleLength(a: Point, b: Point): number {
	const dx = Math.fround(b[0] - a[0]);
	const dy = Math.fround(b[1] - a[1]);
	return Math.fround(Math.sqrt(Math.fround(Math.fround(dx * dx) + Math.fround(dy * dy))));
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

type Mode = 'partial' | 'full' | 'kept';

/** A chart on model contexts, with the steps of the comparison. */
class Harness {
	public readonly chart: ChartApi;
	public readonly width: number;
	private readonly _container: HTMLDivElement;
	private readonly _contexts = new Map<HTMLCanvasElement, ReturnType<typeof modelContext>>();
	private _frames: ((now: number) => void)[] = [];
	private _now = 0;
	/** What the last frame checked by `step` drew on the series layer. */
	public partial: Shape[] = [];
	/** The last full redraw of the series layer. */
	private _full: Shape[] = [];

	public constructor(options: DeepPartial<ChartOptions> = {}, pixelRatio = 1) {
		vi.spyOn(window, 'devicePixelRatio', 'get').mockImplementation(() => pixelRatio);
		this._container = document.body.appendChild(document.createElement('div'));
		vi.stubGlobal('requestAnimationFrame', (callback: (now: number) => void) => this._frames.push(callback));
		vi.stubGlobal('cancelAnimationFrame', () => {});
		const contexts = this._contexts;
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
			let entry = contexts.get(this);
			if (entry === undefined) {
				// The series layer is the chart's first canvas.
				entry = modelContext(contexts.size === 0);
				contexts.set(this, entry);
			}
			return entry.ctx;
		} as unknown as HTMLCanvasElement['getContext']);
		this.chart = createChart(this._container, { autoSize: false, width: 640, height: 400, worker: false, ...options });
		this.width = 0;
	}

	public destroy(): void {
		this.chart.destroy();
		this._container.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	}

	public get paneCanvas(): HTMLCanvasElement {
		return this.chart.element().querySelectorAll('canvas')[0]!;
	}

	public get pane(): Shape[] {
		return this._contexts.get(this.paneCanvas)!.shapes;
	}

	public shapes(canvas: HTMLCanvasElement): Shape[] {
		return this._contexts.get(canvas)?.shapes ?? [];
	}

	public get overlay(): Shape[] {
		const canvases = this.chart.element().querySelectorAll('canvas');
		return this._contexts.get(canvases[canvases.length - 1]!)!.shapes;
	}

	public clear(): void {
		for (const entry of this._contexts.values()) {
			entry.shapes.length = 0;
		}
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

	/** Draws everything again without changing anything, and returns the shapes of the series layer. */
	public async redraw(): Promise<Shape[]> {
		const visible = this.chart.options().grid.vertLines.visible;
		this.chart.applyOptions({ grid: { vertLines: { visible: !visible } } });
		this.chart.applyOptions({ grid: { vertLines: { visible } } });
		this.clear();
		await this.settle();
		const shapes = [...this.pane];
		assert.isAbove(shapes.length, 0);
		assert.isTrue(
			shapes.every(shape => shape.clip === null),
			'a full redraw has no clip',
		);
		this._full = shapes;
		this.clear();
		return shapes;
	}

	/**
	 * Runs `change`, lets the chart draw it, and checks the frame against full redraws of the state
	 * before and after: a partial frame must draw, inside its columns, what the full redraw draws
	 * there, and the full redraws must agree everywhere else; a frame that keeps the layer needs full
	 * redraws that agree everywhere. Returns what the frame did, and its columns.
	 */
	public async step(
		change: () => void | Promise<void>,
	): Promise<{ mode: Mode; left: number; right: number; overlay: Shape[] }> {
		const before = this._full;
		this.clear();
		await change();
		await this.settle();
		const frame = [...this.pane];
		const overlay = [...this.overlay];
		this.partial = frame;
		const after = await this.redraw();
		const width = this.paneCanvas.width;
		const clip = frame[0]?.clip ?? null;
		if (frame.length === 0) {
			assert.deepEqual(reaching(after, 0, width), reaching(before, 0, width), 'nothing changed on the layer');
			return { mode: 'kept', left: 0, right: 0, overlay };
		}
		if (clip === null) {
			assert.isTrue(
				frame.every(shape => shape.clip === null),
				'one full frame',
			);
			assert.deepEqual(reaching(frame, 0, width), reaching(after, 0, width));
			return { mode: 'full', left: 0, right: width, overlay };
		}
		const [left, right] = clip;
		assert.isAtLeast(left, 0);
		assert.isAtMost(right, width);
		assert.isAbove(right, left);
		assert.isTrue(
			frame.every(shape => shape.clip === clip),
			'one frame, all of it through the clip',
		);
		assert.deepEqual(reaching(frame, left, right), reaching(after, left, right), 'inside the columns');
		assert.deepEqual(reaching(after, 0, left), reaching(before, 0, left), 'left of the columns');
		assert.deepEqual(reaching(after, right, width), reaching(before, right, width), 'right of the columns');
		return { mode: 'partial', left, right, overlay };
	}
}

const COUNT = 2000;
const LAST = (COUNT - 1) * MINUTE;

const dashedStrokes = (shapes: readonly Shape[]): Shape[] =>
	shapes.filter(shape => shape.dashed && shape.lines.length > 0);
const points = (shape: Shape): number => shape.lines.reduce((sum, line) => sum + line.length, 0);
/** Length of the level segment a stroke's first line starts with; 0 when it starts otherwise. */
const leadOf = (shape: Shape): number => {
	const [a, b] = shape.lines[0]!;
	return a !== undefined && b !== undefined && a[1] === b[1] ? b[0] - a[0] : 0;
};

/** The closes of `candles(COUNT)` times `factor` as a line, with points left out when `gaps`. */
function lineData(factor: number, gaps = false) {
	const data = candles(COUNT);
	const value = data.close.map((close, i) => (gaps && (i % 37 === 0 || i === COUNT - 2) ? NaN : close * factor));
	return { time: data.time, value };
}

describe.each([1, 2, 1.5])('redrawing the columns a tick changed, at pixel ratio %s', ratio => {
	let h: Harness;

	afterEach(() => {
		h.destroy();
	});

	/** Shows the last `bars` bars with room for new ones, and draws the reference frame. */
	const show = async (bars: number): Promise<void> => {
		await h.settle();
		h.chart.timeScale().setVisibleLogicalRange({ from: COUNT - bars, to: COUNT + bars / 10 });
		await h.settle();
		await h.redraw();
	};

	it.each([200, 2000])('redraws the last candle of %s without the others', async bars => {
		h = new Harness({}, ratio);
		const data = candles(COUNT);
		const series = h.chart.addSeries('candlestick', {
			borderVisible: true,
			upColor: 'rgba(0, 150, 0, 0.4)',
			downColor: 'rgba(200, 0, 0, 0.4)',
		});
		series.setData(data);
		await show(bars);
		const all = h.paneCanvas.width;
		const open = data.open[COUNT - 1]!;
		for (const close of [open - 0.5, open + 0.7, open - 1.5, open]) {
			// Inside the range in view, so the price scale stays.
			// oxlint-disable-next-line no-await-in-loop
			const frame = await h.step(() => series.update({ time: LAST, open, high: open + 2, low: open - 2, close }));
			expect(frame.mode).toBe('partial');
			expect(frame.right - frame.left).toBeLessThan(all / 10);
			// The last-value label follows on the overlay, which is drawn in every frame.
			expect(frame.overlay.filter(shape => shape.kind === 'fillText').map(shape => shape.args[0])).toContain(
				close.toFixed(2),
			);
		}
	});

	it('redraws lines of every style from far enough to keep joins, caps and dashes', async () => {
		h = new Harness({}, ratio);
		const lines: SeriesApi<'line'>[] = [
			h.chart.addSeries('line', { color: '#1f77b4' }),
			h.chart.addSeries('line', { color: 'rgba(214, 39, 40, 0.5)', lineWidth: 4 }),
			h.chart.addSeries('line', { color: '#8c564b', lineWidth: 2, lineType: 'step' }),
			h.chart.addSeries('line', { color: '#2ca02c', lineWidth: 2 }),
		];
		for (const [index, line] of lines.entries()) {
			line.setData(lineData(1 + index * 0.01, index === 3));
		}
		await show(300);
		const all = h.paneCanvas.width;
		const value = candles(COUNT).close[COUNT - 1]!;
		for (const [i, move] of [0.4, -0.6, 0.2, -0.1].entries()) {
			// oxlint-disable-next-line no-await-in-loop
			const frame = await h.step(() => {
				for (const [index, line] of lines.entries()) {
					// The line with gaps loses its last value in one step and gets it back in the next.
					line.update({ time: LAST, value: index === 3 && i % 2 === 0 ? NaN : (value + move) * (1 + index * 0.01) });
				}
			});
			expect(frame.mode).toBe('partial');
			expect(frame.right - frame.left).toBeLessThan(all / 10);
		}

		// Dashes are counted along the path: a dashed line is redrawn to the right edge, from the items
		// at the columns, after a lead as long as the whole path is before them.
		const dashed = h.chart.addSeries('line', { color: '#9467bd', lineStyle: 'dashed' });
		const dotted = h.chart.addSeries('line', { color: '#17becf', lineStyle: 'dotted', lineWidth: 2 });
		dashed.setData(lineData(0.98));
		dotted.setData(lineData(0.97, true));
		await h.settle();
		await h.redraw();
		for (const move of [0.3, -0.2]) {
			// oxlint-disable-next-line no-await-in-loop
			const frame = await h.step(() => {
				dashed.update({ time: LAST, value: (value + move) * 0.98 });
				dotted.update({ time: LAST, value: (value - move) * 0.97 });
				lines[0]!.update({ time: LAST, value: value - move });
			});
			expect(frame.mode).toBe('partial');
			expect(frame.right).toBe(all);
			const strokes = dashedStrokes(h.partial);
			expect(strokes).toHaveLength(2);
			// The dotted line has gaps: its lead is as long as the piece that reaches the columns.
			expect(leadOf(strokes[0]!)).toBeGreaterThan(all / 2);
			for (const stroke of strokes) {
				expect(leadOf(stroke)).toBeGreaterThan(0);
				expect(points(stroke)).toBeLessThan(10);
			}
		}
		// A change in the middle of a dashed line moves every dash after it.
		const row = COUNT - 150;
		const frame = await h.step(() => dashed.update({ time: row * MINUTE, value: value * 0.99 }));
		expect(frame.mode).toBe('partial');
		expect(frame.right).toBe(all);
		const [corrected] = dashedStrokes(h.partial);
		expect(leadOf(corrected!)).toBeGreaterThan(all / 2);
		expect(points(corrected!)).toBeGreaterThan(150);
		expect(points(corrected!)).toBeLessThan(160);

		// A gap among the items redrawn: the piece before it has the lead, the piece after it starts
		// its dashes anew, as in the whole path.
		const gap = await h.step(() => dashed.update({ time: (COUNT - 3) * MINUTE, value: NaN }));
		expect(gap.mode).toBe('partial');
		const next = await h.step(() => dashed.update({ time: LAST, value: value * 0.985 }));
		expect(next.mode).toBe('partial');
		const [pieces] = dashedStrokes(h.partial);
		expect(pieces!.lines).toHaveLength(2);
		expect(leadOf(pieces!)).toBeGreaterThan(all / 2);
		expect(points(pieces!)).toBeLessThan(10);
	});

	it('redraws the columns of a point that changed away from the last bar', async () => {
		h = new Harness({}, ratio);
		const line = h.chart.addSeries('line', { color: 'rgba(31, 119, 180, 0.6)', lineWidth: 3 });
		const step = h.chart.addSeries('line', { color: '#8c564b', lineType: 'step' });
		const bars = h.chart.addSeries('histogram', { color: 'rgba(0, 150, 0, 0.5)', negativeColor: '#cc0000', base: 100 });
		const data = lineData(1);
		line.setData(data);
		step.setData(lineData(1.01));
		bars.setData(lineData(1, true));
		await show(300);
		const all = h.paneCanvas.width;
		for (const row of [COUNT - 120, COUNT - 121, COUNT - 40, COUNT - 299]) {
			const value = data.value[row]!;
			// oxlint-disable-next-line no-await-in-loop
			const frame = await h.step(() => {
				line.update({ time: row * MINUTE, value: value + 0.6 });
				step.update({ time: row * MINUTE, value: value * 1.01 - 0.6 });
				bars.update({ time: row * MINUTE, value: value > 100 ? 99.5 : 100.5 });
			});
			expect(frame.mode).toBe('partial');
			// Somewhere inside the pane, not at its right edge.
			expect(frame.right).toBeLessThan(all - 10);
			expect(frame.right - frame.left).toBeLessThan(all / 10);
		}
		// Two points far apart in one frame: one range of columns that holds both.
		const far = await h.step(() => {
			line.update({ time: (COUNT - 250) * MINUTE, value: data.value[COUNT - 250]! + 0.3 });
			line.update({ time: (COUNT - 50) * MINUTE, value: data.value[COUNT - 50]! - 0.3 });
		});
		expect(far.mode).toBe('partial');
		expect(far.right - far.left).toBeGreaterThan(all / 2);
	});

	it('redraws merged pixel columns, for an update and for a new bar', async () => {
		h = new Harness({}, ratio);
		const count = 50_000;
		const data = candles(count);
		const series = h.chart.addSeries('candlestick');
		const line = h.chart.addSeries('line', { color: 'rgba(255, 127, 14, 0.5)', lineWidth: 2 });
		const dashed = h.chart.addSeries('line', { color: '#9467bd', lineStyle: 'dashed' });
		const bars = h.chart.addSeries('histogram', { priceScaleId: 'volume' });
		series.setData(data);
		line.setData({ time: data.time, value: data.high });
		dashed.setData({ time: data.time, value: data.low });
		bars.setData({ time: data.time, value: data.close.map((close, i) => close - data.open[i]!) });
		await h.settle();
		h.chart.timeScale().setVisibleLogicalRange({ from: count - 20_000, to: count + 1000 });
		await h.settle();
		await h.redraw();
		const all = h.paneCanvas.width;
		let time = (count - 1) * MINUTE;
		const open = data.open[count - 1]!;
		const modes: Mode[] = [];
		const lefts: number[] = [];
		const leads: number[] = [];
		const drawnPoints: number[] = [];
		for (let i = 0; i < 12; i++) {
			if (i % 3 === 2) {
				time += MINUTE;
			}
			const close = open + Math.sin(i) * 1.5;
			// oxlint-disable-next-line no-await-in-loop
			const frame = await h.step(() => {
				series.update({ time, open, high: open + 2, low: open - 2, close });
				line.update({ time, value: open + 2 });
				dashed.update({ time, value: open - 2 + Math.cos(i) * 0.1 });
				bars.update({ time, value: (close - open) / 2 });
			});
			modes.push(frame.mode);
			lefts.push(frame.mode === 'partial' ? frame.left : all);
			if (frame.mode === 'partial') {
				const [stroke] = dashedStrokes(h.partial);
				leads.push(leadOf(stroke!));
				drawnPoints.push(points(stroke!));
			}
		}
		// The dashed line is drawn from the columns of the last bar too.
		expect(Math.min(...lefts)).toBeGreaterThan(all / 2);
		expect(Math.min(...leads)).toBeGreaterThan(all);
		expect(Math.max(...drawnPoints)).toBeLessThan(100);
		// Updates of the last bar never need the whole layer; a new bar does when it adds a column.
		expect(modes.filter((_, i) => i % 3 !== 2)).not.toContain('full');
		expect(modes).toContain('partial');
	});

	it('redraws through a coarse level with every bar in view', async () => {
		h = new Harness({}, ratio);
		// Ten bars into a bucket of every level, so the next few bars join it.
		const count = 100_010;
		const data = candles(count);
		const series = h.chart.addSeries('candlestick');
		series.setData(data);
		series.addIndicator('sma', { params: { period: 20 } });
		series.addIndicator('macd', { priceScaleId: 'macd' });
		await h.settle();
		h.chart.timeScale().fitContent();
		await h.settle();
		await h.redraw();
		const open = data.open[count - 1]!;
		const modes: Mode[] = [];
		for (let i = 0; i < 6; i++) {
			const close = open + Math.sin(i + 1) * 1.5;
			// oxlint-disable-next-line no-await-in-loop
			const frame = await h.step(() =>
				series.update({ time: (count - 1) * MINUTE, open, high: open + 2, low: open - 2, close }),
			);
			modes.push(frame.mode);
		}
		expect(modes).toContain('partial');

		// New bars that join the last bucket add no item. The time ticks are computed again for them
		// and land where they were, so the layer is still patched.
		let time = (count - 1) * MINUTE;
		const added: Mode[] = [];
		for (let i = 0; i < 4; i++) {
			time += MINUTE;
			const close = open + Math.cos(i) * 1.5;
			// oxlint-disable-next-line no-await-in-loop
			const frame = await h.step(() => series.update({ time, open, high: open + 2, low: open - 2, close }));
			added.push(frame.mode);
		}
		expect(added).not.toContain('full');
		expect(added).toContain('partial');
	});

	it.each(['logarithmic', 'percentage', 'indexed'] as const)('redraws on a %s and an inverted scale', async mode => {
		h = new Harness(
			{ priceScale: { mode }, priceScales: { other: { visible: true, position: 'left', invertScale: true } } },
			ratio,
		);
		const data = candles(COUNT);
		const series = h.chart.addSeries('candlestick', { borderVisible: true });
		const line = h.chart.addSeries('line', { priceScaleId: 'other', lineWidth: 2 });
		const bars = h.chart.addSeries('histogram', { priceScaleId: 'other', base: 100 });
		series.setData(data);
		line.setData(lineData(1));
		bars.setData(lineData(1.001));
		await show(200);
		const open = data.open[COUNT - 1]!;
		for (const close of [open - 0.5, open + 0.7]) {
			// oxlint-disable-next-line no-await-in-loop
			const frame = await h.step(() => {
				series.update({ time: LAST, open, high: open + 2, low: open - 2, close });
				line.update({ time: LAST, value: close });
				bars.update({ time: LAST, value: close > open ? 100.4 : 99.6 });
			});
			expect(frame.mode).toBe('partial');
		}
	});

	it('draws everything under the series inside the columns: watermark, grid, sessions', async () => {
		h = new Harness(
			{
				watermark: { visible: true, text: 'TEST', fontSize: 48 },
				grid: { vertLines: { style: 'dashed' }, horzLines: { style: 'dotted' } },
				sessions: {
					schedule: {
						timeZone: 'UTC',
						days: [0, 1, 2, 3, 4, 5, 6],
						hours: [
							{ start: '00:00', end: '08:00', kind: 'pre' },
							{ start: '08:00', end: '20:00' },
						],
						holidays: [],
					},
					breaks: { visible: true, style: 'dashed' },
					extendedHours: { visible: true },
				},
			},
			ratio,
		);
		const data = candles(COUNT);
		const series = h.chart.addSeries('candlestick');
		series.setData(data);
		await show(1900);
		const full = await h.redraw();
		expect(full.filter(shape => shape.kind === 'fillText')).toHaveLength(1);
		expect(full.filter(shape => shape.kind === 'stroke' && shape.dashed).length).toBeGreaterThanOrEqual(2);
		const open = data.open[COUNT - 1]!;
		const frame = await h.step(() =>
			series.update({ time: LAST, open, high: open + 2, low: open - 2, close: open + 1 }),
		);
		expect(frame.mode).toBe('partial');
	});

	it('falls back to a full redraw when the tick is not all that changed', async () => {
		h = new Harness({}, ratio);
		const data = candles(COUNT);
		const series = h.chart.addSeries('candlestick');
		const line = h.chart.addSeries('line');
		series.setData(data);
		line.setData(lineData(1));
		await show(200);
		const open = data.open[COUNT - 1]!;
		let close = open;
		const tick = (): void => {
			close = close === open ? open + 0.5 : open;
			series.update({ time: LAST, open, high: open + 2, low: open - 2, close });
		};
		expect((await h.step(tick)).mode).toBe('partial');

		// A value outside the range in view: autoscale moves the price scale, and every item with it.
		expect((await h.step(() => line.update({ time: LAST, value: 500 }))).mode).toBe('full');
		expect((await h.step(() => line.update({ time: LAST, value: data.close[COUNT - 1]! }))).mode).toBe('full');
		expect((await h.step(tick)).mode).toBe('partial');

		// The same on a scale without an axis, which has no ticks to tell.
		const overlaid = h.chart.addSeries('line', { priceScaleId: 'overlay' });
		overlaid.setData(lineData(2));
		await h.settle();
		await h.redraw();
		expect((await h.step(tick)).mode).toBe('partial');
		expect((await h.step(() => overlaid.update({ time: LAST, value: 900 }))).mode).toBe('full');
		expect((await h.step(tick)).mode).toBe('partial');

		// A new bar adds an item.
		expect(
			(await h.step(() => series.update({ time: LAST + MINUTE, open, high: open + 1, low: open - 1, close: open })))
				.mode,
		).toBe('full');
		expect((await h.step(tick)).mode).toBe('partial');

		// A tick together with a change of options, of the view, or of the size.
		const withTick = (change: () => void) => async () => {
			tick();
			// The tick is applied, and the change joins it in the frame that draws it.
			await h.chart.whenApplied();
			change();
		};
		expect((await h.step(withTick(() => line.applyOptions({ color: '#123456' })))).mode).toBe('full');
		expect((await h.step(tick)).mode).toBe('partial');
		expect((await h.step(withTick(() => h.chart.applyOptions({ layout: { background: '#fafafa' } })))).mode).toBe(
			'full',
		);
		expect(
			(await h.step(withTick(() => h.chart.timeScale().setVisibleLogicalRange({ from: COUNT - 150, to: COUNT + 20 }))))
				.mode,
		).toBe('full');
		expect((await h.step(tick)).mode).toBe('partial');
		expect((await h.step(withTick(() => h.chart.resize(600, 380)))).mode).toBe('full');
		expect((await h.step(tick)).mode).toBe('partial');
		expect((await h.step(withTick(() => line.applyOptions({ visible: false })))).mode).toBe('full');
		expect((await h.step(tick)).mode).toBe('partial');
		expect((await h.step(withTick(() => h.chart.removeSeries(line)))).mode).toBe('full');
		expect((await h.step(tick)).mode).toBe('partial');

		// A scale that does not follow the data keeps its mapping, whatever the value.
		h.chart.priceScale().applyOptions({ autoScale: false });
		await h.settle();
		await h.redraw();
		expect(
			(await h.step(() => series.update({ time: LAST + MINUTE, open, high: 900, low: open - 1, close: 800 }))).mode,
		).toBe('partial');
	});

	it('draws the whole layer for every tick when the option asks for full redraws', async () => {
		h = new Harness({ redraw: 'full' }, ratio);
		const data = candles(COUNT);
		const series = h.chart.addSeries('candlestick');
		const line = h.chart.addSeries('line', { lineStyle: 'dashed' });
		series.setData(data);
		line.setData(lineData(1));
		await show(200);
		const open = data.open[COUNT - 1]!;
		let close = open;
		const tick = (): void => {
			close = close === open ? open + 0.5 : open;
			series.update({ time: LAST, open, high: open + 2, low: open - 2, close });
			line.update({ time: LAST, value: close });
		};
		expect((await h.step(tick)).mode).toBe('full');
		expect((await h.step(tick)).mode).toBe('full');
		// A correction left of the view, which changes nothing on the layer, is a full frame as well.
		expect((await h.step(() => line.update({ time: 100 * MINUTE, value: 101 }))).mode).toBe('full');
		h.chart.applyOptions({ redraw: 'auto' });
		await h.settle();
		await h.redraw();
		expect((await h.step(tick)).mode).toBe('partial');
		expect((await h.step(() => line.update({ time: 100 * MINUTE, value: 102 }))).mode).toBe('kept');
		h.chart.applyOptions({ redraw: 'full' });
		await h.settle();
		await h.redraw();
		expect((await h.step(tick)).mode).toBe('full');
	});

	it('keeps the full redraw for what the chart cannot bound: a custom renderer, a primitive under the series', async () => {
		h = new Harness({}, ratio);
		const data = candles(COUNT);
		const series = h.chart.addSeries('candlestick');
		const line = h.chart.addSeries('line');
		series.setData(data);
		line.setData(lineData(1));
		await show(200);
		const open = data.open[COUNT - 1]!;
		let close = open;
		const tick = (): void => {
			close = close === open ? open + 0.5 : open;
			series.update({ time: LAST, open, high: open + 2, low: open - 2, close });
		};
		expect((await h.step(tick)).mode).toBe('partial');

		line.setRenderer({
			draw(target, items) {
				target.context.fillRect(0, 0, items.count, 1);
			},
		});
		await h.settle();
		await h.redraw();
		expect((await h.step(tick)).mode).toBe('full');
		line.setRenderer(null);
		await h.settle();
		await h.redraw();
		expect((await h.step(tick)).mode).toBe('partial');

		const primitive: PanePrimitive = {
			zOrder: 'bottom',
			update() {},
			draw(target: DrawTarget) {
				target.context.fillRect(10, 10, 50, 50);
			},
		};
		h.chart.attachPrimitive(primitive);
		await h.settle();
		await h.redraw();
		expect((await h.step(tick)).mode).toBe('full');
		h.chart.detachPrimitive(primitive);
		await h.settle();
		await h.redraw();
		expect((await h.step(tick)).mode).toBe('partial');
	});

	it('draws every layer again after the browser lost and restored a canvas', async () => {
		h = new Harness({}, ratio);
		const data = candles(COUNT);
		const series = h.chart.addSeries('candlestick');
		series.setData(data);
		await show(200);
		const open = data.open[COUNT - 1]!;
		const tick = (close: number) => () => series.update({ time: LAST, open, high: open + 2, low: open - 2, close });
		expect((await h.step(tick(open + 0.5))).mode).toBe('partial');
		const canvases = [...h.chart.element().querySelectorAll('canvas')];
		const drawn = async (change: () => void): Promise<boolean[]> => {
			h.clear();
			change();
			await h.settle();
			return canvases.map(canvas => h.shapes(canvas).length > 0);
		};
		// A tick draws on the series layer and the overlay; the axes keep what they show.
		expect(await drawn(tick(open))).toEqual([true, false, false, true]);
		expect(await drawn(() => canvases[1]!.dispatchEvent(new Event('contextrestored')))).toEqual([
			true,
			true,
			true,
			true,
		]);
		expect((await h.step(tick(open + 0.5))).mode).toBe('partial');
		const restored = await h.step(async () => {
			tick(open)();
			await h.chart.whenApplied();
			h.paneCanvas.dispatchEvent(new Event('contextrestored'));
		});
		expect(restored.mode).toBe('full');
	});

	it('leaves the layer alone when nothing in view changed', async () => {
		h = new Harness({}, ratio);
		const data = lineData(1);
		const line = h.chart.addSeries('line');
		line.setData(data);
		await h.settle();
		h.chart.timeScale().setVisibleLogicalRange({ from: 500, to: 700 });
		await h.settle();
		await h.redraw();
		// A correction of a bar left of the view, and a tick on the last bar, right of it.
		expect((await h.step(() => line.update({ time: 100 * MINUTE, value: data.value[100]! + 0.1 }))).mode).toBe('kept');
		const frame = await h.step(() => line.update({ time: LAST, value: data.value[COUNT - 1]! + 0.1 }));
		expect(frame.mode).toBe('kept');
		// The overlay is still drawn: the last value has a label of its own.
		expect(frame.overlay.length).toBeGreaterThan(0);
		// A bar at the edge of the view reaches into it.
		expect((await h.step(() => line.update({ time: 600 * MINUTE, value: data.value[600]! + 0.1 }))).mode).toBe(
			'partial',
		);
	});
});
