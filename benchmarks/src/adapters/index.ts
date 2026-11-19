import type { AdapterEntry, KnownFailure } from '../adapter.ts';
import type { DatasetSpec, ScenarioName } from '../jobs.ts';
import { scenarios } from '../scenarios/index.ts';

const LWC_FAILURES: readonly KnownFailure[] = [
	{
		dataset: { kind: 'line', size: 10_000_000 },
		reason: 'the renderer crashed (likely out of memory) while loading, in all 10 stage 0 runs',
	},
];

/** The same for Lightweight Charts, whose indicators are computed in user code (`user-indicators.ts`). */
const LWC_CAPABILITIES: readonly string[] = ['indicators'];

/**
 * What lumen can do beyond `ChartAdapter` (see `AdapterEntry.capabilities`), each with the scenario
 * module that declares the interface `lumen.ts` implements for it. One a line, in alphabetical order.
 */
const LUMEN_CAPABILITIES: readonly string[] = [
	'datafeed', // refetch.ts
	'drawings', // drawings.ts
	'indicators', // indicators.ts
	'lineStyle', // line-ticks.ts
	'marks', // marks.ts
	'priceAxes', // axes-frames.ts
	'state', // state.ts
	'timeZones', // time-zones.ts
];

/**
 * Every library variant the harness can measure. To add a library, write an adapter module that
 * exports an `AdapterFactory` and add an entry here; the id is what `--lib` and `?lib=` select.
 * Entries import their module lazily, so a page only loads the library it measures.
 */
export const adapters: readonly AdapterEntry[] = [
	{
		id: 'lwc-conflation-on',
		description: 'Lightweight Charts with timeScale.enableConflation = true',
		knownFailures: LWC_FAILURES,
		capabilities: LWC_CAPABILITIES,
		load: async () => (await import('./lightweight-charts.ts')).conflationOn,
	},
	{
		id: 'lwc-conflation-off',
		description: 'Lightweight Charts with timeScale.enableConflation = false (library default)',
		knownFailures: LWC_FAILURES,
		capabilities: LWC_CAPABILITIES,
		load: async () => (await import('./lightweight-charts.ts')).conflationOff,
	},
	{
		id: 'lumen-worker',
		description: 'Lumen Charts (workspace sources) with the data engine in a worker (default)',
		capabilities: LUMEN_CAPABILITIES,
		load: async () => (await import('./lumen.ts')).lumenWorker,
	},
	{
		id: 'lumen-main',
		description: 'Lumen Charts (workspace sources) with the data engine on the main thread',
		capabilities: LUMEN_CAPABILITIES,
		load: async () => (await import('./lumen.ts')).lumenMain,
	},
];

export function findAdapter(id: string): AdapterEntry {
	const entry = adapters.find(a => a.id === id);
	if (entry === undefined) {
		throw new Error(`Unknown adapter "${id}". Known: ${adapters.map(a => a.id).join(', ')}`);
	}
	return entry;
}

/**
 * Why `adapter` is known to fail on `dataset` (in `scenario`), or null. Planners use it to leave
 * such runs out: they only repeat a failure and cost minutes each.
 */
export function knownFailure(adapter: string, dataset: DatasetSpec, scenario?: ScenarioName): string | null {
	const entry = adapters.find(a => a.id === adapter);
	const requires = scenario === undefined ? undefined : scenarios.find(s => s.name === scenario)?.requires;
	if (requires !== undefined && entry?.capabilities?.includes(requires.capability) !== true) {
		return requires.reason;
	}
	const failure = entry?.knownFailures?.find(f => f.dataset.kind === dataset.kind && f.dataset.size === dataset.size);
	return failure === undefined ? null : `known failure: ${failure.reason}`;
}
