import {
	BUILTIN_INDICATORS,
	type EngineClient,
	type IndicatorInfo,
	type IndicatorInputRef,
	type PluginResult,
	SOURCE_COLUMNS,
	indicatorInfo,
	resolveParams,
} from '@lumen-charts/engine';
import { INVALIDATE_LIGHT } from './model/invalidation';
import { type DeepPartial, type HistogramOptions, type LineOptions, definedOnly, shallowEqual } from './options';
import type { SeriesRenderer } from './primitives';
import { type AnySeriesOptions, Series, type SeriesApi, type SeriesHost, defaultSeriesOptions } from './series';
import type { IndicatorInputState, IndicatorPlan, IndicatorState, SeriesReference } from './state';

/** A column of a series an indicator input can read. On a line or histogram, every price name reads its value. */
export type SourceColumn = 'time' | 'open' | 'high' | 'low' | 'close' | 'volume' | 'value';

/**
 * Where one input of an indicator reads from: a column of the indicator's source, a column of
 * another series, or the values of another indicator's output (a chain).
 */
export type IndicatorInput = SourceColumn | { series: SeriesApi; column?: SourceColumn } | IndicatorOutputApi;

/** Options of an output's series: a line or a histogram, as the indicator defines it. */
export type IndicatorOutputOptions = Partial<LineOptions> | Partial<HistogramOptions>;

export interface IndicatorOptions {
	/**
	 * Name of the indicator in saved state (see `ChartApi.saveState`), unique among the chart's
	 * indicators. Set when the indicator is added and kept from then on; without one it is named
	 * `indicator-1`, `indicator-2`, ... in the order indicators are added.
	 */
	id: string;
	/** Parameters by name. Omitted ones take the definition's defaults. */
	params: Record<string, number>;
	/**
	 * One entry per input of the definition, in its order. Omitted ones read the definition's default
	 * column of the source.
	 */
	inputs: IndicatorInput[];
	/** Options of each output's series, by output name. */
	outputs: Record<string, IndicatorOutputOptions>;
	/**
	 * Price scale of the outputs (see `SeriesOptionsCommon.priceScaleId`), for example one of their
	 * own for an oscillator. Setting it moves every output; a `priceScaleId` in `outputs` moves that
	 * output alone, and wins within the same call. Empty (the default): the scale the source series
	 * was on when the indicator was added.
	 */
	priceScaleId: string;
}

/** One output of an indicator: a series on the main timeline, computed in the data engine. */
export interface IndicatorOutputApi {
	readonly name: string;
	/** How the output is drawn. */
	readonly type: 'line' | 'histogram';
	readonly indicator: IndicatorApi;
	applyOptions(options: IndicatorOutputOptions): void;
	options(): Readonly<LineOptions | HistogramOptions>;
	/** The latest value, NaN while there is none. */
	lastValue(): number;
	/** Adds an indicator computed from this output's values. */
	addIndicator(name: string, options?: DeepPartial<IndicatorOptions>): IndicatorApi;
	/** Draws the output with `renderer` instead of a line or histogram; null goes back to that. */
	setRenderer(renderer: SeriesRenderer | null): void;
}

/**
 * An indicator computed in the data engine. Its outputs are series on the main timeline, drawn on
 * the price pane and included in autoscale; they update with every tick of their inputs.
 */
export interface IndicatorApi {
	/** Name of the indicator in saved state: the `id` option it was added with, or the one it was given. */
	readonly id: string;
	readonly name: string;
	/** The definition: inputs, outputs and parameters with their defaults and bounds. */
	info(): IndicatorInfo;
	/**
	 * Changes parameters, inputs or output styles. New parameters or inputs recompute the indicator
	 * in the background; the old values stay on screen until the new ones are ready. Throws a
	 * `RangeError` for a parameter out of bounds.
	 */
	applyOptions(options: DeepPartial<IndicatorOptions>): void;
	options(): Readonly<IndicatorOptions>;
	/** The output with this name, or the first one. */
	output(name?: string): IndicatorOutputApi;
	outputs(): readonly IndicatorOutputApi[];
	/** Removes the indicator, and every indicator that reads its outputs. */
	remove(): void;
}

/** What indicators need from the chart. */
export interface IndicatorHost extends SeriesHost {
	removeIndicator(indicator: IndicatorApi): void;
}

