import type { AdapterFactory, ChartAdapter, ChartSize } from '../adapter.ts';
import { findAdapter } from '../adapters/index.ts';
import { type SeriesColumns, TICK_NEW_BAR, generateSeries, generateTicks } from '../data.ts';
import type {
	AdapterInfo,
	FramesJob,
	FramesRun,
	Job,
	LoadJob,
	LoadRun,
	LoadTimings,
	MemoryResult,
	MemorySample,
	PageRunResult,
	RunResult,
	TickJob,
	TickRun,
} from '../jobs.ts';
import { motionRanges } from '../motion.ts';
import { summarize } from '../stats.ts';
import { countDrawCalls } from './draw-calls.ts';
import {
	afterLibraryFrame,
	afterNextFrame,
	frameJsTotal,
	libraryFrameRuns,
	requestTimedFrame,
	startFrameRecording,
	stopFrameRecording,
} from './frames.ts';

/** Services the page cannot provide itself with full precision; the runner supplies them over CDP. */
export interface Probes {
	/** Full garbage collection, or nothing if unavailable. */
	collectGarbage(): Promise<void>;
	/** Memory in use by the page, or null if unavailable. */
	measureMemory(): Promise<MemorySample | null>;
}

/** Bars in view in the `latest` tick view. */
const LATEST_VIEW_BARS = 200;

export async function runJob(job: Job, container: HTMLElement, probes: Probes): Promise<PageRunResult> {
	let info: AdapterInfo | null = null;
	try {
		const factory = await findAdapter(job.adapter).load();
		info = { library: { ...factory.library }, options: { ...factory.options } };
		const result = await runScenario(job, factory, container, probes);
		return { status: 'ok', adapter: info, result };
	} catch (error) {
		const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
		return { status: 'failed', adapter: info, message };
	} finally {
		container.replaceChildren();
	}
}

function runScenario(job: Job, factory: AdapterFactory, container: HTMLElement, probes: Probes): Promise<RunResult> {
	switch (job.scenario) {
		case 'load':
			return runLoad(job, factory, container, probes);
		case 'tick':
			return runTick(job, factory, container);
		case 'frames':
			return runFrames(job, factory, container);
	}
}

function prepare(adapter: ChartAdapter, data: SeriesColumns): unknown {
	return data.kind === 'candles' ? adapter.prepareCandles(data) : adapter.prepareLine(data);
}

/** Creates a chart and waits until its empty state is painted, so creation is not part of a load. */
async function createSettled(factory: AdapterFactory, container: HTMLElement, size: ChartSize): Promise<ChartAdapter> {
	const adapter = await factory.create(container, size);
	await adapter.settle();
	return adapter;
}

async function loadOnce(
	factory: AdapterFactory,
	container: HTMLElement,
	size: ChartSize,
	data: SeriesColumns,
): Promise<{ adapter: ChartAdapter; timings: LoadTimings }> {
	const adapter = await createSettled(factory, container, size);
	const t0 = performance.now();
	const prepared = prepare(adapter, data);
	const t1 = performance.now();
	const runs = libraryFrameRuns();
	const js = frameJsTotal();
	adapter.setData(prepared);
	const t2 = performance.now();
	await afterLibraryFrame(runs);
	const t3 = performance.now();
	await adapter.settle();
	const t4 = performance.now();
	return {
		adapter,
		timings: {
			convertMs: t1 - t0,
			setDataMs: t2 - t1,
			firstFrameMs: t3 - t1,
			firstFrameWithConversionMs: t3 - t0,
			settledMs: t4 - t1,
			frameJsMs: frameJsTotal() - js,
		},
	};
}

function difference(after: number | null, before: number | null): number | null {
	return after === null || before === null ? null : after - before;
}

function memoryResult(before: MemorySample | null, after: MemorySample | null): MemoryResult | null {
	if (before === null || after === null) {
		return null;
	}
	return {
		before,
		after,
		retainedBytes: after.totalBytes - before.totalBytes,
		retainedJsHeapBytes: after.jsHeapBytes - before.jsHeapBytes,
		retainedBackingStoreBytes: difference(after.backingStoreBytes, before.backingStoreBytes),
		retainedEmbedderHeapBytes: difference(after.embedderHeapBytes, before.embedderHeapBytes),
	};
}

async function runLoad(
	job: LoadJob,
	factory: AdapterFactory,
	container: HTMLElement,
	probes: Probes,
): Promise<LoadRun> {
	const generateStart = performance.now();
	const data = generateSeries(job.dataset.kind, { seed: job.seed, count: job.dataset.size });
	const generateMs = performance.now() - generateStart;
	await probes.collectGarbage();

	const cold = await loadOnce(factory, container, job.chart, data);
	cold.adapter.destroy();
	await afterNextFrame();
	await probes.collectGarbage();

	const before = await probes.measureMemory();
	const warm = await loadOnce(factory, container, job.chart, data);
	await probes.collectGarbage();
	const after = await probes.measureMemory();
	warm.adapter.destroy();

	return { generateMs, cold: cold.timings, warm: warm.timings, memory: memoryResult(before, after) };
}

