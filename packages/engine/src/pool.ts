import { type EngineTransport, workerFailure } from './host';
import type { Command, EngineEvent, HostMessage, ReadyMessage } from './protocol';

/**
 * Workers shared by the engines of a page.
 *
 * A worker per engine costs a thread, a copy of the engine code and a heap for every chart. Here
 * engines created with the same worker source share a few workers instead: the first engines get a
 * worker each, up to the limit, and every further engine joins the worker that serves the fewest.
 * Up to the limit nothing changes for a page, since each chart still has a thread of its own; past
 * it the number of threads stays put. A worker stops when its last engine is destroyed.
 *
 * A worker that fails after it started (an error it does not handle, or a message from it that
 * cannot be read) is stopped, and every engine on it is lost (see `EngineTransport.onlost`): a
 * command may never be answered, and what the engines held cannot be trusted any more.
 */

/** A Worker constructor, such as a Vite `?worker` import (`new () => Worker`). */
export type WorkerConstructor = new () => Worker;

/** A factory returning a dedicated Worker instance. */
export type WorkerFactory = () => Worker;

/**
 * Tells the engine how to start a worker:
 * - `string` or `URL`: module URL of the worker entry, started with `{ type: 'module' }`. Normalized
 *   by absolute `href`, so callers passing the same URL share one worker pool automatically.
 * - `WorkerConstructor`: a bundler worker class (e.g. `import ChartWorker from '@lumen-ticks/core/worker?worker'`),
 *   invoked with `new`.
 * - `WorkerFactory`: a function returning a `Worker` instance.
 */
export type WorkerSource = string | URL | WorkerConstructor | WorkerFactory;

/** Options for `createWorkerPool`. */
export interface WorkerPoolOptions {
	/**
	 * Worker source for this pool. Defaults to the configured global worker source (see
	 * `configureWorker`), or the built-in worker if none was configured.
	 */
	worker?: WorkerSource;
	/**
	 * Maximum number of workers this pool starts (`1` shares one thread, `Infinity` gives each chart
	 * its own). When omitted, follows `getMaxWorkers()`.
	 */
	maxWorkers?: number;
	/**
	 * Milliseconds to wait for a worker's ready message before falling back to the calling thread.
	 * Defaults to the timeout set by `configureWorker` (4000 ms).
	 */
	timeout?: number;
}

/**
 * Explicit handle to a bounded pool of shared engine workers. Pass to `createChart(container, { worker: pool })`,
 * `createEngine({ worker: pool })`, or `configureWorker(pool)`.
 */
export interface WorkerPool {
	/** Maximum number of workers this pool will start. */
	readonly maxWorkers: number;
	/** Number of workers currently running or starting in this pool. */
	readonly activeWorkers: number;
	/** Number of engines currently attached to workers of this pool. */
	readonly engines: number;
	/**
	 * Pre-starts up to `count` (default `1`, capped at `maxWorkers`) workers so the first charts
	 * attach without waiting for worker startup. Safe no-op when `Worker` is unavailable, blocked,
	 * or the pool has been destroyed.
	 */
	warmup(count?: number): void;
	/**
	 * Stops all workers in this pool and prevents future warmups or attachments. Engines attached
	 * while still starting fall back to the calling thread; running engines receive `onlost`.
	 */
	destroy(): void;
}

/** Global default worker settings configured via `configureWorker`. */
export interface WorkerConfig {
	/**
	 * Default worker setting used when a chart or engine does not pass `worker`.
	 * - `true` (default): built-in module worker with automatic main-thread fallback.
	 * - `false`: always run time-sliced on the calling thread.
	 * - `WorkerSource`: URL string, `URL`, bundler worker constructor, or factory function.
	 * - `WorkerPool`: explicit shared pool used by default.
	 */
	source?: boolean | WorkerSource | WorkerPool;
	/**
	 * Maximum workers shared per pool unless a pool sets its own `maxWorkers`.
	 * Same as `setMaxWorkers(count)`.
	 */
	maxWorkers?: number;
	/**
	 * Default milliseconds to wait for a worker's ready message before falling back to the calling
	 * thread (default 4000).
	 */
	timeout?: number;
}

