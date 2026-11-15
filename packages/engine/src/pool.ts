import type { EngineTransport } from './host';
import type { Command, EngineEvent, HostMessage, ReadyMessage } from './protocol';

/**
 * Workers shared by the engines of a page.
 *
 * A worker per engine costs a thread, a copy of the engine code and a heap for every chart. Here
 * engines created with the same worker factory share a few workers instead: the first engines get a
 * worker each, up to the limit, and every further engine joins the worker that serves the fewest.
 * Up to the limit nothing changes for a page, since each chart still has a thread of its own; past
 * it the number of threads stays put. A worker stops when its last engine is destroyed.
 */

const NO_TRANSFER: Transferable[] = [];

/** Most workers started per factory unless `setMaxWorkers` says otherwise. */
const DEFAULT_MAX_WORKERS = 4;

let maxWorkers: number | null = null;

/** A worker and the engines it serves. */
interface PooledWorker {
	readonly worker: Worker;
	readonly factory: () => Worker;
	/** The workers of the same factory, this one included while it runs. */
	readonly siblings: PooledWorker[];
	readonly channels: Map<number, WorkerChannel>;
	nextId: number;
	/** Whether the worker has answered; until then nothing is sent to it. */
	ready: boolean;
	/** Stops waiting for the worker's first answer. */
	settle: () => boolean;
}

const pools = new Map<() => Worker, PooledWorker[]>();

/**
 * The most workers that engines created with the same `worker` setting share. The default is 4, or
 * one less than the number of processor cores where that is smaller, and at least 1.
 */
export function getMaxWorkers(): number {
	if (maxWorkers !== null) {
		return maxWorkers;
	}
	const cores = typeof navigator === 'undefined' ? undefined : navigator.hardwareConcurrency;
	return Math.max(1, Math.min(DEFAULT_MAX_WORKERS, (cores ?? DEFAULT_MAX_WORKERS + 1) - 1));
}

/**
 * Sets the most workers that engines created with the same `worker` setting share, for the whole
 * page. It applies to engines created from now on: engines that run keep their worker. 1 puts every
 * chart on one thread; `Infinity` gives every chart a worker of its own.
 */
export function setMaxWorkers(count: number): void {
	if (!(count >= 1)) {
		throw new RangeError(`setMaxWorkers expects a number of at least 1, got ${count}`);
	}
	maxWorkers = Math.floor(count);
}

/** One engine's share of a pooled worker: commands go out tagged with its id, events come back by it. */
class WorkerChannel implements EngineTransport {
	public onevent: ((event: EngineEvent) => void) | null = null;
	public readonly onReady: (transport: EngineTransport) => void;
	public readonly onFailed: () => void;
	private readonly _pooled: PooledWorker;
	private readonly _id: number;
	private _closed = false;

	public constructor(
		pooled: PooledWorker,
		id: number,
		onReady: (transport: EngineTransport) => void,
		onFailed: () => void,
	) {
		this._pooled = pooled;
		this._id = id;
		this.onReady = onReady;
		this.onFailed = onFailed;
	}

	public post(command: Command, transfer: ArrayBuffer[]): void {
		if (this._closed) {
			return;
		}
		(command as HostMessage).engine = this._id;
		this._pooled.worker.postMessage(command, transfer);
	}

	/** Lets the engine go. The worker stops with its last engine. */
	public close(): void {
		if (this._closed) {
			return;
		}
		this._closed = true;
		this.onevent = null;
		const pooled = this._pooled;
		if (!pooled.channels.delete(this._id)) {
			// The worker failed to start and is gone already.
			return;
		}
		if (pooled.channels.size === 0) {
			pooled.settle();
			retire(pooled);
		} else if (pooled.ready) {
			const message: HostMessage = { type: 'close', engine: this._id };
			pooled.worker.postMessage(message, NO_TRANSFER);
		}
	}
}

function retire(pooled: PooledWorker): void {
	const index = pooled.siblings.indexOf(pooled);
	if (index >= 0) {
		pooled.siblings.splice(index, 1);
	}
	// Nothing is kept for a factory without workers, or every factory ever used would stay reachable.
	if (pooled.siblings.length === 0 && pools.get(pooled.factory) === pooled.siblings) {
		pools.delete(pooled.factory);
	}
	pooled.worker.terminate();
}

/**
 * Starts a worker and waits for its ready message. A page whose content security policy blocks
 * workers reports that either by throwing (which the caller sees) or by an asynchronous error
 * event, so nothing is sent, and no buffer is given away, until the worker has answered.
 */
function start(factory: () => Worker, timeout: number, siblings: PooledWorker[]): PooledWorker {
	const worker = factory();
	let settled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const pooled: PooledWorker = {
		worker,
		factory,
		siblings,
		channels: new Map(),
		nextId: 0,
		ready: false,
		settle: () => {
			if (settled) {
				return false;
			}
			settled = true;
			clearTimeout(timer);
			worker.removeEventListener('error', fail);
			worker.removeEventListener('message', onReady);
			return true;
		},
	};
	const fail = (): void => {
		if (!pooled.settle()) {
			return;
		}
		retire(pooled);
		// Every engine that waited for this worker falls back by itself.
		const channels = Array.from(pooled.channels.values());
		pooled.channels.clear();
		for (const channel of channels) {
			channel.onFailed();
		}
	};
	const onReady = (message: MessageEvent<ReadyMessage>): void => {
		if (message.data.ready !== true || !pooled.settle()) {
			return;
		}
		pooled.ready = true;
		worker.addEventListener('message', (event: MessageEvent<EngineEvent>) => {
			pooled.channels.get(event.data.engine ?? 0)?.onevent?.(event.data);
		});
		// An engine may leave or join while the others are told; the map takes both.
		for (const channel of Array.from(pooled.channels.values())) {
			channel.onReady(channel);
		}
	};
	timer = setTimeout(fail, timeout);
	worker.addEventListener('error', fail);
	worker.addEventListener('message', onReady);
	siblings.push(pooled);
	return pooled;
}

/**
 * Gives an engine a place on a worker made by `factory`: a new worker while fewer than the limit
 * run for this factory, else the one that serves the fewest engines.
 *
 * `onReady` receives the engine's transport once the worker has answered, which is during this
 * call if it already has. `onFailed` is called instead if the worker fails to start or does not
 * answer within `timeout` milliseconds, counted from when the worker was started.
 *
 * Returns a function that gives the place back, or null if the worker could not be created.
 */
export function connectWorker(
	factory: () => Worker,
	timeout: number,
	onReady: (transport: EngineTransport) => void,
	onFailed: () => void,
): (() => void) | null {
	let siblings = pools.get(factory);
	if (siblings === undefined) {
		siblings = [];
		pools.set(factory, siblings);
	}
	let pooled: PooledWorker | undefined;
	if (siblings.length < getMaxWorkers()) {
		try {
			pooled = start(factory, timeout, siblings);
		} catch {
			if (siblings.length === 0) {
				pools.delete(factory);
			}
			return null;
		}
	} else {
		for (const candidate of siblings) {
			if (pooled === undefined || candidate.channels.size < pooled.channels.size) {
				pooled = candidate;
			}
		}
	}
	const id = pooled!.nextId++;
	const channel = new WorkerChannel(pooled!, id, onReady, onFailed);
	pooled!.channels.set(id, channel);
	if (pooled!.ready) {
		onReady(channel);
	}
	return () => channel.close();
}
