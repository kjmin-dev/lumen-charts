// Several charts on one page, as a dashboard has them, each with live ticks.

import type { AdapterFactory, ChartAdapter, ChartSize } from '../adapter.ts';
import { generateSeries, generateTicks } from '../data.ts';
import { mb, ms } from '../format.ts';
import { afterNextFrame, frameJsTotal, libraryFrameRuns, nextTask, pendingFrameCallbacks } from '../harness/frames.ts';
import { markMeasured } from '../harness/marks.ts';
import { delay, overBudget, prepare } from '../harness/steps.ts';
import {
	type DatasetSpec,
	type JobBase,
	type JobCase,
	K,
	M,
	type MainThreadTimes,
	type MemoryResult,
	datasetLabel,
} from '../jobs.ts';
import { memoryResult } from '../memory.ts';
import { MIB, MS, type Report, US, cell, eachCase, hostIdle, table } from '../report.ts';
import { type RunContext, defineScenario } from '../scenario.ts';
import { type Distribution, summarize } from '../stats.ts';

/** A library that says when a chart is idle. */
export interface IdleAdapter {
	/**
	 * The library's own part of `settle`: resolves once everything submitted so far has been applied
	 * and drawn, possibly from inside the animation frame that draws it, without waiting for that
	 * frame's rendering. With several charts on a page the harness waits for all of them like this
	 * and then for the rendering once, so the waiting costs the same whatever a library does per
	 * chart. For libraries without such a signal the harness uses `settle`.
	 */
	idle(): Promise<void>;
}

/** A library that shares workers between its charts, up to a limit. */
export interface WorkerLimitFactory {
	/**
	 * Limits the workers the library shares between its charts, for charts created afterwards. A
	 * version of the library that has no such limit ignores the call.
	 */
	setMaxWorkers(count: number): void;
}

function hasIdle(adapter: ChartAdapter): adapter is ChartAdapter & IdleAdapter {
	return (adapter as Partial<IdleAdapter>).idle !== undefined;
}

function hasWorkerLimit(factory: AdapterFactory): factory is AdapterFactory & WorkerLimitFactory {
	return (factory as Partial<WorkerLimitFactory>).setMaxWorkers !== undefined;
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
	if (!adapters.every(hasIdle)) {
		await Promise.all(adapters.map(adapter => adapter.settle()));
		return;
	}
	for (;;) {
		await Promise.all(adapters.map(adapter => adapter.idle()));
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

async function runMulti(job: MultiJob, { factory, container, probes }: RunContext): Promise<MultiRun> {
	const generateStart = performance.now();
	const data = generateSeries(job.dataset.kind, { seed: job.seed, count: job.dataset.size });
	const ticks = generateTicks(data, {
		seed: job.seed + 1,
		count: job.warmupRounds + job.rounds,
		newBarEvery: job.newBarEvery,
	});
	const generateMs = performance.now() - generateStart;
	if (job.maxWorkers !== null && hasWorkerLimit(factory)) {
		factory.setMaxWorkers(job.maxWorkers);
	}

	// A grid whose first rows fill the viewport; the rows after them start below its bottom edge.
	const visibleRows = Math.ceil(job.visibleCharts / job.columns);
	const cellSize = {
		width: Math.floor((document.documentElement.clientWidth - (job.columns - 1) * MULTI_GAP) / job.columns),
		height: Math.floor(window.innerHeight / visibleRows),
	};
	const grid = document.createElement('div');
	grid.style.display = 'grid';
	grid.style.gridTemplateColumns = `repeat(${job.columns}, ${cellSize.width}px)`;
	grid.style.gridAutoRows = `${cellSize.height}px`;
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
		markMeasured('start');
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
		markMeasured('end');
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
			cell: cellSize,
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

function multiSection(report: Report): string {
	const rows: string[][] = [];
	for (const c of eachCase<MultiJob>(report, 'multi')) {
		const { adapter } = c;
		rows.push([
			`${c.job.charts} charts (${c.job.visibleCharts} in view), ${datasetLabel(c.job.dataset)} each` +
				(c.job.maxWorkers === null ? '' : `, at most ${c.job.maxWorkers} workers`),
			adapter,
			cell(c, 'workers'),
			cell(c, 'memory.retainedWorkerBytes', MIB),
			cell(c, 'memory.retainedPageBytes', MIB),
			cell(c, 'rendererResident.retainedBytes', MIB),
			cell(c, 'createMs', MS),
			cell(c, 'shownMs', MS),
			cell(c, 'shownMainThread.layoutMs', MS),
			cell(c, 'frameJs.p50', MS),
			cell(c, 'frameJs.p95', MS),
			cell(c, 'frameCallbacks.p50'),
			cell(c, 'tickMainThread.taskMs', MS),
			cell(c, 'tickMainThread.scriptMs', MS),
			cell(c, 'mainThreadPerTick.mean', US),
			cell(c, 'settle.p50', MS),
			cell(c, 'settle.p95', MS),
			cell(c, 'revealFrameJsMs', MS),
			cell(c, 'rounds'),
			hostIdle(c),
		]);
	}
	return table(
		[
			'Case',
			'Adapter',
			'Workers',
			'Workers retain (MiB)',
			'Page retains (MiB)',
			'Renderer resident growth (MiB)',
			'Create loop (ms)',
			'All shown (ms)',
			'Layout until shown (ms)',
			'Round frame JS p50 (ms)',
			'p95 (ms)',
			'Frame callbacks per round',
			'Main thread per round (ms)',
			'of it script (ms)',
			'Timed JS per tick (µs)',
			'Round settle p50 (ms)',
			'p95 (ms)',
			'Reveal frame JS (ms)',
			'Rounds',
			'CPU idle',
		],
		rows,
	);
}

export const multi = defineScenario<MultiJob, MultiRun>({
	name: 'multi',
	order: 110,
	plan({ quick, chart, seed, budgetMs, warmupBudgetMs, keep, maxWorkers: limits }) {
		const cases: JobCase<MultiJob>[] = [];
		for (const { dataset, charts, visibleCharts, columns } of quick ? QUICK_MULTI_CASES : MULTI_CASES) {
			if (!keep(dataset)) {
				continue;
			}
			for (const maxWorkers of limits) {
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
		return cases;
	},
	caseParts: job => [`${job.charts}-charts`, ...(job.maxWorkers === null ? [] : [`max-workers-${job.maxWorkers}`])],
	run: runMulti,
	headline(m) {
		return (
			`${m('charts') ?? '–'} charts in ${m('workers') ?? '–'} workers; shown ${ms(m('shownMs'))} ` +
			`(create ${ms(m('createMs'))}); retained ${mb(m('memory.retainedBytes'))} ` +
			`(page ${mb(m('memory.retainedPageBytes'))}, workers ${mb(m('memory.retainedWorkerBytes'))}); ` +
			`tick round: frame JS p50 ${ms(m('frameJs.p50'))} p95 ${ms(m('frameJs.p95'))}, ` +
			`main thread ${ms(m('tickMainThread.taskMs'))}; per tick ${ms(m('mainThreadPerTick.mean'))}`
		);
	},
	sections: [{ title: 'Several charts on one page', render: multiSection }],
});