/** Every option an output's series starts with. */
export function outputSeriesDefaults(info: IndicatorInfo, output: number): LineOptions | HistogramOptions {
	const definition = info.outputs[output]!;
	return {
		...defaultSeriesOptions(definition.style === 'histogram' ? 'histogram' : 'line'),
		...outputDefaults(definition),
	} as LineOptions | HistogramOptions;
}

/** Defaults of the options of an output, from its definition. */
function outputDefaults(info: IndicatorInfo['outputs'][number]): Partial<AnySeriesOptions> {
	const color = info.color ?? '#2962ff';
	if (info.style === 'histogram') {
		return { color, negativeColor: '#ef5350', priceLineVisible: false };
	}
	return { color, lineWidth: 1.5, priceLineVisible: false, crosshairMarkerVisible: false };
}

/** Definitions the chart knows, by name: the built-ins, then those registered from plugin modules. */
export function builtinInfos(): Map<string, IndicatorInfo> {
	const map = new Map<string, IndicatorInfo>();
	for (const definition of BUILTIN_INDICATORS) {
		map.set(definition.name, indicatorInfo(definition));
	}
	return map;
}

class IndicatorOutput implements IndicatorOutputApi {
	public readonly name: string;
	public readonly indicator: Indicator;
	public readonly series: Series;

	public constructor(indicator: Indicator, name: string, series: Series) {
		this.indicator = indicator;
		this.name = name;
		this.series = series;
	}

	public get type(): 'line' | 'histogram' {
		return this.series.type === 'histogram' ? 'histogram' : 'line';
	}

	public applyOptions(options: IndicatorOutputOptions): void {
		this.series.applyOptions(options);
	}

	public options(): Readonly<LineOptions | HistogramOptions> {
		return this.series.seriesOptions as LineOptions | HistogramOptions;
	}

	public lastValue(): number {
		return this.series.lastValue;
	}

	public addIndicator(name: string, options?: DeepPartial<IndicatorOptions>): IndicatorApi {
		return this.indicator.host.addIndicator(this.series, name, options);
	}

	public setRenderer(renderer: SeriesRenderer | null): void {
		this.series.setRenderer(renderer);
	}
}

/**
 * An indicator on the main thread: the definition's metadata, the inputs resolved to series ids,
 * and one derived series per output. The values live in the data engine.
 */
export class Indicator implements IndicatorApi {
	public readonly definition: IndicatorInfo;
	public readonly host: IndicatorHost;
	public readonly id: string;
	/** Engine id of the instance. */
	public readonly engineId: number;
	/** The series (or derived output series) the indicator was added to. */
	public readonly source: Series;
	public readonly outputList: IndicatorOutput[] = [];
	private _params: Float64Array;
	private _inputs: IndicatorInput[];
	private _refs: IndicatorInputRef[];
	private _priceScaleId: string;
	/** Scale of the source when the indicator was added, for outputs that name none. */
	private readonly _sourceScaleId: string;
	private readonly _resolve: (input: IndicatorInput, index: number) => IndicatorInputRef;

	public constructor(
		host: IndicatorHost,
		engine: EngineClient | null,
		info: IndicatorInfo,
		source: Series,
		options: DeepPartial<IndicatorOptions>,
		resolve: (input: IndicatorInput, index: number) => IndicatorInputRef,
		id: string,
	) {
		this.host = host;
		this.id = id;
		this.definition = info;
		this.source = source;
		this._resolve = resolve;
		this._params = resolveParams(info.params, (options.params ?? {}) as Record<string, number>);
		this._inputs = this._inputsWith((options.inputs ?? []) as IndicatorInput[]);
		this._refs = this._inputs.map((input, i) => resolve(input, i));
		this._priceScaleId = options.priceScaleId ?? '';
		this._sourceScaleId = source.seriesOptions.priceScaleId;
		const created = engine?.addIndicator(info.name, Array.from(this._params), this._refs, info.outputs.length);
		this.engineId = created?.id ?? -1;
		info.outputs.forEach((output, i) => {
			const style = (options.outputs?.[output.name] ?? {}) as IndicatorOutputOptions;
			const series = new Series(
				host,
				created?.outputs[i] ?? -1,
				output.style === 'histogram' ? 'histogram' : 'line',
				{
					...outputDefaults(output),
					priceScaleId: this._outputScaleId(),
					...definedOnly(style as Partial<AnySeriesOptions>),
				},
				true,
			);
			this.outputList.push(new IndicatorOutput(this, output.name, series));
		});
	}

