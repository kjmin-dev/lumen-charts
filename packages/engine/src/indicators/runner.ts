import { CHUNK_MASK, CHUNK_ROWS, CHUNK_SHIFT } from '../chunk';
import type { IndicatorDefinition } from './definition';

/**
 * Reads rows `[from, to)` of input `input` (global main-timeline indexes) into `out` from `offset`
 * on. Missing values are NaN.
 */
export type InputReader = (input: number, from: number, to: number, out: Float64Array, offset: number) => void;

/**
 * Runs one indicator's kernel along the main timeline: the committed position, the kernel state
 * and the carry (the last `lookback` input rows before the position), plus checkpoints of both at
 * every chunk boundary passed, so a computation can restart there.
 *
 * Slices never cross a chunk boundary (global index a multiple of 8,192). A windowed kernel starts
 * fresh at every boundary and rebuilds its state from the carry, so its values do not depend on
 * where the computation began. The engine and `computeIndicator` both run kernels through this
 * class, which makes their results the same bits.
 */
export class Runner {
	public readonly definition: IndicatorDefinition;
	public readonly params: Float64Array;
	public readonly inputs: number;
	public readonly outputs: number;
	public readonly lookback: number;
	public readonly windowed: boolean;
	/**
	 * Column-major work buffer: inputs, then outputs, `stride` rows each. Input rows `[0, lookback)`
	 * always hold the carry; a slice occupies rows `[lookback, lookback + n)`.
	 */
	public readonly buffer: Float64Array;
	/** The output columns of `buffer`, as one view (columns `stride` apart). */
	public readonly results: Float64Array;
	public readonly stride: number;
	/** Rows before this one are committed: `state` and the carry describe them. */
	public position = 0;
	/** First row of the data, where the kernel starts fresh with a carry of NaN. */
	public first = 0;
	public readonly state: Float64Array;
	private readonly _scratch: Float64Array;
	private readonly _read: InputReader;
	/** State followed by the carry, at each chunk boundary passed, by grid number. */
	private readonly _checkpoints = new Map<number, Float64Array>();

	public constructor(definition: IndicatorDefinition, params: Float64Array, read: InputReader) {
		this.definition = definition;
		this.params = params;
		this.inputs = definition.inputs.length;
		this.outputs = definition.outputs.length;
		this.lookback = definition.lookback(params);
		this.windowed = definition.windowed === true;
		this.stride = this.lookback + CHUNK_ROWS;
		this.buffer = new Float64Array((this.inputs + this.outputs) * this.stride);
		this.results = this.buffer.subarray(this.inputs * this.stride);
		const size = definition.stateSize(params);
		this.state = new Float64Array(size);
		this._scratch = new Float64Array(size);
		this._read = read;
	}

	/** Bytes held by the buffers and checkpoints. */
	public get byteLength(): number {
		let bytes = this.buffer.byteLength + 2 * this.state.byteLength;
		for (const checkpoint of this._checkpoints.values()) {
			bytes += checkpoint.byteLength;
		}
		return bytes;
	}

	/** Starts over at row `first`, the first row of the data. */
	public reset(first: number): void {
		this.first = first;
		this.position = first;
		this.state.fill(0);
		this._checkpoints.clear();
		for (let i = 0; i < this.inputs; i++) {
			this.buffer.fill(NaN, i * this.stride, i * this.stride + this.lookback);
		}
	}

	/**
	 * Commits rows from the position up to `to` or the next chunk boundary, whichever comes first.
	 * Returns the number of rows; their outputs are in rows `[lookback, lookback + n)` of `results`.
	 */
	public step(to: number): number {
		const from = this.position;
		if (from >= to) {
			return 0;
		}
		const end = Math.min(to, ((from >> CHUNK_SHIFT) + 1) << CHUNK_SHIFT);
		const n = end - from;
		if ((from & CHUNK_MASK) === 0 && from !== this.first) {
			if (this.windowed) {
				this.state.fill(0);
			}
			this._save(from >> CHUNK_SHIFT);
		}
		const { buffer, lookback, stride } = this;
		for (let i = 0; i < this.inputs; i++) {
			this._read(i, from, end, buffer, i * stride + lookback);
		}
		this.definition.kernel(buffer, lookback, n, this.state, lookback, this.params);
		if (lookback > 0) {
			// The last `lookback` input rows become the carry of the next slice.
			for (let i = 0; i < this.inputs; i++) {
				const base = i * stride;
				buffer.copyWithin(base, base + n, base + n + lookback);
			}
		}
		this.position = end;
		return n;
	}

