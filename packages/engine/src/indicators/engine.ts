import { CHUNK_ROWS, CHUNK_SHIFT } from '../chunk';
import { type IndicatorInputRef, type SeriesBlock, levelCount, levelShift } from '../protocol';
import { FIRST, LAST, MAX, MIN, Pyramid, aggregate, storeBuckets } from '../pyramid';
import { ChunkedStore } from '../store';
import { BUILTIN_INDICATORS } from './builtins';
import { type IndicatorDefinition, resolveParams } from './definition';
import { type InputReader, Runner } from './runner';

/** What the indicator engine needs from the data engine. */
export interface IndicatorHost {
	/** First row of the main timeline. */
	first(): number;
	/** One past the last row of the main timeline (not above `first()`). */
	end(): number;
	/**
	 * Copies rows `[from, to)` of a column of a series, aligned to the main timeline, into `out` from
	 * `offset` on. Column 0 is the main timeline's time. Missing values are NaN.
	 */
	read(series: number, column: number, from: number, to: number, out: Float64Array, offset: number): void;
	/** Main-timeline rows a series changed in the command being run, as `[from, to)` pairs. */
	runs(series: number): readonly number[];
	/**
	 * True when rows `[from, to)` of the main series are in memory. Rows among `[from, ahead)` that
	 * the memory limit let go are asked for again (a later `rows` command brings them back), so a
	 * recomputation reads exact inputs one window at a time.
	 */
	ensure(from: number, to: number, ahead: number): boolean;
}

/** A recomputation running off to the side; the live values stay in place until it is done. */
interface Job {
	/**
	 * Rows `[first, to)` are recomputed, where `first` is the first row of the data. `Infinity`:
	 * everything, into a new store that replaces the live one. Otherwise the rows are spliced into the
	 * live store, whose rows from `to` on stay as they are.
	 */
	to: number;
	/** Null until the job starts, and again whenever it has to start over. */
	runner: Runner | null;
	store: ChunkedStore | null;
	pyramid: Pyramid | null;
	/** A partial job's results, column-major, `to - first` rows per output. */
	values: Float64Array | null;
	/** Row the job waits to be fetched again before it can go on, or NaN. */
	waiting: number;
}

interface Instance {
	readonly id: number;
	definition: IndicatorDefinition;
	params: Float64Array;
	inputs: IndicatorInputRef[];
	/** Instance read by each input, or null for a column of a series. */
	sources: (Instance | null)[];
	/** Derived series id of each output. */
	readonly outputs: readonly number[];
	/** Live values, one column per output, on the main timeline. */
	store: ChunkedStore | null;
	pyramid: Pyramid;
	/** Live runner: the state at the last committed row, for incremental updates. Null without live values. */
	runner: Runner | null;
	job: Job | null;
	/** First row whose values changed in the tick batch being applied. */
	changed: number;
	read: InputReader;
}

/** Ticks recompute an older bar in place when at most this many rows follow its chunk's start. */
const SYNC_ROWS = 4 * CHUNK_ROWS;
/** Rows let go under the memory limit that a recomputation asks for ahead of where it reads. */
const FETCH_AHEAD = 16 * CHUNK_ROWS;

/** Smallest chunk boundary (global index multiple of the chunk size) at or above `index`. */
function chunkCeil(index: number): number {
	return ((index + CHUNK_ROWS - 1) >> CHUNK_SHIFT) << CHUNK_SHIFT;
}

/**
 * Finest-level buckets of one output: the first, highest, lowest and last non-missing value of each
 * group of `2^shift` rows among `[lo, hi)` (whole groups except at the ends of the data), where row
 * `r` is `source[r - base]`. Writes group `k` to `block[at + k]` and the next three columns
 * `stride` apart, as `aggregate` with first, highest, lowest and last would, in one pass. Returns
 * the number of groups.
 */
