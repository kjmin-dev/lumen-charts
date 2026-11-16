// Jobs the harness page runs, their results, and the default benchmark matrix.
// Shared by the page and the Node runner, so this module must stay free of DOM and Node APIs.

import type { ChartSize } from './adapter.ts';
import type { SeriesKind } from './data.ts';
import type { Distribution } from './stats.ts';

export type ScenarioName =
	| 'load'
	| 'tick'
	| 'frames'
	| 'prepend'
	| 'refetch'
	| 'multi'
	| 'ind-load'
	| 'ind-apply'
	| 'ind-frames'
	| 'ind-prepend'
	| 'axes-frames'
	| 'drawings'
	| 'state'
	| 'tz-frames'
	| 'tz-change';
export const SCENARIOS: readonly ScenarioName[] = [
	'load',
	'tick',
	'frames',
	'prepend',
	'refetch',
	'multi',
	'ind-load',
	'ind-apply',
	'ind-frames',
	'ind-prepend',
	'axes-frames',
	'drawings',
	'state',
	'tz-frames',
	'tz-change',
];
/** The stage 3 scenarios: the ones above with indicators on the series. */
export const INDICATOR_SCENARIOS: readonly ScenarioName[] = ['ind-load', 'ind-apply', 'ind-frames', 'ind-prepend'];
/** The stage 4 scenarios: drawings on the chart. */
export const DRAWING_SCENARIOS: readonly ScenarioName[] = ['drawings'];
/** The stage 4 scenario of saving and restoring the state of a chart. */
export const STATE_SCENARIOS: readonly ScenarioName[] = ['state'];
/** The stage 4 scenarios of time zones and sessions. */
export const TIME_ZONE_SCENARIOS: readonly ScenarioName[] = ['tz-frames', 'tz-change'];

export interface DatasetSpec {
	readonly kind: SeriesKind;
	readonly size: number;
}

interface JobBase {
	/** Adapter id from the registry. */
	readonly adapter: string;
	readonly dataset: DatasetSpec;
	/** Seed of the data set. Ticks use `seed + 1`. */
	readonly seed: number;
	readonly chart: ChartSize;
}

/** Cold load, then warm load and memory of the same data set in the same page. */
export interface LoadJob extends JobBase {
	readonly scenario: 'load';
}

/** Which bars are in view while ticks arrive. */
export type TickView = 'latest' | 'all';

export interface TickJob extends JobBase {
	readonly scenario: 'tick';
	/** `latest`: the last 200 bars; `all`: every bar. */
	readonly view: TickView;
	/** Measured ticks: the most a run measures. */
	readonly ticks: number;
	/**
	 * Measuring stops after the first round that ends `budgetMs` or later after measuring started,
	 * once at least `minTicks` ticks are measured. A budget of 0 always measures `ticks`.
	 */
	readonly minTicks: number;
	readonly budgetMs: number;
	/** Ticks applied before measuring, taken from the same stream: the most a run applies. */
	readonly warmupTicks: number;
	/** Warm-up stops after the first round that ends this long after it started. 0: no limit. */
	readonly warmupBudgetMs: number;
	/** Ticks applied back to back between two `settle()` calls. */
	readonly roundSize: number;
	/** Every Nth tick starts a new bar. */
	readonly newBarEvery: number;
}

export type Motion = 'pan' | 'zoom';
/** Number of bars in view, or `all` for every bar of the data set. */
export type ZoomLevel = number | 'all';

export interface FramesJob extends JobBase {
	readonly scenario: 'frames';
	readonly zoom: ZoomLevel;
	readonly motion: Motion;
	/** Measured frames: the most a run measures. */
	readonly frames: number;
	/**
	 * Measuring stops after the first frame that starts `budgetMs` or later after measuring started,
	 * once at least `minFrames` frames are measured. A budget of 0 always measures `frames`.
	 */
	readonly minFrames: number;
	readonly budgetMs: number;
	/** Frames dropped before measuring: the most a run drops. */
	readonly warmupFrames: number;
	/** Warm-up stops after the first frame that starts this long after it started (at least 3 frames). 0: no limit. */
	readonly warmupBudgetMs: number;
}

/**
 * Older history added before the first bar while the view shows that first bar in its middle, so
 * every prepended batch fills the empty left half of the view. Batch `r` is generated older than
 * the series' current first bar; prepends follow each other like pages of history loaded while
 * the user keeps scrolling back.
 */
export interface PrependJob extends JobBase {
	readonly scenario: 'prepend';
	/** Rows per prepend. */
	readonly batch: number;
	/**
	 * Bars in view while prepending: twice the batch, so the batch fills the left half, but at most
	 * the base data set.
	 */
	readonly visibleBars: number;
	/** Measured prepends: the most a run measures. One more, unmeasured, comes first (`cold`). */
	readonly prepends: number;
	/**
	 * Measuring stops after the first prepend that ends `budgetMs` or later after measuring started,
	 * once at least `minPrepends` prepends are measured. A budget of 0 always measures `prepends`.
	 */
	readonly minPrepends: number;
	readonly budgetMs: number;
}

/**
 * What a refetch case runs. `jumps`: one series with a datafeed, and the jumps. `several`: the same
 * series, a second one with a datafeed on the same times and a third without one over the last
 * tenth of them, and the jumps. `ops`: one series with a datafeed, a few jumps, then timed
 * corrections, deletions and a change of resolution.
 */
export type RefetchVariant = 'jumps' | 'several' | 'ops';

/**
 * A series with a datafeed under a memory limit, for libraries that can fetch history again. Once
 * the library has let rows go, the view jumps from one region of old history to the next at a
 * zoom that shows single bars, so a jump that lands on rows let go makes the library fetch them
 * from the datafeed. The datafeed is in the page and answers at once, so the latency is the
 * library's own.
 */
export interface RefetchJob extends JobBase {
	readonly scenario: 'refetch';
	readonly variant: RefetchVariant;
	/** Memory limit handed to the library, in bytes. */
	readonly memoryLimit: number;
	/** Bars in view at every jump. */
	readonly visibleBars: number;
	/** Measured jumps: the most a run measures. One more, unmeasured, comes first (`coldShownMs`). */
	readonly jumps: number;
	/**
	 * Measuring stops after the first jump that ends `budgetMs` or later after measuring started,
	 * once at least `minJumps` jumps are measured. A budget of 0 always measures `jumps`.
	 */
	readonly minJumps: number;
	readonly budgetMs: number;
}

/**
 * Several charts on one page, as a dashboard has them: `charts` charts in a grid of `columns`
 * columns, each filling its cell (the library's auto-size mode) and holding the data set in a
 * series of its own. The cells are sized so that the first `visibleCharts` charts fill the
 * viewport and the others are below the fold, out of view. The charts are created and loaded in
 * one loop, and then every chart receives the same live ticks, round after round.
 */
