import { type ChartApi, createChart } from '@lumen-ticks/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimeScale } from '../src/model/time-scale';

const MINUTE = 60_000;

describe('pointer input and layout reads', () => {
	let container: HTMLDivElement;
	let frames: ((now: number) => void)[];
	let chart: ChartApi;
	let now = 0;
	/** Where the layout puts the chart in the viewport. */
	let left = 0;
	let top = 0;
	let rectReads = 0;

	const scale = (): TimeScale => (chart as unknown as { scale: TimeScale }).scale;
	const crosshair = () => {
		const state = (chart as unknown as { _crosshair: { x: number; y: number; visible: boolean } })._crosshair;
		return { _crosshairX: state.x, _crosshairY: state.y, _crosshairVisible: state.visible };
	};
	const layout = () => (chart as unknown as { _layout: { paneWidth: number } })._layout;
	const runFrames = (): void => {
		for (const frame of frames.splice(0)) {
			now += 16;
			frame(now);
		}
	};
	const settle = async (): Promise<void> => {
		const state = { done: false };
		void chart.whenIdle().then(() => {
			state.done = true;
		});
		const step = async (remaining: number): Promise<void> => {
			if (state.done || remaining === 0) {
				return;
			}
			runFrames();
			await new Promise(resolve => setTimeout(resolve, 0));
			await step(remaining - 1);
		};
		await step(500);
		expect(state.done).toBe(true);
	};
	const pointer = (type: string, x: number, y: number, init: PointerEventInit = {}): void => {
		chart
			.element()
			.dispatchEvent(
				new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', bubbles: true, ...init }),
			);
	};
	const wheel = (x: number, deltaY: number, deltaX = 0): void => {
		const event = new WheelEvent('wheel', { deltaX, deltaY, bubbles: true, cancelable: true });
		// The DOM used for tests does not take pointer coordinates from the event init.
		Object.defineProperty(event, 'clientX', { value: x });
		chart.element().dispatchEvent(event);
	};

	const touch = (type: string, id: number, x: number, timeStamp: number): void => {
		const event = new PointerEvent(type, { clientX: x, clientY: 100, pointerId: id, pointerType: 'touch' });
		Object.defineProperty(event, 'timeStamp', { value: timeStamp });
		chart.element().dispatchEvent(event);
	};

	beforeEach(async () => {
		container = document.body.appendChild(document.createElement('div'));
		frames = [];
		left = 0;
		top = 0;
		vi.stubGlobal('requestAnimationFrame', (callback: (now: number) => void) => frames.push(callback));
		vi.stubGlobal('cancelAnimationFrame', () => {});
		chart = createChart(container, { autoSize: false, width: 640, height: 400, worker: false });
		const time = Float64Array.from({ length: 5000 }, (_, i) => i * MINUTE);
		chart.addSeries('line').setData({ time, value: time.map((_, i) => 100 + (i % 11)) });
		await settle();
		vi.spyOn(chart.element(), 'getBoundingClientRect').mockImplementation(() => {
			rectReads++;
			return { left, top, width: 640, height: 400 } as DOMRect;
		});
		rectReads = 0;
	});

	afterEach(() => {
		chart.destroy();
		container.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('reads the chart rectangle once per frame, not once per event', () => {
		for (let i = 0; i < 20; i++) {
			pointer('pointermove', 100 + i, 150);
			wheel(100 + i, 10);
		}
		expect(rectReads).toBe(0);
		runFrames();
		expect(rectReads).toBe(1);
		// A frame without pointer input reads nothing.
		chart.applyOptions({ layout: { background: '#101010' } });
		runFrames();
		expect(rectReads).toBe(1);
	});

	it('scales a price axis under the wheel in the frame, around the pointer in the chart', () => {
		const axis = chart.element().querySelectorAll('canvas')[1]!;
		const spacing = scale().barSpacing;
		top = -40;
		const before = chart.priceScale().getVisibleRange()!;
		const price = chart.priceScale().coordinateToPrice(150)!;
		for (let i = 0; i < 5; i++) {
			const event = new WheelEvent('wheel', { deltaY: -20, bubbles: true, cancelable: true });
			Object.defineProperty(event, 'clientY', { value: 110 });
			axis.dispatchEvent(event);
		}
		expect(rectReads).toBe(0);
		expect(chart.priceScale().getVisibleRange()).toEqual(before);
		runFrames();
		expect(rectReads).toBe(1);
		const after = chart.priceScale().getVisibleRange()!;
		expect(after.to - after.from).toBeCloseTo((before.to - before.from) * Math.exp(-100 * 0.002), 9);
		// 110 in the viewport is 150 in the chart, which the page scrolled up by 40.
		expect(chart.priceScale().priceToCoordinate(price)).toBeCloseTo(150, 6);
		expect(scale().barSpacing).toBe(spacing);
	});

	it('uses the rectangle of the frame, so a page scrolled since the last frame is followed', () => {
		pointer('pointermove', 300, 150);
		runFrames();
		expect(crosshair()._crosshairX).toBe(300);
		expect(crosshair()._crosshairY).toBe(150);

		// The page scrolls: the chart is now elsewhere in the viewport, without any resize.
		left = 120;
		top = -40;
		pointer('pointermove', 300, 150);
		runFrames();
		expect(crosshair()._crosshairX).toBe(180);
		expect(crosshair()._crosshairY).toBe(190);
		expect(crosshair()._crosshairVisible).toBe(true);

		// Leaving wins over a hover that was still waiting for its frame.
		pointer('pointermove', 310, 150);
		pointer('pointerleave', 900, 150);
		runFrames();
		expect(crosshair()._crosshairVisible).toBe(false);
	});

	it('keeps the bar under the pointer in place when the wheel zooms', () => {
		left = 50;
		const anchor = 250;
		const before = scale().xToLogical(anchor);
		const spacing = scale().barSpacing;
		wheel(left + anchor, 120);
		wheel(left + anchor, 120);
		wheel(left + anchor, -60);
		runFrames();
		expect(scale().barSpacing).toBeCloseTo(spacing * Math.exp(-180 * 0.002), 9);
		expect(scale().xToLogical(anchor)).toBeCloseTo(before, 6);

		// Past the right edge of the pane, the anchor is the edge.
		const paneWidth = layout().paneWidth;
		const edge = scale().xToLogical(paneWidth);
		wheel(left + paneWidth + 30, -100);
		runFrames();
		expect(scale().xToLogical(paneWidth)).toBeCloseTo(edge, 6);
	});

	it('applies pans and zooms of one frame in the order they happened', () => {
		const reference = Object.assign(Object.create(Object.getPrototypeOf(scale())), scale()) as TimeScale;
		reference.zoomAt(200, Math.exp(-150 * 0.002));
		reference.scrollBy(-40);
		reference.zoomAt(320, Math.exp(90 * 0.002));
		reference.scrollBy(25);

		wheel(200, 150);
		wheel(0, 0, 40);
		wheel(320, -90);
		pointer('pointerdown', 100, 100);
		pointer('pointermove', 125, 100);
		pointer('pointerup', 125, 100);
		runFrames();
		expect(scale().barSpacing).toBeCloseTo(reference.barSpacing, 9);
		expect(scale().rightOffset).toBeCloseTo(reference.rightOffset, 9);
	});

	it('applies waiting input before a call reads or sets the view', () => {
		const range = chart.timeScale().getVisibleLogicalRange()!;
		wheel(200, 150);
		const zoomed = chart.timeScale().getVisibleLogicalRange()!;
		expect(zoomed.to - zoomed.from).toBeGreaterThan(range.to - range.from);
		expect(rectReads).toBe(1);

		// A wheel event followed by a call: the call has the last word.
		wheel(200, 150);
		chart.timeScale().setVisibleLogicalRange({ from: 1000, to: 1200 });
		runFrames();
		const set = chart.timeScale().getVisibleLogicalRange()!;
		expect(set.from).toBeCloseTo(1000, 6);
		expect(set.to).toBeCloseTo(1200, 6);
	});

	it('pinches around the middle of two touches and keeps scrolling after a flick', () => {
		left = 30;
		// Each finger moves in an event of its own, so the pinch is two zooms around two middles.
		const reference = Object.assign(Object.create(Object.getPrototypeOf(scale())), scale()) as TimeScale;
		reference.zoomAt(275, 1.5);
		reference.zoomAt(300, 200 / 150);
		touch('pointerdown', 1, left + 250, 0);
		touch('pointerdown', 2, left + 350, 0);
		touch('pointermove', 1, left + 200, 10);
		touch('pointermove', 2, left + 400, 10);
		expect(rectReads).toBe(0);
		runFrames();
		expect(rectReads).toBe(1);
		expect(scale().barSpacing).toBeCloseTo(reference.barSpacing, 9);
		expect(scale().rightOffset).toBeCloseTo(reference.rightOffset, 9);
		touch('pointerup', 1, left + 200, 20);
		touch('pointerup', 2, left + 400, 20);
		runFrames();

		// A flick: the chart keeps moving, frame after frame, without any further event.
		touch('pointerdown', 1, 300, 1000);
		touch('pointermove', 1, 340, 1060);
		touch('pointermove', 1, 400, 1120);
		touch('pointerup', 1, 400, 1125);
		now = 1125;
		const released = scale().rightOffset;
		runFrames();
		const afterOne = scale().rightOffset;
		expect(afterOne).toBeLessThan(released);
		expect(frames.length).toBe(1);
		runFrames();
		expect(scale().rightOffset).toBeLessThan(afterOne);
		expect(frames.length).toBe(1);
	});
});