function lineBuckets(
	source: Float64Array,
	base: number,
	lo: number,
	hi: number,
	shift: number,
	block: Float64Array,
	stride: number,
	at: number,
): number {
	let k = at;
	let r = lo;
	while (r < hi) {
		const next = ((r >> shift) + 1) << shift;
		const end = next < hi ? next : hi;
		const from = r - base;
		const stop = end - base;
		let first = NaN;
		for (let i = from; i < stop; i++) {
			const v = source[i]!;
			if (v === v) {
				first = v;
				break;
			}
		}
		let last = NaN;
		for (let i = stop - 1; i >= from; i--) {
			const v = source[i]!;
			if (v === v) {
				last = v;
				break;
			}
		}
		let max = -Infinity;
		let min = Infinity;
		for (let i = from; i < stop; i++) {
			const v = source[i]!;
			// Comparisons with NaN are false, so missing values are skipped.
			max = v > max ? v : max;
			min = v < min ? v : min;
		}
		block[k] = first;
		block[k + stride] = max === -Infinity ? NaN : max;
		block[k + 2 * stride] = min === Infinity ? NaN : min;
		block[k + 3 * stride] = last;
		k++;
		r = end;
	}
	return k - at;
}

/** Level-of-detail aggregates of an indicator: first, highest, lowest and last value of each output. */
function aggregatesOf(outputs: number): number[] {
	const list: number[] = [];
	for (let o = 0; o < outputs; o++) {
		list.push(FIRST, MAX, MIN, LAST);
	}
	return list;
}

/**
 * Indicators inside the data engine. Each indicator instance turns columns of series (or outputs of
 * other instances) into outputs that are series on the main timeline, with levels of detail like
 * every other series.
 *
 * Full computations (after a load, a parameter change or a prepend) run in background slices of one
 * chunk, into storage of their own; the values on screen stay until the new ones are complete and
 * are then swapped in at once. Ticks update the live values incrementally: the kernel state is kept
 * at the last committed row, and the bar still forming is computed from a copy of it.
 */
export class IndicatorEngine {
	/** Called when work finished outside a command and a notice is waiting. */
	public onwake: (() => void) | null = null;
	private readonly _host: IndicatorHost;
	private readonly _definitions = new Map<string, IndicatorDefinition>();
	/** Instances in creation order, which is a topological order: inputs only read earlier instances. */
	private readonly _instances: Instance[] = [];
	private readonly _byOutput = new Map<number, { instance: Instance; index: number }>();
	/** Values were swapped in since the last notice: the client's windows are stale. */
	private _swapped = false;
	/** Instances swapped since the last notice, whose latest values go with it. */
	private readonly _fresh = new Set<Instance>();
	/** Reused arguments of `aggregate`. */
	private readonly _sourcesScratch: Float64Array[] = [];
	private readonly _bases: number[] = [];
	private _block = new Float64Array(0);

	public constructor(host: IndicatorHost) {
		this._host = host;
		for (const definition of BUILTIN_INDICATORS) {
			this._definitions.set(definition.name, definition);
		}
	}

	/** True while a recomputation can make progress (it is not waiting for rows to be fetched). */
	public get busy(): boolean {
		for (const instance of this._instances) {
			if (instance.job !== null && instance.job.waiting !== instance.job.waiting) {
				return true;
			}
		}
		return false;
	}

	/**
	 * First main row a pending recomputation still has to read, or Infinity: rows from there on
	 * must not be let go under the memory limit (they would only be fetched again).
	 */
	public get readFrom(): number {
		let from = Infinity;
		for (const instance of this._instances) {
			const job = instance.job;
			if (job !== null) {
				const position = job.runner === null ? this._host.first() : job.runner.position;
				if (position < from) {
					from = position;
				}
			}
		}
		return from;
	}

	/** Number of instances with a recomputation pending. */
	public get pending(): number {
		let count = 0;
		for (const instance of this._instances) {
			if (instance.job !== null) {
				count++;
			}
		}
		return count;
	}

	public get byteLength(): number {
		let bytes = 0;
		for (const instance of this._instances) {
			bytes += (instance.store?.byteLength ?? 0) + instance.pyramid.byteLength + (instance.runner?.byteLength ?? 0);
			const job = instance.job;
			if (job !== null) {
				bytes += (job.store?.byteLength ?? 0) + (job.pyramid?.byteLength ?? 0) + (job.values?.byteLength ?? 0);
				bytes += job.runner?.byteLength ?? 0;
			}
		}
		return bytes;
	}

