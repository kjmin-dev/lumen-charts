import type { TimelineResolution } from '@lumen-charts/engine';
import type { LevelWindow } from '../data/window-cache';

/** The position is right for the current timeline. */
const VALID = 0;
/** The position was right for an earlier timeline; it stands in until the next lookup asks again. */
const STALE = 1;
/** Asked for, and the answer is not in yet. */
const PENDING = 2;

/** Most times remembered; past it the memo starts over and asks again for what is looked up. */
const MAX_ENTRIES = 65_536;
/**
 * Bars the engine takes the typical spacing at either end from (64 gaps). A timeline longer than
 * that on both sides of a change keeps the spacing at the end that did not move.
 */
const SPACING_ROWS = 65;

/** Where `resolve` commands go. */
export interface TimeIndexEngine {
	resolveTimes(times: Float64Array): number;
}

/**
 * Logical positions of times on the main timeline, for anchors stored as times (drawings,
 * primitives). The main thread holds only the bars around the view, so a time elsewhere is looked
 * up by the data engine: `lookup` answers at once when it can (a time inside the raw window, or
 * beyond either end of the timeline once its ends are known) and otherwise returns NaN, or the
 * position for an earlier timeline, and asks the engine; `version` changes when answers arrive.
 *
 * Positions survive what keeps indexes: a prepend, bars appended, bars cut at either end. Only the
 * positions those change (times outside the bars both timelines share) are asked for again. A new
 * epoch (a new history, bars removed in the middle) changes every position, and none is shown until
 * it is known again.
 */
export class TimeIndex {
	/** Changes whenever a lookup may answer differently than before. */
	public version = 0;
	/** Set while anything uses positions: then the ends of the timeline are kept known. */
	public active = false;
	/** Called when an answer arrived, so positions changed. */
	public listener: (() => void) | null = null;

	private readonly _slots = new Map<number, number>();
	private _times = new Float64Array(64);
	private _positions = new Float64Array(64);
	private _states = new Uint8Array(64);
	private _count = 0;
	/** Slots to ask for with the next `flush`. */
	private _batch = new Int32Array(64);
	private _batchCount = 0;
	/** Requests out, by `seq`: the slots asked for and the memo generation they belong to. */
	private readonly _requests = new Map<number, { slots: Int32Array; generation: number }>();
	/** Changes when the memo starts over, so answers for the old slots are dropped. */
	private _generation = 0;

	/** Timeline the valid positions are for. */
	private _epoch = -1;
	private _first = 0;
	private _end = 0;
	/** The ends of the timeline, known for the timeline above when `_ends` is set. */
	private _ends = false;
	private _endsRequested = false;
	private _firstTime = NaN;
	private _lastTime = NaN;
	private _headInterval = NaN;
	private _tailInterval = NaN;
	/** Raw rows held around the view, for answers without the engine. */
	private _window: LevelWindow | null = null;

	/** Extent of the timeline: `[first, end)` rows. */
	public get first(): number {
		return this._first;
	}

	public get end(): number {
		return this._end;
	}

	/** Number of times remembered. */
	public get size(): number {
		return this._count;
	}

	/** The raw window lookups may answer from; null when the view draws from a coarse level only. */
	public setWindow(window: LevelWindow | null): void {
		this._window = window !== null && window.count > 0 ? window : null;
	}