/**
 * Where a chart or engine runs:
 * - `true`: use the default worker (configured via `configureWorker`, or the built-in worker).
 * - `false`: always run time-sliced on the calling thread.
 * - `'dedicated'`: start an unshared worker for this engine alone, using the configured default
 *   worker source (or the built-in worker).
 * - `WorkerSource`: URL string, `URL`, bundler worker constructor, or factory function (pooled by source).
 * - `WorkerPool`: attach to an explicit pool created with `createWorkerPool`.
 */
export type WorkerOption = boolean | 'dedicated' | WorkerSource | WorkerPool;

type PoolKey = string | WorkerConstructor | WorkerFactory;

const NO_TRANSFER: Transferable[] = [];

/** Most workers started per pool unless `setMaxWorkers` or `createWorkerPool` says otherwise. */
const DEFAULT_MAX_WORKERS = 4;
/** Default milliseconds to wait for a worker's ready message before falling back. */
const DEFAULT_WORKER_TIMEOUT = 4000;

let maxWorkers: number | null = null;
let defaultTimeout = DEFAULT_WORKER_TIMEOUT;
let defaultSource: boolean | WorkerSource | ManagedWorkerPool = true;

function defaultWorker(): Worker {
	return new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
}

function checkMaxWorkers(count: number, caller: string): number {
	if (!(count >= 1)) {
		throw new RangeError(`${caller} expects a number of at least 1, got ${count}`);
	}
	return Math.floor(count);
}

function checkTimeout(ms: number, caller: string): number {
	if (!Number.isFinite(ms) || !(ms > 0)) {
		throw new RangeError(`${caller} expects a finite positive timeout in milliseconds, got ${ms}`);
	}
	return ms;
}

function checkSourceString(value: string, caller: string): void {
	if (value.trim() === '') {
		throw new RangeError(`${caller} expects a non-empty worker URL`);
	}
}

/** Resolves a URL string against the current document/location so relative and absolute forms share a key. */
function resolveUrl(input: string): string {
	const base =
		typeof document !== 'undefined' && document.baseURI !== ''
			? document.baseURI
			: typeof location !== 'undefined' && location.href !== ''
				? location.href
				: undefined;
	if (base === undefined) {
		return input;
	}
	try {
		return new URL(input, base).href;
	} catch {
		return input;
	}
}

/** Calls a worker factory or constructs a bundler worker class (e.g. Vite `?worker`). */
function instantiateWorker(source: WorkerConstructor | WorkerFactory): Worker {
	const descriptor = Object.getOwnPropertyDescriptor(source, 'prototype');
	// ES6 classes (including Vite `?worker` imports) have a non-writable `prototype`.
	if (descriptor !== undefined && descriptor.writable === false) {
		return new (source as WorkerConstructor)();
	}
	try {
		return (source as WorkerFactory)();
	} catch (error) {
		// Transpiled class constructors (writable prototype) throw TypeError when called without `new`.
		if (error instanceof TypeError && descriptor !== undefined) {
			return new (source as WorkerConstructor)();
		}
		throw error;
	}
}

/** Turns a `WorkerSource` into a stable pool key and a zero-arg spawner. */
function normalizeSource(source: WorkerSource): { key: PoolKey; create: () => Worker } {
	if (typeof source === 'string') {
		const href = resolveUrl(source);
		return {
			key: href,
			create: () => new Worker(href, { type: 'module' }),
		};
	}
	if (source instanceof URL) {
		const href = source.href;
		return {
			key: href,
			create: () => new Worker(href, { type: 'module' }),
		};
	}
	return {
		key: source,
		create: () => instantiateWorker(source),
	};
}

/** A worker and the engines it serves. */
interface PooledWorker {
	readonly worker: Worker;
	readonly owner: ManagedWorkerPool;
	readonly channels: Map<number, WorkerChannel>;
	nextId: number;
	/** Whether the worker has answered; until then nothing is sent to it. */
	ready: boolean;
	/** True while the worker was pre-started by `warmup()` and has not served an engine yet. */
	warmed: boolean;
	/** Stops waiting for the worker's first answer. */
	settle: () => boolean;
}

/** One engine's share of a pooled worker: commands go out tagged with its id, events come back by it. */
class WorkerChannel implements EngineTransport {
	public onevent: ((event: EngineEvent) => void) | null = null;
	public onlost: ((message: string, cause: unknown) => void) | null = null;
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