	/** True when `series` is an output of an indicator. */
	public owns(series: number): boolean {
		return this._byOutput.has(series);
	}

	/** Value columns of a derived series at a level. */
	public columns(level: number): number {
		return level === 0 ? 1 : 4;
	}

	// Commands

	/** Adds an instance, or changes the definition, parameters or inputs of one. */
	public set(
		id: number,
		name: string,
		params: readonly number[],
		inputs: IndicatorInputRef[],
		outputs: number[],
	): void {
		const definition = this._definitions.get(name);
		if (definition === undefined) {
			throw new Error(`Unknown indicator "${name}"`);
		}
		if (outputs.length !== definition.outputs.length || inputs.length !== definition.inputs.length) {
			throw new Error(
				`Indicator "${name}" takes ${definition.inputs.length} inputs and has ${definition.outputs.length} outputs`,
			);
		}
		const values: Record<string, number> = {};
		definition.params.forEach((param, i) => {
			values[param.name] = params[i] ?? param.default;
		});
		const resolved = resolveParams(definition.params, values);
		let instance = this._instances.find(entry => entry.id === id);
		if (instance === undefined) {
			const created: Instance = {
				id,
				definition,
				params: resolved,
				inputs: [],
				sources: [],
				outputs,
				store: null,
				pyramid: new Pyramid(aggregatesOf(outputs.length)),
				runner: null,
				job: null,
				changed: Infinity,
				read: (input, from, to, out, offset) => this._readInput(created, input, from, to, out, offset),
			};
			instance = created;
			this._instances.push(instance);
			outputs.forEach((series, index) => {
				this._byOutput.set(series, { instance: created, index });
			});
		} else if (instance.definition.outputs.length !== definition.outputs.length) {
			throw new Error('An indicator keeps its number of outputs');
		} else {
			instance.definition = definition;
			instance.params = resolved;
		}
		instance.inputs = inputs.map(input => ({ series: input.series, column: input.column }));
		this._link(instance);
		this._schedule(instance, Infinity);
	}

	public remove(id: number): void {
		const index = this._instances.findIndex(entry => entry.id === id);
		if (index < 0) {
			return;
		}
		const instance = this._instances[index]!;
		this._instances.splice(index, 1);
		for (const series of instance.outputs) {
			this._byOutput.delete(series);
		}
		this._fresh.delete(instance);
		// Readers of the removed outputs now read missing values.
		for (const other of this._instances) {
			if (other.sources.includes(instance)) {
				this._link(other);
				this._schedule(other, Infinity);
			}
		}
	}

	/** Rows were fetched again: recomputations waiting for them go on. */
	public rowsRestored(): void {
		for (const instance of this._instances) {
			if (instance.job !== null) {
				instance.job.waiting = NaN;
			}
		}
	}

	/**
	 * Rows `[from, to)` could not be fetched again. A recomputation waiting for them is given up:
	 * the values on screen stay, and the next change tries again.
	 */
	public rowsFailed(from: number, to: number): void {
		for (const instance of this._instances) {
			const waiting = instance.job?.waiting ?? NaN;
			if (waiting >= from && waiting < to) {
				instance.job = null;
			}
		}
	}

	// Changes of the data

	/** The main timeline changed (new main series or new data for it): every value is recomputed. */
	public timelineChanged(): void {
		for (const instance of this._instances) {
			// Indexes now mean other bars, so nothing old can be shown.
			instance.store = null;
			instance.runner = null;
			instance.pyramid.reset(0, 0);
			this._fresh.delete(instance);
			this._schedule(instance, Infinity);
		}
	}

	/** A series other than the main one got new data (or was removed): its readers recompute. */
	public seriesChanged(series: number): void {
		for (const instance of this._instances) {
			if (instance.inputs.some((input, i) => input.series === series && instance.sources[i] === null)) {
				this._schedule(instance, Infinity);
			}
		}
	}

	/**
	 * History was prepended to the main series in front of `oldFirst`. Cumulative indicators are
	 * recomputed in full; windowed ones from the new first row up to the first chunk boundary whose
	 * window lies entirely in rows they had before, so later values (the same bits) stay.
	 */
	public prepended(oldFirst: number): void {
		for (const instance of this._instances) {
			this._schedule(instance, this._extent(instance, oldFirst));
		}
	}

