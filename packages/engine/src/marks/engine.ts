import { HeatmapStore } from './heatmap-store';
import type {
	MarksChange,
	MarksChunk,
	MarksData,
	MarksFetchRequest,
	MarksRequest,
	MarksRestoreResult,
	MarksStore,
	MarksUpdate,
} from './protocol';
import { ScatterStore } from './scatter-store';

/** The window of a series the client was sent last: appends that change rows of it are patched in. */
interface Subscription {
	generation: number;
	level: number;
	end: number;
	/** The window ended with the last row of its level, so rows added after it follow on. */
	live: boolean;
}

interface Hosted {
	store: MarksStore;
	/** Changes with every `set` and `delete`. */
	generation: number;
	subscription: Subscription | null;
	/** The series has a datafeed: chunks of its marks may be let go under the memory limit. */
	fetchable: boolean;
	/** Times the last window request asked for, whose marks stay in memory. */
	keepFrom: number;
	keepTo: number;
	/**
	 * The chunks the last window request needs and that were let go: it was answered with a coarser
	 * level meanwhile (`MarksUpdate.partial`), and the client is told to ask again once they are back.
	 */
	deferred: number[] | null;
	/** Fetch requests out, by chunk. */
	fetching: Map<number, number>;
	/** Changes waiting for chunks let go (a removal that reads or moves them), and those after them. */
	queue: MarksChange[];
}

/** What a change or a window request of a marks series leaves in the event that answers it. */
export interface MarksOutcome {
	rejected: number;
	marks?: MarksUpdate[];
	marksFetch?: MarksFetchRequest[];
	marksCancel?: number[];
	marksRestored?: MarksRestoreResult;
}

/**
 * The marks series of an engine: their stores, and for each the window the client holds, which an
 * append patches with the rows it changed (the new points, the cells of the last time bucket, the
 * last column) in the event that answers it. A prepend or a deletion is not patched: the client is
 * told to ask for its view again (`MarksUpdate.notice`).
 */
export class MarksEngine {
	private readonly _series = new Map<number, Hosted>();
	/** Fetch requests out, by id: the series and chunk each is for. */
	private readonly _requests = new Map<number, { series: number; chunk: number }>();
	private _nextRequest = 1;

	/** Bytes held by the stores. */
	public get byteLength(): number {
		let bytes = 0;
		for (const hosted of this._series.values()) {
			bytes += hosted.store.byteLength;
		}
		return bytes;
	}

	/** The store of a series, for readers in the engine; undefined for a series it does not have. */
	public store(series: number): MarksStore | undefined {
		return this._series.get(series)?.store;
	}

	/** Whether `series` is a marks series. */
	public has(series: number): boolean {
		return this._series.has(series);
	}

	/** Fetch requests out, and changes waiting for marks to come back. */
	public get requests(): number {
		return this._requests.size;
	}

	public get waiting(): number {
		let waiting = 0;
		for (const hosted of this._series.values()) {
			waiting += hosted.queue.length;
		}
		return waiting;
	}

	/** Applies a change. A bulk change yields between slices of work. */
	public *change(series: number, change: MarksChange, outcome: MarksOutcome): Generator<undefined, void, undefined> {
		if (change.op === 'add') {
			this._series.set(series, {
				store: change.kind === 'heatmap' ? new HeatmapStore() : new ScatterStore(),
				generation: 0,
				subscription: null,
				fetchable: change.fetchable === true,
				keepFrom: Number.NaN,
				keepTo: Number.NaN,
				deferred: null,
				fetching: new Map(),
				queue: [],
			});
			return;
		}
		const hosted = this._series.get(series);
		if (change.op === 'remove') {
			if (hosted !== undefined) {
				this._cancel(hosted, [], outcome);
			}
			this._series.delete(series);
			return;
		}
		if (hosted === undefined) {
			outcome.rejected = change.op === 'delete' ? 0 : change.data.count;
			return;
		}
		if (change.op === 'set') {
			// A new history: what waited for the old one, and the requests for it, are dropped.
			hosted.queue.length = 0;
			hosted.deferred = null;
			this._cancel(hosted, [], outcome);
			if (change.fetchable !== undefined) {
				hosted.fetchable = change.fetchable;
			}
		} else if (hosted.queue.length > 0) {
			// Behind a change that waits for marks to come back, in the order they came.
			hosted.queue.push(change);
			return;
		}
		yield* this._apply(series, hosted, change, outcome);
	}

