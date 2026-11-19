import type { HeatmapColumns, MarksRequest, MarksUpdate, ScatterRows } from '@lumen-charts/engine';

/** Runs a store's generator to its end and returns what it returns. */
export function drain<T>(run: Generator<undefined, T, undefined>): T {
	let step = run.next();
	while (step.done !== true) {
		step = run.next();
	}
	return step.value;
}

/** A small deterministic generator of numbers in `[0, 1)`. */
export function random(seed: number): () => number {
	let state = seed >>> 0 || 1;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

/** Scatter rows from parallel arrays. */
export function rows(time: number[], price: number[], value?: number[]): ScatterRows {
	return {
		kind: 'scatter',
		count: time.length,
		time: Float64Array.from(time),
		price: Float64Array.from(price),
		value: value === undefined ? null : Float32Array.from(value),
	};
}

/** `count` trades a second apart from `t0`: a price that wanders around 100, and sizes 1 to 100. */
export function trades(count: number, seed = 7, t0 = 0, spread = 0.5): ScatterRows {
	const next = random(seed);
	const time = new Float64Array(count);
	const price = new Float64Array(count);
	const value = new Float32Array(count);
	let mid = 100;
	for (let i = 0; i < count; i++) {
		mid += (next() - 0.5) * 0.02;
		time[i] = t0 + i * 1000;
		price[i] = mid + (next() - 0.5) * spread;
		value[i] = 1 + Math.floor(next() * 100);
	}
	return { kind: 'scatter', count, time, price, value };
}

/** `count` columns a minute apart on a grid of `rowCount` cells from price 90 in steps of 0.5: cell `r` of column `c` holds `value(c, r)`. */
export function heat(
	count: number,
	rowCount: number,
	value: (column: number, row: number) => number = (c, r) => c * 10 + r,
	t0 = 0,
	first = 0,
): HeatmapColumns {
	const time = new Float64Array(count);
	const values = new Float32Array(count * rowCount);
	for (let c = 0; c < count; c++) {
		time[c] = t0 + (first + c) * 60_000;
		for (let r = 0; r < rowCount; r++) {
			values[c * rowCount + r] = value(first + c, r);
		}
	}
	return { kind: 'heatmap', count, rows: rowCount, priceStart: 90, priceStep: 0.5, time, values };
}

export function request(from: number, to: number, step: number, more: Partial<MarksRequest> = {}): MarksRequest {
	return {
		from,
		to,
		step,
		priceStep: 0,
		limit: Infinity,
		generation: -1,
		heldLevel: -1,
		heldStart: 0,
		heldEnd: 0,
		...more,
	};
}

export function blankUpdate(): MarksUpdate {
	return {
		series: 0,
		generation: 0,
		level: 0,
		start: 0,
		count: 0,
		total: 0,
		timeStep: 0,
		priceStep: 0,
		priceStart: 0,
		rows: 1,
		valueMin: Number.NaN,
		valueMax: Number.NaN,
		time: new Float64Array(0),
		price: new Float64Array(0),
		values: new Float32Array(0),
	};
}