export interface MultiJob extends JobBase {
	readonly scenario: 'multi';
	readonly charts: number;
	readonly visibleCharts: number;
	readonly columns: number;
	/** Measured rounds: the most a run measures. A round is one tick to every chart, then `settle()` of all. */
	readonly rounds: number;
	/**
	 * Measuring stops after the first round that ends `budgetMs` or later after measuring started,
	 * once at least `minRounds` rounds are measured. A budget of 0 always measures `rounds`.
	 */
	readonly minRounds: number;
	readonly budgetMs: number;
	/** Rounds applied before measuring, taken from the same stream: the most a run applies. */
	readonly warmupRounds: number;
	/** Warm-up stops after the first round that ends this long after it started. 0: no limit. */
	readonly warmupBudgetMs: number;
	/** Every Nth tick starts a new bar. */
	readonly newBarEvery: number;
	/**
	 * Most workers the library shares between its charts, for libraries with such a limit (lumen's
	 * `setMaxWorkers`); null leaves the library's default.
	 */
	readonly maxWorkers: number | null;
}

/**
 * The stage 3 scenarios run the load, frames and prepend scenarios with the first `indicators` of
 * the indicator set (`INDICATOR_SET`) on the candles. Their times include the indicators: a load or
 * prepend is settled once every indicator is computed and drawn.
 */
export interface IndicatorLoadJob extends Omit<LoadJob, 'scenario'> {
	readonly scenario: 'ind-load';
	readonly indicators: number;
}

export interface IndicatorFramesJob extends Omit<FramesJob, 'scenario'> {
	readonly scenario: 'ind-frames';
	readonly indicators: number;
}

export interface IndicatorPrependJob extends Omit<PrependJob, 'scenario'> {
	readonly scenario: 'ind-prepend';
	readonly indicators: number;
}

/**
 * Tick to applied patch: ticks one at a time, each timed from the update call until the library
 * has applied it, indicator values included (for lumen: the engine's answer has been applied on
 * the main thread; for a library that applies updates synchronously: the call itself). Ticks are
 * separated by random pauses of up to 2 ms, so they arrive at random points of the frame cycle, as
 * ticks from a socket would, and frames run whenever they are due.
 */
export interface ApplyJob extends JobBase {
	readonly scenario: 'ind-apply';
	readonly indicators: number;
	readonly view: TickView;
	/** Measured ticks: the most a run measures. */
	readonly ticks: number;
	/** Measuring stops after `budgetMs` once at least `minTicks` ticks are measured; 0 measures all. */
	readonly minTicks: number;
	readonly budgetMs: number;
	readonly warmupTicks: number;
	readonly warmupBudgetMs: number;
	/** Every Nth tick starts a new bar. */
	readonly newBarEvery: number;
}

/**
 * How the stage 4 price axes scenario lays out its series, candles and three moving averages (the
 * first three of the indicator set): all on one normal scale (`one`, the reference), the same on a
 * logarithmic (`log`) or a percentage scale (`percent`), or each average on an axis of its own, two
 * left of the pane and one right of the candles' axis (`four`).
 */
export type PriceAxesLayout = 'one' | 'log' | 'percent' | 'four';
export const PRICE_AXES_LAYOUTS: readonly PriceAxesLayout[] = ['one', 'log', 'percent', 'four'];

/** Pan and zoom frames with the series on price axes laid out as `axes` says. */
export interface AxesFramesJob extends Omit<FramesJob, 'scenario'> {
	readonly scenario: 'axes-frames';
	readonly indicators: number;
	readonly axes: PriceAxesLayout;
}

/**
 * What a drawings case does, one step per frame with `drawings` drawings on the chart (see
 * `generateDrawings`): `hover` moves the pointer over the pane along a fixed path, `drag` drags one
 * drawing in view along the same path, `pan` pans as the frames scenario does.
 */
export type DrawingsVariant = 'hover' | 'drag' | 'pan';

/**
 * The stage 4 gate: with 1,000 drawings, hover handling p99 within 1 ms (design section 9). Half the
 * drawings are in view and half in older history; the pointer moves once per frame.
 */
export interface DrawingsJob extends JobBase {
	readonly scenario: 'drawings';
	readonly variant: DrawingsVariant;
	readonly drawings: number;
	/** Bars in view: the last ones of the data set. */
	readonly visibleBars: number;
	/** Measured frames: the most a run measures. */
	readonly frames: number;
	readonly minFrames: number;
	readonly budgetMs: number;
	readonly warmupFrames: number;
	readonly warmupBudgetMs: number;
}

/**
 * The frames scenario with the chart in a time zone and with a session schedule (stage 4): the
 * time axis follows the wall clock of `timeZone`, and with `sessions` the chart has the extended
 * hours of a New York equity exchange (pre-market from 04:00, regular hours 09:30 to 16:00,
 * post-market to 20:00, Monday to Friday) with breaks drawn and extended hours shaded.
 */
export interface TimeZoneFramesJob extends Omit<FramesJob, 'scenario'> {
	readonly scenario: 'tz-frames';
	readonly timeZone: string;
	readonly sessions: boolean;
}

/**
 * Saving the state of a chart and restoring it, with the data set loaded, `indicators` indicators
 * on its series and `drawings` drawings on it (see `generateDrawings`), `rounds` times each: saving,
 * turning the state into JSON and back, restoring it into the chart it was saved from, and restoring
 * it into a chart emptied before each round, which has to make the series and indicators again.
 */
export interface StateJob extends JobBase {
	readonly scenario: 'state';
	readonly drawings: number;
	readonly indicators: number;
	/** Bars in view: the last ones of the data set. */
	readonly visibleBars: number;
	readonly rounds: number;
}

/**
 * Changes of the time zone at run time, with the data set loaded and `zoom` bars in view: first to
 * each of `zones` once (the first change to a zone in a page builds its table of offsets), then
 * `changes` more through all of them, then `changes` changes of an option that has nothing to do
 * with time (the text color), which cost a redraw like any change of options.
 */
export interface ZoneChangeJob extends JobBase {
	readonly scenario: 'tz-change';
	readonly zoom: ZoomLevel;
	readonly zones: readonly string[];
	readonly changes: number;
}

export type Job =
	| LoadJob
	| TickJob
	| FramesJob
	| PrependJob
	| RefetchJob
	| IndicatorLoadJob
	| ApplyJob
	| IndicatorFramesJob
	| IndicatorPrependJob
	| AxesFramesJob
	| MultiJob
	| DrawingsJob
	| StateJob
	| TimeZoneFramesJob
	| ZoneChangeJob;

