import type { AdapterFactory, ChartAdapter, ChartSize, LogicalRange } from '../adapter.ts';
import { findAdapter } from '../adapters/index.ts';
import { DEFAULT_INTERVAL_MS, type SeriesColumns, TICK_NEW_BAR, generateSeries, generateTicks } from '../data.ts';
import type {
	AdapterInfo,
	FramesJob,
	FramesRun,
	Job,
	LoadJob,
	LoadRun,
	LoadTimings,
	MainThreadTimes,
	MemorySample,
	MultiJob,
	MultiRun,
	PageRunResult,
	PrependJob,
	PrependRun,
	PrependTimings,
	RefetchJob,
	RefetchRun,
	RunResult,
	TickJob,
	TickRun,
} from '../jobs.ts';
import { memoryResult } from '../memory.ts';
import { motionRanges } from '../motion.ts';
import { summarize } from '../stats.ts';
import { countDrawCalls } from './draw-calls.ts';
import {
	afterLibraryFrame,
	afterNextFrame,
	frameJsTotal,
	libraryFrameRuns,
	recordFrameTimes,
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
	/** Time the main thread has spent since the page started, or null if unavailable. */
	mainThread(): Promise<MainThreadTimes | null>;
	/** Resident memory of the browser's renderer processes in bytes, or null if unavailable. */
	rendererMemory(): Promise<number | null>;
}

/** Bars in view in the `latest` tick view. */
const LATEST_VIEW_BARS = 200;
/** Warm-up frames a frames run drops even when its warm-up budget is spent. */
const MIN_WARMUP_FRAMES = 3;

/** Whether `budgetMs` (0: unlimited) has passed since `start`. */
function overBudget(start: number, budgetMs: number, now = performance.now()): boolean {
	return budgetMs > 0 && now - start >= budgetMs;
}

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
		case 'prepend':
			return runPrepend(job, factory, container, probes);
		case 'refetch':
			return runRefetch(job, factory, container, probes);
		case 'multi':
			return runMulti(job, factory, container, probes);
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
		const warmupStart = performance.now();
		let offset = 0;
		while (offset < job.warmupTicks) {
			const end = Math.min(offset + roundSize, job.warmupTicks);
			for (let i = offset; i < end; i++) {
				adapter.applyTick(ticks, i);
			}
			offset = end;
			await adapter.settle();
			if (overBudget(warmupStart, job.warmupBudgetMs)) {
				break;
			}
		}

		const maxRounds = Math.ceil(job.ticks / roundSize);
		const durations = new Float64Array(job.ticks);
		const syncPerRound = new Float64Array(maxRounds);
		const settle = new Float64Array(maxRounds);
		const settleJs = new Float64Array(maxRounds);
		const mainThreadPerTick = new Float64Array(maxRounds);
		const measureStart = performance.now();
		let count = 0;
		let rounds = 0;
		while (count < job.ticks) {
			const r = rounds++;
			const start = count;
			const end = Math.min(start + roundSize, job.ticks);
			count = end;
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
			if (count >= job.minTicks && overBudget(measureStart, job.budgetMs)) {
				break;
			}
		}

		const update: number[] = [];
		const newBar: number[] = [];
		for (let i = 0; i < count; i++) {
			(ticks.tickKind[offset + i] === TICK_NEW_BAR ? newBar : update).push(durations[i] ?? 0);
		}
		return {
			sync: summarize(durations.subarray(0, count)),
			syncUpdate: summarize(update),
			syncNewBar: summarize(newBar),
			syncPerRound: summarize(syncPerRound.subarray(0, rounds)),
			settle: summarize(settle.subarray(0, rounds)),
			settleJs: summarize(settleJs.subarray(0, rounds)),
			mainThreadPerTick: summarize(mainThreadPerTick.subarray(0, rounds)),
			visibleBars,
			warmupTicks: offset,
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

		// Recorded frame k holds the library's draw for step k and the harness call for step k + 1.
		// Frame 0 has no draw yet and the final frame no harness call; both are dropped together with
		// the warm-up frames. Measured frames are [first, last); both are decided while running.
		let first = 0;
		let last = 0;
		startFrameRecording();
		let recording;
		try {
			await new Promise<void>((resolve, reject) => {
				const warmupStart = performance.now();
				let measureStart = 0;
				let frame = 0;
				const onFrame = (): void => {
					const now = performance.now();
					if (first === 0) {
						const warmedUp =
							frame >= job.warmupFrames ||
							(frame >= MIN_WARMUP_FRAMES && overBudget(warmupStart, job.warmupBudgetMs, now));
						if (warmedUp) {
							first = frame + 1;
							measureStart = now;
						}
					} else if (last === 0) {
						// The library has drawn in this frame already: its callbacks were requested first.
						const measured = frame + 1 - first;
						if (measured >= job.frames || (measured >= job.minFrames && overBudget(measureStart, job.budgetMs, now))) {
							last = frame + 1;
						}
					} else if (frame === last) {
						resolve();
						return;
					}
					const range = ranges[frame + 1];
					if (range === undefined) {
						reject(new Error(`No motion step for frame ${frame + 1}`));
						return;
					}
					try {
						adapter.setVisibleLogicalRange(range);
					} catch (error) {
						reject(error);
						return;
					}
					frame++;
					requestTimedFrame(onFrame);
				};
				requestTimedFrame(onFrame);
			});
		} finally {
			recording = stopFrameRecording();
		}
		await adapter.settle();

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

		// Untimed: one redraw at the starting range, with drawing calls counted.
		const drawCalls = await countRedraw(adapter, ranges[0] ?? { from: 0, to: n - 1 });

		return {
			jsTime: summarize(jsTime),
			interval: summarize(interval),
			framesWithLibraryWork,
			visibleBars,
			warmupFrames: first - 1,
			drawCalls,
		};
	} finally {
		adapter.destroy();
	}
}