	/**
	 * Applies the rows changed by a tick batch (see `IndicatorHost.runs`) and adds the patch specs of
	 * every changed output to `specs` (series, level, start, count, columns). `endBefore` is the end of
	 * the main timeline before the batch.
	 */
	public ticks(endBefore: number, specs: number[]): void {
		const host = this._host;
		const end = host.end();
		for (const instance of this._instances) {
			instance.changed = Infinity;
			// New bars are new input rows for every instance.
			let from = end > endBefore ? endBefore : Infinity;
			const { inputs, sources } = instance;
			for (let i = 0; i < inputs.length; i++) {
				const source = sources[i];
				if (source === undefined || source === null) {
					const runs = host.runs(inputs[i]!.series);
					for (let r = 0; r < runs.length; r += 2) {
						if (runs[r]! < from) {
							from = runs[r]!;
						}
					}
				} else if (source.changed < from) {
					from = source.changed;
				}
			}
			if (from >= end) {
				continue;
			}
			const job = instance.job;
			const runner = instance.runner;
			if (job !== null && job.runner !== null && from < (job.to === Infinity ? job.runner.position : job.to)) {
				// Rows the job has computed changed under it.
				this._schedule(instance, Infinity);
				continue;
			}
			if (runner === null || instance.store === null) {
				continue;
			}
			if (from < runner.position) {
				// A correction of a committed row, recomputed here if it is recent and its rows are all held.
				const start = (from >> CHUNK_SHIFT) << CHUNK_SHIFT;
				if (job !== null || end - start > SYNC_ROWS || !host.ensure(start, end, start) || !runner.rewind(from)) {
					this._schedule(instance, Infinity);
					continue;
				}
			} else {
				from = Math.min(from, runner.position);
			}
			this._advance(runner, instance.store, end);
			instance.changed = from;
			this._ensureLevels(instance.pyramid, instance.store);
			this._refreshLevels(instance.pyramid, instance.store, from, end);
			this._specs(instance, from, end, specs);
		}
	}

	// Background work

	/**
	 * Runs one slice of the first recomputation whose inputs are settled. Returns true while more
	 * can be done now.
	 */
	public step(): boolean {
		for (const instance of this._instances) {
			const job = instance.job;
			if (
				job !== null &&
				job.waiting !== job.waiting &&
				!instance.sources.some(source => source !== null && source.job !== null)
			) {
				this._stepJob(instance, job);
				return this.busy;
			}
		}
		return false;
	}

	/**
	 * Specs of a notice after values were swapped in: the latest row of each swapped output, so the
	 * last-value label follows. Returns false when there is nothing to report.
	 */
	public takeNotice(specs: number[]): boolean {
		if (!this._swapped) {
			return false;
		}
		this._swapped = false;
		const end = this._host.end();
		for (const instance of this._fresh) {
			const store = instance.store;
			if (store !== null && store.end === end && end > store.first) {
				for (const series of instance.outputs) {
					specs.push(series, 0, end - 1, 1, 1);
				}
			}
		}
		this._fresh.clear();
		return true;
	}

	// Reading values

	/** Adds a block per derived series to a window of `level` over `[from, to)`, columns `stride` long. */
	public window(level: number, from: number, to: number, stride: number, blocks: SeriesBlock[]): void {
		const columns = this.columns(level);
		for (const instance of this._instances) {
			for (let index = 0; index < instance.outputs.length; index++) {
				const data = new Float64Array(stride * columns);
				this._copy(instance, index, level, from, to, data, stride);
				blocks.push({ series: instance.outputs[index]!, data });
			}
		}
	}

	/** Copies rows (or buckets) `[start, start + count)` of a derived series at `level` into `data`. */
	public copy(series: number, level: number, start: number, count: number, data: Float64Array): void {
		const entry = this._byOutput.get(series);
		if (entry === undefined) {
			data.fill(NaN);
			return;
		}
		this._copy(entry.instance, entry.index, level, start, start + count, data, count);
	}

