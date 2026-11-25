import {
	type DrawTarget,
	HIT_BODY,
	HIT_NONE,
	type PanePrimitive,
	type PaneView,
	type PrimitiveBounds,
	type PrimitiveHost,
	type PrimitiveZOrder,
	type SeriesItems,
	type SeriesRenderer,
} from '@lumen-ticks/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MINUTE, TestChart, candles } from './drawing-helpers';

/** A box from bar `from` to bar `to` between two prices, recording what the chart asks of it. */
class Box implements PanePrimitive {
	public readonly zOrder: PrimitiveZOrder;
	public host: PrimitiveHost | null = null;
	public updates = 0;
	public draws: CanvasRenderingContext2D[] = [];
	public highlights: [boolean, boolean][] = [];
	public detachedCount = 0;
	public left = NaN;
	public right = NaN;
	public top = NaN;
	public bottom = NaN;
	public times: number[] = [];

	public constructor(
		zOrder: PrimitiveZOrder,
		public from: number,
		public to: number,
		public low = 95,
		public high = 105,
	) {
		this.zOrder = zOrder;
	}

	public attached(host: PrimitiveHost): void {
		this.host = host;
	}

	public detached(): void {
		this.detachedCount++;
		this.host = null;
	}

	public update(view: PaneView, bounds: PrimitiveBounds): void {
		this.updates++;
		const from = view.timeToLogical(this.from * MINUTE);
		const to = view.timeToLogical(this.to * MINUTE);
		this.times.push(from);
		this.left = view.timeToX(this.from * MINUTE);
		this.right = view.logicalToX(to);
		this.top = view.priceToY(this.high);
		this.bottom = view.priceToY(this.low);
		bounds.left = this.left;
		bounds.right = this.right;
		bounds.top = this.top;
		bounds.bottom = this.bottom;
	}

	public draw(target: DrawTarget): void {
		this.draws.push(target.context);
		const r = target.pixelRatio;
		target.context.fillRect(this.left * r, this.top * r, (this.right - this.left) * r, (this.bottom - this.top) * r);
	}

	public drawHighlight(_target: DrawTarget, _view: PaneView, hovered: boolean, selected: boolean): void {
		this.highlights.push([hovered, selected]);
	}

	public hitTest(x: number, y: number): number {
		return x >= this.left && x <= this.right && y >= this.top && y <= this.bottom ? HIT_BODY : HIT_NONE;
	}
}