/** All times start when `setData` is called, except `convertMs` and the `*WithConversionMs` sums. */
export interface LoadTimings {
	/** Converting columns to the library's input format (`prepare*`). */
	convertMs: number;
	/** The synchronous `setData` call. */
	setDataMs: number;
	/**
	 * Until the main thread has finished the first frame in which the library ran an animation-frame
	 * callback after `setData`: the first painted frame. This is the load time.
	 */
	firstFrameMs: number;
	/** convertMs + firstFrameMs. */
	firstFrameWithConversionMs: number;
	/** Until `settle()` resolves: every follow-up draw (layout passes, for example) is done too. */
	settledMs: number;
	/** JavaScript time in animation-frame callbacks between `setData` and settling. */
	frameJsMs: number;
}

/** Memory in use by one JavaScript heap, or by several summed. */
export interface HeapUsage {
	/** V8 heap in use (JavaScript objects). */
	jsHeapBytes: number;
	/** ArrayBuffer backing stores and external strings, or null when the method cannot see them. */
	backingStoreBytes: number | null;
	/** Blink's heap (DOM and other embedder objects), or null when the method cannot see it. */
	embedderHeapBytes: number | null;
	/** Sum of the parts above that are known. */
	totalBytes: number;
}

/** The page's dedicated workers, summed. Each worker has a heap of its own. */
export interface WorkerHeapUsage extends HeapUsage {
	/** Number of workers measured. */
	count: number;
}

/**
 * Memory in use. The `HeapUsage` fields describe the page's main thread, as in every results file;
 * `workers` adds the page's dedicated workers (results before schema 2 have no workers).
 */
export interface MemorySample extends HeapUsage {
	/** How the numbers were obtained. */
	method: string;
	/** The page's dedicated workers, or null when the method cannot see them. */
	workers: WorkerHeapUsage | null;
	/** Page and workers together: totalBytes + workers.totalBytes (the page alone without workers). */
	allTotalBytes: number;
}

export interface MemoryResult {
	/** Before the measured chart is created, data already generated, after a full GC. */
	before: MemorySample;
	/** After the measured work has settled, after a full GC. */
	after: MemorySample;
	/**
	 * after.allTotalBytes - before.allTotalBytes: what the chart retains in the page and its workers.
	 * Before schema 2 this was the page alone, which missed an engine running in a worker.
	 */
	retainedBytes: number;
	/** after.totalBytes - before.totalBytes: the page's main thread alone. */
	retainedPageBytes: number;
	/** Same for the workers' total, or null when they cannot be measured. */
	retainedWorkerBytes: number | null;
	/** after.jsHeapBytes - before.jsHeapBytes (page). */
	retainedJsHeapBytes: number;
	/** Same for the page's backing stores, or null when the method cannot see them. */
	retainedBackingStoreBytes: number | null;
	/** Same for the page's embedder heap, or null when the method cannot see it. */
	retainedEmbedderHeapBytes: number | null;
}

export interface LoadRun {
	/** Generating the data set in the page (not part of any load time). */
	generateMs: number;
	/** First load in a fresh page: includes compiling the library's code. */
	cold: LoadTimings;
	/** Second load of the same data set in the same page, into a new chart. */
	warm: LoadTimings;
	memory: MemoryResult | null;
}

export interface TickRun {
	/** Duration of each `applyTick` call, all measured ticks. */
	sync: Distribution;
	/** Same, ticks that modify the last bar only. */
	syncUpdate: Distribution;
	/** Same, ticks that start a new bar only. */
	syncNewBar: Distribution;
	/** Mean per-tick sync cost of each round (round sync time / round size). */
	syncPerRound: Distribution;
	/**
	 * Wall time from the end of each round's last update call until `settle()` resolves: the latency
	 * until the round is painted. Includes waiting for the next frame (up to one refresh interval).
	 */
	settle: Distribution;
	/** JavaScript time in animation-frame callbacks during each round's `settle()`: the paint work. */
	settleJs: Distribution;
	/**
	 * Main-thread JavaScript per tick including the paint it causes, per round:
	 * (round sync time + round settleJs) / round size. Excludes idle time and work off the main thread.
	 */
	mainThreadPerTick: Distribution;
	/** Visible bars when measuring started. */
	visibleBars: number;
	/** Warm-up ticks applied (fewer than the job's when its warm-up budget ran out). */
	warmupTicks: number;
}

export interface FramesRun {
	/** JavaScript time spent in animation-frame callbacks, per frame. */
	jsTime: Distribution;
	/** Interval between consecutive frames' rAF timestamps. */
	interval: Distribution;
	/** Frames in which the library ran at least one animation-frame callback (expected: all). */
	framesWithLibraryWork: number;
	/** Visible bars at the start of the motion. */
	visibleBars: number;
	/** Warm-up frames dropped (fewer than the job's when its warm-up budget ran out). */
	warmupFrames: number;
	/**
	 * Canvas 2D calls in one redraw at the starting range, counted in a separate untimed pass after
	 * the measurement (the counting wrappers would slow the measured frames down). Shows how much the
	 * library draws, for example whether conflation merged bars. Empty for libraries that do not
	 * draw with Canvas 2D.
	 */
	drawCalls: Record<string, number>;
}

/** One prepend. All times start when `prepend` is called, except `prepareMs`. */
export interface PrependTimings {
	/** Building the batch in the library's input format (`preparePrepend`), before the call. */
	prepareMs: number;
	/** The synchronous `prepend` call. */
	callMs: number;
	/**
	 * Until the main thread has finished the first frame in which the library ran an animation-frame
	 * callback after the call. That frame does not necessarily show the new bars yet.
	 */
	firstFrameMs: number;
	/**
	 * Until `settle()`, called right after `prepend`, resolves: the bars are applied and the main
	 * thread has finished rendering the frame that shows them. This is the prepend-to-screen latency.
	 */
	shownMs: number;
	/** JavaScript time in animation-frame callbacks between the call and `shownMs`. */
	frameJsMs: number;
	/**
	 * Longest gap between the call, every frame that began before `shownMs`, and `shownMs`: how long
	 * the screen could not be updated (about one refresh interval when nothing blocks).
	 */
	longestFrameMs: number;
}

export interface PrependRun {
	/** The first prepend of the run, with code paths not yet compiled. Not part of the distributions. */
	cold: PrependTimings;
	/** Each field of `PrependTimings` over the measured prepends. */
	prepareMs: Distribution;
	callMs: Distribution;
	firstFrameMs: Distribution;
	shownMs: Distribution;
	frameJsMs: Distribution;
	longestFrameMs: Distribution;
	/** Bars in view while prepending. */
	visibleBars: number;
	/** Rows of the series after the last prepend: the base, the cold batch and the measured ones. */
	finalRows: number;
	/**
	 * Canvas 2D calls in one redraw, counted in untimed passes after the measurement: `shown` with
	 * the last batch in the left half of the view, `leftEmpty` at the new left edge with the left
	 * half empty. Shows that the prepended bars are drawn; empty for libraries without Canvas 2D.
	 */
	drawCalls: { shown: Record<string, number>; leftEmpty: Record<string, number> };
	/** Before the chart is created and after the last prepend: what the history and caches hold. */
	memory: MemoryResult | null;
}