	public get name(): string {
		return this.definition.name;
	}

	/** Series ids every input reads. */
	public get refs(): readonly IndicatorInputRef[] {
		return this._refs;
	}

	public info(): IndicatorInfo {
		return this.definition;
	}

	public applyOptions(options: DeepPartial<IndicatorOptions>): void {
		const info = this.definition;
		let changed = false;
		if (options.params !== undefined) {
			const current: Record<string, number> = {};
			info.params.forEach((param, i) => {
				current[param.name] = this._params[i]!;
			});
			const params = resolveParams(info.params, {
				...current,
				...definedOnly(options.params as Record<string, number>),
			});
			if (params.some((value, i) => value !== this._params[i])) {
				this._params = params;
				changed = true;
			}
		}
		if (options.inputs !== undefined) {
			const inputs = this._inputsWith(options.inputs as IndicatorInput[]);
			const refs = inputs.map((input, i) => this._resolve(input, i));
			if (refs.some((ref, i) => ref.series !== this._refs[i]!.series || ref.column !== this._refs[i]!.column)) {
				this._refs = refs;
				changed = true;
			}
			this._inputs = inputs;
		}
		let restyled = false;
		if (options.priceScaleId !== undefined && options.priceScaleId !== this._priceScaleId) {
			this._priceScaleId = options.priceScaleId;
			const priceScaleId = this._outputScaleId();
			for (const output of this.outputList) {
				output.series.seriesOptions = { ...output.series.seriesOptions, priceScaleId };
			}
			restyled = true;
		}
		for (const output of this.outputList) {
			const style = options.outputs?.[output.name];
			if (style !== undefined) {
				const next = { ...output.series.seriesOptions, ...definedOnly(style as Partial<AnySeriesOptions>) };
				if (!shallowEqual(output.series.seriesOptions, next as AnySeriesOptions)) {
					output.series.seriesOptions = next as AnySeriesOptions;
					restyled = true;
				}
			}
		}
		if (changed) {
			this.host.engine()?.updateIndicator(
				this.engineId,
				info.name,
				Array.from(this._params),
				this._refs,
				this.outputList.map(output => output.series.engineId),
			);
		}
		if (changed || restyled) {
			this.host.invalidate(INVALIDATE_LIGHT);
		}
	}

	public options(): Readonly<IndicatorOptions> {
		const params: Record<string, number> = {};
		this.definition.params.forEach((param, i) => {
			params[param.name] = this._params[i]!;
		});
		const outputs: Record<string, IndicatorOutputOptions> = {};
		for (const output of this.outputList) {
			outputs[output.name] = output.options();
		}
		return { id: this.id, params, inputs: [...this._inputs], outputs, priceScaleId: this._priceScaleId };
	}

	public output(name?: string): IndicatorOutputApi {
		const output = name === undefined ? this.outputList[0] : this.outputList.find(entry => entry.name === name);
		if (output === undefined) {
			throw new Error(`Indicator "${this.name}" has no output "${String(name)}"`);
		}
		return output;
	}

	public outputs(): readonly IndicatorOutputApi[] {
		return this.outputList;
	}

	public remove(): void {
		this.host.removeIndicator(this);
	}

	/** Scale of outputs that name none of their own. */
	private _outputScaleId(): string {
		return this._priceScaleId === '' ? this._sourceScaleId : this._priceScaleId;
	}

	/** Inputs given, then the definition's default columns for the rest. */
	private _inputsWith(given: readonly (IndicatorInput | undefined)[]): IndicatorInput[] {
		return this.definition.inputs.map((column, i) => given[i] ?? (column as SourceColumn));
	}
}

/** The derived series behind an output handle, or null for anything else. */
export function outputSeries(value: unknown): Series | null {
	return value instanceof IndicatorOutput ? value.series : null;
}

