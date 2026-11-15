import {
	BUILTIN_INDICATORS,
	type EngineClient,
	type IndicatorInfo,
	type IndicatorInputRef,
	SOURCE_COLUMNS,
	indicatorInfo,
	resolveParams,
} from '@lumen-charts/engine';
import { INVALIDATE_LIGHT } from './model/invalidation';
import {
	type DeepPartial,
	type HistogramOptions,
	type LineOptions,
	definedOnly,
	optionsEqual,
	shallowEqual,
} from './options';
import { type AnySeriesOptions, Series, type SeriesApi, type SeriesHost } from './series';

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
	/** Parameters by name. Omitted ones take the definition's defaults. */
	params: Record<string, number>;
	/**
	 * One entry per input of the definition, in its order. Omitted ones read the definition's default
	 * column of the source.
	 */
	inputs: IndicatorInput[];
	/** Options of each output's series, by output name. */
	outputs: Record<string, IndicatorOutputOptions>;
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
}

/**
 * An indicator computed in the data engine. Its outputs are series on the main timeline, drawn on
 * the price pane and included in autoscale; they update with every tick of their inputs.
 */
export interface IndicatorApi {
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

/** Defaults of the options of an output, from its definition. */
function outputDefaults(info: IndicatorInfo['outputs'][number]): Partial<AnySeriesOptions> {
	const color = info.color ?? '#2962ff';
	if (info.style === 'histogram') {
		return { color, negativeColor: '#ef5350', priceLineVisible: false };
	}
	return { color, lineWidth: 1.5, priceLineVisible: false, crosshairMarkerVisible: false };
}

/** Definitions the chart knows, by name: the built-ins. */
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
}

/**
 * An indicator on the main thread: the definition's metadata, the inputs resolved to series ids,
 * and one derived series per output. The values live in the data engine.
 */
export class Indicator implements IndicatorApi {
	public readonly definition: IndicatorInfo;
	public readonly host: IndicatorHost;
	/** Engine id of the instance. */
	public readonly id: number;
	/** The series (or derived output series) the indicator was added to. */
	public readonly source: Series;
	public readonly outputList: IndicatorOutput[] = [];
	private _params: Float64Array;
	private _inputs: IndicatorInput[];
	private _refs: IndicatorInputRef[];
	private readonly _resolve: (input: IndicatorInput, index: number) => IndicatorInputRef;

	public constructor(
		host: IndicatorHost,
		engine: EngineClient | null,
		info: IndicatorInfo,
		source: Series,
		options: DeepPartial<IndicatorOptions>,
		resolve: (input: IndicatorInput, index: number) => IndicatorInputRef,
	) {
		this.host = host;
		this.definition = info;
		this.source = source;
		this._resolve = resolve;
		this._params = resolveParams(info.params, (options.params ?? {}) as Record<string, number>);
		this._inputs = this._inputsWith((options.inputs ?? []) as IndicatorInput[]);
		this._refs = this._inputs.map((input, i) => resolve(input, i));
		const created = engine?.addIndicator(info.name, Array.from(this._params), this._refs, info.outputs.length);
		this.id = created?.id ?? -1;
		info.outputs.forEach((output, i) => {
			const style = (options.outputs?.[output.name] ?? {}) as IndicatorOutputOptions;
			const series = new Series(
				host,
				created?.outputs[i] ?? -1,
				output.style === 'histogram' ? 'histogram' : 'line',
				{ ...outputDefaults(output), ...definedOnly(style as Partial<AnySeriesOptions>) },
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
			if (!optionsEqual(Array.from(params), Array.from(this._params))) {
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
				this.id,
				info.name,
				Array.from(this._params),
				this._refs,
				this.outputList.map(output => output.series.id),
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
		return { params, inputs: [...this._inputs], outputs };
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
}

/**
 * The indicators of a chart: definitions by name and instances in creation order (an indicator reads
 * only earlier ones, which keeps the engine's order topological).
 */
export class ChartIndicators {
	/** Indicators the engine is still computing, from the latest event. */
	public computing = 0;
	private readonly _host: ChartIndicatorsHost;
	private readonly _list: Indicator[] = [];
	private readonly _definitions = builtinInfos();

	public constructor(host: ChartIndicatorsHost) {
		this._host = host;
	}

	public add(source: unknown, name: string, options: DeepPartial<IndicatorOptions>): IndicatorApi {
		const info = this._definitions.get(name);
		if (info === undefined) {
			throw new Error(`Unknown indicator "${name}"`);
		}
		const series = outputSeries(source) ?? (source instanceof Series ? source : null);
		if (series === null || !this._host.seriesList.includes(series)) {
			throw new Error('The source of an indicator must be a series or an indicator output of this chart');
		}
		let self: Indicator | null = null;
		const resolve = (input: IndicatorInput, index: number): IndicatorInputRef =>
			this._resolve(self, series, input, info.inputs[index]!);
		const indicator = new Indicator(this._host, this._host.ensureEngine(), info, series, options, resolve);
		self = indicator;
		this._list.push(indicator);
		for (const output of indicator.outputList) {
			this._host.seriesList.push(output.series);
		}
		this._host.invalidate(INVALIDATE_LIGHT);
		return indicator;
	}

	/** Removes an indicator, after every indicator that reads its outputs. */
	public remove(indicator: IndicatorApi): void {
		const index = this._list.indexOf(indicator as Indicator);
		if (index < 0) {
			return;
		}
		const removed = this._list[index]!;
		const outputs = new Set(removed.outputList.map(output => output.series.id));
		for (const reader of this._list.slice(index + 1)) {
			if (reader.refs.some(ref => outputs.has(ref.series)) || outputs.has(reader.source.id)) {
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
			this._host.forget(output.series.id);
		}
		this._host.engine()?.removeIndicator(removed.id);
		this._host.invalidate(INVALIDATE_LIGHT);
	}

	/** Removes every indicator that reads series `id` or was added to it. */
	public removeReadersOf(id: number): void {
		for (const indicator of this._list.slice()) {
			if (indicator.refs.some(ref => ref.series === id) || indicator.source.id === id) {
				this.remove(indicator);
			}
		}
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
			return name === 'time' ? { series: this._rootOf(read).id, column: 0 } : { series: read.id, column: 0 };
		}
		return { series: read.id, column: columnOf(read.kind, name as SourceColumn) };
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