	// Internals

	/** Resolves which instance each input reads. An input may only read an instance created earlier. */
	private _link(instance: Instance): void {
		const position = this._instances.indexOf(instance);
		instance.sources = instance.inputs.map(input => {
			const entry = this._byOutput.get(input.series);
			if (entry === undefined) {
				return null;
			}
			return this._instances.indexOf(entry.instance) < position ? entry.instance : null;
		});
	}

	/**
	 * Last row (exclusive) an instance recomputes after a prepend in front of `oldFirst`, or Infinity
	 * for everything: rows whose window reaches back past `oldFirst`, up to the next chunk boundary.
	 */
	private _extent(instance: Instance, oldFirst: number): number {
		if (instance.definition.windowed !== true || instance.runner === null) {
			return Infinity;
		}
		let changed = oldFirst;
		for (const source of instance.sources) {
			if (source !== null) {
				const to = source.job?.to ?? oldFirst;
				if (to > changed) {
					changed = to;
				}
			}
		}
		if (changed === Infinity) {
			return Infinity;
		}
		const to = chunkCeil(changed + instance.definition.lookback(instance.params));
		// Near the end of the data, recomputing everything is as cheap and keeps the tail simple.
		return to >= this._host.end() - CHUNK_ROWS ? Infinity : to;
	}

	/** Queues (or widens and restarts) a recomputation, and the ones of every instance reading this one. */
	private _schedule(instance: Instance, to: number): void {
		const job = instance.job;
		if (job === null) {
			instance.job = { to, runner: null, store: null, pyramid: null, values: null, waiting: NaN };
		} else {
			job.to = Math.max(job.to, to);
			job.runner = null;
			job.store = null;
			job.pyramid = null;
			job.values = null;
			job.waiting = NaN;
		}
		const extent = instance.job!.to;
		for (const reader of this._instances) {
			if (reader !== instance && reader.sources.includes(instance)) {
				const windowed = reader.definition.windowed === true && reader.runner !== null && extent !== Infinity;
				const lookback = windowed ? reader.definition.lookback(reader.params) : 0;
				this._schedule(reader, windowed ? chunkCeil(extent + lookback) : Infinity);
			}
		}
	}

	private _stepJob(instance: Instance, job: Job): void {
		const host = this._host;
		const first = host.first();
		const end = host.end();
		const outputs = instance.outputs.length;
		if (job.to !== Infinity && (instance.store === null || instance.runner === null || job.to >= end - CHUNK_ROWS)) {
			// Nothing to splice into, or the splice would reach the tail: recompute everything.
			job.to = Infinity;
			job.runner = null;
		}
		let runner = job.runner;
		if (runner === null) {
			runner = new Runner(instance.definition, instance.params, instance.read);
			runner.reset(first);
			job.runner = runner;
			if (job.to === Infinity) {
				const store = new ChunkedStore(outputs);
				store.clear(first);
				job.store = store;
				const pyramid = new Pyramid(aggregatesOf(outputs));
				pyramid.reset(levelCount(end - first), first);
				job.pyramid = pyramid;
				job.values = null;
			} else {
				job.values = new Float64Array((job.to - first) * outputs);
			}
		}
		if (!this._inputsHeld(instance, job, runner.position, job.to === Infinity ? end : job.to)) {
			return;
		}
		if (job.to === Infinity) {
			const store = job.store!;
			const pyramid = job.pyramid!;
			if (end <= first) {
				this._swap(instance, runner, store, pyramid);
				return;
			}
			const from = runner.position;
			if (from < end - 1) {
				runner.step(end - 1);
				this._put(runner, store, from, runner.position);
				this._refreshLevels(pyramid, store, from, runner.position);
				if (runner.position < end - 1) {
					return;
				}
			}
			runner.provisional();
			this._put(runner, store, end - 1, end);
			this._ensureLevels(pyramid, store);
			this._refreshLevels(pyramid, store, Math.min(from, end - 1), end);
			this._swap(instance, runner, store, pyramid);
			return;
		}
		const values = job.values!;
		const rows = job.to - first;
		const from = runner.position;
		const n = runner.step(job.to);
		for (let o = 0; o < outputs; o++) {
			const at = o * runner.stride + runner.lookback;
			values.set(runner.results.subarray(at, at + n), o * rows + from - first);
		}
		if (runner.position >= job.to) {
			this._splice(instance, runner, job.to, values, rows);
		}
	}

