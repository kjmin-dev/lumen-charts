import { EngineCore } from './core';
import { type Command, type EngineEvent, type ReadyMessage, transferables } from './protocol';

/** The part of a worker global scope the engine host needs. */
export interface EngineScope {
	addEventListener(type: 'message', listener: (event: MessageEvent<Command>) => void): void;
	postMessage(message: EngineEvent | ReadyMessage, transfer: Transferable[]): void;
}

/** Longest stretch of background work a worker host runs before looking at its messages again. */
const BACKGROUND_SLICE_MS = 4;
/**
 * Delay before a worker host starts background work after a command. The answer to a load is usually
 * followed at once by a window request, which should not wait behind a slice of background work.
 */
const BACKGROUND_DELAY_MS = 20;

/** Runs an engine inside a worker: one event per command, buffers transferred back. */
export function attachEngineHost(scope: EngineScope): void {
	const core = new EngineCore();
	let timer: ReturnType<typeof setTimeout> | null = null;
	let channel: MessageChannel | null = null;
	const step = (): void => {
		const deadline = performance.now() + BACKGROUND_SLICE_MS;
		while (core.backgroundStep()) {
			if (performance.now() >= deadline) {
				// A message task lets queued commands run first and is not clamped like nested timers.
				if (channel === null && typeof MessageChannel !== 'undefined') {
					channel = new MessageChannel();
					channel.port1.addEventListener('message', step);
					channel.port1.start();
				}
				if (channel === null) {
					setTimeout(step, 0);
				} else {
					channel.port2.postMessage(null);
				}
				return;
			}
		}
		// Nothing left: an idle port is closed so it keeps nothing alive.
		if (channel !== null) {
			channel.port1.removeEventListener('message', step);
			channel.port1.close();
			channel = null;
		}
	};
	scope.addEventListener('message', message => {
		let event: EngineEvent;
		try {
			const run = core.run(message.data);
			let next = run.next();
			while (next.done !== true) {
				next = run.next();
			}
			event = next.value;
		} catch {
			// Every command is answered, or the client would wait for this one forever.
			event = core.failure(message.data);
		}
		scope.postMessage(event, transferables(event));
		if (core.busy && timer === null && channel === null) {
			timer = setTimeout(() => {
				timer = null;
				step();
			}, BACKGROUND_DELAY_MS);
		}
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
/** Background work waits at most this long for idle time on a busy main thread. */
const IDLE_TIMEOUT_MS = 500;

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
	private _idleScheduled = false;
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

	/**
	 * Background work (building levels of detail) waits for idle time, so it never runs between an
	 * answer and the frame that draws it, as message tasks posted back to back would.
	 */
	private _scheduleIdle(): void {
		if (this._idleScheduled || this._closed) {
			return;
		}
		this._idleScheduled = true;
		if (typeof requestIdleCallback === 'function') {
			requestIdleCallback(this._idle, { timeout: IDLE_TIMEOUT_MS });
		} else {
			setTimeout(this._idle, 0);
		}
	}

	private readonly _idle = (deadline?: IdleDeadline): void => {
		this._idleScheduled = false;
		if (this._closed || this._current !== null || this._head < this._queue.length) {
			// Commands come first; the pump schedules this again once they are answered.
			return;
		}
		const remaining = deadline === undefined || deadline.didTimeout ? SLICE_MS : deadline.timeRemaining();
		const end = performance.now() + Math.min(SLICE_MS, Math.max(1, remaining));
		while (this._core.backgroundStep()) {
			if (performance.now() >= end) {
				this._scheduleIdle();
				return;
			}
		}
	};

	private readonly _pump = (): void => {
		this._scheduled = false;
		const deadline = performance.now() + SLICE_MS;
		while (!this._closed) {
			if (this._current === null) {
				if (this._head >= this._queue.length) {
					this._queue.length = 0;
					this._head = 0;
					if (this._core.busy) {
						this._scheduleIdle();
					}
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
