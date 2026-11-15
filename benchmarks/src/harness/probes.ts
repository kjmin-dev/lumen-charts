import type { MemorySample } from '../jobs.ts';
import type { Probes } from './scenarios.ts';

interface PerformanceWithMemory extends Performance {
	measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
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
			? 'runner: CDP Runtime.getHeapUsage'
			: window.crossOriginIsolated && perf.measureUserAgentSpecificMemory !== undefined
				? 'page: performance.measureUserAgentSpecificMemory'
				: perf.memory !== undefined
					? 'page: performance.memory.usedJSHeapSize'
					: 'unavailable';
	return { garbageCollection, memory };
}

async function pageMemory(): Promise<MemorySample | null> {
	const perf = performance as PerformanceWithMemory;
	if (window.crossOriginIsolated && perf.measureUserAgentSpecificMemory !== undefined) {
		// Chromium counts the JavaScript heap and ArrayBuffer backing stores together, not the DOM.
		// The promise may only resolve after the next garbage collection (up to about 20 s).
		const { bytes } = await perf.measureUserAgentSpecificMemory();
		return {
			method: 'performance.measureUserAgentSpecificMemory (JavaScript heap and ArrayBuffers combined)',
			jsHeapBytes: bytes,
			backingStoreBytes: null,
			embedderHeapBytes: null,
			totalBytes: bytes,
		};
	}
	if (perf.memory !== undefined) {
		const bytes = perf.memory.usedJSHeapSize;
		return {
			method: 'performance.memory.usedJSHeapSize',
			jsHeapBytes: bytes,
			backingStoreBytes: null,
			embedderHeapBytes: null,
			totalBytes: bytes,
		};
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