	/** The worker failed: nothing more comes for this engine, and nothing more is sent. */
	public lose(message: string, cause: unknown): void {
		if (this._closed) {
			return;
		}
		this._closed = true;
		const lost = this.onlost;
		this.onevent = null;
		this.onlost = null;
		lost?.(message, cause);
	}

	/** Lets the engine go. The worker stops with its last engine. */
	public close(): void {
		if (this._closed) {
			return;
		}
		this._closed = true;
		this.onevent = null;
		this.onlost = null;
		const pooled = this._pooled;
		if (!pooled.channels.delete(this._id)) {
			// The worker failed to start or the pool was destroyed already.
			return;
		}
		if (pooled.channels.size === 0 && !pooled.warmed) {
			pooled.settle();
			pooled.owner.retire(pooled);
		} else if (pooled.ready) {
			const message: HostMessage = { type: 'close', engine: this._id };
			pooled.worker.postMessage(message, NO_TRANSFER);
		}
	}
}

class ManagedWorkerPool implements WorkerPool {
	private readonly _source: WorkerSource | null;
	private readonly _maxWorkers: number | null;
	private readonly _timeout: number | null;
	private readonly _workers: PooledWorker[] = [];
	private readonly _onEmpty: (() => void) | null;
	private _destroyed = false;

	public constructor(
		source: WorkerSource | null,
		limit: number | null,
		timeout: number | null,
		onEmpty: (() => void) | null,
	) {
		this._source = source;
		this._maxWorkers = limit;
		this._timeout = timeout;
		this._onEmpty = onEmpty;
	}

	public get maxWorkers(): number {
		return this._maxWorkers ?? getMaxWorkers();
	}

	public get activeWorkers(): number {
		return this._workers.length;
	}

	public get engines(): number {
		let total = 0;
		for (const pooled of this._workers) {
			total += pooled.channels.size;
		}
		return total;
	}

	/** Underlying source of this pool, used when deriving a dedicated worker from a configured pool. */
	public source(): WorkerSource {
		return this._source ?? resolveDefaultSource();
	}

	public warmup(count = 1): void {
		const requested = checkMaxWorkers(count, 'WorkerPool.warmup');
		if (this._destroyed || typeof Worker === 'undefined') {
			return;
		}
		const target = Math.min(requested, this.maxWorkers);
		const timeout = this._timeout ?? defaultTimeout;
		while (this._workers.length < target) {
			try {
				this._start(timeout, true);
			} catch {
				// Creating the worker threw (e.g. CSP): stop warming without throwing.
				return;
			}
		}
	}

	public destroy(): void {
		if (this._destroyed) {
			return;
		}
		this._destroyed = true;
		const workers = this._workers.splice(0);
		for (const pooled of workers) {
			const wasReady = pooled.ready;
			pooled.settle();
			pooled.worker.terminate();
			const channels = Array.from(pooled.channels.values());
			pooled.channels.clear();
			for (const channel of channels) {
				if (wasReady) {
					channel.lose('The data engine worker pool was destroyed', undefined);
				} else {
					channel.onFailed();
				}
			}
		}
		this._onEmpty?.();
	}

	/** Removes `pooled` from this pool and terminates its worker. */
	public retire(pooled: PooledWorker): void {
		const index = this._workers.indexOf(pooled);
		if (index >= 0) {
			this._workers.splice(index, 1);
		}
		if (this._workers.length === 0) {
			this._onEmpty?.();
		}
		pooled.worker.terminate();
	}

	/**
	 * Attaches an engine to a worker in this pool: prefers an idle warmed worker, then starts a new
	 * worker while under `maxWorkers`, else joins the worker serving the fewest engines.
	 */
	public connect(
		timeoutOverride: number | undefined,
		onReady: (transport: EngineTransport) => void,
		onFailed: () => void,
	): (() => void) | null {
		if (this._destroyed) {
			return null;
		}
		let pooled: PooledWorker | undefined;
		// Prefer an idle worker pre-started by `warmup()` before spawning another.
		for (const candidate of this._workers) {
			if (candidate.channels.size === 0) {
				pooled = candidate;
				break;
			}
		}
		if (pooled === undefined && this._workers.length < this.maxWorkers) {
			const timeout = timeoutOverride ?? this._timeout ?? defaultTimeout;
			try {
				pooled = this._start(timeout, false);
			} catch {
				if (this._workers.length === 0) {
					this._onEmpty?.();
				}
				return null;
			}
		}
		if (pooled === undefined) {
			for (const candidate of this._workers) {
				if (pooled === undefined || candidate.channels.size < pooled.channels.size) {
					pooled = candidate;
				}
			}
		}
		pooled!.warmed = false;
		const id = pooled!.nextId++;
		const channel = new WorkerChannel(pooled!, id, onReady, onFailed);
		pooled!.channels.set(id, channel);
		if (pooled!.ready) {
			onReady(channel);
		}
		return () => channel.close();
	}

