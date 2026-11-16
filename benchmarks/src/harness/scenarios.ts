import type { AdapterFactory, ChartAdapter, ChartSize, LogicalRange } from '../adapter.ts';
import { findAdapter } from '../adapters/index.ts';
import {
	type CandleColumns,
	DEFAULT_INTERVAL_MS,
	Random,
	type LineColumns,
	type SeriesColumns,
	TICK_NEW_BAR,
	generateSeries,
	generateTicks,
} from '../data.ts';
import type {
	AdapterInfo,
	ApplyJob,
	ApplyRun,
	DrawingsJob,
	DrawingsRun,
	FramesJob,
	FramesRun,
	IndicatorFramesJob,
	AxesFramesJob,
	IndicatorLoadJob,
	IndicatorPrependJob,
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
	RefetchOperations,
	RefetchRun,
	RunResult,
	StateJob,
	StateRun,
	TickJob,
	TickRun,
	TimeZoneFramesJob,
	ZoneChangeJob,
	ZoneChangeRun,
	ZoneChangeTimings,
} from '../jobs.ts';
import { generateDrawings } from '../drawings.ts';
import { memoryResult } from '../memory.ts';
import { motionRanges } from '../motion.ts';
import { summarize } from '../stats.ts';
import { countDrawCalls } from './draw-calls.ts';
import {
	afterLibraryFrame,
	afterNextFrame,
	frameJsTotal,
	libraryFrameRuns,
	nextTask,
	pendingFrameCallbacks,
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
		case 'ind-load':
			return runLoad(job, factory, container, probes);
		case 'ind-apply':
			return runApply(job, factory, container);
		case 'ind-frames':
			return runFrames(job, factory, container);
		case 'ind-prepend':
			return runPrepend(job, factory, container, probes);
		case 'axes-frames':
			return runFrames(job, factory, container);
		case 'multi':
			return runMulti(job, factory, container, probes);
		case 'drawings':
			return runDrawings(job, factory, container);
		case 'state':
			return runState(job, factory, container);
		case 'tz-frames':
			return runFrames(job, factory, container);
		case 'tz-change':
			return runZoneChange(job, factory, container);
	}
}

function prepare(adapter: ChartAdapter, data: SeriesColumns): unknown {
	return data.kind === 'candles' ? adapter.prepareCandles(data) : adapter.prepareLine(data);
}

/** Indicators a job puts on its series (the stage 3 scenarios), or 0. */
function indicatorsOf(job: Job): number {
	return 'indicators' in job ? job.indicators : 0;
}

