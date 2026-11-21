import {
	type EngineClient,
	type EngineEvent,
	PATCH_COUNT,
	PATCH_LEVEL,
	PATCH_OFFSET,
	PATCH_SERIES,
	PATCH_START,
	PATCH_STRIDE,
	columnCount,
	createEngine,
	levelFor,
} from '@lumen-charts/engine';
import type { ChartIndicators } from '../indicators';
import { INVALIDATE_LIGHT, type Invalidation } from '../model/invalidation';
import type { TimeDisplay } from '../model/time-display';
import type { TimeIndex } from '../model/time-index';
import type { TimeScale } from '../model/time-scale';
import type { ChartLayout } from '../render/layout';
import type { Series } from '../series';
import type { ChartSettings } from '../settings';
import type { DatafeedFetches } from './datafeed';
import type { WindowCache } from './window-cache';

/** What the data flow needs from the chart. */
export interface DataFlowHost {
	/** Brings the pane size and the view up to date, before a call reads or changes the view. */
	syncView(): void;
	/** Applies the pointer input that waits for the layout. */
	resolveInput(): void;
	invalidate(level: Invalidation): void;
	/** Data changed and nothing else: the frame may redraw only the columns that changed. */
	dataChanged(): void;
	/** A call that waited for the data ran: anything on the series layer may differ. */
	callApplied(): void;
	/** The timeline may place the times of a restored view now. */
	resolveView(): void;
	/** An event was handled: whoever waits for the chart may have nothing left to wait for. */
	settled(): void;
}

interface Deferred {
	seq: number;
	action: () => void;
}

/**
 * The chart's side of the data engine: creates the engine with the first series, applies its events
 * to the window cache, the time scale and the series, asks for the rows the view needs, and holds
 * back calls on the view until the data handed over before them has been applied.
 */
export class DataFlow {
	/** The data engine, created with the first series (or plugin module); null before and after. */
	public engine: EngineClient | null = null;
	/** Scale version the last window request was planned for. */
	public plannedScale = -1;
	/** Limit last sent to the engine. */
	private _memoryLimit = Infinity;
	private _deferred: Deferred[] = [];
	private _closed = false;
	private readonly _host: DataFlowHost;
	private readonly _settings: ChartSettings;
	private readonly _layout: ChartLayout;
	private readonly _scale: TimeScale;
	private readonly _cache: WindowCache;
	private readonly _series: readonly Series[];
	private readonly _time: TimeDisplay;
	private readonly _times: TimeIndex;
	private readonly _indicators: ChartIndicators;
	private readonly _fetches: DatafeedFetches;

	public constructor(
		host: DataFlowHost,
		settings: ChartSettings,
		layout: ChartLayout,
		scale: TimeScale,
		cache: WindowCache,
		series: readonly Series[],
		time: TimeDisplay,
		times: TimeIndex,
		indicators: ChartIndicators,
		fetches: DatafeedFetches,
	) {
		this._host = host;
		this._settings = settings;
		this._layout = layout;
		this._scale = scale;
		this._cache = cache;
		this._series = series;
		this._time = time;
		this._times = times;
		this._indicators = indicators;
		this._fetches = fetches;
	}

	/** From here on no engine is created and no call is held back: the chart is being destroyed. */
	public close(): void {
		this._closed = true;
	}

	/** Destroys the engine and drops the calls that waited for it. */
	public destroy(): void {
		this.engine?.destroy();
		this.engine = null;
		this._deferred = [];
	}

	/** Sends the memory limit to the engine if it changed. */
	public setMemoryLimit(limit: number): void {
		if (this.engine !== null && limit !== this._memoryLimit) {
			this._memoryLimit = limit;
			this.engine.setMemoryLimit(limit);
		}
	}

	/** The data engine, created with the first series (or plugin module). */
	public ensureEngine(): EngineClient | null {
		if (this.engine === null && !this._closed) {
			this.engine = createEngine({ packedPatches: true, worker: this._settings.options.worker });
			this.engine.onevent = this._onEvent;
			this._memoryLimit = this._settings.options.memoryLimit;
			if (this._memoryLimit !== Infinity) {
				this.engine.setMemoryLimit(this._memoryLimit);
			}
		}
		return this.engine;
	}

	/**
	 * Runs `action` once the engine has applied all data handed over so far, keeping call order.
	 * Window requests in flight do not delay it: a view change does not depend on them.
	 */
	public afterData(action: () => void): void {
		if (this._closed) {
			return;
		}
		const engine = this.engine;
		if (engine === null || !engine.dataPending) {
			this._host.syncView();
			action();
			this._host.invalidate(INVALIDATE_LIGHT);
			return;
		}
		this._deferred.push({ seq: engine.barrier(), action });
	}

	private readonly _columnCount = (id: number, level: number): number => {
		for (const series of this._series) {
			if (series.engineId === id) {
				return columnCount(series.kind, level);
			}
		}
		return 1;
	};

