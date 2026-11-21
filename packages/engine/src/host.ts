import { EngineCore } from './core';
import { type Command, type EngineEvent, type HostMessage, type ReadyMessage, transferables } from './protocol';

/** The part of a worker global scope the engine host needs. */
export interface EngineScope {
	addEventListener(type: 'message', listener: (event: MessageEvent<HostMessage>) => void): void;
	postMessage(message: EngineEvent | ReadyMessage, transfer: Transferable[]): void;
}

/** Longest stretch of background work a worker host runs before looking at its messages again. */
const BACKGROUND_SLICE_MS = 4;
/**
 * How long after a command background work runs in short slices. The answer to a load or a prepend
 * is usually followed by a window request, which should not wait behind a slice of background work;
 * it arrives within a round trip to the main thread, which a busy frame can stretch to most of a
 * frame. Until then the work goes on a millisecond at a time instead of not at all: waiting the whole
 * time instead made a worker's prepend settle 20 ms later than the main thread's.
 */
const BACKGROUND_GRACE_MS = 20;
/** Longest stretch of background work while a window request may still be on its way. */
const BACKGROUND_GRACE_SLICE_MS = 1;
/**
 * Longest stretch a worker host that serves several engines runs commands before looking at its
 * messages again: a command of one engine waits at most this long behind a bulk load of another.
 */
const COMMAND_SLICE_MS = 4;

/** One engine of a worker host, with the commands it has not answered yet. */
interface Hosted {
	readonly id: number;
	readonly core: EngineCore;
	/** Commands received and not started, in order; `head` is the next one. */
	queue: Command[];
	head: number;
	/** The command being run, which may span several slices. */
	command: Command | null;
	run: Generator<undefined, EngineEvent, undefined> | null;
}

/**
 * Runs engines inside a worker: one event per command, buffers transferred back.
 *
 * A worker serves any number of engines, each with a state of its own; a message says which engine
 * it is for (`engine`, 0 when absent) and an engine starts with its first command.
 * - The commands of one engine run in the order they arrive, one at a time.
 * - A command that throws is answered with a failure event of its engine; the others never notice.
 * - With one engine, a command runs to completion as soon as it arrives. With several, the engines
 *   take turns: one runs its commands until none is left or the slice is over, then the host looks
 *   at its messages, so a bulk load of one chart cannot hold up the others for long.
 * - Background work (building levels of detail) of any engine runs only while no engine has a
 *   command waiting.
 */