/** Column number a source column name reads in a series of `kind`. */
export function columnOf(kind: 'ohlcv' | 'line', column: SourceColumn): number {
	if (!(column in SOURCE_COLUMNS)) {
		throw new Error(`Unknown column "${String(column)}"`);
	}
	if (column === 'time') {
		return 0;
	}
	if (kind === 'line') {
		// One value column; a line has no volume.
		return column === 'volume' ? 5 : 1;
	}
	return SOURCE_COLUMNS[column]!;
}

/** What the chart's indicator list needs from the chart. */
export interface ChartIndicatorsHost extends IndicatorHost {
	/** The chart's series in drawing order, derived ones included; outputs are added and removed here. */
	readonly seriesList: Series[];
	/** The data engine, created if there is none yet (null once the chart is destroyed). */
	ensureEngine(): EngineClient | null;
	/** Forgets what the window cache holds of a series. */
	forget(series: number): void;
	/** An output series is gone: its primitives are detached. */
	seriesRemoved(series: Series): void;
	/** URL relative module URLs are resolved against. */
	baseUrl(): string;
}

/**
 * The indicators of a chart: definitions by name, instances in creation order (an indicator reads
 * only earlier ones, which keeps the engine's order topological), and modules being loaded.
 */
export class ChartIndicators {
	/** Indicators the engine is still computing, from the latest event. */
	public computing = 0;
	private readonly _host: ChartIndicatorsHost;
	private readonly _list: Indicator[] = [];
	private readonly _definitions = builtinInfos();
	/** Indicators named by the chart so far (see `IndicatorOptions.id`). */
	private _named = 0;
	private readonly _plugins = new Map<
		string,
		{ resolve: (infos: IndicatorInfo[]) => void; reject: (error: Error) => void }[]
	>();

	public constructor(host: ChartIndicatorsHost) {
		this._host = host;
	}

	public add(source: unknown, name: string, options: DeepPartial<IndicatorOptions>): IndicatorApi {
		const info = this._definitions.get(name);
		if (info === undefined) {
			throw new Error(`Unknown indicator "${name}": register it with registerIndicators first`);
		}
		const series = outputSeries(source) ?? (source instanceof Series ? source : null);
		if (series === null || !this._host.seriesList.includes(series)) {
			throw new Error('The source of an indicator must be a series or an indicator output of this chart');
		}
		let id = options.id;
		if (id === undefined || id === '') {
			do {
				id = `indicator-${++this._named}`;
			} while (this._byId(id) !== undefined);
		} else if (typeof id !== 'string') {
			throw new Error('lumen-charts: the id of an indicator must be a string');
		} else if (this._byId(id) !== undefined) {
			throw new Error(`lumen-charts: an indicator with id "${id}" exists already`);
		}
		let self: Indicator | null = null;
		const resolve = (input: IndicatorInput, index: number): IndicatorInputRef =>
			this._resolve(self, series, input, info.inputs[index]!);
		const indicator = new Indicator(this._host, this._host.ensureEngine(), info, series, options, resolve, id);
		self = indicator;
		this._list.push(indicator);
		for (const output of indicator.outputList) {
			this._host.seriesList.push(output.series);
		}
		this._host.invalidate(INVALIDATE_LIGHT);
		return indicator;
	}

	/** The indicators in the order they were added. */
	public get list(): readonly Indicator[] {
		return this._list;
	}

	/** The definition with this name, if it is a built-in or was registered. */
	public definition(name: string): IndicatorInfo | undefined {
		return this._definitions.get(name);
	}

	/** The state of every indicator (see `IndicatorState`); `order` gives each its place among the series. */
	public save(order: (indicator: Indicator) => number): IndicatorState[] {
		const reference = (series: Series): SeriesReference => {
			const owner = series.derived ? this._ownerOf(series) : undefined;
			return owner === undefined
				? { series: series.id }
				: { indicator: owner.id, output: owner.outputList.find(output => output.series === series)!.name };
		};
		return this._list.map(indicator => {
			const options = indicator.options();
			const outputs: IndicatorState['outputs'] = {};
			for (const output of indicator.outputList) {
				outputs[output.name] = { ...output.options() };
			}
			return {
				id: indicator.id,
				name: indicator.name,
				source: reference(indicator.source),
				params: options.params,
				inputs: options.inputs.map((input, i): IndicatorInputState => {
					if (typeof input === 'string') {
						return input;
					}
					const output = outputSeries(input);
					if (output !== null) {
						return reference(output) as IndicatorInputState;
					}
					const read = (input as { series: Series; column?: SourceColumn }).series;
					const column =
						(input as { column?: SourceColumn }).column ?? (indicator.definition.inputs[i] as SourceColumn);
					return read.derived ? (reference(read) as IndicatorInputState) : { series: read.id, column };
				}),
				outputs,
				priceScaleId: options.priceScaleId,
				order: order(indicator),
			};
		});
	}

