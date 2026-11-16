import type { CandleColumns, LineColumns, SeriesKind, TickColumns } from './data.ts';

/** Size of the chart in CSS pixels. */
export interface ChartSize {
	readonly width: number;
	readonly height: number;
}

/**
 * Range of bar indexes, where bar `i` is the i-th row of the data set. Both ends are inclusive and
 * may be fractional or outside the data: `to - from + 1` bars fill the plot width. Indexes have a
 * fixed origin: rows added by `prepend` get negative indexes and existing rows keep theirs.
 */
export interface LogicalRange {
	readonly from: number;
	readonly to: number;
}

/**
 * One chart instance with a single series, as the scenarios see it.
 *
 * Scenarios hand data over as columns. Converting columns into the library's input format is the
 * adapter's job and happens in `prepareCandles` / `prepareLine`, which scenarios time separately
 * from `setData`. `TPrepared` is opaque to scenarios: they only pass it back to `setData`.
 *
 * Calls other than `settle` may return before the library has applied them (for example when the
 * data engine runs in a worker). `settle` is the only synchronization point.
 *
 * This is what every library can do. What only some can, a scenario that needs it declares as an
 * interface of its own in its module (`scenarios/`), which the adapters of those libraries
 * implement; the scenario asks for it with `supports`.
 */
export interface ChartAdapter<TPrepared = unknown> {
	/** Converts candles to the library's input format. Must not touch the chart. */
	prepareCandles(data: CandleColumns): TPrepared;
	/** Converts line points to the library's input format. Must not touch the chart. */
	prepareLine(data: LineColumns): TPrepared;
	/** Replaces the series with prepared data, creating a series of the matching type if needed. */
	setData(data: TPrepared): void;
	/**
	 * Converts older history for `prepend`. Unlike `prepareCandles` / `prepareLine` it may read the
	 * chart's current data, for libraries that can only replace a series as a whole; it must not
	 * change the chart. Scenarios time it separately from `prepend`.
	 */
	preparePrepend(data: CandleColumns | LineColumns): TPrepared;
	/**
	 * Adds prepared history before the first bar of the series. Every row is older than the current
	 * first bar. Existing bars keep their logical indexes; the new ones take the indexes below.
	 */
	prepend(data: TPrepared): void;
	/**
	 * Applies tick `index` of `ticks` to the tail of the series: the last bar is replaced when the
	 * tick has its time, otherwise a bar is appended. Any per-tick conversion is part of the call.
	 */
	applyTick(ticks: TickColumns, index: number): void;
	/** Shows the given range of bars, as a scripted pan or zoom would. */
	setVisibleLogicalRange(range: LogicalRange): void;
	/**
	 * Resolves once everything submitted so far has been applied and the main thread has finished
	 * rendering the frame that shows it. GPU rasterization and display are not awaited.
	 */
	settle(): Promise<void>;
	/** Removes the chart and releases its resources. */
	destroy(): void;
}

/**
 * Whether `value` (an adapter or a factory) has the methods of `T`, an interface a scenario declares
 * for what only some libraries can do.
 */
export function supports<T extends object>(value: object, ...methods: (keyof T)[]): value is T {
	return methods.every(method => typeof (value as Record<PropertyKey, unknown>)[method] === 'function');
}

/** A loaded library variant that creates charts. */
export interface AdapterFactory {
	/** Library name and the version actually loaded at runtime. */
	readonly library: { readonly name: string; readonly version: string };
	/** Options that define this variant, recorded with every result. */
	readonly options: Readonly<Record<string, unknown>>;
	/**
	 * Mounts a chart inside `container`: of exactly `size`, or with `auto` in the library's auto-size
	 * mode, where the chart fills the container and follows its size.
	 */
	create(container: HTMLElement, size: ChartSize | 'auto'): Promise<ChartAdapter>;
}

/** A data set an adapter is known to fail on, so the planner leaves it out instead of running it again. */
export interface KnownFailure {
	/** Same shape as a job's data set (`DatasetSpec`). */
	readonly dataset: { readonly kind: SeriesKind; readonly size: number };
	/** What happened and where it was measured. */
	readonly reason: string;
}

/** Registry entry. `load` imports the library only when a run selects it. */
export interface AdapterEntry {
	/** Stable id used on the command line and in results, for example `lwc-conflation-on`. */
	readonly id: string;
	readonly description: string;
	readonly knownFailures?: readonly KnownFailure[];
	/**
	 * What the adapter can do beyond `ChartAdapter`, by the names the scenarios that need it ask for
	 * (`requires` of a scenario): the planner leaves the adapter out of the scenarios it cannot run.
	 * The adapter implements the interface the scenario's module declares for it.
	 */
	readonly capabilities?: readonly string[];
	load(): Promise<AdapterFactory>;
}
