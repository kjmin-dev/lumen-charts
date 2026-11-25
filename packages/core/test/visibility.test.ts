import { type ChartApi, createChart } from '@lumen-ticks/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Stands in for `IntersectionObserver`: lets a test say which elements are in the viewport. */
class FakeIntersectionObserver {
	public static instances: FakeIntersectionObserver[] = [];
	public readonly targets = new Set<Element>();
	public disconnected = false;
	private readonly _callback: IntersectionObserverCallback;

	public constructor(callback: IntersectionObserverCallback) {
		this._callback = callback;
		FakeIntersectionObserver.instances.push(this);
	}

	public observe(target: Element): void {
		this.targets.add(target);
	}

	public unobserve(target: Element): void {
		this.targets.delete(target);
	}

	public disconnect(): void {
		this.targets.clear();
		this.disconnected = true;
	}

	public report(target: Element, isIntersecting: boolean): void {
		const entries = [{ target, isIntersecting }] as unknown as IntersectionObserverEntry[];
		this._callback(entries, this as unknown as IntersectionObserver);
	}
}

const MINUTE = 60_000;

function points(count: number) {
	const time = new Float64Array(count);
	const value = new Float64Array(count);
	for (let i = 0; i < count; i++) {
		time[i] = i * MINUTE;
		value[i] = 100 + Math.sin(i / 20) * 5;
	}
	return { time, value };
}

const observer = () => FakeIntersectionObserver.instances[0]!;

describe('chart outside the viewport', () => {
	let container: HTMLDivElement;
	let frames: ((now: number) => void)[];
	let chart: ChartApi;
	let draws: number;
	let now = 0;

	const runFrames = (): void => {
		for (const frame of frames.splice(0)) {
			now += 16;
			frame(now);
		}
	};
	/** Runs frames and engine tasks until the chart is idle. */
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

	beforeEach(() => {
		container = document.body.appendChild(document.createElement('div'));
		frames = [];
		draws = 0;
		FakeIntersectionObserver.instances = [];
		vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
		vi.stubGlobal('requestAnimationFrame', (callback: (now: number) => void) => frames.push(callback));
		vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
			frames[handle - 1] = () => {};
		});
		chart = createChart(container, { autoSize: false, width: 640, height: 400, worker: false });
		const internals = chart as unknown as { frameWrite(now: number): void };
		const write = internals.frameWrite.bind(chart);
		internals.frameWrite = (time: number) => {
			draws++;
			write(time);
		};
	});

	afterEach(() => {
		chart.destroy();
		container.remove();
		vi.unstubAllGlobals();
	});

	it('keeps data current without drawing, and draws once when it comes back', async () => {
		const series = chart.addSeries('line');
		const data = points(1000);
		series.setData(data);
		await settle();
		expect(draws).toBeGreaterThan(0);

		observer().report(chart.element(), false);
		draws = 0;
		for (let i = 0; i < 50; i++) {
			series.update({ time: (1000 + i) * MINUTE, value: 120 + i });
		}
		// Idle means the data is applied; the chart does not wait to be seen.
		await settle();
		expect(draws).toBe(0);
		expect(frames.length).toBe(0);
		// The view followed the new bars, and the last value is the latest one.
		expect(chart.timeScale().getVisibleLogicalRange()!.to).toBe(1049.5);
		expect((series as unknown as { lastValue: number }).lastValue).toBe(169);

		observer().report(chart.element(), true);
		expect(frames.length).toBe(1);
		await settle();
		expect(draws).toBe(1);
		// Nothing changed since: coming back again draws nothing.
		observer().report(chart.element(), false);
		observer().report(chart.element(), true);
		expect(frames.length).toBe(0);
	});

	it('drops a frame it had asked for, resolves waiters, and keeps the invalidation level', async () => {
		chart.addSeries('line').setData(points(500));
		await settle();
		draws = 0;
		chart.applyOptions({ width: 500 });
		const idle = vi.fn<() => void>();
		void chart.whenIdle().then(idle);
		await Promise.resolve();
		expect(idle).not.toHaveBeenCalled();

		observer().report(chart.element(), false);
		await Promise.resolve();
		expect(idle).toHaveBeenCalled();
		runFrames();
		expect(draws).toBe(0);
		const overlay = chart.element().querySelectorAll('canvas')[3]!;
		expect(overlay.style.width).toBe('640px');

		// The full invalidation was kept: the canvases are resized by the draw on return.
		observer().report(chart.element(), true);
		runFrames();
		expect(draws).toBe(1);
		expect(overlay.style.width).toBe('500px');
	});

	it('shares one observer between charts and disconnects it with the last one', () => {
		const other = document.body.appendChild(document.createElement('div'));
		const second = createChart(other, { autoSize: false, width: 300, height: 200 });
		expect(FakeIntersectionObserver.instances.length).toBe(1);
		expect(observer().targets.size).toBe(2);
		second.destroy();
		expect(observer().targets.size).toBe(1);
		expect(observer().disconnected).toBe(false);
		chart.destroy();
		expect(observer().disconnected).toBe(true);
		other.remove();
	});

	it('draws as before where there is no IntersectionObserver', async () => {
		chart.destroy();
		vi.stubGlobal('IntersectionObserver', undefined);
		chart = createChart(container, { autoSize: false, width: 640, height: 400, worker: false });
		chart.addSeries('line').setData(points(100));
		await settle();
		expect(chart.timeScale().getVisibleLogicalRange()).not.toBeNull();
		expect(chart.element().querySelectorAll('canvas')[3]!.style.width).toBe('640px');
	});
});
