import { type EngineTransport, LocalTransport, WorkerTransport } from './host';
import { type Command, type EngineEvent, type ReadyMessage, type SeriesKind, TICK_STRIDE } from './protocol';

export interface EngineOptions {
	/**
	 * Where the engine runs. `true` (default) starts a worker and falls back to the calling thread if
	 * the page blocks workers; `false` always uses the calling thread; a function supplies the worker,
	 * for bundlers that need the worker created in application code.
	 */
	worker?: boolean | (() => Worker);
	/** How long to wait for the worker to start before falling back, in milliseconds. */
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
	/** Receives one event per command, in command order. */
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
	/** Stops a worker that has not answered yet. */
	private _abortConnect: (() => void) | null = null;

	public constructor(options: EngineOptions = {}) {
		const worker = options.worker ?? true;
		if (worker === false || typeof Worker === 'undefined') {
			this._attach(new LocalTransport(), 'local');
		} else {
			this._connect(worker === true ? defaultWorker : worker, options.workerTimeout ?? 4000);
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

	public addSeries(kind: SeriesKind): number {
		const series = this._nextSeries++;
		this._send({ type: 'add', series, kind }, NO_TRANSFER);
		return series;
	}

	public removeSeries(series: number): void {
		this._send({ type: 'remove', series }, NO_TRANSFER);
	}

	/**
	 * Replaces the data of a series. `data` is column-major with time first and is handed over to
	 * the engine: do not use it afterwards.
	 */
	public setData(series: number, data: Float64Array, count: number): void {
		this._send({ type: 'set', series, count, data }, [data.buffer as ArrayBuffer]);
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

	/** Asks for a snapshot of main-timeline rows `[start, start + count)` in buffers of `capacity` rows. */
	public requestWindow(start: number, count: number, capacity: number): void {
		this._send({ type: 'window', start, count, capacity }, NO_TRANSFER);
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

	private _send(body: CommandBody, transfer: ArrayBuffer[]): void {
		if (this._destroyed) {
			return;
		}
		// Buffered ticks were issued first, so they go first.
		this._flushTicks();
		const seq = ++this._seq;
		if (body.type !== 'window') {
			this._dataSeq = seq;
		}
		this._post({ ...body, seq } as Command, transfer);
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

	/**
	 * Starts the worker and waits for its ready message. A page whose content security policy blocks
	 * workers reports that either by throwing or by an asynchronous error event, so nothing is sent
	 * (and no buffer is given away) until the worker has answered.
	 */
	private _connect(factory: () => Worker, timeout: number): void {
		let worker: Worker;
		try {
			worker = factory();
		} catch {
			this._attach(new LocalTransport(), 'local');
			return;
		}
		let settled = false;
		const settle = (): boolean => {
			if (settled) {
				return false;
			}
			settled = true;
			this._abortConnect = null;
			clearTimeout(timer);
			worker.removeEventListener('error', fallBack);
			worker.removeEventListener('message', onReady);
			return true;
		};
		this._abortConnect = (): void => {
			if (settle()) {
				worker.terminate();
			}
		};
		const fallBack = (): void => {
			if (settle()) {
				worker.terminate();
				this._attach(new LocalTransport(), 'local');
			}
		};
		const onReady = (message: MessageEvent<ReadyMessage>): void => {
			if (message.data.ready === true && settle()) {
				this._attach(new WorkerTransport(worker), 'worker');
			}
		};
		const timer = setTimeout(fallBack, timeout);
		worker.addEventListener('error', fallBack);
		worker.addEventListener('message', onReady);
	}
}

export function createEngine(options?: EngineOptions): EngineClient {
	return new EngineClient(options);
}
