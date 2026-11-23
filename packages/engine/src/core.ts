import { CHUNK_MASK, CHUNK_ROWS, CHUNK_SHIFT, TIME } from './chunk';
import { IndicatorEngine } from './indicators/engine';
import { MarksEngine } from './marks/engine';
import type { MarksOutcome } from './marks/engine';
import type { MarksChange } from './marks/protocol';
import {
	ALL_LEVELS,
	type Command,
	type EngineEvent,
	type FetchRequest,
	MAX_LEVEL,
	PATCH_COLUMNS,
	PATCH_COUNT,
	PATCH_LEVEL,
	PATCH_OFFSET,
	PATCH_SERIES,
	PATCH_START,
	PATCH_STRIDE,
	PatchSpecs,
	SPEC_COLUMNS,
	SPEC_COUNT,
	SPEC_LEVEL,
	SPEC_SERIES,
	SPEC_START,
	SPEC_STRIDE,
	type RestoreResult,
	type SeriesKind,
	TICK_STRIDE,
	TIME_PATCH,
	type TimelineResolution,
	type WindowSnapshot,
	hasLevel,
	levelColumnCount,
	levelCount,
	levelShift,
	unpackPatches,
	valueColumnCount,
} from './protocol';
import { LINE_AGGREGATES, OHLCV_AGGREGATES, Pyramid, TIME_AGGREGATES, aggregate, storeBuckets } from './pyramid';
import { ANCHOR_SHIFT, ChunkedStore, SUMMARY_BYTES } from './store';

/** Rows of the main timeline a bulk level-of-detail build handles between two yields. */
const BUILD_SLICE = 65_536;
/** Most chunks one fetch request asks for. */
const FETCH_CHUNKS = 16;
/** Most chunks let go in one go (about 3 ms of summaries on an Apple M1). */
const EVICT_SLICE = 32;
/** log2 of the rows per bucket of the finest level. */
const BUCKET_SHIFT = 4;
/** Numbers a tick keeps while it waits: its time and values. */
const TICK_ROW = TICK_STRIDE - 1;
/** Gaps between bars the typical spacing at either end of the timeline is the median of. */
const INTERVAL_ROWS = 64;

/** Value column (counted from the first value column) each level column of a kind is built from. */
const LINE_SOURCES: readonly number[] = [0, 0, 0, 0];
const OHLCV_SOURCES: readonly number[] = [0, 1, 2, 3, 4];

const EMPTY = new Float64Array(0);
const NO_RUNS: readonly number[] = [];

/** What a correction of an older bar can do now. */
const APPLY = 0;
const WAIT = 1;
const REFUSE = 2;

interface SeriesState {
	readonly id: number;
	readonly kind: SeriesKind;
	readonly store: ChunkedStore;
	readonly valueColumns: number;
	/** Level-of-detail buckets of this series' values on the main timeline. */
	readonly pyramid: Pyramid;
	readonly sources: readonly number[];
	/** Rows can be fetched again (the series has a datafeed), so they may be let go under the memory limit. */
	fetchable: boolean;
	/**
	 * Main-timeline rows changed by the command being run, as `[from, to)` pairs. Rows far apart
	 * (a correction of an old bar and an update of the last one) stay separate runs, so a patch
	 * never has to carry the untouched rows between them.
	 */
	runs: number[];
	/** Position in `runs` of the run touched last. */
	run: number;
	/** Chunks (grid numbers of this series' store) being fetched. */
	readonly fetching: Set<number>;
	/**
	 * Operations of this series waiting for rows let go, oldest first. While one waits, later ones
	 * of the series wait behind it, so they take effect in the order they were made.
	 */
	readonly queue: Held[];
}

/** An operation that waits for rows let go before it takes effect. */
interface Held {
	readonly state: SeriesState;
	/** `seq` of the command it came with, and its row in a batch of ticks (0 for other commands). */
	readonly seq: number;
	readonly row: number;
	readonly type: 'tick' | 'set' | 'prepend' | 'delete';
	/** A tick: its time and values. A set or prepend: its rows, column-major with time first. */
	readonly data: Float64Array;
	readonly count: number;
	/** Times a deletion covers, inclusive. */
	readonly from: number;
	readonly to: number;
	/** A set: whether rows may be let go from now on (unchanged when undefined). */
	readonly fetchable: boolean | undefined;
	/**
	 * A deletion in the middle: 1 when the rows before the gap move up, 0 when those after it move
	 * down, NaN until decided. Decided once, so what it needs does not change while it waits.
	 */
	side: number;
}

/** Rows of a series being fetched again. */
interface Request {
	readonly id: number;
	readonly state: SeriesState;
	readonly start: number;
	readonly end: number;
	/**
	 * For the chunks deletions remove bars from: the times the deletions waiting on the series remove,
	 * as `[from, to]` pairs (null otherwise). The source has usually removed those bars already, so
	 * they may come back without them.
	 */
	readonly cuts: readonly number[] | null;
}

/** A raw window waiting for rows to come back. */
interface DeferredWindow {
	readonly seq: number;
	readonly start: number;
	readonly count: number;
	readonly capacity: number;
}

/**
 * Buckets of a secondary series to rebuild because its bars with times in `[from, to]` came back
 * with other values than the ones let go; they wait for the other members of those buckets.
 */
interface Rebuild {
	readonly state: SeriesState;
	readonly from: number;
	readonly to: number;
}

/** How a deletion is carried out. */
interface DeletePlan {
	mode: 'none' | 'all' | 'head' | 'tail' | 'middle';
	/** Rows removed: `[d0, d1)`. */
	d0: number;
	d1: number;
	/** In the middle: the rows before the gap move up to close it; else the rows after it move down. */
	moveHead: boolean;
}

/** A chunk the memory limit could let go of now. */
interface Candidate {
	readonly state: SeriesState;
	readonly grid: number;
	readonly keepTime: boolean;
	/** Keeps the time of every 16th row (secondary series: the levels keep those of the main one). */
	readonly anchors: boolean;
	readonly distance: number;
	readonly bytes: number;
}

/**
 * The data engine: the only owner of history.
 *
 * It is synchronous and knows nothing about threads. A host feeds it commands and forwards the
 * events; `run` yields between slices of bulk work so a host on the main thread can time-slice it.
 *
 * Every series is exposed on the main timeline, which is the timeline of the first series (in
 * creation order) that has data. A bar of another series belongs to the main bar at or before its
 * time; bars sharing a main bar are merged, and bars before the first main bar are not shown.
 *
 * Level of detail: every series keeps a pyramid of buckets over the main timeline (16, 64, 256, ...
 * rows), and the main timeline keeps one for the time of each bucket's first row. Bulk loads leave
 * the pyramids to be built in the background (`backgroundStep`), so a load is answered as soon as
 * the rows are stored; the first command that needs them finishes the build first. Prepends and
 * ticks update only the buckets that hold changed rows, always from all of their members.
 *
 * Memory limit: chunks of series that can be fetched again are let go far from the view once the
 * levels are built (see `_candidates`). Anything that needs rows let go waits for them: a raw window
 * until its rows are back, a correction of a bar until its bucket can be rebuilt from all members,
 * and an operation that moves rows (a deletion) until every row it moves is back; later operations
 * of that series wait behind it.
 */
export class EngineCore {
	private readonly _series = new Map<number, SeriesState>();
	private _main: SeriesState | null = null;
	private _epoch = 0;
	private _scratch = new Float64Array(0);

	/** Bucket time of the main timeline. */
	private readonly _time = new Pyramid(TIME_AGGREGATES);
	/** Levels every built pyramid has: `levelCount` of the main timeline. */
	private _levels = 0;
	/** Pyramids waiting for a full build, in the order they are built. */
	private readonly _pending = new Set<Pyramid>();
	private _build: Generator<undefined, void, undefined> | null = null;
	/** Reused buffers: buckets being computed, aligned values of a secondary series, kernel arguments. */
	private _block = new Float64Array(0);
	private _values = new Float64Array(0);
	private readonly _sources: Float64Array[] = [];
	private readonly _bases: number[] = [];
	/** Reused patch bookkeeping: the layout of the patches of the event in the making, and ranges being merged. */
	private _packedPatches = false;
	private readonly _specs = new PatchSpecs();
	private readonly _ranges: number[] = [];
	/**
	 * Coarse levels whose patches the client gets (see `levels` of the `window` command): the ones
	 * its window cache holds or awaits. The buckets of every level are kept current regardless, so a
	 * window asked for later is right; only copying changes nobody holds is left out.
	 */
	private _patchLevels = ALL_LEVELS;
	/** State before a batch of changes, see `_beginChanges`. */
	private _changeMain: SeriesState | null = null;
	private _changeEnd = 0;

	/** Memory the engine aims to stay under, in bytes. */
	private _limit = Infinity;
	/** More chunks are over the limit and could go than one call of `_enforceLimit` lets go. */
	private _overLimit = false;
	/** Rows of the last raw window asked for, which are kept when the limit lets rows go. */
	private _pinFrom = NaN;
	private _pinTo = NaN;
	/** Fetch requests out, by id. */
	private readonly _requests = new Map<number, Request>();
	private _nextRequest = 1;
	/** A raw window waiting for rows to come back. */
	private _deferred: DeferredWindow | null = null;
	/** Corrections of older bars waiting for rows let go. They hold up nothing else. */
	private readonly _corrections: Held[] = [];
	private readonly _rebuilds: Rebuild[] = [];
	/**
	 * True while the main timeline is being replaced and another series misses rows its levels must
	 * be rebuilt from: until they are back there is no main timeline, and data operations wait.
	 */
	private _takeover = false;
	/** Chunks that waiting work needs, kept in memory until it has run. */
	private readonly _wanted = new Map<SeriesState, Set<number>>();
	/**
	 * True while a command runs. Nothing is let go meanwhile, not even by a level build it finishes:
	 * a command may have checked that the rows it needs are held before it builds.
	 */
	private _running = false;
	/** Chunks an operation needs, collected by the `_need*` methods. */
	private readonly _needStates: SeriesState[] = [];
	private readonly _needGrids: number[] = [];
	/** Whether each of them holds bars the deletion being planned removes. */
	private readonly _needCut: boolean[] = [];
	private readonly _plan: DeletePlan = { mode: 'none', d0: 0, d1: 0, moveHead: false };
	/**
	 * Deletions after which a series' indexes are re-based: the bars of several of them came back
	 * as one gap, so how many each removed is unknown (see `_restoreCut`).
	 */
	private readonly _rebaseAfter = new Map<SeriesState, Held>();

	/** Indicators and their derived series. */
	private readonly _indicators: IndicatorEngine;
	/** Scatter and heatmap series, which are not on the main timeline. */
	private readonly _marks = new MarksEngine();
	/**
	 * Main rows whose bars hold marks of a series that changed in the command being run, as
	 * `[from, to)` pairs: what the indicators reading that series take as changed input rows.
	 */
	private readonly _marksRuns = new Map<number, number[]>();
	/** Times of the bars an indicator reads marks over, and one past them; reused. */
	private _bounds = new Float64Array(0);
	/** `seq` of the last command answered, which a notice repeats. */
	private _lastAck = 0;
	/** Background work threw once: this engine runs none any more (see `stopBackground`). */
	private _backgroundStopped = false;
	/** Collects fetch requests made and cancelled between commands, which the next notice carries. */
	private readonly _background: EngineEvent = { ack: 0, epoch: 0, first: 0, end: 0, stale: false, rejected: 0 };
	private _readScratch = new Float64Array(0);
	/**
	 * Main rows `[_readFrom, _readTo)` an indicator recomputation reads next (with the rows it asks
	 * for ahead), kept in memory and fetched again while it runs (see `_ensureRows`).
	 */
	private _readFrom = NaN;
	private _readTo = NaN;

	/**
	 * Called when work finished outside a command (a plugin module loaded) and a notice is waiting;
	 * the host then calls `takeNotice`. Background steps can leave notices too, without this call.
	 */
	public onwake: (() => void) | null = null;

	public constructor() {
		this._indicators = new IndicatorEngine({
			first: () => (this._main === null ? 0 : this._main.store.first),
			end: () => (this._main === null ? 0 : this._main.store.end),
			read: (series, column, from, to, out, offset) => this._readColumn(series, column, from, to, out, offset),
			runs: series => this._series.get(series)?.runs ?? this._marksRuns.get(series) ?? NO_RUNS,
			ensure: (from, to, ahead) => this._ensureRows(from, to, ahead),
		});
		this._indicators.onwake = () => this.onwake?.();
	}

	public *run(command: Command): Generator<undefined, EngineEvent, undefined> {
		const event: EngineEvent = { ack: command.seq, epoch: 0, first: 0, end: 0, stale: false, rejected: 0 };
		if (command.packedPatches) {
			this._packedPatches = true;
		}
		this._running = true;
		try {
			yield* this._command(command, event);
		} finally {
			this._running = false;
		}
		// Once per command, after its patches and window are copied: a chunk that was the last one, or
		// in the last window, a moment ago may go now. Under the limit this is a sum of a few numbers.
		this._enforceLimit();
		this._lastAck = command.seq;
		this._finish(event);
		return event;
	}

	private *_command(command: Command, event: EngineEvent): Generator<undefined, void, undefined> {
		switch (command.type) {
			case 'add': {
				const kind = command.kind;
				const valueColumns = valueColumnCount(kind);
				const state: SeriesState = {
					id: command.series,
					kind,
					store: new ChunkedStore(valueColumns + 1),
					valueColumns,
					pyramid: new Pyramid(kind === 'ohlcv' ? OHLCV_AGGREGATES : LINE_AGGREGATES),
					sources: kind === 'ohlcv' ? OHLCV_SOURCES : LINE_SOURCES,
					fetchable: command.fetchable === true,
					runs: [],
					run: 0,
					fetching: new Set(),
					queue: [],
				};
				this._series.set(command.series, state);
				if (this._main !== null) {
					// Its buckets have to span the main timeline like every other pyramid's.
					this._pending.add(state.pyramid);
				}
				break;
			}
			case 'remove':
				yield* this._remove(command.series, event);
				break;
			case 'set':
			case 'prepend':
			case 'delete': {
				const state = this._series.get(command.series);
				if (state === undefined) {
					if (command.type !== 'delete') {
						reject(event, command.series, command.count);
					}
					break;
				}
				const deletion = command.type === 'delete';
				yield* this._operation(
					{
						state,
						seq: command.seq,
						row: 0,
						type: command.type,
						data: deletion ? EMPTY : command.data,
						count: deletion ? 0 : command.count,
						from: deletion ? command.from : 0,
						to: deletion ? command.to : 0,
						fetchable: command.type === 'set' ? command.fetchable : undefined,
						side: NaN,
					},
					event,
				);
				break;
			}
			case 'ticks':
				yield* this._ticks(command.seq, command.data, command.count, event);
				break;
			case 'window': {
				const levels = command.levels;
				// The level asked for is held from here on, whatever the client says. An older client
				// sends no set and gets every level, as before.
				this._patchLevels =
					typeof levels === 'number'
						? levels | 1 | (command.level >= 0 && command.level <= MAX_LEVEL ? 1 << command.level : 0)
						: ALL_LEVELS;
				const main = this._main;
				if (command.level > 0 || main === null || this._takeover) {
					if (command.level > 0) {
						yield* this._drain();
					}
					yield* this._window(command.level, command.start, command.count, command.capacity, command.seq, event);
					break;
				}
				const store = main.store;
				const from = Math.min(Math.max(command.start, store.first), store.end);
				this._pinFrom = from;
				this._pinTo = Math.max(from, Math.min(command.start + command.count, store.end));
				// A newer raw window replaces one still waiting; requests only the old one needed are cancelled.
				this._deferred = { seq: command.seq, start: command.start, count: command.count, capacity: command.capacity };
				yield* this._progress(event);
				break;
			}
			case 'limit':
				this._limit = command.bytes > 0 ? command.bytes : Infinity;
				break;
			case 'rows':
				yield* this._restore(command.request, command.count, command.data, event);
				break;
			case 'indicator':
				this._indicators.set(command.id, command.name, command.params, command.inputs, command.outputs);
				break;
			case 'removeIndicator':
				this._indicators.remove(command.id);
				break;
			case 'plugin':
				this._indicators.load(command.url);
				break;
			case 'resolve':
				event.resolved = this._resolveTimes(command.times);
				break;
			case 'marks':
				yield* this._marks.change(command.series, command.change, event);
				if (event.rejected > 0) {
					event.rejectedSeries = [command.series, event.rejected];
				}
				yield* this._followMarks(event);
				break;
			case 'marksWindow':
				this._marks.window(command.series, command.seq, command.request, event);
				break;
			case 'marksRows': {
				const times = this._marks.requestTimes(command.request);
				yield* this._marks.restore(command.request, command.data, event);
				// Changes that waited for the marks ran: what they refused, and a change dropped after its
				// marks were refused round after round, are reported for the series.
				if (event.rejected > 0 && event.marksRestored !== undefined) {
					event.rejectedSeries = [event.marksRestored.series, event.rejected];
				}
				yield* this._followMarks(event);
				const outcome = event.marksRestored;
				if (outcome !== undefined) {
					if (outcome.outcome === 'restored') {
						this._indicators.rowsRestored();
					} else if (times !== null && this._main !== null && this._main.store.length > 0) {
						this._indicators.rowsFailed(this._mainIndex(times.from), this._mainIndex(times.to) + 1);
					}
				}
				break;
			}
		}
	}

