import type { MemorySample } from '../jobs.ts';
import { type UserAgentMemory, memorySample, splitUserAgentMemory } from '../memory.ts';
import type { Probes } from './scenarios.ts';

interface PerformanceWithMemory extends Performance {
	measureUserAgentSpecificMemory?: () => Promise<UserAgentMemory>;
	memory?: { usedJSHeapSize: number };
}

/** Which garbage collection and memory sources the page will use. */
export function describeProbes(): { garbageCollection: string; memory: string } {
	const perf = performance as PerformanceWithMemory;
	const garbageCollection =
		window.__benchCollectGarbage !== undefined
			? 'runner: CDP HeapProfiler.collectGarbage'
			: window.gc !== undefined
				? 'page: window.gc (--js-flags=--expose-gc)'
				: 'unavailable';
	const memory =
		window.__benchMeasureMemory !== undefined
			? 'runner: CDP Runtime.getHeapUsage of the page and of each dedicated worker'
			: window.crossOriginIsolated && perf.measureUserAgentSpecificMemory !== undefined
				? 'page: performance.measureUserAgentSpecificMemory (page and dedicated workers)'
				: perf.memory !== undefined
					? 'page: performance.memory.usedJSHeapSize (page only)'
					: 'unavailable';
	return { garbageCollection, memory };
}

async function pageMemory(): Promise<MemorySample | null> {
	const perf = performance as PerformanceWithMemory;
	if (window.crossOriginIsolated && perf.measureUserAgentSpecificMemory !== undefined) {
		// Chromium counts the JavaScript heap and ArrayBuffer backing stores together, not the DOM, and
		// attributes them to the page or to each worker. The promise may only resolve after the next
		// garbage collection (up to about 20 s).
		return splitUserAgentMemory(await perf.measureUserAgentSpecificMemory());
	}
	if (perf.memory !== undefined) {
		const bytes = perf.memory.usedJSHeapSize;
		return memorySample(
			'performance.memory.usedJSHeapSize',
			{ jsHeapBytes: bytes, backingStoreBytes: null, embedderHeapBytes: null, totalBytes: bytes },
			null,
		);
	}
	return null;
}

/** Runner-provided probes when present (precise, over CDP), otherwise what the page can do itself. */
export const probes: Probes = {
	async collectGarbage() {
		if (window.__benchCollectGarbage !== undefined) {
			await window.__benchCollectGarbage();
		} else {
			window.gc?.();
		}
	},
	async measureMemory() {
		if (window.__benchMeasureMemory !== undefined) {
			return window.__benchMeasureMemory();
		}
		return pageMemory();
	},
};
