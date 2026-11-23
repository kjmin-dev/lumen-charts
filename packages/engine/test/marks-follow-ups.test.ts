import {
	type EngineClient,
	type HeatmapColumns,
	HeatmapStore,
	MARK_COLUMNS,
	type MarksFetchRequest,
	type MarksOutcome,
	type MarksUpdate,
	MarksEngine,
	type ScatterRows,
	ScatterStore,
	createEngine,
} from '@lumen-charts/engine';
import { describe, expect, it } from 'vitest';
import { blankUpdate, drain, heat, random, request, rows, trades } from './marks-helpers';

function outcome(): MarksOutcome {
	return { rejected: 0 };
}

function readLevel(store: ScatterStore | HeatmapStore, l: number): MarksUpdate {
	const update = blankUpdate();
	store.read(l, store.first(l), store.first(l) + store.total(l), update);
	return update;
}

function betweenScatter(data: ScatterRows, from: number, to: number): ScatterRows {
	const keep: number[] = [];
	for (let i = 0; i < data.count; i++) {
		if (data.time[i]! >= from && data.time[i]! <= to) {
			keep.push(i);
		}
	}
	return {
		kind: 'scatter',
		count: keep.length,
		time: Float64Array.from(keep, i => data.time[i]!),
		price: Float64Array.from(keep, i => data.price[i]!),
		value: data.value === null ? null : Float32Array.from(keep, i => data.value![i]!),
		size: data.size == null ? null : Float32Array.from(keep, i => data.size![i]!),
	};
}

function betweenHeat(data: HeatmapColumns, from: number, to: number): HeatmapColumns {
	const keep: number[] = [];
	for (let i = 0; i < data.count; i++) {
		if (data.time[i]! >= from && data.time[i]! <= to) {
			keep.push(i);
		}
	}
	const values = new Float32Array(keep.length * data.rows);
	keep.forEach((c, i) => values.set(data.values.subarray(c * data.rows, (c + 1) * data.rows), i * data.rows));
	return {
		...data,
		count: keep.length,
		time: Float64Array.from(keep, i => data.time[i]!),
		offsets: data.offsets == null ? null : Int32Array.from(keep, i => data.offsets![i]!),
		values,
	};
}

interface ExpectedCell {
	value: number;
	count: number;
	size: number;
	tMin: number;
	tMax: number;
	pMin: number;
	pMax: number;
}

/** Verifies every coarse scatter level has exact values, counts, sizes and [tMin, tMax, pMin, pMax] bounds. */
function expectExactScatterLevels(store: ScatterStore): void {
	const points = readLevel(store, 0);
	expect(points.bounds.length).toBe(0);
	for (let l = 1; l <= store.levels; l++) {
		const cells = readLevel(store, l);
		expect(cells.bounds.length).toBe(cells.count * 4);
		const expected = new Map<string, ExpectedCell>();
		for (let i = 0; i < points.count; i++) {
			const t = points.time[i]!;
			const p = points.price[i]!;
			const v = points.values[i]!;
			const s = points.sizes.length > 0 ? points.sizes[i]! : Number.NaN;
			const key = `${Math.floor(t / cells.timeStep)}:${Math.floor(p / cells.priceStep)}`;
			const held = expected.get(key);
			if (held === undefined) {
				expected.set(key, { value: v, count: 1, size: s, tMin: t, tMax: t, pMin: p, pMax: p });
			} else {
				if (v === v && !(held.value >= v)) held.value = v;
				if (s === s && !(held.size >= s)) held.size = s;
				held.count++;
				held.tMin = Math.min(held.tMin, t);
				held.tMax = Math.max(held.tMax, t);
				held.pMin = Math.min(held.pMin, p);
				held.pMax = Math.max(held.pMax, p);
			}
		}
		expect(cells.count).toBe(expected.size);
		let wrong = 0;
		for (let i = 0; i < cells.count; i++) {
			const key = `${Math.floor(cells.time[i]! / cells.timeStep)}:${Math.floor(cells.price[i]! / cells.priceStep)}`;
			const cell = expected.get(key);
			const size = cells.sizes.length > 0 ? cells.sizes[i]! : Number.NaN;
			const b = i * 4;
			if (
				cell === undefined ||
				!Object.is(cells.values[i]!, cell.value) ||
				cells.counts[i] !== cell.count ||
				!Object.is(size, cell.size) ||
				cells.bounds[b] !== cell.tMin ||
				cells.bounds[b + 1] !== cell.tMax ||
				cells.bounds[b + 2] !== cell.pMin ||
				cells.bounds[b + 3] !== cell.pMax
			) {
				wrong++;
			}
			expected.delete(key);
		}
		expect(wrong).toBe(0);
		expect(expected.size).toBe(0);
	}
}

