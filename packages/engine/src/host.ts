import { EngineCore } from './core';
import { type Command, type EngineEvent, type ReadyMessage, transferables } from './protocol';

/** The part of a worker global scope the engine host needs. */
export interface EngineScope {
	addEventListener(type: 'message', listener: (event: MessageEvent<Command>) => void): void;
	postMessage(message: EngineEvent | ReadyMessage, transfer: Transferable[]): void;
}

/** Runs an engine inside a worker: one event per command, buffers transferred back. */
export function attachEngineHost(scope: EngineScope): void {
	const core = new EngineCore();
	scope.addEventListener('message', message => {
		let event: EngineEvent;
		try {
			const run = core.run(message.data);
			let step = run.next();
			while (step.done !== true) {
				step = run.next();
			}
			event = step.value;
		} catch {
			// Every command is answered, or the client would wait for this one forever.
			event = core.failure(message.data);
		}
		scope.postMessage(event, transferables(event));
	});
	scope.postMessage({ ready: true }, []);
}

/** Carries commands to an engine and events back. The engine may live in a worker or on this thread. */
export interface EngineTransport {
	onevent: ((event: EngineEvent) => void) | null;
	post(command: Command, transfer: ArrayBuffer[]): void;
	close(): void;
}

export class WorkerTransport implements EngineTransport {
	public onevent: ((event: EngineEvent) => void) | null = null;
	private readonly _worker: Worker;

	public constructor(worker: Worker) {
		this._worker = worker;
		worker.addEventListener('message', this._onMessage);
	}

	public post(command: Command, transfer: ArrayBuffer[]): void {
		this._worker.postMessage(command, transfer);
	}

	public close(): void {
		this._worker.removeEventListener('message', this._onMessage);
		this._worker.terminate();
	}

	private readonly _onMessage = (message: MessageEvent<EngineEvent>): void => {
		this.onevent?.(message.data);
	};
}

/** Longest stretch the main-thread engine runs before giving the thread back. */
const SLICE_MS = 4;

/**
 * Runs the engine on the calling thread, for pages where workers are blocked.
 * Commands are still answered asynchronously, and work is cut into slices of a few milliseconds
 * with a task boundary between them so input and rendering stay responsive.
 */
export class LocalTransport implements EngineTransport {
	public onevent: ((event: EngineEvent) => void) | null = null;
	private readonly _core = new EngineCore();
	private _queue: Command[] = [];
	private _head = 0;
	private _current: Generator<undefined, EngineEvent, undefined> | null = null;
	private _command: Command | null = null;
	private _scheduled = false;
	private _closed = false;
	private _channel: MessageChannel | null = null;

	public post(command: Command, _transfer: ArrayBuffer[]): void {
		if (this._closed) {
			return;
		}
		this._queue.push(command);
		this._schedule();
	}

	public close(): void {
		this._closed = true;
		this._queue = [];
		this._current = null;
		if (this._channel !== null) {
			this._channel.port1.removeEventListener('message', this._pump);
			this._channel.port1.close();
			this._channel.port2.close();
			this._channel = null;
		}
	}

	private _schedule(): void {
		if (this._scheduled) {
			return;
		}
		this._scheduled = true;
		// A message task runs without the clamping browsers apply to nested timers.
		if (typeof MessageChannel === 'undefined') {
			setTimeout(this._pump, 0);
			return;
		}
		if (this._channel === null) {
			this._channel = new MessageChannel();
			this._channel.port1.addEventListener('message', this._pump);
			this._channel.port1.start();
		}
		this._channel.port2.postMessage(null);
	}

	private readonly _pump = (): void => {
		this._scheduled = false;
		const deadline = performance.now() + SLICE_MS;
		while (!this._closed) {
			if (this._current === null) {
				if (this._head >= this._queue.length) {
					this._queue.length = 0;
					this._head = 0;
					return;
				}
				this._command = this._queue[this._head++]!;
				this._current = this._core.run(this._command);
			}
			let event: EngineEvent | null = null;
			try {
				const step = this._current.next();
				if (step.done === true) {
					event = step.value;
				}
			} catch {
				// Every command is answered, or the client would wait for this one forever.
				event = this._core.failure(this._command!);
			}
			if (event !== null) {
				this._current = null;
				this._command = null;
				this.onevent?.(event);
			}
			if (performance.now() >= deadline) {
				if (this._current !== null || this._head < this._queue.length) {
					this._schedule();
				}
				return;
			}
		}
	};
}
