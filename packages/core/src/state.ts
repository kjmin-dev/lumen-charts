import { type IndicatorInfo, resolveParams } from '@lumen-charts/engine';
import { type Drawing, checkPoints } from './drawings/drawing';
import {
	DRAWING_STATE_VERSION,
	type DrawingState,
	type DrawingType,
	POINT_COUNTS,
	drawingOptions,
} from './drawings/types';
import type { SourceColumn } from './indicators';
import type { SessionSchedule, TradingSession } from './model/sessions';
import {
	BASE_OPTIONS,
	type ChartOptions,
	DEFAULT_PRICE_SCALE_ID,
	type DeepPartial,
	type HistogramOptions,
	type LineOptions,
	type LocalizationOptions,
} from './options';
import type { PriceRange } from './price-axes';
import { type AnySeriesOptions, type SeriesType, defaultSeriesOptions } from './series';

/**
 * Version of `ChartState`. `ChartApi.restoreState` refuses a state of another version; the drawings
 * in it carry `DRAWING_STATE_VERSION`, which changes on its own.
 */
export const CHART_STATE_VERSION = 1;

/** The sections of a `ChartState`, for saving or restoring some of them. */
export type ChartStatePart = 'options' | 'series' | 'indicators' | 'drawings' | 'view';

export const CHART_STATE_PARTS: readonly ChartStatePart[] = ['options', 'series', 'indicators', 'drawings', 'view'];

/** Options of `ChartApi.saveState` and `ChartApi.restoreState`. */
export interface ChartStateSelection {
	/**
	 * The sections to save or restore. Default: all of them when saving, and every section the state
	 * has when restoring. What is left out stays as it is on the chart.
	 */
	parts?: readonly ChartStatePart[];
}

/** Options that belong to the page the chart is on rather than to what it shows: never saved. */
export const ENVIRONMENT_OPTIONS = ['width', 'height', 'autoSize', 'worker', 'memoryLimit'] as const;

/**
 * The chart options a state holds: the ones applied to the chart (not the defaults or the theme's
 * colors under them), without what cannot be saved or belongs to the page: the size (`width`,
 * `height`, `autoSize`), `worker`, `memoryLimit` and the formatter functions of `localization`.
 */
export type ChartStateOptions = DeepPartial<
	Omit<ChartOptions, (typeof ENVIRONMENT_OPTIONS)[number] | 'localization'> & {
		localization: Pick<LocalizationOptions, 'timeZone' | 'locale'>;
	}
>;

/** A series in a state: what it is and how it is drawn, without its bars. */
export interface SeriesState {
	/** The series' `id`, which a restore matches series by. */
	id: string;
	type: SeriesType;
	/** Every option of the series, `priceScaleId` among them. */
	options: AnySeriesOptions;
	/** Pane it is drawn on; 0, the price pane. */
	pane: number;
	/** Place in the drawing order among series and indicators: lower is drawn first, below. */
	order: number;
}

/** A series an indicator reads, by id: a series of the chart, or an output of an earlier indicator. */
export type SeriesReference = { series: string } | { indicator: string; output: string };

/** One input of an indicator in a state (see `IndicatorInput`). */
export type IndicatorInputState =
	| SourceColumn
	| { series: string; column: SourceColumn }
	| { indicator: string; output: string };

/** An indicator in a state. Its values are computed again from the bars. */
export interface IndicatorState {
	/** The indicator's `id`. */
	id: string;
	/** Name of its definition: a built-in, or one registered with `registerIndicators`. */
	name: string;
	/** What it was added to. */
	source: SeriesReference;
	/** Every parameter by name. */
	params: Record<string, number>;
	/** One entry per input of the definition. */
	inputs: IndicatorInputState[];
	/** Every option of each output's series, by output name. */
	outputs: Record<string, LineOptions | HistogramOptions>;
	/** The indicator's `priceScaleId` option. */
	priceScaleId: string;
	/** Place in the drawing order (see `SeriesState.order`). */
	order: number;
}

/** What the chart shows of its timeline and price scales. */
export interface ViewState {
	/**
	 * Times (UTC milliseconds) at the left and right edge of the pane, so the view is found again by
	 * time whatever history is loaded. Null when the chart had no bars.
	 */
	timeRange: { from: number; to: number } | null;
	/**
	 * The range of each price scale that does not autoscale (see `PriceScaleApi.getVisibleRange`), by
	 * scale id.
	 */
	priceRanges: Record<string, PriceRange>;
}