/** Verifies every coarse heatmap level equals the direct 4^l merge of level 0. */
function expectExactHeatLevels(store: HeatmapStore): void {
	const raw = readLevel(store, 0);
	expect(raw.bounds.length).toBe(0);
	const cols: { time: number; offset: number; cells: number[] }[] = [];
	let at = 0;
	for (let c = 0; c < raw.count; c++) {
		const len = raw.lengths.length > 0 ? raw.lengths[c]! : raw.rows;
		cols.push({
			time: raw.time[c]!,
			offset: raw.offsets.length > 0 ? raw.offsets[c]! : 0,
			cells: [...raw.values.subarray(at, at + len)],
		});
		at += len;
	}
	for (let l = 1; l <= store.levels; l++) {
		const got = readLevel(store, l);
		expect(got.bounds.length).toBe(0);
		const size = 4 ** l;
		const buckets = new Map<number, typeof cols>();
		cols.forEach((col, i) => {
			const b = Math.floor((raw.first + i) / size);
			const list = buckets.get(b) ?? [];
			list.push(col);
			buckets.set(b, list);
		});
		let gAt = 0;
		const bFirst = Math.floor(raw.first / size);
		const bLast = Math.floor((raw.first + cols.length - 1) / size);
		expect(got.count).toBe(bLast - bFirst + 1);
		for (let b = bFirst; b <= bLast; b++) {
			const members = buckets.get(b)!;
			let low = Infinity;
			let high = -Infinity;
			for (const m of members) {
				low = Math.min(low, m.offset);
				high = Math.max(high, m.offset + m.cells.length);
			}
			const merged = new Float32Array(high - low).fill(Number.NaN);
			for (const m of members) {
				m.cells.forEach((v, r) => {
					const idx = m.offset - low + r;
					if (v === v && !(merged[idx]! >= v)) merged[idx] = v;
				});
			}
			const i = b - bFirst;
			const len = got.lengths.length > 0 ? got.lengths[i]! : got.rows;
			const off = got.offsets.length > 0 ? got.offsets[i]! : 0;
			expect(got.time[i]).toBe(members[0]!.time);
			expect(off).toBe(low);
			expect([...got.values.subarray(gAt, gAt + len)]).toEqual([...merged]);
			gAt += len;
		}
	}
}

/** Scatter dataset whose level 1 has 3+ chunks (>131,072 cells) and a level 2 above it. */
function multiLevelScatter(count = 260_000): ScatterRows {
	const time = new Float64Array(count);
	const price = new Float64Array(count);
	const value = new Float32Array(count);
	for (let i = 0; i < count; i++) {
		time[i] = i * 1000;
		// 40 distinct bins per 64-point bucket -> ~162,500 cells at level 1 (3 chunks), ratio ~0.625 <= 0.75.
		price[i] = 100 + (i % 40) * 0.25;
		value[i] = 1 + ((i * 17) % 100);
	}
	return { kind: 'scatter', count, time, price, value };
}

