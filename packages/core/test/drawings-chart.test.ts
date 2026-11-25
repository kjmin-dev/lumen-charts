import { type DrawingApi, type DrawingState, type SeriesApi, setCanvasBudget } from '@lumen-ticks/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Drawing } from '../src/drawings/drawing';
import { MINUTE, TestChart, candles } from './drawing-helpers';

/** Internals the tests read: where the chart maps bars and prices right now. */
interface Internals {
	scale: { indexToX(index: number): number; xToLogical(x: number): number; version: number };
}

function setup(): { t: TestChart; series: SeriesApi<'candlestick'> } {
	const t = new TestChart();
	const series = t.chart.addSeries('candlestick');
	series.setData(candles(1000));
	t.chart.timeScale().setVisibleLogicalRange({ from: 900, to: 999 });
	return { t, series };
}

function internals(t: TestChart): Internals {
	return t.chart as unknown as Internals;
}

/** Pane position of a logical position and a price, as the chart maps them now. */
function at(t: TestChart, position: number, price: number): { x: number; y: number } {
	const chart = internals(t);
	return { x: chart.scale.indexToX(position), y: t.chart.priceScale().priceToCoordinate(price)! };
}

/** Logical positions of a drawing's points, as the chart resolved them. */
function logical(drawing: DrawingApi): [number, number] {
	const positions = (drawing as unknown as Drawing).logical;
	return [positions[0]!, positions[1]!];
}

const trend = (from: number, to: number, a = 95, b = 105) => ({
	type: 'trendLine' as const,
	points: [
		{ time: from * MINUTE, price: a },
		{ time: to * MINUTE, price: b },
	],
});