/**
 * Plain-JSON state of a chart: what the user configured, without bars. `ChartApi.saveState` returns
 * it and `ChartApi.restoreState` takes it back. Stable across versions of the library while
 * `version` is the same; keys added later are optional.
 */
export interface ChartState {
	version: typeof CHART_STATE_VERSION;
	options?: ChartStateOptions;
	series?: SeriesState[];
	indicators?: IndicatorState[];
	drawings?: DrawingState[];
	view?: ViewState;
}

/** A drawing of a state, checked: what `Drawing` is made from. */
export type DrawingPlan = ConstructorParameters<typeof Drawing>[1];

export interface SeriesPlan {
	id: string;
	type: SeriesType;
	options: AnySeriesOptions;
	order: number;
}

export interface IndicatorPlan {
	id: string;
	info: IndicatorInfo;
	source: SeriesReference;
	params: Record<string, number>;
	inputs: (IndicatorInputState | undefined)[];
	outputs: Record<string, LineOptions | HistogramOptions>;
	priceScaleId: string;
	order: number;
}

/** A state that passed every check, section by section; null for a section that is not restored. */
export interface RestorePlan {
	options: ChartStateOptions | null;
	series: SeriesPlan[] | null;
	indicators: IndicatorPlan[] | null;
	drawings: DrawingPlan[] | null;
	view: ViewState | null;
}

/** What checking a state needs to know of the chart it is restored into. */
export interface RestoreContext {
	/** The definition of an indicator by name, if the chart knows it. */
	definition(name: string): IndicatorInfo | undefined;
	/** Ids of the chart's series, for indicators restored without the series section. */
	seriesIds(): string[];
	/** Options an indicator output has when its state sets none. */
	outputDefaults(info: IndicatorInfo, output: number): LineOptions | HistogramOptions;
}

type Plain = Record<string, unknown>;

