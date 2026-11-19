import type { AutoscaleRange, PanePrimitive, PaneView, PrimitiveHost } from '@lumen-charts/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Drawing } from '../src/drawings/drawing';
import { MINUTE, TestChart, candles } from './drawing-helpers';

/** A primitive that wants prices `low` to `high` in view while bars `from` to `to` are. */
class Band implements PanePrimitive {
	public host: PrimitiveHost | null = null;
	public asked = 0;
	public seen: [number, number][] = [];

	public constructor(
		public from: number,
		public to: number,
		public low: number,
		public high: number,
	) {}

	public attached(host: PrimitiveHost): void {
		this.host = host;
	}

	public draw(): void {}

	public autoscale(range: AutoscaleRange, view: PaneView): boolean {
		this.asked++;
		this.seen.push([range.from, range.to]);
		if (view.timeToLogical(this.to * MINUTE) < range.from || view.timeToLogical(this.from * MINUTE) > range.to) {
			return false;
		}
		range.low = this.low;
		range.high = this.high;
		return true;
	}
}

/** A horizontal line that takes part in autoscale unless `options` say otherwise. */
const line = (price: number, options = {}) => ({
	type: 'horizontalLine' as const,
	points: [{ time: 950 * MINUTE, price }],
	options: { autoscale: true, ...options },
});

