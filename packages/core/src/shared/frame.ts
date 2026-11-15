/**
 * One animation frame for every chart of the page.
 *
 * A frame runs in two phases over the charts that asked for it: first every chart reads what it
 * needs from the layout, then every chart writes to the DOM and draws. With a callback per chart,
 * the first chart's writes would make the second chart's reads recompute the layout, once per
 * chart.
 */
export interface FrameClient {
	/** Set while the client waits for a frame. Owned by this module. */
	frameQueued: boolean;
	/** Reads from the layout (sizes, positions). Must not write to the DOM. */
	frameRead(now: number): void;
	/** Writes to the DOM and draws. */
	frameWrite(now: number): void;
}

/** Clients waiting for the next frame, in the order they asked. */
let queue: (FrameClient | null)[] = [];
/** Clients of the frame being run; a slot is cleared when its client leaves mid-frame. */
let batch: (FrameClient | null)[] = [];
let handle: number | null = null;

/**
 * Reports an error without unwinding the caller, as an uncaught error of the page: one chart that
 * throws must not keep the charts after it from drawing.
 */
function report(error: unknown): void {
	if (typeof reportError === 'function') {
		reportError(error);
	} else {
		setTimeout(() => {
			throw error;
		}, 0);
	}
}

function run(now: number): void {
	handle = null;
	const clients = queue;
	queue = batch;
	batch = clients;
	for (let i = 0; i < clients.length; i++) {
		try {
			clients[i]?.frameRead(now);
		} catch (error) {
			report(error);
		}
	}
	for (let i = 0; i < clients.length; i++) {
		const client = clients[i];
		if (client === null || client === undefined) {
			continue;
		}
		// Cleared before the client draws, so a request it makes while drawing is for the next frame,
		// while one made earlier in this frame (by another chart's draw) is served by this draw.
		client.frameQueued = false;
		try {
			client.frameWrite(now);
		} catch (error) {
			report(error);
		}
	}
	clients.length = 0;
}

/** Asks for `client` to take part in the next frame. Any number of requests give one frame. */
export function requestFrame(client: FrameClient): void {
	if (client.frameQueued) {
		return;
	}
	client.frameQueued = true;
	queue.push(client);
	if (handle === null) {
		handle = requestAnimationFrame(run);
	}
}

/**
 * Withdraws `client` from the frame it waits for, also when that frame is running. The animation
 * frame is cancelled once nobody waits for it, so nothing is left behind by the last chart.
 */
export function cancelFrame(client: FrameClient): void {
	if (!client.frameQueued) {
		return;
	}
	client.frameQueued = false;
	const queued = queue.indexOf(client);
	if (queued >= 0) {
		queue.splice(queued, 1);
	} else {
		const running = batch.indexOf(client);
		if (running >= 0) {
			batch[running] = null;
		}
	}
	if (queue.length === 0 && handle !== null) {
		cancelAnimationFrame(handle);
		handle = null;
	}
}