	/**
	 * Whether the main-series rows of a job's next slice are in memory. If not, they are asked for
	 * (with the rows ahead of them) and the job waits.
	 */
	private _inputsHeld(instance: Instance, job: Job, position: number, to: number): boolean {
		if (!instance.sources.includes(null)) {
			// Only other indicators' outputs, which are never let go.
			return true;
		}
		const end = Math.min(to, ((position >> CHUNK_SHIFT) + 1) << CHUNK_SHIFT);
		if (this._host.ensure(position, end, Math.min(to, position + FETCH_AHEAD))) {
			return true;
		}
		job.waiting = position;
		return false;
	}

	/** Brings a runner from its position to the end of the data, writing into the live store. */
	private _advance(runner: Runner, store: ChunkedStore, end: number): void {
		while (runner.position < end - 1) {
			const from = runner.position;
			runner.step(end - 1);
			this._put(runner, store, from, runner.position);
		}
		runner.provisional();
		this._put(runner, store, end - 1, end);
	}

	/** Writes the outputs of rows `[from, to)` from a runner's results into a store, appending past its end. */
	private _put(runner: Runner, store: ChunkedStore, from: number, to: number): void {
		const results = runner.results;
		const stride = runner.stride;
		const offset = runner.lookback;
		const inside = Math.min(to, store.end);
		if (inside > from) {
			store.write(results, stride, offset, offset + inside - from, from);
		}
		if (to > inside) {
			store.append(results, stride, offset + inside - from, offset + to - from);
		}
	}

	/** Swaps a completed full recomputation in. */
	private _swap(instance: Instance, runner: Runner, store: ChunkedStore, pyramid: Pyramid): void {
		instance.store = store;
		instance.pyramid = pyramid;
		instance.runner = runner;
		instance.job = null;
		this._swapped = true;
		this._fresh.add(instance);
	}

	/** Splices the rows `[first, to)` of a completed partial recomputation into the live values. */
	private _splice(instance: Instance, runner: Runner, to: number, values: Float64Array, rows: number): void {
		const store = instance.store!;
		const first = runner.first;
		const liveFirst = store.first;
		if (liveFirst > first) {
			store.prepend(values, rows, 0, liveFirst - first);
		}
		store.write(values, rows, liveFirst - first, rows, liveFirst);
		instance.runner!.adoptHead(runner, to);
		this._ensureLevels(instance.pyramid, store);
		this._refreshLevels(instance.pyramid, store, first, to);
		instance.job = null;
		this._swapped = true;
		this._fresh.add(instance);
	}

	private _readInput(
		instance: Instance,
		input: number,
		from: number,
		to: number,
		out: Float64Array,
		offset: number,
	): void {
		const ref = instance.inputs[input]!;
		const source = instance.sources[input];
		if (source === undefined || source === null) {
			if (this._byOutput.has(ref.series)) {
				// An output this instance may not read (created later, or removed).
				out.fill(NaN, offset, offset + to - from);
			} else {
				this._host.read(ref.series, ref.column, from, to, out, offset);
			}
			return;
		}
		const index = this._byOutput.get(ref.series)!.index;
		this._copyRows(source.store, index, from, to, out, offset);
	}

	/** Copies rows `[from, to)` of one column of a store into `out`, NaN outside the store's rows. */
	private _copyRows(
		store: ChunkedStore | null,
		column: number,
		from: number,
		to: number,
		out: Float64Array,
		offset: number,
	): void {
		if (store === null) {
			out.fill(NaN, offset, offset + to - from);
			return;
		}
		const lo = Math.min(Math.max(from, store.first), to);
		const hi = Math.max(lo, Math.min(to, store.end));
		if (lo > from) {
			out.fill(NaN, offset, offset + lo - from);
		}
		if (hi > lo) {
			store.copyColumn(column, lo, hi, out, offset + lo - from);
		}
		if (to > hi) {
			out.fill(NaN, offset + hi - from, offset + to - from);
		}
	}