/** Watches timeline extent on an EngineClient and reads all timeline bar timestamps on demand. */
function timelineReader(engine: EngineClient): () => Promise<number[]> {
	let window: { time: Float64Array; count: number } = { time: new Float64Array(0), count: 0 };
	let first = 0;
	let total = 0;
	engine.onevent = event => {
		first = event.first;
		total = event.end - event.first;
		if (event.window !== undefined) {
			window = { time: event.window.time, count: event.window.count };
		}
	};
	return async () => {
		await engine.whenIdle();
		if (total <= 0) {
			return [];
		}
		engine.requestWindow(first, total, total, 0);
		await engine.whenIdle();
		return [...window.time.subarray(0, window.count)];
	};
}

describe('mark corrections (in-place)', () => {
	it('corrects heatmap columns in place, lowers coarse peaks, handles varying offsets, and refuses missing times', () => {
		const store = new HeatmapStore();
		const offsets = Int32Array.from({ length: 2400 }, (_, c) => (c % 5) - 2);
		const data: HeatmapColumns = { ...heat(2400, 6, (c, r) => 50 + ((c + r) % 40)), offsets };
		drain(store.set(data));
		expect(store.levels).toBeGreaterThan(0);

		// Replace column 100 with lower values & a new offset, plus column 1500, plus an unknown time.
		const patch: HeatmapColumns = {
			kind: 'heatmap',
			count: 3,
			rows: 6,
			priceStart: data.priceStart,
			priceStep: data.priceStep,
			time: Float64Array.of(data.time[100]!, data.time[100]! + 1234, data.time[1500]!),
			offsets: Int32Array.of(10, 0, -5),
			values: Float32Array.of(1, 2, 3, 4, 5, 6, 9, 9, 9, 9, 9, 9, 7, 8, Number.NaN, 10, 11, 12),
		};
		const rejected = drain(store.correct(patch));
		expect(rejected).toBe(1);
		expectExactHeatLevels(store);

		// Lowering every column in bucket 25 (columns 100..103) lowers level-1 bucket 25.
		const bucketPatch: HeatmapColumns = {
			kind: 'heatmap',
			count: 4,
			rows: 6,
			priceStart: data.priceStart,
			priceStep: data.priceStep,
			time: Float64Array.of(data.time[100]!, data.time[101]!, data.time[102]!, data.time[103]!),
			offsets: Int32Array.of(0, 0, 0, 0),
			values: new Float32Array(24).fill(2),
		};
		expect(drain(store.correct(bucketPatch))).toBe(0);
		const l1 = readLevel(store, 1);
		const bucket25 = 25 - l1.first;
		const start = l1.lengths.slice(0, bucket25).reduce((a, b) => a + b, 0);
		expect([...l1.values.subarray(start, start + l1.lengths[bucket25]!)]).toEqual([2, 2, 2, 2, 2, 2]);
		expectExactHeatLevels(store);

		// Off-grid correction is refused completely.
		const wrongGrid: HeatmapColumns = { ...bucketPatch, priceStep: 1 };
		expect(drain(store.correct(wrongGrid))).toBe(4);
	});

	it('corrects scatter ranges in place with changed counts, exact bounds, and refuses missing ranges or all-invalid data', () => {
		const store = new ScatterStore();
		const data = trades(90_000, 11, 1_000_000, 0.2);
		drain(store.set(data));
		expect(store.levels).toBeGreaterThan(0);
		expectExactScatterLevels(store);

		// Replace [t[10_000], t[10_099]] (100 points) with 3 points shifted inside the range.
		const from = data.time[10_000]!;
		const to = data.time[10_099]!;
		const replacement: ScatterRows = {
			kind: 'scatter',
			count: 4,
			time: Float64Array.of(from + 200, from + 50, to + 1, to - 10),
			price: Float64Array.of(102.5, 98.25, 100, 101.75),
			value: Float32Array.of(200, 150, 999, 50),
			size: Float32Array.of(6, 4, 2, 8),
		};
		// Point at `to + 1` is outside [from, to] and refused; the 3 valid points replace the 100.
		expect(drain(store.correct(replacement, from, to))).toBe(1);
		expect(store.total(0)).toBe(90_000 - 100 + 3);
		expectExactScatterLevels(store);

		// Range with no existing points is refused without mutating.
		const beforeCount = store.total(0);
		expect(drain(store.correct(rows([500], [100], [5])))).toBe(1);
		expect(store.total(0)).toBe(beforeCount);

		// All-invalid input with count > 0 is refused without deleting existing points.
		expect(drain(store.correct(rows([from], [Number.NaN], [1]), from, to))).toBe(1);
		expect(store.total(0)).toBe(beforeCount);

		// Subsequent append & prepend continue to maintain exact coarse levels and bounds.
		drain(store.append(trades(1000, 3, data.time[data.count - 1]! + 1000, 0.2)));
		drain(store.prepend(trades(1000, 5, 0, 0.2)));
		expectExactScatterLevels(store);
	});

	it('keeps scatter and heatmap levels exact through random appends, prepends, corrections and deletions', () => {
		const next = random(37);
		const store = new ScatterStore();
		let head = 50_000_000;
		let tail = head + 70_000 * 1000;
		drain(store.set(trades(70_000, 2, head, 0.05)));
		for (let step = 0; step < 30; step++) {
			const choice = next();
			if (choice < 0.3) {
				const n = 500 + Math.floor(next() * 1500);
				drain(store.append(trades(n, step + 1, tail, 0.05)));
				tail += n * 1000;
			} else if (choice < 0.55) {
				const n = 500 + Math.floor(next() * 1500);
				head -= n * 1000;
				drain(store.prepend(trades(n, step + 50, head, 0.05)));
			} else if (choice < 0.8) {
				const from = head + Math.floor(next() * (tail - head - 500_000));
				const to = from + 100_000 + Math.floor(next() * 300_000);
				const count = 1 + Math.floor(next() * 50);
				const time = Float64Array.from(
					{ length: count },
					(_, i) => from + Math.floor(((i + 0.5) / count) * (to - from)),
				);
				const price = Float64Array.from({ length: count }, () => 99.5 + next());
				const value = Float32Array.from({ length: count }, () => 1 + Math.floor(next() * 100));
				drain(store.correct({ kind: 'scatter', count, time, price, value }, from, to));
			} else {
				const from = head + Math.floor(next() * (tail - head - 200_000));
				drain(store.delete(from, from + Math.floor(next() * 200_000)));
			}
			if (step % 6 === 5) {
				expectExactScatterLevels(store);
			}
		}
		expect(store.total(0)).toBeGreaterThan(0);
		expectExactScatterLevels(store);

		const hStore = new HeatmapStore();
		let hHead = 10_000;
		let hTail = hHead + 1500;
		drain(hStore.set(heat(1500, 4, (c, r) => (c * 3 + r) % 40, hHead * 60_000)));
		for (let step = 0; step < 25; step++) {
			const choice = next();
			if (choice < 0.3) {
				const n = 50 + Math.floor(next() * 200);
				drain(hStore.append(heat(n, 4, (c, r) => (c + r + step) % 50, hTail * 60_000)));
				hTail += n;
			} else if (choice < 0.55) {
				const n = 50 + Math.floor(next() * 200);
				hHead -= n;
				drain(hStore.prepend(heat(n, 4, (c, r) => (c + r + step) % 50, hHead * 60_000)));
			} else if (choice < 0.8) {
				const raw = readLevel(hStore, 0);
				const idx = Math.floor(next() * raw.count);
				drain(
					hStore.correct({
						kind: 'heatmap',
						count: 1,
						rows: 4,
						priceStart: 90,
						priceStep: 0.5,
						time: Float64Array.of(raw.time[idx]!),
						values: Float32Array.of(step, step + 1, Number.NaN, step + 2),
					}),
				);
			} else {
				const raw = readLevel(hStore, 0);
				if (raw.count > 200) {
					const idx = Math.floor(next() * (raw.count - 50));
					drain(hStore.delete(raw.time[idx]!, raw.time[idx + 40]!));
				}
			}
			if (step % 5 === 4) {
				expectExactHeatLevels(hStore);
			}
		}
		expect(hStore.total(0)).toBeGreaterThan(0);
		expectExactHeatLevels(hStore);
	}, 30_000);

	it('waits for evicted chunks on MarksEngine correct (heatmap & scatter) and recomputes indicators', async () => {
		const engine = new MarksEngine();
		const data = heat(3000, 1024, (c, r) => (c * 3 + r) % 80);
		drain(engine.change(1, { op: 'add', kind: 'heatmap', fetchable: true }, outcome()));
		drain(engine.change(1, { op: 'set', data: betweenHeat(data, -Infinity, Infinity) }, outcome()));
		engine.window(1, 1, request(data.time[2990]!, data.time[2999]!, 60_000), outcome());
		engine.evict(Infinity, Infinity);
		expect(engine.evicted).toBeGreaterThan(0);

		const targetCol = 1200;
		const corrected: HeatmapColumns = {
			kind: 'heatmap',
			count: 1,
			rows: 1024,
			priceStart: data.priceStart,
			priceStep: data.priceStep,
			time: Float64Array.of(data.time[targetCol]!),
			values: new Float32Array(1024).fill(999),
		};
		const asked = outcome();
		drain(engine.change(1, { op: 'correct', data: corrected }, asked));
		expect(engine.waiting).toBe(1);
		let fetches: MarksFetchRequest[] = asked.marksFetch ?? [];
		expect(fetches.length).toBeGreaterThan(0);
		while (fetches.length > 0) {
			const back = outcome();
			for (const fetch of fetches) {
				drain(engine.restore(fetch.id, betweenHeat(data, fetch.from, fetch.to), back));
			}
			fetches = back.marksFetch ?? [];
		}
		expect(engine.waiting).toBe(0);
		const view = outcome();
		engine.window(1, 2, request(data.time[targetCol]!, data.time[targetCol]! + 60_000, 60_000), view);
		expect(view.marks![0]!.level).toBe(0);
		const idx = view.marks![0]!.time.indexOf(data.time[targetCol]!);
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(view.marks![0]!.values[idx * 1024]).toBe(999);
	}, 30_000);
});

