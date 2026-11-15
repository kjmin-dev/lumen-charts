import type { CandleColumns, LineColumns, SeriesColumns, SeriesKind, TickColumns } from './data.ts';

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
	/**
	 * Like `setData`, with a datafeed the library may fetch bars from again and a memory limit in
	 * bytes it may let bars go past. `datafeed` returns the rows with times in `[from, to]`. Only
	 * libraries with `datafeed` set in their registry entry implement it.
	 */
	setDataWithDatafeed?(
		data: TPrepared,
		datafeed: (from: number, to: number) => SeriesColumns,
		memoryLimit: number,
	): void;
	/**
	 * Puts the first `count` indicators of the stage 3 set (`INDICATOR_SET`) on the series the next
	 * `setData` creates, which then keeps the candles' volume; ticks and prepends update them. Called
	 * before `setData`. Only libraries with `indicators` set in their registry entry implement it.
	 */
	withIndicators?(count: number): void;
	/**
	 * Resolves once everything submitted so far has been applied, indicator values included, without
	 * waiting for a frame. A library that applies updates synchronously resolves at once.
	 */
	applied?(): Promise<void>;
	/** Shows the given range of bars, as a scripted pan or zoom would. */
	setVisibleLogicalRange(range: LogicalRange): void;
	/**
	 * Resolves once everything submitted so far has been applied and the main thread has finished
	 * rendering the frame that shows it. GPU rasterization and display are not awaited.
	 */
	settle(): Promise<void>;
	/**
	 * The library's own part of `settle`: resolves once everything submitted so far has been applied
	 * and drawn, possibly from inside the animation frame that draws it, without waiting for that
	 * frame's rendering. With several charts on a page the harness waits for all of them like this
	 * and then for the rendering once, so the waiting costs the same whatever a library does per
	 * chart. Libraries without such a signal leave it out, and the harness uses `settle`.
	 */
	idle?(): Promise<void>;
	/** Removes the chart and releases its resources. */
	destroy(): void;
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
	/**
	 * Limits the workers the library shares between its charts, for charts created afterwards. Only
	 * libraries with such a limit implement it; a version of one that has none ignores the call.
	 */
	setMaxWorkers?(count: number): void;
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
	/** The library can fetch history again from a datafeed (`setDataWithDatafeed`), for the refetch scenario. */
	readonly datafeed?: boolean;
	/** The adapter can put indicators on a series (`withIndicators`, `applied`), for the stage 3 scenarios. */
	readonly indicators?: boolean;
	load(): Promise<AdapterFactory>;
}
