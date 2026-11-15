// Indicators computed in application code, as an application using a chart library without an
// indicator engine computes them. It uses the same kernels and driver as lumen's engine, run
// incrementally (the last bar from the state at the bar before it), so the computation costs what
// it costs in lumen and only what the library does with the values differs.

import { BUILTIN_INDICATORS, type IndicatorDefinition, Runner, resolveParams } from '@lumen-charts/engine';
import type { CandleColumns } from '../data.ts';
import { type BenchIndicator, INDICATOR_SET } from '../indicators.ts';

/** Candle columns that grow with ticks and prepends; rows `[0, length)` are valid. */
class Columns {
	public length = 0;
	/** time, open, high, low, close, volume */
	public readonly data: Float64Array[] = [];

	public constructor() {
		for (let c = 0; c < 6; c++) {
			this.data.push(new Float64Array(1024));
		}
	}

	/** Takes the rows of `source`, followed by those of `rest`. */
	public set(source: CandleColumns, rest?: Columns): void {
		const extra = rest === undefined ? 0 : rest.length;
		const total = source.length + extra;
		const fresh: Float64Array[] = [];
		const columns = [source.time, source.open, source.high, source.low, source.close, source.volume];
		for (let c = 0; c < 6; c++) {
			const column = new Float64Array(Math.max(1024, total * 2));
			column.set(columns[c]!.subarray(0, source.length), 0);
			if (rest !== undefined) {
				column.set(rest.data[c]!.subarray(0, rest.length), source.length);
			}
			fresh.push(column);
		}
		this.data.splice(0, 6, ...fresh);
		this.length = total;
	}

	/** Writes a row at `index` (the last one, or one past it). */
	public put(index: number, row: readonly number[]): void {
		if (index >= this.data[0]!.length) {
			for (let c = 0; c < 6; c++) {
				const grown = new Float64Array(this.data[c]!.length * 2);
				grown.set(this.data[c]!);
				this.data[c] = grown;
			}
		}
		for (let c = 0; c < 6; c++) {
			this.data[c]![index] = row[c]!;
		}
		this.length = Math.max(this.length, index + 1);
	}
}

const COLUMN: Record<string, number> = { time: 0, open: 1, high: 2, low: 3, close: 4, volume: 5 };

/** One indicator over the columns: its outputs, and a runner kept at the last committed row. */
class Entry {
	public readonly definition: IndicatorDefinition;
	public readonly params: Float64Array;
	public outputs: Float64Array[] = [];
	public runner: Runner;
	/** Global index of row 0 of the columns (negative after prepends, as in lumen). */
	public first = 0;
	private readonly _sources: ((row: number) => number)[];

	public constructor(spec: BenchIndicator, columns: Columns, entries: Entry[]) {
		const definition = BUILTIN_INDICATORS.find(entry => entry.name === spec.name)!;
		this.definition = definition;
		this.params = resolveParams(definition.params, spec.params);
		this._sources = definition.inputs.map((name, i) => {
			const input = spec.inputs?.[i] ?? name;
			if (typeof input === 'string') {
				const column = COLUMN[input]!;
				return (row: number) => columns.data[column]![row]!;
			}
			const source = entries[input.from]!;
			return (row: number) => source.outputs[0]![row]!;
		});
		this.runner = this._runner();
	}

	/** Computes every row from scratch. */
	public reset(length: number, first: number): void {
		this.first = first;
		this.outputs = this.definition.outputs.map(() => new Float64Array(Math.max(1024, length * 2)));
		this.runner = this._runner();
		this.runner.reset(first);
		this.advance(length);
	}

	/** Commits rows up to the last one and computes the last one from the state before it. */
	public advance(length: number): void {
		const runner = this.runner;
		const end = this.first + length;
		if (length > this.outputs[0]!.length) {
			this.outputs = this.outputs.map(output => {
				const grown = new Float64Array(output.length * 2);
				grown.set(output);
				return grown;
			});
		}
		while (runner.position < end - 1) {
			const from = runner.position;
			const n = runner.step(end - 1);
			this._store(from, n);
		}
		runner.provisional();
		this._store(end - 1, 1);
	}

	private _store(from: number, n: number): void {
		const runner = this.runner;
		for (let o = 0; o < this.outputs.length; o++) {
			const at = o * runner.stride + runner.lookback;
			this.outputs[o]!.set(runner.results.subarray(at, at + n), from - this.first);
		}
	}

	private _runner(): Runner {
		return new Runner(this.definition, this.params, (input, from, to, out, offset) => {
			const source = this._sources[input]!;
			for (let r = from; r < to; r++) {
				out[offset + r - from] = source(r - this.first);
			}
		});
	}
}

/** The indicator set over growing candle columns. */
export class UserIndicators {
	public readonly columns = new Columns();
	public readonly entries: Entry[] = [];

	public constructor(count: number) {
		for (const spec of INDICATOR_SET.slice(0, count)) {
			this.entries.push(new Entry(spec, this.columns, this.entries));
		}
	}

	/** Every output of every indicator, in order: its definition's style and color. */
	public get outputs(): { style: 'line' | 'histogram'; color: string }[] {
		return this.entries.flatMap(entry =>
			entry.definition.outputs.map(output => ({ style: output.style ?? 'line', color: output.color ?? '#2962ff' })),
		);
	}

	public load(data: CandleColumns): void {
		this.columns.set(data);
		for (const entry of this.entries) {
			entry.reset(this.columns.length, 0);
		}
	}

	/** Recomputes everything after older history, as application code would on a prepend. */
	public prepend(batch: CandleColumns): void {
		const previous = new Columns();
		previous.set(
			{
				kind: 'candles',
				length: this.columns.length,
				time: this.columns.data[0]!,
				open: this.columns.data[1]!,
				high: this.columns.data[2]!,
				low: this.columns.data[3]!,
				close: this.columns.data[4]!,
				volume: this.columns.data[5]!,
			},
			undefined,
		);
		previous.length = this.columns.length;
		this.columns.set(batch, previous);
		const first = (this.entries[0]?.first ?? 0) - batch.length;
		for (const entry of this.entries) {
			entry.reset(this.columns.length, first);
		}
	}

	/** Applies a tick (a new last bar, or the last bar again) and brings every indicator up to it. */
	public tick(row: readonly number[]): void {
		const columns = this.columns;
		const last = columns.length - 1;
		const index = row[0] === columns.data[0]![last] ? last : last + 1;
		columns.put(index, row);
		for (const entry of this.entries) {
			entry.advance(columns.length);
		}
	}

	/** Value of output `o` (counted over all indicators) at the last row. */
	public lastValues(out: number[]): void {
		out.length = 0;
		const last = this.columns.length - 1;
		for (const entry of this.entries) {
			for (const output of entry.outputs) {
				out.push(output[last]!);
			}
		}
	}
}