	/**
	 * Starts a worker and waits for its ready message. A page whose content security policy blocks
	 * workers reports that either by throwing (which the caller sees) or by an asynchronous error
	 * event, so nothing is sent, and no buffer is given away, until the worker has answered.
	 */
	private _start(timeout: number, warmed: boolean): PooledWorker {
		const source = this.source();
		if (typeof source === 'string' && source.trim() === '') {
			throw new RangeError('Empty worker URL');
		}
		const { create } = normalizeSource(source);
		const worker = create();
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const pooled: PooledWorker = {
			worker,
			owner: this,
			channels: new Map(),
			nextId: 0,
			ready: false,
			warmed,
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
			this.retire(pooled);
			// Every engine that waited for this worker falls back by itself.
			const channels = Array.from(pooled.channels.values());
			pooled.channels.clear();
			for (const channel of channels) {
				channel.onFailed();
			}
		};
		// Once it runs, a failure loses every engine on the worker; each is told on its own.
		const lost = (event: Event): void => {
			if (!this._workers.includes(pooled)) {
				return;
			}
			this.retire(pooled);
			const message = workerFailure(event);
			const channels = Array.from(pooled.channels.values());
			pooled.channels.clear();
			for (const channel of channels) {
				channel.lose(message, event);
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
			worker.addEventListener('error', lost);
			worker.addEventListener('messageerror', lost);
			// An engine may leave or join while the others are told; the map takes both.
			for (const channel of Array.from(pooled.channels.values())) {
				channel.onReady(channel);
			}
		};
		timer = setTimeout(fail, timeout);
		worker.addEventListener('error', fail);
		worker.addEventListener('message', onReady);
		this._workers.push(pooled);
		return pooled;
	}
}

const pools = new Map<PoolKey, ManagedWorkerPool>();

/** Resolves the configured default worker source (unwrapping a configured pool), or the built-in worker. */
function resolveDefaultSource(): WorkerSource {
	if (defaultSource instanceof ManagedWorkerPool) {
		return defaultSource.source();
	}
	if (typeof defaultSource === 'boolean') {
		return defaultWorker;
	}
	return defaultSource;
}

/** Gets or creates the implicit shared pool keyed by `source`. */
function sharedPoolFor(source: WorkerSource): ManagedWorkerPool {
	const { key } = normalizeSource(source);
	let pool = pools.get(key);
	if (pool === undefined) {
		pool = new ManagedWorkerPool(source, null, null, () => {
			// Nothing is kept for a source without workers, or every factory ever used would stay reachable.
			if (pools.get(key) === pool) {
				pools.delete(key);
			}
		});
		pools.set(key, pool);
	}
	return pool;
}

function isManagedPool(value: unknown): value is ManagedWorkerPool {
	return value instanceof ManagedWorkerPool;
}

function isWorkerSource(value: unknown): value is WorkerSource {
	return typeof value === 'string' || typeof value === 'function' || value instanceof URL;
}

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
	maxWorkers = checkMaxWorkers(count, 'setMaxWorkers');
}

/**
 * Configures the default worker settings for every chart and engine created afterwards.
 *
 * Accepts a shorthand (`boolean`, `WorkerSource`, or `WorkerPool`) or a `WorkerConfig` object:
 * ```ts
 * configureWorker(ChartWorker); // Vite `?worker`
 * configureWorker('/assets/lumen-worker.js'); // static URL
 * configureWorker({ source: ChartWorker, maxWorkers: 2, timeout: 4000 });
 * configureWorker(false); // main-thread time-sliced mode by default
 * ```
 */