	/**
	 * Follows the timeline of an engine event, before any answer it carries is applied. Positions
	 * that may have moved become stale: all of them with a new epoch, otherwise those outside the
	 * rows the old and the new timeline share.
	 */
	public setTimeline(epoch: number, first: number, end: number): void {
		if (epoch === this._epoch && first === this._first && end === this._end) {
			return;
		}
		const positions = this._positions;
		const states = this._states;
		let changed = false;
		if (epoch !== this._epoch) {
			for (let slot = 0; slot < this._count; slot++) {
				if (states[slot] !== PENDING) {
					states[slot] = STALE;
				}
				positions[slot] = NaN;
			}
			changed = this._count > 0;
		} else {
			// Bars both timelines have keep their indexes; beyond an end that did not move, positions
			// keep the spacing they were extrapolated with.
			const lo = Math.max(first, this._first);
			const hi = Math.min(end, this._end) - 1;
			const long = end - first > SPACING_ROWS && this._end - this._first > SPACING_ROWS;
			const head = long && first === this._first ? -Infinity : lo;
			const tail = long && end === this._end ? Infinity : hi;
			for (let slot = 0; slot < this._count; slot++) {
				const position = positions[slot]!;
				if (states[slot] === VALID && !(position >= head && position <= tail) && !(position >= lo && position <= hi)) {
					states[slot] = STALE;
					changed = true;
				}
			}
		}
		this._epoch = epoch;
		this._first = first;
		this._end = end;
		this._ends = false;
		if (changed) {
			this.version++;
		}
	}

	/**
	 * Applies the answer to request `seq`. The event carrying it has been passed to `setTimeline`
	 * already, so the answer is for the current timeline.
	 */
	public apply(seq: number, resolution: TimelineResolution): void {
		this._ends = true;
		this._endsRequested = false;
		this._firstTime = resolution.firstTime;
		this._lastTime = resolution.lastTime;
		this._headInterval = resolution.headInterval;
		this._tailInterval = resolution.tailInterval;
		const request = this._requests.get(seq);
		this._requests.delete(seq);
		let changed = false;
		if (request !== undefined && request.generation === this._generation) {
			const { slots } = request;
			const positions = resolution.positions;
			for (let i = 0; i < slots.length; i++) {
				const slot = slots[i]!;
				// Asked for again since (it went stale while this answer was on its way): keep waiting.
				if (this._states[slot] === PENDING) {
					this._positions[slot] = positions[i]!;
					this._states[slot] = VALID;
					changed = true;
				}
			}
		}
		// The ends alone change no position that was looked up: nothing to redraw for them.
		if (changed) {
			this.version++;
			this.listener?.();
		}
	}

	/** Forgets the request `seq`, for example when the engine failed it. */
	public cancel(seq: number): void {
		const request = this._requests.get(seq);
		this._requests.delete(seq);
		this._endsRequested = false;
		if (request !== undefined && request.generation === this._generation) {
			for (const slot of request.slots) {
				if (this._states[slot] === PENDING) {
					this._states[slot] = STALE;
				}
			}
		}
	}

	/**
	 * Logical position of `time`: exact for the time of a bar, between two bars for a time between
	 * theirs, beyond the ends at the spacing of the bars there. NaN while the engine is asked.
	 */
	public lookup(time: number): number {
		let slot = this._slots.get(time);
		if (slot === undefined) {
			if (time !== time) {
				return NaN;
			}
			slot = this._add(time);
			const local = this._local(time);
			this._positions[slot] = local;
			if (local === local) {
				this._states[slot] = VALID;
			} else {
				this._ask(slot);
			}
			return local;
		}
		if (this._states[slot] === STALE) {
			const local = this._local(time);
			if (local === local) {
				this._positions[slot] = local;
				this._states[slot] = VALID;
			} else {
				this._ask(slot);
			}
		}
		return this._positions[slot]!;
	}

	/**
	 * Records the position of a time known otherwise, for example the time of a bar the pointer
	 * placed an anchor on, so looking it up needs no round trip.
	 */
	public seed(time: number, position: number): void {
		if (time !== time || position !== position) {
			return;
		}
		let slot = this._slots.get(time);
		if (slot === undefined) {
			slot = this._add(time);
		}
		this._positions[slot] = position;
		this._states[slot] = VALID;
	}

