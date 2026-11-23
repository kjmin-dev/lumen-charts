import type { ChartError, PanePrimitive, PaneView } from '@lumen-charts/core';
import type { EngineClient, EngineEvent, MarksData } from '@lumen-charts/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FetchingSeries, MarkFetches } from '../src/marks/fetches';
import { TestChart, candles } from './drawing-helpers';

/** Stands in for `ImageData`, which the test environment lacks. */
class FakeImageData {
	public readonly data: Uint8ClampedArray;
	public constructor(
		public readonly width: number,
		public readonly height: number,
	) {
		this.data = new Uint8ClampedArray(width * height * 4);
	}
}

class Probe implements PanePrimitive {
	public view: PaneView | null = null;
	public update(view: PaneView): void {
		this.view = view;
	}
	public draw(): void {}
}

class Chart extends TestChart {
	public constructor(options: ConstructorParameters<typeof TestChart>[0] = {}) {
		super({ markRenderer: 'canvas2d', ...options });
		this.chart.attachPrimitive(new Probe());
	}

	/** The pixels the mark series' canvas got last. */
	public pixels(): Uint32Array {
		const layers = new Set(this.canvases());
		let image: FakeImageData | null = null;
		for (const canvas of this.recorders.keys()) {
			if (layers.has(canvas)) {
				continue;
			}
			for (const call of this.calls(canvas)) {
				if (call.name === 'putImageData') {
					image = call.args[0] as FakeImageData;
				}
			}
		}
		return image === null ? new Uint32Array(0) : new Uint32Array(image.data.buffer.slice(0));
	}

	/** The line series the chart holds that are listed nowhere: the timeline its marks make. */
	public hiddenSeries(): number {
		return (this.chart as unknown as { _series: { derived: boolean }[] })._series.filter(series => series.derived)
			.length;
	}
}

describe('a timeline shared by mark series (5)', () => {
	it('lets go of the timeline a series made when making the series throws, and counts no user for it', async () => {
		const t = new Chart();
		try {
			// The first series with a timeline makes it; its options throw: it goes again.
			expect(() => t.chart.addSeries('scatter', { timeline: true, colorBy: 'x' as 'value' })).toThrow(RangeError);
			expect(t.hiddenSeries()).toBe(0);
			const engine = (t.chart as unknown as { _data: { engine: EngineClient } })._data.engine;
			const removeSeries = vi.spyOn(engine, 'removeSeries');
			// A series that does make one, and another that throws while it is shared.
			const trades = t.chart.addSeries('scatter', { timeline: true });
			trades.setData([{ time: 60_500, price: 100, value: 1 }]);
			expect(t.hiddenSeries()).toBe(1);
			expect(() => t.chart.addSeries('heatmap', { timeline: true, palette: 'no such palette' })).toThrow(RangeError);
			expect(() => t.chart.addSeries('scatter', { timeline: true, colorBy: 'x' as 'value' })).toThrow(RangeError);
			expect(t.hiddenSeries()).toBe(1);
			await t.settle();
			// The one series left with it: removing it lets the timeline go, once.
			t.chart.removeSeries(trades);
			await t.settle();
			expect(t.hiddenSeries()).toBe(0);
			expect(removeSeries).toHaveBeenCalledTimes(1);
		} finally {
			t.destroy();
		}
	});
});

function event(fields: Partial<EngineEvent>): EngineEvent {
	return { ack: 1, epoch: 0, first: 0, end: 0, stale: false, rejected: 0, ...fields };
}

