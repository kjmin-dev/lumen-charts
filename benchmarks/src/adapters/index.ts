import type { AdapterEntry } from '../adapter.ts';

/**
 * Every library variant the harness can measure. To add a library, write an adapter module that
 * exports an `AdapterFactory` and add an entry here; the id is what `--lib` and `?lib=` select.
 * Entries import their module lazily, so a page only loads the library it measures.
 */
export const adapters: readonly AdapterEntry[] = [
	{
		id: 'lwc-conflation-on',
		description: 'Lightweight Charts with timeScale.enableConflation = true',
		load: async () => (await import('./lightweight-charts.ts')).conflationOn,
	},
	{
		id: 'lwc-conflation-off',
		description: 'Lightweight Charts with timeScale.enableConflation = false (library default)',
		load: async () => (await import('./lightweight-charts.ts')).conflationOff,
	},
];

export function findAdapter(id: string): AdapterEntry {
	const entry = adapters.find(a => a.id === id);
	if (entry === undefined) {
		throw new Error(`Unknown adapter "${id}". Known: ${adapters.map(a => a.id).join(', ')}`);
	}
	return entry;
}