/** Operations on history let go, each timed from the call until `settle()` resolves. */
export interface RefetchOperations {
	/** Correcting a bar in view, which is in memory. */
	correctHeldMs: Distribution;
	/** Correcting a bar far from the view, which was let go: its bars are fetched again first. */
	correctLetGoMs: Distribution;
	/** Removing 10 bars in the middle of history let go, which moves the bars on one side. */
	removeMs: Distribution;
	/** Switching to 5-minute bars: a new history of a fifth of the bars, with a datafeed for them. */
	resolutionMs: number;
	/** Calls of the old datafeed after the switch (none expected). */
	staleFetches: number;
}

export interface RefetchRun {
	/** The first jump, with code paths not yet compiled. Not part of the distributions. */
	coldShownMs: number;
	/** From `setVisibleLogicalRange` until `settle()` resolves with the region drawn. */
	shownMs: Distribution;
	/** Animation frames the library ran during a jump, up to the one that shows the region. */
	shownFrames: Distribution;
	/** Datafeed calls during one jump. */
	fetches: Distribution;
	/** Rows the datafeed returned during one jump. */
	fetchedRows: Distribution;
	/** Measured jumps that needed no fetch: their rows were still in memory. */
	jumpsWithoutFetch: number;
	visibleBars: number;
	memoryLimit: number;
	rows: number;
	/** Series on the chart. */
	series: number;
	/** Before the chart is created and once the library has let rows go, before the first jump. */
	memoryAfterLoad: MemoryResult | null;
	/** Before the chart is created and after the last jump. */
	memory: MemoryResult | null;
	/** The `ops` variant only. */
	operations: RefetchOperations | null;
}

/**
 * Time the page's main thread spent, from the browser's own counters (CDP `Performance.getMetrics`).
 * Unlike the frame probe it counts everything: message and observer callbacks, layout and style.
 */
export interface MainThreadTimes {
	/** All tasks of the main thread. */
	taskMs: number;
	/** JavaScript, wherever it ran. */
	scriptMs: number;
	/** Layout, including layouts forced by a script reading the layout. */
	layoutMs: number;
	/** Style recalculation. */
	styleMs: number;
}

export interface MultiRun {
	charts: number;
	visibleCharts: number;
	/** CSS size of one chart. */
	cell: ChartSize;
	/** Generating the data set and the ticks in the page (not part of any time below). */
	generateMs: number;
	/**
	 * The loop that creates every chart and hands each its data: `create` and `setData` per chart.
	 * Synchronous time on the main thread, including any layout the library forces.
	 */
	createMs: number;
	/**
	 * From the start of that loop until every chart has settled with its data: the first paint of
	 * all charts.
	 */
	shownMs: number;
	/** JavaScript time in animation-frame callbacks during `shownMs`. */
	shownFrameJsMs: number;
	/** Main-thread time during `shownMs`, or null without the runner. */
	shownMainThread: MainThreadTimes | null;
	/**
	 * Before the charts are created (data already generated) and after they are loaded and the
	 * library's background work has had a second to finish, each after a full GC. `after.workers.count`
	 * is the number of workers the charts run in.
	 */
	memory: MemoryResult | null;
	/** Dedicated workers of the page once the charts are loaded, or null when they cannot be counted. */
	workers: number | null;
	/**
	 * Resident memory of the browser's renderer processes at the two points `memory` is measured, and
	 * the growth between them, or null without the runner. Unlike the heaps it includes what a thread
	 * costs outside any heap (its stack, the engine's own structures, compiled code) and the
	 * canvases' bitmaps that live in the renderer; it is coarser, since memory a collection frees is
	 * not always given back to the system at once.
	 */
	rendererResident: { beforeBytes: number; afterBytes: number; retainedBytes: number } | null;
	/** Sum of the `applyTick` calls of a round divided by the number of charts. */
	sync: Distribution;
	/** Wall time from the last `applyTick` of a round until every chart has settled. */
	settle: Distribution;
	/** JavaScript time in animation-frame callbacks during each round: what the frame costs. */
	frameJs: Distribution;
	/** Animation-frame callbacks the library ran during each round. */
	frameCallbacks: Distribution;
	/**
	 * Main-thread JavaScript per tick that the page can time, per round: (the round's `applyTick`
	 * calls + its animation-frame callbacks) / charts. Leaves out the callbacks that receive the
	 * engine's answers; `tickMainThread` has those.
	 */
	mainThreadPerTick: Distribution;
	/**
	 * Main-thread time per measured round over the whole measured phase, from the browser's counters:
	 * everything the round costs, including the harness's own loop. Null without the runner.
	 */
	tickMainThread: MainThreadTimes | null;
	/** Rounds measured. */
	rounds: number;
	/** Warm-up rounds applied (fewer than the job's when its warm-up budget ran out). */
	warmupRounds: number;
	/**
	 * JavaScript time in animation-frame callbacks while the charts below the fold are scrolled into
	 * view after the last round and settle: the draws a library put off while they were out of view.
	 */
	revealFrameJsMs: number;
}

export interface ApplyRun {
	/** From the update call until the tick is applied, indicator values included, all measured ticks. */
	applied: Distribution;
	/** Same, ticks that modify the last bar only. */
	appliedUpdate: Distribution;
	/** Same, ticks that start a new bar only. */
	appliedNewBar: Distribution;
	/** The synchronous update call alone. */
	sync: Distribution;
	visibleBars: number;
	warmupTicks: number;
}

export interface DrawingsRun {
	/**
	 * JavaScript time of each frame: the pointer event (`hover`, `drag`) or the view change (`pan`),
	 * and the chart's work for it in the animation frame: hit testing and the overlay for a hover,
	 * the edited drawing for a drag, every layer for a pan.
	 */
	frameJs: Distribution;
	/**
	 * `hover` only: one hit test at each position of the path through the library's public hit test,
	 * timed alone after the frames, on the same drawings and view. This is the hit test the hover
	 * does.
	 */
	hitTest: Distribution | null;
	/** `hover` only: mean of a hit test over 20 passes of the whole path, which timer resolution does not limit. */
	hitTestMean: number | null;
	/**
	 * `hover` only: the frame's time minus the hit test at its position: the overlay redraw and the
	 * rest of the frame (pointer event, layout read).
	 */
	redraw: Distribution | null;
	/** `hover` only: positions of the path where a drawing was hit. */
	hits: number | null;
	interval: Distribution;
	frames: number;
	warmupFrames: number;
	drawings: number;
	/** Drawings whose time range overlaps the view at the start. */
	drawingsInView: number;
	visibleBars: number;
}