	/**
	 * Makes the indicators those of a checked state (see `planRestore`), matching them by id. An
	 * indicator is kept, and only takes the state's options, when the state has the same id,
	 * definition and source for it, and every indicator the state has it read is kept too and was
	 * added before it: the engine computes in the order indicators were added, and an input reads
	 * only an earlier one. The others are removed, and those of the state the chart lacks are added in
	 * the state's order, after the kept ones, which stay where they are in the list. `seriesById`
	 * finds the chart's series.
	 */
	public restore(
		plans: readonly IndicatorPlan[],
		seriesById: (id: string) => Series | undefined,
	): Map<string, Indicator> {
		const restored = new Map<string, Indicator>();
		const seriesOf = (reference: SeriesReference): Series | undefined =>
			'indicator' in reference
				? restored.get(reference.indicator)?.outputList.find(output => output.name === reference.output)?.series
				: seriesById(reference.series);
		const list = this._list;
		const kept = new Set<Indicator>();
		// A state lists an indicator after what it reads, so those are decided before it.
		for (const plan of plans) {
			const existing = this._byId(plan.id);
			if (existing === undefined || existing.definition !== plan.info || existing.source !== seriesOf(plan.source)) {
				continue;
			}
			const position = list.indexOf(existing);
			const earlier = (reference: unknown): boolean => {
				if (typeof reference !== 'object' || reference === null || !('indicator' in reference)) {
					return true;
				}
				const read = restored.get((reference as { indicator: string }).indicator);
				return read !== undefined && list.indexOf(read) < position;
			};
			if (earlier(plan.source) && plan.inputs.every(earlier)) {
				restored.set(plan.id, existing);
				kept.add(existing);
			}
		}
		const optionsOf = (plan: IndicatorPlan): DeepPartial<IndicatorOptions> => ({
			params: plan.params,
			inputs: plan.inputs.map(input => {
				if (input === undefined || typeof input === 'string') {
					return input;
				}
				if ('indicator' in input) {
					return restored.get(input.indicator)!.output(input.output);
				}
				return { series: seriesById(input.series)!, column: input.column };
			}) as IndicatorInput[],
			outputs: plan.outputs,
			priceScaleId: plan.priceScaleId,
		});
		// The kept ones first: what they read afterwards is kept too, so none of them reads an
		// indicator that goes, and none is taken along when it is removed.
		for (const plan of plans) {
			const existing = restored.get(plan.id);
			if (existing !== undefined) {
				existing.applyOptions(optionsOf(plan));
			}
		}
		// From the last one back, so each is gone before the ones it reads.
		const stale = this._list.filter(indicator => !kept.has(indicator));
		for (let i = stale.length - 1; i >= 0; i--) {
			this.remove(stale[i]!);
		}
		for (const plan of plans) {
			if (!restored.has(plan.id)) {
				restored.set(
					plan.id,
					this.add(seriesOf(plan.source), plan.info.name, { ...optionsOf(plan), id: plan.id }) as Indicator,
				);
			}
		}
		return restored;
	}

	/** Removes an indicator, after every indicator that reads its outputs. */
	public remove(indicator: IndicatorApi): void {
		const index = this._list.indexOf(indicator as Indicator);
		if (index < 0) {
			return;
		}
		const removed = this._list[index]!;
		const outputs = new Set(removed.outputList.map(output => output.series.engineId));
		for (const reader of this._list.slice(index + 1)) {
			if (reader.refs.some(ref => outputs.has(ref.series)) || outputs.has(reader.source.engineId)) {
				this.remove(reader);
			}
		}
		this._list.splice(this._list.indexOf(removed), 1);
		const list = this._host.seriesList;
		for (const output of removed.outputList) {
			const at = list.indexOf(output.series);
			if (at >= 0) {
				list.splice(at, 1);
			}
			this._host.forget(output.series.engineId);
			this._host.seriesRemoved(output.series);
		}
		this._host.engine()?.removeIndicator(removed.engineId);
		this._host.invalidate(INVALIDATE_LIGHT);
	}

