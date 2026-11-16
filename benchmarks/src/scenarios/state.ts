// The stage 4 scenario of saving and restoring the state of a chart.

import { supports } from '../adapter.ts';
import { type CandleColumns, generateSeries } from '../data.ts';
import { generateDrawings } from '../drawings.ts';
import { ms } from '../format.ts';
import { libraryFrameRuns } from '../harness/frames.ts';
import { type ChangeTimings, changeTimings, createSettled, prepare, timeChange } from '../harness/steps.ts';
import { type JobBase, type JobCase, datasetLabel } from '../jobs.ts';
import { MS, type Report, casesOf, cell, eachCase, median, number, runsNote, table } from '../report.ts';
import { type RunContext, defineScenario } from '../scenario.ts';
import { type Distribution, summarize } from '../stats.ts';
import { DRAWINGS_DATASET, type DrawingsAdapter, QUICK_DRAWINGS_DATASET } from './drawings.ts';
import type { IndicatorAdapter } from './indicators.ts';

/** A library that saves and restores the state of a chart. */
export interface StateAdapter {
	/** The state of the chart as the library saves it, without bars. */
	saveState(): unknown;
	/** Restores a state `saveState` returned, possibly after a trip through JSON. */
	restoreState(state: unknown): void;
	/** Removes the series, indicators and drawings of the chart, as restoring an empty state does. */
	clearState(): void;
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
	restore: ChangeTimings;
	/**
	 * Restoring it into the chart after its series, indicators and drawings were removed: they are
	 * all made again, the series without bars.
	 */
	restoreEmpty: ChangeTimings;
	/** Frames the library drew for one restore into the chart it was saved from. */
	restoreFrames: Distribution;
	drawings: number;
	indicators: number;
	visibleBars: number;
}

// 1,000 drawings is the size of the stage 4 gate; without drawings a restore is the options and series alone.
const STATE_DRAWINGS: readonly number[] = [1000, 0];
const QUICK_STATE_DRAWINGS: readonly number[] = [100];

/** Rounds of the state scenario before the measured ones, which let the engine compile the code. */
const STATE_WARMUP_ROUNDS = 3;

/**
 * Saving and restoring the state of a 1M-candle chart with indicators and drawings. Saving, and the
 * trip through JSON, are timed alone; a restore from the call until the frame that shows it is
 * drawn, like any change (`timeChange`), with the frames the library drew for it counted.
 */
async function runState(job: StateJob, { factory, container }: RunContext): Promise<StateRun> {
	const data = generateSeries('candles', { seed: job.seed, count: job.dataset.size }) as CandleColumns;
	const adapter = await createSettled(factory, container, job.chart);
	if (
		!supports<Pick<DrawingsAdapter, 'addDrawings'>>(adapter, 'addDrawings') ||
		!supports<StateAdapter>(adapter, 'saveState', 'restoreState', 'clearState')
	) {
		throw new Error('This adapter saves no chart state');
	}
	const { addDrawings, saveState, restoreState, clearState } = adapter;
	try {
		if (supports<IndicatorAdapter>(adapter, 'withIndicators')) {
			adapter.withIndicators(job.indicators);
		}
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

function stateSection(report: Report): string {
	const list = casesOf(report, 'state');
	const rows: string[][] = [];
	for (const c of eachCase<StateJob>(report, 'state')) {
		const { adapter } = c;
		const label = `${c.job.drawings} drawings, ${c.job.indicators} indicators, ${datasetLabel(c.job.dataset)}`;
		const length = median(c, 'jsonLength');
		rows.push(
			[
				label,
				adapter,
				'save',
				cell(c, 'saveMs.p50', MS),
				'–',
				cell(c, 'saveMs.p50', MS),
				cell(c, 'saveMs.max', MS),
				'–',
				'–',
			],
			[
				label,
				adapter,
				`JSON.stringify (${length === undefined ? '–' : number(length / 1000)} k characters)`,
				cell(c, 'stringifyMs.p50', MS),
				'–',
				cell(c, 'stringifyMs.p50', MS),
				cell(c, 'stringifyMs.max', MS),
				'–',
				'–',
			],
			[
				label,
				adapter,
				'JSON.parse',
				cell(c, 'parseMs.p50', MS),
				'–',
				cell(c, 'parseMs.p50', MS),
				cell(c, 'parseMs.max', MS),
				'–',
				'–',
			],
		);
		for (const kind of ['restore', 'restoreEmpty'] as const) {
			rows.push([
				label,
				adapter,
				kind === 'restore' ? 'restore into the chart saved from' : 'restore into the chart emptied',
				cell(c, `${kind}.callMs.p50`, MS),
				cell(c, `${kind}.frameJsMs.p50`, MS),
				cell(c, `${kind}.workMs.p50`, MS),
				cell(c, `${kind}.workMs.max`, MS),
				cell(c, `${kind}.shownMs.p50`, MS),
				kind === 'restore' ? cell(c, 'restoreFrames.max') : '–',
			]);
		}
	}
	return (
		table(
			['Case', 'Adapter', 'Step', 'Call p50', 'Frame JS p50', 'Work p50', 'Work max', 'Shown p50', 'Frames max'],
			rows,
		) +
		'\nAll times in ms. Work is the call plus the JavaScript of the frames until drawn; Frames is how many frames ' +
		`the chart drew for one restore. ${runsNote(list)}\n`
	);
}

export const state = defineScenario<StateJob, StateRun>({
	name: 'state',
	order: 130,
	requires: { capability: 'state', reason: 'the library saves no chart state' },
	plan({ quick, chart, seed, keep }) {
		const cases: JobCase<StateJob>[] = [];
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
		return cases;
	},
	caseParts: job => [job.drawings],
	run: runState,
	headline(m) {
		return (
			`save p50 ${ms(m('saveMs.p50'))} max ${ms(m('saveMs.max'))}; JSON ${m('jsonLength') ?? '–'} characters, ` +
			`stringify p50 ${ms(m('stringifyMs.p50'))}, parse p50 ${ms(m('parseMs.p50'))}; ` +
			`restore work p50 ${ms(m('restore.workMs.p50'))} max ${ms(m('restore.workMs.max'))} ` +
			`(call p50 ${ms(m('restore.callMs.p50'))}, frames p50 ${m('restoreFrames.p50') ?? '–'}); ` +
			`into an emptied chart work p50 ${ms(m('restoreEmpty.workMs.p50'))}`
		);
	},
	sections: [{ title: 'Chart state: save and restore', render: stateSection }],
});