	/**
	 * Applies a change that does not wait. A removal that reads or moves marks let go waits for them:
	 * it is queued, and they are asked for.
	 */
	private *_apply(
		series: number,
		hosted: Hosted,
		change: Exclude<MarksChange, { op: 'add' } | { op: 'remove' }>,
		outcome: MarksOutcome,
	): Generator<undefined, void, undefined> {
		const store = hosted.store;
		switch (change.op) {
			case 'set':
				hosted.generation++;
				hosted.subscription = null;
				outcome.rejected = yield* store.set(change.data);
				store.clearChanges();
				return;
			case 'prepend':
				outcome.rejected = yield* store.prepend(change.data);
				store.clearChanges();
				// The rows held keep their indexes, but the view may now reach rows in front of them.
				this._notice(series, hosted, outcome);
				return;
			case 'delete': {
				const needed: number[] = [];
				store.needs(change.from, change.to, needed);
				if (needed.length > 0) {
					hosted.queue.unshift(change);
					this._fetch(series, hosted, needed, outcome);
					return;
				}
				const removed = yield* store.delete(change.from, change.to);
				store.clearChanges();
				if (removed > 0) {
					hosted.generation++;
					this._notice(series, hosted, outcome);
					hosted.subscription = null;
				}
				return;
			}
		}
		outcome.rejected = yield* store.append(change.data);
		const subscription = hosted.subscription;
		if (subscription !== null) {
			const from = store.changedFrom(subscription.level);
			const end = subscription.live
				? store.first(subscription.level) + store.total(subscription.level)
				: subscription.end;
			if (from < end) {
				const update = emptyUpdate(series, hosted.generation);
				store.read(subscription.level, from, end, update);
				subscription.end = end;
				(outcome.marks ??= []).push(update);
			}
		}
		store.clearChanges();
	}

	/** Tells the client holding a window of the series to ask for its view again. */
	private _notice(series: number, hosted: Hosted, outcome: MarksOutcome): void {
		const subscription = hosted.subscription;
		if (subscription === null) {
			// Nothing was sent since the last `set`, or the answer to a request out reflects the change.
			return;
		}
		const update = emptyUpdate(series, hosted.generation);
		hosted.store.read(subscription.level, 0, 0, update);
		update.notice = true;
		(outcome.marks ??= []).push(update);
	}

	/**
	 * Answers a window request: the rows of the level the view needs, or that the client has them.
	 * Where the level is 0 and some of its rows were let go, they are asked for, and the answer holds
	 * the finest coarse level meanwhile (`partial`); a notice follows once they are back.
	 */
	public window(series: number, seq: number, request: MarksRequest, outcome: MarksOutcome): void {
		const hosted = this._series.get(series);
		if (hosted === undefined) {
			return;
		}
		const store = hosted.store;
		let selection = store.select(request);
		hosted.keepFrom = request.from;
		hosted.keepTo = request.to;
		const missing: number[] = [];
		store.missing(selection.level, selection.start, selection.end, missing);
		const keep = missing.slice();
		for (const change of hosted.queue) {
			if (change.op === 'delete') {
				store.needs(change.from, change.to, keep);
			}
		}
		// Requests for marks the view left, and nothing waits for, are dropped.
		this._cancel(hosted, keep, outcome);
		hosted.deferred = null;
		if (missing.length > 0) {
			this._fetch(series, hosted, missing, outcome);
			hosted.deferred = missing;
			selection = store.select(request, 1);
		}
		const update = emptyUpdate(series, hosted.generation);
		update.request = seq;
		if (missing.length > 0) {
			update.partial = true;
		}
		const end = store.first(selection.level) + store.total(selection.level);
		if (
			request.generation === hosted.generation &&
			request.heldLevel === selection.level &&
			request.heldStart <= selection.start &&
			request.heldEnd >= selection.end
		) {
			// Nothing to copy. The description of the level comes with the rows of an empty read.
			store.read(selection.level, request.heldStart, request.heldStart, update);
			update.kept = true;
			update.count = Math.min(request.heldEnd, end) - request.heldStart;
			hosted.subscription = {
				generation: hosted.generation,
				level: selection.level,
				end: request.heldEnd,
				live: request.heldEnd >= end,
			};
		} else {
			store.read(selection.level, selection.start, selection.end, update);
			hosted.subscription = {
				generation: hosted.generation,
				level: selection.level,
				end: selection.end,
				live: selection.end >= end,
			};
		}
		(outcome.marks ??= []).push(update);
	}

	// Memory

	/** Asks for the chunks of a series that are not asked for yet. */
	private _fetch(series: number, hosted: Hosted, chunks: readonly number[], outcome: MarksOutcome): void {
		for (const chunk of chunks) {
			if (hosted.fetching.has(chunk)) {
				continue;
			}
			const range = hosted.store.fetchRange(chunk);
			if (range === null) {
				continue;
			}
			const id = this._nextRequest++;
			hosted.fetching.set(chunk, id);
			this._requests.set(id, { series, chunk });
			(outcome.marksFetch ??= []).push({ id, series, ...range });
		}
	}