	/**
	 * True while level-of-detail buckets are waiting to be built, indicators to be recomputed, or
	 * chunks to be let go.
	 */
	public get busy(): boolean {
		if (this._backgroundStopped) {
			return false;
		}
		return this._pending.size > 0 || this._indicators.busy || this._overLimit;
	}

	/**
	 * True while indicators are being recomputed: background work whose result the chart waits to
	 * show, which a host on the main thread should not leave to idle time.
	 */
	public get urgent(): boolean {
		return !this._backgroundStopped && this._indicators.busy;
	}

	/** Bytes held by every store and pyramid, indicators included. */
	public get byteLength(): number {
		let bytes = this._time.byteLength + this._indicators.byteLength + this._marks.byteLength;
		for (const state of this._series.values()) {
			bytes += state.store.byteLength + state.pyramid.byteLength;
		}
		return bytes;
	}

	/**
	 * Memory held, and how much of it the memory limit could still let go: chunks of fetchable series
	 * away from the last raw window and from the edges of the timeline (see `_candidates`). Also the
	 * fetch requests out and the operations waiting for rows let go, to tell that none is forgotten.
	 */
	public get memory(): { bytes: number; limit: number; evictable: number; requests: number; waiting: number } {
		let evictable = 0;
		if (this._pending.size === 0 && this._evicting()) {
			for (const candidate of this._candidates()) {
				evictable += candidate.bytes;
			}
		}
		let waiting = this._corrections.length + this._rebuilds.length + this._marks.waiting;
		for (const state of this._series.values()) {
			waiting += state.queue.length;
		}
		const requests = this._requests.size + this._marks.requests;
		return { bytes: this.byteLength, limit: this._limit, evictable, requests, waiting };
	}

	/**
	 * Runs one slice of background work: indicator recomputations first, then the build of
	 * level-of-detail buckets, then letting go of chunks over the memory limit. Returns true while
	 * more remains. A host calls this when no command is waiting, and afterwards `takeNotice`;
	 * commands that need the buckets finish the build themselves.
	 */
	public backgroundStep(): boolean {
		if (this._backgroundStopped) {
			return false;
		}
		if (this._indicators.step() || this._buildStep()) {
			return true;
		}
		// Rows can only be let go once the levels that summarize them are built, and rows a
		// recomputation read may go once it is done with them.
		this._enforceLimit();
		return this._overLimit;
	}

	/**
	 * An event that is not the answer to a command, or null: indicator values swapped in (the windows
	 * held are stale; the latest values come as patches), plugin modules loaded, or rows to fetch
	 * again for a recomputation (and requests no longer needed). Its `ack` repeats the last command
	 * answered.
	 */
	public takeNotice(): EngineEvent | null {
		this._specs.clear();
		const swapped = this._indicators.takeNotice(this._specs);
		const plugins = this._indicators.takePlugins();
		const { fetch, cancel, marksFetch, marksCancel } = this._background;
		if (
			!swapped &&
			plugins === null &&
			fetch === undefined &&
			cancel === undefined &&
			marksFetch === undefined &&
			marksCancel === undefined
		) {
			return null;
		}
		const event: EngineEvent = { ack: this._lastAck, epoch: 0, first: 0, end: 0, stale: swapped, rejected: 0 };
		if (plugins !== null) {
			event.plugins = plugins;
		}
		if (fetch !== undefined) {
			event.fetch = fetch;
			delete this._background.fetch;
		}
		if (cancel !== undefined) {
			event.cancel = cancel;
			delete this._background.cancel;
		}
		if (marksFetch !== undefined) {
			event.marksFetch = marksFetch;
			delete this._background.marksFetch;
		}
		if (marksCancel !== undefined) {
			event.marksCancel = marksCancel;
			delete this._background.marksCancel;
		}
		if (swapped) {
			this._emit(event);
		}
		this._finish(event);
		return event;
	}

	/**
	 * Stops the background work of this engine after a step of it threw `error` (a custom indicator
	 * kernel, say), and returns the notice that tells the client: a failure that answers no command,
	 * and no indicator computing any more, so nobody waits for values that will not come. What the
	 * step was doing would throw again, so the engine runs no background work from here on; commands
	 * go on, and a command that needs levels of detail builds them itself.
	 */
	public stopBackground(error: unknown): EngineEvent {
		this._backgroundStopped = true;
		const main = this._main;
		return {
			ack: this._lastAck,
			epoch: this._epoch,
			first: main === null ? 0 : main.store.first,
			end: main === null ? 0 : main.store.end,
			stale: false,
			rejected: 0,
			failed: true,
			computing: 0,
			error: error instanceof Error ? error.message : String(error),
		};
	}

	/**
	 * Event for a command that threw `error`: it tells the client the command is over, what still
	 * holds, and what was thrown, as text so it can cross to another thread.
	 */
	public failure(command: Command, error?: unknown): EngineEvent {
		const main = this._main;
		this._lastAck = command.seq;
		const event: EngineEvent = {
			ack: command.seq,
			epoch: this._epoch,
			first: main === null ? 0 : main.store.first,
			end: main === null ? 0 : main.store.end,
			stale: true,
			rejected: 0,
			failed: true,
		};
		if (error !== undefined) {
			event.error = error instanceof Error ? error.message : String(error);
		}
		return event;
	}

	// Timeline

	/** Picks the main series. */
	private _electMain(): void {
		this._main = this._firstWithData();
	}

	/** The first series in creation order that has data: the one whose timeline is the main one. */
	private _firstWithData(): SeriesState | null {
		for (const state of this._series.values()) {
			if (state.store.length > 0) {
				return state;
			}
		}
		return null;
	}

	/**
	 * The main timeline was replaced (new rows, or another main series). Every pyramid is built again
	 * over it, which needs every row of every series: if a series misses rows let go, there is no
	 * main timeline until they are back (`_takeover`).
	 */
	private _timelineChanged(event: EngineEvent): void {
		this._main = null;
		this._pending.clear();
		this._build = null;
		let missing = false;
		for (const state of this._series.values()) {
			if (state.store.length > 0 && state.store.evictedCount > 0) {
				missing = true;
				break;
			}
		}
		this._takeover = missing;
		if (!missing) {
			this._electMain();
			this._rebuildAll();
		}
		this._rebase(event);
	}

	/**
	 * Indexes now mean other bars: a raw window waiting for rows is answered empty, pins are dropped,
	 * and indicator values, which are kept by index, are dropped and computed again.
	 */
	private _rebase(event: EngineEvent): void {
		this._epoch++;
		this._indicators.timelineChanged();
		this._pinFrom = NaN;
		this._pinTo = NaN;
		// The rows a recomputation was reading are old indexes, possibly past the new timeline; the
		// recomputation starts over and names the rows it reads again.
		this._readFrom = NaN;
		this._readTo = NaN;
		const deferred = this._deferred;
		if (deferred !== null) {
			this._deferred = null;
			event.window ??= {
				level: 0,
				request: deferred.seq,
				start: 0,
				count: 0,
				capacity: 0,
				time: EMPTY,
				series: [],
			};
		}
	}

	/** Fills in the extent of the main timeline and the indicators still computing. */
	private _finish(event: EngineEvent): void {
		const main = this._main;
		if (!this._packedPatches && event.packedPatches !== undefined) {
			event.patches = unpackPatches(event.packedPatches);
			delete event.packedPatches;
		}
		event.epoch = this._epoch;
		if (main !== null) {
			event.first = main.store.first;
			event.end = main.store.end;
		}
		const computing = this._indicators.pending;
		if (computing > 0) {
			event.computing = computing;
		}
	}

	/** The main timeline changed: every pyramid is built again, and every indicator recomputed. */
	private _rebuildAll(): void {
		this._indicators.timelineChanged();
		this._pending.clear();
		this._pending.add(this._time);
		for (const state of this._series.values()) {
			this._pending.add(state.pyramid);
		}
		this._build = null;
	}

	// Operations

	/** Runs a set, prepend or delete now, or holds it until the rows it needs are back. */
	private *_operation(op: Held, event: EngineEvent): Generator<undefined, void, undefined> {
		const state = op.state;
		if (op.type === 'set') {
			// A new history replaces everything that still waits for the old one.
			this._forget(state, event);
		}
		// A set can take over even while the timeline is being replaced: it brings all of its rows.
		const blocked = op.type === 'set' ? false : this._takeover || state.queue.length > 0;
		if (blocked || !this._ready(op)) {
			this._hold(op, event);
		} else {
			yield* this._apply(op, event, false);
		}
		if (this._busyWaiting()) {
			yield* this._progress(event);
		}
	}

	private _hold(op: Held, event: EngineEvent): void {
		op.state.queue.push(op);
		(event.waiting ??= []).push(op.row);
	}

	/** True when something waits for rows let go or requests are out. */
	private _busyWaiting(): boolean {
		if (
			this._takeover ||
			this._deferred !== null ||
			this._requests.size > 0 ||
			this._corrections.length > 0 ||
			this._rebuilds.length > 0
		) {
			return true;
		}
		for (const state of this._series.values()) {
			if (state.queue.length > 0) {
				return true;
			}
		}
		return false;
	}

	/** True when `op` can take effect now; otherwise the chunks it needs are in `_need*`. */
	private _ready(op: Held): boolean {
		const state = op.state;
		if (op.type === 'tick') {
			return this._tickReady(state, op.data[0]!);
		}
		const main = this._main;
		this._clearNeeds();
		if (main !== null && state !== main && main.store.timelessCount > 0 && (op.type !== 'set' || op.count > 0)) {
			// Another series is drawn on the main timeline, which takes the time of every main bar.
			this._needTimeless(main);
			return false;
		}
		switch (op.type) {
			case 'set':
				return true;
			case 'delete':
				return this._planDelete(op, this._plan);
			default:
				return this._prependReady(state);
		}
	}

	private *_apply(op: Held, event: EngineEvent, held: boolean): Generator<undefined, void, undefined> {
		switch (op.type) {
			case 'set':
				reject(event, op.state.id, yield* this._set(op.state, op.data, op.count, op.fetchable, event));
				event.stale = true;
				break;
			case 'prepend':
				yield* this._prepend(op.state, op.data, op.count, event);
				break;
			case 'delete':
				yield* this._delete(op, event);
				if (this._rebaseAfter.get(op.state) === op) {
					this._rebaseAfter.delete(op.state);
					if (op.state === this._main) {
						this._rebase(event);
					}
					event.stale = true;
				}
				break;
			case 'tick':
				yield* this._drain();
				this._beginChanges();
				this._tick(op.state, op.data, 0, op.seq, op.row, event, op);
				this._endChanges(event, true);
				// A tick reports itself once it takes effect.
				return;
		}
		if (held) {
			(event.applied ??= []).push(op.seq, op.row);
		}
	}

	/** Drops everything that waits for the rows of a series, and its requests. */
	private _forget(state: SeriesState, event: EngineEvent): void {
		for (const [id, request] of this._requests) {
			if (request.state === state) {
				this._requests.delete(id);
				(event.cancel ??= []).push(id);
			}
		}
		state.fetching.clear();
		state.queue.length = 0;
		removeWhere(this._corrections, op => op.state === state);
		removeWhere(this._rebuilds, rebuild => rebuild.state === state);
		this._wanted.delete(state);
		this._rebaseAfter.delete(state);
	}

	private *_remove(id: number, event: EngineEvent): Generator<undefined, void, undefined> {
		const state = this._series.get(id);
		if (state === undefined) {
			return;
		}
		this._forget(state, event);
		this._series.delete(id);
		this._pending.delete(state.pyramid);
		this._build = null;
		if (state === this._main) {
			this._timelineChanged(event);
			event.stale = true;
		} else {
			this._indicators.seriesChanged(id);
		}
		if (this._busyWaiting()) {
			yield* this._progress(event);
		}
	}

	private *_set(
		state: SeriesState,
		data: Float64Array,
		count: number,
		fetchable: boolean | undefined,
		event: EngineEvent,
	): Generator<undefined, number, undefined> {
		const wasMain = state === this._main;
		if (fetchable !== undefined) {
			state.fetchable = fetchable;
		}
		state.store.clear();
		const rejected = yield* this._append(state.store, data, count);
		// A series created before the main one takes over the timeline once it has data.
		if (wasMain || this._firstWithData() !== this._main) {
			this._timelineChanged(event);
		} else {
			this._pending.add(state.pyramid);
			this._build = null;
			this._indicators.seriesChanged(state.id);
		}
		return rejected;
	}

	/** Appends rows while their times keep increasing. Returns the number of rows left out. */
	private *_append(store: ChunkedStore, data: Float64Array, count: number): Generator<undefined, number, undefined> {
		let previous = store.length > 0 ? store.lastTime() : -Infinity;
		for (let from = 0; from < count; from += CHUNK_ROWS) {
			const to = Math.min(count, from + CHUNK_ROWS);
			let valid = to;
			for (let i = from; i < to; i++) {
				const time = data[i]!;
				// Written this way so a NaN time fails too.
				if (!(time > previous)) {
					valid = i;
					break;
				}
				previous = time;
			}
			store.append(data, count, from, valid);
			if (valid < to) {
				return count - valid;
			}
			yield;
		}
		return 0;
	}

	private *_prepend(
		state: SeriesState,
		data: Float64Array,
		count: number,
		event: EngineEvent,
	): Generator<undefined, void, undefined> {
		if (state.store.length === 0) {
			reject(event, state.id, yield* this._set(state, data, count, undefined, event));
			event.stale = true;
			return;
		}
		yield* this._drain();
		const store = state.store;
		const oldFirst = store.first;
		const oldFirstTime = store.firstTime();
		reject(event, state.id, yield* this._prependRows(store, data, count));
		if (state === this._main) {
			// Prepending to the main series keeps every existing index, so the client's windows stay
			// valid, except for the first bucket of each level, which can gain rows.
			yield* this._extendLeft(oldFirst);
			this._boundaryPatches(oldFirst, event);
			this._indicators.prepended(oldFirst);
		} else {
			if (this._main !== null && store.first < oldFirst) {
				const main = this._main.store;
				const lo = Math.max(main.first, this._mainIndex(store.firstTime()));
				const hi = this._mainIndex(oldFirstTime) + 1;
				yield* this._refreshSliced(state.pyramid, state, lo, hi);
			}
			this._indicators.seriesChanged(state.id);
			event.stale = true;
		}
	}

