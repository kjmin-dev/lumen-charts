// Animation-frame instrumentation.
//
// `installFrameProbe` replaces `window.requestAnimationFrame` so that every callback a library
// schedules is timed and counted while it is pending. Libraries look the function up when they
// call it (Lightweight Charts calls `window.requestAnimationFrame(...)`), so installing the probe
// before the first chart is created is enough.

type FrameCallback = (time: number) => void;

interface Probe {
	/** Library callbacks requested but not yet run. */
	pending: Set<number>;
	/** Sum of all timed callback durations so far, in milliseconds. */
	jsTotal: number;
	/** Library callbacks run so far. */
	libraryRuns: number;
	recorder: FrameRecorder | null;
	nativeRequest: (callback: FrameRequestCallback) => number;
	nativeCancel: (handle: number) => void;
}

/** Per-frame samples collected while recording. */
export interface FrameRecording {
	/** rAF timestamp of each frame (the frame's begin time). */
	timestamps: number[];
	/** JavaScript time spent in animation-frame callbacks during each frame. */
	jsTime: number[];
	/** Library callbacks (not harness ones) that ran in each frame. */
	libraryCallbacks: number[];
}

class FrameRecorder implements FrameRecording {
	public readonly timestamps: number[] = [];
	public readonly jsTime: number[] = [];
	public readonly libraryCallbacks: number[] = [];

	public add(timestamp: number, duration: number, library: boolean): void {
		const last = this.timestamps.length - 1;
		if (last >= 0 && this.timestamps[last] === timestamp) {
			this.jsTime[last] = (this.jsTime[last] ?? 0) + duration;
			this.libraryCallbacks[last] = (this.libraryCallbacks[last] ?? 0) + (library ? 1 : 0);
		} else {
			this.timestamps.push(timestamp);
			this.jsTime.push(duration);
			this.libraryCallbacks.push(library ? 1 : 0);
		}
	}
}

let probe: Probe | null = null;

function requireProbe(): Probe {
	if (probe === null) {
		throw new Error('Frame probe is not installed');
	}
	return probe;
}

function runTimed(p: Probe, callback: FrameCallback, time: number, library: boolean): void {
	const start = performance.now();
	try {
		callback(time);
	} finally {
		const duration = performance.now() - start;
		p.jsTotal += duration;
		if (library) {
			p.libraryRuns++;
		}
		p.recorder?.add(time, duration, library);
	}
}

export function installFrameProbe(): void {
	if (probe !== null) {
		return;
	}
	const p: Probe = {
		pending: new Set(),
		jsTotal: 0,
		libraryRuns: 0,
		recorder: null,
		nativeRequest: window.requestAnimationFrame.bind(window),
		nativeCancel: window.cancelAnimationFrame.bind(window),
	};
	probe = p;
	window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
		const handle = p.nativeRequest(time => {
			p.pending.delete(handle);
			runTimed(p, callback, time, true);
		});
		p.pending.add(handle);
		return handle;
	};
	window.cancelAnimationFrame = (handle: number): void => {
		p.pending.delete(handle);
		p.nativeCancel(handle);
	};
}

/** Number of library animation-frame callbacks waiting to run. */
export function pendingFrameCallbacks(): number {
	return requireProbe().pending.size;
}

/** Total JavaScript time spent in timed animation-frame callbacks since the probe was installed. */
export function frameJsTotal(): number {
	return requireProbe().jsTotal;
}

/** Number of library animation-frame callbacks run since the probe was installed. */
export function libraryFrameRuns(): number {
	return requireProbe().libraryRuns;
}

/**
 * Harness callback that is timed like library callbacks but does not count as pending library
 * work. Scenario steps use it so their calls into the chart count towards frame JavaScript time.
 */
export function requestTimedFrame(callback: FrameCallback): void {
	const p = requireProbe();
	p.nativeRequest(time => runTimed(p, callback, time, false));
}

/**
 * Collects the rAF timestamp of every frame until `stop` is called, including frames in which no
 * library or harness work runs. Its callback is not timed and not counted as library work, so it
 * changes neither frame JavaScript time nor `settle()`.
 */
export function recordFrameTimes(): { stop(): number[] } {
	const p = requireProbe();
	const stamps: number[] = [];
	let active = true;
	const onFrame = (time: number): void => {
		if (active) {
			stamps.push(time);
			p.nativeRequest(onFrame);
		}
	};
	p.nativeRequest(onFrame);
	return {
		stop: () => {
			active = false;
			return stamps;
		},
	};
}

export function startFrameRecording(): void {
	requireProbe().recorder = new FrameRecorder();
}

export function stopFrameRecording(): FrameRecording {
	const p = requireProbe();
	const recorder = p.recorder;
	p.recorder = null;
	if (recorder === null) {
		throw new Error('Frame recording was not started');
	}
	return recorder;
}

/**
 * Resolves after the next frame's rendering work on the main thread has finished: the callback
 * runs in the next animation frame (after any callback requested earlier), and the message it
 * posts is delivered only after that frame's style, layout, paint and commit steps.
 */
export function afterNextFrame(): Promise<void> {
	const p = requireProbe();
	return new Promise(resolve => {
		p.nativeRequest(() => {
			const channel = new MessageChannel();
			channel.port1.addEventListener(
				'message',
				() => {
					channel.port1.close();
					resolve();
				},
				{ once: true },
			);
			channel.port1.start();
			channel.port2.postMessage(null);
		});
	});
}

/**
 * Resolves after the first rendered frame in which a library animation-frame callback ran after
 * `sinceRuns` (a `libraryFrameRuns()` reading). Throws after `maxFrames` frames.
 */
export async function afterLibraryFrame(sinceRuns: number, maxFrames = 600): Promise<void> {
	for (let i = 0; i < maxFrames; i++) {
		await afterNextFrame();
		if (libraryFrameRuns() > sinceRuns) {
			return;
		}
	}
	throw new Error(`Library did not draw within ${maxFrames} frames`);
}

/**
 * Waits until no library animation-frame callback is pending after a rendered frame, which for a
 * library that draws in `requestAnimationFrame` means its pending draws have been painted.
 * Throws after `maxFrames` frames so a library that redraws forever cannot hang a run.
 */
export async function settleFrames(maxFrames = 600): Promise<void> {
	for (let i = 0; i < maxFrames; i++) {
		await afterNextFrame();
		if (pendingFrameCallbacks() === 0) {
			return;
		}
	}
	throw new Error(`Chart did not settle within ${maxFrames} frames`);
}
