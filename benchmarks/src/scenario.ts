// What a scenario is to the harness. A module in `scenarios/` defines one or more with
// `defineScenario` and exports them; `scenarios/index.ts` finds them. Shared by the page and the
// Node runner, so this module must stay free of DOM and Node APIs.

import type { AdapterFactory, ChartSize } from './adapter.ts';
import type { DatasetSpec, Job, JobCase, MainThreadTimes, MemorySample, RunResult } from './jobs.ts';
import type { Report } from './report.ts';

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
	/**
	 * Starts or stops the runner's record of what the main thread allocates (`pnpm bench
	 * --allocations`); nothing without it. Awaited outside the timed calls, around the measured part.
	 * `ticks`, given at the end, is the number of ticks the part applied: the record is also given
	 * per tick.
	 */
	allocations(edge: 'start' | 'end', ticks?: number): Promise<void>;
}

/** What a scenario plans its part of the matrix from: the options of the plan that concern it. */
export interface PlanContext {
	/** Small sizes and short runs that only check that everything works. */
	readonly quick: boolean;
	readonly chart: ChartSize;
	readonly seed: number;
	/** Measuring time after which a run stops early, once it has its minimum number of samples; 0: never. */
	readonly budgetMs: number;
	/** The same for the warm-up of a run. */
	readonly warmupBudgetMs: number;
	/** Whether the plan's size and kind filters keep a data set. */
	keep(dataset: DatasetSpec): boolean;
	/** Worker limits to plan a case for each, for scenarios that have one; null is the library's own. */
	readonly maxWorkers: readonly (number | null)[];
}

/** What a scenario runs with in the page. */
export interface RunContext {
	readonly factory: AdapterFactory;
	/** The element charts are mounted in, sized as the job's chart. */
	readonly container: HTMLElement;
	readonly probes: Probes;
}

/** Median over runs of a numeric field of the result, by dotted path. */
export type Metric = (path: string) => number | undefined;

/** A section of the report (`pnpm bench:report`), printed when the results have cases of the scenario. */
export interface ReportSection {
	readonly title: string;
	/** Position among all sections, where it differs from the scenario's `order`. */
	readonly order?: number;
	render(report: Report): string;
}

/** Something an adapter must be able to do for a scenario to run on it. */
export interface Requirement {
	/** Listed in `capabilities` of the registry entries of the adapters that can (`adapters/index.ts`). */
	readonly capability: string;
	/** Why the other adapters are skipped, as the runner prints it. */
	readonly reason: string;
}

/** Everything the harness knows about a scenario. */
export interface ScenarioDefinition<J extends Job, R extends RunResult> {
	/** What `--scenario` selects, and the first part of the case ids. */
	readonly name: J['scenario'];
	/**
	 * Position in the matrix, the list of scenarios and the report: lower runs and prints first, and
	 * scenarios with the same number go by name. A new scenario takes a number above the others.
	 */
	readonly order: number;
	readonly requires?: Requirement;
	/** The scenario's cases, in the order they run. */
	plan(context: PlanContext): readonly JobCase<J>[];
	/** The parts of a case id after `<scenario>/<data set>`: what tells the scenario's cases apart. */
	caseParts(job: J): readonly (string | number)[];
	/** Runs a job in the page. */
	run(job: J, context: RunContext): Promise<R>;
	/** One-line summary of a case from the medians of its metrics. */
	headline(metric: Metric): string;
	readonly sections: readonly ReportSection[];
}

/** A scenario as the shared code sees it, whatever its job and result types. */
export type Scenario = ScenarioDefinition<Job, RunResult>;

const defined = new WeakSet<object>();

/** Marks `definition` as a scenario, so the registry takes it when its module exports it. */
export function defineScenario<J extends Job, R extends RunResult>(definition: ScenarioDefinition<J, R>): Scenario {
	defined.add(definition);
	return definition;
}

export function isScenario(value: unknown): value is Scenario {
	return typeof value === 'object' && value !== null && defined.has(value);
}