	/** Prepends rows, walking backward from the newest. Returns the number of rows left out. */
	private *_prependRows(
		store: ChunkedStore,
		data: Float64Array,
		count: number,
	): Generator<undefined, number, undefined> {
		let next = store.firstTime();
		for (let to = count; to > 0; to -= CHUNK_ROWS) {
			const from = Math.max(0, to - CHUNK_ROWS);
			let valid = from;
			for (let i = to - 1; i >= from; i--) {
				const time = data[i]!;
				if (!(time < next)) {
					valid = i + 1;
					break;
				}
				next = time;
			}
			store.prepend(data, count, valid, to);
			if (valid > from) {
				return valid;
			}
			yield;
		}
		return 0;
	}

	/**
	 * Whether a prepend can run: the buckets it rebuilds at the old first bar of a series take
	 * members of other series there (or, for a secondary series, its own bars next to its first).
	 */
	private _prependReady(state: SeriesState): boolean {
		const main = this._main;
		const store = state.store;
		if (main === null || store.length === 0) {
			return true;
		}
		this._clearNeeds();
		if (state === main) {
			if (this._series.size > 1) {
				const edge = ((store.first >> BUCKET_SHIFT) + 1) << BUCKET_SHIFT;
				const until = edge < store.end ? this._rowTime(edge) : Infinity;
				for (const other of this._series.values()) {
					if (other !== main && other.store.evictedCount > 0) {
						this._needTimes(other, -Infinity, until);
					}
				}
			}
		} else if (store.evictedCount > 0) {
			const firstTime = store.firstTime();
			if (firstTime >= main.store.firstTime()) {
				this._needBucket(state, this._mainIndex(firstTime));
			}
		}
		return !this._missing(0);
	}

	// Ticks

	private *_ticks(
		seq: number,
		data: Float64Array,
		count: number,
		event: EngineEvent,
	): Generator<undefined, void, undefined> {
		yield* this._drain();
		this._beginChanges();
		const series = this._series;
		let id = NaN;
		let state: SeriesState | undefined;
		for (let i = 0, offset = 0; i < count; i++, offset += TICK_STRIDE) {
			const tickSeries = data[offset]!;
			if (tickSeries !== id) {
				id = tickSeries;
				state = series.get(tickSeries);
			}
			const time = data[offset + 1]!;
			if (state === undefined || time !== time) {
				reject(event, tickSeries, 1);
				continue;
			}
			this._tick(state, data, offset + 1, seq, i, event, null);
		}
		this._endChanges(event, true);
		if (this._busyWaiting()) {
			yield* this._progress(event);
		}
	}

	/**
	 * Applies one tick read from `row[offset, offset + TICK_ROW)`: an update of the last bar, a new
	 * bar, or a correction of an older one. `op` is the tick's waiting operation once it waited.
	 */
	private _tick(
		state: SeriesState,
		row: Float64Array,
		offset: number,
		seq: number,
		index: number,
		event: EngineEvent,
		op: Held | null,
	): void {
		const time = row[offset]!;
		if (op === null && (this._takeover || state.queue.length > 0 || !this._tickReady(state, time))) {
			this._hold(heldTick(state, row, offset, seq, index), event);
			return;
		}
		const store = state.store;
		let at: number;
		let appended = false;
		if (store.length === 0) {
			store.appendRow(row, offset);
			at = store.end - 1;
			appended = true;
			if (this._firstWithData() !== this._main) {
				this._timelineChanged(event);
				event.stale = true;
			}
		} else {
			const last = store.lastTime();
			if (time === last) {
				at = store.end - 1;
				store.writeRow(at, row, offset);
			} else if (time > last) {
				store.appendRow(row, offset);
				at = store.end - 1;
				appended = true;
			} else {
				// A correction of an older bar. Inserting a bar in the middle would shift indexes, so it is refused.
				const verdict = this._correction(state, time);
				if (verdict === REFUSE) {
					reject(event, state.id, 1);
					if (op !== null) {
						(event.refused ??= []).push(seq, index);
					}
					return;
				}
				if (verdict === WAIT) {
					// Waits without holding anything else up: corrections of other bars, new bars and
					// prepends do not depend on it, and deletions find the bar by its time either way.
					if (op === null) {
						this._corrections.push(heldTick(state, row, offset, seq, index));
						(event.waiting ??= []).push(index);
					} else {
						this._corrections.push(op);
					}
					return;
				}
				at = store.lowerBound(time);
				store.writeRow(at, row, offset);
			}
		}
		if (op !== null) {
			(event.applied ??= []).push(seq, index);
		}
		const main = this._main;
		if (main === null) {
			return;
		}
		if (state === main) {
			markDirty(main, at);
			if (appended && this._series.size > 1) {
				// Bars of other series at or after the new bar's time were merged into the previous
				// main bar and now belong to the new one.
				for (const other of this._series.values()) {
					if (other !== main && other.store.length > 0 && other.store.lastTime() >= time) {
						if (at > main.store.first) {
							markDirty(other, at - 1);
						}
						markDirty(other, at);
					}
				}
			}
		} else {
			const mainIndex = this._mainIndex(time);
			if (mainIndex >= main.store.first) {
				markDirty(state, mainIndex);
			}
		}
	}

	/**
	 * Whether a tick on the last bar (or a new one) can run. Rebuilding the last buckets takes the
	 * bars of other series there; the memory limit keeps them, so this waits only in corner cases.
	 */
	private _tickReady(state: SeriesState, time: number): boolean {
		const main = this._main;
		if (main === null) {
			return true;
		}
		if (state === main) {
			if (this._series.size === 1 || !(time > main.store.lastTime())) {
				return true;
			}
			this._clearNeeds();
			const from = this._rowTime(((main.store.end - 1) >> BUCKET_SHIFT) << BUCKET_SHIFT);
			for (const other of this._series.values()) {
				if (other !== main && other.store.evictedCount > 0) {
					this._needTimes(other, from, Infinity);
				}
			}
			return !this._missing(0);
		}
		this._clearNeeds();
		if (main.store.timelessCount > 0) {
			this._needTimeless(main);
			return false;
		}
		const store = state.store;
		if (store.evictedCount > 0 && time >= store.lastTime()) {
			const mainIndex = this._mainIndex(time);
			if (mainIndex >= main.store.first) {
				this._needBucket(state, mainIndex);
			}
		}
		return !this._missing(0);
	}

	/**
	 * Whether a correction of the bar at `time` (older than the last bar) applies now, waits for rows
	 * let go, or is refused because no bar has that time. Its bucket is rebuilt from all members, so
	 * the bar's chunk must be held, and for a secondary series every bar of that bucket.
	 */
	private _correction(state: SeriesState, time: number): number {
		const store = state.store;
		const grid = store.chunkOf(time);
		if (grid !== grid) {
			// Before the first bar, or between two chunks: no bar has this time.
			return REFUSE;
		}
		if (store.hasTime(grid) && store.value(TIME, store.lowerBound(time)) !== time) {
			return REFUSE;
		}
		this._clearNeeds();
		this._need(state, grid);
		const main = this._main!;
		if (state !== main) {
			const mainIndex = this._mainIndex(time);
			if (mainIndex >= main.store.first) {
				this._needBucket(state, mainIndex);
			}
		}
		return this._missing(0) ? WAIT : APPLY;
	}

	/** Starts a batch of changes whose patches `_endChanges` emits. */
	private _beginChanges(): void {
		for (const state of this._series.values()) {
			state.runs.length = 0;
			state.run = 0;
		}
		const main = this._main;
		this._changeMain = main;
		this._changeEnd = main === null ? 0 : main.store.end;
	}

	/**
	 * Rebuilds the buckets of the rows changed since `_beginChanges` and emits their patches. `ticks`
	 * says the changes were ticks alone, which change no time of a row they do not append.
	 */
	private _endChanges(event: EngineEvent, ticks = false): void {
		const main = this._main;
		if (main === null || main !== this._changeMain) {
			// A new main timeline: every pyramid is built again and the client asks for new windows.
			return;
		}
		const series = this._series;
		const endBefore = this._changeEnd;
		const end = main.store.end;
		this._refreshRuns(this._time, null, main.runs);
		this._refreshRuns(main.pyramid, main, main.runs);
		for (const other of series.values()) {
			if (other !== main) {
				this._refreshRuns(other.pyramid, other, other.runs);
				if (end > endBefore) {
					// New main bars open buckets in every pyramid, including the series that have no value there.
					this._refresh(other.pyramid, other, endBefore, end);
				}
			}
		}
		this._growLevels();

		const specs = this._specs;
		specs.clear();
		// The main series goes first: its time patches tell the client which rows exist.
		this._specRuns(main, true);
		for (const other of series.values()) {
			if (other !== main) {
				this._specRuns(other, false);
			}
		}
		const held = this._patchLevels;
		// A bucket's time is the time of its first row, so without a new bar ticks leave it as it was.
		const times = !ticks || end > endBefore;
		for (let level = 1; level <= this._levels; level++) {
			if (!hasLevel(held, level)) {
				continue;
			}
			if (times) {
				this._specLevel(level, TIME_PATCH, main.runs, 0, 0);
			}
			this._specLevel(level, main.id, main.runs, 0, 0);
			for (const other of series.values()) {
				if (other !== main) {
					this._specLevel(level, other.id, other.runs, endBefore, end);
				}
			}
		}
		// A new bar takes the marks from its time on from the bar before it, which indicators reading
		// marks take as changed.
		if (end > endBefore) {
			this._marksReadRuns(Math.max(main.store.first, endBefore - 1), end);
		}
		// Indicator values change with their inputs and travel in the same message: new bars, ticks,
		// and corrections, also those that waited for rows let go or came back changed at the source.
		this._indicators.ticks(endBefore, specs, held);
		this._marksRuns.clear();
		this._emit(event);
	}

	/** Gives every marks series an indicator reads the changed main rows `[from, to)`. */
	private _marksReadRuns(from: number, to: number): void {
		const read = new Set<number>();
		this._indicators.readSeries(read);
		for (const series of read) {
			if (this._marks.has(series)) {
				this._marksRuns.set(series, [from, to]);
			}
		}
	}

	/**
	 * Follows the changes of marks series that took effect in the command being run: the timelines
	 * they make, then the indicators that read them.
	 */
	private *_followMarks(event: EngineEvent): Generator<undefined, void, undefined> {
		const outcome = event as MarksOutcome;
		const applied = outcome.appliedMarks;
		const removedTimeline = outcome.removedTimeline;
		delete outcome.appliedMarks;
		delete outcome.removedTimeline;
		if (applied !== undefined) {
			for (const { series, change } of applied) {
				yield* this._followTimeline(series, change, event);
				this._marksChanged(series, change, event);
			}
		}
		if (removedTimeline !== undefined) {
			const state = this._series.get(removedTimeline);
			if (state !== undefined) {
				const times = this._marks.unionBucketTimes(removedTimeline, -Infinity, Infinity);
				yield* this._operation(
					{
						state,
						seq: event.ack,
						row: 0,
						type: 'set',
						data: bars(times),
						count: times.length,
						from: 0,
						to: 0,
						fetchable: undefined,
						side: NaN,
					},
					event,
				);
			}
		}
	}

	/**
	 * Makes the bars of the line series one or more marks series share as their timeline (see
	 * `MarksTimeline`) follow a change of one contributor: bars for the union of all contributors'
	 * buckets, removing bars only once no contributor holds marks there.
	 */
	private *_followTimeline(
		series: number,
		change: MarksChange,
		event: EngineEvent,
	): Generator<undefined, void, undefined> {
		const link = this._marks.timelineOf(series);
		const state = link === null ? undefined : this._series.get(link.series);
		if (link === null || state === undefined) {
			return;
		}
		const timelineSeries = link.series;
		const interval = link.interval;
		const store = state.store;
		const contributors = this._marks.timelineContributors(timelineSeries);
		const shared = contributors.length > 1;
		const operation = (
			type: 'set' | 'prepend' | 'delete',
			data: Float64Array,
			count: number,
			from = 0,
			to = 0,
		): Held => ({
			state,
			seq: event.ack,
			row: 0,
			type,
			data,
			count,
			from,
			to,
			fetchable: undefined,
			side: NaN,
		});
		const rebuildUnion = (): Generator<undefined, void, undefined> => {
			const times = this._marks.unionBucketTimes(timelineSeries, -Infinity, Infinity);
			return this._operation(operation('set', bars(times), times.length), event);
		};
		const hasBar = (time: number): boolean => {
			if (store.length === 0) {
				return false;
			}
			const index = store.lowerBound(time);
			return index < store.end && store.timeAt(index) === time;
		};
		const deleteOrphans = function* (
			self: EngineCore,
			from: number,
			to: number,
		): Generator<undefined, void, undefined> {
			if (store.length === 0 || !(from <= to)) {
				return;
			}
			const runs: number[] = [];
			const end = store.upperBound(to);
			let runFrom = NaN;
			let runTo = NaN;
			for (let i = store.lowerBound(from); i < end; i++) {
				const t = store.timeAt(i);
				if (!self._marks.hasBucket(timelineSeries, t)) {
					if (runFrom !== runFrom) {
						runFrom = t;
					}
					runTo = t;
				} else if (runFrom === runFrom) {
					runs.push(runFrom, runTo);
					runFrom = NaN;
				}
			}
			if (runFrom === runFrom) {
				runs.push(runFrom, runTo);
			}
			for (let r = runs.length - 2; r >= 0; r -= 2) {
				yield* self._operation(operation('delete', EMPTY, 0, runs[r]!, runs[r + 1]!), event);
			}
		};
		switch (change.op) {
			case 'set':
				yield* rebuildUnion();
				return;
			case 'prepend': {
				if (store.length === 0) {
					yield* rebuildUnion();
					return;
				}
				const first = store.firstTime();
				if (!shared) {
					const times = this._marks.bucketTimes(series, interval, -Infinity, first);
					const older = times.filter(time => time < first);
					if (older.length > 0) {
						yield* this._operation(operation('prepend', bars(older), older.length), event);
					}
					return;
				}
				let maxTime = -Infinity;
				for (let i = 0; i < change.data.count; i++) {
					const t = change.data.time[i]!;
					if (t > maxTime) {
						maxTime = t;
					}
				}
				if (!(maxTime > -Infinity)) {
					return;
				}
				const scanEnd = interval > 0 ? (Math.floor(maxTime / interval) + 1) * interval : maxTime + 1;
				const times = this._marks.bucketTimes(series, interval, -Infinity, scanEnd);
				const older: number[] = [];
				for (const time of times) {
					if (time < first) {
						older.push(time);
					} else if (!hasBar(time)) {
						yield* rebuildUnion();
						return;
					}
				}
				if (older.length > 0) {
					yield* this._operation(operation('prepend', bars(older), older.length), event);
				}
				return;
			}
			case 'append': {
				if (store.length === 0) {
					yield* rebuildUnion();
					return;
				}
				const last = store.lastTime();
				let newer: number[];
				if (!shared) {
					newer = this._marks.bucketTimes(series, interval, last, Infinity).filter(time => time > last);
				} else {
					let minTime = Infinity;
					for (let i = 0; i < change.data.count; i++) {
						const t = change.data.time[i]!;
						if (t < minTime) {
							minTime = t;
						}
					}
					if (!(minTime < Infinity)) {
						return;
					}
					const scanStart = interval > 0 ? Math.floor(minTime / interval) * interval : minTime;
					const times = this._marks.bucketTimes(series, interval, scanStart, Infinity);
					newer = [];
					for (const time of times) {
						if (time > last) {
							newer.push(time);
						} else if (!hasBar(time)) {
							yield* rebuildUnion();
							return;
						}
					}
				}
				if (newer.length > 0) {
					const data = new Float64Array(newer.length * TICK_STRIDE).fill(NaN);
					newer.forEach((time, i) => {
						data[i * TICK_STRIDE] = state.id;
						data[i * TICK_STRIDE + 1] = time;
					});
					yield* this._ticks(event.ack, data, newer.length, event);
				}
				return;
			}
			case 'delete': {
				let from = interval > 0 ? Math.floor(change.from / interval) * interval : change.from;
				let to = interval > 0 ? Math.floor(change.to / interval) * interval : change.to;
				if (!shared) {
					// The buckets inside the range lost every mark; those at its ends may keep some.
					const kept = (start: number): boolean =>
						this._marks.bucketTimes(series, interval, start, interval > 0 ? start + interval : start + 1).length > 0;
					if (interval > 0 && kept(from)) {
						from += interval;
					}
					if (interval > 0 && to >= from && kept(to)) {
						to -= interval;
					}
					if (to >= from) {
						yield* this._operation(operation('delete', EMPTY, 0, from, to), event);
					}
					return;
				}
				yield* deleteOrphans(this, from, to);
				return;
			}
			case 'correct': {
				if (change.data.kind === 'heatmap') {
					// Heatmap corrections replace cells at existing column timestamps: timeline bars are unchanged.
					return;
				}
				let low = change.from;
				let high = change.to;
				if (low === undefined || high === undefined) {
					low = Infinity;
					high = -Infinity;
					for (let i = 0; i < change.data.count; i++) {
						const t = change.data.time[i]!;
						if (t - t === 0) {
							if (t < low) low = t;
							if (t > high) high = t;
						}
					}
				}
				if (!(low <= high) || !(interval > 0)) {
					return;
				}
				const from = Math.floor(low / interval) * interval;
				const to = Math.floor(high / interval) * interval;
				const present = this._marks.bucketTimes(series, interval, from, to + interval);
				for (const time of present) {
					if (!hasBar(time)) {
						yield* rebuildUnion();
						return;
					}
				}
				yield* deleteOrphans(this, from, to);
				return;
			}
		}
	}