/**
 * Counts the Canvas 2D calls of one redraw at `range`, untimed. The first move makes sure the
 * counted one changes the view, and lets a library fetch any rows the view needs beforehand.
 */
async function countRedraw(adapter: ChartAdapter, range: LogicalRange): Promise<Record<string, number>> {
	adapter.setVisibleLogicalRange({ from: range.from + 0.5, to: range.to + 0.5 });
	await adapter.settle();
	return countDrawCalls(async () => {
		adapter.setVisibleLogicalRange(range);
		await adapter.settle();
	});
}

/** Prepends `batch` and times it until the frame that shows it. The view is already set. */
async function measurePrepend(adapter: ChartAdapter, batch: SeriesColumns): Promise<PrependTimings> {
	const t0 = performance.now();
	const prepared = adapter.preparePrepend(batch);
	const t1 = performance.now();
	const runs = libraryFrameRuns();
	const js = frameJsTotal();
	const frames = recordFrameTimes();
	// Watched alongside `settle()` rather than awaited before it: `settle()` must start right after
	// the call, or a library that applies data synchronously would be timed a frame late.
	let firstFrame = Number.NaN;
	const firstFrameSeen = afterLibraryFrame(runs).then(
		() => {
			firstFrame = performance.now();
		},
		// Only reached when the chart never draws, which fails the run below anyway.
		() => undefined,
	);
	adapter.prepend(prepared);
	const t2 = performance.now();
	await adapter.settle();
	const t3 = performance.now();
	const frameJsMs = frameJsTotal() - js;
	const stamps = frames.stop();
	if (libraryFrameRuns() === runs) {
		// Every prepend in this scenario reaches the screen, so a chart that did not draw lost the data.
		throw new Error('The chart settled without drawing after prepend');
	}
	await firstFrameSeen;
	const points = [t1, ...stamps.filter(stamp => stamp > t1 && stamp < t3), t3];
	let longestFrameMs = 0;
	for (let i = 1; i < points.length; i++) {
		longestFrameMs = Math.max(longestFrameMs, (points[i] ?? 0) - (points[i - 1] ?? 0));
	}
	return {
		prepareMs: t1 - t0,
		callMs: t2 - t1,
		firstFrameMs: firstFrame - t1,
		shownMs: t3 - t1,
		frameJsMs,
		longestFrameMs,
	};
}

