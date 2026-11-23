/// <reference types="node" />
// Joins results files that measured the same cases into one file.
// Usage: pnpm bench:merge <out.json> <results.json> <results.json> ...
//
// Two checkouts are compared by running them alternately, one invocation each, so slow drift of
// the machine falls on both alike. This joins the invocations of one checkout into one results
// file with a run per invocation, which `pnpm bench:report` then summarizes like repeats.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatJson } from '../src/json.ts';
import { type StoredResultsFile, loadResults, mergeResults, storedResults } from '../src/results.ts';

const [out, ...inputs] = process.argv.slice(2);
if (out === undefined || inputs.length === 0) {
	process.stderr.write('Usage: pnpm bench:merge <out.json> <results.json> <results.json> ...\n');
	process.exit(1);
}
// pnpm runs package scripts in the package directory; resolve paths against where they were typed.
const invokedFrom = process.env['INIT_CWD'] ?? process.cwd();
const files = inputs.map(path =>
	loadResults(JSON.parse(readFileSync(resolve(invokedFrom, path), 'utf8')) as StoredResultsFile),
);
const merged = mergeResults(files);
writeFileSync(resolve(invokedFrom, out), formatJson(storedResults(merged)));
process.stdout.write(`Wrote ${out}: ${merged.cases.length} cases from ${files.length} files\n`);
