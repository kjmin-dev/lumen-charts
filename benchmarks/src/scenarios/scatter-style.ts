// Scatter series whose points have sizes of their own, or are colored by their density, against
// the same points drawn plain: zoom and appended points, at 100k and 1M points in view.

import { supports } from '../adapter.ts';
import { type DatasetSpec, type JobCase, K, M, sizeLabel } from '../jobs.ts';
import { MS, type Report, cell, eachCase, hostIdle, table } from '../report.ts';
import { type Metric, type RunContext, defineScenario } from '../scenario.ts';
import { ms } from '../format.ts';
import { type MarksRun, type MarksVariant, type ScatterJob, runMarks } from './marks.ts';

/** How the scatter is drawn: as the `scatter` scenario draws it, with a size per point, or by density. */
export type ScatterStyle = 'plain' | 'sized' | 'density';

/** How a library styles the scatter that `MarksAdapter.setScatter` adds next. */
export interface ScatterStyleOptions {
	/** The size of a point in CSS pixels, from its value; null: every point at the series' size. */
	readonly size: ((value: number) => number) | null;
	readonly colorBy: 'value' | 'density';
}

/** A library whose scatter points can have sizes of their own and be colored by density. */
export interface ScatterStyleAdapter {
	/** Styles the scatter the next `setScatter` adds, and the points `appendScatter` adds to it. */
	styleScatter(style: ScatterStyleOptions): void;
}

export interface ScatterStyleJob extends Omit<ScatterJob, 'scenario'> {
	readonly scenario: 'scatter-style';
	readonly style: ScatterStyle;
}

/**
 * Sizes of 1, 1.5 and 2 CSS pixels (2, 3 and 4 device pixels at a ratio of 2), on average the
 * scatter scenario's 1.5: the cost measured is that of a size per point, not of larger points.
 */
export function styleSize(value: number): number {
	return 1 + (value % 3) * 0.5;
}

function styleOf(style: ScatterStyle): ScatterStyleOptions {
	return { size: style === 'sized' ? styleSize : null, colorBy: style === 'density' ? 'density' : 'value' };
}

/** The scatter scenario's run, with the adapter told the style first. */
async function runStyled(job: ScatterStyleJob, context: RunContext): Promise<MarksRun> {
	const factory = context.factory;
	return runMarks(
		{ ...job, scenario: 'scatter' },
		{
			...context,
			factory: {
				...factory,
				create: async (...args) => {
					const adapter = await factory.create(...args);
					if (!supports<ScatterStyleAdapter>(adapter, 'styleScatter')) {
						throw new Error('This adapter has no scatter sizes and densities');
					}
					adapter.styleScatter(styleOf(job.style));
					return adapter;
				},
			},
		},
	);
}

/** Bars in view: about one per CSS pixel of the pane, as in the scatter scenario. */
const BARS = 1000;
const STYLES: readonly ScatterStyle[] = ['plain', 'sized', 'density'];
const VARIANTS: readonly MarksVariant[] = ['zoom', 'tick'];

function headline(m: Metric): string {
	return (
		`JS mean ${ms(m('jsTime.mean'))} p50 ${ms(m('jsTime.p50'))} p95 ${ms(m('jsTime.p95'))}; ` +
		`${m('marks') ?? '–'} marks at level ${m('level') ?? '–'}; ${m('rendererPath') ?? ''}; frames ${m('frames') ?? '–'}`
	);
}

function section(report: Report): string {
	const rows: string[][] = [];
	for (const c of eachCase<ScatterStyleJob>(report, 'scatter-style')) {
		const first = c.runs.find(run => run.status === 'ok');
		const run = first?.status === 'ok' ? (first.result as unknown as MarksRun) : undefined;
		rows.push([
			`${c.job.variant}, ${sizeLabel(c.job.points)} points (${c.job.style})`,
			c.adapter,
			run?.rendererPath ?? '–',
			run?.rendererReason ?? '–',
			cell(c, 'jsTime.mean', MS),
			cell(c, 'jsTime.p50', MS),
			cell(c, 'jsTime.p95', MS),
			cell(c, 'jsTime.max', MS),
			cell(c, 'marks'),
			cell(c, 'level'),
			cell(c, 'frames'),
			hostIdle(c),
		]);
	}
	return table(
		[
			'Case',
			'Adapter',
			'Path',
			'Reason',
			'JS mean (ms)',
			'p50',
			'p95',
			'max',
			'Marks in view',
			'Level',
			'Frames',
			'CPU idle',
		],
		rows,
	);
}

export const scatterStyle = defineScenario<ScatterStyleJob, MarksRun>({
	name: 'scatter-style',
	order: 172,
	requires: { capability: 'scatterStyle', reason: 'the library has no scatter sizes per point or densities' },
	plan({ quick, chart, seed, budgetMs, warmupBudgetMs, keep }) {
		const dataset: DatasetSpec = { kind: 'candles', size: 2 * BARS };
		if (!keep(dataset)) {
			return [];
		}
		const cases: JobCase<ScatterStyleJob>[] = [];
		for (const points of quick ? [10 * K] : [100 * K, M]) {
			for (const variant of quick ? (['tick'] as const) : VARIANTS) {
				for (const style of STYLES) {
					cases.push({
						scenario: 'scatter-style',
						dataset,
						seed,
						chart,
						points,
						shape: 'cloud',
						variant,
						style,
						pointSize: 1.5,
						visibleBars: BARS,
						budgetMs,
						warmupBudgetMs,
						frames: quick ? 40 : 240,
						minFrames: quick ? 15 : 30,
						warmupFrames: quick ? 8 : 30,
					});
				}
			}
		}
		return cases;
	},
	caseParts: job => [`${job.shape}-${sizeLabel(job.points)}`, job.variant, job.style],
	run: runStyled,
	headline,
	sections: [{ title: 'Scatter series: sizes per point and densities, against plain points', render: section }],
});
