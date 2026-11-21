import {
	type EngineEvent,
	type EngineScope,
	type HostMessage,
	type ReadyMessage,
	attachEngineHost,
} from '@lumen-charts/engine';

/** A worker that runs the real engine host in this thread and delivers messages asynchronously. */
export class FakeWorker {
	public static behavior: 'ok' | 'error' | 'silent' = 'ok';
	/** Every worker created, in order. */
	public static created: FakeWorker[] = [];
	public terminated = false;
	/** Messages posted to the worker, with the buffers handed over with each. */
	public received: HostMessage[] = [];
	public transfers: Transferable[][] = [];
	/** Events the host posted, with the buffers handed over with each. */
	public events: EngineEvent[] = [];
	public eventTransfers: Transferable[][] = [];
	/** Messages delivered to the host so far. */
	public delivered = 0;
	private readonly _listeners = new Map<string, Set<(event: MessageEvent) => void>>();
	private readonly _scopeListeners: ((event: MessageEvent<HostMessage>) => void)[] = [];
	private readonly _scope: EngineScope;

	public constructor() {
		FakeWorker.created.push(this);
		this._scope = {
			addEventListener: (_type, listener) => {
				this._scopeListeners.push(listener);
			},
			postMessage: (message: EngineEvent | ReadyMessage, transfer: Transferable[]) => {
				if (!('ready' in message)) {
					this.events.push(message);
					this.eventTransfers.push(transfer);
				}
				queueMicrotask(() => {
					this._emit('message', { data: message } as MessageEvent);
				});
			},
		};
		const behavior = FakeWorker.behavior;
		queueMicrotask(() => {
			if (behavior === 'ok') {
				attachEngineHost(this._scope);
			} else if (behavior === 'error') {
				this._emit('error', {} as MessageEvent);
			}
		});
	}

	/** Commands received and not answered yet (a `close` message is not a command). */
	public get unanswered(): number {
		return this.received.filter(message => message.type !== 'close').length - this.events.length;
	}

	public addEventListener(type: string, listener: (event: MessageEvent) => void): void {
		let listeners = this._listeners.get(type);
		if (listeners === undefined) {
			listeners = new Set();
			this._listeners.set(type, listeners);
		}
		listeners.add(listener);
	}

	public removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
		this._listeners.get(type)?.delete(listener);
	}

	public postMessage(message: HostMessage, transfer: Transferable[] = []): void {
		this.received.push(message);
		this.transfers.push(transfer);
		queueMicrotask(() => {
			if (this.terminated) {
				return;
			}
			this.delivered++;
			for (const listener of this._scopeListeners) {
				listener({ data: message } as MessageEvent<HostMessage>);
			}
		});
	}

	public terminate(): void {
		this.terminated = true;
	}

	/** Fires an `error` (an error the worker did not handle) or a `messageerror` at the worker's listeners. */
	public crash(type: 'error' | 'messageerror' = 'error', message = 'boom'): void {
		this._emit(type, { type, message } as unknown as MessageEvent);
	}

	private _emit(type: string, event: MessageEvent): void {
		if (this.terminated) {
			return;
		}
		// Like a real event target, deliver to the listeners registered when dispatch starts.
		const listeners = Array.from(this._listeners.get(type) ?? []);
		for (const listener of listeners) {
			listener(event);
		}
	}
}