	/**
	 * Time at a logical position: the bar's time for a whole index inside the held rows, interpolated
	 * between bars, extrapolated beyond the ends; NaN when the rows there are not held and the ends
	 * are not known. `coarse`, a window of buckets, answers approximately where the raw rows do not.
	 */
	public timeAt(position: number, coarse: LevelWindow | null): number {
		if (position !== position) {
			return NaN;
		}
		const first = this._first;
		const last = this._end - 1;
		if (last < first) {
			return NaN;
		}
		if (position >= last && this._ends) {
			return this._lastTime + (position - last) * this._tailInterval;
		}
		if (position <= first && this._ends) {
			return this._firstTime - (first - position) * this._headInterval;
		}
		const window = this._window;
		const lo = Math.floor(position);
		if (window !== null) {
			const row = lo - window.start;
			if (row >= 0 && row < window.count) {
				const time = window.time[row]!;
				const fraction = position - lo;
				if (fraction === 0) {
					return time;
				}
				if (row + 1 < window.count) {
					return time + fraction * (window.time[row + 1]! - time);
				}
			}
		}
		if (coarse !== null && coarse.count > 1) {
			const size = 2 ** coarse.shift;
			const bucket = Math.floor(position / size);
			const k = bucket - coarse.start;
			if (k >= 0 && k + 1 < coarse.count) {
				const start = coarse.time[k]!;
				// A bucket's time is that of its first row, which is not `bucket * size` for the first one.
				const startRow = Math.max(bucket * size, first);
				const nextRow = (bucket + 1) * size;
				return start + ((position - startRow) / (nextRow - startRow)) * (coarse.time[k + 1]! - start);
			}
		}
		return NaN;
	}

	/**
	 * Time at a logical position without asking the engine, for saving a view: `timeAt`, and where
	 * that has no answer at or beyond an end of the timeline (its ends are known only while something
	 * uses positions), the time the rows or buckets held at that end give: beyond the raw rows at
	 * their median spacing, as the engine places times there; from buckets, at the spacing of the
	 * bucket at the end. NaN when nothing held reaches that far.
	 */
	public estimateTime(position: number, coarse: LevelWindow | null): number {
		const known = this.timeAt(position, coarse);
		const first = this._first;
		const last = this._end - 1;
		if (known === known || position !== position || last < first) {
			return known;
		}
		const window = this._window;
		if (window !== null) {
			const count = window.count;
			const times = window.time;
			if (position >= last && window.start + count - 1 === last) {
				return times[count - 1]! + (position - last) * medianGap(times, Math.max(0, count - SPACING_ROWS), count);
			}
			if (position <= first && window.start === first) {
				return times[0]! - (first - position) * medianGap(times, 0, Math.min(count, SPACING_ROWS));
			}
		}
		if (coarse !== null && coarse.count > 1) {
			const size = 2 ** coarse.shift;
			const times = coarse.time;
			const k = coarse.count - 1;
			// Rows a bucket starts at; the first bucket of the timeline starts at its first row.
			const lastStart = Math.max((coarse.start + k) * size, first);
			if (position >= lastStart && coarse.start + k === Math.floor(last / size)) {
				const before = Math.max((coarse.start + k - 1) * size, first);
				return times[k]! + ((position - lastStart) / (lastStart - before)) * (times[k]! - times[k - 1]!);
			}
			if (position <= first && coarse.start === Math.floor(first / size)) {
				const next = (coarse.start + 1) * size;
				return times[0]! - ((first - position) / (next - first)) * (times[1]! - times[0]!);
			}
		}
		return NaN;
	}

