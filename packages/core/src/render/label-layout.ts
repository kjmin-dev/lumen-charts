/**
 * Places labels of one height along a price axis so that none covers another.
 *
 * Each label wants its top at `wanted[i]`, sorted from the top of the axis down, and keeps that
 * order. The tops it gets are the ones closest to the wanted ones in the least-squares sense: a
 * label that overlaps no other stays where it is, and labels that would overlap move apart as a
 * block centred on the mean of their wanted tops, as little as they can, and no further than the
 * axis allows. The caller drops labels first when they cannot all fit (`count * size` above
 * `bottom - top`).
 *
 * Written as positions relative to a stack (`q[i] = top[i] - i * size`), keeping labels apart and in
 * order is keeping `q` non-decreasing: the tops are the isotonic regression of the wanted ones
 * (pool adjacent violators, linear in the count), clamped to the axis. Whole device pixels in, whole
 * device pixels out: rounding `q` keeps it non-decreasing, so rounded labels never overlap either.
 *
 * `wanted` and `out` may be the same array. Allocates only when a call needs more room than any
 * before it.
 */
export function spreadLabels(
	wanted: ArrayLike<number>,
	count: number,
	size: number,
	top: number,
	bottom: number,
	out: { [index: number]: number },
): void {
	if (count <= 0) {
		return;
	}
	if (sums.length < count) {
		const length = Math.max(count, sums.length * 2);
		sums = new Float64Array(length);
		lengths = new Int32Array(length);
	}
	// Blocks of labels that move together: the sum of their `q` and how many there are.
	let blocks = 0;
	for (let i = 0; i < count; i++) {
		let sum = wanted[i]! - i * size;
		let length = 1;
		// Merge while the block above would sit lower than this one: they overlap, so they move together.
		while (blocks > 0 && sums[blocks - 1]! * length > sum * lengths[blocks - 1]!) {
			blocks--;
			sum += sums[blocks]!;
			length += lengths[blocks]!;
		}
		sums[blocks] = sum;
		lengths[blocks] = length;
		blocks++;
	}
	const low = top;
	const high = bottom - count * size;
	let i = 0;
	for (let b = 0; b < blocks; b++) {
		const length = lengths[b]!;
		const q = Math.round(Math.min(high, Math.max(low, sums[b]! / length)));
		for (let k = 0; k < length; k++, i++) {
			out[i] = q + i * size;
		}
	}
}

let sums = new Float64Array(16);
let lengths = new Int32Array(16);
