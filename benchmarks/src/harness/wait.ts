// Waiting between two measured steps, for a time shorter and more exact than timers give, without
// the wait itself leaving work for the garbage collector: whatever it leaves is collected on the
// main thread, in pauses a scenario would measure as the library's.

/**
 * A worker that sleeps for the milliseconds it is sent and answers. `Atomics.wait` on memory
 * nobody else writes to is a sleep with a timeout of any length, fractions of a millisecond included.
 */
const SLEEPER = `
const cell = new Int32Array(new SharedArrayBuffer(4));
onmessage = event => {
	Atomics.wait(cell, 0, 0, event.data);
	postMessage(0);
};
`;

let sleeper: Worker | null = null;
let done: (() => void) | null = null;

function finish(): void {
	const resolve = done;
	done = null;
	resolve?.();
}

/** The channel `waitTasks` posts its turns on, and when the wait in progress ends. */
let port: MessagePort | null = null;
let until = 0;

function turn(): void {
	if (performance.now() < until) {
		port?.postMessage(null, []);
	} else {
		finish();
	}
}

/**
 * Waits `duration` milliseconds a task at a time: frames and messages run whenever they are due
 * meanwhile, but the main thread is never idle, and every turn leaves a message event behind
 * (about 25 turns a millisecond). The turns go over one channel kept for the page; a channel and
 * a promise per turn would also leave two message ports each, which only a full collection frees.
 */
function waitTasks(duration: number): Promise<void> {
	if (port === null) {
		const channel = new MessageChannel();
		channel.port1.addEventListener('message', turn);
		channel.port1.start();
		port = channel.port2;
	}
	const out = port;
	return new Promise(resolve => {
		until = performance.now() + duration;
		done = resolve;
		out.postMessage(null, []);
	});
}

/**
 * Waits `duration` milliseconds with the main thread idle, as it is between two ticks from a
 * socket: frames and messages run whenever they are due, and the wait costs the page one message.
 * A worker sleeps meanwhile; where the page is not cross-origin isolated, and so has no shared
 * memory to sleep on, the wait runs a task at a time instead (`waitTasks`). One wait at a time.
 */
export function waitIdle(duration: number): Promise<void> {
	if (done !== null) {
		throw new Error('A wait is in progress');
	}
	if (!(duration > 0)) {
		return Promise.resolve();
	}
	if (typeof SharedArrayBuffer === 'undefined') {
		return waitTasks(duration);
	}
	if (sleeper === null) {
		const url = URL.createObjectURL(new Blob([SLEEPER], { type: 'text/javascript' }));
		sleeper = new Worker(url);
		sleeper.addEventListener('message', finish);
		URL.revokeObjectURL(url);
	}
	const worker = sleeper;
	return new Promise(resolve => {
		done = resolve;
		worker.postMessage(duration, []);
	});
}
