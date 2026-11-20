import { report } from './frame';

/**
 * The handlers of one event of the public API. A handler that throws is reported as an uncaught
 * error of the page, so the handlers after it still run and the chart goes on drawing.
 */
export class Listeners<T> {
	private readonly _handlers = new Set<(value: T) => void>();

	/** Whether anyone listens. Whoever emits checks this before building what the event carries. */
	public get active(): boolean {
		return this._handlers.size > 0;
	}

	/** Adds `handler` and returns the function that removes it again. */
	public add(handler: (value: T) => void): () => void {
		this._handlers.add(handler);
		return () => {
			this._handlers.delete(handler);
		};
	}

	public emit(value: T): void {
		for (const handler of this._handlers) {
			try {
				handler(value);
			} catch (error) {
				report(error);
			}
		}
	}

	public clear(): void {
		this._handlers.clear();
	}
}