describe('evicting intermediate mark LOD levels under memoryLimit', () => {
	it('evicts intermediate coarse scatter levels, materializes immediately when children stay, and fetches + materializes under memoryLimit = 1', async () => {
		const data = multiLevelScatter(260_000);
		const ref = new ScatterStore();
		drain(ref.set(betweenScatter(data, -Infinity, Infinity)));
		expect(ref.levels).toBeGreaterThanOrEqual(2);

		// 1. Direct store verification: level 1 has >= 3 chunks so chunk 1 is evictable while level 2 (top) is not.
		const store = new ScatterStore();
		drain(store.set(betweenScatter(data, -Infinity, Infinity)));
		const chunks: { chunk: number; level?: number; from: number; to: number; bytes: number }[] = [];
		const tail = data.time[data.count - 1]!;
		store.evictable(tail - 5000, tail, chunks);
		const l0 = chunks.filter(c => (c.level ?? 0) === 0);
		const l1 = chunks.filter(c => c.level === 1);
		const topLevel = chunks.filter(c => c.level === store.levels);
		expect(l0.length).toBeGreaterThan(0);
		expect(l1.length).toBeGreaterThan(0);
		expect(topLevel.length).toBe(0);

		// Evicting level-1 chunk alone while level 0 stays -> materialize rebuilds with zero fetch!
		const targetL1 = l1[0]!;
		const freedL1 = store.evict(targetL1.chunk, 1);
		expect(freedL1).toBeGreaterThan(0);
		expect(store.evicted).toBe(1);
		const startRow = targetL1.chunk * 65_536;
		const missing: number[] = [];
		store.missing(1, startRow, startRow + 100, missing);
		expect(missing).toEqual([]);
		expect(store.materialize(1, startRow, startRow + 100)).toBe(true);
		expect(store.evicted).toBe(0);
		expect(readLevel(store, 1)).toEqual(readLevel(ref, 1));

		// 2. Full EngineClient with memoryLimit = 1: evicts BOTH level 0 and level 1, serves level 2 stand-in, fetches & materializes level 1 cleanly.
		const client = createEngine({ worker: false });
		const gotMarks: MarksUpdate[] = [];
		const gotFetches: MarksFetchRequest[] = [];
		client.onmarks = updates => gotMarks.push(...updates);
		client.onmarksfetch = event => gotFetches.push(...(event.marksFetch ?? []));
		const series = client.addMarks('scatter', true);
		client.changeMarks(series, { op: 'set', data: betweenScatter(data, -Infinity, Infinity) });
		client.requestMarks(series, request(tail - 5000, tail, 1));
		client.setMemoryLimit(1);
		await client.whenIdle();

		// Request level 1 over the evicted coarse chunk's time range.
		const midFrom = targetL1.from + (targetL1.to - targetL1.from) * 0.25;
		const midTo = targetL1.from + (targetL1.to - targetL1.from) * 0.75;
		const l1Step = readLevel(ref, 1).timeStep;
		gotMarks.length = 0;
		gotFetches.length = 0;
		client.requestMarks(series, request(midFrom, midTo, l1Step * 1.1));
		await client.whenIdle();
		const standIn = gotMarks.at(-1)!;
		expect(standIn.partial).toBe(true);
		expect(standIn.level).toBeGreaterThan(1);
		expect(gotFetches.length).toBeGreaterThan(0);

		// Restore all fetched level-0 chunks under memoryLimit = 1; level 1 materializes before notice!
		for (const fetch of gotFetches) {
			client.restoreMarks(fetch.id, betweenScatter(data, fetch.from, fetch.to));
		}
		await client.whenIdle();
		expect(gotMarks.at(-1)!.notice).toBe(true);

		gotMarks.length = 0;
		gotFetches.length = 0;
		client.requestMarks(series, request(midFrom, midTo, l1Step * 1.1));
		await client.whenIdle();
		const final = gotMarks.at(-1)!;
		expect(final.partial).toBeUndefined();
		expect(final.level).toBe(1);
		expect(gotFetches).toEqual([]);
		// Matches reference store row-for-row including bounds!
		const refSlice = blankUpdate();
		ref.read(1, final.start, final.start + final.count, refSlice);
		expect([...final.time]).toEqual([...refSlice.time]);
		expect([...final.price]).toEqual([...refSlice.price]);
		expect([...final.values]).toEqual([...refSlice.values]);
		expect([...final.counts]).toEqual([...refSlice.counts]);
		expect([...final.bounds]).toEqual([...refSlice.bounds]);
		client.destroy();
	}, 30_000);

	it('evicts intermediate coarse heatmap levels, materializes on demand, and handles delete that shrinks top level', () => {
		const data = heat(3000, 1024, (c, r) => (c * 5 + r) % 100);
		const ref = new HeatmapStore();
		drain(ref.set(betweenHeat(data, -Infinity, Infinity)));
		expect(ref.levels).toBe(2);

		const engine = new MarksEngine();
		drain(engine.change(1, { op: 'add', kind: 'heatmap', fetchable: true }, outcome()));
		drain(engine.change(1, { op: 'set', data: betweenHeat(data, -Infinity, Infinity) }, outcome()));
		const tail = data.time[2999]!;
		engine.window(1, 1, request(tail - 120_000, tail, 60_000), outcome());
		const beforeBytes = engine.byteLength;
		const store = engine.store(1) as HeatmapStore;
		const evictable: { chunk: number; level?: number; from: number; to: number; bytes: number }[] = [];
		store.evictable(tail - 120_000, tail, evictable);
		const l0Count = evictable.filter(c => (c.level ?? 0) === 0).length;
		const l1Count = evictable.filter(c => c.level === 1).length;
		expect(l0Count).toBeGreaterThan(10);
		expect(l1Count).toBeGreaterThan(2);
		expect(evictable.some(c => c.level === 2)).toBe(false);

		engine.evict(Infinity, Infinity);
		expect(engine.evicted).toBe(l0Count + l1Count);
		expect(engine.byteLength).toBeLessThan(beforeBytes * 0.25);

		// Asking for level 1 over evicted middle returns level 2 stand-in (`partial: true`) and fetches level 0 chunks.
		const mid = data.time[1200]!;
		const asked = outcome();
		engine.window(1, 2, request(mid, mid + 60_000 * 400, 60_000 * 4), asked);
		expect(asked.marks![0]!.partial).toBe(true);
		expect(asked.marks![0]!.level).toBe(2);
		for (const fetch of asked.marksFetch!) {
			drain(engine.restore(fetch.id, betweenHeat(data, fetch.from, fetch.to), outcome()));
		}
		const after = outcome();
		engine.window(1, 3, request(mid, mid + 60_000 * 400, 60_000 * 4), after);
		expect(after.marks![0]!.partial).toBeUndefined();
		expect(after.marks![0]!.level).toBe(1);
		const refSlice = blankUpdate();
		ref.read(1, after.marks![0]!.start, after.marks![0]!.start + after.marks![0]!.count, refSlice);
		expect([...after.marks![0]!.values]).toEqual([...refSlice.values]);

		// Deleting enough columns that level 2 is no longer needed does not fetch level 1's columns
		// only to let level 2 go: level 2 stays, rebuilt, as long as level 1 is not held in full.
		engine.evict(Infinity, Infinity);
		const kept = betweenHeat(data, data.time[1801]!, Infinity);
		const delOut = outcome();
		drain(engine.change(1, { op: 'delete', from: data.time[0]!, to: data.time[1800]! }, delOut));
		let fetches = delOut.marksFetch ?? [];
		let fetched = 0;
		while (fetches.length > 0) {
			const back = outcome();
			for (const fetch of fetches) {
				fetched++;
				drain(engine.restore(fetch.id, betweenHeat(kept, fetch.from, fetch.to), back));
				expect(back.marksRestored!.outcome).toBe('restored');
			}
			fetches = back.marksFetch ?? [];
		}
		expect(engine.waiting).toBe(0);
		expect(fetched).toBeLessThanOrEqual(2);
		expect(store.levels).toBe(2);
		const topMissing: number[] = [];
		store.missing(2, store.first(2), store.first(2) + store.total(2), topMissing);
		expect(topMissing).toEqual([]);
		// Once level 1 can be made from what is held, the next change lets level 2 go.
		let view = outcome();
		engine.window(1, 4, request(-Infinity, Infinity, 1, { limit: Infinity }), view);
		for (let round = 0; view.marksFetch !== undefined && round < 20; round++) {
			for (const fetch of view.marksFetch) {
				drain(engine.restore(fetch.id, betweenHeat(kept, fetch.from, fetch.to), outcome()));
			}
			view = outcome();
			engine.window(1, 4, request(-Infinity, Infinity, 1, { limit: Infinity }), view);
		}
		const level0: number[] = [];
		store.missing(0, store.first(0), store.first(0) + store.total(0), level0);
		expect(level0).toEqual([]);
		drain(engine.change(1, { op: 'append', data: heat(1, 1024, () => 1, 0, 3000) }, outcome()));
		expect(store.levels).toBe(1);
		const checkMissing: number[] = [];
		store.missing(1, store.first(1), store.first(1) + store.total(1), checkMissing);
		expect(checkMissing).toEqual([]);
		expectExactHeatLevels(store);
	}, 30_000);
});