describe('drawings on a chart', () => {
	let t: TestChart;
	let series: SeriesApi<'candlestick'>;

	beforeEach(async () => {
		({ t, series } = setup());
		await t.settle();
	});

	afterEach(() => {
		t.destroy();
		setCanvasBudget(48 * 1024 * 1024);
	});

	describe('layers', () => {
		it('adds a drawings layer with the first drawing, without redrawing the series', async () => {
			expect(t.canvases().length).toBe(4);
			t.clearCalls();
			const line = t.chart.drawings().add(trend(920, 980));
			await t.settle();
			expect(t.canvases().length).toBe(5);
			expect(t.drawingsLayer.some(call => call.name === 'stroke')).toBe(true);
			const a = at(t, 920, 95);
			const b = at(t, 980, 105);
			expect(t.chart.drawings().hitTest((a.x + b.x) / 2, (a.y + b.y) / 2)).toBe(line);
			expect(t.chart.drawings().hitTest((a.x + b.x) / 2, (a.y + b.y) / 2 + 30)).toBeNull();
		});

		it('redraws only the overlay when the pointer hovers a drawing', async () => {
			const line = t.chart.drawings().add(trend(920, 980));
			await t.settle();
			const hovered: (DrawingApi | null)[] = [];
			t.chart.drawings().subscribe('hovered', drawing => hovered.push(drawing));
			t.clearCalls();
			const a = at(t, 920, 95);
			const b = at(t, 980, 105);
			t.pointer('pointermove', (a.x + b.x) / 2, (a.y + b.y) / 2);
			t.runFrames();
			expect(hovered).toEqual([line]);
			expect(t.chart.drawings().hovered()).toBe(line);
			expect(t.pane.length).toBe(0);
			expect(t.drawingsLayer.length).toBe(0);
			// The handles of the hovered line, on the overlay.
			expect(t.overlay.filter(call => call.name === 'arc').length).toBe(2);
			t.pointer('pointermove', 100, 50);
			t.runFrames();
			expect(hovered).toEqual([line, null]);
			expect(t.drawingsLayer.length).toBe(0);
		});

		it('moves a dragged drawing to the overlay: the others are drawn once when it leaves, once when it returns', async () => {
			const drawings = t.chart.drawings();
			for (let i = 0; i < 20; i++) {
				drawings.add(trend(905 + i, 915 + i, 90 + i, 92 + i));
			}
			const line = drawings.add(trend(920, 980));
			await t.settle();
			const a = at(t, 920, 95);
			const b = at(t, 980, 105);
			const start = { x: a.x + (b.x - a.x) / 4, y: a.y + (b.y - a.y) / 4 };
			t.clearCalls();
			t.pointer('pointerdown', start.x, start.y);
			t.runFrames();
			expect(drawings.selected()).toBe(line);
			expect(t.drawingsLayer.length).toBe(0);
			t.pointer('pointermove', start.x + 20, start.y);
			t.runFrames();
			// It left the layer: the 20 others are drawn once more without it.
			const strokes = (): number => t.drawingsLayer.filter(call => call.name === 'stroke').length;
			expect(strokes()).toBe(20);
			t.clearCalls();
			for (let i = 1; i <= 5; i++) {
				t.pointer('pointermove', start.x + 20 + i * 10, start.y + i);
				t.runFrames();
			}
			expect(t.drawingsLayer.length).toBe(0);
			expect(t.pane.length).toBe(0);
			expect(t.overlay.some(call => call.name === 'stroke')).toBe(true);
			t.clearCalls();
			t.pointer('pointerup', start.x + 70, start.y + 5);
			t.runFrames();
			expect(strokes()).toBe(21);
		});

		it('redraws drawings when the view moves, not when a tick leaves it as it was', async () => {
			t.chart.drawings().add(trend(920, 980));
			t.chart.timeScale().setVisibleLogicalRange({ from: 900, to: 1010 });
			await t.settle();
			// A tick that keeps the high and low of the last bar leaves the price scale as it is.
			const last = candles(1000);
			t.clearCalls();
			series.update({
				time: 999 * MINUTE,
				open: last.open[999]!,
				high: last.high[999]!,
				low: last.low[999]!,
				close: last.close[999]! + 0.5,
			});
			await t.settle();
			expect(t.pane.length).toBeGreaterThan(0);
			expect(t.drawingsLayer.length).toBe(0);
			t.clearCalls();
			t.chart.timeScale().setVisibleLogicalRange({ from: 890, to: 1000 });
			await t.settle();
			expect(t.drawingsLayer.some(call => call.name === 'stroke')).toBe(true);
		});

		it('merges drawings into the series layer past the canvas budget', async () => {
			t.destroy();
			setCanvasBudget(1);
			({ t } = setup());
			await t.settle();
			t.chart.drawings().add(trend(920, 980));
			await t.settle();
			expect(t.canvases().length).toBe(4);
			expect(t.pane.some(call => call.name === 'stroke')).toBe(true);
			// Hovering still redraws the overlay alone.
			t.clearCalls();
			t.pointer('pointermove', 100, 50);
			t.runFrames();
			expect(t.pane.length).toBe(0);
		});
	});

	describe('pointer and keyboard', () => {
		it('creates a two-point drawing with two clicks, then selects it and ends the tool', async () => {
			const drawings = t.chart.drawings();
			const created: DrawingApi[] = [];
			drawings.subscribe('created', drawing => created.push(drawing));
			drawings.startTool('trendLine', { color: '#ff0000' });
			expect(drawings.activeTool()).toBe('trendLine');
			const a = at(t, 930, 100);
			const b = at(t, 960, 104);
			t.click(a.x + 1, a.y);
			expect(created).toEqual([]);
			// The second point follows the pointer until the second click.
			t.pointer('pointermove', b.x, b.y);
			t.runFrames();
			expect(t.overlay.some(call => call.name === 'stroke')).toBe(true);
			t.click(b.x, b.y);
			expect(created.length).toBe(1);
			const line = created[0]!;
			expect(drawings.activeTool()).toBeNull();
			expect(drawings.selected()).toBe(line);
			expect(line.options().color).toBe('#ff0000');
			const [p0, p1] = line.points();
			// Points snap to bars; prices are free.
			expect(p0!.time).toBe(930 * MINUTE);
			expect(p1!.time).toBe(960 * MINUTE);
			expect(p0!.price).toBeCloseTo(100, 1);
			expect(p1!.price).toBeCloseTo(104, 1);
			expect(drawings.list()).toEqual([line]);
		});

		it('places every point of clicks that come faster than frames', async () => {
			const drawings = t.chart.drawings();
			drawings.startTool('fibRetracement');
			const a = at(t, 920, 96);
			const b = at(t, 950, 104);
			t.pointer('pointerdown', a.x, a.y);
			t.pointer('pointerup', a.x, a.y);
			t.pointer('pointerdown', b.x, b.y);
			t.pointer('pointerup', b.x, b.y);
			t.runFrames();
			const fib = drawings.list()[0]!;
			expect(fib.type).toBe('fibRetracement');
			expect(fib.points().map(point => point.time)).toEqual([920 * MINUTE, 950 * MINUTE]);
		});

		it('pinches rather than edits when a second finger comes before the first press is answered', async () => {
			t.chart.drawings().add(trend(900, 999, 100, 100));
			await t.settle();
			const scale = internals(t).scale as unknown as { barSpacing: number };
			const spacing = scale.barSpacing;
			const p = at(t, 950, 100);
			const touch = (type: string, id: number, x: number): void =>
				t.pointer(type, x, p.y, { pointerId: id, pointerType: 'touch' });
			touch('pointerdown', 1, p.x);
			touch('pointerdown', 2, p.x + 100);
			touch('pointermove', 2, p.x + 200);
			t.runFrames();
			expect(t.chart.drawings().selected()).toBeNull();
			expect(scale.barSpacing).toBeGreaterThan(spacing);
			touch('pointerup', 1, p.x);
			touch('pointerup', 2, p.x + 200);
			t.runFrames();
		});

		it('creates a drawing with a press, a drag and a release', async () => {
			const drawings = t.chart.drawings();
			drawings.startTool('rectangle');
			const a = at(t, 920, 96);
			const b = at(t, 950, 104);
			t.pointer('pointerdown', a.x, a.y);
			t.runFrames();
			t.pointer('pointermove', (a.x + b.x) / 2, (a.y + b.y) / 2);
			t.runFrames();
			t.pointer('pointermove', b.x, b.y);
			t.runFrames();
			t.pointer('pointerup', b.x, b.y);
			t.runFrames();
			const rectangle = drawings.list()[0]!;
			expect(rectangle.type).toBe('rectangle');
			expect(rectangle.points().map(point => point.time)).toEqual([920 * MINUTE, 950 * MINUTE]);
		});

		it('places single-point tools with one click and three-point channels with three', async () => {
			const drawings = t.chart.drawings();
			drawings.startTool('horizontalLine');
			const a = at(t, 940, 101);
			t.click(a.x, a.y);
			expect(drawings.list().map(d => d.type)).toEqual(['horizontalLine']);
			drawings.startTool('parallelChannel');
			for (const [bar, price] of [
				[910, 95],
				[950, 100],
				[930, 106],
			] as const) {
				const p = at(t, bar, price);
				t.click(p.x, p.y);
			}
			const channel = drawings.list()[1]!;
			expect(channel.type).toBe('parallelChannel');
			expect(channel.points().map(point => point.time)).toEqual([910 * MINUTE, 950 * MINUTE, 930 * MINUTE]);
		});

		it('cancels a drawing being created with Escape', async () => {
			const drawings = t.chart.drawings();
			drawings.startTool('trendLine');
			const a = at(t, 930, 100);
			t.click(a.x, a.y);
			t.key('Escape');
			t.runFrames();
			expect(drawings.activeTool()).toBeNull();
			expect(drawings.list()).toEqual([]);
			const strokes = t.overlay.filter(call => call.name === 'stroke').length;
			t.clearCalls();
			t.pointer('pointermove', a.x + 50, a.y);
			t.runFrames();
			expect(t.overlay.filter(call => call.name === 'stroke').length).toBeLessThanOrEqual(strokes);
		});

		it('drags a drawing by whole bars, and a point by its handle', async () => {
			const drawings = t.chart.drawings();
			const line = drawings.add(trend(920, 980));
			await t.settle();
			const changed: DrawingApi[] = [];
			drawings.subscribe('changed', drawing => changed.push(drawing));
			const a = at(t, 920, 95);
			const b = at(t, 980, 105);
			const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
			const spacing = at(t, 921, 95).x - a.x;
			t.pointer('pointerdown', mid.x, mid.y);
			t.runFrames();
			t.pointer('pointermove', mid.x + spacing * 5.2, mid.y);
			t.runFrames();
			t.pointer('pointerup', mid.x + spacing * 5.2, mid.y);
			t.runFrames();
			expect(changed).toEqual([line]);
			expect(line.points().map(point => point.time)).toEqual([925 * MINUTE, 985 * MINUTE]);
			expect(line.points()[0]!.price).toBeCloseTo(95, 6);
			// The second point's handle, moved to bar 990.
			const handle = at(t, 985, 105);
			const target = at(t, 990, 108);
			t.pointer('pointerdown', handle.x, handle.y);
			t.runFrames();
			t.pointer('pointermove', target.x, target.y);
			t.runFrames();
			t.pointer('pointerup', target.x, target.y);
			t.runFrames();
			expect(line.points()[0]!.time).toBe(925 * MINUTE);
			expect(line.points()[1]!.time).toBe(990 * MINUTE);
			expect(line.points()[1]!.price).toBeCloseTo(108, 1);
		});

		it('drags a rectangle by a corner its points do not name, and by the middle of an edge', async () => {
			const drawings = t.chart.drawings();
			const box = drawings.add({
				type: 'rectangle',
				points: [
					{ time: 920 * MINUTE, price: 95 },
					{ time: 980 * MINUTE, price: 105 },
				],
			});
			await t.settle();
			const changed: DrawingApi[] = [];
			drawings.subscribe('changed', drawing => changed.push(drawing));
			const drag = (from: { x: number; y: number }, to: { x: number; y: number }) => {
				t.pointer('pointerdown', from.x, from.y);
				t.runFrames();
				t.pointer('pointermove', to.x, to.y);
				t.runFrames();
				t.pointer('pointerup', to.x, to.y);
				t.runFrames();
			};
			// The corner at the first point's time and the second's price; (980, 95) stays.
			drag(at(t, 920, 105), at(t, 930, 102));
			let points = box.points();
			expect(points[0]!.time).toBe(930 * MINUTE);
			expect(points[0]!.price).toBe(95);
			expect(points[1]!.time).toBe(980 * MINUTE);
			expect(points[1]!.price).toBeCloseTo(102, 1);
			// The middle of the right edge moves that edge in time alone.
			const middle = at(t, 980, (95 + points[1]!.price) / 2);
			t.pointer('pointermove', middle.x, middle.y);
			t.runFrames();
			expect(t.chart.element().style.cursor).toBe('ew-resize');
			const price = points[1]!.price;
			drag(middle, { x: at(t, 970, 0).x, y: middle.y - 30 });
			points = box.points();
			expect(points.map(point => point.time)).toEqual([930 * MINUTE, 970 * MINUTE]);
			expect(points.map(point => point.price)).toEqual([95, price]);
			expect(changed).toEqual([box, box]);
			// Two points still: the handles are derived, the state is what it was.
			expect(box.toJSON().points.length).toBe(2);
			// Escape puts a dragged corner back.
			const corner = at(t, 970, 95);
			t.pointer('pointerdown', corner.x, corner.y);
			t.runFrames();
			t.pointer('pointermove', corner.x + 40, corner.y + 40);
			t.runFrames();
			t.key('Escape');
			t.pointer('pointerup', corner.x + 40, corner.y + 40);
			t.runFrames();
			expect(box.points()).toEqual(points);
		});

		it('puts a drawing back where it was on Escape during a drag', async () => {
			const drawings = t.chart.drawings();
			const line = drawings.add(trend(920, 980));
			await t.settle();
			const before = line.points();
			const a = at(t, 920, 95);
			const b = at(t, 980, 105);
			const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
			t.pointer('pointerdown', mid.x, mid.y);
			t.runFrames();
			t.pointer('pointermove', mid.x + 40, mid.y + 20);
			t.runFrames();
			t.key('Escape');
			expect(line.points()).toEqual(before);
			t.pointer('pointerup', mid.x + 40, mid.y + 20);
			t.runFrames();
			expect(line.points()).toEqual(before);
		});

		it('creates a drawing with a touch drag, and undoes a drag the browser cancels', async () => {
			const drawings = t.chart.drawings();
			drawings.startTool('trendLine');
			const a = at(t, 920, 96);
			const b = at(t, 950, 104);
			const touch = { pointerType: 'touch' };
			t.pointer('pointerdown', a.x, a.y, touch);
			t.runFrames();
			t.pointer('pointermove', b.x, b.y, touch);
			t.runFrames();
			t.pointer('pointerup', b.x, b.y, touch);
			t.runFrames();
			const line = drawings.list()[0]!;
			expect(line.points().map(point => point.time)).toEqual([920 * MINUTE, 950 * MINUTE]);
			const before = line.points();
			const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
			t.pointer('pointerdown', mid.x, mid.y, touch);
			t.runFrames();
			t.pointer('pointermove', mid.x + 50, mid.y, touch);
			t.runFrames();
			expect(line.points()).not.toEqual(before);
			t.pointer('pointercancel', mid.x + 50, mid.y, touch);
			t.runFrames();
			expect(line.points()).toEqual(before);
		});

		it('ends a drag when its drawing is removed meanwhile', async () => {
			const drawings = t.chart.drawings();
			const line = drawings.add(trend(920, 980));
			await t.settle();
			const changed: DrawingApi[] = [];
			drawings.subscribe('changed', drawing => changed.push(drawing));
			const a = at(t, 920, 95);
			const b = at(t, 980, 105);
			const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
			t.pointer('pointerdown', mid.x, mid.y);
			t.runFrames();
			t.pointer('pointermove', mid.x + 40, mid.y);
			t.runFrames();
			line.remove();
			t.clearCalls();
			t.pointer('pointermove', mid.x + 60, mid.y);
			t.runFrames();
			t.pointer('pointerup', mid.x + 60, mid.y);
			t.runFrames();
			expect(changed).toEqual([]);
			expect(drawings.list()).toEqual([]);
			expect(t.overlay.some(call => call.name === 'arc')).toBe(false);
		});

		it('removes the selected drawing with Delete, unless it is locked', async () => {
			const drawings = t.chart.drawings();
			const removed: DrawingApi[] = [];
			drawings.subscribe('removed', drawing => removed.push(drawing));
			const line = drawings.add(trend(920, 980));
			const locked = drawings.add({ ...trend(920, 980, 90, 90), options: { locked: true } });
			await t.settle();
			drawings.select(locked);
			t.key('Delete');
			expect(drawings.list()).toEqual([line, locked]);
			drawings.select(line);
			t.key('Delete');
			expect(removed).toEqual([line]);
			expect(drawings.list()).toEqual([locked]);
			expect(drawings.selected()).toBeNull();
		});

		it('pans instead of moving a locked drawing, or where no drawing is', async () => {
			const drawings = t.chart.drawings();
			const locked = drawings.add({ ...trend(920, 980, 100, 100), options: { locked: true } });
			await t.settle();
			const scale = internals(t).scale;
			const p = at(t, 950, 100);
			const before = scale.xToLogical(p.x);
			t.pointer('pointerdown', p.x, p.y);
			t.runFrames();
			expect(drawings.selected()).toBe(locked);
			t.pointer('pointermove', p.x + 60, p.y);
			t.runFrames();
			t.pointer('pointerup', p.x + 60, p.y);
			await t.settle();
			expect(locked.points()[0]!.time).toBe(920 * MINUTE);
			expect(scale.xToLogical(p.x)).toBeLessThan(before - 5);
		});

		it('snaps points to the open, high, low or close in magnet mode', async () => {
			t.chart.applyOptions({ crosshair: { mode: 'magnet' } });
			const data = candles(1000);
			const drawings = t.chart.drawings();
			drawings.startTool('horizontalLine');
			// Just above the high of bar 940.
			const p = at(t, 940, data.high[940]! + 0.3);
			t.click(p.x, p.y);
			expect(drawings.list()[0]!.points()[0]!.price).toBe(data.high[940]);
		});

		it('snaps points to the nearest value of every series on their scale, and closes only in nearest mode', async () => {
			t.chart.applyOptions({ crosshair: { mode: 'magnet' } });
			const data = candles(1000);
			// A line above the candles, on the same scale, added after them.
			t.chart.addSeries('line').setData({ time: data.time, value: data.high.map(value => value + 5) });
			await t.settle();
			const drawings = t.chart.drawings();
			drawings.startTool('horizontalLine');
			let p = at(t, 940, data.high[940]! + 4.2);
			t.click(p.x, p.y);
			expect(drawings.list()[0]!.points()[0]!.price).toBe(data.high[940]! + 5);
			t.chart.applyOptions({ crosshair: { mode: 'nearest' } });
			drawings.startTool('horizontalLine');
			p = at(t, 940, data.low[940]! - 0.3);
			t.click(p.x, p.y);
			expect(drawings.list()[1]!.points()[0]!.price).toBe(data.close[940]);
		});

		it('reaches drawings from further away with touch', async () => {
			const drawings = t.chart.drawings();
			const line = drawings.add(trend(920, 980, 100, 100));
			await t.settle();
			const p = at(t, 950, 100);
			t.click(p.x, p.y + 9, { pointerType: 'mouse' });
			expect(drawings.selected()).toBeNull();
			t.click(p.x, p.y + 9, { pointerType: 'touch' });
			expect(drawings.selected()).toBe(line);
		});

		it('reads the layout only in frames, also for presses on drawings', async () => {
			t.chart.drawings().add(trend(920, 980));
			await t.settle();
			const reads = t.rectReads;
			const p = at(t, 950, 100);
			t.pointer('pointerdown', p.x, p.y);
			t.pointer('pointermove', p.x + 5, p.y);
			t.pointer('pointermove', p.x + 10, p.y);
			t.pointer('pointerup', p.x + 10, p.y);
			expect(t.rectReads).toBe(reads);
			t.runFrames();
			expect(t.rectReads).toBe(reads + 1);
		});
	});

	describe('points stored as times', () => {
		it('places times between bars between them and future times at the spacing of the last bars', async () => {
			const drawings = t.chart.drawings();
			const between = drawings.add(trend(930.5, 1004));
			await t.settle();
			const [a, b] = logical(between);
			expect(a).toBeCloseTo(930.5);
			// Five bars past the last one, a bar a minute.
			expect(b).toBeCloseTo(1004);
			// A new bar arrives a minute later: the future point stays where it was.
			series.update({ time: 1000 * MINUTE, open: 100, high: 101, low: 99, close: 100 });
			await t.settle();
			expect(logical(between)[1]).toBeCloseTo(1004);
		});

		it('keeps its place through a prepend, and resolves a point in history it reaches', async () => {
			const drawings = t.chart.drawings();
			// The first point is 100 minutes before the first bar.
			const line = drawings.add(trend(-100, 950));
			await t.settle();
			expect(logical(line)[0]).toBeCloseTo(-100);
			const older = candles(200, -200);
			series.prepend(older);
			await t.settle();
			expect(logical(line)).toEqual([-100, 950]);
		});

		it('maps old times onto a new resolution', async () => {
			const drawings = t.chart.drawings();
			const line = drawings.add(trend(907, 990));
			await t.settle();
			// Five-minute bars over the same time: bar k at minute 5k.
			const five = candles(200);
			five.time = five.time.map((_, k) => k * 5 * MINUTE);
			series.setData(five);
			t.chart.timeScale().setVisibleLogicalRange({ from: 150, to: 199 });
			await t.settle();
			const [a, b] = logical(line);
			expect(a).toBeCloseTo(907 / 5);
			expect(b).toBeCloseTo(990 / 5);
		});

		it('follows bars removed in the middle', async () => {
			const drawings = t.chart.drawings();
			const line = drawings.add(trend(960, 990));
			await t.settle();
			series.removeBars({ from: 940 * MINUTE, to: 949 * MINUTE });
			await t.settle();
			const [a, b] = logical(line);
			// Ten bars fewer before them, whichever side moved.
			expect(b - a).toBeCloseTo(30);
			const scale = internals(t).scale as unknown as { first: number; end: number };
			expect(scale.end - 1 - b).toBeCloseTo(9);
		});

		it('resolves points far outside the bars held through the engine', async () => {
			const drawings = t.chart.drawings();
			const line = drawings.add(trend(10, 20));
			await t.settle();
			expect(logical(line)).toEqual([10, 20]);
		});
	});

	describe('state', () => {
		it('round-trips through JSON into another chart', async () => {
			const drawings = t.chart.drawings();
			drawings.add(trend(920, 980));
			drawings.add({
				type: 'fibRetracement',
				points: [
					{ time: 900 * MINUTE, price: 110 },
					{ time: 950 * MINUTE, price: 90 },
				],
				options: { levels: [0, 0.5, 1], lineStyle: 'dashed' },
				zIndex: 3,
			});
			drawings.add({ type: 'text', points: [{ time: 940 * MINUTE, price: 100 }], options: { text: 'a\nb' } });
			const saved = JSON.parse(JSON.stringify(drawings.toJSON())) as DrawingState[];
			expect(saved.map(state => state.version)).toEqual([1, 1, 1]);
			expect(saved.map(state => state.type)).toEqual(['trendLine', 'text', 'fibRetracement']);

			t.destroy();
			t = new TestChart();
			t.chart.addSeries('candlestick').setData(candles(1000));
			for (const state of saved) {
				t.chart.drawings().add(state);
			}
			await t.settle();
			const restored = t.chart.drawings();
			expect(restored.toJSON()).toEqual(saved);
			expect(() => restored.add(saved[0]!)).toThrow(/exists/);
			expect(() => restored.add({ ...saved[0]!, id: 'x', version: 2 as 1 })).toThrow(/version/);
			expect(() => restored.add({ type: 'trendLine', points: [] })).toThrow(/2 points/);
		});

		it('orders drawings by z-index', async () => {
			const drawings = t.chart.drawings();
			const a = drawings.add(trend(920, 980));
			const b = drawings.add(trend(920, 980));
			expect(drawings.list()).toEqual([a, b]);
			a.bringToFront();
			expect(drawings.list()).toEqual([b, a]);
			await t.settle();
			const p = at(t, 950, 100);
			expect(drawings.hitTest(p.x, p.y)).toBe(a);
			a.sendToBack();
			expect(drawings.list()).toEqual([a, b]);
			expect(drawings.hitTest(p.x, p.y)).toBe(b);
		});

		it('applies options and points through the API with events', async () => {
			const drawings = t.chart.drawings();
			const line = drawings.add(trend(920, 980));
			const changed: DrawingApi[] = [];
			drawings.subscribe('changed', drawing => changed.push(drawing));
			line.applyOptions({ color: '#00ff00', lineWidth: undefined });
			expect(line.options().color).toBe('#00ff00');
			expect(line.options().lineWidth).toBe(2);
			line.setPoints([
				{ time: 930 * MINUTE, price: 100 },
				{ time: 940 * MINUTE, price: 101 },
			]);
			expect(changed).toEqual([line, line]);
			expect(() => line.setPoints([{ time: 1, price: 1 }])).toThrow(/2 points/);
			line.remove();
			expect(drawings.get(line.id)).toBeNull();
		});
	});
});