	/**
	 * Computes the row at the position without committing it, for a bar that is still changing. Its
	 * outputs are in row `lookback` of `results`.
	 */
	public provisional(): void {
		const row = this.position;
		const scratch = this._scratch;
		if (this.windowed && (row & CHUNK_MASK) === 0 && row !== this.first) {
			scratch.fill(0);
		} else {
			scratch.set(this.state);
		}
		const { buffer, lookback, stride } = this;
		for (let i = 0; i < this.inputs; i++) {
			this._read(i, row, row + 1, buffer, i * stride + lookback);
		}
		this.definition.kernel(buffer, lookback, 1, scratch, lookback, this.params);
	}

	/**
	 * Moves the position back to the start of the chunk holding `row`, with the state and carry the
	 * computation had there. Returns false when that is not known; `reset` is then the way back.
	 */
	public rewind(row: number): boolean {
		if (row >= this.position) {
			return true;
		}
		const grid = row >> CHUNK_SHIFT;
		const start = grid << CHUNK_SHIFT;
		if (start <= this.first) {
			this.reset(this.first);
			return true;
		}
		const checkpoint = this._checkpoints.get(grid);
		if (checkpoint === undefined) {
			return false;
		}
		const size = this.state.length;
		this.state.set(checkpoint.subarray(0, size));
		for (let i = 0; i < this.inputs; i++) {
			const at = size + i * this.lookback;
			this.buffer.set(checkpoint.subarray(at, at + this.lookback), i * this.stride);
		}
		this.position = start;
		return true;
	}

	/**
	 * True when this runner, at a chunk boundary, holds exactly (bit for bit) the state and carry the
	 * other kept as its checkpoint at that boundary: from there on, with the same inputs, both
	 * compute the same rows. A windowed runner starts every chunk with zero state, so only its carry
	 * is compared.
	 */
	public matches(other: Runner): boolean {
		const row = this.position;
		if ((row & CHUNK_MASK) !== 0 || row === this.first) {
			return false;
		}
		const checkpoint = other._checkpoints.get(row >> CHUNK_SHIFT);
		const size = this.state.length;
		const lookback = this.lookback;
		if (checkpoint === undefined || checkpoint.length !== size + this.inputs * lookback) {
			return false;
		}
		if (!this.windowed) {
			for (let i = 0; i < size; i++) {
				if (!Object.is(this.state[i], checkpoint[i])) {
					return false;
				}
			}
		}
		for (let input = 0; input < this.inputs; input++) {
			const base = input * this.stride;
			const at = size + input * lookback;
			for (let r = 0; r < lookback; r++) {
				if (!Object.is(this.buffer[base + r], checkpoint[at + r])) {
					return false;
				}
			}
		}
		return true;
	}

	/**
	 * Takes over the head of the data from a runner that recomputed rows `[other.first, to)` after
	 * history was prepended: its first row and its checkpoints below `to`. The state at the position
	 * stays, since rows from `to` on did not change.
	 */
	public adoptHead(other: Runner, to: number): void {
		this.first = other.first;
		const limit = to >> CHUNK_SHIFT;
		for (const grid of this._checkpoints.keys()) {
			if (grid < limit) {
				this._checkpoints.delete(grid);
			}
		}
		for (const [grid, checkpoint] of other._checkpoints) {
			if (grid < limit) {
				this._checkpoints.set(grid, checkpoint);
			}
		}
	}

	private _save(grid: number): void {
		const size = this.state.length;
		const lookback = this.lookback;
		let checkpoint = this._checkpoints.get(grid);
		if (checkpoint === undefined) {
			checkpoint = new Float64Array(size + this.inputs * lookback);
			this._checkpoints.set(grid, checkpoint);
		}
		checkpoint.set(this.state);
		for (let i = 0; i < this.inputs; i++) {
			checkpoint.set(this.buffer.subarray(i * this.stride, i * this.stride + lookback), size + i * lookback);
		}
	}
}

/**
 * Computes an indicator over plain arrays, one per input, all of the same length. `first` is the
 * global index of row 0, which places the chunk boundaries where the engine has them, so the
 * results are the same bits as the engine's for the same data. Returns one array per output.
 */
export function computeIndicator(
	definition: IndicatorDefinition,
	params: Float64Array,
	inputs: readonly ArrayLike<number>[],
	first = 0,
): Float64Array[] {
	const count = inputs[0]?.length ?? 0;
	const runner = new Runner(definition, params, (input, from, to, out, offset) => {
		const source = inputs[input]!;
		for (let r = from; r < to; r++) {
			out[offset + r - from] = source[r - first]!;
		}
	});
	runner.reset(first);
	const outputs: Float64Array[] = [];
	for (let o = 0; o < runner.outputs; o++) {
		outputs.push(new Float64Array(count));
	}
	const end = first + count;
	while (runner.position < end) {
		const from = runner.position;
		const n = runner.step(end);
		for (let o = 0; o < runner.outputs; o++) {
			const at = o * runner.stride + runner.lookback;
			outputs[o]!.set(runner.results.subarray(at, at + n), from - first);
		}
	}
	return outputs;
}