/** Each change timed from the `applyOptions` call until `settle()` resolves with it drawn. */
export interface ZoneChangeTimings {
	/** The synchronous call. */
	callMs: Distribution;
	/** JavaScript in animation-frame callbacks until settled: the redraw. */
	frameJsMs: Distribution;
	/** callMs + frameJsMs: the main thread's work for the change. */
	workMs: Distribution;
	/** Wall time until settled, which includes waiting for the next frame. */
	shownMs: Distribution;
}

export interface StateRun {
	/** One `saveState` call, in milliseconds (each sample is the mean of ten calls). */
	saveMs: Distribution;
	/** `JSON.stringify` of the state, and `JSON.parse` of that. */
	stringifyMs: Distribution;
	parseMs: Distribution;
	/** Length of the JSON in characters. */
	jsonLength: number;
	/**
	 * Restoring the parsed state into the chart it was saved from: the series and indicators are
	 * kept, the drawings replaced. Timed from the call until it is drawn.
	 */
	restore: ZoneChangeTimings;
	/**
	 * Restoring it into the chart after its series, indicators and drawings were removed: they are
	 * all made again, the series without bars.
	 */
	restoreEmpty: ZoneChangeTimings;
	/** Frames the library drew for one restore into the chart it was saved from. */
	restoreFrames: Distribution;
	drawings: number;
	indicators: number;
	visibleBars: number;
}

export interface ZoneChangeRun {
	/** The first change to each zone in the page, which builds its table. */
	cold: ZoneChangeTimings;
	/** Later changes, between zones whose tables exist. */
	warm: ZoneChangeTimings;
	/** Changes of the text color: what any change of options costs. */
	baseline: ZoneChangeTimings;
	visibleBars: number;
}

export type RunResult =
	| LoadRun
	| TickRun
	| FramesRun
	| PrependRun
	| RefetchRun
	| ApplyRun
	| MultiRun
	| DrawingsRun
	| StateRun
	| ZoneChangeRun;

export type FailureReason = 'error' | 'timeout' | 'crash';

/** How busy the machine was during a run, measured by the runner. */
export interface HostLoad {
	/** Share of all cores' time that was idle during the run (0 to 1), including the browser's own use. */
	cpuIdle: number;
	/** One-minute load average at the end of the run. */
	loadAverage: number;
}

export type RunOutcome =
	| { readonly status: 'ok'; readonly result: RunResult; readonly durationMs: number; readonly host?: HostLoad }
	| {
			readonly status: 'failed';
			readonly reason: FailureReason;
			readonly message: string;
			readonly durationMs: number;
			readonly host?: HostLoad;
	  };

/** Library and options reported by an adapter. */
export interface AdapterInfo {
	library: { name: string; version: string };
	options: Record<string, unknown>;
}

/** What `bench.run` returns from the page. */
export type PageRunResult =
	| { readonly status: 'ok'; readonly adapter: AdapterInfo; readonly result: RunResult }
	| { readonly status: 'failed'; readonly adapter: AdapterInfo | null; readonly message: string };

// Matrix -------------------------------------------------------------------------------------------

export const K = 1_000;
export const M = 1_000_000;

export function sizeLabel(size: number): string {
	if (size >= M && size % M === 0) {
		return `${size / M}m`;
	}
	if (size >= K && size % K === 0) {
		return `${size / K}k`;
	}
	return String(size);
}

export function parseSize(label: string): number {
	const match = /^(\d+(?:\.\d+)?)([km]?)$/i.exec(label.trim());
	if (match === null) {
		throw new Error(`Invalid size "${label}" (expected for example 100k or 1m)`);
	}
	const unit = (match[2] ?? '').toLowerCase();
	const scale = unit === 'm' ? M : unit === 'k' ? K : 1;
	return Math.round(Number(match[1]) * scale);
}

export function datasetLabel(dataset: DatasetSpec): string {
	return `${dataset.kind}-${sizeLabel(dataset.size)}`;
}

/** Identifies a case: everything about a job except the adapter. */
export function caseId(job: Job): string {
	const base = `${job.scenario}/${datasetLabel(job.dataset)}`;
	switch (job.scenario) {
		case 'load':
			return base;
		case 'tick':
			return `${base}/${job.view}`;
		case 'frames':
			return `${base}/${job.motion}-${job.zoom === 'all' ? 'all' : sizeLabel(job.zoom)}`;
		case 'prepend':
			return `${base}/${sizeLabel(job.batch)}`;
		case 'refetch':
			return `${base}/${job.memoryLimit / 2 ** 20}mib/${job.variant}`;
		case 'ind-load':
			return `${base}/${job.indicators}`;
		case 'ind-apply':
			return `${base}/${job.view}/${job.indicators}`;
		case 'ind-frames':
			return `${base}/${job.motion}-${job.zoom === 'all' ? 'all' : sizeLabel(job.zoom)}/${job.indicators}`;
		case 'ind-prepend':
			return `${base}/${sizeLabel(job.batch)}/${job.indicators}`;
		case 'axes-frames':
			return `${base}/${job.motion}-${job.zoom === 'all' ? 'all' : sizeLabel(job.zoom)}/${job.axes}`;
		case 'multi':
			return `${base}/${job.charts}-charts${job.maxWorkers === null ? '' : `/max-workers-${job.maxWorkers}`}`;
		case 'drawings':
			return `${base}/${job.drawings}/${job.variant}`;
		case 'state':
			return `${base}/${job.drawings}`;
		case 'tz-frames':
			return `${base}/${job.motion}-${job.zoom === 'all' ? 'all' : sizeLabel(job.zoom)}`;
		case 'tz-change':
			return `${base}/${job.zoom === 'all' ? 'all' : sizeLabel(job.zoom)}`;
	}
}

/**
 * Whether case `id` is selected by `pattern`: every `/`-separated part of the pattern equals the
 * id's part at the same position, so `frames/line-10m` selects `frames/line-10m/pan-200` but
 * `frames/candles-1m/pan-200` does not select `frames/candles-1m/pan-2000`.
 */
export function matchesCase(id: string, pattern: string): boolean {
	const idParts = id.split('/');
	const parts = pattern.split('/').filter(part => part !== '');
	return parts.length > 0 && parts.length <= idParts.length && parts.every((part, i) => part === idParts[i]);
}

/** Why an adapter is left out of a data set in a scenario, or null to run it. */
export type SkipRule = (adapter: string, dataset: DatasetSpec, scenario: ScenarioName) => string | null;

