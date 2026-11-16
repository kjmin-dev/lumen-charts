// The benchmark matrix: the cases of every scenario, as jobs per adapter and repeat. Shared by the
// page and the Node runner, so this module must stay free of DOM and Node APIs.

import {
	DEFAULT_BUDGET_MS,
	type DatasetSpec,
	type Job,
	type JobCase,
	type Plan,
	type PlanOptions,
	type PlannedJob,
	type SkippedCase,
	datasetLabel,
	matchesCase,
} from './jobs.ts';
import type { PlanContext } from './scenario.ts';
import { findScenario, scenarios } from './scenarios/index.ts';

/** Warm-up time limit of a run with a budget. */
const WARMUP_BUDGET_MS = 2_000;

/** Identifies a case: everything about a job except the adapter. */
export function caseId(job: Job): string {
	return [job.scenario, datasetLabel(job.dataset), ...findScenario(job.scenario).caseParts(job)].join('/');
}

/**
 * Builds the job list. Cases run one after another, scenario by scenario in the scenarios' order;
 * within a case the repeats run in order and each repeat runs every adapter back to back, so slow
 * drift of the machine affects all adapters alike.
 */
export function planJobs(options: PlanOptions): Plan {
	const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
	const context: PlanContext = {
		quick: options.quick,
		chart: options.chart,
		seed: options.seed,
		budgetMs,
		warmupBudgetMs: budgetMs > 0 ? Math.min(WARMUP_BUDGET_MS, budgetMs) : 0,
		keep: (dataset: DatasetSpec): boolean =>
			(options.sizes.length === 0 || options.sizes.includes(dataset.size)) &&
			(options.kinds.length === 0 || options.kinds.includes(dataset.kind)),
		maxWorkers: options.maxWorkers ?? [null],
	};
	const cases: JobCase[] = [];
	for (const scenario of scenarios) {
		if (options.scenarios.includes(scenario.name)) {
			cases.push(...scenario.plan(context));
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
