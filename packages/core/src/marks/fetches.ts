import type { EngineClient, EngineEvent, MarksData, MarksFetchRequest } from '@lumen-charts/engine';

/** Marks the chart asks a datafeed for: those with times in `[from, to]` (UTC milliseconds, inclusive). */
export interface MarksDatafeedRequest {
	from: number;
	to: number;
	/** Aborted once the chart no longer needs the marks (the view moved away, or the series is gone). */
	signal: AbortSignal;
}

/**
 * Where a heatmap or scatter series fetches marks again that the data engine let go under the
 * chart's `memoryLimit`. `getMarks` returns the marks of the times asked for, in any form `setData`
 * of the series takes: the same marks the series was given, in the same order (points at one time
 * keep their order). The engine checks them against what it let go, and refuses marks that differ:
 * marks are not corrected after the fact, so the levels of detail made from them stay right.
 */
export interface MarksDatafeed<T> {
	getMarks(request: MarksDatafeedRequest): Promise<T>;
}

/** What the fetches need of a series. */
export interface FetchingSeries {
	readonly engineId: number;
	datafeed: MarksDatafeed<unknown> | null;
	/** Packs what the datafeed returned as marks for the engine; throws for input it cannot read. */
	packFetched(data: unknown): MarksData;
	/** Asks for the view again: the engine answered with a stand-in and fetching failed meanwhile. */
	retry(): void;
	/** Pause before the next request after a failure; doubles with every failure in a row. */
	fetchBackoff: number;
}

/** Pause before asking again after the first failure, and the longest one, in milliseconds. */
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;

interface Fetch {
	series: FetchingSeries;
	controller: AbortController;
}

/**
 * The datafeed requests of a chart's heatmap and scatter series: marks the engine let go under the
 * memory limit and needs again are fetched from the datafeed of their series and handed back. A
 * failure, or marks that are not those let go, pause the series before its view asks again, from
 * 1 s up to 30 s; meanwhile it is drawn from a coarser level of detail.
 */
export class MarkFetches {
	/** Requests in flight. */
	public fetching = 0;
	private readonly _requests = new Map<number, Fetch>();
	/** Marks handed back, by request id, until the engine says whether it took them. */
	private readonly _answered = new Map<number, FetchingSeries>();
	private readonly _timers = new Set<ReturnType<typeof setTimeout>>();
	private readonly _engine: () => EngineClient | null;
	private readonly _series: (engineId: number) => FetchingSeries | undefined;
	private readonly _settled: () => void;

	public constructor(
		engine: () => EngineClient | null,
		series: (engineId: number) => FetchingSeries | undefined,
		settled: () => void,
	) {
		this._engine = engine;
		this._series = series;
		this._settled = settled;
	}

	public handle(event: EngineEvent): void {
		const restored = event.marksRestored;
		if (restored !== undefined) {
			const series = this._answered.get(restored.request);
			this._answered.delete(restored.request);
			if (series !== undefined) {
				if (restored.outcome === 'restored') {
					series.fetchBackoff = 0;
				} else {
					if (restored.outcome === 'mismatch') {
						console.warn(
							'lumen-charts: the datafeed of a heatmap or scatter returned marks that do not match those it ' +
								'replaces; they were ignored.',
						);
					}
					this._failed(series);
				}
			}
		}
		for (const id of event.marksCancel ?? []) {
			this._abort(id);
		}
		for (const request of event.marksFetch ?? []) {
			this._fetch(request);
		}
	}

	private _fetch(request: MarksFetchRequest): void {
		const engine = this._engine();
		const series = this._series(request.series);
		if (engine === null || series === undefined || this._requests.has(request.id)) {
			return;
		}
		const datafeed = series.datafeed;
		if (datafeed === null) {
			engine.restoreMarks(request.id, null);
			return;
		}
		const controller = new AbortController();
		this._requests.set(request.id, { series, controller });
		this.fetching++;
		const done = (data: MarksData | null): void => {
			if (controller.signal.aborted) {
				return;
			}
			this._requests.delete(request.id);
			this.fetching--;
			const current = this._engine();
			if (current !== null) {
				if (data !== null) {
					this._answered.set(request.id, series);
				} else {
					this._failed(series);
				}
				current.restoreMarks(request.id, data);
			}
			this._settled();
		};
		let pending: Promise<unknown>;
		try {
			pending = datafeed.getMarks({ from: request.from, to: request.to, signal: controller.signal });
		} catch (error) {
			pending = Promise.reject(error);
		}
		pending.then(
			data => {
				let packed: MarksData;
				try {
					packed = series.packFetched(data);
				} catch {
					done(null);
					return;
				}
				done(packed);
			},
			() => done(null),
		);
	}

	/** A request failed: the series waits out its pause, then its view asks again. */
	private _failed(series: FetchingSeries): void {
		series.fetchBackoff = Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, series.fetchBackoff * 2));
		const timer = setTimeout(() => {
			this._timers.delete(timer);
			series.retry();
		}, series.fetchBackoff);
		this._timers.add(timer);
	}

	private _abort(id: number): void {
		const entry = this._requests.get(id);
		if (entry === undefined) {
			return;
		}
		this._requests.delete(id);
		this.fetching--;
		entry.controller.abort();
		this._settled();
	}

	/** Aborts the requests of a series, or of every series. */
	public abort(series: FetchingSeries | null): void {
		for (const [id, entry] of this._requests) {
			if (series === null || entry.series === series) {
				this._abort(id);
			}
		}
	}

	public destroy(): void {
		this.abort(null);
		this._answered.clear();
		for (const timer of this._timers) {
			clearTimeout(timer);
		}
		this._timers.clear();
	}
}
