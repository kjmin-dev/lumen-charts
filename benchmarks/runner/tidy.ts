/// <reference types="node" />
// Writes JSON files of the benchmarks again in the form the runners write (`formatJson`; results
// files without the summaries of their cases), and checks that nothing they hold changes: each
// file must parse to what it parsed to before, but for the summaries left out, and a summary is
// left out only where the runs give it again (`loadResults` makes it when the file is read). A
// summary the runs do not give again, written by an older runner, is kept.
// Usage: pnpm bench:tidy [file.json ...] (every JSON file of docs/benchmarks by default)

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { formatJson } from '../src/json.ts';
import { type CaseResult, isResultsFile, summarizeCase } from '../src/results.ts';

// pnpm runs package scripts in the package directory; resolve paths against where they were typed.
const invokedFrom = process.env['INIT_CWD'] ?? process.cwd();
const docs = resolve(import.meta.dirname, '../../docs/benchmarks');
const args = process.argv.slice(2);
const paths =
	args.length > 0
		? args.map(path => resolve(invokedFrom, path))
		: readdirSync(docs)
				.filter(name => name.endsWith('.json'))
				.map(name => resolve(docs, name));

let bytesBefore = 0;
let bytesAfter = 0;
let linesBefore = 0;
let linesAfter = 0;
let dropped = 0;
let kept = 0;
let rewritten = 0;
for (const path of paths) {
	const text = readFileSync(path, 'utf8');
	const parsed: unknown = JSON.parse(text);
	// What the file must parse to once written again.
	const expected: unknown = structuredClone(parsed);
	if (isResultsFile(parsed)) {
		const cases = (expected as { cases: Record<string, unknown>[] }).cases;
		for (const [index, c] of parsed.cases.entries()) {
			if (c.summary === undefined) {
				continue;
			}
			const made: CaseResult = { ...c, summary: {} };
			summarizeCase(made);
			if (isDeepStrictEqual(made.summary, c.summary) && made.status === c.status) {
				delete c.summary;
				delete cases[index]!['summary'];
				dropped++;
			} else {
				kept++;
				process.stdout.write(`${path}: kept the summary of ${c.caseId} (${c.adapter}), which its runs do not give\n`);
			}
		}
	}
	const out = formatJson(parsed);
	if (!isDeepStrictEqual(JSON.parse(out), expected)) {
		throw new Error(`${path}: written again, it would hold something else`);
	}
	bytesBefore += text.length;
	bytesAfter += out.length;
	linesBefore += text.split('\n').length - 1;
	linesAfter += out.split('\n').length - 1;
	if (out !== text) {
		writeFileSync(path, out);
		rewritten++;
	}
}
const mb = (bytes: number) => (bytes / 1e6).toFixed(1);
process.stdout.write(
	`${paths.length} files, ${rewritten} written again: ${mb(bytesBefore)} → ${mb(bytesAfter)} MB, ` +
		`${linesBefore} → ${linesAfter} lines; summaries left out ${dropped}, kept ${kept}\n`,
);