	/**
	 * A marks series changed: indicators reading it follow. An append changes the bars its marks fall
	 * in, which are recomputed in place with the patches of their outputs in this event; any other
	 * change recomputes them in the background.
	 */
	private _marksChanged(series: number, change: MarksChange, event: EngineEvent): void {
		if (change.op === 'add' || !this._indicators.reads(series)) {
			return;
		}
		const main = this._main;
		if (change.op !== 'append' || main === null || main.store.length === 0) {
			this._indicators.seriesChanged(series);
			return;
		}
		let first = Infinity;
		const times = change.data.time;
		for (let i = 0; i < change.data.count; i++) {
			const time = times[i]!;
			if (time < first) {
				first = time;
			}
		}
		if (!(first < Infinity)) {
			return;
		}
		const store = main.store;
		const row = first < store.firstTime() ? store.first : this._mainIndex(first);
		this._beginChanges();
		this._marksRuns.set(series, [row, store.end]);
		this._specs.clear();
		this._indicators.ticks(store.end, this._specs, this._patchLevels);
		this._marksRuns.clear();
		this._emit(event);
	}

	/** Adds one raw patch spec per run of changed rows of a series (and the time column for the main series). */
	private _specRuns(state: SeriesState, main: boolean): void {
		const runs = state.runs;
		const specs = this._specs;
		for (let r = 0; r < runs.length; r += 2) {
			const start = runs[r]!;
			const rows = runs[r + 1]! - start;
			if (main) {
				specs.push(TIME_PATCH, 0, start, rows, 1);
			}
			specs.push(state.id, 0, start, rows, state.valueColumns);
		}
	}

	/**
	 * Adds the patch specs of one level for the buckets holding the rows of `runs`, plus rows
	 * `[extraFrom, extraTo)`. Ranges that meet in the same bucket become one patch.
	 */
	private _specLevel(level: number, series: number, runs: readonly number[], extraFrom: number, extraTo: number): void {
		// Kept at the length it grew to, with the count beside it: emptied, it would grow again per call.
		const ranges = this._ranges;
		let length = 0;
		for (let r = 0; r < runs.length; r += 2) {
			length = insertRange(ranges, length, runs[r]!, runs[r + 1]!);
		}
		if (extraTo > extraFrom) {
			length = insertRange(ranges, length, extraFrom, extraTo);
		}
		if (length === 0) {
			return;
		}
		const shift = levelShift(level);
		const columns = series === TIME_PATCH ? 1 : levelColumnCount(this._series.get(series)!.kind);
		const specs = this._specs;
		let lo = ranges[0]! >> shift;
		let hi = ((ranges[1]! - 1) >> shift) + 1;
		for (let r = 2; r < length; r += 2) {
			const from = ranges[r]! >> shift;
			const to = ((ranges[r + 1]! - 1) >> shift) + 1;
			if (from <= hi) {
				hi = Math.max(hi, to);
			} else {
				specs.push(series, level, lo, hi - lo, columns);
				lo = from;
				hi = to;
			}
		}
		specs.push(series, level, lo, hi - lo, columns);
	}

	/** Patches of the first bucket of every level after history was prepended in front of `oldFirst`. */
	private _boundaryPatches(oldFirst: number, event: EngineEvent): void {
		const specs = this._specs;
		specs.clear();
		for (let level = 1; level <= this._levels; level++) {
			const shift = levelShift(level);
			// A prepend that is a multiple of the bucket size only adds whole buckets.
			if ((oldFirst & ((1 << shift) - 1)) === 0 || !hasLevel(this._patchLevels, level)) {
				continue;
			}
			const bucket = oldFirst >> shift;
			specs.push(TIME_PATCH, level, bucket, 1, 1);
			for (const state of this._series.values()) {
				specs.push(state.id, level, bucket, 1, levelColumnCount(state.kind));
			}
		}
		this._emit(event);
	}

	/** Packs the patches the collected specs describe into the event, after any patches it has. */
	private _emit(event: EngineEvent): void {
		const length = this._specs.length;
		if (length === 0) {
			return;
		}
		const specs = this._specs.values;
		let total = 0;
		for (let s = 0; s < length; s += SPEC_STRIDE) {
			total += specs[s + SPEC_COUNT]! * specs[s + SPEC_COLUMNS]!;
		}
		// Two buffers for the whole event, and no object or view per patch (see `Patches`).
		const before = event.packedPatches;
		const indexBefore = before === undefined ? 0 : before.index.length;
		let offset = before === undefined ? 0 : before.data.length;
		const index = new Int32Array(indexBefore + (length / SPEC_STRIDE) * PATCH_STRIDE);
		const data = new Float64Array(offset + total);
		if (before !== undefined) {
			index.set(before.index);
			data.set(before.data);
		}
		const main = this._main!;
		let p = indexBefore;
		for (let s = 0; s < length; s += SPEC_STRIDE) {
			const series = specs[s + SPEC_SERIES]!;
			const level = specs[s + SPEC_LEVEL]!;
			const start = specs[s + SPEC_START]!;
			const count = specs[s + SPEC_COUNT]!;
			const columns = specs[s + SPEC_COLUMNS]!;
			if (this._indicators.owns(series)) {
				this._indicators.copy(series, level, start, count, data, offset);
			} else if (level === 0) {
				if (series === TIME_PATCH) {
					main.store.copyColumn(TIME, start, start + count, data, offset);
				} else {
					const state = this._series.get(series)!;
					if (state === main) {
						for (let c = 0; c < columns; c++) {
							main.store.copyColumn(c + 1, start, start + count, data, offset + c * count);
						}
					} else {
						this._aligned(state, start, start + count, data.subarray(offset, offset + count * columns), count);
					}
				}
			} else {
				const pyramid = series === TIME_PATCH ? this._time : this._series.get(series)!.pyramid;
				const store = pyramid.levels[level - 1]!;
				for (let c = 0; c < columns; c++) {
					store.copyColumn(c, start, start + count, data, offset + c * count);
				}
			}
			index[p + PATCH_SERIES] = series;
			index[p + PATCH_LEVEL] = level;
			index[p + PATCH_START] = start;
			index[p + PATCH_COUNT] = count;
			index[p + PATCH_COLUMNS] = columns;
			index[p + PATCH_OFFSET] = offset;
			p += PATCH_STRIDE;
			offset += count * columns;
		}
		this._specs.clear();
		event.packedPatches = { index, data };
	}

	/** Index of the main bar a time belongs to: the last bar at or before it. */
	private _mainIndex(time: number): number {
		const store = this._main!.store;
		if (time >= store.lastTime()) {
			return store.end - 1;
		}
		const index = store.lowerBound(time);
		const at = index === index ? store.timeAt(index) : NaN;
		if (at !== at) {
			// The main series keeps every time while other series have data (see `_evictable`).
			throw new Error('lumen-charts: the time of a main bar that was let go was needed');
		}
		return at === time ? index : index - 1;
	}

	/** Logical positions of times on the main timeline (see `TimelineResolution`). Reads only. */
	private _resolveTimes(times: Float64Array): TimelineResolution {
		const positions = times;
		const main = this._main;
		const store = main?.store;
		if (store === undefined || store.length === 0) {
			positions.fill(NaN);
			return { positions, firstTime: NaN, lastTime: NaN, headInterval: NaN, tailInterval: NaN };
		}
		const first = store.first;
		const end = store.end;
		const firstTime = store.firstTime();
		const lastTime = store.lastTime();
		// The first and last chunk are always held, so their times are there.
		const headInterval = medianGap(store, first, Math.min(end, first + INTERVAL_ROWS + 1));
		const tailInterval = medianGap(store, Math.max(first, end - INTERVAL_ROWS - 1), end);
		for (let i = 0; i < times.length; i++) {
			const time = times[i]!;
			let position: number;
			if (time !== time) {
				position = NaN;
			} else if (time <= firstTime) {
				position = first - (firstTime - time) / headInterval;
			} else if (time >= lastTime) {
				position = end - 1 + (time - lastTime) / tailInterval;
			} else {
				position = this._interpolate(store, time);
			}
			positions[i] = position;
		}
		return { positions, firstTime, lastTime, headInterval, tailInterval };
	}

	/** Position of a time strictly between the first and the last main bar. */
	private _interpolate(store: ChunkedStore, time: number): number {
		const index = store.lowerBound(time);
		if (index === index) {
			const at = store.timeAt(index);
			if (at === time) {
				return index;
			}
			// The bar before may be the last of a chunk let go, whose last time the chunk keeps.
			let before = store.timeAt(index - 1);
			if (before !== before) {
				before = store.chunkLastTime(store.gridOf(index - 1));
			}
			return index - 1 + (time - before) / (at - before);
		}
		// Inside a chunk without its times: between the bucket times the levels keep (every 16th bar),
		// or the chunk's first and last time if the levels are not built.
		const grid = store.chunkOf(time);
		const lo = Math.max(store.first, grid << CHUNK_SHIFT);
		const hi = Math.min(store.end, (grid + 1) << CHUNK_SHIFT) - 1;
		let fromRow = lo;
		let fromTime = store.chunkFirstTime(grid);
		let toRow = hi;
		let toTime = store.chunkLastTime(grid);
		const level = this._levels > 0 ? this._time.levels[0]! : null;
		if (level !== null) {
			let a = (lo >> BUCKET_SHIFT) + 1;
			let b = hi >> BUCKET_SHIFT;
			// Buckets a..b start inside the chunk; find the last one that starts at or before `time`.
			while (a <= b) {
				const mid = (a + b) >> 1;
				const start = level.value(0, mid);
				if (start <= time) {
					fromRow = mid << BUCKET_SHIFT;
					fromTime = start;
					a = mid + 1;
				} else {
					toRow = mid << BUCKET_SHIFT;
					toTime = start;
					b = mid - 1;
				}
			}
		}
		if (fromTime === time) {
			return fromRow;
		}
		return fromRow + ((toRow - fromRow) * (time - fromTime)) / (toTime - fromTime);
	}

	/**
	 * Time of main row `row`, which may be the first row of a chunk let go; inside a chunk without its
	 * times, the time of the bucket's first row from the levels, which is no later.
	 */
	private _rowTime(row: number): number {
		const time = this._main!.store.timeAt(row);
		return time === time ? time : this._time.levels[0]!.value(0, row >> BUCKET_SHIFT);
	}

	/** Time just past the finest bucket holding main row `row`: the next bucket's first time, or Infinity at the end. */
	private _bucketEndTime(row: number): number {
		const end = ((row >> BUCKET_SHIFT) + 1) << BUCKET_SHIFT;
		return end < this._main!.store.end ? this._rowTime(end) : Infinity;
	}

	private *_window(
		level: number,
		start: number,
		count: number,
		capacity: number,
		seq: number,
		event: EngineEvent,
	): Generator<undefined, undefined, undefined> {
		const main = this._main;
		if (main === null || level > this._levels) {
			// A level that does not exist (yet) is answered with an empty window, which ends the request.
			event.window = { level, request: seq, start: 0, count: 0, capacity: 0, time: EMPTY, series: [] };
			return;
		}
		const shift = levelShift(level);
		const first = main.store.first >> shift;
		const end = ((main.store.end - 1) >> shift) + 1;
		const from = Math.min(Math.max(start, first), end);
		const to = Math.max(from, Math.min(start + count, end));
		const rows = to - from;
		const stride = Math.max(capacity, rows);
		const time = new Float64Array(stride);
		const window: WindowSnapshot = {
			level,
			request: seq,
			start: from,
			count: rows,
			capacity: stride,
			time,
			series: [],
		};
		event.window = window;
		if (level > 0) {
			this._time.levels[level - 1]!.copyColumn(0, from, to, time, 0);
			for (const state of this._series.values()) {
				const store = state.pyramid.levels[level - 1]!;
				const data = new Float64Array(stride * store.columnCount);
				for (let c = 0; c < store.columnCount; c++) {
					store.copyColumn(c, from, to, data, c * stride);
				}
				window.series.push({ series: state.id, data });
				yield;
			}
			this._indicators.window(level, from, to, stride, window.series);
			return;
		}
		main.store.copyColumn(TIME, from, to, time, 0);
		for (const state of this._series.values()) {
			const data = new Float64Array(stride * state.valueColumns);
			if (state === main) {
				for (let c = 0; c < state.valueColumns; c++) {
					main.store.copyColumn(c + 1, from, to, data, c * stride);
					yield;
				}
			} else {
				this._aligned(state, from, to, data, stride);
				yield;
			}
			window.series.push({ series: state.id, data });
		}
		this._indicators.window(0, from, to, stride, window.series);
	}