async function runTick(job: TickJob, factory: AdapterFactory, container: HTMLElement): Promise<TickRun> {
	const data = generateSeries(job.dataset.kind, { seed: job.seed, count: job.dataset.size });
	const ticks = generateTicks(data, {
		seed: job.seed + 1,
		count: job.warmupTicks + job.ticks,
		newBarEvery: job.newBarEvery,
	});
	const adapter = await createSettled(factory, container, job.chart);
	try {
		adapter.setData(prepare(adapter, data));
		await adapter.settle();
		const n = data.length;
		const visibleBars = job.view === 'all' ? n : Math.min(LATEST_VIEW_BARS, n);
		adapter.setVisibleLogicalRange({ from: n - visibleBars, to: n - 1 });
		await adapter.settle();

		const { roundSize } = job;
		for (let start = 0; start < job.warmupTicks; start += roundSize) {
			const end = Math.min(start + roundSize, job.warmupTicks);
			for (let i = start; i < end; i++) {
				adapter.applyTick(ticks, i);
			}
			await adapter.settle();
		}

		const count = job.ticks;
		const rounds = Math.ceil(count / roundSize);
		const durations = new Float64Array(count);
		const syncPerRound = new Float64Array(rounds);
		const settle = new Float64Array(rounds);
		const settleJs = new Float64Array(rounds);
		const mainThreadPerTick = new Float64Array(rounds);
		const offset = job.warmupTicks;
		for (let r = 0; r < rounds; r++) {
			const start = r * roundSize;
			const end = Math.min(start + roundSize, count);
			const roundStart = performance.now();
			let last = roundStart;
			for (let i = start; i < end; i++) {
				adapter.applyTick(ticks, offset + i);
				const now = performance.now();
				durations[i] = now - last;
				last = now;
			}
			const js = frameJsTotal();
			await adapter.settle();
			const settled = performance.now();
			const paintJs = frameJsTotal() - js;
			syncPerRound[r] = (last - roundStart) / (end - start);
			settle[r] = settled - last;
			settleJs[r] = paintJs;
			mainThreadPerTick[r] = (last - roundStart + paintJs) / (end - start);
		}

		const update: number[] = [];
		const newBar: number[] = [];
		for (let i = 0; i < count; i++) {
			(ticks.tickKind[offset + i] === TICK_NEW_BAR ? newBar : update).push(durations[i] ?? 0);
		}
		return {
			sync: summarize(durations),
			syncUpdate: summarize(update),
			syncNewBar: summarize(newBar),
			syncPerRound: summarize(syncPerRound),
			settle: summarize(settle),
			settleJs: summarize(settleJs),
			mainThreadPerTick: summarize(mainThreadPerTick),
			visibleBars,
		};
	} finally {
		adapter.destroy();
	}
}

async function runFrames(job: FramesJob, factory: AdapterFactory, container: HTMLElement): Promise<FramesRun> {
	const data = generateSeries(job.dataset.kind, { seed: job.seed, count: job.dataset.size });
	const adapter = await createSettled(factory, container, job.chart);
	try {
		adapter.setData(prepare(adapter, data));
		await adapter.settle();
		const n = data.length;
		const visibleBars = job.zoom === 'all' ? n : Math.min(job.zoom, n);
		// Step 0 is applied before recording; each later step runs in its own animation frame.
		const steps = job.warmupFrames + job.frames + 2;
		const ranges = motionRanges(job.motion, n, visibleBars, steps, Math.max(1, Math.round(job.frames / 4)));
		adapter.setVisibleLogicalRange(ranges[0] ?? { from: 0, to: n - 1 });
		await adapter.settle();

		startFrameRecording();
		let recording;
		try {
			await new Promise<void>((resolve, reject) => {
				let step = 1;
				const onFrame = (): void => {
					const range = ranges[step];
					if (range === undefined) {
						resolve();
						return;
					}
					try {
						adapter.setVisibleLogicalRange(range);
					} catch (error) {
						reject(error);
						return;
					}
					step++;
					requestTimedFrame(onFrame);
				};
				requestTimedFrame(onFrame);
			});
		} finally {
			recording = stopFrameRecording();
		}
		await adapter.settle();

		// Recorded frame k holds the library's draw for step k and the harness call for step k + 1.
		// Frame 0 has no draw yet and the final frame no harness call; both are dropped together with
		// the warm-up frames.
		const first = job.warmupFrames + 1;
		const last = first + job.frames;
		if (recording.timestamps.length < last) {
			throw new Error(`Recorded ${recording.timestamps.length} frames, expected at least ${last}`);
		}
		const jsTime: number[] = [];
		const interval: number[] = [];
		let framesWithLibraryWork = 0;
		for (let k = first; k < last; k++) {
			jsTime.push(recording.jsTime[k] ?? 0);
			interval.push((recording.timestamps[k] ?? 0) - (recording.timestamps[k - 1] ?? 0));
			if ((recording.libraryCallbacks[k] ?? 0) > 0) {
				framesWithLibraryWork++;
			}
		}

		// Untimed: one redraw at the starting range, with drawing calls counted. The first move makes
		// sure the counted one changes the view.
		const start = ranges[0] ?? { from: 0, to: n - 1 };
		adapter.setVisibleLogicalRange({ from: start.from + 0.5, to: start.to + 0.5 });
		await adapter.settle();
		const drawCalls = await countDrawCalls(async () => {
			adapter.setVisibleLogicalRange(start);
			await adapter.settle();
		});

		return {
			jsTime: summarize(jsTime),
			interval: summarize(interval),
			framesWithLibraryWork,
			visibleBars,
			drawCalls,
		};
	} finally {
		adapter.destroy();
	}
}