	/** Copies output `index` at `level` over `[from, to)` into `data`, whose columns are `stride` long. */
	private _copy(
		instance: Instance,
		index: number,
		level: number,
		from: number,
		to: number,
		data: Float64Array,
		stride: number,
	): void {
		if (level === 0) {
			this._copyRows(instance.store, index, from, to, data, 0);
			return;
		}
		const store = instance.pyramid.levels[level - 1] ?? null;
		for (let c = 0; c < 4; c++) {
			this._copyRows(store, 4 * index + c, from, to, data, c * stride);
		}
	}

	/** Adds the patch specs of every output of an instance for rows `[from, end)`. */
	private _specs(instance: Instance, from: number, end: number, specs: number[]): void {
		const levels = instance.pyramid.levels.length;
		for (const series of instance.outputs) {
			specs.push(series, 0, from, end - from, 1);
			for (let level = 1; level <= levels; level++) {
				const shift = levelShift(level);
				const lo = from >> shift;
				specs.push(series, level, lo, ((end - 1) >> shift) + 1 - lo, 4);
			}
		}
	}

	/** Gives a pyramid the levels the main timeline needs, each built from the level below. */
	private _ensureLevels(pyramid: Pyramid, store: ChunkedStore): void {
		const wanted = levelCount(this._host.end() - this._host.first());
		while (pyramid.levels.length < wanted) {
			pyramid.addLevel(store.first);
			if (store.length > 0) {
				this._refreshLevel(pyramid, store, pyramid.levels.length, store.first, store.end);
			}
		}
	}

	/** Rebuilds, at every level from the finest up, the buckets holding rows `[lo, hi)` of a store. */
	private _refreshLevels(pyramid: Pyramid, store: ChunkedStore, lo: number, hi: number): void {
		const from = Math.max(lo, store.first);
		const to = Math.min(hi, store.end);
		if (to <= from) {
			return;
		}
		for (let level = 1; level <= pyramid.levels.length; level++) {
			this._refreshLevel(pyramid, store, level, from, to);
		}
	}

	/** Recomputes the buckets of one level that hold rows `[lo, hi)`, from all of their members. */
	private _refreshLevel(pyramid: Pyramid, store: ChunkedStore, level: number, lo: number, hi: number): void {
		const shift = levelShift(level);
		const bucketFrom = lo >> shift;
		const bucketTo = ((hi - 1) >> shift) + 1;
		const buckets = bucketTo - bucketFrom;
		const columns = pyramid.columnCount;
		if (this._block.length < buckets * columns) {
			this._block = new Float64Array(Math.max(buckets * columns, this._block.length * 2, 256));
		}
		const block = this._block;
		const sources = this._sourcesScratch;
		const bases = this._bases;
		const aggregates = pyramid.aggregates;
		// Rows at the finest level, buckets of the level below above it; each source chunk at a time.
		const child = level === 1 ? store : pyramid.levels[level - 2]!;
		const g = level === 1 ? shift : 2;
		const end = Math.min(level === 1 ? bucketTo << shift : bucketTo << 2, child.end);
		let i = Math.max(level === 1 ? bucketFrom << shift : bucketFrom << 2, child.first);
		let at = 0;
		while (i < end) {
			const chunk = child.chunkAt(i);
			const row = i & child.mask;
			const n = Math.min(child.rows - row, end - i);
			if (level === 1) {
				// Every output feeds its four aggregates, in one pass over its rows.
				let written = 0;
				for (let o = 0; o < chunk.columns.length; o++) {
					written = lineBuckets(chunk.columns[o]!, i - row, i, i + n, shift, block, buckets, 4 * o * buckets + at);
				}
				at += written;
				i += n;
				continue;
			}
			for (let c = 0; c < columns; c++) {
				sources[c] = chunk.columns[c]!;
				bases[c] = i - row;
			}
			at += aggregate(sources, bases, i, i + n, g, aggregates, block, buckets, at);
			i += n;
		}
		storeBuckets(pyramid.levels[level - 1]!, block, buckets, bucketFrom, bucketTo);
	}
}