describe('unified timeline from multiple mark series (engine)', () => {
	it('maintains the sorted union of buckets across heatmap + scatter through set, append, prepend, delete, correct, and remove', async () => {
		const engine = createEngine({ worker: false });
		const readTimeline = timelineReader(engine);
		const timeline = engine.addSeries('line', false);
		const hm = engine.addMarks('heatmap', false, { series: timeline, interval: 0 });
		const sc = engine.addMarks('scatter', false, { series: timeline, interval: 60_000 });

		// 1. Heatmap sets columns at minutes 2, 4, 6.
		engine.changeMarks(hm, {
			op: 'set',
			data: {
				kind: 'heatmap',
				count: 3,
				rows: 2,
				priceStart: 100,
				priceStep: 1,
				time: Float64Array.of(2 * 60_000, 4 * 60_000, 6 * 60_000),
				values: Float32Array.of(1, 2, 3, 4, 5, 6),
			},
		});
		expect(await readTimeline()).toEqual([120_000, 240_000, 360_000]);

		// 2. Scatter sets points in minutes 1, 4, 5 -> union is [1, 2, 4, 5, 6].
		engine.changeMarks(sc, {
			op: 'set',
			data: rows([60_000 + 500, 240_000 + 200, 300_000 + 100], [100, 101, 102], [1, 2, 3]),
		});
		expect(await readTimeline()).toEqual([60_000, 120_000, 240_000, 300_000, 360_000]);

		// 3. Scatter appends minute 7 (tail fast path) and heatmap appends minute 3 (interior -> union rebuild).
		engine.changeMarks(sc, { op: 'append', data: rows([420_000 + 10], [100], [4]) });
		expect(await readTimeline()).toEqual([60_000, 120_000, 240_000, 300_000, 360_000, 420_000]);

		// Scatter prepends minute 0 (head fast path).
		engine.changeMarks(sc, { op: 'prepend', data: rows([500], [100], [1]) });
		expect(await readTimeline()).toEqual([0, 60_000, 120_000, 240_000, 300_000, 360_000, 420_000]);

		// Heatmap prepends minute 1.5 (90_000, strictly interior to timeline [0..420_000] -> union rebuild).
		engine.changeMarks(hm, {
			op: 'prepend',
			data: {
				kind: 'heatmap',
				count: 1,
				rows: 2,
				priceStart: 100,
				priceStep: 1,
				time: Float64Array.of(90_000),
				values: Float32Array.of(7, 8),
			},
		});
		expect(await readTimeline()).toEqual([0, 60_000, 90_000, 120_000, 240_000, 300_000, 360_000, 420_000]);

		// 4. Delete scatter points in minutes 4 and 5: minute 4 stays (owned by heatmap), minute 5 goes!
		engine.changeMarks(sc, { op: 'delete', from: 240_000, to: 359_999 });
		expect(await readTimeline()).toEqual([0, 60_000, 90_000, 120_000, 240_000, 360_000, 420_000]);

		// 5. Correct scatter minute 1 (60_000..119_999) by moving point from minute 1 to minute 3 (180_000) over range [60_000, 239_999]:
		engine.changeMarks(sc, {
			op: 'correct',
			data: rows([180_000 + 100], [105], [9]),
			from: 60_000,
			to: 239_999,
		});
		expect(await readTimeline()).toEqual([0, 90_000, 120_000, 180_000, 240_000, 360_000, 420_000]);

		// 6. Remove heatmap: timeline shrinks to scatter's buckets only ([0, 180_000, 420_000]).
		engine.changeMarks(hm, { op: 'remove' });
		expect(await readTimeline()).toEqual([0, 180_000, 420_000]);

		// 7. Indicators reading scatter continue working across corrections on the shared timeline.
		engine.addIndicator('sma', [1], [{ series: sc, column: MARK_COLUMNS.count }], 1);
		await engine.whenIdle();
		engine.changeMarks(sc, { op: 'remove' });
		expect(await readTimeline()).toEqual([]);
		engine.destroy();
	});
});