describe('autoscale with primitives and drawings', () => {
	let t: TestChart;

	beforeEach(async () => {
		t = new TestChart();
		t.chart.addSeries('candlestick', { id: 'main' }).setData(candles(1000));
		t.chart.timeScale().setVisibleLogicalRange({ from: 900, to: 999 });
		await t.settle();
	});

	afterEach(() => {
		t.destroy();
	});

	const range = (id?: string) => t.chart.priceScale(id).getVisibleRange()!;

	it('leaves the range to the series unless a drawing opts in', async () => {
		const series = range();
		expect(series.to).toBeLessThan(120);
		const drawing = t.chart.drawings().add(line(150, { autoscale: false }));
		await t.settle();
		expect(range()).toEqual(series);
		drawing.applyOptions({ autoscale: true });
		await t.settle();
		// Joined with the series: their low stays, the high is the line's.
		expect(range()).toEqual({ from: series.from, to: 150 });
		drawing.applyOptions({ autoscale: false });
		await t.settle();
		expect(range()).toEqual(series);
	});

	it('follows an opted-in drawing as it is added, moved, hidden and removed', async () => {
		const series = range();
		const drawing = t.chart.drawings().add(line(60));
		await t.settle();
		expect(range()).toEqual({ from: 60, to: series.to });
		drawing.setPoints([{ time: 950 * MINUTE, price: 70 }]);
		await t.settle();
		expect(range().from).toBe(70);
		drawing.applyOptions({ visible: false });
		await t.settle();
		expect(range()).toEqual(series);
		drawing.applyOptions({ visible: true });
		await t.settle();
		expect(range().from).toBe(70);
		drawing.remove();
		await t.settle();
		expect(range()).toEqual(series);
	});

	it('counts a drawing only while the time span of its points overlaps the view', async () => {
		const drawings = t.chart.drawings();
		drawings.add({
			type: 'rectangle',
			points: [
				{ time: 700 * MINUTE, price: 20 },
				{ time: 760 * MINUTE, price: 200 },
			],
			options: { autoscale: true },
		});
		// A vertical line has no price, and an extended line counts where its points are.
		drawings.add({ type: 'verticalLine', points: [{ time: 950 * MINUTE, price: 500 }], options: { autoscale: true } });
		drawings.add({
			type: 'extendedLine',
			points: [
				{ time: 100 * MINUTE, price: 400 },
				{ time: 200 * MINUTE, price: 300 },
			],
			options: { autoscale: true },
		});
		await t.settle();
		expect(range().from).toBeGreaterThan(80);
		expect(range().to).toBeLessThan(120);
		t.chart.timeScale().setVisibleLogicalRange({ from: 750, to: 850 });
		await t.settle();
		expect(range()).toEqual({ from: 20, to: 200 });
		t.chart.timeScale().setVisibleLogicalRange({ from: 761, to: 860 });
		await t.settle();
		expect(range().from).toBeGreaterThan(80);
	});

	it('asks a drawing once, keeps its span, and asks again when it or the timeline changed', async () => {
		const asked = vi.spyOn(Drawing.prototype as unknown as { _priceRange(): boolean }, '_priceRange');
		const drawing = t.chart.drawings().add({
			type: 'rectangle',
			points: [
				{ time: 700 * MINUTE, price: 20 },
				{ time: 760 * MINUTE, price: 200 },
			],
			options: { autoscale: true },
		});
		await t.settle();
		expect(asked).toHaveBeenCalledTimes(1);
		for (const from of [850, 800, 740, 700, 650, 800]) {
			t.chart.timeScale().setVisibleLogicalRange({ from, to: from + 99 });
			// oxlint-disable-next-line no-await-in-loop
			await t.settle();
			expect(range().to === 200).toBe(from <= 760 && from + 99 >= 700);
		}
		expect(asked).toHaveBeenCalledTimes(1);
		drawing.setPoints([
			{ time: 700 * MINUTE, price: 20 },
			{ time: 860 * MINUTE, price: 300 },
		]);
		await t.settle();
		expect(asked).toHaveBeenCalledTimes(2);
		expect(range().to).toBe(300);
		// Another history: the same times are at other positions, 300 bars to the left.
		const main = t.chart.series()[0] as unknown as { setData(data: unknown): void };
		main.setData(candles(1000, 300));
		t.chart.timeScale().setVisibleLogicalRange({ from: 380, to: 420 });
		await t.settle();
		expect(asked.mock.calls.length).toBeGreaterThan(2);
		expect(range()).toEqual({ from: 20, to: 300 });
		t.chart.timeScale().setVisibleLogicalRange({ from: 600, to: 700 });
		await t.settle();
		expect(range().to).toBeLessThan(120);
	});

	it('takes every Fibonacci level and both lines of a channel', async () => {
		const drawings = t.chart.drawings();
		const fib = drawings.add({
			type: 'fibRetracement',
			points: [
				{ time: 920 * MINUTE, price: 110 },
				{ time: 960 * MINUTE, price: 100 },
			],
			options: { autoscale: true, levels: [0, 1, 2.5, -1] },
		});
		await t.settle();
		// Levels are taken in price from the second point: 100 + 10 * level.
		expect(range()).toEqual({ from: 90, to: 125 });
		fib.remove();
		drawings.add({
			type: 'parallelChannel',
			points: [
				{ time: 920 * MINUTE, price: 100 },
				{ time: 960 * MINUTE, price: 110 },
				{ time: 940 * MINUTE, price: 145 },
			],
			options: { autoscale: true },
		});
		await t.settle();
		// The parallel line is 40 above the base line: from 140 to 150.
		expect(range().to).toBeCloseTo(150, 6);
	});

	it('gives the values of the scale on a logarithmic and on a percentage scale, and its margins go around', async () => {
		t.chart.applyOptions({ priceScale: { mode: 'logarithmic', scaleMargins: { top: 0.2, bottom: 0.1 } } });
		const drawing = t.chart.drawings().add(line(400));
		await t.settle();
		expect(range().to).toBeCloseTo(400, 6);
		// The top margin is above the line: a fifth of the pane.
		const height = t.chart.priceScale().priceToCoordinate(range().from)! / 0.9;
		expect(t.chart.priceScale().priceToCoordinate(400)!).toBeCloseTo(0.2 * height, 6);
		// What a logarithmic scale cannot show does not count.
		drawing.setPoints([{ time: 950 * MINUTE, price: -5 }]);
		await t.settle();
		expect(range().to).toBeLessThan(120);
		expect(range().from).toBeGreaterThan(80);
		t.chart.applyOptions({ priceScale: { mode: 'percentage' } });
		drawing.setPoints([{ time: 950 * MINUTE, price: 300 }]);
		await t.settle();
		// In percent of the first visible close, as the series' range is.
		const top = t.chart.priceScale().coordinateToPrice(t.chart.priceScale().priceToCoordinate(300)!)!;
		expect(top).toBeCloseTo(300, 6);
		expect(range().to).toBeGreaterThan(150);
		expect(t.chart.priceScale().priceToCoordinate(300)!).toBeCloseTo(0.2 * height, 6);
	});

	it('leaves a scale that does not autoscale, and one without a visible series, alone', async () => {
		t.chart.priceScale().setVisibleRange({ from: 90, to: 110 });
		t.chart.drawings().add(line(150));
		t.chart.drawings().add({ ...line(5), priceScaleId: 'empty' });
		await t.settle();
		expect(range()).toEqual({ from: 90, to: 110 });
		expect(t.chart.priceScale('empty').getVisibleRange()).toBeNull();
		t.chart.priceScale().applyOptions({ autoScale: true });
		await t.settle();
		expect(range().to).toBe(150);
	});

	it('keeps the scale where it is while an opted-in drawing is dragged, and fits it on release', async () => {
		const drawings = t.chart.drawings();
		const drawing = drawings.add(line(130));
		await t.settle();
		const before = range();
		expect(before.to).toBe(130);
		const y = t.chart.priceScale().priceToCoordinate(130)!;
		t.pointer('pointerdown', 300, y);
		t.runFrames();
		t.pointer('pointermove', 300, y + 100);
		t.runFrames();
		t.pointer('pointermove', 300, y + 120);
		t.runFrames();
		expect(range()).toEqual(before);
		t.pointer('pointerup', 300, y + 120);
		await t.settle();
		expect(drawing.points()[0]!.price).toBeLessThan(120);
		expect(range().to).toBeLessThan(120);
	});

	it('asks a primitive with autoscale once per frame that computes ranges, and no other', async () => {
		const series = range();
		const band = new Band(940, 960, 50, 160);
		const plain: PanePrimitive = { draw() {} };
		t.chart.attachPrimitive(plain);
		t.chart.attachPrimitive(band);
		await t.settle();
		expect(range()).toEqual({ from: 50, to: 160 });
		const asked = band.asked;
		// A pointer move draws the overlay alone.
		t.pointer('pointermove', 200, 200);
		t.runFrames();
		expect(band.asked).toBe(asked);
		t.chart.timeScale().setVisibleLogicalRange({ from: 800, to: 899 });
		await t.settle();
		expect(band.asked).toBe(asked + 1);
		expect(band.seen.at(-1)).toEqual([800, 899]);
		expect(range().to).toBeLessThan(120);
		// Its answer changed for another reason than the view: it says so.
		band.from = 850;
		band.high = 170;
		band.host!.requestUpdate();
		await t.settle();
		expect(range()).toEqual({ from: 50, to: 170 });
		t.chart.detachPrimitive(band);
		await t.settle();
		expect(range().from).toBeGreaterThan(80);
		expect(series.from).toBeGreaterThan(80);
	});

	it('keeps the answer of a primitive that gives its span, until the primitive says it changed', async () => {
		const band = new Band(940, 960, 50, 160);
		const ask = band.autoscale.bind(band);
		band.autoscale = (given, view) => {
			ask(given, view);
			given.low = band.low;
			given.high = band.high;
			given.spanFrom = view.timeToLogical(band.from * MINUTE);
			given.spanTo = view.timeToLogical(band.to * MINUTE);
			return true;
		};
		t.chart.attachPrimitive(band);
		await t.settle();
		expect(range()).toEqual({ from: 50, to: 160 });
		expect(band.asked).toBe(1);
		t.chart.timeScale().setVisibleLogicalRange({ from: 800, to: 899 });
		await t.settle();
		expect(range().to).toBeLessThan(120);
		t.chart.timeScale().setVisibleLogicalRange({ from: 880, to: 950 });
		await t.settle();
		expect(range().to).toBe(160);
		expect(band.asked).toBe(1);
		band.high = 180;
		band.host!.requestUpdate();
		await t.settle();
		expect(range().to).toBe(180);
		expect(band.asked).toBe(2);
		// Another scale mode: asked again, in case the answer depends on it.
		t.chart.applyOptions({ priceScale: { mode: 'logarithmic' } });
		await t.settle();
		expect(band.asked).toBe(3);
		expect(range().to).toBeCloseTo(180, 6);
	});

	it('joins a series primitive with the scale of its series', async () => {
		const other = t.chart.addSeries('line', { priceScaleId: 'other' });
		other.setData({ time: candles(1000).time, value: candles(1000).close });
		const band = new Band(940, 960, -40, 500);
		other.attachPrimitive(band);
		await t.settle();
		expect(range('other')).toEqual({ from: -40, to: 500 });
		expect(range().to).toBeLessThan(120);
	});

	it('saves the option, and reads a state without it as off', async () => {
		const drawings = t.chart.drawings();
		const on = drawings.add(line(150));
		expect(on.toJSON().options.autoscale).toBe(true);
		const state = JSON.parse(JSON.stringify(on.toJSON())) as Record<string, Record<string, unknown>>;
		delete state.options!.autoscale;
		on.remove();
		t.chart.restoreState({ version: 1, drawings: [state as never] });
		expect(drawings.list()[0]!.options().autoscale).toBe(false);
		expect(() =>
			t.chart.restoreState({ version: 1, drawings: [{ ...state, options: { autoscale: 1 } } as never] }),
		).toThrow(/drawings\[0\]\.options\.autoscale must be a boolean/);
	});
});
