/// <reference types="node" />
// Breakdowns of the traces `pnpm bench --profile <dir>` records (see ../src/profile.ts).
// Run on its own, it summarizes the traces of a directory again:
//   pnpm bench:profile <dir>
// The source maps come from `benchmarks/dist`, which must hold the build the traces were made
// with: an unminified one (`LUMEN_BENCH_PROFILE=1 pnpm --filter @lumen-ticks/benchmarks build`) of
// the same sources.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { SourceMap } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AllocationSummary, type SamplingNode, summarizeAllocations } from '../src/allocations.ts';
import { formatJson } from '../src/json.ts';
import {
	type CallFrame,
	type SourceResolver,
	type TraceEvent,
	type TraceSummary,
	summarizeTrace,
} from '../src/profile.ts';

const benchDir = fileURLToPath(new URL('..', import.meta.url));
const repoDir = resolve(benchDir, '..');

/** Source file of a call frame of the built page, through the source maps of `benchmarks/dist`. */
export function sourceResolver(): SourceResolver {
	const maps = new Map<string, SourceMap | null>();
	return (frame: CallFrame): string | null => {
		let pathname: string;
		try {
			pathname = new URL(frame.url).pathname;
		} catch {
			return null;
		}
		let map = maps.get(pathname);
		if (map === undefined) {
			try {
				map = new SourceMap(JSON.parse(readFileSync(resolve(benchDir, 'dist', `.${pathname}.map`), 'utf8')));
			} catch {
				map = null;
			}
			maps.set(pathname, map);
		}
		if (map === null) {
			return null;
		}
		const entry = map.findEntry(frame.lineNumber ?? 0, frame.columnNumber ?? 0) as { originalSource?: string };
		if (entry.originalSource === undefined) {
			return null;
		}
		// Relative to the repository, whatever the map's own base is.
		const source = entry.originalSource.replace(/^file:\/\//, '');
		return relative(repoDir, resolve(benchDir, 'dist', `.${dirname(pathname)}`, source));
	};
}

export interface RunProfile {
	run: string;
	summary: TraceSummary;
}

function fileName(run: string): string {
	return run.replace(/[^\w.-]+/g, '_');
}

function summarize(trace: Buffer, resolveSource: SourceResolver): TraceSummary {
	const parsed = JSON.parse(trace.toString('utf8')) as { traceEvents?: TraceEvent[] } | TraceEvent[];
	return summarizeTrace(Array.isArray(parsed) ? parsed : (parsed.traceEvents ?? []), resolveSource);
}

/**
 * Writes the trace of a run to `<directory>/<run>.trace.json` and its breakdown next to it. Throws
 * when the trace cannot be summarized; the trace is kept.
 */
export function writeProfile(directory: string, run: string, trace: Buffer, resolveSource: SourceResolver): RunProfile {
	mkdirSync(directory, { recursive: true });
	writeFileSync(resolve(directory, `${fileName(run)}.trace.json`), trace);
	const summary = summarize(trace, resolveSource);
	writeFileSync(resolve(directory, `${fileName(run)}.json`), formatJson(summary));
	return { run, summary };
}

export interface RunAllocations {
	run: string;
	summary: AllocationSummary;
}

/**
 * Writes what a run allocated (`pnpm bench --allocations`) to `<directory>/<run>.json`. Throws when
 * the trace has no measure marks.
 */
export function writeAllocations(
	directory: string,
	run: string,
	head: SamplingNode,
	ticks: number,
	trace: Buffer,
	resolveSource: SourceResolver,
): RunAllocations {
	mkdirSync(directory, { recursive: true });
	const parsed = JSON.parse(trace.toString('utf8')) as { traceEvents?: TraceEvent[] } | TraceEvent[];
	const events = Array.isArray(parsed) ? parsed : (parsed.traceEvents ?? []);
	const summary = summarizeAllocations(head, ticks, events, resolveSource);
	writeFileSync(resolve(directory, `${fileName(run)}.json`), formatJson(summary));
	return { run, summary };
}

export function writeAllocationsSummary(directory: string, runs: readonly RunAllocations[]): void {
	writeFileSync(resolve(directory, 'summary.json'), formatJson(runs));
}

export function writeSummary(directory: string, profiles: readonly RunProfile[]): void {
	writeFileSync(resolve(directory, 'summary.json'), formatJson(profiles));
}

if (import.meta.main) {
	const directory = resolve(process.env['INIT_CWD'] ?? process.cwd(), process.argv[2] ?? '.');
	const resolveSource = sourceResolver();
	const profiles: RunProfile[] = [];
	const files = readdirSync(directory);
	files.sort();
	for (const file of files) {
		if (!file.endsWith('.trace.json')) {
			continue;
		}
		const run = file.slice(0, -'.trace.json'.length);
		try {
			const summary = summarize(readFileSync(resolve(directory, file)), resolveSource);
			writeFileSync(resolve(directory, `${run}.json`), formatJson(summary));
			profiles.push({ run, summary });
			process.stdout.write(`${run}\n`);
		} catch (error) {
			process.stdout.write(`${run}: ${error instanceof Error ? error.message : String(error)}\n`);
		}
	}
	writeSummary(directory, profiles);
}