export function attachEngineHost(scope: EngineScope): void {
	const engines = new Map<number, Hosted>();
	/** The engines in the order they take turns; `turn` is the one whose turn it is. */
	const ring: Hosted[] = [];
	let turn = 0;
	let backgroundTurn = 0;
	/** Commands received and not answered yet, over all engines. */
	let waiting = 0;
	/** The commands left wait for the continuation task, which is posted. */
	let yielded = false;
	/** Background work is on its way: it continues in a posted task. */
	let background = false;
	/** Until this time background work runs in short slices (`BACKGROUND_GRACE_MS`). */
	let graceUntil = 0;
	let posted = false;
	let channel: MessageChannel | null = null;

	/** Runs `resume` in a later task, behind the messages that have arrived by then. */
	const post = (): void => {
		if (posted) {
			return;
		}
		posted = true;
		// A message task lets queued commands run first and is not clamped like nested timers.
		if (channel === null && typeof MessageChannel !== 'undefined') {
			channel = new MessageChannel();
			channel.port1.addEventListener('message', resume);
			channel.port1.start();
		}
		if (channel === null) {
			setTimeout(resume, 0);
		} else {
			channel.port2.postMessage(null);
		}
	};

	/** Runs waiting commands, engine by engine, until none is left or the slice is over. */
	const pump = (): void => {
		yielded = false;
		const deadline = performance.now() + COMMAND_SLICE_MS;
		while (waiting > 0) {
			// The next engine with something to do; one exists while commands are waiting.
			let hosted = ring[turn]!;
			while (hosted.run === null && hosted.head === hosted.queue.length) {
				turn = (turn + 1) % ring.length;
				hosted = ring[turn]!;
			}
			turn = (turn + 1) % ring.length;
			// Its turn: commands until it has none left.
			for (;;) {
				if (hosted.run === null) {
					if (hosted.head === hosted.queue.length) {
						hosted.queue.length = 0;
						hosted.head = 0;
						break;
					}
					hosted.command = hosted.queue[hosted.head++]!;
					hosted.run = hosted.core.run(hosted.command);
				}
				// A host with one engine has nobody to give way to, and runs every command in one go.
				const sliced = ring.length > 1;
				let event: EngineEvent | null = null;
				try {
					let step = hosted.run.next();
					if (sliced) {
						while (step.done !== true && performance.now() < deadline) {
							step = hosted.run.next();
						}
					} else {
						while (step.done !== true) {
							step = hosted.run.next();
						}
					}
					if (step.done === true) {
						event = step.value;
					}
				} catch (error) {
					// Every command is answered, or the client would wait for this one forever. What was
					// thrown goes along as text: it may not survive the copy to the other thread.
					event = hosted.core.failure(hosted.command!, error);
				}
				if (event !== null) {
					hosted.command = null;
					hosted.run = null;
					waiting--;
					event.engine = hosted.id;
					scope.postMessage(event, transferables(event));
				}
				if (sliced && performance.now() >= deadline) {
					if (waiting > 0) {
						// Messages that arrived meanwhile are delivered before the continuation.
						yielded = true;
						post();
					} else {
						scheduleBackground();
					}
					return;
				}
			}
		}
		scheduleBackground();
	};

	const scheduleBackground = (): void => {
		// Every command opens the grace period again: the request that follows its answer may come.
		graceUntil = performance.now() + BACKGROUND_GRACE_MS;
		if (background) {
			return;
		}
		for (const hosted of ring) {
			if (hosted.core.busy) {
				background = true;
				// A posted task runs behind the messages that have arrived by then.
				post();
				return;
			}
		}
	};

	/**
	 * Posts what an engine's work outside its commands finished (indicator values swapped in, a
	 * plugin module loaded, rows to fetch again), as a notice tagged with the engine.
	 */
	const notify = (hosted: Hosted): void => {
		const notice = hosted.core.takeNotice();
		if (notice !== null) {
			notice.engine = hosted.id;
			scope.postMessage(notice, transferables(notice));
		}
	};

	/** Runs one slice of background work, taking the engines that have some in turn. */
	const runBackground = (): void => {
		const now = performance.now();
		const deadline = now + (now < graceUntil ? BACKGROUND_GRACE_SLICE_MS : BACKGROUND_SLICE_MS);
		let idle = 0;
		while (idle < ring.length) {
			backgroundTurn = (backgroundTurn + 1) % ring.length;
			const hosted = ring[backgroundTurn]!;
			let more: boolean;
			try {
				more = hosted.core.backgroundStep();
				notify(hosted);
			} catch (error) {
				// Thrown out of here it would be an error of the worker, which loses every engine on it.
				more = false;
				const notice = hosted.core.stopBackground(error);
				notice.engine = hosted.id;
				scope.postMessage(notice, transferables(notice));
			}
			if (more) {
				idle = 0;
				if (performance.now() >= deadline) {
					post();
					return;
				}
			} else {
				idle++;
			}
		}
		// Nothing left: an idle port is closed so it keeps nothing alive.
		background = false;
		if (channel !== null && !posted) {
			channel.port1.removeEventListener('message', resume);
			channel.port1.close();
			channel = null;
		}
	};

	/** The continuation task: commands first, background work only when none is waiting. */
	function resume(): void {
		posted = false;
		if (waiting > 0) {
			pump();
			// Background work that was under way goes on behind the commands.
			if (background && !posted) {
				post();
			}
		} else {
			yielded = false;
			if (background) {
				runBackground();
			}
		}
	}

	const close = (id: number): void => {
		const hosted = engines.get(id);
		if (hosted === undefined) {
			return;
		}
		engines.delete(id);
		const index = ring.indexOf(hosted);
		ring.splice(index, 1);
		turn = ring.length === 0 ? 0 : turn > index ? turn - 1 : turn % ring.length;
		backgroundTurn = 0;
		// Its commands are never answered: nobody listens for them any more.
		waiting -= hosted.queue.length - hosted.head + (hosted.run === null ? 0 : 1);
	};

	scope.addEventListener('message', message => {
		const data = message.data;
		if (data.type === 'close') {
			close(data.engine);
			return;
		}
		const id = data.engine ?? 0;
		let hosted = engines.get(id);
		if (hosted === undefined) {
			const created: Hosted = { id, core: new EngineCore(), queue: [], head: 0, command: null, run: null };
			// A plugin module loads between commands; its outcome goes out as soon as it is known.
			created.core.onwake = () => notify(created);
			hosted = created;
			engines.set(id, hosted);
			ring.push(hosted);
		}
		hosted.queue.push(data);
		waiting++;
		// While commands wait for the continuation, this one waits with them, for its engine's turn.
		if (!yielded) {
			pump();
		}
	});
	scope.postMessage({ ready: true }, []);
}