	private readonly _onEvent = (event: EngineEvent): void => {
		// The window to ask for depends on the pane width.
		this._layout.ensureSize();
		const scale = this._scale;
		const wasEmpty = scale.isEmpty;
		const version = scale.version;
		this._cache.apply(event, this._columnCount);
		const window = event.window;
		if (window !== undefined) {
			// Offsets of the bars that can come into view are looked up before a frame needs them.
			this._time.cover(window.time, window.count, 2 ** this._cache.level(window.level).shift);
		}
		scale.setExtent(event.first, event.end);
		const times = this._times;
		times.setTimeline(event.epoch, event.first, event.end);
		times.setWindow(this._cache.held(0));
		if (event.resolved !== undefined) {
			times.apply(event.ack, event.resolved);
		} else if (event.failed === true) {
			times.cancel(event.ack);
		}
		if (wasEmpty && !scale.isEmpty) {
			scale.reset(this._settings.options.timeScale.barSpacing, this._settings.options.timeScale.rightOffset);
		}
		this._trackLastValues(event);
		this._indicators.computing = event.computing ?? 0;
		if (event.plugins !== undefined) {
			this._indicators.settlePlugins(event.plugins);
		}
		if (
			event.fetch !== undefined ||
			event.cancel !== undefined ||
			event.restored !== undefined ||
			event.window?.incomplete === true
		) {
			this._fetches.handle(event);
		}
		// A failed command changes nothing on screen, and redrawing for it would only repeat the request.
		let changed =
			event.failed !== true &&
			(scale.version !== version || event.stale || event.window !== undefined || event.packedPatches !== undefined);
		const deferred = this._deferred;
		while (deferred.length > 0 && deferred[0]!.seq <= event.ack) {
			// Pointer input from before the call comes first.
			this._host.resolveInput();
			deferred.shift()!.action();
			changed = true;
			// A call that waited for the data can change anything.
			this._host.callApplied();
		}
		this._host.resolveView();
		if (changed) {
			// Requested now rather than in the next draw, the rows usually arrive before that frame,
			// so new data is drawn in one frame instead of an empty frame followed by the data.
			this.requestWindow(this._layout.devicePixelRatio());
			// Data alone: the frame redraws the columns that changed if everything else is as drawn.
			this._host.dataChanged();
		}
		// Nothing to draw, or a chart outside the viewport, which draws when it comes back.
		this._host.settled();
	};

	/**
	 * Takes the latest value of each series straight from the patches. The last bar is often outside
	 * the window held by the cache (the user is looking at history), and its value is still shown.
	 */
	private _trackLastValues(event: EngineEvent): void {
		const patches = event.packedPatches;
		if (patches === undefined) {
			return;
		}
		const { index, data } = patches;
		for (let p = 0; p < index.length; p += PATCH_STRIDE) {
			const rows = index[p + PATCH_COUNT]!;
			if (index[p + PATCH_LEVEL] !== 0 || index[p + PATCH_START]! + rows !== event.end) {
				continue;
			}
			const id = index[p + PATCH_SERIES];
			for (const series of this._series) {
				if (series.engineId !== id) {
					continue;
				}
				const offset = index[p + PATCH_OFFSET]!;
				const closeColumn = series.kind === 'ohlcv' ? 3 : 0;
				const close = data[offset + closeColumn * rows + rows - 1]!;
				if (close === close) {
					series.lastValue = close;
					series.lastUp = close >= data[offset + rows - 1]!;
				}
				break;
			}
		}
	}

	/**
	 * Level of detail for a bar spacing in device pixels: raw rows up to 16 bars per pixel, then the
	 * coarsest level whose buckets are not wider than a pixel.
	 */
	public levelFor(spacing: number): number {
		const scale = this._scale;
		return spacing < 1 ? levelFor(1 / spacing, scale.end - scale.first) : 0;
	}

	/**
	 * Asks the engine for the rows or buckets around the visible range at the level the view needs,
	 * unless the cache has or awaits them.
	 */
	public requestWindow(ratio: number): void {
		const scale = this._scale;
		const engine = this.engine;
		this.plannedScale = scale.version;
		if (engine !== null && !scale.isEmpty) {
			const level = this.levelFor(scale.barSpacing * ratio);
			const cache = this._cache;
			const request = cache.plan(level, scale.from, scale.to, scale.first, scale.end);
			// Each request names the levels the cache holds or awaits (the one planned just now among
			// them), so the engine patches only those; see `WindowCache.patchedLevels`.
			if (request !== null) {
				cache
					.level(level)
					.sent(
						engine.requestWindow(request.start, request.count, request.capacity, request.level, cache.patchedLevels()),
					);
			}
			// While the raw rows for the view are on their way (a fast scroll left the window, or they
			// are fetched again) or could not be fetched, the finest level is drawn instead of nothing.
			// Not before the first raw window, though: right after a load the levels are still being
			// built in the background, and the raw rows come first.
			const raw = cache.level(0);
			const visibleFrom = Math.max(scale.first, Math.ceil(scale.from - 0.5));
			const visibleTo = Math.min(scale.end, Math.floor(scale.to + 0.5) + 1);
			const covered =
				raw.capacity > 0 && raw.rowsFrom(scale.first) <= visibleFrom && raw.rowsTo(scale.end) >= visibleTo;
			if (level === 0 && !covered && (raw.capacity > 0 || raw.incomplete) && scale.end - scale.first >= 16) {
				const fallback = cache.plan(1, scale.from, scale.to, scale.first, scale.end);
				if (fallback !== null) {
					cache
						.level(1)
						.sent(
							engine.requestWindow(
								fallback.start,
								fallback.count,
								fallback.capacity,
								fallback.level,
								cache.patchedLevels(),
							),
						);
				}
			}
		}
	}
}
