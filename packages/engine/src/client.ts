import { type EngineTransport, LocalTransport } from './host';
import { connectWorker } from './pool';
import { type Command, type EngineEvent, type IndicatorInputRef, type SeriesKind, TICK_STRIDE } from './protocol';

export interface EngineOptions {
	/**
	 * Where the engine runs. `true` (default) uses a worker and falls back to the calling thread if
	 * the page blocks workers; `false` always uses the calling thread; a function supplies the worker,
	 * for bundlers that need the worker created in application code.
	 *
	 * Workers are shared: engines with the same setting run in at most `getMaxWorkers()` workers (see
	 * `setMaxWorkers`), each engine with a state of its own. Engines given the same function share
	 * the workers it makes, and it is called once per worker; pass a function of its own to give an
	 * engine a worker of its own.
	 */
	worker?: boolean | (() => Worker);
	/**
	 * How long to wait for the worker to start before falling back, in milliseconds (default 4000).
	 * The wait starts with the worker, so an engine that joins a worker still starting waits for
	 * what is left of the first engine's timeout.
	 */
	workerTimeout?: number;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type CommandBody = DistributiveOmit<Command, 'seq'>;

interface Held {
	command: Command;
	transfer: ArrayBuffer[];
}

const NO_TRANSFER: ArrayBuffer[] = [];

function defaultWorker(): Worker {
	return new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
}

/**
 * Asynchronous interface to the data engine. Calling code is the same whether the engine runs in a
 * worker or time-sliced on the calling thread.
 */
export class EngineClient {
	/** Receives one event per command, in command order, and notices of background work in between. */
	public onevent: ((event: EngineEvent) => void) | null = null;
	private _transport: EngineTransport | null = null;
	/** Commands issued before the transport is known. Buffers are transferred only once it is. */
	private _held: Held[] = [];
	private _seq = 0;
	private _acked = 0;
	/** `seq` of the last command that changes data. */
	private _dataSeq = 0;
	private _nextSeries = 1;
	private _ticks = new Float64Array(TICK_STRIDE * 256);
	private _tickCount = 0;
	private _flushQueued = false;
	private _destroyed = false;
	private _idle: (() => void)[] = [];
	private _mode: 'connecting' | 'worker' | 'local' = 'connecting';
	/** Gives back the engine's place on a worker that has not answered yet. */
	private _abortConnect: (() => void) | null = null;

	public constructor(options: EngineOptions = {}) {
		const worker = options.worker ?? true;
		if (worker === false || typeof Worker === 'undefined') {
			this._attach(new LocalTransport(), 'local');
		} else {
			const release = connectWorker(
				worker === true ? defaultWorker : worker,
				options.workerTimeout ?? 4000,
				transport => {
					this._abortConnect = null;
					this._attach(transport, 'worker');
				},
				() => {
					this._abortConnect = null;
					this._attach(new LocalTransport(), 'local');
				},
			);
			if (release === null) {
				// Creating the worker threw: the page does not allow workers.
				this._attach(new LocalTransport(), 'local');
			} else if (this._transport === null) {
				this._abortConnect = release;
			}
		}
	}

	/** `connecting` until the worker has answered or failed. */
	public get mode(): 'connecting' | 'worker' | 'local' {
		return this._mode;
	}

	/** Number of commands (including a batch of buffered ticks) the engine has not answered yet. */
	public get pending(): number {
		return this._seq - this._acked + (this._tickCount > 0 ? 1 : 0);
	}

	/**
	 * Whether data handed over so far (series, histories, ticks) still has to be applied. Window
	 * requests do not count: they only read.
	 */
	public get dataPending(): boolean {
		return this._tickCount > 0 || this._acked < this._dataSeq;
	}

	/**
	 * Sends buffered ticks and returns the `seq` of the last command that changes data. Once an event
	 * with this `ack` arrives, all data handed over up to now has been applied.
	 */
	public barrier(): number {
		this._flushTicks();
		return this._dataSeq;
	}

	/**
	 * Adds a series. A `fetchable` series can have its rows fetched again (it has a datafeed), so
	 * under a memory limit the engine may let rows of it go and ask for them with `fetch` requests.
	 */
	public addSeries(kind: SeriesKind, fetchable = false): number {
		const series = this._nextSeries++;
		this._send({ type: 'add', series, kind, fetchable }, NO_TRANSFER);
		return series;
	}

	/** Sets the memory the engine aims to stay under, in bytes (`Infinity` for no limit). */
	public setMemoryLimit(bytes: number): void {
		this._send({ type: 'limit', bytes }, NO_TRANSFER);
	}

	/**
	 * Hands back the rows of the `FetchRequest` with id `request` (column-major, time first, taken
	 * over like `setData`), or null when fetching them failed.
	 */
	public restoreRows(request: number, data: Float64Array | null, count: number): void {
		this._send({ type: 'rows', request, count, data }, data === null ? NO_TRANSFER : [data.buffer as ArrayBuffer]);
	}

	public removeSeries(series: number): void {
		this._send({ type: 'remove', series }, NO_TRANSFER);
	}

	/**
	 * Adds an indicator instance of the definition `name`. Its outputs become derived series on the
	 * main timeline, with the ids returned. `params` follow the definition's order. Values arrive once
	 * computed in the background, announced by an event with `stale`.
	 */
	public addIndicator(
		name: string,
		params: number[],
		inputs: IndicatorInputRef[],
		outputCount: number,
	): { id: number; outputs: number[] } {
		const id = this._nextSeries++;
		const outputs: number[] = [];
		for (let i = 0; i < outputCount; i++) {
			outputs.push(this._nextSeries++);
		}
		this._send({ type: 'indicator', id, name, params, inputs, outputs }, NO_TRANSFER);
		return { id, outputs };
	}