	/** Removes every indicator that reads series `id` or was added to it. */
	public removeReadersOf(id: number): void {
		for (const indicator of this._list.slice()) {
			if (indicator.refs.some(ref => ref.series === id) || indicator.source.engineId === id) {
				this.remove(indicator);
			}
		}
	}

	/** Has the engine load a module of indicators; settled by `settlePlugins`. */
	public register(url: string | URL): Promise<readonly IndicatorInfo[]> {
		const engine = this._host.ensureEngine();
		if (engine === null) {
			return Promise.reject(new Error('The chart was destroyed'));
		}
		if (engine.lost) {
			return Promise.reject(new Error('The data engine of the chart stopped'));
		}
		const href = new URL(String(url), this._host.baseUrl()).href;
		return new Promise((resolve, reject) => {
			const waiters = this._plugins.get(href) ?? [];
			waiters.push({ resolve, reject });
			this._plugins.set(href, waiters);
			engine.loadPlugin(href);
		});
	}

	/** Settles the waiters of `register` for modules the engine finished loading. */
	public settlePlugins(results: readonly PluginResult[]): void {
		for (const result of results) {
			const waiters = this._plugins.get(result.url) ?? [];
			this._plugins.delete(result.url);
			for (const info of result.indicators ?? []) {
				this._definitions.set(info.name, info);
			}
			for (const { resolve, reject } of waiters) {
				if (result.indicators === undefined) {
					reject(new Error(`Could not load indicators from ${result.url}: ${result.error ?? 'unknown error'}`));
				} else {
					resolve(result.indicators);
				}
			}
		}
	}

	/** Rejects every module still loading: the chart is gone. */
	public destroy(): void {
		this._rejectPlugins('The chart was destroyed');
	}

	/** The engine stopped: nothing is computed any more, and no module finishes loading. */
	public engineLost(message: string): void {
		this.computing = 0;
		this._rejectPlugins(message);
	}

	private _rejectPlugins(reason: string): void {
		for (const waiters of this._plugins.values()) {
			for (const { reject } of waiters) {
				reject(new Error(reason));
			}
		}
		this._plugins.clear();
	}

	/**
	 * Engine reference of one input. `indicator` is the one being configured (null while it is
	 * created); it may read only outputs of indicators added before it.
	 */
	private _resolve(
		indicator: Indicator | null,
		source: Series,
		input: IndicatorInput,
		column: string,
	): IndicatorInputRef {
		const output = outputSeries(input);
		const read = output ?? (typeof input === 'string' ? source : (input as { series: SeriesApi }).series);
		if (!(read instanceof Series) || !this._host.seriesList.includes(read)) {
			throw new Error('An indicator input must read a series or an indicator output of this chart');
		}
		const name =
			typeof input === 'string' ? input : output === null ? ((input as { column?: string }).column ?? column) : column;
		if (read.derived) {
			const owner = this._ownerOf(read)!;
			const position = indicator === null ? this._list.length : this._list.indexOf(indicator);
			if (this._list.indexOf(owner) >= position) {
				throw new Error('An indicator can only read the outputs of indicators added before it');
			}
			// Times come from the series at the root of the chain; every other column reads the output.
			return name === 'time'
				? { series: this._rootOf(read).engineId, column: 0 }
				: { series: read.engineId, column: 0 };
		}
		return { series: read.engineId, column: columnOf(read.kind, name as SourceColumn) };
	}

	private _byId(id: string): Indicator | undefined {
		return this._list.find(entry => entry.id === id);
	}

	private _ownerOf(series: Series): Indicator | undefined {
		return this._list.find(entry => entry.outputList.some(item => item.series === series));
	}

	/** The series an output was ultimately computed from. */
	private _rootOf(series: Series): Series {
		let current = series;
		while (current.derived) {
			const owner = this._ownerOf(current);
			if (owner === undefined) {
				break;
			}
			current = owner.source;
		}
		return current;
	}
}