describe('pane primitives', () => {
	let t: TestChart;

	beforeEach(async () => {
		t = new TestChart();
		t.chart.addSeries('candlestick').setData(candles(1000));
		t.chart.timeScale().setVisibleLogicalRange({ from: 900, to: 999 });
		await t.settle();
	});

	afterEach(() => {
		t.destroy();
	});

	const scale = () => (t.chart as unknown as { scale: { indexToX(i: number): number } }).scale;
	const priceToY = (price: number) => t.chart.priceScale().priceToCoordinate(price)!;

	it('draws a normal primitive in the drawings layer, with the chart mapping, and updates it only when needed', async () => {
		const box = new Box('normal', 920, 940);
		t.chart.attachPrimitive(box);
		await t.settle();
		expect(box.host).not.toBeNull();
		expect(box.left).toBeCloseTo(scale().indexToX(920));
		expect(box.top).toBeCloseTo(priceToY(105));
		expect(box.draws.length).toBe(1);
		expect(box.draws[0]).toBe(t.recorders.get(t.drawingsCanvas!)!.ctx);
		const updates = box.updates;
		// Hovering it highlights it on the overlay; nothing is updated or redrawn in its layer.
		t.pointer('pointermove', (box.left + box.right) / 2, (box.top + box.bottom) / 2);
		t.runFrames();
		expect(box.highlights).toEqual([[true, false]]);
		expect(box.updates).toBe(updates);
		expect(box.draws.length).toBe(1);
		// Its own change: one update and one redraw.
		box.high = 110;
		box.host!.requestUpdate();
		box.host!.requestUpdate();
		t.runFrames();
		expect(box.updates).toBe(updates + 1);
		expect(box.draws.length).toBe(2);
		// A pan: updated and redrawn with the new view.
		t.chart.timeScale().setVisibleLogicalRange({ from: 890, to: 989 });
		await t.settle();
		expect(box.left).toBeCloseTo(scale().indexToX(920));
		expect(box.draws.length).toBe(3);
	});

	it('updates primitives for a view the chart took over between frames', async () => {
		const box = new Box('normal', 920, 940);
		t.chart.attachPrimitive(box);
		await t.settle();
		// Frames of the pointer alone look at no primitive.
		const updates = box.updates;
		for (let k = 0; k < 5; k++) {
			t.pointer('pointermove', 100 + k * 30, 120);
			t.runFrames();
		}
		expect(box.updates).toBe(updates);
		// A conversion between frames hands the views the new mapping before the frame does: the
		// frame still updates the primitive for it.
		t.chart.timeScale().setVisibleLogicalRange({ from: 880, to: 979 });
		t.chart.timeScale().timeToCoordinate(930 * MINUTE);
		await t.settle();
		expect(box.updates).toBe(updates + 1);
		expect(box.left).toBeCloseTo(scale().indexToX(920));
	});

	it('draws a bottom primitive with the series and a top one on the overlay', async () => {
		const bottom = new Box('bottom', 910, 930);
		const top = new Box('top', 950, 970);
		t.chart.attachPrimitive(bottom);
		t.chart.attachPrimitive(top);
		await t.settle();
		expect(bottom.draws.at(-1)).toBe(t.recorders.get(t.canvases()[0]!)!.ctx);
		expect(top.draws.at(-1)).toBe(t.recorders.get(t.canvases().at(-1)!)!.ctx);
		// Below the series: its rectangle comes before the candles.
		const pane = t.pane;
		const box = pane.findIndex(call => call.name === 'fillRect' && call.args[1] === bottom.top);
		const fills = pane.map((call, i) => (call.name === 'fillRect' ? i : -1)).filter(i => i >= 0);
		const lastFill = fills[fills.length - 1]!;
		expect(box).toBeGreaterThan(0);
		expect(box).toBeLessThan(lastFill);
		const bottomDraws = bottom.draws.length;
		const topDraws = top.draws.length;
		t.pointer('pointermove', 100, 100);
		t.runFrames();
		expect(bottom.draws.length).toBe(bottomDraws);
		expect(top.draws.length).toBe(topDraws + 1);
		t.chart.detachPrimitive(top);
		expect(top.detachedCount).toBe(1);
		t.pointer('pointermove', 110, 100);
		t.runFrames();
		expect(top.draws.length).toBe(topDraws + 1);
	});

	it('detaches series primitives with their series', async () => {
		const line = t.chart.addSeries('line');
		line.setData({ time: candles(1000).time, value: candles(1000).close });
		const box = new Box('normal', 920, 940);
		line.attachPrimitive(box);
		await t.settle();
		expect(box.draws.length).toBe(1);
		t.chart.removeSeries(line);
		expect(box.detachedCount).toBe(1);
		const other = new Box('normal', 920, 940);
		line.attachPrimitive(other);
		expect(other.host).toBeNull();
	});

	it('answers times outside the bars held once the engine has looked them up', async () => {
		const box = new Box('normal', 5, 10);
		t.chart.attachPrimitive(box);
		await t.settle();
		expect(box.times[0]).toBeNaN();
		expect(box.times.at(-1)).toBe(5);
	});

	it('draws a series with a custom renderer instead of its built-in style', async () => {
		const seen: { count: number; x: number; y: number; barWidth: number }[] = [];
		const renderer: SeriesRenderer = {
			draw(target: DrawTarget, items: SeriesItems) {
				seen.push({ count: items.count, x: items.x[0]!, y: items.yClose[0]!, barWidth: items.barWidth });
				target.context.fillRect(0, 0, 1, 1);
			},
		};
		t.destroy();
		t = new TestChart();
		const series = t.chart.addSeries('candlestick', { upColor: '#00aa00', downColor: '#aa0000' });
		series.setData(candles(1000));
		t.chart.timeScale().setVisibleLogicalRange({ from: 900, to: 999 });
		series.setRenderer(renderer);
		await t.settle();
		expect(seen.length).toBe(1);
		expect(seen[0]!.count).toBeGreaterThanOrEqual(100);
		expect(seen[0]!.barWidth).toBeGreaterThan(1);
		expect(t.pane.some(call => call.name === 'fillRect' && call.fillStyle === '#00aa00')).toBe(false);
		// Indicator outputs take one as well.
		const sma = series.addIndicator('sma', { params: { period: 5 } });
		sma.output().setRenderer(renderer);
		series.setRenderer(null);
		await t.settle();
		expect(t.pane.some(call => call.name === 'fillRect' && call.fillStyle === '#00aa00')).toBe(true);
		expect(seen.length).toBeGreaterThan(1);
	});
});
