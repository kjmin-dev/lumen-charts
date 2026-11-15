// Memory samples and what a chart retains, from whatever source measured them. Shared by the page
// and the Node runner, so this module must stay free of DOM and Node APIs.

import type { HeapUsage, MemoryResult, MemorySample, WorkerHeapUsage } from './jobs.ts';

/** The fields of CDP `Runtime.getHeapUsage` the harness uses. */
export interface CdpHeapUsage {
	usedSize: number;
	backingStorageSize: number;
	embedderHeapUsedSize: number;
}

export function cdpHeapUsage(usage: CdpHeapUsage): HeapUsage {
	const { usedSize, backingStorageSize, embedderHeapUsedSize } = usage;
	return {
		jsHeapBytes: usedSize,
		backingStoreBytes: backingStorageSize,
		embedderHeapBytes: embedderHeapUsedSize,
		totalBytes: usedSize + backingStorageSize + embedderHeapUsedSize,
	};
}

function sumNullable(a: number | null, b: number | null): number | null {
	return a === null || b === null ? null : a + b;
}

/** Sums the heaps of several workers. No workers give zeros: the page had none running. */
export function sumWorkers(heaps: readonly HeapUsage[]): WorkerHeapUsage {
	const sum: WorkerHeapUsage = { count: 0, jsHeapBytes: 0, backingStoreBytes: 0, embedderHeapBytes: 0, totalBytes: 0 };
	for (const heap of heaps) {
		sum.count++;
		sum.jsHeapBytes += heap.jsHeapBytes;
		sum.backingStoreBytes = sumNullable(sum.backingStoreBytes, heap.backingStoreBytes);
		sum.embedderHeapBytes = sumNullable(sum.embedderHeapBytes, heap.embedderHeapBytes);
		sum.totalBytes += heap.totalBytes;
	}
	return sum;
}

export function memorySample(method: string, page: HeapUsage, workers: WorkerHeapUsage | null): MemorySample {
	return { method, ...page, workers, allTotalBytes: page.totalBytes + (workers?.totalBytes ?? 0) };
}

/** What `performance.measureUserAgentSpecificMemory` resolves with (the parts the harness reads). */
export interface UserAgentMemory {
	bytes: number;
	breakdown: readonly {
		bytes: number;
		attribution: readonly { scope?: string; url?: string }[];
	}[];
}

/**
 * Splits a `measureUserAgentSpecificMemory` result into the page and its dedicated workers. An entry
 * belongs to the workers when every realm it is attributed to is a dedicated worker; everything else,
 * including memory shared between realms, stays with the page. Chromium counts the JavaScript heap
 * and ArrayBuffer backing stores together here, without the DOM.
 */
export function splitUserAgentMemory(result: UserAgentMemory): MemorySample {
	let workerBytes = 0;
	const workers = new Set<string>();
	for (const entry of result.breakdown) {
		const { attribution } = entry;
		if (attribution.length > 0 && attribution.every(a => a.scope === 'DedicatedWorkerGlobalScope')) {
			workerBytes += entry.bytes;
			for (const a of attribution) {
				workers.add(a.url ?? '');
			}
		}
	}
	const pageBytes = result.bytes - workerBytes;
	return memorySample(
		'performance.measureUserAgentSpecificMemory (JavaScript heap and ArrayBuffers combined)',
		{ jsHeapBytes: pageBytes, backingStoreBytes: null, embedderHeapBytes: null, totalBytes: pageBytes },
		{
			// Workers with the same script URL cannot be told apart here.
			count: workers.size,
			jsHeapBytes: workerBytes,
			backingStoreBytes: null,
			embedderHeapBytes: null,
			totalBytes: workerBytes,
		},
	);
}

function difference(after: number | null, before: number | null): number | null {
	return after === null || before === null ? null : after - before;
}

/** What the chart retains between two samples, or null if either is missing. */
export function memoryResult(before: MemorySample | null, after: MemorySample | null): MemoryResult | null {
	if (before === null || after === null) {
		return null;
	}
	return {
		before,
		after,
		retainedBytes: after.allTotalBytes - before.allTotalBytes,
		retainedPageBytes: after.totalBytes - before.totalBytes,
		retainedWorkerBytes: difference(after.workers?.totalBytes ?? null, before.workers?.totalBytes ?? null),
		retainedJsHeapBytes: after.jsHeapBytes - before.jsHeapBytes,
		retainedBackingStoreBytes: difference(after.backingStoreBytes, before.backingStoreBytes),
		retainedEmbedderHeapBytes: difference(after.embedderHeapBytes, before.embedderHeapBytes),
	};
}
