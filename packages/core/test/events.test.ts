import type { ChartPointerEvent, LogicalRange, SeriesApi, TimeRange } from '@lumen-ticks/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChartEvents } from '../src/input/chart-events';
import { MINUTE, TestChart, candles } from './drawing-helpers';

/** Bar `i` of `candles(count)`. */
function bar(i: number) {
	const data = candles(i + 1);
	return { open: data.open[i]!, high: data.high[i]!, low: data.low[i]!, close: data.close[i]! };
}

describe('chart events', () => {
	let t: TestChart;
	let moves: ChartPointerEvent[];

	beforeEach(() => {
		t = new TestChart();
		moves = [];
	});

	afterEach(() => {
		t.destroy();
	});

	/** A chart with 500 candles named `btc`, settled. */
	async function withCandles(): Promise<SeriesApi<'candlestick'>> {
		const series = t.chart.addSeries('candlestick', { id: 'btc' });
		series.setData(candles(500));
		t.chart.timeScale().setVisibleLogicalRange({ from: 99.5, to: 199.5 });
		await t.settle();
		return series;
	}

	/** The pane x of bar `index`, as the chart draws it. */
	function xOf(index: number): number {
		return t.chart.timeScale().logicalToCoordinate(index)!;
	}

	describe('crosshairMove', () => {
		it('reports many pointer moves in one frame once, after the frame, with the values there', async () => {
			await withCandles();
			t.chart.subscribe('crosshairMove', event => moves.push(event));
			for (let i = 0; i < 10; i++) {
				t.pointer('pointermove', 100 + i, 150);
			}
			expect(moves).toHaveLength(0);
			t.runFrames();
			expect(moves).toHaveLength(1);
			const event = moves[0]!;
			const index = Math.round(t.chart.timeScale().coordinateToLogical(109)!);
			expect(event).toMatchObject({ source: 'pointer', point: { x: 109, y: 150 }, logical: index });
			expect(event.time).toBe(index * MINUTE);
			expect([...event.values.keys()]).toEqual(['btc']);
			expect(event.values.get('btc')).toEqual(bar(index));
		});

		it('reports nothing for a frame in which the crosshair stayed', async () => {
			await withCandles();
			t.pointer('pointermove', 100, 150);
			t.runFrames();
			t.chart.subscribe('crosshairMove', event => moves.push(event));
			t.pointer('pointermove', 100, 150);
			t.runFrames();
			t.chart.applyOptions({ layout: { background: '#101010' } });
			t.runFrames();
			expect(moves).toHaveLength(0);
		});

		it('reports the crosshair leaving with no point, and a move beyond the bars without values', async () => {
			await withCandles();
			t.chart.subscribe('crosshairMove', event => moves.push(event));
			t.pointer('pointermove', 100, 150);
			t.runFrames();
			t.pointer('pointerleave', 100, 150);
			t.runFrames();
			expect(moves[1]).toMatchObject({ source: 'pointer', point: null, logical: null, time: null });
			expect(moves[1]!.values.size).toBe(0);

			t.chart.timeScale().setVisibleLogicalRange({ from: 450, to: 550 });
			await t.settle();
			const beyond = xOf(520);
			t.pointer('pointermove', beyond, 150);
			t.runFrames();
			expect(moves.at(-1)).toMatchObject({ logical: 520, time: null });
			expect(moves.at(-1)!.values.size).toBe(0);
		});

		it('holds the value of every series and indicator output at the bar', async () => {
			await withCandles();
			const data = candles(500);
			const line = t.chart.addSeries('line', { id: 'close' });
			line.setData({ time: data.time, value: data.close });
			const sma = t.chart.addIndicator(t.chart.series()[0]!, 'sma', { id: 'avg', params: { period: 1 } });
			await t.chart.whenApplied();
			await t.settle();
			t.chart.subscribe('crosshairMove', event => moves.push(event));
			t.pointer('pointermove', xOf(150), 100);
			t.runFrames();
			const values = moves[0]!.values;
			expect(values.get('btc')).toEqual(bar(150));
			expect(values.get('close')).toEqual({ value: bar(150).close });
			expect(values.get(`${sma.id}.${sma.output().name}`)).toEqual({ value: bar(150).close });
		});

		it('builds nothing while nobody listens', async () => {
			await withCandles();
			const build = vi.spyOn(ChartEvents.prototype as unknown as { _event: () => unknown }, '_event');
			t.pointer('pointermove', 100, 150);
			t.runFrames();
			t.click(120, 150);
			t.pointer('pointerleave', 100, 150);
			t.runFrames();
			expect(build).not.toHaveBeenCalled();

			const unsubscribe = t.chart.subscribe('crosshairMove', event => moves.push(event));
			t.pointer('pointermove', 110, 150);
			t.runFrames();
			expect(build).toHaveBeenCalledTimes(1);
			unsubscribe();
			t.pointer('pointermove', 130, 150);
			t.runFrames();
			expect(build).toHaveBeenCalledTimes(1);
			expect(moves).toHaveLength(1);
		});

		it('reports the keyboard navigator as its source', async () => {
			await withCandles();
			t.chart.subscribe('crosshairMove', event => moves.push(event));
			const slider = t.chart.element().querySelector('input[type="range"]') as HTMLInputElement;
			slider.dispatchEvent(new FocusEvent('focus'));
			slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
			t.runFrames();
			expect(moves.at(-1)).toMatchObject({ source: 'keyboard' });
			expect(moves.at(-1)!.values.get('btc')).toEqual(bar(moves.at(-1)!.logical!));
		});
	});

	describe('setCrosshairPosition', () => {
		it('puts the crosshair on the bar at or before a time and a price, and reports it as api', async () => {
			await withCandles();
			t.chart.subscribe('crosshairMove', event => moves.push(event));
			t.chart.setCrosshairPosition(150.6 * MINUTE, 101);
			t.runFrames();
			expect(moves).toHaveLength(1);
			const event = moves[0]!;
			expect(event).toMatchObject({ source: 'api', logical: 150, time: 150 * MINUTE });
			expect(event.point!.x).toBeCloseTo(xOf(150), 6);
			expect(event.point!.y).toBeCloseTo(t.chart.priceScale().priceToCoordinate(101)!, 6);
			expect(event.values.get('btc')).toEqual(bar(150));

			// It stays on its bar as the view moves.
			t.chart.timeScale().setVisibleLogicalRange({ from: 120, to: 220 });
			await t.settle();
			expect(moves.at(-1)).toMatchObject({ source: 'api', logical: 150 });
			expect(moves.at(-1)!.point!.x).toBeCloseTo(xOf(150), 6);

			// Without a price there is no horizontal line; a later time takes the last bar, here out of
			// view, where the chart holds no rows to read its time and values from.
			t.chart.setCrosshairPosition(10_000 * MINUTE, null);
			t.runFrames();
			expect(moves.at(-1)).toMatchObject({ source: 'api', logical: 499, time: null });
			expect(moves.at(-1)!.point!.x).toBeCloseTo(xOf(499), 6);
			expect(moves.at(-1)!.point!.y).toBeNaN();

			// A time before the first bar hides it.
			t.chart.setCrosshairPosition(-5 * MINUTE, 101);
			t.runFrames();
			expect(moves.at(-1)).toMatchObject({ source: 'api', point: null });
		});

		it('gives way to the pointer, and clears', async () => {
			await withCandles();
			t.chart.subscribe('crosshairMove', event => moves.push(event));
			t.chart.setCrosshairPosition(150 * MINUTE, 101);
			t.runFrames();
			t.pointer('pointermove', 200, 120);
			t.runFrames();
			expect(moves.at(-1)).toMatchObject({ source: 'pointer', point: { x: 200, y: 120 } });
			// The view moves; the crosshair stays where the pointer is.
			t.chart.timeScale().setVisibleLogicalRange({ from: 140, to: 240 });
			await t.settle();
			expect(moves.at(-1)!.point).toEqual({ x: 200, y: 120 });

			t.chart.setCrosshairPosition(150 * MINUTE, 101);
			t.runFrames();
			t.chart.clearCrosshairPosition();
			t.runFrames();
			expect(moves.at(-1)).toMatchObject({ source: 'api', point: null, logical: null });
		});

		it('waits for bars set before the data arrives', async () => {
			t.chart.subscribe('crosshairMove', event => moves.push(event));
			t.chart.setCrosshairPosition(150 * MINUTE, null);
			t.runFrames();
			expect(moves).toHaveLength(0);
			await withCandles();
			expect(moves.at(-1)).toMatchObject({ source: 'api', logical: 150, time: 150 * MINUTE });
		});
	});

	describe('click', () => {
		let clicks: ChartPointerEvent[];
		beforeEach(() => {
			clicks = [];
		});

		it('reports a press and release that did not move, and not a drag', async () => {
			await withCandles();
			t.chart.subscribe('click', event => clicks.push(event));
			t.click(xOf(150), 100);
			expect(clicks).toHaveLength(1);
			expect(clicks[0]).toMatchObject({ source: 'pointer', logical: 150, time: 150 * MINUTE });
			expect(clicks[0]!.point!.x).toBeCloseTo(xOf(150), 6);
			expect(clicks[0]!.values.get('btc')).toEqual(bar(150));

			// A little jitter is still a click.
			t.pointer('pointerdown', 100, 100);
			t.pointer('pointermove', 102, 101);
			t.pointer('pointerup', 102, 101);
			t.runFrames();
			expect(clicks).toHaveLength(2);

			// A drag pans.
			const range = t.chart.timeScale().getVisibleLogicalRange()!;
			t.pointer('pointerdown', 100, 100);
			t.pointer('pointermove', 140, 100);
			t.pointer('pointerup', 140, 100);
			t.runFrames();
			expect(clicks).toHaveLength(2);
			expect(t.chart.timeScale().getVisibleLogicalRange()!.from).toBeLessThan(range.from);

			// Neither a second button, nor a press on the price axis, nor below the pane.
			t.click(100, 100, { button: 2 });
			t.click(630, 100);
			t.click(100, 395);
			expect(clicks).toHaveLength(2);
		});

		it('leaves presses a drawing takes to the drawing', async () => {
			await withCandles();
			t.chart.subscribe('click', event => clicks.push(event));
			const drawings = t.chart.drawings();
			drawings.startTool('horizontalLine');
			t.click(100, 120);
			expect(drawings.list()).toHaveLength(1);
			expect(clicks).toHaveLength(0);

			// The line is selected by a click on it, which is not reported either.
			drawings.select(null);
			t.click(200, 120);
			expect(drawings.selected()).not.toBeNull();
			expect(clicks).toHaveLength(0);

			// Away from it, with drawings on the chart, a click is reported.
			t.click(200, 300);
			expect(clicks).toHaveLength(1);
		});
	});

	describe('visible ranges', () => {
		let logical: (LogicalRange | null)[];
		let times: (TimeRange | null)[];

		beforeEach(() => {
			logical = [];
			times = [];
		});

		function listen(): void {
			t.chart.timeScale().subscribe('visibleLogicalRangeChange', range => logical.push(range));
			t.chart.timeScale().subscribe('visibleTimeRangeChange', range => times.push(range));
		}

		it('reports a change once per frame, for calls, pans, zooms and fitContent', async () => {
			await withCandles();
			listen();
			t.chart.timeScale().setVisibleLogicalRange({ from: 199.5, to: 299.5 });
			t.chart.timeScale().setVisibleLogicalRange({ from: 149.5, to: 249.5 });
			await t.settle();
			expect(logical).toHaveLength(1);
			expect(logical[0]!.from).toBeCloseTo(149.5, 6);
			expect(logical[0]!.to).toBeCloseTo(249.5, 6);
			expect(times).toHaveLength(1);
			expect(times[0]!.from).toBeCloseTo(149.5 * MINUTE, 0);
			expect(times[0]!.to).toBeCloseTo(249.5 * MINUTE, 0);

			t.pointer('pointerdown', 300, 100);
			t.pointer('pointermove', 320, 100);
			t.pointer('pointermove', 340, 100);
			t.runFrames();
			t.pointer('pointerup', 340, 100);
			t.runFrames();
			expect(logical).toHaveLength(2);
			expect(logical[1]!.from).toBeLessThan(149.5);

			const wheel = new WheelEvent('wheel', { deltaY: 200, bubbles: true, cancelable: true });
			Object.defineProperty(wheel, 'clientX', { value: 300 });
			t.chart.element().dispatchEvent(wheel);
			await t.settle();
			expect(logical).toHaveLength(3);

			t.chart.timeScale().fitContent();
			await t.settle();
			expect(logical).toHaveLength(4);
			expect(logical[3]!.from).toBeCloseTo(-0.5, 6);
			expect(logical[3]!.to).toBeCloseTo(499.5, 6);
			expect(times).toHaveLength(4);
		});

		it('reports nothing for frames that do not move the view', async () => {
			await withCandles();
			listen();
			t.pointer('pointermove', 100, 100);
			t.runFrames();
			t.chart.applyOptions({ layout: { background: '#101010' } });
			t.runFrames();
			t.chart.timeScale().setVisibleLogicalRange({ from: 99.5, to: 199.5 });
			await t.settle();
			expect(logical).toEqual([]);
			expect(times).toEqual([]);
		});

		it('reports the first bars, and nothing while there are none', async () => {
			listen();
			t.runFrames();
			expect(logical).toEqual([]);
			await withCandles();
			expect(logical).toHaveLength(1);
			expect(times).toHaveLength(1);
		});
	});

	it('lets two charts sync their crosshairs and time ranges without echoing forever', async () => {
		await withCandles();
		const other = new TestChart();
		try {
			const series = other.chart.addSeries('candlestick', { id: 'eth' });
			series.setData(candles(400, 100));
			await other.settle();
			const charts = [t.chart, other.chart];
			let ranges = 0;
			const crosshairs: ChartPointerEvent[] = [];
			other.chart.subscribe('crosshairMove', event => crosshairs.push(event));
			for (const chart of charts) {
				const peer = chart === t.chart ? other.chart : t.chart;
				chart.subscribe('crosshairMove', event => {
					if (event.source === 'api') return;
					if (event.time === null) peer.clearCrosshairPosition();
					else peer.setCrosshairPosition(event.time, null);
				});
				chart.timeScale().subscribe('visibleTimeRangeChange', range => {
					ranges++;
					if (range !== null) peer.timeScale().setVisibleRange(range);
				});
			}
			t.chart.timeScale().setVisibleLogicalRange({ from: 199.5, to: 299.5 });
			// Both charts draw in the frames of the one created last.
			for (let i = 0; i < 20; i++) {
				other.runFrames();
				// oxlint-disable-next-line no-await-in-loop
				await new Promise(resolve => setTimeout(resolve, 0));
			}
			expect(ranges).toBeLessThan(6);
			const range = other.chart.timeScale().getVisibleRange()!;
			expect(range.from).toBeCloseTo(199.5 * MINUTE, 0);
			expect(range.to).toBeCloseTo(299.5 * MINUTE, 0);
			expect(other.frames).toHaveLength(0);

			t.pointer('pointermove', xOf(250), 100);
			other.runFrames();
			other.runFrames();
			// Bar 250 of the first chart is bar 150 of the other, which starts 100 minutes later.
			expect(crosshairs.at(-1)).toMatchObject({ source: 'api', logical: 150, time: 250 * MINUTE });
		} finally {
			other.chart.destroy();
			other.container.remove();
		}
	});

	describe('time scale', () => {
		it('converts both ways between times, logical positions and coordinates', async () => {
			await withCandles();
			const timeScale = t.chart.timeScale();
			const x = timeScale.logicalToCoordinate(150)!;
			expect(x).toBeGreaterThan(0);
			expect(timeScale.coordinateToLogical(x)).toBeCloseTo(150, 6);
			expect(timeScale.timeToCoordinate(150 * MINUTE)).toBeCloseTo(x, 6);
			expect(timeScale.coordinateToTime(x)).toBeCloseTo(150 * MINUTE, 0);
			// Between two bars, a time takes the fraction of the way between them.
			expect(timeScale.timeToCoordinate(150.5 * MINUTE)).toBeCloseTo(timeScale.logicalToCoordinate(150.5)!, 6);
		});

		it('shows a range of times, and reads it back', async () => {
			await withCandles();
			const timeScale = t.chart.timeScale();
			timeScale.setVisibleRange({ from: 200 * MINUTE, to: 300 * MINUTE });
			await t.settle();
			const range = timeScale.getVisibleRange()!;
			expect(range.from).toBeCloseTo(200 * MINUTE, 0);
			expect(range.to).toBeCloseTo(300 * MINUTE, 0);
			expect(timeScale.getVisibleLogicalRange()!.from).toBeCloseTo(200, 6);
			expect(timeScale.getVisibleLogicalRange()!.to).toBeCloseTo(300, 6);
		});

		it('answers null before data, and a time range set before data shows once it arrives', async () => {
			const timeScale = t.chart.timeScale();
			t.runFrames();
			expect(timeScale.logicalToCoordinate(1)).toBeNull();
			expect(timeScale.coordinateToLogical(10)).toBeNull();
			expect(timeScale.timeToCoordinate(MINUTE)).toBeNull();
			expect(timeScale.coordinateToTime(10)).toBeNull();
			expect(timeScale.getVisibleRange()).toBeNull();
			timeScale.setVisibleRange({ from: 300 * MINUTE, to: 400 * MINUTE });
			const series = t.chart.addSeries('candlestick');
			series.setData(candles(500));
			await t.settle();
			expect(timeScale.getVisibleLogicalRange()!.from).toBeCloseTo(300, 6);
		});

		it('throws for an event the chart or the time scale does not have', () => {
			expect(() => t.chart.timeScale().subscribe('crosshairMove' as 'visibleLogicalRangeChange', () => {})).toThrow(
				/time scale has no event/,
			);
			expect(() => t.chart.subscribe('visibleLogicalRangeChange' as 'click', () => {})).toThrow(/no event/);
		});
	});
});