describe('drawing points in magnet mode', () => {
	let t: TestChart | null = null;
	afterEach(() => {
		t?.destroy();
		t = null;
	});

	it('snap where the crosshair snaps, never to a value above or below the pane', async () => {
		t = new TestChart();
		const data = candles(1000);
		t.chart.addSeries('candlestick').setData(data);
		t.chart.timeScale().setVisibleLogicalRange({ from: 900, to: 999 });
		t.chart.applyOptions({ crosshair: { mode: 'magnet' } });
		await t.settle();
		// A manual range that leaves the high of bar 940 above the pane, nearer the pointer than its close.
		const base = data.open[940]!;
		t.chart.priceScale().setVisibleRange({ from: base - 2.5, to: base + 1.2 });
		await t.settle();
		const x = (t.chart as unknown as { scale: { indexToX(i: number): number } }).scale.indexToX(940);
		expect(t.chart.priceScale().priceToCoordinate(data.high[940]!)!).toBeLessThan(0);
		t.clearCalls();
		t.pointer('pointermove', x, 2);
		t.runFrames();
		const labels = t.overlay.filter(call => call.name === 'fillText').map(call => String(call.args[0]));
		expect(labels).toContain(data.close[940]!.toFixed(2));
		const drawings = t.chart.drawings();
		drawings.startTool('horizontalLine');
		t.click(x, 2);
		await t.settle();
		expect(drawings.list()[0]!.points()[0]!.price).toBe(data.close[940]);
	});
});
