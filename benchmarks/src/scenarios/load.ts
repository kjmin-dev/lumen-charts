// Cold load, then warm load and memory of the same data set in the same page.

import type { AdapterFactory, ChartAdapter, ChartSize } from '../adapter.ts';
import { type SeriesColumns, generateSeries } from '../data.ts';
import { mb, ms } from '../format.ts';
import { afterLibraryFrame, afterNextFrame, frameJsTotal, libraryFrameRuns } from '../harness/frames.ts';
import { markMeasured } from '../harness/marks.ts';
import { createSettled, prepare } from '../harness/steps.ts';
import { type DatasetSpec, type JobBase, type JobCase, K, M, type MemoryResult, datasetLabel } from '../jobs.ts';
import { memoryResult } from '../memory.ts';
import { MS, type Report, casesOf, cell, eachCase, hostIdle, memoryTable, runsNote, table } from '../report.ts';
import { type Metric, type RunContext, defineScenario } from '../scenario.ts';

/** Cold load, then warm load and memory of the same data set in the same page. */
export interface LoadJob extends JobBase {
	readonly scenario: 'load';
}

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

export interface LoadRun {
	/** Generating the data set in the page (not part of any load time). */
	generateMs: number;
	/** First load in a fresh page: includes compiling the library's code. */
	cold: LoadTimings;
	/** Second load of the same data set in the same page, into a new chart. */
	warm: LoadTimings;
	memory: MemoryResult | null;
}

const LOAD_DATASETS: readonly DatasetSpec[] = [
	{ kind: 'candles', size: 100 * K },
	{ kind: 'candles', size: M },
	{ kind: 'line', size: M },
	{ kind: 'line', size: 10 * M },
];
const QUICK_LOAD_DATASETS: readonly DatasetSpec[] = [
	{ kind: 'candles', size: 10 * K },
	{ kind: 'line', size: 10 * K },
];

/** Something a scenario does to a chart before it gets its data, such as putting indicators on it. */
export type ChartSetup = (adapter: ChartAdapter) => void;

async function loadOnce(
	factory: AdapterFactory,
	container: HTMLElement,
	size: ChartSize,
	data: SeriesColumns,
	setup: ChartSetup | undefined,
): Promise<{ adapter: ChartAdapter; timings: LoadTimings }> {
	const adapter = await createSettled(factory, container, size);
	setup?.(adapter);
	markMeasured('start');
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
	markMeasured('end');
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

export async function runLoad(
	job: JobBase,
	{ factory, container, probes }: RunContext,
	setup?: ChartSetup,
): Promise<LoadRun> {
	const generateStart = performance.now();
	const data = generateSeries(job.dataset.kind, { seed: job.seed, count: job.dataset.size });
	const generateMs = performance.now() - generateStart;
	await probes.collectGarbage();

	const cold = await loadOnce(factory, container, job.chart, data, setup);
	cold.adapter.destroy();
	await afterNextFrame();
	await probes.collectGarbage();

	const before = await probes.measureMemory();
	const warm = await loadOnce(factory, container, job.chart, data, setup);
	await probes.collectGarbage();
	const after = await probes.measureMemory();
	warm.adapter.destroy();

	return { generateMs, cold: cold.timings, warm: warm.timings, memory: memoryResult(before, after) };
}

export function loadHeadline(m: Metric): string {
	return (
		`first frame ${ms(m('warm.firstFrameMs'))} (with conversion ${ms(m('warm.firstFrameWithConversionMs'))}, ` +
		`settled ${ms(m('warm.settledMs'))}, cold ${ms(m('cold.firstFrameMs'))}), ` +
		`retained ${mb(m('memory.retainedBytes'))} (page ${mb(m('memory.retainedPageBytes'))}, ` +
		`workers ${mb(m('memory.retainedWorkerBytes'))})`
	);
}

export function loadSection(report: Report, scenario: string): string {
	const list = casesOf(report, scenario);
	const rows: string[][] = [];
	for (const c of eachCase(report, scenario)) {
		const { adapter } = c;
		rows.push([
			datasetLabel(c.job.dataset),
			adapter,
			cell(c, 'warm.firstFrameMs', MS),
			cell(c, 'warm.firstFrameWithConversionMs', MS),
			cell(c, 'warm.settledMs', MS),
			cell(c, 'warm.convertMs', MS),
			cell(c, 'warm.setDataMs', MS),
			cell(c, 'warm.frameJsMs', MS),
			cell(c, 'cold.firstFrameMs', MS),
			cell(c, 'generateMs', MS),
			hostIdle(c),
		]);
	}
	return (
		table(
			[
				'Data set',
				'Adapter',
				'First frame (ms)',
				'+ conversion (ms)',
				'Settled (ms)',
				'Conversion (ms)',
				'setData (ms)',
				'Frame JS (ms)',
				'Cold first frame (ms)',
				'Generate (ms)',
				'Host CPU idle',
			],
			rows,
		) + `\n${runsNote(list)}\n`
	);
}

export function loadMemorySection(report: Report, scenario: string): string {
	return memoryTable(
		report,
		scenario,
		c => datasetLabel(c.job.dataset),
		c => c.job.dataset.size,
	);
}

export const load = defineScenario<LoadJob, LoadRun>({
	name: 'load',
	order: 10,
	plan({ quick, chart, seed, keep }) {
		const cases: JobCase<LoadJob>[] = [];
		for (const dataset of (quick ? QUICK_LOAD_DATASETS : LOAD_DATASETS).filter(keep)) {
			cases.push({ scenario: 'load', dataset, seed, chart });
		}
		return cases;
	},
	caseParts: () => [],
	run: (job, context) => runLoad(job, context),
	headline: loadHeadline,
	sections: [
		{ title: 'Load', render: report => loadSection(report, 'load') },
		{ title: 'Memory after load', render: report => loadMemorySection(report, 'load') },
	],
});