function isPlain(value: unknown): value is Plain {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(path: string, reason: string): never {
	throw new Error(`lumen-charts: invalid chart state: ${path} ${reason}`);
}

const LINE_STYLES = ['solid', 'dotted', 'dashed'];
const SCALE_MODES = ['normal', 'logarithmic', 'percentage', 'indexed'];
const ALIGNMENTS = ['left', 'center', 'right'];

/** Values of the options that take one of a few strings, by key; `crosshair.mode` by its path. */
const CHOICES: Readonly<Record<string, readonly string[]>> = {
	theme: ['light', 'dark', 'auto'],
	style: LINE_STYLES,
	lineStyle: LINE_STYLES,
	priceLineStyle: LINE_STYLES,
	lineType: ['simple', 'step'],
	position: ['left', 'right'],
	horzAlign: ALIGNMENTS,
	vertAlign: ['top', 'center', 'bottom'],
	mode: SCALE_MODES,
	'crosshair.mode': ['normal', 'magnet', 'hidden'],
};

const SOURCE_COLUMN_NAMES: readonly string[] = ['time', 'open', 'high', 'low', 'close', 'volume', 'value'];
const SERIES_TYPES: readonly string[] = ['candlestick', 'line', 'histogram'];

/** Where a value is in a state, for an error: made only when there is one, as most values are right. */
type Where = () => string;

/**
 * Copy of `value` with the keys `template` has, each holding a value of the kind it holds there: a
 * finite number, a string (one of its choices, where it has some), a boolean, an array of finite
 * numbers, or an object checked the same way. Keys the template lacks are left out, and so are those
 * it holds null for, which are not saved. A value of another kind throws when `strict`, and is left
 * out otherwise. `where` says where `value` is, and `parent` is the key it is under. Written into
 * `result` when given, over what it holds.
 */
function conform(
	value: unknown,
	template: Plain,
	where: Where,
	strict: boolean,
	parent = '',
	result: Plain = {},
): Plain {
	if (!isPlain(value)) {
		if (strict) {
			fail(where(), 'must be an object');
		}
		return result;
	}
	// The template's keys, read from the value: a key of the value the template lacks is never looked at.
	for (const key in template) {
		const given = value[key];
		if (given === undefined || !Object.hasOwn(value, key)) {
			continue;
		}
		const model = template[key];
		let kind: string;
		if (typeof model === 'number') {
			if (typeof given === 'number' && Number.isFinite(given)) {
				result[key] = given;
				continue;
			}
			kind = 'a finite number';
		} else if (typeof model === 'string') {
			const choices = CHOICES[key === 'mode' && parent === 'crosshair' ? 'crosshair.mode' : key];
			if (typeof given === 'string' && (choices === undefined || choices.includes(given))) {
				result[key] = given;
				continue;
			}
			kind = choices === undefined ? 'a string' : `one of ${choices.join(', ')}`;
		} else if (typeof model === 'boolean') {
			if (typeof given === 'boolean') {
				result[key] = given;
				continue;
			}
			kind = 'a boolean';
		} else if (Array.isArray(model)) {
			if (Array.isArray(given) && given.every(item => typeof item === 'number' && Number.isFinite(item))) {
				result[key] = [...(given as number[])];
				continue;
			}
			kind = 'an array of finite numbers';
		} else if (isPlain(model)) {
			if (isPlain(given)) {
				result[key] = conform(given, model, () => `${where()}.${key}`, strict, key);
				continue;
			}
			kind = 'an object';
		} else {
			continue;
		}
		if (strict) {
			fail(`${where()}.${key}`, `must be ${kind}`);
		}
	}
	return result;
}

/** A session schedule, or the keys of one, checked for shape; its times are checked when it is compiled. */
function conformSchedule(value: unknown, where: Where, strict: boolean): Partial<SessionSchedule> | undefined {
	if (!isPlain(value)) {
		if (strict) {
			fail(where(), 'must be an object');
		}
		return undefined;
	}
	const result: Partial<SessionSchedule> = {};
	const bad = (key: string, kind: string): void => {
		if (strict) {
			fail(`${where()}.${key}`, `must be ${kind}`);
		}
	};
	const { timeZone, days, hours, holidays } = value;
	if (typeof timeZone === 'string') {
		result.timeZone = timeZone;
	} else if (timeZone !== undefined) {
		bad('timeZone', 'a string');
	}
	if (Array.isArray(days) && days.every(day => Number.isFinite(day))) {
		result.days = [...(days as number[])];
	} else if (days !== undefined) {
		bad('days', 'an array of numbers');
	}
	if (
		Array.isArray(hours) &&
		hours.every(
			session =>
				isPlain(session) &&
				typeof session.start === 'string' &&
				typeof session.end === 'string' &&
				(session.kind === undefined || typeof session.kind === 'string'),
		)
	) {
		result.hours = (hours as TradingSession[]).map(session =>
			session.kind === undefined
				? { start: session.start, end: session.end }
				: { start: session.start, end: session.end, kind: session.kind },
		);
	} else if (hours !== undefined) {
		bad('hours', 'an array of sessions with a start and an end');
	}
	if (Array.isArray(holidays) && holidays.every(day => typeof day === 'string')) {
		result.holidays = [...(holidays as string[])];
	} else if (holidays !== undefined) {
		bad('holidays', 'an array of dates');
	}
	return result;
}

/** What chart options are checked against: the defaults, without what a state does not hold. */
const OPTIONS_TEMPLATE: Plain = (() => {
	const template: Plain = { ...BASE_OPTIONS };
	for (const key of ENVIRONMENT_OPTIONS) {
		delete template[key];
	}
	// Scales by ids of the user's choosing, and the schedule with its arrays: checked on their own.
	delete template.priceScales;
	template.sessions = { ...BASE_OPTIONS.sessions, schedule: null };
	return template;
})();

/**
 * The part of chart options a state holds, from options as they were applied (`strict` off: what
 * cannot be saved is left out) or from a state (`strict`: a value of the wrong kind throws).
 */
export function chartStateOptions(input: unknown, strict: boolean): ChartStateOptions {
	const path = 'options';
	const result = conform(input, OPTIONS_TEMPLATE, () => path, strict);
	if (!isPlain(input)) {
		return result;
	}
	const scales = input.priceScales;
	if (isPlain(scales)) {
		const kept: Plain = {};
		for (const id of Object.keys(scales)) {
			if (id !== DEFAULT_PRICE_SCALE_ID && scales[id] !== undefined) {
				kept[id] = conform(
					scales[id],
					BASE_OPTIONS.priceScale as unknown as Plain,
					() => `${path}.priceScales.${id}`,
					strict,
				);
			}
		}
		result.priceScales = kept;
	} else if (scales !== undefined && strict) {
		fail(`${path}.priceScales`, 'must be an object');
	}
	const sessions = input.sessions;
	if (isPlain(sessions) && sessions.schedule !== undefined) {
		const schedule = conformSchedule(sessions.schedule, () => `${path}.sessions.schedule`, strict);
		if (schedule !== undefined) {
			(result.sessions as Plain).schedule = schedule;
		}
	}
	return result;
}

/** Every option of a series: its defaults, then what `value` sets of them. */
function seriesOptions(defaults: object, value: unknown, where: Where): AnySeriesOptions {
	return {
		...defaults,
		...(value === undefined ? undefined : conform(value, defaults as Plain, where, true)),
	} as unknown as AnySeriesOptions;
}

function identifier(value: unknown, where: Where, taken: Set<string>): string {
	if (typeof value !== 'string' || value === '') {
		fail(`${where()}.id`, 'must be a string that is not empty');
	}
	if (taken.has(value)) {
		fail(`${where()}.id`, `"${value}" is used twice`);
	}
	taken.add(value);
	return value;
}

function list(value: unknown, path: string): unknown[] {
	if (!Array.isArray(value)) {
		fail(path, 'must be an array');
	}
	return value;
}

function order(value: unknown, path: string, fallback: number): number {
	if (value === undefined) {
		return fallback;
	}
	if (!Number.isFinite(value)) {
		fail(path, 'must be a finite number');
	}
	return value as number;
}

function planSeries(value: unknown): SeriesPlan[] {
	const ids = new Set<string>();
	return list(value, 'series').map((entry, i) => {
		const path = `series[${i}]`;
		if (!isPlain(entry)) {
			fail(path, 'must be an object');
		}
		const type = entry.type;
		if (typeof type !== 'string' || !SERIES_TYPES.includes(type)) {
			fail(`${path}.type`, `must be one of ${SERIES_TYPES.join(', ')}`);
		}
		if (entry.pane !== undefined && entry.pane !== 0) {
			fail(`${path}.pane`, 'must be 0: the chart has one pane');
		}
		return {
			id: identifier(entry.id, () => path, ids),
			type: type as SeriesType,
			options: seriesOptions(defaultSeriesOptions(type as SeriesType), entry.options, () => `${path}.options`),
			order: order(entry.order, `${path}.order`, i),
		};
	});
}

function planIndicators(value: unknown, seriesIds: ReadonlySet<string>, context: RestoreContext): IndicatorPlan[] {
	const ids = new Set<string>();
	/** Output names of the indicators before the one being checked: it may read only those. */
	const earlier = new Map<string, readonly string[]>();
	const reference = (ref: Plain, path: string): void => {
		if (typeof ref.indicator === 'string') {
			const outputs = earlier.get(ref.indicator);
			if (outputs === undefined) {
				fail(path, `reads indicator "${ref.indicator}", which is not listed before it`);
			}
			if (typeof ref.output !== 'string' || !outputs.includes(ref.output)) {
				fail(path, `reads output "${String(ref.output)}", which indicator "${ref.indicator}" does not have`);
			}
		} else if (typeof ref.series !== 'string') {
			fail(path, 'must name a series or an indicator');
		} else if (!seriesIds.has(ref.series)) {
			fail(path, `reads series "${ref.series}", which the chart would not have`);
		}
	};
	return list(value, 'indicators').map((entry, i) => {
		const path = `indicators[${i}]`;
		if (!isPlain(entry)) {
			fail(path, 'must be an object');
		}
		const id = identifier(entry.id, () => path, ids);
		const name = entry.name;
		const info = typeof name === 'string' ? context.definition(name) : undefined;
		if (info === undefined) {
			fail(
				`${path}.name`,
				`"${String(name)}" is not an indicator the chart knows: register custom indicators with registerIndicators before restoring`,
			);
		}
		const source = entry.source;
		if (!isPlain(source)) {
			fail(`${path}.source`, 'must name a series or an indicator');
		}
		reference(source, `${path}.source`);
		const given = entry.params ?? {};
		if (!isPlain(given)) {
			fail(`${path}.params`, 'must be an object');
		}
		const params: Record<string, number> = {};
		for (const param of info.params) {
			const number = given[param.name];
			if (number !== undefined) {
				if (typeof number !== 'number') {
					fail(`${path}.params.${param.name}`, 'must be a number');
				}
				params[param.name] = number;
			}
		}
		// Throws a RangeError for a parameter out of its bounds; the others take their defaults.
		const resolved = resolveParams(info.params, params);
		info.params.forEach((param, k) => {
			params[param.name] = resolved[k]!;
		});
		const inputs = list(entry.inputs ?? [], `${path}.inputs`)
			.slice(0, info.inputs.length)
			.map((input, k): IndicatorInputState | undefined => {
				const at = `${path}.inputs[${k}]`;
				if (input === undefined || input === null) {
					return undefined;
				}
				if (typeof input === 'string') {
					if (!SOURCE_COLUMN_NAMES.includes(input)) {
						fail(at, `must be one of ${SOURCE_COLUMN_NAMES.join(', ')}`);
					}
					return input as SourceColumn;
				}
				if (!isPlain(input)) {
					fail(at, 'must be a column, a series or an indicator output');
				}
				reference(input, at);
				if (typeof input.indicator === 'string') {
					return { indicator: input.indicator, output: input.output as string };
				}
				const column = input.column ?? info.inputs[k];
				if (typeof column !== 'string' || !SOURCE_COLUMN_NAMES.includes(column)) {
					fail(`${at}.column`, `must be one of ${SOURCE_COLUMN_NAMES.join(', ')}`);
				}
				return { series: input.series as string, column: column as SourceColumn };
			});
		const styles = entry.outputs ?? {};
		if (!isPlain(styles)) {
			fail(`${path}.outputs`, 'must be an object');
		}
		const outputs: Record<string, LineOptions | HistogramOptions> = {};
		info.outputs.forEach((output, k) => {
			outputs[output.name] = seriesOptions(
				context.outputDefaults(info, k),
				styles[output.name],
				() => `${path}.outputs.${output.name}`,
			) as LineOptions | HistogramOptions;
		});
		const priceScaleId = entry.priceScaleId ?? '';
		if (typeof priceScaleId !== 'string') {
			fail(`${path}.priceScaleId`, 'must be a string');
		}
		earlier.set(
			id,
			info.outputs.map(output => output.name),
		);
		return {
			id,
			info,
			source:
				typeof source.indicator === 'string'
					? { indicator: source.indicator, output: source.output as string }
					: { series: source.series as string },
			params,
			inputs,
			outputs,
			priceScaleId,
			order: order(entry.order, `${path}.order`, i),
		};
	});
}

const DRAWING_OPTIONS_TEMPLATE = drawingOptions('trendLine', undefined) as unknown as Plain;

function planDrawings(value: unknown): DrawingPlan[] {
	const ids = new Set<string>();
	const entries = list(value, 'drawings');
	const plans: DrawingPlan[] = [];
	// A thousand drawings is common: nothing is made for an error message unless there is an error.
	let i = 0;
	const where: Where = () => `drawings[${i}]`;
	const options: Where = () => `drawings[${i}].options`;
	for (; i < entries.length; i++) {
		const entry = entries[i];
		if (!isPlain(entry)) {
			fail(where(), 'must be an object');
		}
		const { version, type, zIndex, pane, priceScaleId } = entry;
		if (version !== undefined && version !== DRAWING_STATE_VERSION) {
			fail(
				`${where()}.version`,
				`${String(version)} is not supported: this version of the library reads version ${DRAWING_STATE_VERSION}`,
			);
		}
		if (typeof type !== 'string' || !Object.hasOwn(POINT_COUNTS, type)) {
			fail(`${where()}.type`, `"${String(type)}" is not a drawing type`);
		}
		if (zIndex !== undefined && !Number.isFinite(zIndex)) {
			fail(`${where()}.zIndex`, 'must be a finite number');
		}
		if (pane !== undefined && pane !== 0) {
			fail(`${where()}.pane`, 'must be 0: the chart has one pane');
		}
		if (priceScaleId !== undefined && (typeof priceScaleId !== 'string' || priceScaleId === '')) {
			fail(`${where()}.priceScaleId`, 'must be a string that is not empty');
		}
		const id = identifier(entry.id, where, ids);
		const points = entry.points as DrawingState['points'];
		try {
			checkPoints(points, POINT_COUNTS[type as DrawingType], type as DrawingType);
		} catch (error) {
			fail(where(), `is not a drawing: ${(error as Error).message.replace('lumen-charts: ', '')}`);
		}
		// The defaults of the tool, then what the state sets, in one object.
		const style = drawingOptions(type as DrawingType, undefined);
		if (entry.options !== undefined) {
			conform(entry.options, DRAWING_OPTIONS_TEMPLATE, options, true, '', style as unknown as Plain);
		}
		plans.push({
			id,
			type: type as DrawingType,
			// Read once, when the drawing is made right after the checks: no copy.
			points,
			options: style,
			zIndex: (zIndex as number | undefined) ?? 0,
			pane: 0,
			priceScaleId: (priceScaleId as string | undefined) ?? DEFAULT_PRICE_SCALE_ID,
		});
	}
	return plans;
}

function planView(value: unknown): ViewState {
	if (!isPlain(value)) {
		fail('view', 'must be an object');
	}
	const range = (entry: unknown, path: string): { from: number; to: number } => {
		if (!isPlain(entry) || !Number.isFinite(entry.from) || !Number.isFinite(entry.to)) {
			fail(path, 'must have a finite from and to');
		}
		if (!((entry.from as number) < (entry.to as number))) {
			fail(path, 'must have its from below its to');
		}
		return { from: entry.from as number, to: entry.to as number };
	};
	const timeRange = value.timeRange ?? null;
	const prices = value.priceRanges ?? {};
	if (!isPlain(prices)) {
		fail('view.priceRanges', 'must be an object');
	}
	const priceRanges: Record<string, PriceRange> = {};
	for (const id of Object.keys(prices)) {
		priceRanges[id] = range(prices[id], `view.priceRanges.${id}`);
	}
	return { timeRange: timeRange === null ? null : range(timeRange, 'view.timeRange'), priceRanges };
}

/**
 * Checks a state from storage or the network, all of it before anything is restored: its version,
 * the kind of every value, that ids are unique and that every series, indicator and output an
 * indicator reads is there. Throws an `Error` that says where the state is wrong (a `RangeError` for
 * an indicator parameter out of bounds). Returns the sections to restore, with defaults filled in.
 */
export function planRestore(
	state: unknown,
	parts: readonly ChartStatePart[] | undefined,
	context: RestoreContext,
): RestorePlan {
	if (!isPlain(state)) {
		throw new Error('lumen-charts: invalid chart state: it must be an object');
	}
	if (state.version !== CHART_STATE_VERSION) {
		throw new Error(
			`lumen-charts: chart state version ${String(state.version)} is not supported: ` +
				`this version of the library reads version ${CHART_STATE_VERSION}`,
		);
	}
	if (parts !== undefined) {
		if (!Array.isArray(parts)) {
			throw new Error('lumen-charts: parts must be an array');
		}
		for (const part of parts) {
			if (!CHART_STATE_PARTS.includes(part)) {
				throw new Error(`lumen-charts: "${String(part)}" is not a part of a chart state`);
			}
		}
	}
	const wanted = (part: ChartStatePart): boolean =>
		state[part] !== undefined && state[part] !== null && (parts === undefined || parts.includes(part));
	const series = wanted('series') ? planSeries(state.series) : null;
	let indicators: IndicatorPlan[] | null = null;
	if (wanted('indicators')) {
		const ids = new Set(series === null ? context.seriesIds() : series.map(entry => entry.id));
		indicators = planIndicators(state.indicators, ids, context);
	}
	return {
		options: wanted('options') ? chartStateOptions(state.options, true) : null,
		series,
		indicators,
		drawings: wanted('drawings') ? planDrawings(state.drawings) : null,
		view: wanted('view') ? planView(state.view) : null,
	};
}
