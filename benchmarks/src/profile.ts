// Turns a Chromium trace of one benchmark run into a breakdown of where the time went: CPU samples
// of every thread by category, the animation frames, garbage collections and the time each thread
// was busy. Pure functions over parsed trace events, so they run in Node and are tested there.

/** Performance marks the harness page sets around the measured part of a run. */
export const MEASURE_START_MARK = 'bench:measure:start';
export const MEASURE_END_MARK = 'bench:measure:end';

/** Trace categories `pnpm bench --profile` records. */
export const TRACE_CATEGORIES = [
	'devtools.timeline',
	'disabled-by-default-devtools.timeline',
	'disabled-by-default-v8.cpu_profiler',
	'blink.user_timing',
	'toplevel',
	'v8',
	'gpu',
];

export interface TraceEvent {
	pid: number;
	tid: number;
	/** Microseconds. */
	ts: number;
	ph: string;
	cat?: string;
	name: string;
	dur?: number;
	id?: string;
	args?: Record<string, unknown>;
}

export interface CallFrame {
	functionName: string;
	url: string;
	lineNumber?: number;
	columnNumber?: number;
}

/** Path of the source file a call frame was compiled from, or null for native frames and unknown scripts. */
export type SourceResolver = (frame: CallFrame) => string | null;

export interface Distribution {
	count: number;
	mean: number;
	p50: number;
	p95: number;
	p99: number;
	max: number;
}

export interface FunctionTime {
	name: string;
	source: string | null;
	category: string;
	selfMs: number;
}

export interface ThreadProfile {
	process: string;
	thread: string;
	/** Time the samples inside the measured part stand for, idle included. */
	sampledMs: number;
	/** The sampling interval, in microseconds: the median distance between two regular samples. */
	sampleIntervalUs: number;
	/** Self time per category in milliseconds, idle left out, largest first. */
	categories: Record<string, number>;
	/** Self time per category inside animation-frame callbacks only (main thread). */
	frameCategories: Record<string, number> | null;
	top: FunctionTime[];
}

export interface ThreadBusy {
	process: string;
	thread: string;
	/** Time inside top-level trace events (tasks) in the measured part. */
	busyMs: number;
	/** Of which garbage collection events. */
	gcMs: number;
}

export interface TraceSummary {
	/** Length of the measured part, between the two marks. */
	windowMs: number;
	/**
	 * JavaScript time of the animation frames on the page's main thread, in milliseconds: the
	 * callbacks of one frame added up.
	 */
	frames: Distribution | null;
	threads: ThreadBusy[];
	profiles: ThreadProfile[];
}

function distribution(values: number[]): Distribution | null {
	if (values.length === 0) {
		return null;
	}
	const ordered = [...values];
	ordered.sort((a, b) => a - b);
	const at = (q: number): number => ordered[Math.min(ordered.length - 1, Math.ceil(q * ordered.length) - 1)] ?? 0;
	let sum = 0;
	for (const value of ordered) {
		sum += value;
	}
	return {
		count: ordered.length,
		mean: sum / ordered.length,
		p50: at(0.5),
		p95: at(0.95),
		p99: at(0.99),
		max: ordered[ordered.length - 1] ?? 0,
	};
}

const CANVAS_CALLS = new Set([
	'lineTo',
	'moveTo',
	'stroke',
	'fill',
	'fillRect',
	'strokeRect',
	'clearRect',
	'beginPath',
	'closePath',
	'rect',
	'arc',
	'fillText',
	'measureText',
	'save',
	'restore',
	'clip',
	'setLineDash',
	'setTransform',
	'drawImage',
	'putImageData',
	'getContext',
	'set fillStyle',
	'set strokeStyle',
	'set lineWidth',
	'set lineJoin',
	'set font',
	'set globalAlpha',
	'set textAlign',
	'set textBaseline',
	'set width',
	'set height',
]);

const MESSAGING_CALLS = new Set(['postMessage', 'structuredClone', 'get data']);

const CHART_FUNCTIONS: Record<string, string> = {
	_renderPane: 'series layer: drawing',
	_renderOverlay: 'overlay',
	_renderAxes: 'grid, axes and labels',
	_renderWatermark: 'grid, axes and labels',
	_renderMarkers: 'overlay',
	_axisTag: 'overlay',
	_renderDrawings: 'drawings and primitives',
	_syncPrimitives: 'drawings and primitives',
	_updateModel: 'model: scales, ticks, autoscale',
	_includeSeries: 'model: scales, ticks, autoscale',
	_fitPriceAxes: 'model: scales, ticks, autoscale',
	_requestWindow: 'window cache and patches',
};

