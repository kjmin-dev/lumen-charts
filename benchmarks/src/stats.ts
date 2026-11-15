/** Summary of one sample set. All values are in the unit of the samples (milliseconds here). */
export interface Distribution {
	count: number;
	mean: number;
	min: number;
	p50: number;
	p90: number;
	p95: number;
	p99: number;
	max: number;
}

/** Spread of one metric over repeated runs. */
export interface RunSpread {
	/** Median over runs. This is the headline number. */
	median: number;
	min: number;
	max: number;
	/** (max - min) / median, or 0 when the median is 0. */
	relativeRange: number;
	runs: number;
}

/**
 * Nearest-rank percentile of sorted samples: the smallest sample such that at least `p` percent of
 * all samples are less than or equal to it, i.e. `sorted[ceil(p / 100 * n) - 1]`. No interpolation,
 * so the result is always an observed value.
 */
export function percentileSorted(sorted: ArrayLike<number>, p: number): number {
	const n = sorted.length;
	if (n === 0) {
		return Number.NaN;
	}
	const rank = Math.ceil((p / 100) * n);
	const index = Math.min(n - 1, Math.max(0, rank - 1));
	return sorted[index] ?? Number.NaN;
}

/** Summarizes samples. `samples` is not modified. */
export function summarize(samples: ArrayLike<number>): Distribution {
	const sorted = Float64Array.from(samples);
	sorted.sort();
	const n = sorted.length;
	let sum = 0;
	for (let i = 0; i < n; i++) {
		sum += sorted[i] ?? 0;
	}
	return {
		count: n,
		mean: n === 0 ? Number.NaN : sum / n,
		min: n === 0 ? Number.NaN : (sorted[0] ?? Number.NaN),
		p50: percentileSorted(sorted, 50),
		p90: percentileSorted(sorted, 90),
		p95: percentileSorted(sorted, 95),
		p99: percentileSorted(sorted, 99),
		max: n === 0 ? Number.NaN : (sorted[n - 1] ?? Number.NaN),
	};
}

/** Median and range of one value measured in several runs. */
export function spread(values: readonly number[]): RunSpread {
	const finite = values.filter(v => Number.isFinite(v));
	const sorted = Float64Array.from(finite);
	sorted.sort();
	const n = sorted.length;
	if (n === 0) {
		return { median: Number.NaN, min: Number.NaN, max: Number.NaN, relativeRange: Number.NaN, runs: 0 };
	}
	const middle = n >> 1;
	const median = n % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
	const min = sorted[0] ?? 0;
	const max = sorted[n - 1] ?? 0;
	return { median, min, max, relativeRange: median === 0 ? 0 : (max - min) / median, runs: n };
}