	/**
	 * Logical position of `time` from what is held, without asking the engine or remembering the
	 * time: inside the raw rows, beyond the known ends, or beyond an end the raw rows reach with the
	 * 65 rows the engine takes the spacing there from, which gives the engine's answer. NaN otherwise.
	 */
	public locate(time: number): number {
		const local = this._local(time);
		const window = this._window;
		if (local === local || window === null || time !== time) {
			return local;
		}
		const first = this._first;
		const last = this._end - 1;
		const count = window.count;
		const times = window.time;
		const start = window.start;
		if (time > times[count - 1]! && start + count - 1 === last && start <= Math.max(first, last - SPACING_ROWS + 1)) {
			return last + (time - times[count - 1]!) / medianGap(times, Math.max(0, count - SPACING_ROWS), count);
		}
		if (time < times[0]! && start === first && start + count - 1 >= Math.min(last, first + SPACING_ROWS - 1)) {
			return first - (times[0]! - time) / medianGap(times, 0, Math.min(count, SPACING_ROWS));
		}
		return NaN;
	}

	/**
	 * Sends what waits to be asked for, and asks for the ends of the timeline when they are not known
	 * and something uses positions. Called once per frame.
	 */
	public flush(engine: TimeIndexEngine | null): void {
		const ends = this.active && !this._ends && !this._endsRequested && this._end > this._first;
		if (engine === null || (this._batchCount === 0 && !ends)) {
			return;
		}
		const count = this._batchCount;
		const times = new Float64Array(count);
		const slots = this._batch.slice(0, count);
		for (let i = 0; i < count; i++) {
			times[i] = this._times[slots[i]!]!;
		}
		this._batchCount = 0;
		this._endsRequested = true;
		this._requests.set(engine.resolveTimes(times), { slots, generation: this._generation });
	}

	/** Forgets everything, for example when the main series is gone. */
	public clear(): void {
		this._slots.clear();
		this._count = 0;
		this._batchCount = 0;
		this._generation++;
		this.version++;
	}

	/** Answers without the engine: inside the raw window, or beyond the known ends. */
	private _local(time: number): number {
		const window = this._window;
		if (window !== null) {
			const times = window.time;
			const count = window.count;
			if (time >= times[0]! && time <= times[count - 1]!) {
				let lo = 0;
				let hi = count - 1;
				while (lo < hi) {
					const mid = (lo + hi) >> 1;
					if (times[mid]! < time) {
						lo = mid + 1;
					} else {
						hi = mid;
					}
				}
				const at = times[lo]!;
				if (at === time) {
					return window.start + lo;
				}
				const before = times[lo - 1]!;
				return window.start + lo - 1 + (time - before) / (at - before);
			}
		}
		if (this._ends) {
			if (time >= this._lastTime) {
				return this._end - 1 + (time - this._lastTime) / this._tailInterval;
			}
			if (time <= this._firstTime) {
				return this._first - (this._firstTime - time) / this._headInterval;
			}
		}
		return NaN;
	}

	private _ask(slot: number): void {
		this._states[slot] = PENDING;
		if (this._batchCount === this._batch.length) {
			const grown = new Int32Array(this._batch.length * 2);
			grown.set(this._batch);
			this._batch = grown;
		}
		this._batch[this._batchCount++] = slot;
	}

	private _add(time: number): number {
		if (this._count === MAX_ENTRIES) {
			this.clear();
		}
		const slot = this._count++;
		if (slot === this._times.length) {
			const size = slot * 2;
			const times = new Float64Array(size);
			times.set(this._times);
			this._times = times;
			const positions = new Float64Array(size);
			positions.set(this._positions);
			this._positions = positions;
			const states = new Uint8Array(size);
			states.set(this._states);
			this._states = states;
		}
		this._times[slot] = time;
		this._slots.set(time, slot);
		return slot;
	}
}

/** Median of the gaps between times `[from, to)`, as the engine takes the spacing at an end; 1 without a gap. */
function medianGap(times: Float64Array, from: number, to: number): number {
	const gaps: number[] = [];
	for (let row = from + 1; row < to; row++) {
		const gap = times[row]! - times[row - 1]!;
		if (gap === gap) {
			gaps.push(gap);
		}
	}
	if (gaps.length === 0) {
		return 1;
	}
	gaps.sort((a, b) => a - b);
	const gap = gaps[gaps.length >> 1]!;
	return gap > 0 ? gap : 1;
}