export interface PlanOptions {
	scenarios: readonly ScenarioName[];
	adapters: readonly string[];
	/** Keep only data sets with one of these sizes (empty: all). */
	sizes: readonly number[];
	/** Keep only data sets of these kinds (empty: all). */
	kinds: readonly SeriesKind[];
	/** Keep only cases selected by one of these patterns (see `matchesCase`; empty or absent: all). */
	cases?: readonly string[];
	/** Leaves out adapter and data set pairs known to fail, for example a renderer that runs out of memory. */
	skip?: SkipRule;
	repeats: number;
	/** Small sizes and short runs that only check that everything works. */
	quick: boolean;
	chart: ChartSize;
	seed: number;
	/**
	 * Measuring time after which a tick or frames run stops early, once it has its minimum number of
	 * samples (default `DEFAULT_BUDGET_MS`). 0 measures every tick and frame. Fast libraries finish
	 * before the budget; it only shortens runs of slow ones, whose distribution is clear long before.
	 */
	budgetMs?: number;
	/**
	 * Worker limits to run the multi-chart scenario with, one case each (see `MultiJob.maxWorkers`;
	 * default: the library's own limit only).
	 */
	maxWorkers?: readonly (number | null)[];
}

export const DEFAULT_BUDGET_MS = 10_000;
/** Warm-up time limit of a run with a budget. */
const WARMUP_BUDGET_MS = 2_000;

/** `Omit` applied to each member of a union. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A job without its adapter. */
type JobCase = DistributiveOmit<Job, 'adapter'>;

export interface PlannedJob {
	readonly id: string;
	readonly caseId: string;
	readonly repeat: number;
	readonly job: Job;
}

/** A case an adapter is left out of, and why. */
export interface SkippedCase {
	readonly caseId: string;
	readonly adapter: string;
	readonly reason: string;
}

export interface Plan {
	readonly jobs: PlannedJob[];
	readonly skipped: SkippedCase[];
}

const LOAD_DATASETS: readonly DatasetSpec[] = [
	{ kind: 'candles', size: 100 * K },
	{ kind: 'candles', size: M },
	{ kind: 'line', size: M },
	{ kind: 'line', size: 10 * M },
];
const TICK_DATASETS: readonly DatasetSpec[] = [
	{ kind: 'candles', size: 10 * K },
	{ kind: 'candles', size: 100 * K },
	{ kind: 'candles', size: 300 * K },
	{ kind: 'candles', size: M },
];
const TICK_VIEWS: readonly TickView[] = ['latest', 'all'];
// 10M line points are the data set of the stage 2 gate (design section 9).
const FRAME_DATASETS: readonly DatasetSpec[] = [
	{ kind: 'candles', size: M },
	{ kind: 'line', size: 10 * M },
];
// Levels at or above the data set size are left out, so 2M only applies to 10M points.
const FRAME_ZOOMS: readonly ZoomLevel[] = [200, 2_000, 20_000, 200_000, 2 * M, 'all'];
const MOTIONS: readonly Motion[] = ['pan', 'zoom'];
const PREPEND_DATASETS: readonly DatasetSpec[] = [
	{ kind: 'candles', size: M },
	{ kind: 'line', size: 10 * M },
];

interface PrependBatch {
	readonly batch: number;
	readonly prepends: number;
	readonly minPrepends: number;
}

// 10k: a page of history as a datafeed delivers it while the user scrolls. 1M: a bulk load, where
// the cost proportional to the batch shows. Every measured 1M prepend adds 1M rows, hence fewer.
const PREPEND_BATCHES: readonly PrependBatch[] = [
	{ batch: 10 * K, prepends: 20, minPrepends: 5 },
	{ batch: M, prepends: 5, minPrepends: 3 },
];

interface RefetchCase {
	readonly dataset: DatasetSpec;
	readonly memoryLimit: number;
	readonly variant: RefetchVariant;
}

// The stage 2 gate's data set. 128 MiB is below what 10M points take with their levels (about
// 185 MiB), so most of the old history is let go before the first jump. 1 MiB is below anything a
// library can keep, so what it holds then is its floor. Three series at 256 MiB: the two with a
// datafeed take about 370 MiB with their levels.
const REFETCH_CASES: readonly RefetchCase[] = [
	{ dataset: { kind: 'line', size: 10 * M }, memoryLimit: 128 * 2 ** 20, variant: 'jumps' },
	{ dataset: { kind: 'line', size: 10 * M }, memoryLimit: 2 ** 20, variant: 'jumps' },
	{ dataset: { kind: 'line', size: 10 * M }, memoryLimit: 256 * 2 ** 20, variant: 'several' },
	{ dataset: { kind: 'line', size: 10 * M }, memoryLimit: 128 * 2 ** 20, variant: 'ops' },
];
const QUICK_REFETCH_CASES: readonly RefetchCase[] = [
	{ dataset: { kind: 'line', size: 100 * K }, memoryLimit: 1.5 * 2 ** 20, variant: 'jumps' },
	{ dataset: { kind: 'line', size: 100 * K }, memoryLimit: 3 * 2 ** 20, variant: 'several' },
	{ dataset: { kind: 'line', size: 100 * K }, memoryLimit: 1.5 * 2 ** 20, variant: 'ops' },
];

// Stage 3: 20 indicators on candles. 100k is where Lightweight Charts, which takes one line series
// per output in user code, is compared; 1M is the gate's data set.
const INDICATOR_COUNT = 20;
const INDICATOR_DATASETS: readonly DatasetSpec[] = [
	{ kind: 'candles', size: 100 * K },
	{ kind: 'candles', size: M },
];
const INDICATOR_FRAME_ZOOMS: readonly ZoomLevel[] = [200, 2_000, 20_000, 200_000, 'all'];
const INDICATOR_PREPEND_BATCHES: readonly PrependBatch[] = [
	{ batch: 10 * K, prepends: 10, minPrepends: 3 },
	{ batch: M, prepends: 3, minPrepends: 2 },
];
const QUICK_INDICATOR_DATASETS: readonly DatasetSpec[] = [{ kind: 'candles', size: 10 * K }];
// Stage 4: three moving averages on the candles, on price axes laid out four ways.
const AXES_DATASETS: readonly DatasetSpec[] = [{ kind: 'candles', size: M }];
const AXES_ZOOMS: readonly ZoomLevel[] = [200, 'all'];
const AXES_INDICATORS = 3;

// Stage 4: 1M one-minute candles (almost two years, so two changes to and from summer time a year)
// in New York time with the extended hours of an equity exchange.
const TIME_ZONE_DATASETS: readonly DatasetSpec[] = [{ kind: 'candles', size: M }];
const QUICK_TIME_ZONE_DATASETS: readonly DatasetSpec[] = [{ kind: 'candles', size: 10 * K }];
const TIME_ZONE_FRAME_ZOOMS: readonly ZoomLevel[] = [200, 2_000, 20_000, 200_000, 'all'];
const ZONE_CHANGE_ZOOMS: readonly ZoomLevel[] = [200, 20_000, 'all'];
/** Zones a change cycles through: summer time north and south, half-hour offsets, none. */
const CHANGE_ZONES: readonly string[] = [
	'America/New_York',
	'Europe/London',
	'Asia/Kolkata',
	'Australia/Lord_Howe',
	'Asia/Tokyo',
	'UTC',
];
interface MultiCase {
	readonly dataset: DatasetSpec;
	readonly charts: number;
	readonly visibleCharts: number;
	readonly columns: number;
}

