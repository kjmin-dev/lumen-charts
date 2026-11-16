import type { AdapterEntry, KnownFailure } from '../adapter.ts';
import {
	DRAWING_SCENARIOS,
	type DatasetSpec,
	INDICATOR_SCENARIOS,
	STATE_SCENARIOS,
	type ScenarioName,
	TIME_ZONE_SCENARIOS,
} from '../jobs.ts';

const LWC_FAILURES: readonly KnownFailure[] = [
	{
		dataset: { kind: 'line', size: 10_000_000 },
		reason: 'the renderer crashed (likely out of memory) while loading, in all 10 stage 0 runs',
	},
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
		indicators: true,
		load: async () => (await import('./lightweight-charts.ts')).conflationOn,
	},
	{
		id: 'lwc-conflation-off',
		description: 'Lightweight Charts with timeScale.enableConflation = false (library default)',
		knownFailures: LWC_FAILURES,
		indicators: true,
		load: async () => (await import('./lightweight-charts.ts')).conflationOff,
	},
	{
		id: 'lumen-worker',
		description: 'Lumen Charts (workspace sources) with the data engine in a worker (default)',
		datafeed: true,
		indicators: true,
		priceAxes: true,
		drawings: true,
		state: true,
		timeZones: true,
		load: async () => (await import('./lumen.ts')).lumenWorker,
	},
	{
		id: 'lumen-main',
		description: 'Lumen Charts (workspace sources) with the data engine on the main thread',
		datafeed: true,
		indicators: true,
		priceAxes: true,
		drawings: true,
		state: true,
		timeZones: true,
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
	if (scenario === 'refetch' && entry?.datafeed !== true) {
		return 'the library cannot fetch history again from a datafeed';
	}
	if (scenario !== undefined && INDICATOR_SCENARIOS.includes(scenario) && entry?.indicators !== true) {
		return 'the adapter cannot put indicators on a series';
	}
	if (scenario === 'axes-frames' && entry?.priceAxes !== true) {
		return 'the adapter cannot lay out price axes';
	}

	if (scenario !== undefined && DRAWING_SCENARIOS.includes(scenario) && entry?.drawings !== true) {
		return 'the library has no drawings';
	}
	if (scenario !== undefined && STATE_SCENARIOS.includes(scenario) && entry?.state !== true) {
		return 'the library saves no chart state';
	}
	if (scenario !== undefined && TIME_ZONE_SCENARIOS.includes(scenario) && entry?.timeZones !== true) {
		return 'the library shows no time zones or sessions';
	}
	const failure = entry?.knownFailures?.find(f => f.dataset.kind === dataset.kind && f.dataset.size === dataset.size);
	return failure === undefined ? null : `known failure: ${failure.reason}`;
}
