import { type AnyMarkOptions, type MarkSeriesType, defaultMarkOptions } from './options';
import { checkOptions } from './series';

/** A heatmap or scatter series in a state: what it is and how it is drawn, without its data. */
export interface MarkSeriesState {
	/** The series' `id`, which a restore matches series by. */
	id: string;
	type: MarkSeriesType;
	/** Every option of the series. */
	options: AnyMarkOptions;
	/** Always 0: the chart has one pane. */
	pane: number;
	/**
	 * Place among the series of the state. Heatmaps are drawn below the other series and scatters
	 * above them whatever their place; among themselves they are drawn in this order.
	 */
	order: number;
}

/** A series of a state that was checked. */
export interface MarkSeriesPlan {
	id: string;
	type: MarkSeriesType;
	options: AnyMarkOptions;
	order: number;
}

export function isMarkType(type: unknown): type is MarkSeriesType {
	return type === 'heatmap' || type === 'scatter';
}

function fail(path: string, reason: string): never {
	throw new Error(`lumen-charts: invalid chart state: ${path} ${reason}`);
}

const CHOICES: Readonly<Record<string, readonly string[]>> = {
	valueScale: ['linear', 'log'],
	shape: ['square', 'circle'],
	barAlign: ['center', 'start'],
};

/** Every option of a series: its defaults, then what `value` sets of them, each of the right kind. */
function planOptions(type: MarkSeriesType, value: unknown, path: string): AnyMarkOptions {
	const defaults = defaultMarkOptions(type) as unknown as Record<string, unknown>;
	const options: Record<string, unknown> = { ...defaults };
	if (value === undefined) {
		return options as unknown as AnyMarkOptions;
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		fail(path, 'must be an object');
	}
	for (const [key, entry] of Object.entries(value)) {
		const at = `${path}.${key}`;
		if (!(key in defaults)) {
			fail(at, 'is not an option of the series');
		}
		if (key === 'palette') {
			if (typeof entry !== 'string' && !(Array.isArray(entry) && entry.every(color => typeof color === 'string'))) {
				fail(at, 'must be the name of a palette or an array of colors');
			}
			options[key] = Array.isArray(entry) ? [...(entry as string[])] : entry;
		} else if (key === 'valueMin' || key === 'valueMax') {
			if (entry !== null && !Number.isFinite(entry)) {
				fail(at, 'must be a finite number or null');
			}
			options[key] = entry;
		} else if (typeof defaults[key] === 'number') {
			if (!Number.isFinite(entry)) {
				fail(at, 'must be a finite number');
			}
			options[key] = entry;
		} else if (typeof entry !== typeof defaults[key]) {
			fail(at, `must be a ${typeof defaults[key]}`);
		} else if (CHOICES[key] !== undefined && !CHOICES[key].includes(entry as string)) {
			fail(at, `must be one of ${CHOICES[key].join(', ')}`);
		} else {
			options[key] = entry;
		}
	}
	try {
		checkOptions(options as unknown as AnyMarkOptions);
	} catch (error) {
		fail(path, `has a color that cannot be read (${(error as Error).message})`);
	}
	return options as unknown as AnyMarkOptions;
}

/**
 * Checks the heatmap and scatter series of a state, given as the entries of its `series` and their
 * places in it, and returns what a restore does with them. Throws for anything that is wrong;
 * `taken` are the ids of the state's other series.
 */
export function planMarkSeries(
	entries: readonly { entry: Record<string, unknown>; index: number }[],
	taken: ReadonlySet<string>,
): MarkSeriesPlan[] {
	const ids = new Set<string>();
	return entries.map(({ entry, index }) => {
		const path = `series[${index}]`;
		const id = entry.id;
		if (typeof id !== 'string' || id === '') {
			fail(`${path}.id`, 'must be a string that is not empty');
		}
		if (ids.has(id) || taken.has(id)) {
			fail(`${path}.id`, `"${id}" is used twice`);
		}
		ids.add(id);
		if (entry.pane !== undefined && entry.pane !== 0) {
			fail(`${path}.pane`, 'must be 0: the chart has one pane');
		}
		if (entry.order !== undefined && !Number.isFinite(entry.order)) {
			fail(`${path}.order`, 'must be a finite number');
		}
		const type = entry.type as MarkSeriesType;
		return {
			id,
			type,
			options: planOptions(type, entry.options, `${path}.options`),
			order: (entry.order as number | undefined) ?? index,
		};
	});
}
