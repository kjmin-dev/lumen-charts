import type { ChartSize } from '../adapter.ts';
import { type Distribution, summarize } from '../stats.ts';
import { afterNextFrame } from './frames.ts';

export interface TimerResolution {
	/** Smallest non-zero step between two consecutive `performance.now()` readings. */
	minStepMs: number;
	/** Median non-zero step. */
	medianStepMs: number;
	/** Number of steps observed. */
	steps: number;
}

export interface PageEnvironment {
	userAgent: string;
	/** `navigator.userAgentData` high-entropy values where the browser has them. */
	userAgentData: Record<string, unknown> | null;
	devicePixelRatio: number;
	viewport: ChartSize;
	screen: ChartSize;
	chart: ChartSize;
	hardwareConcurrency: number;
	deviceMemoryGb: number | null;
	crossOriginIsolated: boolean;
	timer: TimerResolution;
	/** Intervals between animation frames on the idle page: shows the refresh rate or frame cap. */
	idleFrameInterval: Distribution;
	webgl: { vendor: string; renderer: string } | null;
	/** `production` for `vite build` output, `development` for the dev server. */
	buildMode: string;
	/** Garbage collection and memory sources available to the page. */
	probes: { garbageCollection: string; memory: string };
}

/**
 * Reads `performance.now()` in a tight loop and records each change. Browsers coarsen the clock
 * (Chromium: 5 µs with cross-origin isolation, 100 µs without), so the smallest step is the
 * effective resolution.
 */
export function measureTimerResolution(maxSteps = 2000, budgetMs = 250): TimerResolution {
	const steps: number[] = [];
	const deadline = performance.now() + budgetMs;
	let last = performance.now();
	while (steps.length < maxSteps) {
		const now = performance.now();
		if (now !== last) {
			steps.push(now - last);
			last = now;
			if (now > deadline) {
				break;
			}
		}
	}
	const summary = summarize(steps);
	return { minStepMs: summary.min, medianStepMs: summary.p50, steps: summary.count };
}

async function idleFrameIntervals(frames: number): Promise<Distribution> {
	const stamps: number[] = [];
	await new Promise<void>(resolve => {
		const onFrame = (time: number): void => {
			stamps.push(time);
			if (stamps.length > frames) {
				resolve();
			} else {
				requestAnimationFrame(onFrame);
			}
		};
		requestAnimationFrame(onFrame);
	});
	return summarize(stamps.slice(1).map((t, i) => t - (stamps[i] ?? t)));
}

function webglInfo(): { vendor: string; renderer: string } | null {
	const canvas = document.createElement('canvas');
	const gl = canvas.getContext('webgl');
	if (gl === null) {
		return null;
	}
	const debug = gl.getExtension('WEBGL_debug_renderer_info');
	const vendor = String(gl.getParameter(debug === null ? gl.VENDOR : debug.UNMASKED_VENDOR_WEBGL));
	const renderer = String(gl.getParameter(debug === null ? gl.RENDERER : debug.UNMASKED_RENDERER_WEBGL));
	gl.getExtension('WEBGL_lose_context')?.loseContext();
	return { vendor, renderer };
}

interface UserAgentDataLike {
	getHighEntropyValues(hints: string[]): Promise<Record<string, unknown>>;
}

async function userAgentData(): Promise<Record<string, unknown> | null> {
	const data = (navigator as Navigator & { userAgentData?: UserAgentDataLike }).userAgentData;
	if (data === undefined) {
		return null;
	}
	try {
		return await data.getHighEntropyValues(['architecture', 'model', 'platformVersion', 'fullVersionList']);
	} catch {
		return null;
	}
}

export async function collectEnvironment(
	chart: ChartSize,
	probes: PageEnvironment['probes'],
	buildMode: string,
): Promise<PageEnvironment> {
	await afterNextFrame();
	const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
	return {
		userAgent: navigator.userAgent,
		userAgentData: await userAgentData(),
		devicePixelRatio: window.devicePixelRatio,
		viewport: { width: window.innerWidth, height: window.innerHeight },
		screen: { width: window.screen.width, height: window.screen.height },
		chart,
		hardwareConcurrency: navigator.hardwareConcurrency,
		deviceMemoryGb: deviceMemory ?? null,
		crossOriginIsolated: window.crossOriginIsolated,
		timer: measureTimerResolution(),
		idleFrameInterval: await idleFrameIntervals(120),
		webgl: webglInfo(),
		buildMode,
		probes,
	};
}