export function configureWorker(config: boolean | WorkerSource | WorkerPool | WorkerConfig): void {
	if (typeof config === 'boolean' || isManagedPool(config) || isWorkerSource(config)) {
		if (typeof config === 'string') {
			checkSourceString(config, 'configureWorker');
		}
		defaultSource = config;
		return;
	}
	if (typeof config !== 'object' || config === null) {
		throw new TypeError('configureWorker expects a boolean, worker source, worker pool, or WorkerConfig object');
	}
	const next = config as WorkerConfig;
	// Validate every field before applying any change.
	let nextMax: number | undefined;
	if (next.maxWorkers !== undefined) {
		nextMax = checkMaxWorkers(next.maxWorkers, 'configureWorker');
	}
	let nextTimeout: number | undefined;
	if (next.timeout !== undefined) {
		nextTimeout = checkTimeout(next.timeout, 'configureWorker');
	}
	let nextSource: boolean | WorkerSource | ManagedWorkerPool | undefined;
	if (next.source !== undefined) {
		if (typeof next.source === 'string') {
			checkSourceString(next.source, 'configureWorker');
			nextSource = next.source;
		} else if (typeof next.source === 'boolean' || isManagedPool(next.source) || isWorkerSource(next.source)) {
			nextSource = next.source;
		} else {
			throw new TypeError('configureWorker: invalid worker source');
		}
	}
	if (nextMax !== undefined) {
		maxWorkers = nextMax;
	}
	if (nextTimeout !== undefined) {
		defaultTimeout = nextTimeout;
	}
	if (nextSource !== undefined) {
		defaultSource = nextSource;
	}
}

/** Returns the current global worker configuration (see `configureWorker`). */
export function getWorkerConfig(): Readonly<Required<WorkerConfig>> {
	return {
		source: defaultSource,
		maxWorkers: getMaxWorkers(),
		timeout: defaultTimeout,
	};
}

/**
 * Creates an explicit, isolated pool of shared engine workers.
 *
 * Pass the returned handle as `worker` in `createChart`, `createEngine`, or `configureWorker` to
 * share workers explicitly across a group of charts with its own `maxWorkers` limit and optional
 * `warmup()` pre-starting.
 */
export function createWorkerPool(options: WorkerPoolOptions = {}): WorkerPool {
	let source: WorkerSource | null = null;
	if (options.worker !== undefined) {
		if (typeof options.worker === 'string') {
			checkSourceString(options.worker, 'createWorkerPool');
		} else if (!isWorkerSource(options.worker)) {
			throw new TypeError('createWorkerPool: invalid worker source');
		}
		source = options.worker;
	}
	const limit = options.maxWorkers === undefined ? null : checkMaxWorkers(options.maxWorkers, 'createWorkerPool');
	const timeout = options.timeout === undefined ? null : checkTimeout(options.timeout, 'createWorkerPool');
	return new ManagedWorkerPool(source, limit, timeout, null);
}

/**
 * Resolves `option` against the global worker configuration and connects an engine to a worker.
 *
 * Returns a release function, `false` when the engine should run locally without trying a worker,
 * or `null` when starting the worker threw synchronously (so the caller falls back to local mode).
 */
export function connectEngineWorker(
	option: WorkerOption | undefined,
	timeout: number | undefined,
	onReady: (transport: EngineTransport) => void,
	onFailed: () => void,
): (() => void) | false | null {
	if (option === false || typeof Worker === 'undefined') {
		return false;
	}
	if (option === 'dedicated') {
		const pool = new ManagedWorkerPool(resolveDefaultSource(), 1, null, null);
		return pool.connect(timeout, onReady, onFailed);
	}
	if (isManagedPool(option)) {
		return option.connect(timeout, onReady, onFailed);
	}
	if (option === undefined) {
		if (defaultSource === false) {
			return false;
		}
		if (isManagedPool(defaultSource)) {
			return defaultSource.connect(timeout, onReady, onFailed);
		}
		const source = defaultSource === true ? defaultWorker : defaultSource;
		return sharedPoolFor(source).connect(timeout, onReady, onFailed);
	}
	if (option === true) {
		if (isManagedPool(defaultSource)) {
			return defaultSource.connect(timeout, onReady, onFailed);
		}
		const source = typeof defaultSource === 'boolean' ? defaultWorker : defaultSource;
		return sharedPoolFor(source).connect(timeout, onReady, onFailed);
	}
	if (!isWorkerSource(option) || (typeof option === 'string' && option.trim() === '')) {
		return null;
	}
	return sharedPoolFor(option).connect(timeout, onReady, onFailed);
}