// A dashboard of 16 charts, half of them below the fold, each with 100k one-minute candles (ten
// weeks) and live ticks; and 4 charts in view with 1M candles each, where the loads are heavy
// enough to show whether a library runs them side by side.
const MULTI_CASES: readonly MultiCase[] = [
	{ dataset: { kind: 'candles', size: 100 * K }, charts: 16, visibleCharts: 8, columns: 4 },
	{ dataset: { kind: 'candles', size: M }, charts: 4, visibleCharts: 4, columns: 2 },
];
const QUICK_MULTI_CASES: readonly MultiCase[] = [
	{ dataset: { kind: 'candles', size: 10 * K }, charts: 4, visibleCharts: 2, columns: 2 },
];

interface DrawingsCase {
	readonly drawings: number;
	readonly variant: DrawingsVariant;
}

// 1,000 drawings is the gate; hovering a chart without drawings is the crosshair alone, for scale.
const DRAWINGS_DATASET: DatasetSpec = { kind: 'candles', size: M };
const DRAWINGS_CASES: readonly DrawingsCase[] = [
	{ drawings: 1000, variant: 'hover' },
	{ drawings: 0, variant: 'hover' },
	{ drawings: 1000, variant: 'drag' },
	{ drawings: 1000, variant: 'pan' },
];
const QUICK_DRAWINGS_DATASET: DatasetSpec = { kind: 'candles', size: 10 * K };
const QUICK_DRAWINGS_CASES: readonly DrawingsCase[] = [
	{ drawings: 100, variant: 'hover' },
	{ drawings: 100, variant: 'drag' },
];

// 1,000 drawings is the size of the stage 4 gate; without drawings a restore is the options and series alone.
const STATE_DRAWINGS: readonly number[] = [1000, 0];
const QUICK_STATE_DRAWINGS: readonly number[] = [100];

const QUICK_LOAD_DATASETS: readonly DatasetSpec[] = [
	{ kind: 'candles', size: 10 * K },
	{ kind: 'line', size: 10 * K },
];
const QUICK_TICK_DATASETS: readonly DatasetSpec[] = [{ kind: 'candles', size: 10 * K }];
const QUICK_FRAME_DATASETS: readonly DatasetSpec[] = [
	{ kind: 'candles', size: 10 * K },
	{ kind: 'line', size: 10 * K },
];
const QUICK_FRAME_ZOOMS: readonly ZoomLevel[] = [200, 'all'];
const QUICK_PREPEND_DATASETS: readonly DatasetSpec[] = QUICK_FRAME_DATASETS;
const QUICK_PREPEND_BATCHES: readonly PrependBatch[] = [{ batch: K, prepends: 3, minPrepends: 2 }];

/**
 * Builds the job list. Cases run one after another; within a case the repeats run in order and
 * each repeat runs every adapter back to back, so slow drift of the machine affects all adapters
 * alike.
 */
