import type { DrawingApi } from '@lumen-ticks/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { Drawing } from '../src/drawings/drawing';
import { MINUTE, TestChart, candles } from './drawing-helpers';

/** Screen points of a drawing, as it was last laid out (CSS pixels in the pane). */
function screen(drawing: DrawingApi): number[] {
	return [...(drawing as unknown as Drawing).geometry.subarray(0, 4)];
}

function x(t: TestChart, index: number): number {
	return (t.chart as unknown as { scale: { indexToX(i: number): number } }).scale.indexToX(index);
}

const line = (a: number, b: number, scale = 'default') => ({
	type: 'trendLine' as const,
	points: [
		{ time: 920 * MINUTE, price: a },
		{ time: 980 * MINUTE, price: b },
	],
	priceScaleId: scale,
});

describe('drawings on price scales', () => {
	let t: TestChart;

	afterEach(() => {
		t.destroy();
	});

	async function chart(options: Parameters<TestChart['chart']['applyOptions']>[0] = {}): Promise<void> {
		t = new TestChart(options);
		t.chart.addSeries('candlestick').setData(candles(1000));
		t.chart.timeScale().setVisibleLogicalRange({ from: 900, to: 999 });
		await t.settle();
	}

	it('sits at its prices on a logarithmic scale, straight on screen between them', async () => {
		await chart({ priceScale: { mode: 'logarithmic' } });
		const scale = t.chart.priceScale();
		const drawing = t.chart.drawings().add(line(92, 108));
		await t.settle();
		const [x0, y0, x1, y1] = screen(drawing);
		expect(x0).toBeCloseTo(x(t, 920), 6);
		expect(y0).toBeCloseTo(scale.priceToCoordinate(92)!, 6);
		expect(y1).toBeCloseTo(scale.priceToCoordinate(108)!, 6);
		expect(t.chart.drawings().hitTest((x0! + x1!) / 2, (y0! + y1!) / 2)).toBe(drawing);
		// Fibonacci levels are taken in price: level 0.5 of 92 to 108 is at 100.
		const fib = t.chart.drawings().add({ ...line(92, 108), type: 'fibRetracement', options: { levels: [0.5] } });
		await t.settle();
		expect(t.chart.drawings().hitTest(x(t, 925), scale.priceToCoordinate(100)!)).toBe(fib);
	});

	it('maps prices with the base of a percentage scale, which moves with the view', async () => {
		await chart({ priceScale: { mode: 'percentage' } });
		const scale = t.chart.priceScale();
		const drawing = t.chart.drawings().add(line(95, 105));
		await t.settle();
		expect(screen(drawing)[1]).toBeCloseTo(scale.priceToCoordinate(95)!, 6);
		const before = screen(drawing)[1]!;
		// Another first visible bar: another base, so the same price is drawn elsewhere.
		t.chart.timeScale().setVisibleLogicalRange({ from: 870, to: 969 });
		await t.settle();
		expect(screen(drawing)[1]).toBeCloseTo(scale.priceToCoordinate(95)!, 6);
		expect(screen(drawing)[1]).not.toBeCloseTo(before, 1);
	});

	it('follows an inverted scale', async () => {
		await chart({ priceScale: { invertScale: true } });
		const scale = t.chart.priceScale();
		const drawing = t.chart.drawings().add(line(95, 105));
		await t.settle();
		const [, y0, , y1] = screen(drawing);
		expect(y0).toBeCloseTo(scale.priceToCoordinate(95)!, 6);
		expect(y1!).toBeGreaterThan(y0!);
	});

	it('binds to the scale it names, here an overlay of another series', async () => {
		await chart();
		const values = candles(1000);
		t.chart.addSeries('line', { priceScaleId: 'volume' }).setData({
			time: values.time,
			value: values.close.map(close => close * 1000),
		});
		const drawing = t.chart.drawings().add(line(95_000, 105_000, 'volume'));
		await t.settle();
		const overlay = t.chart.priceScale('volume');
		expect(screen(drawing)[1]).toBeCloseTo(overlay.priceToCoordinate(95_000)!, 6);
		expect(drawing.toJSON().priceScaleId).toBe('volume');
		// On a scale with nothing on it the drawing waits, unseen, for a range.
		const lonely = t.chart.drawings().add(line(1, 2, 'empty'));
		await t.settle();
		expect((lonely as unknown as Drawing).onScreen).toBe(false);
	});

	it('snaps to the bar of a series on its own scale, in any mode', async () => {
		await chart({ priceScale: { mode: 'percentage' }, crosshair: { mode: 'magnet' } });
		const values = candles(1000);
		// A series on another scale, near the pointer on screen, is not what a point snaps to.
		t.chart.addSeries('line', { priceScaleId: 'other' }).setData({ time: values.time, value: values.close });
		await t.settle();
		const drawings = t.chart.drawings();
		drawings.startTool('horizontalLine');
		const y = t.chart.priceScale().priceToCoordinate(values.close[950]!)!;
		t.click(x(t, 950), y + 1);
		expect(drawings.list()[0]!.points()[0]!.price).toBe(values.close[950]);
	});
});
