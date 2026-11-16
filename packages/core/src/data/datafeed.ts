import type { EngineClient, EngineEvent, FetchRequest } from '@lumen-charts/engine';
import type { Series } from '../series';
import type { WindowCache } from './window-cache';

/** A datafeed request: in flight, or waiting out the pause after a failure (`timer`). */
interface Fetch {
	series: Series;
	controller: AbortController;
	timer: ReturnType<typeof setTimeout> | null;
}

/** Pause before asking a datafeed again after the first failure, and the longest one, in milliseconds. */
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;

/**
 * The datafeed requests of a chart: rows the engine let go under the memory limit and needs again
 * are fetched from the datafeed of their series and handed back to the engine.
 */
export class DatafeedFetches {
	/** Requests in flight (not waiting out a pause). */
	public fetching = 0;
	/** Datafeed requests, by request id. */
	private readonly _requests = new Map<number, Fetch>();
	/** Bars handed back to the engine, by request id, until it says whether it took them. */
	private readonly _answered = new Map<number, { series: Series; from: number; to: number }>();
	private readonly _series: readonly Series[];
	private readonly _cache: WindowCache;
	private readonly _engine: () => EngineClient | null;
	private readonly _settled: () => void;

	/**
	 * `series` is the chart's list, `engine` its data engine if it has one, and `settled` hears a
	 * request end: whoever waits for the chart to be idle may have nothing left to wait for.
	 */
	public constructor(
		series: readonly Series[],
		cache: WindowCache,
		engine: () => EngineClient | null,
		settled: () => void,
	) {
		this._series = series;
		this._cache = cache;
		this._engine = engine;
		this._settled = settled;
	}

	/** Aborts every request and forgets the answers the engine has not confirmed. */
	public destroy(): void {
		this.abort(null);
		this._answered.clear();
	}

	/**
	 * Fetches rows the engine let go and needs again from the series' datafeed, and hands them back.
	 * The engine checks them against the rows it let go; a raw window waits for them meanwhile, and the
	 * chart draws a coarse level where it has nothing else. Requests the engine no longer needs are
	 * aborted through the signal `getBars` got.
	 */
	public handle(event: EngineEvent): void {
		const restored = event.restored;
		if (restored !== undefined) {
			const answered = this._answered.get(restored.request);
			this._answered.delete(restored.request);
			if (restored.outcome === 'restored' && answered !== undefined) {
				answered.series.fetchBackoff = 0;
			} else if (restored.outcome === 'mismatch' && answered !== undefined) {
				console.warn(
					`lumen-charts: the datafeed returned ${restored.received} bars where ${restored.expected} were expected; ` +
						'they do not match the bars they replace and were ignored.',
				);
				failed(answered.series, answered.from, answered.to);
			}
		}
		const window = event.window;
		if (window?.incomplete === true) {
			// The rows could not be fetched: draw what the levels show and ask again after a pause.
			let backoff = RETRY_MIN_MS;
			for (const series of this._series) {
				backoff = Math.max(backoff, series.fetchBackoff);
			}
			this._cache.level(window.level).holdOff(performance.now() + backoff);
		}
		for (const id of event.cancel ?? []) {
			this._abortFetch(id);
		}
		const engine = this._engine();
		for (const request of event.fetch ?? []) {
			const series = this._seriesById(request.series);
			if (engine === null || this._requests.has(request.id) || series === undefined) {
				// A removed series: the engine forgot its requests when it removed it.
				continue;
			}
			if (event.ack < series.reloadSeq) {
				// Asked for before the series got a new history: the engine drops it once it gets there.
				continue;
			}
			if (series.datafeed === null) {
				engine.restoreRows(request.id, null, 0);
				continue;
			}
			this._fetch(series, request);
		}
	}

	/** Calls the series' datafeed for a request, after the pause that follows a failure if one is running. */
	private _fetch(series: Series, request: FetchRequest): void {
		const datafeed = series.datafeed!;
		const { id, from, to, start, end } = request;
		const controller = new AbortController();
		const entry: Fetch = { series, controller, timer: null };
		this._requests.set(id, entry);
		const done = (data: Float64Array | null, count: number): void => {
			if (controller.signal.aborted) {
				return;
			}
			this._requests.delete(id);
			this.fetching--;
			const engine = this._engine();
			if (data === null) {
				failed(series, from, to);
			} else if (engine !== null) {
				this._answered.set(id, { series, from, to });
			}
			// After destroy the engine is gone, and nothing waits for the rows.
			engine?.restoreRows(id, data, count);
			this._settled();
		};
		const call = (): void => {
			entry.timer = null;
			this.fetching++;
			let pending: Promise<unknown>;
			try {
				pending = datafeed.getBars({ from, to, countBack: end - start, signal: controller.signal });
			} catch (error) {
				pending = Promise.reject(error);
			}
			pending.then(
				bars => {
					let packed: { data: Float64Array; count: number };
					try {
						packed = series.packFetched(bars as never, from, to);
					} catch {
						done(null, 0);
						return;
					}
					done(packed.data, packed.count);
				},
				() => {
					done(null, 0);
				},
			);
		};
		// Bars whose request failed a moment ago are asked for again only after the pause.
		const now = performance.now();
		let wait = 0;
		const failures = series.failures;
		for (let i = failures.length - 1; i >= 0; i--) {
			const failure = failures[i]!;
			if (failure.until <= now) {
				failures.splice(i, 1);
			} else if (failure.from <= to && failure.to >= from) {
				wait = Math.max(wait, failure.until - now);
			}
		}
		if (wait > 0) {
			entry.timer = setTimeout(call, wait);
		} else {
			call();
		}
	}

	/** Aborts a datafeed request; its answer, if one still comes, is ignored. */
	private _abortFetch(id: number): void {
		const entry = this._requests.get(id);
		if (entry === undefined) {
			return;
		}
		this._requests.delete(id);
		if (entry.timer === null) {
			this.fetching--;
		} else {
			clearTimeout(entry.timer);
		}
		entry.controller.abort();
		this._settled();
	}

	/** Aborts the datafeed requests of a series, or of every series. */
	public abort(series: Series | null): void {
		for (const [id, entry] of this._requests) {
			if (series === null || entry.series === series) {
				this._abortFetch(id);
			}
		}
	}

	private _seriesById(id: number): Series | undefined {
		for (const series of this._series) {
			if (series.engineId === id) {
				return series;
			}
		}
		return undefined;
	}
}

/** Notes a failed datafeed request: the pause doubles (1 s to 30 s) and those bars wait it out. */
function failed(series: Series, from: number, to: number): void {
	series.fetchBackoff = Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, series.fetchBackoff * 2));
	series.failures.push({ from, to, until: performance.now() + series.fetchBackoff });
}
