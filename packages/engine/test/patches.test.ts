import {
	EngineCore,
	PATCH_COLUMNS,
	PATCH_COUNT,
	PATCH_LEVEL,
	PATCH_OFFSET,
	PATCH_SERIES,
	PATCH_START,
	PATCH_STRIDE,
	PatchSpecs,
	SPEC_STRIDE,
	TIME_PATCH,
	packPatches,
	transferables,
	unpackPatches,
} from '@lumen-charts/engine';
import { describe, expect, it } from 'vitest';
import { ohlcv, run, ticks } from './helpers';

const MIN = 60_000;

describe('packed patches', () => {
	it('packs patches into an index and one buffer of values, and unpacks them again', () => {
		const list = [
			{ series: TIME_PATCH, level: 0, start: -3, count: 2, data: new Float64Array([10, 20]) },
			{ series: 1, level: 0, start: -3, count: 2, data: new Float64Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) },
			{ series: 7, level: 2, start: 4, count: 1, data: new Float64Array([1.5, 2.5, 0.5, 2]) },
		];
		const packed = packPatches(list);
		expect([...packed.index]).toEqual([TIME_PATCH, 0, -3, 2, 1, 0, 1, 0, -3, 2, 5, 2, 7, 2, 4, 1, 4, 12]);
		expect(packed.data.length).toBe(16);
		expect(unpackPatches(packed)).toEqual(list);
		expect(unpackPatches(undefined)).toEqual([]);
		expect(unpackPatches(packPatches([]))).toEqual([]);
	});

	it('gives views of the packed values, not copies', () => {
		const packed = packPatches([{ series: 1, level: 0, start: 0, count: 1, data: new Float64Array([4]) }]);
		const [patch] = unpackPatches(packed);
		packed.data[0] = 5;
		expect(patch!.data[0]).toBe(5);
	});

	it('come from the engine as two buffers an event transfers', () => {
		const core = new EngineCore();
		run(core, { type: 'add', series: 1, kind: 'ohlcv' });
		run(core, { type: 'set', series: 1, count: 100, data: ohlcv(100, 0, MIN) });
		const event = run(core, ticks([1, 99 * MIN, 1, 2, 0.5, 1.5, 7], [1, 100 * MIN, 2, 3, 1, 2, 8]));
		const { index, data } = event.patches!;
		expect(index).toBeInstanceOf(Int32Array);
		expect(index.length % PATCH_STRIDE).toBe(0);
		// Each patch says where its values are, back to back in the order of the index.
		let offset = 0;
		for (let p = 0; p < index.length; p += PATCH_STRIDE) {
			expect(index[p + PATCH_OFFSET]).toBe(offset);
			offset += index[p + PATCH_COUNT]! * index[p + PATCH_COLUMNS]!;
		}
		expect(data.length).toBe(offset);
		// The time column first, then the values of the two rows: column-major.
		expect([...index.subarray(0, PATCH_STRIDE)]).toEqual([TIME_PATCH, 0, 99, 2, 1, 0]);
		expect(index[PATCH_STRIDE + PATCH_SERIES]).toBe(1);
		expect(index[PATCH_STRIDE + PATCH_LEVEL]).toBe(0);
		expect(index[PATCH_STRIDE + PATCH_START]).toBe(99);
		expect([...data.subarray(0, 12)]).toEqual([99 * MIN, 100 * MIN, 1, 2, 2, 3, 0.5, 1, 1.5, 2, 7, 8]);
		expect(transferables(event)).toEqual([index.buffer, data.buffer]);
	});
});

describe('PatchSpecs', () => {
	it('grows as needed and keeps its storage when cleared', () => {
		const specs = new PatchSpecs();
		const capacity = specs.values.length;
		for (let i = 0; i < capacity / SPEC_STRIDE + 1; i++) {
			specs.add(i, 1, 2, 3, 4);
		}
		expect(specs.length).toBe(capacity + SPEC_STRIDE);
		expect(specs.values.length).toBe(2 * capacity);
		expect([...specs.values.subarray(capacity, capacity + SPEC_STRIDE)]).toEqual([capacity / SPEC_STRIDE, 1, 2, 3, 4]);
		const grown = specs.values;
		specs.clear();
		specs.add(TIME_PATCH, 0, -5, 1, 1);
		expect(specs.length).toBe(SPEC_STRIDE);
		expect(specs.values).toBe(grown);
		expect([...specs.values.subarray(0, SPEC_STRIDE)]).toEqual([TIME_PATCH, 0, -5, 1, 1]);
	});
});
