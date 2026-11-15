import { describe, expect, it } from 'vitest';
import { cdpHeapUsage, memoryResult, memorySample, splitUserAgentMemory, sumWorkers } from '../src/memory.ts';

const MIB = 2 ** 20;

function pageHeap(used: number) {
	return cdpHeapUsage({ usedSize: used, backingStorageSize: 0, embedderHeapUsedSize: 0 });
}

describe('memory samples', () => {
	it('sums workers and adds them to the page total', () => {
		const page = cdpHeapUsage({ usedSize: 10 * MIB, backingStorageSize: 2 * MIB, embedderHeapUsedSize: MIB });
		expect(page.totalBytes).toBe(13 * MIB);
		const workers = sumWorkers([
			cdpHeapUsage({ usedSize: MIB, backingStorageSize: 46 * MIB, embedderHeapUsedSize: 0 }),
			cdpHeapUsage({ usedSize: MIB, backingStorageSize: 0, embedderHeapUsedSize: 0 }),
		]);
		expect(workers).toEqual({
			count: 2,
			jsHeapBytes: 2 * MIB,
			backingStoreBytes: 46 * MIB,
			embedderHeapBytes: 0,
			totalBytes: 48 * MIB,
		});
		const sample = memorySample('test', page, workers);
		expect(sample.totalBytes).toBe(13 * MIB);
		expect(sample.allTotalBytes).toBe(61 * MIB);
		expect(memorySample('test', page, null).allTotalBytes).toBe(13 * MIB);
	});

	it('reports no workers as zeros, not as unknown', () => {
		expect(sumWorkers([])).toEqual({
			count: 0,
			jsHeapBytes: 0,
			backingStoreBytes: 0,
			embedderHeapBytes: 0,
			totalBytes: 0,
		});
	});

	it('splits measureUserAgentSpecificMemory into the page and its dedicated workers', () => {
		const sample = splitUserAgentMemory({
			bytes: 106 * MIB,
			breakdown: [
				{ bytes: MIB / 4, attribution: [{ scope: 'Window', url: 'http://localhost/' }] },
				{ bytes: MIB / 4, attribution: [] },
				{ bytes: 100 * MIB, attribution: [{ scope: 'DedicatedWorkerGlobalScope', url: 'http://localhost/w.js' }] },
				{ bytes: 5.5 * MIB, attribution: [{ scope: 'DedicatedWorkerGlobalScope', url: 'http://localhost/w.js' }] },
			],
		});
		expect(sample.workers?.count).toBe(1);
		expect(sample.workers?.totalBytes).toBe(105.5 * MIB);
		expect(sample.totalBytes).toBe(MIB / 2);
		expect(sample.allTotalBytes).toBe(106 * MIB);
		expect(sample.backingStoreBytes).toBeNull();
	});
});

describe('memoryResult', () => {
	it('separates what the page and the workers retain', () => {
		const before = memorySample('test', pageHeap(10 * MIB), sumWorkers([]));
		const worker = cdpHeapUsage({ usedSize: MIB, backingStorageSize: 46 * MIB, embedderHeapUsedSize: 0 });
		const after = memorySample('test', pageHeap(11 * MIB), sumWorkers([worker]));
		const result = memoryResult(before, after);
		expect(result?.retainedPageBytes).toBe(MIB);
		expect(result?.retainedWorkerBytes).toBe(47 * MIB);
		expect(result?.retainedBytes).toBe(48 * MIB);
		expect(result?.retainedJsHeapBytes).toBe(MIB);
		expect(result?.retainedBackingStoreBytes).toBe(0);
	});

	it('leaves worker retention unknown when a sample cannot see workers', () => {
		const page = pageHeap(MIB);
		const result = memoryResult(memorySample('test', page, null), memorySample('test', page, sumWorkers([])));
		expect(result?.retainedWorkerBytes).toBeNull();
		expect(memoryResult(null, memorySample('test', page, null))).toBeNull();
	});
});