	/**
	 * Copies rows `[from, to)` of a column of a series, aligned to the main timeline, into `out` from
	 * `offset` on: what indicators read. Column 0 is the main timeline's time; values a series does
	 * not have (an unknown series, a column it lacks, rows let go) are NaN.
	 */
	private _readColumn(
		series: number,
		column: number,
		from: number,
		to: number,
		out: Float64Array,
		offset: number,
	): void {
		const main = this._main;
		const state = this._series.get(series);
		if (to <= from) {
			return;
		}
		if (state === undefined && this._marks.has(series)) {
			this._readMarks(series, column, from, to, out, offset);
			return;
		}
		if (main === null || state === undefined || (column > state.valueColumns && column !== TIME)) {
			out.fill(NaN, offset, offset + to - from);
			return;
		}
		if (column !== TIME && state.store.length === 0) {
			out.fill(NaN, offset, offset + to - from);
			return;
		}
		if (column === TIME || state === main) {
			// Chunk by chunk: a chunk let go has no values, and maybe no times either.
			const store = main.store;
			let index = from;
			while (index < to) {
				const n = Math.min(CHUNK_ROWS - (index & CHUNK_MASK), to - index);
				const grid = store.gridOf(index);
				const held = column === TIME ? store.hasTime(grid) : !store.isEvicted(grid);
				if (held) {
					store.copyColumn(column, index, index + n, out, offset + index - from);
				} else {
					out.fill(NaN, offset + index - from, offset + index - from + n);
				}
				index += n;
			}
			return;
		}
		if (state.store.evictedCount > 0) {
			// Recomputations ask for the rows they read first (`_ensureRows`); should any be missing
			// anyway, they read as missing values rather than as the wrong bars.
			this._clearNeeds();
			this._needTimes(state, this._rowTime(from), to < main.store.end ? this._rowTime(to) : Infinity);
			if (this._missing(0)) {
				out.fill(NaN, offset, offset + to - from);
				return;
			}
		}
		const rows = to - from;
		const size = rows * state.valueColumns;
		if (this._readScratch.length < size) {
			this._readScratch = new Float64Array(Math.max(size, this._readScratch.length * 2, 256));
		}
		this._aligned(state, from, to, this._readScratch, rows);
		out.set(this._readScratch.subarray((column - 1) * rows, column * rows), offset);
	}

	/**
	 * See `IndicatorHost.ensure`: whether rows `[from, to)` of the main timeline are in memory, for
	 * every series with data (an indicator may read any of them). Between commands, rows among
	 * `[from, ahead)` that were let go are asked for again, with a notice, and kept until the
	 * recomputation has read them.
	 */
	private _ensureRows(from: number, to: number, ahead: number): boolean {
		const main = this._main;
		if (main === null) {
			return true;
		}
		const store = main.store;
		const lo = Math.max(from, store.first);
		const hi = Math.min(to, store.end);
		this._needReading(lo, hi);
		const held = !this._missing(0) && this._marksHeld(lo, hi);
		if (!this._running) {
			this._readFrom = lo;
			this._readTo = Math.min(Math.max(hi, ahead), store.end);
			this._reconcile(this._background);
		}
		return held;
	}

	/**
	 * Column `column` of a marks series over main rows `[from, to)`: each bar over the marks from its
	 * time to the next bar's, the last bar's on to any time.
	 */
	private _readMarks(
		series: number,
		column: number,
		from: number,
		to: number,
		out: Float64Array,
		offset: number,
	): void {
		const main = this._main;
		if (main === null) {
			out.fill(NaN, offset, offset + to - from);
			return;
		}
		const store = main.store;
		const n = to - from;
		if (this._bounds.length < n + 1) {
			this._bounds = new Float64Array(Math.max(n + 1, this._bounds.length * 2));
		}
		const bounds = this._bounds;
		const end = Math.min(to + 1, store.end);
		this._readColumn(main.id, TIME, from, end, bounds, 0);
		if (to + 1 > store.end) {
			bounds[n] = Infinity;
		}
		this._marks.aggregate(series, column, bounds, n, out, offset);
	}

	/**
	 * Whether the marks the bars of main rows `[from, to)` read are held, for every marks series an
	 * indicator reads; outside a command, those let go are asked for.
	 */
	private _marksHeld(from: number, to: number): boolean {
		const read = new Set<number>();
		this._indicators.readSeries(read);
		const store = this._main!.store;
		let held = true;
		for (const series of read) {
			if (!this._marks.has(series) || to <= from) {
				continue;
			}
			const t0 = this._rowTime(from);
			const t1 = to < store.end ? this._rowTime(to) : Infinity;
			held = this._marks.held(series, t0, t1, this._running ? null : this._background) && held;
		}
		return held;
	}

	/** Collects in `_need*` the chunks of every series that rows `[from, to)` of the main timeline take. */
	private _needReading(from: number, to: number): void {
		this._clearNeeds();
		if (to <= from) {
			return;
		}
		const main = this._main!;
		this._needRows(main, from, to);
		if (this._series.size > 1) {
			const t0 = this._rowTime(from);
			const t1 = to < main.store.end ? this._rowTime(to) : Infinity;
			for (const state of this._series.values()) {
				if (state !== main && state.store.evictedCount > 0) {
					this._needTimes(state, t0, t1);
				}
			}
		}
	}

	// Deletions

	/**
	 * Plans the deletion of the bars of `state` with times in `[from, to]`. Returns false, with the
	 * chunks it needs in `_need*`, while rows it must read or move were let go.
	 *
	 * Bars at either end are cut off without moving anything, so the remaining bars keep their
	 * indexes. Bars in the middle leave a gap that the rows on one side close by moving over: the side
	 * with fewer rows let go, then the shorter one. For the main series that re-bases those indexes,
	 * which starts a new epoch, as a new history does. Leaving the bars in place as empty slots
	 * instead would keep indexes without moving rows, but a deleted bar would still take a slot on the
	 * ordinal time scale, keep its time for secondary series to merge into, and no longer match a
	 * datafeed that has removed it.
	 */
	private _planDelete(op: Held, plan: DeletePlan): boolean {
		const { state, from, to } = op;
		this._clearNeeds();
		plan.mode = 'none';
		const store = state.store;
		if (store.length === 0 || !(from <= to)) {
			return true;
		}
		let d0 = store.lowerBound(from);
		let d1 = store.upperBound(to);
		// An end inside a chunk without its times: its rows tell where exactly. Until they are back,
		// the plan uses a row inside that chunk, which needs the same chunks as the exact plan will.
		const known = d0 === d0 && d1 === d1;
		if (known && d1 <= d0) {
			return true;
		}
		// The earliest row the deletion could start at, and the latest it could end at.
		if (d0 !== d0) {
			d0 = (store.chunkOf(from) << CHUNK_SHIFT) + 1;
		}
		if (d1 !== d1) {
			d1 = Math.max(d0 + 1, ((store.chunkOf(to) + 1) << CHUNK_SHIFT) - 1);
		}
		plan.d0 = d0;
		plan.d1 = d1;
		const first = store.first;
		const end = store.end;
		if (d0 === first && d1 === end) {
			plan.mode = 'all';
			return true;
		}
		if (d0 === first) {
			plan.mode = 'head';
			this._needRows(state, d1, d1 + 1, from, to);
		} else if (d1 === end) {
			plan.mode = 'tail';
			this._needRows(state, d0 - 1, d0, from, to);
		} else {
			plan.mode = 'middle';
			if (op.side !== op.side) {
				const head = evictedRows(store, first, d1);
				const tail = evictedRows(store, d0, end);
				op.side = head < tail || (head === tail && d0 - first <= end - d1) ? 1 : 0;
			}
			plan.moveHead = op.side === 1;
			if (plan.moveHead) {
				this._needRows(state, first, d1, from, to);
			} else {
				this._needRows(state, d0, end, from, to);
			}
		}
		const main = this._main!;
		if (state === main) {
			if (this._series.size > 1) {
				// Bars of other series are merged into main bars again where rows moved or an end moved.
				let t0 = -Infinity;
				let t1 = Infinity;
				if (plan.mode === 'head') {
					t0 = this._rowTime(d1);
					t1 = this._bucketEndTime(d1);
				} else if (plan.mode === 'tail') {
					t0 = this._rowTime(((d0 - 1) >> BUCKET_SHIFT) << BUCKET_SHIFT);
				} else if (plan.moveHead) {
					t1 = this._bucketEndTime(d1);
				} else {
					t0 = this._rowTime(Math.max(first, ((d0 - 1) >> BUCKET_SHIFT) << BUCKET_SHIFT));
				}
				// Held ones too: they must stay while the deletion waits, or what it needs would grow.
				for (const other of this._series.values()) {
					if (other !== main) {
						this._needTimes(other, t0, t1);
					}
				}
			}
		} else {
			// Main bars whose slots held bars removed get their buckets rebuilt from the bars that stay.
			const m0 = Math.max(main.store.first, this._mainIndex(from));
			const m1 = this._mainIndex(to);
			if (m1 >= m0) {
				const lo = Math.max(main.store.first, (m0 >> BUCKET_SHIFT) << BUCKET_SHIFT);
				const hi = ((m1 >> BUCKET_SHIFT) + 1) << BUCKET_SHIFT;
				this._needTimes(state, this._rowTime(lo), from);
				this._needTimes(state, to, hi < main.store.end ? this._rowTime(hi) : Infinity);
			}
		}
		return known && !this._missing(0);
	}

	private *_delete(op: Held, event: EngineEvent): Generator<undefined, void, undefined> {
		const { state, from, to } = op;
		yield* this._drain();
		const plan = this._plan;
		if (!this._planDelete(op, plan)) {
			throw new Error('lumen-charts: a deletion ran before its rows were back');
		}
		if (plan.mode === 'none') {
			return;
		}
		if (plan.mode === 'all') {
			reject(event, state.id, yield* this._set(state, EMPTY, 0, undefined, event));
			event.stale = true;
			return;
		}
		const { d0, d1, moveHead } = plan;
		const store = state.store;
		const first = store.first;
		const end = store.end;
		const n = d1 - d0;
		const main = this._main!;
		if (state !== main) {
			const m0 = Math.max(main.store.first, this._mainIndex(from));
			const m1 = this._mainIndex(to);
			this._cut(state, plan);
			if (m1 >= m0) {
				this._beginChanges();
				state.runs.push(m0, m1 + 1);
				this._endChanges(event);
			}
			return;
		}
		// Rows whose buckets change, in the indexes after the deletion.
		let lo: number;
		let hi: number;
		if (plan.mode === 'head') {
			lo = d1;
			hi = d1 + 1;
		} else if (plan.mode === 'tail') {
			lo = d0 - 1;
			hi = d0;
		} else if (moveHead) {
			lo = first + n;
			hi = d1 + 1;
		} else {
			// The bar before the gap takes the secondary bars of the slots removed, so it changes too.
			lo = d0 - 1;
			hi = end - n;
		}
		this._cut(state, plan);
		this._truncateLevels(store.first, store.end);
		yield* this._refreshSliced(this._time, null, lo, hi);
		for (const other of this._series.values()) {
			yield* this._refreshSliced(other.pyramid, other, lo, hi);
		}
		if (plan.mode === 'middle') {
			this._rebase(event);
		} else {
			// Indexes stay, but the first or the last bars are gone: every indicator is computed again
			// over what is left (one that reads only other series too, since the timeline starts or ends
			// elsewhere), and its values stay on screen until then.
			this._indicators.rowsRemoved();
		}
		event.stale = true;
	}

	/** Removes the rows of a plan from a store, and the requests for rows that are gone. */
	private _cut(state: SeriesState, plan: DeletePlan): void {
		const store = state.store;
		const { d0, d1 } = plan;
		if (plan.mode === 'head') {
			store.truncate(d1, store.end);
		} else if (plan.mode === 'tail') {
			store.truncate(store.first, d0);
		} else {
			store.removeRows(d0, d1, plan.moveHead);
		}
		// Rows that moved were all held, so only requests for rows cut off are out of date.
		for (const [id, request] of this._requests) {
			if (request.state === state && (request.start < store.first || request.end > store.end)) {
				this._requests.delete(id);
				for (let grid = request.start >> CHUNK_SHIFT; grid <= (request.end - 1) >> CHUNK_SHIFT; grid++) {
					state.fetching.delete(grid);
				}
			}
		}
	}

	/** Cuts every level of every pyramid to the buckets of main rows `[first, end)`. */
	private _truncateLevels(first: number, end: number): void {
		truncatePyramid(this._time, first, end);
		for (const state of this._series.values()) {
			truncatePyramid(state.pyramid, first, end);
		}
	}

	// Memory limit

