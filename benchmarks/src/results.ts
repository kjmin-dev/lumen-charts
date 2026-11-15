// Result file format, shared by the runner and the manual page. Free of DOM and Node APIs.

import type { AdapterInfo, Job, PlannedJob, RunOutcome, RunResult } from './jobs.ts';
import { type RunSpread, spread } from './stats.ts';

/**
 * 2: memory samples include the page's dedicated workers, and `retainedBytes` counts them (it was
 * the page alone); the prepend scenario.
 */
export const RESULTS_SCHEMA_VERSION = 2;

export interface CaseResult {
	/** Scenario, data set and parameters, without the adapter (see `caseId`). */
	caseId: string;
	adapter: string;
	/** The job of the first repeat (all repeats are identical). */
	job: Job;
	library: AdapterInfo | null;
	/** `ok` when every run succeeded, `partial` when some did, `failed` when none did. */
	status: 'ok' | 'partial' | 'failed';
	runs: RunOutcome[];
	/** Every numeric field of the successful runs, by dotted path, summarized over runs. */
	summary: Record<string, RunSpread>;
}

export interface ResultsFile {
	schema: number;
	createdAt: string;
	/** Free-form description of how the results were produced (runner flags, page, browser). */
	environment: Record<string, unknown>;
	cases: CaseResult[];
}

/** Collects `path -> value` for every finite number in `value`. */
export function numericLeaves(value: unknown, prefix = '', out: Map<string, number> = new Map()): Map<string, number> {
	if (typeof value === 'number') {
		if (Number.isFinite(value)) {
			out.set(prefix, value);
		}
	} else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
		for (const [key, child] of Object.entries(value)) {
			numericLeaves(child, prefix === '' ? key : `${prefix}.${key}`, out);
		}
	}
	return out;
}

/** Summarizes each numeric field over the runs that produced it. */
export function summarizeRuns(results: readonly RunResult[]): Record<string, RunSpread> {
	const values = new Map<string, number[]>();
	for (const result of results) {
		for (const [path, value] of numericLeaves(result)) {
			const list = values.get(path);
			if (list === undefined) {
				values.set(path, [value]);
			} else {
				list.push(value);
			}
		}
	}
	const summary: Record<string, RunSpread> = {};
	for (const [path, list] of values) {
		summary[path] = spread(list);
	}
	return summary;
}

export interface CompletedJob {
	planned: PlannedJob;
	outcome: RunOutcome;
	library: AdapterInfo | null;
}

/** Groups completed jobs by case and adapter, in the order they first appear. */
export function aggregate(completed: readonly CompletedJob[]): CaseResult[] {
	const groups = new Map<string, CaseResult>();
	for (const { planned, outcome, library } of completed) {
		const key = `${planned.caseId}|${planned.job.adapter}`;
		let group = groups.get(key);
		if (group === undefined) {
			group = {
				caseId: planned.caseId,
				adapter: planned.job.adapter,
				job: planned.job,
				library,
				status: 'ok',
				runs: [],
				summary: {},
			};
			groups.set(key, group);
		}
		group.library ??= library;
		group.runs.push(outcome);
	}
	for (const group of groups.values()) {
		const ok = group.runs.flatMap(run => (run.status === 'ok' ? [run.result] : []));
		group.status = ok.length === group.runs.length ? 'ok' : ok.length > 0 ? 'partial' : 'failed';
		group.summary = summarizeRuns(ok);
	}
	return [...groups.values()];
}
