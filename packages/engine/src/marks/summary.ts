/**
 * Checksums of marks let go under the memory limit. Two lanes of MurmurHash3 (x86, 32 bits) over
 * the bit patterns of the rows give a 64-bit checksum, against which the rows a datafeed hands back
 * are checked. Not cryptographic: they catch a datafeed that answers with other marks, not an
 * attacker.
 */

const SEED_A = 0x2545f491;
const SEED_B = 0x9e3779b9;

function round(h: number, k: number): number {
	let x = Math.imul(k, 0xcc9e2d51);
	x = (x << 15) | (x >>> 17);
	x = Math.imul(x, 0x1b873593);
	const y = h ^ x;
	return (Math.imul((y << 13) | (y >>> 19), 5) + 0xe6546b64) | 0;
}

function finish(h: number, length: number): number {
	let x = h ^ length;
	x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
	x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
	return (x ^ (x >>> 16)) >>> 0;
}

const DOUBLE = new Float64Array(1);
const DOUBLE_WORDS = new Uint32Array(DOUBLE.buffer);
const SINGLE = new Float32Array(1);
const SINGLE_WORD = new Uint32Array(SINGLE.buffer);

/** A running 64-bit checksum of numbers, fed one at a time. NaN counts as one pattern. */
export class Checksum {
	private _a = SEED_A;
	private _b = SEED_B;
	private _length = 0;

	/** Feeds a double. */
	public double(value: number): void {
		DOUBLE[0] = value === value ? value : Number.NaN;
		const low = DOUBLE_WORDS[0]!;
		const high = DOUBLE_WORDS[1]!;
		this._a = round(round(this._a, low), high);
		this._b = round(round(this._b, high), low);
		this._length += 2;
	}

	/** Feeds a single, as the stores keep values and sizes. */
	public single(value: number): void {
		SINGLE[0] = value === value ? value : Number.NaN;
		const word = SINGLE_WORD[0]!;
		this._a = round(this._a, word);
		this._b = round(this._b, ~word);
		this._length++;
	}

	public get high(): number {
		return finish(this._a, this._length);
	}

	public get low(): number {
		return finish(this._b, this._length);
	}
}

/** Bytes a chunk let go of is counted as: its summary and the objects holding it. */
export const MARKS_SUMMARY_BYTES = 128;