/** Carries commands to an engine and events back. The engine may live in a worker or on this thread. */
export interface EngineTransport {
	onevent: ((event: EngineEvent) => void) | null;
	/**
	 * Called once if the engine stops for good, with a message and what reported it: the worker it
	 * runs in failed after it started. No event comes after it, also none for commands sent before.
	 */
	onlost?: ((message: string, cause: unknown) => void) | null;
	post(command: Command, transfer: ArrayBuffer[]): void;
	close(): void;
}

/**
 * The message for a worker that failed after it started: an error it did not handle, after which
 * its state is unknown, or a message from it that could not be read, which was lost.
 */
export function workerFailure(event: Event): string {
	if (event.type === 'messageerror') {
		return 'The data engine worker sent a message that could not be read';
	}
	const message = (event as ErrorEvent).message;
	return typeof message === 'string' && message !== ''
		? `The data engine worker failed: ${message}`
		: 'The data engine worker failed';
}

/** A worker of its own for one engine. A worker that fails after it started is stopped (see `onlost`). */
export class WorkerTransport implements EngineTransport {
	public onevent: ((event: EngineEvent) => void) | null = null;
	public onlost: ((message: string, cause: unknown) => void) | null = null;
	private readonly _worker: Worker;

	public constructor(worker: Worker) {
		this._worker = worker;
		worker.addEventListener('message', this._onMessage);
		worker.addEventListener('error', this._onFailure);
		worker.addEventListener('messageerror', this._onFailure);
	}

	public post(command: Command, transfer: ArrayBuffer[]): void {
		this._worker.postMessage(command, transfer);
	}

	public close(): void {
		this._worker.removeEventListener('message', this._onMessage);
		this._worker.removeEventListener('error', this._onFailure);
		this._worker.removeEventListener('messageerror', this._onFailure);
		this._worker.terminate();
	}

	private readonly _onMessage = (message: MessageEvent<EngineEvent>): void => {
		this.onevent?.(message.data);
	};

	private readonly _onFailure = (event: Event): void => {
		const lost = this.onlost;
		this.onevent = null;
		this.onlost = null;
		this.close();
		lost?.(workerFailure(event), event);
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

	public constructor() {
		// A notice that comes between commands is delivered by the pump once the queue is empty.
		this._core.onwake = () => this._schedule();
	}

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
		try {
			while (this._core.backgroundStep()) {
				if (performance.now() >= end) {
					this._notify();
					this._scheduleIdle();
					return;
				}
			}
		} catch (error) {
			this._stopBackground(error);
			return;
		}
		this._notify();
	};

	/** A step of background work threw: the engine stops it and the client is told (see `EngineCore.stopBackground`). */
	private _stopBackground(error: unknown): void {
		const notice = this._core.stopBackground(error);
		notice.cause = error;
		this.onevent?.(notice);
	}

	private _notify(): void {
		const notice = this._core.takeNotice();
		if (notice !== null) {
			this.onevent?.(notice);
		}
	}

	private readonly _pump = (): void => {
		this._scheduled = false;
		const deadline = performance.now() + SLICE_MS;
		while (!this._closed) {
			if (this._current === null) {
				if (this._head >= this._queue.length) {
					this._queue.length = 0;
					this._head = 0;
					// Indicator values the chart waits for are computed in tasks like commands, not in idle
					// time; at least one step per task, so they get there however busy the thread is.
					if (this._core.urgent) {
						try {
							do {
								this._core.backgroundStep();
							} while (this._core.urgent && performance.now() < deadline);
						} catch (error) {
							this._stopBackground(error);
							return;
						}
					}
					this._notify();
					if (this._core.urgent) {
						this._schedule();
					} else if (this._core.busy) {
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
			} catch (error) {
				// Every command is answered, or the client would wait for this one forever. On this thread
				// the client gets what was thrown as it is.
				event = this._core.failure(this._command!, error);
				event.cause = error;
			}
			if (event !== null) {
				this._current = null;
				this._command = null;
				this.onevent?.(event);
			}
			if (performance.now() >= deadline) {
				// The last command may have finished just now and left background work behind it.
				if (this._current !== null || this._head < this._queue.length || this._core.urgent) {
					this._schedule();
				} else if (this._core.busy) {
					this._scheduleIdle();
				}
				return;
			}
		}
	};
}