	/** Cancels the requests of a series for chunks other than `keep`. */
	private _cancel(hosted: Hosted, keep: readonly number[], outcome: MarksOutcome): void {
		for (const [chunk, id] of hosted.fetching) {
			if (!keep.includes(chunk)) {
				hosted.fetching.delete(chunk);
				this._requests.delete(id);
				(outcome.marksCancel ??= []).push(id);
			}
		}
	}

	/**
	 * Takes marks fetched again for request `request` (null: fetching failed). Changes that waited for
	 * them run, and the client whose view needed them is told to ask again.
	 */
	public *restore(
		request: number,
		data: MarksData | null,
		outcome: MarksOutcome,
	): Generator<undefined, void, undefined> {
		const entry = this._requests.get(request);
		if (entry === undefined) {
			// Cancelled, or for a series that is gone: nothing needs it.
			return;
		}
		this._requests.delete(request);
		const hosted = this._series.get(entry.series)!;
		hosted.fetching.delete(entry.chunk);
		const store = hosted.store;
		const restored = data !== null && store.restore(entry.chunk, data);
		outcome.marksRestored = {
			request,
			series: entry.series,
			outcome: data === null ? 'failed' : restored ? 'restored' : 'mismatch',
		};
		if (!restored) {
			return;
		}
		// The changes that waited, while nothing they read is missing.
		while (hosted.queue.length > 0) {
			const change = hosted.queue[0]!;
			if (change.op === 'delete') {
				const needed: number[] = [];
				store.needs(change.from, change.to, needed);
				if (needed.length > 0) {
					this._fetch(entry.series, hosted, needed, outcome);
					break;
				}
			}
			hosted.queue.shift();
			yield* this._apply(
				entry.series,
				hosted,
				change as Exclude<MarksChange, { op: 'add' } | { op: 'remove' }>,
				outcome,
			);
		}
		const deferred = hosted.deferred;
		if (deferred !== null) {
			const left: number[] = [];
			for (const chunk of deferred) {
				const range = store.fetchRange(chunk);
				if (range !== null) {
					left.push(chunk);
				}
			}
			if (left.length === 0) {
				hosted.deferred = null;
				this._notice(entry.series, hosted, outcome);
			}
		}
	}

	/**
	 * Lets go of chunks of series with a datafeed, those farthest from what their views asked for
	 * first, until `excess` bytes are freed or `max` chunks went. Returns the bytes freed, and whether
	 * more could go.
	 */
	public evict(excess: number, max: number): { freed: number; more: boolean } {
		const candidates: (MarksChunk & { hosted: Hosted; distance: number })[] = [];
		const out: MarksChunk[] = [];
		for (const hosted of this._series.values()) {
			if (!hosted.fetchable) {
				continue;
			}
			out.length = 0;
			const keepFrom = hosted.keepFrom === hosted.keepFrom ? hosted.keepFrom : Infinity;
			const keepTo = hosted.keepTo === hosted.keepTo ? hosted.keepTo : -Infinity;
			hosted.store.evictable(keepFrom, keepTo, out);
			const waiting: number[] = [];
			for (const change of hosted.queue) {
				if (change.op === 'delete') {
					hosted.store.needs(change.from, change.to, waiting);
				}
			}
			for (const chunk of out) {
				if (hosted.fetching.has(chunk.chunk) || waiting.includes(chunk.chunk)) {
					continue;
				}
				const distance =
					keepFrom <= keepTo ? Math.max(keepFrom - chunk.to, chunk.from - keepTo) : -Math.abs(chunk.from);
				candidates.push({ ...chunk, hosted, distance });
			}
		}
		candidates.sort((a, b) => b.distance - a.distance);
		let freed = 0;
		const n = Math.min(candidates.length, max);
		let i = 0;
		for (; i < n && freed < excess; i++) {
			const candidate = candidates[i]!;
			freed += candidate.hosted.store.evict(candidate.chunk);
		}
		return { freed, more: freed < excess && i < candidates.length };
	}

	/** Chunks every series has let go. */
	public get evicted(): number {
		let evicted = 0;
		for (const hosted of this._series.values()) {
			evicted += hosted.store.evicted;
		}
		return evicted;
	}
}

function emptyUpdate(series: number, generation: number): MarksUpdate {
	// Arrays of their own: the update's buffers are transferred to the client.
	return {
		series,
		generation,
		level: 0,
		start: 0,
		count: 0,
		first: 0,
		total: 0,
		timeStep: 0,
		priceStep: 0,
		priceStart: 0,
		rows: 1,
		valueMin: Number.NaN,
		valueMax: Number.NaN,
		time: new Float64Array(0),
		price: new Float64Array(0),
		values: new Float32Array(0),
		counts: new Float32Array(0),
		sizes: new Float32Array(0),
		offsets: new Int32Array(0),
		lengths: new Int32Array(0),
	};
}