	/** True while the limit applies: a finite limit, levels built, and a series that can be fetched again. */
	private _evicting(): boolean {
		if (this._limit === Infinity || this._takeover || this._main === null || this._levels === 0) {
			return false;
		}
		for (const state of this._series.values()) {
			if (state.fetchable && state.store.length > 0) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Whether the main series has to keep the time of every bar: other series are drawn on its
	 * timeline, and merging their bars into main bars takes the time of each one.
	 */
	private _mainKeepsTime(): boolean {
		for (const state of this._series.values()) {
			if (state !== this._main && (state.store.length > 0 || state.queue.length > 0)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Chunks the limit could let go of now, farthest from the last raw window first.
	 *
	 * Of the main series: every chunk but the first and the last (prepends rebuild the first bucket,
	 * ticks write the last bar), those of the last raw window, those being fetched and those waiting
	 * work needs. A chunk keeps its time column while other series have data.
	 *
	 * Of a secondary series: every chunk but its first and last, and those with bars near the main
	 * series' first and last chunk, near the last raw window, or in the buckets of its own first and
	 * last bar: ticks, prepends and windows there rebuild buckets or merge bars from them.
	 */
	private _candidates(): Candidate[] {
		const main = this._main!;
		const store = main.store;
		let pinFrom = Math.max(store.first, this._pinFrom);
		let pinTo = Math.min(store.end, this._pinTo);
		if (!(pinTo > pinFrom)) {
			pinFrom = store.end - 1;
			pinTo = store.end;
		}
		const pinFirst = store.gridOf(pinFrom);
		const pinLast = store.gridOf(pinTo - 1);
		const distance = (grid: number): number => (grid < pinFirst ? pinFirst - grid : grid - pinLast);
		const out: Candidate[] = [];
		const keepTime = this._mainKeepsTime();
		// Rows an indicator recomputation has yet to read stay: let go, they would only be fetched again.
		const reading = this._indicators.readFrom;
		const readRow = Math.min(Math.max(reading, store.first), store.end - 1);
		const readGrid = reading === Infinity ? Infinity : store.gridOf(readRow);
		const readTime = reading === Infinity ? Infinity : this._rowTime(readRow);
		if (main.fetchable) {
			const wanted = this._wanted.get(main);
			const last = Math.min(store.lastGrid, readGrid);
			for (let grid = store.firstGrid + 1; grid < last; grid++) {
				if ((grid >= pinFirst && grid <= pinLast) || main.fetching.has(grid) || wanted?.has(grid) === true) {
					continue;
				}
				if (!store.isEvicted(grid)) {
					const bytes = keepTime ? store.chunkBytes - store.timeBytes : store.chunkBytes - SUMMARY_BYTES;
					out.push({ state: main, grid, keepTime, anchors: false, distance: distance(grid), bytes });
				} else if (!keepTime && store.hasTime(grid)) {
					const bytes = store.timeBytes - SUMMARY_BYTES;
					out.push({ state: main, grid, keepTime, anchors: false, distance: distance(grid), bytes });
				}
			}
		}
		let kept: number[] | null = null;
		for (const state of this._series.values()) {
			const own = state.store;
			if (state === main || !state.fetchable || own.length === 0 || own.lastGrid - own.firstGrid < 2) {
				continue;
			}
			kept ??= this._keptTimes(pinFrom, pinTo);
			const ranges = kept.slice();
			// The buckets of its own first and last bar.
			if (own.firstTime() >= store.firstTime()) {
				const at = this._mainIndex(own.firstTime());
				ranges.push(this._rowTime(bucketStart(at, store.first)), this._bucketEndTime(at));
			}
			ranges.push(this._rowTime(bucketStart(this._mainIndex(own.lastTime()), store.first)), Infinity);
			const wanted = this._wanted.get(state);
			const level = this._time.levels[0]!;
			for (let grid = own.firstGrid + 1; grid < own.lastGrid; grid++) {
				if (own.isEvicted(grid) || state.fetching.has(grid) || wanted?.has(grid) === true) {
					continue;
				}
				const firstTime = own.chunkFirstTime(grid);
				const lastTime = own.chunkLastTime(grid);
				if (lastTime >= readTime) {
					continue;
				}
				let near = false;
				for (let r = 0; r < ranges.length && !near; r += 2) {
					near = lastTime >= ranges[r]! && firstTime < ranges[r + 1]!;
				}
				if (near) {
					continue;
				}
				const bucket = Math.max(level.first, level.upperBound(firstTime) - 1);
				out.push({
					state,
					grid,
					keepTime: false,
					anchors: true,
					distance: distance(store.gridOf(Math.max(store.first, bucket << BUCKET_SHIFT))),
					bytes: own.chunkBytes - SUMMARY_BYTES - ((own.rows >> ANCHOR_SHIFT) << 3),
				});
			}
		}
		out.sort((a, b) => b.distance - a.distance);
		return out;
	}

	/**
	 * Time ranges `[from, to)` (in pairs) whose bars of secondary series stay: those merged into the
	 * main series' last chunk and the bucket before it, into its first chunk or before it, and into
	 * the last raw window.
	 */
	private _keptTimes(pinFrom: number, pinTo: number): number[] {
		const store = this._main!.store;
		const tail = Math.max(
			store.first,
			Math.min(store.lastGrid << CHUNK_SHIFT, bucketStart(store.end - 2, store.first)),
		);
		const head = store.firstGrid < store.lastGrid ? store.chunkFirstTime(store.firstGrid + 1) : Infinity;
		return [
			this._rowTime(tail),
			Infinity,
			-Infinity,
			head,
			this._rowTime(bucketStart(pinFrom, store.first)),
			this._bucketEndTime(pinTo - 1),
		];
	}

	/**
	 * Lets go of chunks far from the view until the engine holds no more than the limit, or nothing
	 * more can go. Levels of detail always stay, so zoomed-out views keep drawing, and every chunk let
	 * go keeps a summary to check the rows that come back.
	 *
	 * At most `EVICT_SLICE` chunks per call: a summary takes a pass over the chunk, and letting go of
	 * a whole history at once (10M points right after their levels are built) would take over 100 ms.
	 * The rest goes in background steps (`_overLimit`), between commands.
	 */
	private _enforceLimit(): void {
		if (this._running || this._pending.size > 0) {
			return;
		}
		this._overLimit = false;
		let bytes = this.byteLength;
		if (bytes <= this._limit) {
			return;
		}
		if (this._evicting()) {
			const candidates = this._candidates();
			const n = Math.min(candidates.length, EVICT_SLICE);
			for (let i = 0; i < n; i++) {
				const candidate = candidates[i]!;
				bytes -= candidate.state.store.evict(candidate.grid, candidate.keepTime, candidate.anchors);
				if (bytes <= this._limit) {
					return;
				}
			}
			if (candidates.length > n) {
				this._overLimit = true;
				return;
			}
		}
		// The bars go first; then the marks of series with a datafeed, far from their views.
		if (this._limit !== Infinity) {
			// Marks a recomputation has yet to read stay: let go, they would only be fetched again.
			const reading = this._indicators.readFrom;
			const main = this._main;
			const readTime =
				reading === Infinity || main === null || main.store.length === 0
					? Infinity
					: this._rowTime(Math.min(Math.max(reading, main.store.first), main.store.end - 1));
			const read = new Set<number>();
			this._indicators.readSeries(read);
			const { more } = this._marks.evict(bytes - this._limit, EVICT_SLICE, read, readTime);
			this._overLimit = more;
		}
	}

	/**
	 * Runs whatever waited and can run now, answers a raw window whose rows are all back, asks for
	 * the rows that waiting work still needs, and cancels requests nothing needs any more.
	 */
	private *_progress(event: EngineEvent): Generator<undefined, void, undefined> {
		for (let changed = true; changed;) {
			changed = false;
			if (this._takeover && !this._takeoverWaits()) {
				this._takeover = false;
				this._electMain();
				this._rebuildAll();
				this._rebase(event);
				event.stale = true;
				changed = true;
			}
			if (this._takeover) {
				break;
			}
			if (yield* this._runCorrections(event)) {
				changed = true;
			}
			if (yield* this._runQueues(event)) {
				changed = true;
			}
			if (yield* this._runRebuilds(event)) {
				changed = true;
			}
		}
		const deferred = this._deferred;
		if (deferred !== null && this._main !== null && !this._takeover && this._windowReady(deferred)) {
			this._deferred = null;
			yield* this._window(0, deferred.start, deferred.count, deferred.capacity, deferred.seq, event);
		}
		this._reconcile(event);
	}

	/** True while a series with data misses rows the new timeline's levels need. */
	private _takeoverWaits(): boolean {
		for (const state of this._series.values()) {
			if (state.store.length > 0 && state.store.evictedCount > 0) {
				return true;
			}
		}
		return false;
	}

	private *_runCorrections(event: EngineEvent): Generator<undefined, boolean, undefined> {
		let changed = false;
		const list = this._corrections;
		for (let i = 0; i < list.length;) {
			const op = list[i]!;
			const verdict = this._correction(op.state, op.data[0]!);
			if (verdict === WAIT) {
				i++;
				continue;
			}
			list.splice(i, 1);
			changed = true;
			if (verdict === REFUSE) {
				reject(event, op.state.id, 1);
				(event.refused ??= []).push(op.seq, op.row);
				continue;
			}
			yield* this._drain();
			this._beginChanges();
			this._tick(op.state, op.data, 0, op.seq, op.row, event, op);
			this._endChanges(event, true);
		}
		return changed;
	}

	private *_runQueues(event: EngineEvent): Generator<undefined, boolean, undefined> {
		let changed = false;
		for (const state of this._series.values()) {
			const queue = state.queue;
			while (queue.length > 0 && !this._takeover) {
				const op = queue[0]!;
				if (!this._ready(op)) {
					break;
				}
				queue.shift();
				changed = true;
				yield* this._apply(op, event, true);
			}
		}
		return changed;
	}

	private *_runRebuilds(event: EngineEvent): Generator<undefined, boolean, undefined> {
		let changed = false;
		const list = this._rebuilds;
		for (let i = 0; i < list.length;) {
			const rebuild = list[i]!;
			const rows = this._rebuildRows(rebuild);
			if (rows !== null && this._missing(0)) {
				i++;
				continue;
			}
			list.splice(i, 1);
			changed = true;
			if (rows !== null) {
				yield* this._drain();
				this._beginChanges();
				rebuild.state.runs.push(rows[0]!, rows[1]!);
				this._endChanges(event);
			}
		}
		return changed;
	}

	/** Main rows whose buckets a rebuild redoes, with the bars they take in `_need*`; null if none. */
	private _rebuildRows(rebuild: Rebuild): number[] | null {
		this._clearNeeds();
		const main = this._main;
		if (main === null || rebuild.state === main) {
			return null;
		}
		const m0 = Math.max(main.store.first, this._mainIndex(rebuild.from));
		const m1 = this._mainIndex(rebuild.to);
		if (m1 < m0) {
			return null;
		}
		const lo = bucketStart(m0, main.store.first);
		const hi = ((m1 >> BUCKET_SHIFT) + 1) << BUCKET_SHIFT;
		this._needTimes(rebuild.state, this._rowTime(lo), hi < main.store.end ? this._rowTime(hi) : Infinity);
		return [m0, m1 + 1];
	}

	/** True when every row a raw window shows is in memory; otherwise the chunks it needs are in `_need*`. */
	private _windowReady(window: DeferredWindow): boolean {
		const main = this._main!;
		const store = main.store;
		const from = Math.min(Math.max(window.start, store.first), store.end);
		const to = Math.max(from, Math.min(window.start + window.count, store.end));
		this._clearNeeds();
		if (to > from) {
			this._needRows(main, from, to);
			if (this._series.size > 1) {
				const t0 = this._rowTime(from);
				const t1 = to < store.end ? this._rowTime(to) : Infinity;
				for (const state of this._series.values()) {
					if (state !== main && state.store.evictedCount > 0) {
						this._needTimes(state, t0, t1);
					}
				}
			}
		}
		return !this._missing(0);
	}

	/**
	 * Works out what everything still waiting needs, keeps it in memory (`_wanted`), asks for what is
	 * missing and not on its way yet, and cancels requests nothing needs any more.
	 */
	private _reconcile(event: EngineEvent): void {
		const wanted = this._wanted;
		wanted.clear();
		/**
		 * Chunks with bars a waiting deletion removes, by series, with that deletion. Nothing else asks
		 * for them meanwhile: the source has usually removed those bars, so only an answer without them
		 * would do, and the deletion takes it.
		 */
		const cuts = new Map<SeriesState, { ranges: number[]; grids: number[]; ready: boolean }>();
		const want = (ranges: number[] | null): void => {
			const states = this._needStates;
			const grids = this._needGrids;
			const cut = this._needCut;
			// A deletion asks for the chunks it removes bars from last, once all else it needs is held:
			// they come back in one piece, and the deletion takes effect as soon as they do. A chunk one
			// deletion removes bars from is one of those for all of them.
			let rest = false;
			for (let i = 0; i < states.length && !rest; i++) {
				if (cut[i]! || !states[i]!.store.isEvicted(grids[i]!)) {
					continue;
				}
				let cutElsewhere = false;
				for (let k = 0; k < states.length && !cutElsewhere; k++) {
					cutElsewhere = cut[k]! && states[k] === states[i] && grids[k] === grids[i];
				}
				rest = !cutElsewhere;
			}
			for (let i = 0; i < states.length; i++) {
				const state = states[i]!;
				if (cut[i]! && ranges !== null) {
					let entry = cuts.get(state);
					if (entry === undefined) {
						entry = { ranges, grids: [], ready: !rest };
						cuts.set(state, entry);
					}
					entry.grids.push(grids[i]!);
					if (rest && state.store.isEvicted(grids[i]!)) {
						// Asked for once the rest is held. Kept while held: let go, it would hide where the
						// deletion is.
						continue;
					}
				}
				let set = wanted.get(state);
				if (set === undefined) {
					set = new Set();
					wanted.set(state, set);
				}
				set.add(grids[i]!);
			}
		};
		if (this._takeover) {
			this._clearNeeds();
			for (const state of this._series.values()) {
				if (state.store.length > 0 && state.store.evictedCount > 0) {
					this._needRows(state, state.store.first, state.store.end);
				}
			}
			want(null);
		} else {
			if (this._deferred !== null && this._main !== null) {
				this._windowReady(this._deferred);
				want(null);
			}
			for (const op of this._corrections) {
				this._correction(op.state, op.data[0]!);
				want(null);
			}
			for (const state of this._series.values()) {
				this._wantQueue(state, want);
			}
			for (const rebuild of this._rebuilds) {
				this._rebuildRows(rebuild);
				want(null);
			}
			if (this._readTo > this._readFrom && this._main !== null) {
				if (this._indicators.readFrom === Infinity) {
					// The recomputation is done, or was given up.
					this._readFrom = NaN;
					this._readTo = NaN;
				} else {
					this._needReading(this._readFrom, this._readTo);
					want(null);
				}
			}
		}
		for (const [id, request] of this._requests) {
			const set = wanted.get(request.state);
			let needed = false;
			for (let grid = request.start >> CHUNK_SHIFT; grid <= (request.end - 1) >> CHUNK_SHIFT && !needed; grid++) {
				needed = set?.has(grid) === true;
			}
			if (!needed) {
				this._requests.delete(id);
				for (let grid = request.start >> CHUNK_SHIFT; grid <= (request.end - 1) >> CHUNK_SHIFT; grid++) {
					request.state.fetching.delete(grid);
				}
				(event.cancel ??= []).push(id);
			}
		}
		for (const [state, set] of wanted) {
			const cut = cuts.get(state);
			const grids: number[] = [];
			for (const grid of set) {
				if (state.store.isEvicted(grid) && !state.fetching.has(grid) && cut?.grids.includes(grid) !== true) {
					grids.push(grid);
				}
			}
			if (grids.length > 0) {
				grids.sort((a, b) => a - b);
				this._request(state, grids, event);
			}
			if (cut?.ready === true) {
				this._requestCut(state, cut.ranges, cut.grids, event);
			}
		}
	}

	/**
	 * Collects what the queue of a series waits for. When a deletion leads it, every operation up to
	 * the last deletion waiting there is taken together: the chunks they remove bars from come back in
	 * one answer, which may lack the bars of all of them, and all of them then run at once.
	 */
	private _wantQueue(state: SeriesState, want: (ranges: number[] | null) => void): void {
		const queue = state.queue;
		if (queue.length === 0) {
			return;
		}
		if (queue[0]!.type !== 'delete') {
			this._ready(queue[0]!);
			want(null);
			return;
		}
		let last = 0;
		for (let i = 1; i < queue.length; i++) {
			if (queue[i]!.type === 'delete') {
				last = i;
			}
		}
		const states: SeriesState[] = [];
		const grids: number[] = [];
		const cut: boolean[] = [];
		const ranges: number[] = [];
		for (let i = 0; i <= last; i++) {
			const op = queue[i]!;
			this._ready(op);
			for (let k = 0; k < this._needStates.length; k++) {
				states.push(this._needStates[k]!);
				grids.push(this._needGrids[k]!);
				cut.push(op.type === 'delete' && this._needCut[k]!);
			}
			if (op.type === 'delete') {
				ranges.push(op.from, op.to);
			}
		}
		this._clearNeeds();
		for (let k = 0; k < states.length; k++) {
			this._need(states[k]!, grids[k]!, cut[k]!);
		}
		want(ranges);
	}

	/**
	 * Asks in one request for the chunks a deletion removes bars from, from the first to the last of
	 * them, once none is on its way any more and one at least was let go.
	 */
	private _requestCut(state: SeriesState, ranges: number[], grids: readonly number[], event: EngineEvent): void {
		let firstGrid = Infinity;
		let lastGrid = -Infinity;
		let missing = false;
		for (const grid of grids) {
			if (state.fetching.has(grid)) {
				return;
			}
			missing ||= state.store.isEvicted(grid);
			firstGrid = Math.min(firstGrid, grid);
			lastGrid = Math.max(lastGrid, grid);
		}
		if (!missing) {
			return;
		}
		const store = state.store;
		for (let grid = firstGrid; grid <= lastGrid; grid++) {
			if (state.fetching.has(grid)) {
				return;
			}
		}
		for (let grid = firstGrid; grid <= lastGrid; grid++) {
			state.fetching.add(grid);
		}
		const start = Math.max(firstGrid << CHUNK_SHIFT, store.first);
		const end = Math.min((lastGrid + 1) << CHUNK_SHIFT, store.end);
		const id = this._nextRequest++;
		this._requests.set(id, { id, state, start, end, cuts: ranges.slice() });
		const request: FetchRequest = {
			id,
			series: state.id,
			start,
			end,
			from: store.chunkFirstTime(firstGrid),
			to: store.chunkLastTime(lastGrid),
			removing: ranges.slice(),
		};
		(event.fetch ??= []).push(request);
	}

	/** Asks for chunks of a series (grid numbers in increasing order), consecutive ones in one request. */
	private _request(state: SeriesState, grids: readonly number[], event: EngineEvent): void {
		const store = state.store;
		for (let i = 0; i < grids.length;) {
			let j = i;
			while (j + 1 < grids.length && grids[j + 1] === grids[j]! + 1 && j + 1 - i < FETCH_CHUNKS) {
				j++;
			}
			const firstGrid = grids[i]!;
			const lastGrid = grids[j]!;
			for (let grid = firstGrid; grid <= lastGrid; grid++) {
				state.fetching.add(grid);
			}
			const start = Math.max(firstGrid << CHUNK_SHIFT, store.first);
			const end = Math.min((lastGrid + 1) << CHUNK_SHIFT, store.end);
			const id = this._nextRequest++;
			this._requests.set(id, { id, state, start, end, cuts: null });
			const request: FetchRequest = {
				id,
				series: state.id,
				start,
				end,
				from: store.chunkFirstTime(firstGrid),
				to: store.chunkLastTime(lastGrid),
			};
			(event.fetch ??= []).push(request);
			i = j + 1;
		}
	}

	/**
	 * Takes rows fetched again. They must be exactly the rows let go: as many, with the same times.
	 * Anything else is refused, so indexes can never shift. Values may differ: bars corrected at the
	 * source while they were let go come back corrected, and their buckets are rebuilt.
	 */
	private *_restore(
		id: number,
		count: number,
		data: Float64Array | null,
		event: EngineEvent,
	): Generator<undefined, void, undefined> {
		const request = this._requests.get(id);
		const result: RestoreResult = {
			request: id,
			series: request === undefined ? 0 : request.state.id,
			start: request === undefined ? 0 : request.start,
			expected: request === undefined ? 0 : request.end - request.start,
			received: data === null ? 0 : count,
			outcome: 'failed',
		};
		event.restored = result;
		if (request === undefined) {
			// Cancelled, or its rows were replaced: nothing waits for it any more.
			return;
		}
		this._requests.delete(id);
		const { state, start, end } = request;
		const store = state.store;
		const firstGrid = store.gridOf(start);
		const lastGrid = store.gridOf(end - 1);
		for (let grid = firstGrid; grid <= lastGrid; grid++) {
			state.fetching.delete(grid);
		}
		if (data !== null && request.cuts !== null) {
			yield* this._drain();
			result.outcome = this._restoreCut(request, data, count, event) ? 'restored' : 'mismatch';
		} else if (data !== null) {
			if (this._matches(state, data, count, start, end)) {
				yield* this._drain();
				for (let grid = firstGrid; grid <= lastGrid; grid++) {
					if (!store.isEvicted(grid)) {
						continue;
					}
					const offset = Math.max(grid << CHUNK_SHIFT, store.first) - start;
					if (store.restore(grid, data, count, offset)) {
						this._changedAtSource(state, grid, event);
					}
				}
				result.outcome = 'restored';
			} else if (this._cutPending(state, store.chunkFirstTime(firstGrid), store.chunkLastTime(lastGrid))) {
				// A deletion waits there: the source has removed those bars, which is why they do not
				// match. Not a fault of the datafeed; the deletion asks for them again without them.
				result.expected = 0;
			} else {
				result.outcome = 'mismatch';
			}
		}
		if (result.outcome === 'restored') {
			this._indicators.rowsRestored();
		} else if (this._main !== null) {
			// A recomputation waiting for these rows is given up; the values on screen stay.
			const main = this._main.store;
			const from =
				state === this._main ? start : Math.max(main.first, this._mainIndex(store.chunkFirstTime(firstGrid)));
			const to = state === this._main ? end : this._mainIndex(store.chunkLastTime(lastGrid)) + 1;
			this._indicators.rowsFailed(from, to);
		}
		const deferred = this._deferred;
		if (result.outcome !== 'restored' && deferred !== null && this._main !== null) {
			this._windowReady(deferred);
			let needed = false;
			for (let i = 0; i < this._needStates.length && !needed; i++) {
				needed = this._needStates[i] === state && this._needGrids[i]! >= firstGrid && this._needGrids[i]! <= lastGrid;
			}
			if (needed) {
				// The window cannot be completed now: answer it empty, so the view can fall back to a
				// coarse level and ask again later.
				this._deferred = null;
				event.window = {
					level: 0,
					request: deferred.seq,
					start: Math.min(Math.max(deferred.start, this._main.store.first), this._main.store.end),
					count: 0,
					capacity: 0,
					time: EMPTY,
					series: [],
					incomplete: true,
				};
			}
		}
		yield* this._progress(event);
	}

	/**
	 * True when `data` holds exactly the bars of rows `[start, end)` of a series: as many, with the
	 * times kept or summarized, and for the main series also the time of every bucket's first bar,
	 * which the levels keep.
	 */
	private _matches(state: SeriesState, data: Float64Array, count: number, start: number, end: number): boolean {
		if (count !== end - start) {
			return false;
		}
		const store = state.store;
		const main = state === this._main;
		const level = main && this._levels > 0 ? this._time.levels[0]! : null;
		for (let grid = store.gridOf(start); grid <= store.gridOf(end - 1); grid++) {
			const from = Math.max(grid << CHUNK_SHIFT, store.first);
			const to = Math.min((grid + 1) << CHUNK_SHIFT, store.end);
			const offset = from - start;
			if (!store.matches(grid, data, count, offset, to - from)) {
				return false;
			}
			if (level !== null && !store.hasTime(grid)) {
				const size = 1 << BUCKET_SHIFT;
				for (let row = ((from + size - 1) >> BUCKET_SHIFT) << BUCKET_SHIFT; row < to; row += size) {
					if (data[row - start] !== level.value(0, row >> BUCKET_SHIFT)) {
						return false;
					}
				}
			}
		}
		return true;
	}

	/**
	 * Takes the rows of a request for chunks deletions remove bars from. They may come with or
	 * without the bars of any deletion waiting on the series: the source has usually removed them
	 * already. The other bars must be the ones let go, checked by every time kept (the chunk's times,
	 * or its first and last time and the time of every 16th bar, which the levels keep for the main
	 * series and the summary for a secondary one). Those times also tell how many bars each gap held,
	 * and the bars removed come back as placeholders without values, which the deletions, run next
	 * all together, remove. When two gaps have no kept time between them the split between them is
	 * unknown, and the rows are refused.
	 */
	private _restoreCut(request: Request, data: Float64Array, count: number, event: EngineEvent): boolean {
		const { state, start, end } = request;
		const cuts = request.cuts!;
		const store = state.store;
		const n = end - start;
		const removed = (time: number): boolean => {
			for (let i = 0; i < cuts.length; i += 2) {
				if (time >= cuts[i]! && time <= cuts[i + 1]!) {
					return true;
				}
			}
			return false;
		};
		const keep: number[] = [];
		let previous = -Infinity;
		for (let i = 0; i < count; i++) {
			const time = data[i]!;
			if (!(time > previous)) {
				return false;
			}
			previous = time;
			if (!removed(time)) {
				keep.push(i);
			}
		}
		const kept = keep.length;
		const total = n - kept;
		if (total < 0) {
			return false;
		}
		const times = new Float64Array(kept);
		for (let k = 0; k < kept; k++) {
			times[k] = data[keep[k]!]!;
		}
		// Bars removed before each kept bar, where a time kept says so.
		const before = new Float64Array(kept + 1).fill(NaN);
		before[kept] = total;
		const known = (row: number, time: number): boolean => {
			if (removed(time)) {
				return true;
			}
			const k = indexOf(times, time);
			const value = row - start - k;
			if (k < 0 || value < 0 || value > total || (before[k] === before[k] && before[k] !== value)) {
				return false;
			}
			before[k] = value;
			return true;
		};
		const level = state === this._main && this._levels > 0 ? this._time.levels[0]! : null;
		for (let grid = store.gridOf(start); grid <= store.gridOf(end - 1); grid++) {
			const from = Math.max(grid << CHUNK_SHIFT, store.first);
			const to = Math.min((grid + 1) << CHUNK_SHIFT, store.end);
			if (store.hasTime(grid)) {
				for (let row = from; row < to; row++) {
					if (!known(row, store.value(TIME, row))) {
						return false;
					}
				}
				continue;
			}
			if (!known(from, store.chunkFirstTime(grid)) || !known(to - 1, store.chunkLastTime(grid))) {
				return false;
			}
			const anchors = store.anchors(grid);
			const size = 1 << ANCHOR_SHIFT;
			for (let row = store.firstAnchor(grid), k = 0; row < to; row += size, k++) {
				const time = anchors !== null ? anchors[k]! : level !== null ? level.value(0, row >> BUCKET_SHIFT) : NaN;
				if (time === time && !known(row, time)) {
					return false;
				}
			}
		}
		// The gaps: where the bars of each deletion would be among the kept bars.
		const spanFirst = store.chunkFirstTime(store.gridOf(start));
		const spanLast = store.chunkLastTime(store.gridOf(end - 1));
		const gapAt: number[] = [];
		const gapFrom: number[] = [];
		let shared = false;
		for (let i = 0; i < cuts.length; i += 2) {
			if (cuts[i]! <= spanLast && cuts[i + 1]! >= spanFirst) {
				const at = lowerBoundOf(times, cuts[i]!);
				if (gapAt.includes(at)) {
					shared = true;
				} else {
					gapAt.push(at);
					gapFrom.push(cuts[i]!);
				}
			}
		}
		const gapCount = new Float64Array(gapAt.length);
		let lastAt = -1;
		let lastValue = 0;
		for (let k = 0; k <= kept; k++) {
			const value = before[k]!;
			if (value !== value) {
				continue;
			}
			const between: number[] = [];
			for (let g = 0; g < gapAt.length; g++) {
				if (gapAt[g]! > lastAt && gapAt[g]! <= k) {
					between.push(g);
				}
			}
			const delta = value - lastValue;
			if (delta < 0 || (delta > 0 && between.length !== 1)) {
				return false;
			}
			if (delta > 0) {
				gapCount[between[0]!] = delta;
			}
			lastAt = k;
			lastValue = value;
		}
		// The rows as they were: the kept ones around placeholders whose time is inside their deletion
		// and not before the row in front of them, so the deletion finds them.
		const columns = store.columnCount;
		const block = new Float64Array(n * columns).fill(NaN);
		let row = 0;
		for (let k = 0; k <= kept; k++) {
			const g = gapAt.indexOf(k);
			if (g >= 0 && gapCount[g]! > 0) {
				let placeholder = gapFrom[g]!;
				if (k > 0) {
					placeholder = Math.max(placeholder, times[k - 1]!);
				} else if (start > store.first) {
					const time = store.timeAt(start - 1);
					placeholder = Math.max(placeholder, time === time ? time : placeholder);
				}
				block.fill(placeholder, row, row + gapCount[g]!);
				row += gapCount[g]!;
			}
			if (k < kept) {
				const source = keep[k]!;
				for (let c = 0; c < columns; c++) {
					block[c * n + row] = data[c * count + source]!;
				}
				row++;
			}
		}
		if (row !== n) {
			return false;
		}
		for (let grid = store.gridOf(start); grid <= store.gridOf(end - 1); grid++) {
			if (store.isEvicted(grid)) {
				store.restore(grid, block, n, Math.max(grid << CHUNK_SHIFT, store.first) - start);
			}
		}
		if (shared) {
			// Bars of several deletions, with no kept bar between them, came back as one gap: how many
			// each removed is unknown, so which indexes the bars keep is too. The deletions still
			// remove the right bars; the series is re-based after the last of them.
			for (const op of state.queue) {
				if (op.type === 'delete') {
					this._rebaseAfter.set(state, op);
				}
			}
		}
		// Values may have changed at the source too; the deletions rebuild what they change.
		if (state === this._main) {
			this._refresh(state.pyramid, state, start, end);
		} else if (this._main !== null) {
			const from = store.chunkFirstTime(store.gridOf(start));
			this._rebuilds.push({ state, from, to: store.chunkLastTime(store.gridOf(end - 1)) });
		}
		event.stale = true;
		return true;
	}

	/** True when a deletion of bars with times in `[from, to]` of a series waits. */
	private _cutPending(state: SeriesState, from: number, to: number): boolean {
		for (const op of state.queue) {
			if (op.type === 'delete' && op.from <= to && op.to >= from) {
				return true;
			}
		}
		return false;
	}

	/** Rebuilds the buckets of a chunk that came back with other values than the ones let go. */
	private _changedAtSource(state: SeriesState, grid: number, event: EngineEvent): void {
		const main = this._main;
		if (main === null) {
			return;
		}
		const store = state.store;
		if (state === main) {
			this._beginChanges();
			main.runs.push(Math.max(grid << CHUNK_SHIFT, store.first), Math.min((grid + 1) << CHUNK_SHIFT, store.end));
			this._endChanges(event);
			return;
		}
		this._rebuilds.push({ state, from: store.chunkFirstTime(grid), to: store.chunkLastTime(grid) });
	}

	// Chunks an operation needs

	private _clearNeeds(): void {
		this._needStates.length = 0;
		this._needGrids.length = 0;
		this._needCut.length = 0;
	}

	private _need(state: SeriesState, grid: number, cut = false): void {
		this._needStates.push(state);
		this._needGrids.push(grid);
		this._needCut.push(cut);
	}

	/**
	 * Needs the chunks of rows `[from, to)` of a series; those with bars in `[cutFrom, cutTo]`, which
	 * a deletion removes, are marked as such.
	 */
	private _needRows(state: SeriesState, from: number, to: number, cutFrom = NaN, cutTo = NaN): void {
		const store = state.store;
		for (let grid = store.gridOf(from), last = store.gridOf(to - 1); grid <= last; grid++) {
			this._need(state, grid, store.chunkFirstTime(grid) <= cutTo && store.chunkLastTime(grid) >= cutFrom);
		}
	}

	/** Needs the chunks of a series with bars in `[from, to)`, found by the first and last time of each chunk. */
	private _needTimes(state: SeriesState, from: number, to: number): void {
		const store = state.store;
		if (store.length === 0 || !(to > from)) {
			return;
		}
		for (let grid = store.chunkAtOrAfter(from); grid <= store.lastGrid && store.chunkFirstTime(grid) < to; grid++) {
			this._need(state, grid);
		}
	}

	/** Needs the bars of a secondary series merged into the finest bucket holding main row `row`. */
	private _needBucket(state: SeriesState, row: number): void {
		const main = this._main!.store;
		const lo = bucketStart(row, main.first);
		const hi = ((row >> BUCKET_SHIFT) + 1) << BUCKET_SHIFT;
		this._needTimes(state, this._rowTime(lo), hi < main.end ? this._rowTime(hi) : Infinity);
	}

	/** Needs every chunk of the main series whose time column was let go. */
	private _needTimeless(main: SeriesState): void {
		const store = main.store;
		for (let grid = store.firstGrid; grid <= store.lastGrid; grid++) {
			if (!store.hasTime(grid)) {
				this._need(main, grid);
			}
		}
	}

	/** True when a chunk needed from position `from` on is not held. */
	private _missing(from: number): boolean {
		const states = this._needStates;
		const grids = this._needGrids;
		for (let i = from; i < states.length; i++) {
			if (states[i]!.store.isEvicted(grids[i]!)) {
				return true;
			}
		}
		return false;
	}

	// Level of detail

	/** Finishes the background build of levels (not indicator work), yielding between slices. */
	private *_drain(): Generator<undefined, void, undefined> {
		while (this._buildStep()) {
			yield;
		}
	}

	/** Runs one slice of the background build of levels. Returns true while more remains. */
	private _buildStep(): boolean {
		if (this._pending.size === 0) {
			return false;
		}
		this._build ??= this._buildAll();
		if (this._build.next().done === true) {
			this._build = null;
		}
		return this._pending.size > 0;
	}

	private *_buildAll(): Generator<undefined, void, undefined> {
		// A Set visits entries added while it is iterated, so pyramids queued meanwhile are built too.
		for (const pyramid of this._pending) {
			yield* this._buildPyramid(pyramid);
			this._pending.delete(pyramid);
		}
	}

	/** Builds every level of a pyramid from scratch, over the whole main timeline. */
	private *_buildPyramid(pyramid: Pyramid): Generator<undefined, void, undefined> {
		const main = this._main;
		if (main === null) {
			pyramid.reset(0, 0);
			return;
		}
		const first = main.store.first;
		const end = main.store.end;
		this._levels = levelCount(end - first);
		pyramid.reset(this._levels, first);
		const owner = this._owner(pyramid);
		for (let lo = first; lo < end; lo += BUILD_SLICE) {
			this._refresh(pyramid, owner, lo, Math.min(end, lo + BUILD_SLICE));
			yield;
		}
	}

	/** Series a pyramid belongs to; null for the time pyramid. */
	private _owner(pyramid: Pyramid): SeriesState | null {
		if (pyramid === this._time) {
			return null;
		}
		for (const state of this._series.values()) {
			if (state.pyramid === pyramid) {
				return state;
			}
		}
		return null;
	}

	/** Recomputes the buckets of every pyramid that hold rows prepended in front of `oldFirst`. */
	private *_extendLeft(oldFirst: number): Generator<undefined, void, undefined> {
		const first = this._main!.store.first;
		for (let hi = oldFirst; hi > first; hi -= BUILD_SLICE) {
			const lo = Math.max(first, hi - BUILD_SLICE);
			this._refresh(this._time, null, lo, hi);
			for (const state of this._series.values()) {
				this._refresh(state.pyramid, state, lo, hi);
			}
			yield;
		}
		this._growLevels();
	}

	private *_refreshSliced(
		pyramid: Pyramid,
		owner: SeriesState | null,
		lo: number,
		hi: number,
	): Generator<undefined, void, undefined> {
		for (let from = lo; from < hi; from += BUILD_SLICE) {
			this._refresh(pyramid, owner, from, Math.min(hi, from + BUILD_SLICE));
			yield;
		}
	}

	private _refreshRuns(pyramid: Pyramid, owner: SeriesState | null, runs: readonly number[]): void {
		for (let r = 0; r < runs.length; r += 2) {
			this._refresh(pyramid, owner, runs[r]!, runs[r + 1]!);
		}
	}

	/**
	 * Recomputes, at every level from the finest up, the buckets that hold main rows `[lo, hi)`.
	 * Each bucket is rebuilt from all of its members (rows at the finest level, four buckets above
	 * it), never by merging in a changed value: a correction can lower a high.
	 */
	private _refresh(pyramid: Pyramid, owner: SeriesState | null, lo: number, hi: number): void {
		const main = this._main!.store;
		const from = Math.max(lo, main.first);
		const to = Math.min(hi, main.end);
		if (to <= from) {
			return;
		}
		for (let level = 1; level <= pyramid.levels.length; level++) {
			this._refreshLevel(pyramid, owner, level, from, to);
		}
	}

	private _refreshLevel(pyramid: Pyramid, owner: SeriesState | null, level: number, lo: number, hi: number): void {
		const shift = levelShift(level);
		const bucketFrom = lo >> shift;
		const bucketTo = ((hi - 1) >> shift) + 1;
		const buckets = bucketTo - bucketFrom;
		const columns = pyramid.columnCount;
		if (this._block.length < buckets * columns) {
			this._block = new Float64Array(Math.max(buckets * columns, this._block.length * 2, 256));
		}
		const block = this._block;
		if (level === 1) {
			const main = this._main!.store;
			this._aggregateRows(
				pyramid,
				owner,
				Math.max(bucketFrom << shift, main.first),
				Math.min(bucketTo << shift, main.end),
				shift,
				block,
				buckets,
			);
		} else {
			const child = pyramid.levels[level - 2]!;
			const sources = this._sources;
			const bases = this._bases;
			const aggregates = pyramid.aggregates;
			const end = Math.min(bucketTo << 2, child.end);
			let at = 0;
			let i = Math.max(bucketFrom << 2, child.first);
			while (i < end) {
				const chunk = child.chunkAt(i);
				const row = i & child.mask;
				const n = Math.min(child.rows - row, end - i);
				for (let c = 0; c < columns; c++) {
					sources[c] = chunk.columns[c]!;
					bases[c] = i - row;
				}
				at += aggregate(sources, bases, i, i + n, 2, aggregates, block, buckets, at);
				i += n;
			}
		}
		storeBuckets(pyramid.levels[level - 1]!, block, buckets, bucketFrom, bucketTo);
	}

	/** Aggregates main rows `[lo, hi)` (whole buckets of `2^shift` rows, cut only at the data's ends) into `block`. */
	private _aggregateRows(
		pyramid: Pyramid,
		owner: SeriesState | null,
		lo: number,
		hi: number,
		shift: number,
		block: Float64Array,
		stride: number,
	): void {
		const sources = this._sources;
		const bases = this._bases;
		const aggregates = pyramid.aggregates;
		const columns = aggregates.length;
		const main = this._main!;
		if (owner === null || owner === main) {
			const store = main.store;
			let at = 0;
			let r = lo;
			while (r < hi) {
				const chunk = store.chunkAt(r);
				const row = r & CHUNK_MASK;
				const n = Math.min(CHUNK_ROWS - row, hi - r);
				const missing = owner === null ? chunk.columns.length === 0 : chunk.columns.length < store.columnCount;
				if (missing) {
					// Never reached: buckets are rebuilt only where their rows are held. Should it happen,
					// rows let go read as missing rather than as anything made up.
					const groups = ((r + n - 1) >> shift) - (r >> shift) + 1;
					for (let c = 0; c < columns; c++) {
						block.fill(NaN, c * stride + at, c * stride + at + groups);
					}
					at += groups;
					r += n;
					continue;
				}
				for (let c = 0; c < columns; c++) {
					sources[c] = chunk.columns[owner === null ? TIME : owner.sources[c]! + 1]!;
					bases[c] = r - row;
				}
				at += aggregate(sources, bases, r, r + n, shift, aggregates, block, stride, at);
				r += n;
			}
			return;
		}
		if (owner.store.length === 0) {
			const buckets = ((hi - 1) >> shift) - (lo >> shift) + 1;
			for (let c = 0; c < columns; c++) {
				block.fill(NaN, c * stride, c * stride + buckets);
			}
			return;
		}
		const rows = hi - lo;
		if (this._values.length < rows * owner.valueColumns) {
			this._values = new Float64Array(Math.max(rows * owner.valueColumns, this._values.length * 2, 256));
		}
		const values = this._values;
		this._aligned(owner, lo, hi, values, rows);
		for (let c = 0; c < columns; c++) {
			sources[c] = values;
			bases[c] = lo - owner.sources[c]! * rows;
		}
		aggregate(sources, bases, lo, hi, shift, aggregates, block, stride, 0);
	}

	/** Adds the levels a grown main timeline needs to every pyramid, each built from the level below. */
	private _growLevels(): void {
		const main = this._main!.store;
		const first = main.first;
		const end = main.end;
		const levels = levelCount(end - first);
		while (this._levels < levels) {
			this._levels++;
			const level = this._levels;
			// A pyramid may still have the level from before a deletion shortened the timeline.
			if (this._time.levels.length < level) {
				this._time.addLevel(first);
			}
			this._refreshLevel(this._time, null, level, first, end);
			for (const state of this._series.values()) {
				if (state.pyramid.levels.length < level) {
					state.pyramid.addLevel(first);
				}
				this._refreshLevel(state.pyramid, state, level, first, end);
			}
		}
	}

	/**
	 * Writes the values of a secondary series for main bars `[from, to)` into column-major `out`
	 * (columns `stride` long). Main bars without a matching bar get NaN. The bars merged into those
	 * main bars must be held, and the main series' times (it keeps them while other series have data).
	 */
	private _aligned(state: SeriesState, from: number, to: number, out: Float64Array, stride: number): void {
		const rows = to - from;
		if (rows <= 0) {
			return;
		}
		const valueColumns = state.valueColumns;
		for (let c = 0; c < valueColumns; c++) {
			out.fill(NaN, c * stride, c * stride + rows);
		}
		const store = state.store;
		if (store.length === 0) {
			return;
		}
		// times[k] is the time of main bar `from + k`; one extra entry bounds the last bar.
		const main = this._main!.store;
		let times = this._scratch;
		if (times.length < rows + 1) {
			times = new Float64Array(Math.max(rows + 1, times.length * 2));
			this._scratch = times;
		}
		main.copyColumn(TIME, from, to, times, 0);
		times[rows] = to < main.end ? main.timeAt(to) : Infinity;

		const end = store.end;
		let j = store.lowerBound(times[0]!);
		if (j !== j || times[rows] !== times[rows]) {
			throw new Error('lumen-charts: bars that were let go were needed');
		}
		if (j >= end) {
			return;
		}
		let chunk = store.chunkAt(j);
		let columns = chunk.columns;
		// A chunk whose values were let go reads as missing values; one without its times is only
		// ever looked at for its first time, which bounds the bars before it.
		let held = columns.length === store.columnCount;
		let row = j & CHUNK_MASK;
		let time = columns.length > 0 ? columns[TIME]![row]! : chunk.summary!.firstTime;
		for (let k = 0; k < rows && j < end; k++) {
			const next = times[k + 1]!;
			if (time >= next) {
				continue;
			}
			let open = NaN;
			let high = -Infinity;
			let low = Infinity;
			let close = NaN;
			let volume = NaN;
			// As in every other aggregation, rows without a value are skipped, and a group made only
			// of such rows has no value.
			do {
				if (columns.length === 0) {
					throw new Error('lumen-charts: bars that were let go were needed');
				}
				if (!held) {
					// Nothing to merge.
				} else if (valueColumns === 1) {
					const value = columns[1]![row]!;
					if (value === value) {
						close = value;
					}
				} else {
					const o = columns[1]![row]!;
					const h = columns[2]![row]!;
					const l = columns[3]![row]!;
					const c = columns[4]![row]!;
					const v = columns[5]![row]!;
					if (open !== open) {
						open = o;
					}
					if (h === h) {
						high = Math.max(high, h);
					}
					if (l === l) {
						low = Math.min(low, l);
					}
					if (c === c) {
						close = c;
					}
					if (v === v) {
						volume = volume === volume ? volume + v : v;
					}
				}
				j++;
				row++;
				if (j >= end) {
					break;
				}
				if (row === CHUNK_ROWS) {
					chunk = store.chunkAt(j);
					columns = chunk.columns;
					held = columns.length === store.columnCount;
					row = 0;
				}
				time = columns.length > 0 ? columns[TIME]![row]! : chunk.summary!.firstTime;
			} while (time < next);
			if (valueColumns === 1) {
				out[k] = close;
			} else {
				out[k] = open;
				out[stride + k] = high === -Infinity ? NaN : high;
				out[2 * stride + k] = low === Infinity ? NaN : low;
				out[3 * stride + k] = close;
				out[4 * stride + k] = volume;
			}
		}
	}
}

/** Line rows at `times` without values, column-major: the bars of a timeline made from marks. */
function bars(times: readonly number[]): Float64Array {
	const data = new Float64Array(times.length * 2).fill(NaN);
	data.set(times);
	return data;
}

function markDirty(state: SeriesState, index: number): void {
	const runs = state.runs;
	// Ticks nearly always touch the run touched last, so that one is tried first.
	let r = state.run;
	if (r >= runs.length || index < runs[r]! - 1 || index > runs[r + 1]!) {
		for (r = 0; r < runs.length; r += 2) {
			if (index >= runs[r]! - 1 && index <= runs[r + 1]!) {
				break;
			}
		}
		if (r >= runs.length) {
			runs.push(index, index + 1);
			state.run = r;
			return;
		}
		state.run = r;
	}
	if (index < runs[r]!) {
		runs[r] = index;
	} else if (index >= runs[r + 1]!) {
		runs[r + 1] = index + 1;
	}
}

/** Counts `count` rows of series `series` that were not applied, in all and for the series. */
function reject(event: EngineEvent, series: number, count: number): void {
	if (count <= 0) {
		return;
	}
	event.rejected += count;
	const list = (event.rejectedSeries ??= []);
	for (let i = 0; i < list.length; i += 2) {
		if (list[i] === series) {
			list[i + 1] = list[i + 1]! + count;
			return;
		}
	}
	list.push(series, count);
}

/** A copy of one tick, to wait with. */
function heldTick(state: SeriesState, row: Float64Array, offset: number, seq: number, index: number): Held {
	return {
		state,
		seq,
		row: index,
		type: 'tick',
		data: row.slice(offset, offset + TICK_ROW),
		count: 1,
		from: 0,
		to: 0,
		fetchable: undefined,
		side: NaN,
	};
}

/**
 * Median gap between consecutive times of rows `[from, to)`, or 1 ms with fewer than two rows. Rows
 * of a chunk without its times are skipped. The median ignores the odd long gap (a weekend, a
 * session break) that a mean would not.
 */
function medianGap(store: ChunkedStore, from: number, to: number): number {
	const gaps = new Float64Array(Math.max(0, to - from - 1));
	let count = 0;
	let previous = store.timeAt(from);
	for (let row = from + 1; row < to; row++) {
		const time = store.timeAt(row);
		const gap = time - previous;
		if (gap === gap) {
			gaps[count++] = gap;
		}
		previous = time;
	}
	if (count === 0) {
		return 1;
	}
	// At most 64 numbers: an insertion sort is plenty.
	for (let i = 1; i < count; i++) {
		const value = gaps[i]!;
		let j = i - 1;
		while (j >= 0 && gaps[j]! > value) {
			gaps[j + 1] = gaps[j]!;
			j--;
		}
		gaps[j + 1] = value;
	}
	const gap = gaps[count >> 1]!;
	return gap > 0 ? gap : 1;
}

/** First row of the finest bucket holding `row`, not before `first`. */
function bucketStart(row: number, first: number): number {
	return Math.max(first, (row >> BUCKET_SHIFT) << BUCKET_SHIFT);
}

/** Index of `time` in increasing `times`, or -1. */
function indexOf(times: Float64Array, time: number): number {
	const k = lowerBoundOf(times, time);
	return k < times.length && times[k] === time ? k : -1;
}

/** First index of increasing `times` whose time is not less than `time`. */
function lowerBoundOf(times: Float64Array, time: number): number {
	let lo = 0;
	let hi = times.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (times[mid]! < time) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo;
}

/** Rows of chunks among `[from, to)` whose values were let go. */
function evictedRows(store: ChunkedStore, from: number, to: number): number {
	let rows = 0;
	if (store.evictedCount === 0) {
		return 0;
	}
	for (let grid = store.gridOf(from), last = store.gridOf(to - 1); grid <= last; grid++) {
		if (store.isEvicted(grid)) {
			rows += store.rows;
		}
	}
	return rows;
}

/** Cuts every level of a pyramid to the buckets of main rows `[first, end)`. */
function truncatePyramid(pyramid: Pyramid, first: number, end: number): void {
	for (let level = 1; level <= pyramid.levels.length; level++) {
		const shift = levelShift(level);
		pyramid.levels[level - 1]!.truncate(first >> shift, ((end - 1) >> shift) + 1);
	}
}

/** Removes the entries of a list that match, keeping the order of the others. */
function removeWhere<T>(list: T[], match: (entry: T) => boolean): void {
	let kept = 0;
	for (const entry of list) {
		if (!match(entry)) {
			list[kept++] = entry;
		}
	}
	list.length = kept;
}

/**
 * Inserts `[from, to)` into the first `length` numbers of `ranges`, a list of ranges kept sorted by
 * start (lists hold a few entries), and returns its new length. `ranges` may be longer than that.
 */
function insertRange(ranges: number[], length: number, from: number, to: number): number {
	let i = length;
	while (i > 0 && ranges[i - 2]! > from) {
		ranges[i] = ranges[i - 2]!;
		ranges[i + 1] = ranges[i - 1]!;
		i -= 2;
	}
	ranges[i] = from;
	ranges[i + 1] = to;
	return length + 2;
}