const SOURCE_CATEGORIES: [RegExp, string][] = [
	[/packages\/core\/src\/render\/(series|pane)\.ts$/, 'series layer: drawing'],
	[/packages\/core\/src\/render\/overlay\.ts$/, 'overlay'],
	[/packages\/core\/src\/render\/axes\.ts$/, 'grid, axes and labels'],
	[/packages\/core\/src\/views\//, 'series layer: items and coordinates'],
	[/packages\/core\/src\/render\/(chrome|sessions|layer)\.ts$/, 'grid, axes and labels'],
	[/packages\/core\/src\/(render\/primitive-host|primitives)\.ts$/, 'drawings and primitives'],
	[/packages\/core\/src\/drawings\//, 'drawings and primitives'],
	[/packages\/core\/src\/data\//, 'window cache and patches'],
	[/packages\/core\/src\/model\//, 'model: scales, ticks, autoscale'],
	[/packages\/core\/src\/input\//, 'input'],
	[/packages\/core\/src\//, 'chart: other'],
	[/packages\/engine\/src\/indicators\/kernels\.ts$/, 'engine: indicator kernels'],
	[/packages\/engine\/src\/indicators\//, 'engine: indicator runner and engine'],
	[/packages\/engine\/src\/pyramid\.ts$/, 'engine: levels of detail'],
	[/packages\/engine\/src\/(client|pool)\.ts$/, 'engine client: messages'],
	[/packages\/engine\/src\/(host|worker)\.ts$/, 'engine host: messages and scheduling'],
	[/packages\/engine\/src\//, 'engine: store and commands'],
	[/benchmarks\//, 'harness'],
];

/**
 * Category of a call frame. `parent` is the category of the nearest caller with a source file, which
 * decides where a native canvas call belongs.
 */
export function categorize(frame: CallFrame, source: string | null, parent: string | null): string {
	const name = frame.functionName;
	if (source === null) {
		if (name === '(idle)') {
			return 'idle';
		}
		if (name === '(garbage collector)') {
			return 'garbage collection';
		}
		if (name === '(program)' || name === '(root)') {
			return 'browser: outside JavaScript';
		}
		if (CANVAS_CALLS.has(name)) {
			return parent === 'series layer: drawing' ? 'series layer: Canvas 2D calls' : 'other layers: Canvas 2D calls';
		}
		if (MESSAGING_CALLS.has(name)) {
			return 'messages: postMessage and structured clone';
		}
		return frame.url === '' ? 'other native calls' : 'other scripts';
	}
	if (source.endsWith('packages/core/src/chart.ts')) {
		return CHART_FUNCTIONS[name] ?? 'chart: other';
	}
	for (const [pattern, category] of SOURCE_CATEGORIES) {
		if (pattern.test(source)) {
			return category;
		}
	}
	return 'other scripts';
}

interface ProfileNode {
	id: number;
	parent?: number;
	callFrame: CallFrame;
}

interface ThreadSamples {
	pid: number;
	tid: number;
	startTime: number;
	nodes: Map<number, ProfileNode>;
	samples: number[];
	deltas: number[];
}

function sorted(record: Map<string, number>): Record<string, number> {
	const entries = [...record];
	entries.sort((a, b) => b[1] - a[1]);
	return Object.fromEntries(entries.map(([key, us]) => [key, us / 1000]));
}

/** Distances between two samples in this range, in microseconds, are the sampler's own. */
const MIN_REGULAR_US = 50;
const MAX_REGULAR_US = 2000;

/** Longest gap between two animation-frame callbacks of the same frame, in microseconds. */
const SAME_FRAME_US = 2000;

/** Total length of the union of `[start, end)` intervals, which must be sorted by start. */
function unionLength(intervals: [number, number][]): number {
	let total = 0;
	let reach = -Infinity;
	for (const [start, end] of intervals) {
		if (end <= reach) {
			continue;
		}
		total += end - Math.max(start, reach);
		reach = end;
	}
	return total;
}

/**
 * Summarizes the part of a trace between the last pair of measure marks. Throws when the marks are
 * missing (the trace buffer filled up before the run ended, or the scenario sets none).
 */
export function summarizeTrace(events: readonly TraceEvent[], resolve: SourceResolver, topCount = 25): TraceSummary {
	let start = NaN;
	let end = NaN;
	let mainPid = -1;
	let mainTid = -1;
	for (const event of events) {
		if (event.name === MEASURE_START_MARK) {
			start = event.ts;
			end = NaN;
			mainPid = event.pid;
			mainTid = event.tid;
		} else if (event.name === MEASURE_END_MARK) {
			end = event.ts;
		}
	}
	if (!(end > start)) {
		throw new Error('The trace has no pair of measure marks');
	}

	const threadNames = new Map<string, string>();
	const processNames = new Map<number, string>();
	const profiles = new Map<string, ThreadSamples>();
	const chunks: TraceEvent[] = [];
	const frameIntervals: [number, number][] = [];
	const tasks = new Map<string, [number, number][]>();
	const gc = new Map<string, number>();
	for (const event of events) {
		const key = `${event.pid}:${event.tid}`;
		if (event.ph === 'M') {
			const name = (event.args as { name?: string } | undefined)?.name ?? '';
			if (event.name === 'thread_name') {
				threadNames.set(key, name);
			} else if (event.name === 'process_name') {
				processNames.set(event.pid, name);
			}
		} else if (event.name === 'Profile') {
			const data = (event.args as { data?: { startTime?: number } }).data;
			profiles.set(`${event.pid}:${event.id}`, {
				pid: event.pid,
				tid: event.tid,
				startTime: data?.startTime ?? event.ts,
				nodes: new Map(),
				samples: [],
				deltas: [],
			});
		} else if (event.name === 'ProfileChunk') {
			chunks.push(event);
		} else if (event.ph === 'X' && event.dur !== undefined) {
			const from = Math.max(event.ts, start);
			const to = Math.min(event.ts + event.dur, end);
			if (to <= from) {
				continue;
			}
			let list = tasks.get(key);
			if (list === undefined) {
				list = [];
				tasks.set(key, list);
			}
			list.push([from, to]);
			if (event.name === 'MinorGC' || event.name === 'MajorGC') {
				gc.set(key, (gc.get(key) ?? 0) + to - from);
			}
			if (event.name === 'FireAnimationFrame' && event.pid === mainPid && event.tid === mainTid) {
				frameIntervals.push([event.ts, event.ts + event.dur]);
			}
		}
	}
	chunks.sort((a, b) => a.ts - b.ts);
	for (const chunk of chunks) {
		const profile = profiles.get(`${chunk.pid}:${chunk.id}`);
		const data = (
			chunk.args as { data?: { cpuProfile?: { nodes?: ProfileNode[]; samples?: number[] }; timeDeltas?: number[] } }
		).data;
		if (profile === undefined || data === undefined) {
			continue;
		}
		for (const node of data.cpuProfile?.nodes ?? []) {
			profile.nodes.set(node.id, node);
		}
		profile.samples.push(...(data.cpuProfile?.samples ?? []));
		profile.deltas.push(...(data.timeDeltas ?? []));
	}

	const name = (pid: number, tid: number): { process: string; thread: string } => ({
		process: processNames.get(pid) ?? String(pid),
		thread: threadNames.get(`${pid}:${tid}`) ?? String(tid),
	});

	const threads: ThreadBusy[] = [];
	for (const [key, list] of tasks) {
		const [pid, tid] = key.split(':').map(Number) as [number, number];
		list.sort((a, b) => a[0] - b[0]);
		const busyMs = unionLength(list) / 1000;
		if (busyMs >= 0.05) {
			threads.push({ ...name(pid, tid), busyMs, gcMs: (gc.get(key) ?? 0) / 1000 });
		}
	}
	threads.sort((a, b) => b.busyMs - a.busyMs);

	frameIntervals.sort((a, b) => a[0] - b[0]);
	// Callbacks of one frame run back to back; frames are at least a refresh interval apart.
	const frames: number[] = [];
	let previousEnd = -Infinity;
	for (const [from, to] of frameIntervals) {
		if (from < start || to > end) {
			continue;
		}
		if (from - previousEnd < SAME_FRAME_US && frames.length > 0) {
			frames[frames.length - 1]! += (to - from) / 1000;
		} else {
			frames.push((to - from) / 1000);
		}
		previousEnd = to;
	}
	const threadProfiles: ThreadProfile[] = [];
	for (const profile of profiles.values()) {
		const isMain = profile.pid === mainPid && profile.tid === mainTid;
		const sources = new Map<number, string | null>();
		const categories = new Map<number, string>();
		const categoryOf = (id: number): string => {
			const known = categories.get(id);
			if (known !== undefined) {
				return known;
			}
			const node = profile.nodes.get(id);
			if (node === undefined) {
				return 'other scripts';
			}
			const source = node.callFrame.url === '' ? null : resolve(node.callFrame);
			sources.set(id, source);
			// The nearest caller that has a source file says which part of the library a native call serves.
			let parent: string | null = null;
			for (let up = node.parent; up !== undefined; up = profile.nodes.get(up)?.parent) {
				const category = categoryOf(up);
				if (sources.get(up) !== null && sources.get(up) !== undefined) {
					parent = category;
					break;
				}
			}
			const category = categorize(node.callFrame, source, parent);
			categories.set(id, category);
			return category;
		};
		// Children know their parent only through the parent's `children` in some Chromium versions.
		for (const node of profile.nodes.values()) {
			for (const child of (node as ProfileNode & { children?: number[] }).children ?? []) {
				const childNode = profile.nodes.get(child);
				if (childNode !== undefined && childNode.parent === undefined) {
					childNode.parent = node.id;
				}
			}
		}

		const byCategory = new Map<string, number>();
		const inFrames = new Map<string, number>();
		const byFunction = new Map<number, number>();
		let sampled = 0;
		let frame = 0;
		// Deltas can be negative where two chunks meet, so samples are put in order of time first.
		const stamped: [number, number][] = [];
		let clock = profile.startTime;
		for (let i = 0; i < profile.samples.length; i++) {
			clock += profile.deltas[i] ?? 0;
			stamped.push([clock, profile.samples[i]!]);
		}
		stamped.sort((a, b) => a[0] - b[0]);
		// The sampler runs at a fixed interval, but V8 adds samples of its own in between (many on a
		// thread that runs short tasks back to back), and on a busy machine the sampler is late now and
		// then. The interval is the median of the distances that are neither.
		const regular: number[] = [];
		for (let i = 0; i + 1 < stamped.length; i++) {
			const distance = stamped[i + 1]![0] - stamped[i]![0];
			if (distance >= MIN_REGULAR_US && distance < MAX_REGULAR_US) {
				regular.push(distance);
			}
		}
		regular.sort((a, b) => a - b);
		const interval = regular[regular.length >> 1] ?? 0;
		for (let i = 0; i + 1 < stamped.length; i++) {
			const [time, id] = stamped[i]!;
			if (time < start || time >= end) {
				continue;
			}
			// A sample stands for the time until the next one, but for no more than two intervals:
			// what ran while the sampler was late is unknown, and is left out.
			const next = Math.min(stamped[i + 1]![0] - time, 2 * interval);
			const category = categoryOf(id);
			sampled += next;
			if (category === 'idle') {
				continue;
			}
			byCategory.set(category, (byCategory.get(category) ?? 0) + next);
			byFunction.set(id, (byFunction.get(id) ?? 0) + next);
			if (isMain) {
				while (frame < frameIntervals.length && frameIntervals[frame]![1] <= time) {
					frame++;
				}
				const current = frameIntervals[frame];
				if (current !== undefined && current[0] <= time) {
					inFrames.set(category, (inFrames.get(category) ?? 0) + next);
				}
			}
		}
		if (byCategory.size === 0) {
			continue;
		}
		// The same function appears once per call path: add those up.
		const functions = new Map<string, FunctionTime>();
		for (const [id, us] of byFunction) {
			const node = profile.nodes.get(id)!;
			const source = sources.get(id) ?? null;
			const category = categoryOf(id);
			const key = `${node.callFrame.functionName}|${source ?? ''}|${category}`;
			const entry = functions.get(key);
			if (entry === undefined) {
				functions.set(key, {
					name: node.callFrame.functionName || '(anonymous)',
					source,
					category,
					selfMs: us / 1000,
				});
			} else {
				entry.selfMs += us / 1000;
			}
		}
		const top = [...functions.values()];
		top.sort((a, b) => b.selfMs - a.selfMs);
		threadProfiles.push({
			...name(profile.pid, profile.tid),
			sampledMs: sampled / 1000,
			sampleIntervalUs: interval,
			categories: sorted(byCategory),
			frameCategories: isMain ? sorted(inFrames) : null,
			top: top.slice(0, topCount),
		});
	}
	threadProfiles.sort(
		(a, b) =>
			Object.values(b.categories).reduce((x, y) => x + y, 0) - Object.values(a.categories).reduce((x, y) => x + y, 0),
	);

	return { windowMs: (end - start) / 1000, frames: distribution(frames), threads, profiles: threadProfiles };
}