	/** Changes the definition, parameters or inputs of an indicator; its outputs keep their ids. */
	public updateIndicator(
		id: number,
		name: string,
		params: number[],
		inputs: IndicatorInputRef[],
		outputs: number[],
	): void {
		this._send({ type: 'indicator', id, name, params, inputs, outputs }, NO_TRANSFER);
	}

	public removeIndicator(id: number): void {
		this._send({ type: 'removeIndicator', id }, NO_TRANSFER);
	}

	/**
	 * Has the engine import a module of indicator definitions from `url`, in the worker or on this
	 * thread. The outcome comes with a later event's `plugins`.
	 */
	public loadPlugin(url: string): void {
		this._send({ type: 'plugin', url }, NO_TRANSFER);
	}

	/**
	 * Replaces the data of a series. `data` is column-major with time first and is handed over to
	 * the engine: do not use it afterwards. `fetchable` changes whether rows of the series can be
	 * fetched again (see `addSeries`); it stays as it was when omitted. Returns the command's `seq`.
	 */
	public setData(series: number, data: Float64Array, count: number, fetchable?: boolean): number {
		return this._send(
			fetchable === undefined ? { type: 'set', series, count, data } : { type: 'set', series, count, data, fetchable },
			[data.buffer as ArrayBuffer],
		);
	}

	/** Removes the bars of a series with times in `[from, to]` (UTC milliseconds, inclusive). */
	public deleteBars(series: number, from: number, to: number): void {
		this._send({ type: 'delete', series, from, to }, NO_TRANSFER);
	}

	/** Adds older history before the first bar. Takes ownership of `data` like `setData`. */
	public prepend(series: number, data: Float64Array, count: number): void {
		this._send({ type: 'prepend', series, count, data }, [data.buffer as ArrayBuffer]);
	}

	/**
	 * Updates the bar at `time` or appends a new one. For a line series pass the value as `a`.
	 * Ticks issued in the same task travel to the engine as one message.
	 */
	public tick(series: number, time: number, a: number, b = NaN, c = NaN, d = NaN, e = NaN): void {
		if (this._destroyed) {
			return;
		}
		let ticks = this._ticks;
		let offset = this._tickCount * TICK_STRIDE;
		if (offset === ticks.length) {
			ticks = new Float64Array(ticks.length * 2);
			ticks.set(this._ticks);
			this._ticks = ticks;
		}
		ticks[offset++] = series;
		ticks[offset++] = time;
		ticks[offset++] = a;
		ticks[offset++] = b;
		ticks[offset++] = c;
		ticks[offset++] = d;
		ticks[offset] = e;
		this._tickCount++;
		if (!this._flushQueued) {
			this._flushQueued = true;
			queueMicrotask(this._flushTicks);
		}
	}

	/**
	 * Asks for a snapshot of main-timeline rows `[start, start + count)` in buffers of `capacity`
	 * rows. At a coarse `level`, the range and the capacity count buckets of that level instead.
	 * Returns the command's `seq`, which the snapshot carries as `request`.
	 */
	public requestWindow(start: number, count: number, capacity: number, level = 0): number {
		return this._send({ type: 'window', level, start, count, capacity }, NO_TRANSFER);
	}

	/** Resolves once every command issued so far has been answered. */
	public whenIdle(): Promise<void> {
		if (this.pending === 0) {
			return Promise.resolve();
		}
		return new Promise(resolve => {
			this._idle.push(resolve);
		});
	}

	public destroy(): void {
		if (this._destroyed) {
			return;
		}
		this._destroyed = true;
		this.onevent = null;
		this._held = [];
		this._tickCount = 0;
		this._abortConnect?.();
		this._abortConnect = null;
		this._transport?.close();
		this._transport = null;
		this._acked = this._seq;
		this._resolveIdle();
	}

	private readonly _flushTicks = (): void => {
		this._flushQueued = false;
		const count = this._tickCount;
		if (count === 0 || this._destroyed) {
			return;
		}
		this._tickCount = 0;
		const data = this._ticks.slice(0, count * TICK_STRIDE);
		const seq = ++this._seq;
		this._dataSeq = seq;
		this._post({ type: 'ticks', seq, count, data }, [data.buffer]);
	};

	private _send(body: CommandBody, transfer: ArrayBuffer[]): number {
		if (this._destroyed) {
			return -1;
		}
		// Buffered ticks were issued first, so they go first.
		this._flushTicks();
		const seq = ++this._seq;
		// Windows, limits and fetched rows change nothing a later call could depend on.
		if (body.type !== 'window' && body.type !== 'limit' && body.type !== 'rows') {
			this._dataSeq = seq;
		}
		this._post({ ...body, seq } as Command, transfer);
		return seq;
	}

	private _post(command: Command, transfer: ArrayBuffer[]): void {
		if (this._transport === null) {
			this._held.push({ command, transfer });
		} else {
			this._transport.post(command, transfer);
		}
	}

	private _attach(transport: EngineTransport, mode: 'worker' | 'local'): void {
		if (this._destroyed) {
			transport.close();
			return;
		}
		this._mode = mode;
		this._transport = transport;
		transport.onevent = this._receive;
		const held = this._held;
		this._held = [];
		for (const { command, transfer } of held) {
			transport.post(command, transfer);
		}
	}

	private readonly _receive = (event: EngineEvent): void => {
		this._acked = event.ack;
		this.onevent?.(event);
		if (this.pending === 0) {
			this._resolveIdle();
		}
	};

	private _resolveIdle(): void {
		if (this._idle.length === 0) {
			return;
		}
		const waiters = this._idle;
		this._idle = [];
		for (const resolve of waiters) {
			resolve();
		}
	}
}

export function createEngine(options?: EngineOptions): EngineClient {
	return new EngineClient(options);
}
