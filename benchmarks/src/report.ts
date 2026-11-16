// Formatting of the report's tables (`pnpm bench:report`), for the runner and for the sections the
// scenarios define. Free of DOM and Node APIs.

import type { Job } from './jobs.ts';
import type { CaseResult } from './results.ts';
import { type RunSpread, spread } from './stats.ts';

/** The cases of the results files a report is made from, in file order. */
export interface Report {
	readonly cases: readonly CaseResult[];
}

export function number(value: number): string {
	const abs = Math.abs(value);
	const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : 3;
	return value.toFixed(digits);
}

/** "median (min–max)" of a metric, scaled. */
export function cell(c: CaseResult | undefined, path: string, scale = 1): string {
	const s: RunSpread | undefined = c?.summary[path];
	if (c === undefined) {
		return '';
	}
	if (c.status === 'failed') {
		const first = c.runs[0];
		return first?.status === 'failed' ? `failed: ${first.reason}` : 'failed';
	}
	if (s === undefined || s.runs === 0) {
		return '–';
	}
	if (s.runs === 1) {
		return number(s.median * scale);
	}
	return `${number(s.median * scale)} (${number(s.min * scale)}–${number(s.max * scale)})`;
}

/** Share of CPU time the whole machine had idle during the case's runs: "median% (min–max%)". */
export function hostIdle(c: CaseResult | undefined): string {
	const values = (c?.runs ?? []).flatMap(run => (run.host === undefined ? [] : [run.host.cpuIdle * 100]));
	if (values.length === 0) {
		return '–';
	}
	const s = spread(values);
	return s.runs === 1
		? `${s.median.toFixed(0)}%`
		: `${s.median.toFixed(0)}% (${s.min.toFixed(0)}–${s.max.toFixed(0)}%)`;
}

export function median(c: CaseResult | undefined, path: string): number | undefined {
	return c?.summary[path]?.median;
}

export function table(header: string[], rows: string[][]): string {
	const lines = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`];
	for (const row of rows) {
		lines.push(`| ${row.join(' | ')} |`);
	}
	return `${lines.join('\n')}\n`;
}

export const MS = 1;
export const US = 1000;
export const MIB = 1 / 2 ** 20;

export function adaptersOf(list: readonly CaseResult[]): string[] {
	return [...new Set(list.map(c => c.adapter))];
}

export function find<J extends Job = Job>(report: Report, caseId: string, adapter: string): CaseResult<J> | undefined {
	return report.cases.find(c => c.caseId === caseId && c.adapter === adapter) as CaseResult<J> | undefined;
}

/** The cases of a scenario. */
export function casesOf<J extends Job = Job>(report: Report, scenario: string): CaseResult<J>[] {
	return report.cases.filter(c => c.job.scenario === scenario) as CaseResult<J>[];
}

export function caseIds(report: Report, scenario: string): string[] {
	return [...new Set(casesOf(report, scenario).map(c => c.caseId))];
}

/** The rows of a scenario's table: its cases in order, each with its adapters in order. */
export function eachCase<J extends Job = Job>(report: Report, scenario: string): CaseResult<J>[] {
	const adapters = adaptersOf(casesOf(report, scenario));
	const found: CaseResult<J>[] = [];
	for (const id of caseIds(report, scenario)) {
		for (const adapter of adapters) {
			const c = find<J>(report, id, adapter);
			if (c !== undefined) {
				found.push(c);
			}
		}
	}
	return found;
}

export function runsNote(list: readonly CaseResult[]): string {
	const counts = [...new Set(list.map(c => c.runs.length))];
	counts.sort((a, b) => a - b);
	return counts.length === 0 ? '' : `runs per row: ${counts.join(', ')}`;
}

/** Canvas 2D call that draws the series' bars: one `fillRect` per candle body or wick, one `lineTo` per point. */
export function seriesCall(c: CaseResult): string {
	return c.job.dataset.kind === 'candles' ? 'fillRect' : 'lineTo';
}

/**
 * Memory retained by the chart in the page and in its workers. Results before schema 2 measured the
 * page alone: their page and worker columns are empty and `Retained` is the page's.
 */
export function memoryTable<J extends Job = Job>(
	report: Report,
	scenario: string,
	label: (c: CaseResult<J>) => string,
	points: (c: CaseResult<J>) => number,
): string {
	const rows: string[][] = [];
	for (const c of eachCase<J>(report, scenario)) {
		const { adapter } = c;
		const retained = median(c, 'memory.retainedBytes');
		rows.push([
			label(c),
			adapter,
			cell(c, 'memory.retainedBytes', MIB),
			cell(c, 'memory.retainedPageBytes', MIB),
			cell(c, 'memory.retainedWorkerBytes', MIB),
			retained === undefined ? '–' : number(retained / points(c)),
			cell(c, 'memory.retainedJsHeapBytes', MIB),
			cell(c, 'memory.retainedBackingStoreBytes', MIB),
			cell(c, 'memory.retainedEmbedderHeapBytes', MIB),
			cell(c, 'memory.after.workers.backingStoreBytes', MIB),
			cell(c, 'memory.after.workers.count'),
			cell(c, 'memory.after.totalBytes', MIB),
		]);
	}
	return table(
		[
			'Data set',
			'Adapter',
			'Retained (MiB)',
			'Page (MiB)',
			'Workers (MiB)',
			'Bytes per point',
			'Page JS heap (MiB)',
			'Page backing stores (MiB)',
			'Page embedder heap (MiB)',
			'Worker backing stores after (MiB)',
			'Workers after',
			'Page total after (MiB)',
		],
		rows,
	);
}
