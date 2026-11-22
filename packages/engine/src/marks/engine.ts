import { HeatmapStore } from './heatmap-store';
import type { MarksChange, MarksRequest, MarksStore, MarksUpdate } from './protocol';
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
}

/** What a change or a window request of a marks series leaves in the event that answers it. */
export interface MarksOutcome {
	rejected: number;
	marks?: MarksUpdate[];
}

/**
 * The marks series of an engine: their stores, and for each the window the client holds, which an
 * append patches with the rows it changed (the new points, the cells of the last time bucket, the
 * last column) in the event that answers it. A prepend or a deletion is not patched: the client is
 * told to ask for its view again (`MarksUpdate.notice`).
 */
export class MarksEngine {
	private readonly _series = new Map<number, Hosted>();

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

	/** Applies a change. A bulk change yields between slices of work. */
	public *change(series: number, change: MarksChange, outcome: MarksOutcome): Generator<undefined, void, undefined> {
		if (change.op === 'add') {
			this._series.set(series, {
				store: change.kind === 'heatmap' ? new HeatmapStore() : new ScatterStore(),
				generation: 0,
				subscription: null,
			});
			return;
		}
		if (change.op === 'remove') {
			this._series.delete(series);
			return;
		}
		const hosted = this._series.get(series);
		if (hosted === undefined) {
			outcome.rejected = change.op === 'delete' ? 0 : change.data.count;
			return;
		}
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

	/** Answers a window request: the rows of the level the view needs, or that the client has them. */
	public window(series: number, seq: number, request: MarksRequest, outcome: MarksOutcome): void {
		const hosted = this._series.get(series);
		if (hosted === undefined) {
			return;
		}
		const store = hosted.store;
		const selection = store.select(request);
		const update = emptyUpdate(series, hosted.generation);
		update.request = seq;
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