async function runPrepend(
	job: PrependJob,
	factory: AdapterFactory,
	container: HTMLElement,
	probes: Probes,
): Promise<PrependRun> {
	const { kind } = job.dataset;
	const data = generateSeries(kind, { seed: job.seed, count: job.dataset.size });
	await probes.collectGarbage();
	const before = await probes.measureMemory();
	const adapter = await createSettled(factory, container, job.chart);
	try {
		adapter.setData(prepare(adapter, data));
		await adapter.settle();

		const half = job.visibleBars / 2;
		// Logical index and time of the series' first row. Prepends move both back.
		let first = 0;
		let firstTime = data.time[0] ?? 0;
		const prependNext = async (index: number): Promise<PrependTimings> => {
			// Untimed: a batch that ends one step before the first bar, and the view with the first
			// bar in its middle, so the left half is empty until the batch arrives.
			const batch = generateSeries(kind, {
				seed: job.seed + 2 + index,
				count: job.batch,
				startTime: firstTime - job.batch * DEFAULT_INTERVAL_MS,
			});
			adapter.setVisibleLogicalRange({ from: first - half, to: first + half - 1 });
			await adapter.settle();
			const timings = await measurePrepend(adapter, batch);
			first -= job.batch;
			firstTime = batch.time[0] ?? firstTime;
			return timings;
		};

		const cold = await prependNext(0);
		const samples: PrependTimings[] = [];
		const measureStart = performance.now();
		while (samples.length < job.prepends) {
			samples.push(await prependNext(samples.length + 1));
			if (samples.length >= job.minPrepends && overBudget(measureStart, job.budgetMs)) {
				break;
			}
		}

		// Untimed: the view of the last prepend, whose left half now holds the last batch, and the view
		// at the new first bar, whose left half is empty.
		const last = first + job.batch;
		const shown = await countRedraw(adapter, { from: last - half, to: last + half - 1 });
		const leftEmpty = await countRedraw(adapter, { from: first - half, to: first + half - 1 });

		await probes.collectGarbage();
		const after = await probes.measureMemory();
		const distribution = (key: keyof PrependTimings) => summarize(samples.map(sample => sample[key]));
		return {
			cold,
			prepareMs: distribution('prepareMs'),
			callMs: distribution('callMs'),
			firstFrameMs: distribution('firstFrameMs'),
			shownMs: distribution('shownMs'),
			frameJsMs: distribution('frameJsMs'),
			longestFrameMs: distribution('longestFrameMs'),
			visibleBars: job.visibleBars,
			finalRows: data.length - first,
			drawCalls: { shown, leftEmpty },
			memory: memoryResult(before, after),
		};
	} finally {
		adapter.destroy();
	}
}

/** First position in sorted `time` whose value is not below `target`. */
function lowerBound(time: Float64Array, target: number): number {
	let lo = 0;
	let hi = time.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (time[mid]! < target) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo;
}

