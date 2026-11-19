// Turns what `pnpm bench --allocations` records of one run into a summary of what the page's main
// thread allocated during the measured part and of how often it collected: a sampling heap profile
// (CDP `HeapProfiler`, with the objects that were collected meanwhile kept in it) and the garbage
// collection events of a trace. Bytes and counts depend on the code, not on how busy the machine
// is, so they compare between runs where times do not. Pure functions, tested in Node.

import {
	type CallFrame,
	MEASURE_END_MARK,
	MEASURE_START_MARK,
	type SourceResolver,
	type TraceEvent,
} from './profile.ts';

/**
 * Trace categories that hold the garbage collection events and the measure marks. The timeline's
 * own category is left out: it records every task, and a tick run that waits a task at a time
 * fills the trace buffer with them before it ends.
 */
export const ALLOCATION_TRACE_CATEGORIES = ['blink.user_timing', 'v8'];

/** A node of a sampling heap profile (`HeapProfiler.SamplingHeapProfileNode`). */
export interface SamplingNode {
	callFrame: CallFrame;
	/** Bytes allocated by this function itself, scaled up from the samples. */
	selfSize: number;
	children: SamplingNode[];
}

/** Who a call site belongs to. */
export type AllocationOwner = 'library' | 'harness' | 'other scripts' | 'outside JavaScript';

export interface AllocationSite {
	/** The innermost function with a source file on the allocating stack. */
	function: string;
	source: string | null;
	owner: AllocationOwner;
	bytes: number;
}

export interface CollectionStats {
	count: number;
	/** Milliseconds of the main thread, all collections together. */
	totalMs: number;
	maxMs: number;
	/** Bytes of the JavaScript heap the collections freed. */
	freedBytes: number;
}

export interface AllocationSummary {
	/** Length of the measured part, between the two marks, in milliseconds. */
	windowMs: number;
	/** Ticks applied in the measured part. */
	ticks: number;
	/** Bytes allocated on the JavaScript heap of the main thread in the measured part (sampled). */
	bytes: number;
	/** The same per tick, and by who allocated them. */
	bytesPerTick: number;
	ownersPerTick: Record<AllocationOwner, number>;
	owners: Record<AllocationOwner, number>;
	/** Call sites by bytes, largest first. */
	sites: AllocationSite[];
	/** Garbage collections of the main thread in the measured part. */
	minor: CollectionStats;
	major: CollectionStats;
}

/** Owner of a source file, as the source maps of the harness build name it. */
export function ownerOf(source: string | null): AllocationOwner {
	if (source === null) {
		return 'outside JavaScript';
	}
	if (/(^|\/)packages\/(core|engine)\/src\//.test(source)) {
		return 'library';
	}
	if (/(^|\/)benchmarks\/(src|runner)\//.test(source)) {
		return 'harness';
	}
	return 'other scripts';
}

/**
 * Bytes per call site of a sampling heap profile. An allocation belongs to the innermost function
 * on its stack that has a source file: memory a built-in allocates (`slice`, a `Map`) counts for
 * the function that called it. Allocations with no such function on the stack are made by the
 * browser outside JavaScript: the objects of a message it deserializes, the events it dispatches.
 */
export function allocationSites(head: SamplingNode, resolve: SourceResolver): AllocationSite[] {
	const sites = new Map<string, AllocationSite>();
	const visit = (node: SamplingNode, inherited: { function: string; source: string | null }): void => {
		const source = node.callFrame.url === '' ? null : resolve(node.callFrame);
		const site = source === null ? inherited : { function: node.callFrame.functionName || '(anonymous)', source };
		if (node.selfSize > 0) {
			const key = `${site.source ?? ''}\n${site.function}`;
			const known = sites.get(key);
			if (known === undefined) {
				sites.set(key, { ...site, owner: ownerOf(site.source), bytes: node.selfSize });
			} else {
				known.bytes += node.selfSize;
			}
		}
		for (const child of node.children) {
			visit(child, site);
		}
	};
	visit(head, { function: '(outside JavaScript)', source: null });
	const list = [...sites.values()];
	list.sort((a, b) => b.bytes - a.bytes);
	return list;
}

function emptyStats(): CollectionStats {
	return { count: 0, totalMs: 0, maxMs: 0, freedBytes: 0 };
}

/**
 * Summarizes the allocations and collections between the last pair of measure marks. Throws when
 * the trace has no such pair.
 */
export function summarizeAllocations(
	head: SamplingNode,
	ticks: number,
	events: readonly TraceEvent[],
	resolve: SourceResolver,
	topCount = 30,
): AllocationSummary {
	let start = NaN;
	let end = NaN;
	let pid = -1;
	let tid = -1;
	for (const event of events) {
		if (event.name === MEASURE_START_MARK) {
			start = event.ts;
			end = NaN;
			pid = event.pid;
			tid = event.tid;
		} else if (event.name === MEASURE_END_MARK) {
			end = event.ts;
		}
	}
	if (!(end > start)) {
		throw new Error('The trace has no pair of measure marks');
	}
	const minor = emptyStats();
	const major = emptyStats();
	for (const event of events) {
		if (event.pid !== pid || event.tid !== tid || event.ph !== 'X' || event.dur === undefined) {
			continue;
		}
		if ((event.name !== 'MinorGC' && event.name !== 'MajorGC') || event.ts < start || event.ts > end) {
			continue;
		}
		const stats = event.name === 'MinorGC' ? minor : major;
		const args = event.args as { usedHeapSizeBefore?: number; usedHeapSizeAfter?: number } | undefined;
		stats.count++;
		stats.totalMs += event.dur / 1000;
		stats.maxMs = Math.max(stats.maxMs, event.dur / 1000);
		stats.freedBytes += Math.max(0, (args?.usedHeapSizeBefore ?? 0) - (args?.usedHeapSizeAfter ?? 0));
	}
	const sites = allocationSites(head, resolve);
	const owners: Record<AllocationOwner, number> = {
		library: 0,
		harness: 0,
		'other scripts': 0,
		'outside JavaScript': 0,
	};
	let bytes = 0;
	for (const site of sites) {
		owners[site.owner] += site.bytes;
		bytes += site.bytes;
	}
	const perTick = (value: number): number => (ticks > 0 ? Math.round(value / ticks) : 0);
	return {
		windowMs: (end - start) / 1000,
		ticks,
		bytes,
		bytesPerTick: perTick(bytes),
		ownersPerTick: {
			library: perTick(owners.library),
			harness: perTick(owners.harness),
			'other scripts': perTick(owners['other scripts']),
			'outside JavaScript': perTick(owners['outside JavaScript']),
		},
		owners,
		sites: sites.slice(0, topCount),
		minor,
		major,
	};
}

function collections(stats: CollectionStats): string {
	return `${stats.count} (${stats.totalMs.toFixed(1)} ms, longest ${stats.maxMs.toFixed(1)})`;
}

/** The line the runner prints per run. */
export function allocationsHeadline(summary: AllocationSummary): string {
	const { ownersPerTick: per, minor, major } = summary;
	return (
		`allocated per tick: ${summary.bytesPerTick} B (library ${per.library}, harness ${per.harness}, ` +
		`outside JavaScript ${per['outside JavaScript']}, other ${per['other scripts']}); ` +
		`collections: minor ${collections(minor)}, major ${collections(major)}`
	);
}