export function planJobs(options: PlanOptions): Plan {
	const { quick, chart, seed } = options;
	const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
	const warmupBudgetMs = budgetMs > 0 ? Math.min(WARMUP_BUDGET_MS, budgetMs) : 0;
	const keep = (dataset: DatasetSpec): boolean =>
		(options.sizes.length === 0 || options.sizes.includes(dataset.size)) &&
		(options.kinds.length === 0 || options.kinds.includes(dataset.kind));
	const cases: JobCase[] = [];

	if (options.scenarios.includes('load')) {
		for (const dataset of (quick ? QUICK_LOAD_DATASETS : LOAD_DATASETS).filter(keep)) {
			cases.push({ scenario: 'load', dataset, seed, chart });
		}
	}
	if (options.scenarios.includes('tick')) {
		for (const dataset of (quick ? QUICK_TICK_DATASETS : TICK_DATASETS).filter(keep)) {
			for (const view of TICK_VIEWS) {
				cases.push({
					scenario: 'tick',
					dataset,
					seed,
					chart,
					view,
					ticks: quick ? 1_000 : 10_000,
					minTicks: quick ? 200 : 500,
					budgetMs,
					warmupTicks: quick ? 100 : 500,
					warmupBudgetMs,
					roundSize: 100,
					newBarEvery: 10,
				});
			}
		}
	}
	if (options.scenarios.includes('frames')) {
		for (const dataset of (quick ? QUICK_FRAME_DATASETS : FRAME_DATASETS).filter(keep)) {
			for (const zoom of quick ? QUICK_FRAME_ZOOMS : FRAME_ZOOMS) {
				if (zoom !== 'all' && zoom >= dataset.size) {
					continue;
				}
				for (const motion of MOTIONS) {
					cases.push({
						scenario: 'frames',
						dataset,
						seed,
						chart,
						zoom,
						motion,
						frames: quick ? 60 : 300,
						minFrames: quick ? 20 : 30,
						budgetMs,
						warmupFrames: quick ? 10 : 30,
						warmupBudgetMs,
					});
				}
			}
		}
	}
	if (options.scenarios.includes('prepend')) {
		for (const dataset of (quick ? QUICK_PREPEND_DATASETS : PREPEND_DATASETS).filter(keep)) {
			for (const { batch, prepends, minPrepends } of quick ? QUICK_PREPEND_BATCHES : PREPEND_BATCHES) {
				cases.push({
					scenario: 'prepend',
					dataset,
					seed,
					chart,
					batch,
					// A view wider than the data cannot be shown: lumen stops zooming out where all of it fits.
					visibleBars: Math.min(2 * batch, dataset.size),
					prepends,
					minPrepends,
					budgetMs,
				});
			}
		}
	}

	if (options.scenarios.includes('refetch')) {
		for (const { dataset, memoryLimit, variant } of quick ? QUICK_REFETCH_CASES : REFETCH_CASES) {
			if (keep(dataset)) {
				const ops = variant === 'ops';
				cases.push({
					scenario: 'refetch',
					variant,
					dataset,
					seed,
					chart,
					memoryLimit,
					visibleBars: 2_000,
					jumps: quick || ops ? 3 : 20,
					minJumps: quick || ops ? 2 : 5,
					budgetMs,
				});
			}
		}
	}

	const indicatorDatasets = (quick ? QUICK_INDICATOR_DATASETS : INDICATOR_DATASETS).filter(keep);
	const indicators = quick ? 5 : INDICATOR_COUNT;
	if (options.scenarios.includes('ind-load')) {
		for (const dataset of indicatorDatasets) {
			cases.push({ scenario: 'ind-load', dataset, seed, chart, indicators });
		}
	}
	if (options.scenarios.includes('ind-apply')) {
		for (const dataset of indicatorDatasets) {
			for (const view of TICK_VIEWS) {
				cases.push({
					scenario: 'ind-apply',
					dataset,
					seed,
					chart,
					indicators,
					view,
					ticks: quick ? 500 : 10_000,
					minTicks: quick ? 100 : 1_000,
					budgetMs,
					warmupTicks: quick ? 50 : 200,
					warmupBudgetMs,
					newBarEvery: 10,
				});
			}
		}
	}
	if (options.scenarios.includes('ind-frames')) {
		for (const dataset of indicatorDatasets) {
			for (const zoom of quick ? QUICK_FRAME_ZOOMS : INDICATOR_FRAME_ZOOMS) {
				if (zoom !== 'all' && zoom >= dataset.size) {
					continue;
				}
				for (const motion of MOTIONS) {
					cases.push({
						scenario: 'ind-frames',
						dataset,
						seed,
						chart,
						indicators,
						zoom,
						motion,
						frames: quick ? 60 : 300,
						minFrames: quick ? 20 : 30,
						budgetMs,
						warmupFrames: quick ? 10 : 30,
						warmupBudgetMs,
					});
				}
			}
		}
	}
	if (options.scenarios.includes('ind-prepend')) {
		for (const dataset of indicatorDatasets) {
			for (const { batch, prepends, minPrepends } of quick ? QUICK_PREPEND_BATCHES : INDICATOR_PREPEND_BATCHES) {
				if (batch > dataset.size) {
					continue;
				}
				cases.push({
					scenario: 'ind-prepend',
					dataset,
					seed,
					chart,
					indicators,
					batch,
					visibleBars: Math.min(2 * batch, dataset.size),
					prepends,
					minPrepends,
					budgetMs,
				});
			}
		}
	}
	if (options.scenarios.includes('axes-frames')) {
		for (const dataset of (quick ? QUICK_INDICATOR_DATASETS : AXES_DATASETS).filter(keep)) {
			for (const zoom of quick ? QUICK_FRAME_ZOOMS : AXES_ZOOMS) {
				for (const motion of MOTIONS) {
					for (const axes of PRICE_AXES_LAYOUTS) {
						cases.push({
							scenario: 'axes-frames',
							dataset,
							seed,
							chart,
							indicators: AXES_INDICATORS,
							axes,
							zoom,
							motion,
							frames: quick ? 60 : 300,
							minFrames: quick ? 20 : 30,
							budgetMs,
							warmupFrames: quick ? 10 : 30,
							warmupBudgetMs,
						});
					}
				}
			}
		}
	}
	if (options.scenarios.includes('multi')) {
		for (const { dataset, charts, visibleCharts, columns } of quick ? QUICK_MULTI_CASES : MULTI_CASES) {
			if (!keep(dataset)) {
				continue;
			}
			for (const maxWorkers of options.maxWorkers ?? [null]) {
				cases.push({
					scenario: 'multi',
					dataset,
					seed,
					chart,
					charts,
					visibleCharts,
					columns,
					rounds: quick ? 30 : 300,
					minRounds: quick ? 10 : 60,
					budgetMs,
					warmupRounds: quick ? 5 : 30,
					warmupBudgetMs,
					newBarEvery: 10,
					maxWorkers,
				});
			}
		}
	}

	if (options.scenarios.includes('drawings')) {
		const dataset = quick ? QUICK_DRAWINGS_DATASET : DRAWINGS_DATASET;
		if (keep(dataset)) {
			for (const { drawings, variant } of quick ? QUICK_DRAWINGS_CASES : DRAWINGS_CASES) {
				cases.push({
					scenario: 'drawings',
					dataset,
					seed,
					chart,
					variant,
					drawings,
					visibleBars: 300,
					frames: quick ? 60 : 600,
					minFrames: quick ? 20 : 120,
					budgetMs,
					warmupFrames: quick ? 10 : 60,
					warmupBudgetMs,
				});
			}
		}
	}

	if (options.scenarios.includes('state')) {
		const dataset = quick ? QUICK_DRAWINGS_DATASET : DRAWINGS_DATASET;
		if (keep(dataset)) {
			for (const drawings of quick ? QUICK_STATE_DRAWINGS : STATE_DRAWINGS) {
				cases.push({
					scenario: 'state',
					dataset,
					seed,
					chart,
					drawings,
					indicators: 5,
					visibleBars: 300,
					rounds: quick ? 5 : 30,
				});
			}
		}
	}

	const timeZoneDatasets = (quick ? QUICK_TIME_ZONE_DATASETS : TIME_ZONE_DATASETS).filter(keep);
	if (options.scenarios.includes('tz-frames')) {
		for (const dataset of timeZoneDatasets) {
			for (const zoom of quick ? QUICK_FRAME_ZOOMS : TIME_ZONE_FRAME_ZOOMS) {
				if (zoom !== 'all' && zoom >= dataset.size) {
					continue;
				}
				for (const motion of MOTIONS) {
					cases.push({
						scenario: 'tz-frames',
						dataset,
						seed,
						chart,
						timeZone: 'America/New_York',
						sessions: true,
						zoom,
						motion,
						frames: quick ? 60 : 300,
						minFrames: quick ? 20 : 30,
						budgetMs,
						warmupFrames: quick ? 10 : 30,
						warmupBudgetMs,
					});
				}
			}
		}
	}
	if (options.scenarios.includes('tz-change')) {
		for (const dataset of timeZoneDatasets) {
			for (const zoom of quick ? QUICK_FRAME_ZOOMS : ZONE_CHANGE_ZOOMS) {
				if (zoom !== 'all' && zoom >= dataset.size) {
					continue;
				}
				cases.push({
					scenario: 'tz-change',
					dataset,
					seed,
					chart,
					zoom,
					zones: CHANGE_ZONES,
					changes: quick ? 12 : 60,
				});
			}
		}
	}

	const patterns = options.cases ?? [];
	const jobs: PlannedJob[] = [];
	const skipped: SkippedCase[] = [];
	for (const c of cases) {
		const id = caseId({ ...c, adapter: '' });
		if (patterns.length > 0 && !patterns.some(pattern => matchesCase(id, pattern))) {
			continue;
		}
		const adapters: string[] = [];
		for (const adapter of options.adapters) {
			const reason = options.skip?.(adapter, c.dataset, c.scenario) ?? null;
			if (reason === null) {
				adapters.push(adapter);
			} else {
				skipped.push({ caseId: id, adapter, reason });
			}
		}
		for (let repeat = 0; repeat < options.repeats; repeat++) {
			for (const adapter of adapters) {
				const job: Job = { ...c, adapter };
				jobs.push({ id: `${id}/${adapter}#${repeat + 1}`, caseId: id, repeat, job });
			}
		}
	}
	return { jobs, skipped };
}