describe('pauses after marks refused (1)', () => {
	let restored: number;
	let series: FetchingSeries & { retries: number };
	let fetches: MarkFetches;

	beforeEach(() => {
		vi.useFakeTimers();
		restored = 0;
		const engine = {
			restoreMarks: () => {
				restored++;
				return 0;
			},
		} as unknown as EngineClient;
		series = {
			engineId: 7,
			datafeed: { getMarks: () => Promise.resolve({}) },
			packFetched: data => data as MarksData,
			retries: 0,
			retry() {
				this.retries++;
			},
			fetchBackoff: 0,
		};
		fetches = new MarkFetches(
			() => engine,
			id => (id === 7 ? series : undefined),
			() => {},
		);
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		fetches.destroy();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	/** One round: three chunks asked for and handed back, all refused. */
	async function refusedRound(first: number): Promise<void> {
		fetches.handle(
			event({
				marksFetch: [0, 1, 2].map(k => ({ id: first + k, series: 7, from: k, to: k, count: 1 })),
			}),
		);
		await vi.advanceTimersByTimeAsync(0);
		for (let k = 0; k < 3; k++) {
			fetches.handle(event({ marksRestored: { request: first + k, series: 7, outcome: 'mismatch' } }));
		}
	}

	it('pauses once per round of refusals, 1, 2 and 4 s, and asks again once after each', async () => {
		await refusedRound(10);
		expect(restored).toBe(3);
		expect(series.fetchBackoff).toBe(1000);
		await vi.advanceTimersByTimeAsync(999);
		expect(series.retries).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(series.retries).toBe(1);
		await refusedRound(20);
		expect(series.fetchBackoff).toBe(2000);
		await vi.advanceTimersByTimeAsync(2000);
		expect(series.retries).toBe(2);
		await refusedRound(30);
		expect(series.fetchBackoff).toBe(4000);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(series.retries).toBe(3);
	});
});

/** `count` trades a second apart, as columns. */
function history(count: number) {
	const time: number[] = [];
	const price: number[] = [];
	const value: number[] = [];
	for (let i = 0; i < count; i++) {
		time.push(i * 1000);
		price.push(100 + Math.sin(i / 3000) * 4 + ((i * 7) % 11) * 0.01);
		value.push((i * 13) % 50);
	}
	return { time, price, value };
}

type History = ReturnType<typeof history>;

function slice(data: History, from: number, to: number): History {
	const out: History = { time: [], price: [], value: [] };
	for (let i = 0; i < data.time.length; i++) {
		if (data.time[i]! >= from && data.time[i]! <= to) {
			out.time.push(data.time[i]!);
			out.price.push(data.price[i]!);
			out.value.push(data.value[i]!);
		}
	}
	return out;
}

/**
 * A chart of 400,000 trades viewed at their end under `limit`, from which the application removes
 * the trades of `[from, to]` at its source first and then from the chart, and whose view then moves
 * to them: what it draws, what was refused, and what the datafeed warned of.
 */
async function removed(
	limit: number,
): Promise<{ pixels: Uint32Array; errors: ChartError[]; warnings: number; asked: number }> {
	vi.stubGlobal('ImageData', FakeImageData);
	const t = new Chart({ memoryLimit: limit });
	const errors: ChartError[] = [];
	let warnings = 0;
	let asked = 0;
	vi.spyOn(console, 'warn').mockImplementation(() => {
		warnings++;
	});
	try {
		const all = history(400_000);
		let source = all;
		t.chart.subscribe('error', error => errors.push(error));
		t.chart.addSeries('candlestick').setData(candles(7000));
		const series = t.chart.addSeries('scatter', {
			autoscale: false,
			datafeed: {
				getMarks: ({ from, to }) => {
					asked++;
					return Promise.resolve(slice(source, from, to));
				},
			},
		});
		series.setData(all);
		t.chart.timeScale().setVisibleLogicalRange({ from: 6600, to: 6680 });
		await t.settle();
		// The application removes the trades of two seconds' worth of bars at its source, then here.
		const from = 150_000_000;
		const to = 152_000_000;
		const kept = (i: number): boolean => all.time[i]! < from || all.time[i]! > to;
		source = {
			time: all.time.filter((_, i) => kept(i)),
			price: all.price.filter((_, i) => kept(i)),
			value: all.value.filter((_, i) => kept(i)),
		};
		series.removeMarks({ from, to });
		await t.settle();
		t.chart.timeScale().setVisibleLogicalRange({ from: 2480, to: 2560 });
		await t.settle();
		return { pixels: t.pixels(), errors, warnings, asked };
	} finally {
		t.destroy();
		vi.unstubAllGlobals();
	}
}

describe('a removal at the source, then on a chart whose marks were let go (1)', () => {
	it('runs with the datafeed answering the changed history, and draws what a chart that kept everything draws', async () => {
		const reference = await removed(Infinity);
		expect(reference.asked).toBe(0);
		const fetched = await removed(1);
		expect(fetched.asked).toBeGreaterThan(0);
		expect(fetched.errors).toEqual([]);
		expect(fetched.warnings).toBe(0);
		expect(fetched.pixels.some(pixel => pixel !== 0)).toBe(true);
		expect(fetched.pixels).toEqual(reference.pixels);
	});
});
