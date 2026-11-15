import type { CandleColumns, LineColumns, TickColumns } from './data.ts';

/** Size of the chart in CSS pixels. */
export interface ChartSize {
	readonly width: number;
	readonly height: number;
}

/**
 * Range of bar indexes, where bar `i` is the i-th row of the data set. Both ends are inclusive and
 * may be fractional or outside the data: `to - from + 1` bars fill the plot width.
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
 */
export interface ChartAdapter<TPrepared = unknown> {
	/** Converts candles to the library's input format. Must not touch the chart. */
	prepareCandles(data: CandleColumns): TPrepared;
	/** Converts line points to the library's input format. Must not touch the chart. */
	prepareLine(data: LineColumns): TPrepared;
	/** Replaces the series with prepared data, creating a series of the matching type if needed. */
	setData(data: TPrepared): void;
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

/** A loaded library variant that creates charts. */
export interface AdapterFactory {
	/** Library name and the version actually loaded at runtime. */
	readonly library: { readonly name: string; readonly version: string };
	/** Options that define this variant, recorded with every result. */
	readonly options: Readonly<Record<string, unknown>>;
	/** Mounts a chart of exactly `size` inside `container`. */
	create(container: HTMLElement, size: ChartSize): Promise<ChartAdapter>;
}

/** Registry entry. `load` imports the library only when a run selects it. */
export interface AdapterEntry {
	/** Stable id used on the command line and in results, for example `lwc-conflation-on`. */
	readonly id: string;
	readonly description: string;
	load(): Promise<AdapterFactory>;
}