/** Rows `[from, to)` of a data set, as views on its columns. */
function sliceRows(data: SeriesColumns, from: number, to: number): SeriesColumns {
	const length = to - from;
	if (data.kind === 'line') {
		return { kind: 'line', length, time: data.time.subarray(from, to), value: data.value.subarray(from, to) };
	}
	return {
		kind: 'candles',
		length,
		time: data.time.subarray(from, to),
		open: data.open.subarray(from, to),
		high: data.high.subarray(from, to),
		low: data.low.subarray(from, to),
		close: data.close.subarray(from, to),
		volume: data.volume.subarray(from, to),
	};
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Gap between the cells of the multi-chart grid, in CSS pixels. It puts the first row below the
 * fold clear of the viewport's edge, so those charts are out of view, not just touching it.
 */
const MULTI_GAP = 8;
/** Untimed wait for a library's background work (building levels of detail) before memory is measured. */
const MULTI_BACKGROUND_MS = 1000;
/** Frames after scrolling for visibility to be reported and the draws it causes to be requested. */
const REVEAL_FRAMES = 4;

async function settleAll(adapters: readonly ChartAdapter[]): Promise<void> {
	await Promise.all(adapters.map(adapter => adapter.settle()));
}

/** Main-thread time between two readings, divided by `parts`. */
function mainThreadBetween(
	before: MainThreadTimes | null,
	after: MainThreadTimes | null,
	parts = 1,
): MainThreadTimes | null {
	if (before === null || after === null) {
		return null;
	}
	return {
		taskMs: (after.taskMs - before.taskMs) / parts,
		scriptMs: (after.scriptMs - before.scriptMs) / parts,
		layoutMs: (after.layoutMs - before.layoutMs) / parts,
		styleMs: (after.styleMs - before.styleMs) / parts,
	};
}

async function runMulti(
	job: MultiJob,
	factory: AdapterFactory,
	container: HTMLElement,
	probes: Probes,
): Promise<MultiRun> {
	const generateStart = performance.now();
	const data = generateSeries(job.dataset.kind, { seed: job.seed, count: job.dataset.size });
	const ticks = generateTicks(data, {
		seed: job.seed + 1,
		count: job.warmupRounds + job.rounds,
		newBarEvery: job.newBarEvery,
	});
	const generateMs = performance.now() - generateStart;
	if (job.maxWorkers !== null) {
		factory.setMaxWorkers?.(job.maxWorkers);
	}

	// A grid whose first rows fill the viewport; the rows after them start below its bottom edge.
	const visibleRows = Math.ceil(job.visibleCharts / job.columns);
	const cell = {
		width: Math.floor((document.documentElement.clientWidth - (job.columns - 1) * MULTI_GAP) / job.columns),
		height: Math.floor(window.innerHeight / visibleRows),
	};
	const grid = document.createElement('div');
	grid.style.display = 'grid';
	grid.style.gridTemplateColumns = `repeat(${job.columns}, ${cell.width}px)`;
	grid.style.gridAutoRows = `${cell.height}px`;
	grid.style.gap = `${MULTI_GAP}px`;
	const cells: HTMLElement[] = [];
	for (let i = 0; i < job.charts; i++) {
		cells.push(grid.appendChild(document.createElement('div')));
	}
	container.style.width = 'auto';
	container.style.height = 'auto';
	container.appendChild(grid);
	await afterNextFrame();
	await probes.collectGarbage();
	const before = await probes.measureMemory();
	const residentBefore = await probes.rendererMemory();

	const adapters: ChartAdapter[] = [];
	try {
		// What an application does for a dashboard: one loop that creates each chart and hands it its
		// data. Converting the data to the library's format is timed apart and left out.
		const mainBeforeLoad = await probes.mainThread();
		const loadJs = frameJsTotal();
		let convertMs = 0;
		const t0 = performance.now();
		for (const element of cells) {
			const adapter = await factory.create(element, 'auto');
			adapters.push(adapter);
			const convertStart = performance.now();
			const prepared = prepare(adapter, data);
			convertMs += performance.now() - convertStart;
			adapter.setData(prepared);
		}
		const t1 = performance.now();
		await settleAll(adapters);
		const t2 = performance.now();
		const shownFrameJsMs = frameJsTotal() - loadJs;
		const shownMainThread = mainThreadBetween(mainBeforeLoad, await probes.mainThread());

		await delay(MULTI_BACKGROUND_MS);
		await settleAll(adapters);
		await probes.collectGarbage();
		const after = await probes.measureMemory();
		const residentAfter = await probes.rendererMemory();

		const n = adapters.length;
		const warmupStart = performance.now();
		let offset = 0;
		while (offset < job.warmupRounds) {
			for (const adapter of adapters) {
				adapter.applyTick(ticks, offset);
			}
			offset++;
			await settleAll(adapters);
			if (overBudget(warmupStart, job.warmupBudgetMs)) {
				break;
			}
		}

		const sync = new Float64Array(job.rounds);
		const settle = new Float64Array(job.rounds);
		const frameJs = new Float64Array(job.rounds);
		const frameCallbacks = new Float64Array(job.rounds);
		const mainThreadPerTick = new Float64Array(job.rounds);
		const mainBeforeTicks = await probes.mainThread();
		const measureStart = performance.now();
		let rounds = 0;
		while (rounds < job.rounds) {
			const r = rounds++;
			const js = frameJsTotal();
			const runs = libraryFrameRuns();
			const roundStart = performance.now();
			for (const adapter of adapters) {
				adapter.applyTick(ticks, offset + r);
			}
			const applied = performance.now();
			await settleAll(adapters);
			const settled = performance.now();
			const paintJs = frameJsTotal() - js;
			sync[r] = (applied - roundStart) / n;
			settle[r] = settled - applied;
			frameJs[r] = paintJs;
			frameCallbacks[r] = libraryFrameRuns() - runs;
			mainThreadPerTick[r] = (applied - roundStart + paintJs) / n;
			if (rounds >= job.minRounds && overBudget(measureStart, job.budgetMs)) {
				break;
			}
		}
		const tickMainThread = mainThreadBetween(mainBeforeTicks, await probes.mainThread(), rounds);

		// The charts below the fold come into view: a library that put their draws off draws them now.
		const revealJs = frameJsTotal();
		window.scrollTo(0, document.documentElement.scrollHeight);
		for (let i = 0; i < REVEAL_FRAMES; i++) {
			await afterNextFrame();
		}
		await settleAll(adapters);
		const revealFrameJsMs = frameJsTotal() - revealJs;
		window.scrollTo(0, 0);

		return {
			charts: n,
			visibleCharts: job.visibleCharts,
			cell,
			generateMs,
			createMs: t1 - t0 - convertMs,
			shownMs: t2 - t0 - convertMs,
			shownFrameJsMs,
			shownMainThread,
			memory: memoryResult(before, after),
			workers: after?.workers?.count ?? null,
			rendererResident:
				residentBefore === null || residentAfter === null
					? null
					: {
							beforeBytes: residentBefore,
							afterBytes: residentAfter,
							retainedBytes: residentAfter - residentBefore,
						},
			sync: summarize(sync.subarray(0, rounds)),
			settle: summarize(settle.subarray(0, rounds)),
			frameJs: summarize(frameJs.subarray(0, rounds)),
			frameCallbacks: summarize(frameCallbacks.subarray(0, rounds)),
			mainThreadPerTick: summarize(mainThreadPerTick.subarray(0, rounds)),
			tickMainThread,
			rounds,
			warmupRounds: offset,
			revealFrameJsMs,
		};
	} finally {
		for (const adapter of adapters) {
			adapter.destroy();
		}
	}
}

async function runRefetch(
	job: RefetchJob,
	factory: AdapterFactory,
	container: HTMLElement,
	probes: Probes,
): Promise<RefetchRun> {
	const data = generateSeries(job.dataset.kind, { seed: job.seed, count: job.dataset.size });
	await probes.collectGarbage();
	const before = await probes.measureMemory();
	const adapter = await createSettled(factory, container, job.chart);
	try {
		if (adapter.setDataWithDatafeed === undefined) {
			throw new Error('This library cannot fetch history again from a datafeed');
		}
		let fetches = 0;
		let fetchedRows = 0;
		// The datafeed is the generated data set itself, held by the page like a server would hold it.
		const datafeed = (from: number, to: number): SeriesColumns => {
			const lo = lowerBound(data.time, from);
			const hi = lowerBound(data.time, to + 1);
			fetches++;
			fetchedRows += hi - lo;
			return sliceRows(data, lo, hi);
		};
		adapter.setDataWithDatafeed(prepare(adapter, data), datafeed, job.memoryLimit);
		await adapter.settle();
		// Untimed: the library summarizes the history and lets rows go in the background.
		await delay(1500);
		await adapter.settle();
		await probes.collectGarbage();
		const loaded = await probes.measureMemory();

		const n = data.length;
		const half = job.visibleBars / 2;
		// Regions spread over the oldest 90% of the history, far enough apart that no jump lands in
		// rows the previous one brought back.
		const step = Math.floor((n * 0.9) / (job.jumps + 1));
		const jump = async (index: number): Promise<{ shownMs: number; fetches: number; fetchedRows: number }> => {
			const center = Math.floor(n * 0.02) + index * step;
			const f0 = fetches;
			const r0 = fetchedRows;
			const t0 = performance.now();
			adapter.setVisibleLogicalRange({ from: center - half, to: center + half - 1 });
			await adapter.settle();
			return { shownMs: performance.now() - t0, fetches: fetches - f0, fetchedRows: fetchedRows - r0 };
		};
		const cold = await jump(0);
		const samples: { shownMs: number; fetches: number; fetchedRows: number }[] = [];
		const measureStart = performance.now();
		while (samples.length < job.jumps) {
			samples.push(await jump(samples.length + 1));
			if (samples.length >= job.minJumps && overBudget(measureStart, job.budgetMs)) {
				break;
			}
		}
		await probes.collectGarbage();
		const after = await probes.measureMemory();
		return {
			coldShownMs: cold.shownMs,
			shownMs: summarize(samples.map(sample => sample.shownMs)),
			fetches: summarize(samples.map(sample => sample.fetches)),
			fetchedRows: summarize(samples.map(sample => sample.fetchedRows)),
			jumpsWithoutFetch: samples.filter(sample => sample.fetches === 0).length,
			visibleBars: job.visibleBars,
			memoryLimit: job.memoryLimit,
			rows: n,
			memoryAfterLoad: memoryResult(before, loaded),
			memory: memoryResult(before, after),
		};
	} finally {
		adapter.destroy();
	}
}
