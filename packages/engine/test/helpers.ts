import type { Command, EngineCore, EngineEvent } from '@lumen-ticks/engine';

/** Column-major OHLCV block: bar `i` has time `t0 + i * step` and prices derived from `i`. */
export function ohlcv(count: number, t0 = 0, step = 60_000, base = 100): Float64Array {
	const data = new Float64Array(count * 6);
	for (let i = 0; i < count; i++) {
		const price = base + i;
		data[i] = t0 + i * step;
		data[count + i] = price;
		data[2 * count + i] = price + 2;
		data[3 * count + i] = price - 2;
		data[4 * count + i] = price + 1;
		data[5 * count + i] = 10 + i;
	}
	return data;
}

/** Column-major line block from parallel arrays. */
export function line(times: number[], values: number[]): Float64Array {
	const data = new Float64Array(times.length * 2);
	data.set(times, 0);
	data.set(values, times.length);
	return data;
}

let seq = 0;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Runs one command to completion. */
export function run(core: EngineCore, body: DistributiveOmit<Command, 'seq'>): EngineEvent {
	const generator = core.run({ ...body, seq: ++seq } as Command);
	let step = generator.next();
	while (step.done !== true) {
		step = generator.next();
	}
	return step.value;
}

export function ticks(...rows: number[][]): { type: 'ticks'; count: number; data: Float64Array } {
	const data = new Float64Array(rows.length * 7).fill(NaN);
	rows.forEach((row, i) => {
		data.set(row, i * 7);
	});
	return { type: 'ticks', count: rows.length, data };
}

/** Deterministic pseudo-random numbers in [0, 1). */
export function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
