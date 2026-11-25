import { type ChartApi, createChart } from '@lumen-ticks/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Stands in for `ResizeObserver`: records what is observed and lets a test report sizes. */
class FakeResizeObserver {
	public static instances: FakeResizeObserver[] = [];
	public readonly targets = new Set<Element>();
	public disconnected = false;
	private readonly _callback: ResizeObserverCallback;

	public constructor(callback: ResizeObserverCallback) {
		this._callback = callback;
		FakeResizeObserver.instances.push(this);
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

	/** Reports content boxes, all in one callback as a browser does. */
	public report(sizes: [Element, number, number][]): void {
		const entries = sizes.map(([target, width, height]) => ({
			target,
			contentRect: { width, height },
			contentBoxSize: [{ inlineSize: width, blockSize: height }],
		}));
		this._callback(entries as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver);
	}
}

/** CSS size of the overlay canvas, which covers the whole chart. */
function size(chart: ChartApi): string {
	const overlay = chart.element().querySelectorAll('canvas')[3]!;
	return `${overlay.style.width} x ${overlay.style.height}`;
}

/** Makes the layout report `width` x `height` as the used size of every chart root. */
function layOut(width: string, height: string) {
	return vi
		.spyOn(window, 'getComputedStyle')
		.mockImplementation(() => ({ width, height }) as unknown as CSSStyleDeclaration);
}

describe('chart sizing', () => {
	let container: HTMLDivElement;
	let frames: ((now: number) => void)[];
	let charts: ChartApi[];

	const runFrames = (): void => {
		for (const frame of frames.splice(0)) {
			frame(16);
		}
	};
	const create = (target: HTMLElement = container): ChartApi => {
		const chart = createChart(target, { worker: false });
		charts.push(chart);
		return chart;
	};

	beforeEach(() => {
		container = document.body.appendChild(document.createElement('div'));
		frames = [];
		charts = [];
		FakeResizeObserver.instances = [];
		vi.stubGlobal('ResizeObserver', FakeResizeObserver);
		vi.stubGlobal('requestAnimationFrame', (callback: (now: number) => void) => frames.push(callback));
		vi.stubGlobal('cancelAnimationFrame', () => {});
	});

	afterEach(() => {
		for (const chart of charts) {
			chart.destroy();
		}
		container.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('fills the content box of a container with padding, not its border box', () => {
		// A container of 300 x 200 with 20 pixels of padding: the border box is 340 x 240.
		container.style.padding = '20px';
		const borderBox = vi
			.spyOn(container, 'getBoundingClientRect')
			.mockReturnValue({ left: 0, top: 0, width: 340, height: 240 } as DOMRect);
		const chart = create();
		const observer = FakeResizeObserver.instances[0]!;
		observer.report([[chart.element(), 300, 200]]);
		runFrames();
		expect(size(chart)).toBe('300px x 200px');
		expect(borderBox).not.toHaveBeenCalled();

		// Fractions are cut off, so the canvases never reach past the box.
		observer.report([[chart.element(), 250.75, 180.5]]);
		runFrames();
		expect(size(chart)).toBe('250px x 180px');
	});

	it('measures in the first frame, so the first paint has the size before the observer reports', () => {
		const layout = layOut('412.5px', '300px');
		const chart = create();
		expect(layout).not.toHaveBeenCalled();
		runFrames();
		expect(size(chart)).toBe('412px x 300px');
		expect(layout).toHaveBeenCalledTimes(1);

		// The observer then reports the same box: nothing changes and nothing is drawn again.
		FakeResizeObserver.instances[0]!.report([[chart.element(), 412.5, 300]]);
		expect(frames.length).toBe(0);
	});

	it('reads the layout once for any number of charts created in a row, and never for an options change', () => {
		const reads: string[] = [];
		const layout = vi.spyOn(window, 'getComputedStyle').mockImplementation(() => {
			reads.push('read');
			return { width: '300px', height: '200px' } as unknown as CSSStyleDeclaration;
		});
		const containers = [0, 1, 2].map(() => document.body.appendChild(document.createElement('div')));
		const created = containers.map(target => create(target));
		const bounding = containers.map(target => vi.spyOn(target, 'getBoundingClientRect'));
		expect(reads.length).toBe(0);
		// Every chart reads in the read phase of the one frame, before any of them writes.
		const writes = created.map(chart =>
			vi.spyOn(chart as unknown as { _placeLayers(): void }, '_placeLayers').mockImplementation(() => {
				reads.push('write');
			}),
		);
		runFrames();
		expect(reads.slice(0, 4)).toEqual(['read', 'read', 'read', 'write']);
		expect(reads.filter(entry => entry === 'read').length).toBe(3);
		for (const write of writes) {
			write.mockRestore();
		}

		layout.mockClear();
		for (const chart of created) {
			chart.applyOptions({ layout: { background: '#101010' } });
			chart.applyOptions({ grid: { vertLines: { visible: false } } });
		}
		runFrames();
		expect(layout).not.toHaveBeenCalled();
		for (const spy of bounding) {
			expect(spy).not.toHaveBeenCalled();
		}
		for (const target of containers) {
			target.remove();
		}
	});

	it('measures when a call needs the size before the first frame', async () => {
		layOut('640px', '400px');
		const chart = create();
		const time = Float64Array.from({ length: 1000 }, (_, i) => i * 60_000);
		chart.addSeries('line').setData({ time, value: time.map((_, i) => 100 + (i % 7)) });
		chart.timeScale().setVisibleLogicalRange({ from: 100, to: 300 });
		// The engine answers in a later task, and the range is applied then: no frame has run yet.
		const answered = async (remaining: number): Promise<void> => {
			if (remaining > 0 && chart.timeScale().getVisibleLogicalRange() === null) {
				await new Promise(resolve => setTimeout(resolve, 5));
				await answered(remaining - 1);
			}
		};
		await answered(100);
		expect(frames.length).toBe(1);
		const range = chart.timeScale().getVisibleLogicalRange()!;
		expect(range.from).toBeCloseTo(100, 6);
		expect(range.to).toBeCloseTo(300, 6);
	});

	it('shares one observer between charts and disconnects it with the last one', () => {
		const other = document.body.appendChild(document.createElement('div'));
		const first = create();
		const second = create(other);
		expect(FakeResizeObserver.instances.length).toBe(1);
		const observer = FakeResizeObserver.instances[0]!;
		expect(observer.targets.size).toBe(2);

		// One callback sizes both charts.
		observer.report([
			[first.element(), 300, 200],
			[second.element(), 500, 250],
		]);
		runFrames();
		expect(size(first)).toBe('300px x 200px');
		expect(size(second)).toBe('500px x 250px');

		// An explicit size stops the observation of that chart only.
		first.applyOptions({ autoSize: false, width: 111, height: 99 });
		expect(observer.targets.size).toBe(1);
		observer.report([[first.element(), 300, 200]]);
		runFrames();
		expect(size(first)).toBe('111px x 99px');

		first.destroy();
		expect(observer.disconnected).toBe(false);
		second.destroy();
		expect(observer.disconnected).toBe(true);
		create();
		expect(FakeResizeObserver.instances.length).toBe(2);
		other.remove();
	});

	it('measures on every options change where there is no observer to report resizes', () => {
		vi.stubGlobal('ResizeObserver', undefined);
		const layout = layOut('300px', '200px');
		const chart = create();
		runFrames();
		expect(size(chart)).toBe('300px x 200px');
		layout.mockImplementation(() => ({ width: '360px', height: '220px' }) as unknown as CSSStyleDeclaration);
		chart.applyOptions({ layout: { background: '#101010' } });
		runFrames();
		expect(size(chart)).toBe('360px x 220px');
	});
});