/** Puts the indicator set on the series the next `setData` creates, if the job has any. */
function withIndicators(adapter: ChartAdapter, count: number): void {
	if (count === 0) {
		return;
	}
	if (adapter.withIndicators === undefined) {
		throw new Error('This adapter cannot put indicators on a series');
	}
	adapter.withIndicators(count);
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
	indicators: number,
): Promise<{ adapter: ChartAdapter; timings: LoadTimings }> {
	const adapter = await createSettled(factory, container, size);
	withIndicators(adapter, indicators);
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
	job: LoadJob | IndicatorLoadJob,
	factory: AdapterFactory,
	container: HTMLElement,
	probes: Probes,
): Promise<LoadRun> {
	const generateStart = performance.now();
	const data = generateSeries(job.dataset.kind, { seed: job.seed, count: job.dataset.size });
	const generateMs = performance.now() - generateStart;
	await probes.collectGarbage();

	const indicators = indicatorsOf(job);
	const cold = await loadOnce(factory, container, job.chart, data, indicators);
	cold.adapter.destroy();
	await afterNextFrame();
	await probes.collectGarbage();

	const before = await probes.measureMemory();
	const warm = await loadOnce(factory, container, job.chart, data, indicators);
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

/** Puts a chart of a stage 4 job into its time zone, with its sessions. */
function withTimeZone(adapter: ChartAdapter, timeZone: string, sessions: boolean): void {
	if (adapter.setTimeZone === undefined) {
		throw new Error('This adapter cannot show time zones');
	}
	adapter.setTimeZone(timeZone, sessions);
}

async function runFrames(
	job: FramesJob | IndicatorFramesJob | AxesFramesJob | TimeZoneFramesJob,
	factory: AdapterFactory,
	container: HTMLElement,
): Promise<FramesRun> {
	const data = generateSeries(job.dataset.kind, { seed: job.seed, count: job.dataset.size });
	const adapter = await createSettled(factory, container, job.chart);
	try {
		withIndicators(adapter, indicatorsOf(job));
		if (job.scenario === 'axes-frames') {
			if (adapter.withPriceAxes === undefined) {
				throw new Error('This adapter cannot lay out price axes');
			}
			adapter.withPriceAxes(job.axes);
		}
		if (job.scenario === 'tz-frames') {
			withTimeZone(adapter, job.timeZone, job.sessions);
		}
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

/** Times one change of options from the call until it is drawn. */
async function timeChange(adapter: ChartAdapter, change: () => void): Promise<[number, number, number]> {
	const js = frameJsTotal();
	const t0 = performance.now();
	change();
	const t1 = performance.now();
	await adapter.settle();
	const t2 = performance.now();
	return [t1 - t0, frameJsTotal() - js, t2 - t0];
}

function changeTimings(samples: readonly [number, number, number][]): ZoneChangeTimings {
	return {
		callMs: summarize(samples.map(sample => sample[0])),
		frameJsMs: summarize(samples.map(sample => sample[1])),
		workMs: summarize(samples.map(sample => sample[0] + sample[1])),
		shownMs: summarize(samples.map(sample => sample[2])),
	};
}

async function runZoneChange(
	job: ZoneChangeJob,
	factory: AdapterFactory,
	container: HTMLElement,
): Promise<ZoneChangeRun> {
	const data = generateSeries(job.dataset.kind, { seed: job.seed, count: job.dataset.size });
	const adapter = await createSettled(factory, container, job.chart);
	try {
		if (adapter.setTimeZone === undefined || adapter.repaint === undefined) {
			throw new Error('This adapter cannot show time zones');
		}
		adapter.setData(prepare(adapter, data));
		await adapter.settle();
		const n = data.length;
		const visibleBars = job.zoom === 'all' ? n : Math.min(job.zoom, n);
		// The middle of the history: both ends of the view have bars, and the window around it too.
		const from = Math.floor((n - visibleBars) / 2);
		adapter.setVisibleLogicalRange({ from, to: from + visibleBars - 1 });
		await adapter.settle();

		const setZone = (zone: string) => () => adapter.setTimeZone!(zone, false);
		const cold: [number, number, number][] = [];
		for (const zone of job.zones) {
			// UTC needs no table: it is not a first change.
			if (zone !== 'UTC') {
				cold.push(await timeChange(adapter, setZone(zone)));
			}
		}
		const warm: [number, number, number][] = [];
		let current = job.zones[job.zones.length - 1];
		for (let i = 0; i < job.changes; i++) {
			const zone = job.zones[i % job.zones.length]!;
			// A change to the zone already shown would change nothing.
			if (zone === current) {
				continue;
			}
			warm.push(await timeChange(adapter, setZone(zone)));
			current = zone;
		}
		const baseline: [number, number, number][] = [];
		for (let i = 0; i < job.changes; i++) {
			baseline.push(await timeChange(adapter, () => adapter.repaint!()));
		}
		return { cold: changeTimings(cold), warm: changeTimings(warm), baseline: changeTimings(baseline), visibleBars };
	} finally {
		adapter.destroy();
	}
}

/**
 * Saving and restoring the state of a 1M-candle chart with indicators and drawings. Saving, and the
 * trip through JSON, are timed alone; a restore from the call until the frame that shows it is
 * drawn, like any change (`timeChange`), with the frames the library drew for it counted.
 */
async function runState(job: StateJob, factory: AdapterFactory, container: HTMLElement): Promise<StateRun> {
	const data = generateSeries('candles', { seed: job.seed, count: job.dataset.size }) as CandleColumns;
	const adapter = await createSettled(factory, container, job.chart);
	const { addDrawings, saveState, restoreState, clearState } = adapter;
	if (addDrawings === undefined || saveState === undefined || restoreState === undefined || clearState === undefined) {
		throw new Error('This adapter saves no chart state');
	}
	try {
		adapter.withIndicators?.(job.indicators);
		adapter.setData(prepare(adapter, data));
		await adapter.settle();
		const n = data.length;
		const visibleBars = Math.min(job.visibleBars, n);
		const view = { from: n - visibleBars, to: n - 1 };
		adapter.setVisibleLogicalRange(view);
		await adapter.settle();
		addDrawings.call(adapter, generateDrawings(data, job.drawings, view.from, view.to, job.seed + 3));
		await adapter.settle();

		// A call takes a fraction of a millisecond, which the page's clock resolves poorly: ten a sample.
		const batch = 10;
		const time = (action: () => void): number => {
			const t0 = performance.now();
			for (let i = 0; i < batch; i++) {
				action();
			}
			return (performance.now() - t0) / batch;
		};
		let state = saveState.call(adapter);
		let json = JSON.stringify(state);
		const saveMs: number[] = [];
		const stringifyMs: number[] = [];
		const parseMs: number[] = [];
		for (let round = 0; round < job.rounds + STATE_WARMUP_ROUNDS; round++) {
			const save = time(() => {
				state = saveState.call(adapter);
			});
			const stringify = time(() => {
				json = JSON.stringify(state);
			});
			const parse = time(() => {
				JSON.parse(json);
			});
			if (round >= STATE_WARMUP_ROUNDS) {
				saveMs.push(save);
				stringifyMs.push(stringify);
				parseMs.push(parse);
			}
		}

		const restore: [number, number, number][] = [];
		const restoreFrames: number[] = [];
		for (let round = 0; round < job.rounds + STATE_WARMUP_ROUNDS; round++) {
			// As an application gets it from storage: objects the chart has never seen.
			const parsed: unknown = JSON.parse(json);
			const runs = libraryFrameRuns();
			const sample = await timeChange(adapter, () => restoreState.call(adapter, parsed));
			if (round >= STATE_WARMUP_ROUNDS) {
				restore.push(sample);
				restoreFrames.push(libraryFrameRuns() - runs);
			}
		}
		if (JSON.stringify(saveState.call(adapter)) !== json) {
			throw new Error('The state saved after a restore differs from the state restored');
		}
		const restoreEmpty: [number, number, number][] = [];
		for (let round = 0; round < job.rounds + STATE_WARMUP_ROUNDS; round++) {
			clearState.call(adapter);
			await adapter.settle();
			const parsed: unknown = JSON.parse(json);
			const sample = await timeChange(adapter, () => restoreState.call(adapter, parsed));
			if (round >= STATE_WARMUP_ROUNDS) {
				restoreEmpty.push(sample);
			}
		}
		return {
			saveMs: summarize(saveMs),
			stringifyMs: summarize(stringifyMs),
			parseMs: summarize(parseMs),
			jsonLength: json.length,
			restore: changeTimings(restore),
			restoreEmpty: changeTimings(restoreEmpty),
			restoreFrames: summarize(restoreFrames),
			drawings: job.drawings,
			indicators: job.indicators,
			visibleBars,
		};
	} finally {
		adapter.destroy();
	}
}

/** Rounds of the state scenario before the measured ones, which let the engine compile the code. */
const STATE_WARMUP_ROUNDS = 3;

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
	job: PrependJob | IndicatorPrependJob,
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
		withIndicators(adapter, indicatorsOf(job));
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

/** Longest pause between two ticks of the tick-to-applied scenario, in milliseconds. */
const MAX_TICK_GAP_MS = 2;

/** Waits `ms` milliseconds a task at a time, so frames run whenever they are due meanwhile. */
async function pause(ms: number): Promise<void> {
	const until = performance.now() + ms;
	while (performance.now() < until) {
		await nextTask();
	}
}

/**
 * Ticks one at a time, each from the update call until the library has applied it (indicator
 * values included), with the series' indicators computed beforehand. A random pause of up to
 * `MAX_TICK_GAP_MS` separates ticks, so they arrive at random points of the frame cycle as ticks from
 * a socket would: a tick that arrives during a frame waits for it, and with ticks back to back the
 * share of ticks that do would depend on how fast the library is.
 */
async function runApply(job: ApplyJob, factory: AdapterFactory, container: HTMLElement): Promise<ApplyRun> {
	const data = generateSeries(job.dataset.kind, { seed: job.seed, count: job.dataset.size });
	const ticks = generateTicks(data, {
		seed: job.seed + 1,
		count: job.warmupTicks + job.ticks,
		newBarEvery: job.newBarEvery,
	});
	const adapter = await createSettled(factory, container, job.chart);
	if (adapter.applied === undefined) {
		throw new Error('This adapter cannot tell when an update is applied');
	}
	try {
		withIndicators(adapter, job.indicators);
		adapter.setData(prepare(adapter, data));
		await adapter.settle();
		const n = data.length;
		const visibleBars = job.view === 'all' ? n : Math.min(LATEST_VIEW_BARS, n);
		adapter.setVisibleLogicalRange({ from: n - visibleBars, to: n - 1 });
		await adapter.settle();

		const warmupStart = performance.now();
		let offset = 0;
		while (offset < job.warmupTicks) {
			adapter.applyTick(ticks, offset++);
			await adapter.applied();
			if (overBudget(warmupStart, job.warmupBudgetMs)) {
				break;
			}
		}
		await adapter.settle();

		const applied = new Float64Array(job.ticks);
		const sync = new Float64Array(job.ticks);
		const gaps = new Random(job.seed + 2);
		const measureStart = performance.now();
		let count = 0;
		while (count < job.ticks) {
			await pause(gaps.next() * MAX_TICK_GAP_MS);
			const t0 = performance.now();
			adapter.applyTick(ticks, offset + count);
			const t1 = performance.now();
			await adapter.applied();
			const t2 = performance.now();
			sync[count] = t1 - t0;
			applied[count] = t2 - t0;
			count++;
			if (count >= job.minTicks && overBudget(measureStart, job.budgetMs, t2)) {
				break;
			}
		}
		await adapter.settle();

		const update: number[] = [];
		const newBar: number[] = [];
		for (let i = 0; i < count; i++) {
			(ticks.tickKind[offset + i] === TICK_NEW_BAR ? newBar : update).push(applied[i] ?? 0);
		}
		return {
			applied: summarize(applied.subarray(0, count)),
			appliedUpdate: summarize(update),
			appliedNewBar: summarize(newBar),
			sync: summarize(sync.subarray(0, count)),
			visibleBars,
			warmupTicks: offset,
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

/**
 * `settle()` for several charts at once. Where the library says when a chart is idle, the charts
 * are awaited together and the frame's rendering once, as `settle()` of one chart does: awaiting
 * `settle()` of every chart would add a task or a frame wait per chart, and more of them for a
 * library that leaves some charts undrawn than for one that draws them all.
 */
async function settleAll(adapters: readonly ChartAdapter[]): Promise<void> {
	if (adapters.some(adapter => adapter.idle === undefined)) {
		await Promise.all(adapters.map(adapter => adapter.settle()));
		return;
	}
	for (;;) {
		await Promise.all(adapters.map(adapter => adapter.idle?.()));
		await nextTask();
		if (pendingFrameCallbacks() === 0) {
			return;
		}
		// A chart asked for another frame meanwhile.
		await afterNextFrame();
	}
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

/** A datafeed over a data set held by the page, like a server holds it, that can change as one does. */
class Source {
	public fetches = 0;
	public fetchedRows = 0;
	/** Values set at the source, by time. */
	public readonly corrected = new Map<number, number>();
	/** Times of bars removed at the source, as `[from, to]` pairs. */
	public readonly removed: number[] = [];
	public readonly data: LineColumns;

	public constructor(data: LineColumns) {
		this.data = data;
	}

	public readonly feed = (from: number, to: number): SeriesColumns => {
		const lo = lowerBound(this.data.time, from);
		const hi = lowerBound(this.data.time, to + 1);
		this.fetches++;
		let rows = sliceRows(this.data, lo, hi) as LineColumns;
		if (this.removed.length > 0 || this.corrected.size > 0) {
			const time: number[] = [];
			const value: number[] = [];
			for (let i = 0; i < rows.length; i++) {
				const t = rows.time[i]!;
				let gone = false;
				for (let r = 0; r < this.removed.length; r += 2) {
					gone ||= t >= this.removed[r]! && t <= this.removed[r + 1]!;
				}
				if (!gone) {
					time.push(t);
					value.push(this.corrected.get(t) ?? rows.value[i]!);
				}
			}
			rows = { kind: 'line', length: time.length, time: Float64Array.from(time), value: Float64Array.from(value) };
		}
		this.fetchedRows += rows.length;
		return rows;
	};
}

/** The same times with other values, for a second series. */
function shifted(data: LineColumns, from: number, scale: number): LineColumns {
	const time = data.time.subarray(from);
	const value = new Float64Array(time.length);
	for (let i = 0; i < time.length; i++) {
		value[i] = data.value[from + i]! * scale + 10;
	}
	return { kind: 'line', length: time.length, time, value };
}

/** Every `step`-th bar: a coarser resolution of the same history. */
function coarser(data: LineColumns, step: number): LineColumns {
	const length = Math.floor(data.length / step);
	const time = new Float64Array(length);
	const value = new Float64Array(length);
	for (let i = 0; i < length; i++) {
		time[i] = data.time[i * step]!;
		value[i] = data.value[i * step]!;
	}
	return { kind: 'line', length, time, value };
}

async function runRefetch(
	job: RefetchJob,
	factory: AdapterFactory,
	container: HTMLElement,
	probes: Probes,
): Promise<RefetchRun> {
	const data = generateSeries(job.dataset.kind, { seed: job.seed, count: job.dataset.size });
	if (data.kind !== 'line') {
		throw new Error('The refetch scenario runs on line points');
	}
	const several = job.variant === 'several';
	const main = new Source(data);
	const second = several ? new Source(shifted(data, 0, 0.5)) : null;
	const third = several ? shifted(data, Math.floor(data.length * 0.9), 2) : null;
	await probes.collectGarbage();
	const before = await probes.measureMemory();
	const adapter = await createSettled(factory, container, job.chart);
	try {
		if (adapter.setDataWithDatafeed === undefined) {
			throw new Error('This library cannot fetch history again from a datafeed');
		}
		adapter.setDataWithDatafeed(prepare(adapter, data), main.feed, job.memoryLimit);
		if (second !== null && third !== null) {
			if (adapter.addSeriesWithDatafeed === undefined) {
				throw new Error('This library cannot draw several series with datafeeds');
			}
			adapter.addSeriesWithDatafeed(prepare(adapter, second.data), second.feed);
			adapter.addSeriesWithDatafeed(prepare(adapter, third), null);
		}
		await adapter.settle();
		// Untimed: the library summarizes the history and lets rows go in the background.
		await delay(several ? 3000 : 1500);
		await adapter.settle();
		await probes.collectGarbage();
		const loaded = await probes.measureMemory();

		const n = data.length;
		const half = job.visibleBars / 2;
		const fetched = (): { fetches: number; rows: number } => ({
			fetches: main.fetches + (second?.fetches ?? 0),
			rows: main.fetchedRows + (second?.fetchedRows ?? 0),
		});
		// Regions spread over the oldest 90% of the history, far enough apart that no jump lands in
		// rows the previous one brought back.
		const step = Math.floor((n * 0.9) / (job.jumps + 1));
		interface Jump {
			shownMs: number;
			frames: number;
			fetches: number;
			fetchedRows: number;
		}
		const jump = async (index: number): Promise<Jump> => {
			const center = Math.floor(n * 0.02) + index * step;
			const f0 = fetched();
			const runs = libraryFrameRuns();
			const t0 = performance.now();
			adapter.setVisibleLogicalRange({ from: center - half, to: center + half - 1 });
			await adapter.settle();
			const shownMs = performance.now() - t0;
			const f1 = fetched();
			return {
				shownMs,
				frames: libraryFrameRuns() - runs,
				fetches: f1.fetches - f0.fetches,
				fetchedRows: f1.rows - f0.rows,
			};
		};
		const cold = await jump(0);
		const samples: Jump[] = [];
		const measureStart = performance.now();
		while (samples.length < job.jumps) {
			samples.push(await jump(samples.length + 1));
			if (samples.length >= job.minJumps && overBudget(measureStart, job.budgetMs)) {
				break;
			}
		}
		await probes.collectGarbage();
		const after = await probes.measureMemory();
		const operations = job.variant === 'ops' ? await runOperations(adapter, main, data, samples.length) : null;
		return {
			coldShownMs: cold.shownMs,
			shownMs: summarize(samples.map(sample => sample.shownMs)),
			shownFrames: summarize(samples.map(sample => sample.frames)),
			fetches: summarize(samples.map(sample => sample.fetches)),
			fetchedRows: summarize(samples.map(sample => sample.fetchedRows)),
			jumpsWithoutFetch: samples.filter(sample => sample.fetches === 0).length,
			visibleBars: job.visibleBars,
			memoryLimit: job.memoryLimit,
			rows: n,
			series: several ? 3 : 1,
			memoryAfterLoad: memoryResult(before, loaded),
			memory: memoryResult(before, after),
			operations,
		};
	} finally {
		adapter.destroy();
	}
}

/**
 * Corrections, deletions and a change of resolution on a series whose history was mostly let go,
 * each timed from the call until the chart has settled. The source changes first, as it would.
 */
async function runOperations(
	adapter: ChartAdapter,
	source: Source,
	data: LineColumns,
	jumps: number,
): Promise<RefetchOperations> {
	if (
		adapter.correctBar === undefined ||
		adapter.removeBars === undefined ||
		adapter.reloadWithDatafeed === undefined
	) {
		throw new Error('This library cannot correct or remove bars, or change resolution');
	}
	const n = data.length;
	const timed = async (action: () => void): Promise<number> => {
		const t0 = performance.now();
		action();
		await adapter.settle();
		return performance.now() - t0;
	};
	// The view is at the region of the last jump.
	const step = Math.floor((n * 0.9) / (jumps + 1));
	const inView = Math.floor(n * 0.02) + jumps * step;
	const held: number[] = [];
	const letGo: number[] = [];
	for (let k = 0; k < 5; k++) {
		const heldAt = inView - 500 + k * 200;
		const heldTime = data.time[heldAt]!;
		source.corrected.set(heldTime, 1);
		held.push(await timed(() => adapter.correctBar!(heldTime, 1)));
		// Far from the view: history let go.
		const far = Math.floor(n * (0.07 + k * 0.17));
		const farTime = data.time[far]!;
		source.corrected.set(farTime, 2);
		letGo.push(await timed(() => adapter.correctBar!(farTime, 2)));
	}
	const removes: number[] = [];
	for (const at of [0.15, 0.5, 0.8]) {
		const index = Math.floor(n * at);
		const from = data.time[index]!;
		const to = data.time[index + 9]!;
		source.removed.push(from, to);
		removes.push(await timed(() => adapter.removeBars!(from, to)));
	}
	// Five-minute bars from a datafeed that serves them.
	const five = new Source(coarser(data, 5));
	const prepared = adapter.prepareLine(five.data);
	const fetchesBefore = source.fetches;
	const resolutionMs = await timed(() => adapter.reloadWithDatafeed!(prepared, five.feed));
	await delay(500);
	await adapter.settle();
	return {
		correctHeldMs: summarize(held),
		correctLetGoMs: summarize(letGo),
		removeMs: summarize(removes),
		resolutionMs,
		staleFetches: source.fetches - fetchesBefore,
	};
}

/** Path of the pointer over the pane at step `k`: two sines of different periods, so it sweeps the pane. */
function pathPoint(k: number, rect: DOMRect, out: { x: number; y: number }): void {
	// The pane is the chart without its axes, which take the right and bottom edge.
	out.x = rect.left + rect.width * (0.45 + 0.4 * Math.sin((2 * Math.PI * k) / 97));
	out.y = rect.top + rect.height * (0.45 + 0.4 * Math.sin((2 * Math.PI * k) / 61));
}

function pointerEvent(type: string, x: number, y: number, pressed: boolean): PointerEvent {
	return new PointerEvent(type, {
		clientX: x,
		clientY: y,
		pointerId: 1,
		pointerType: 'mouse',
		isPrimary: true,
		button: type === 'pointermove' ? -1 : 0,
		buttons: pressed ? 1 : 0,
		bubbles: true,
		cancelable: true,
	});
}

/**
 * Drawings on a 1M-candle chart, one step per animation frame: the pointer hovering along a path
 * (the stage 4 gate), dragging a drawing along it, or a pan. Frame JavaScript time includes the
 * pointer event, which the harness dispatches in a timed frame callback, and the chart's draw for
 * it. For hovers, the library's public hit test is then timed alone at every position of the path.
 */
async function runDrawings(job: DrawingsJob, factory: AdapterFactory, container: HTMLElement): Promise<DrawingsRun> {
	const data = generateSeries('candles', { seed: job.seed, count: job.dataset.size }) as CandleColumns;
	const adapter = await createSettled(factory, container, job.chart);
	const { addDrawings, pointerTarget, hitTestDrawing } = adapter;
	if (addDrawings === undefined || pointerTarget === undefined || hitTestDrawing === undefined) {
		throw new Error('This adapter has no drawings');
	}
	try {
		adapter.setData(prepare(adapter, data));
		await adapter.settle();
		const n = data.length;
		const visibleBars = Math.min(job.visibleBars, n);
		const view = { from: n - visibleBars, to: n - 1 };
		adapter.setVisibleLogicalRange(view);
		await adapter.settle();
		const drawings = generateDrawings(data, job.drawings, view.from, view.to, job.seed + 3);
		addDrawings.call(adapter, drawings);
		await adapter.settle();

		const target = pointerTarget.call(adapter);
		// Read once, before measuring: the page does not scroll during the run.
		const rect = target.getBoundingClientRect();
		const point = { x: 0, y: 0 };
		const steps = job.warmupFrames + job.frames + 2;
		const ranges = job.variant === 'pan' ? motionRanges('pan', n, visibleBars, steps, 1) : [];
		// A drag starts on a drawing in view: the first point of the path where the hit test finds one.
		let pressAt = 0;
		if (job.variant === 'drag') {
			while (pressAt < 2000) {
				pathPoint(pressAt, rect, point);
				if (hitTestDrawing.call(adapter, point.x - rect.left, point.y - rect.top)) {
					break;
				}
				pressAt++;
			}
			if (pressAt === 2000) {
				throw new Error('No drawing on the path to drag');
			}
			target.dispatchEvent(pointerEvent('pointerdown', point.x, point.y, true));
			await adapter.settle();
		}
		const step = (k: number): void => {
			if (job.variant === 'pan') {
				adapter.setVisibleLogicalRange(ranges[k] ?? view);
				return;
			}
			pathPoint(pressAt + k, rect, point);
			target.dispatchEvent(pointerEvent('pointermove', point.x, point.y, job.variant === 'drag'));
		};
		step(0);
		await adapter.settle();

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
						const measured = frame + 1 - first;
						if (measured >= job.frames || (measured >= job.minFrames && overBudget(measureStart, job.budgetMs, now))) {
							last = frame + 1;
						}
					} else if (frame === last) {
						resolve();
						return;
					}
					try {
						step(frame + 1);
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
		if (job.variant === 'drag') {
			target.dispatchEvent(pointerEvent('pointerup', point.x, point.y, false));
			await adapter.settle();
		}
		if (recording.timestamps.length < last) {
			throw new Error(`Recorded ${recording.timestamps.length} frames, expected at least ${last}`);
		}
		const frameJs: number[] = [];
		const interval: number[] = [];
		for (let k = first; k < last; k++) {
			frameJs.push(recording.jsTime[k] ?? 0);
			interval.push((recording.timestamps[k] ?? 0) - (recording.timestamps[k - 1] ?? 0));
		}

		let hitTest: DrawingsRun['hitTest'] = null;
		let hitTestMean: number | null = null;
		let redraw: DrawingsRun['redraw'] = null;
		let hits: number | null = null;
		if (job.variant === 'hover') {
			// Frame k drew the hover of step k: the same positions, hit-tested alone.
			const single: number[] = [];
			const rest: number[] = [];
			hits = 0;
			for (let k = first; k < last; k++) {
				pathPoint(k, rect, point);
				const x = point.x - rect.left;
				const y = point.y - rect.top;
				const t0 = performance.now();
				const hit = hitTestDrawing.call(adapter, x, y);
				const time = performance.now() - t0;
				single.push(time);
				rest.push(Math.max(0, (recording.jsTime[k] ?? 0) - time));
				if (hit) {
					hits++;
				}
			}
			const passes = 20;
			const t0 = performance.now();
			for (let pass = 0; pass < passes; pass++) {
				for (let k = first; k < last; k++) {
					pathPoint(k, rect, point);
					hitTestDrawing.call(adapter, point.x - rect.left, point.y - rect.top);
				}
			}
			hitTestMean = (performance.now() - t0) / (passes * (last - first));
			hitTest = summarize(single);
			redraw = summarize(rest);
		}
		return {
			frameJs: summarize(frameJs),
			hitTest,
			hitTestMean,
			redraw,
			hits,
			interval: summarize(interval),
			frames: last - first,
			warmupFrames: first - 1,
			drawings: drawings.length,
			drawingsInView: drawings.filter(drawing => drawing.inView).length,
			visibleBars,
		};
	} finally {
		adapter.destroy();
	}
}
