/// <reference types="node" />
// Prints Markdown tables from results files written by the runner, so write-ups quote the JSON
// instead of copying numbers by hand. Usage: pnpm bench:report <results.json>...

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SkippedCase } from '../src/jobs.ts';
import { type Report, caseIds, number, table } from '../src/report.ts';
import { type StoredResultsFile, loadResults } from '../src/results.ts';
import { scenarios } from '../src/scenarios/index.ts';

const files = process.argv.slice(2);
if (files.length === 0) {
	process.stderr.write('Usage: pnpm bench:report <results.json>...\n');
	process.exit(1);
}

const cwd = process.env['INIT_CWD'] ?? process.cwd();
const results = files.map(file =>
	loadResults(JSON.parse(readFileSync(resolve(cwd, file), 'utf8')) as StoredResultsFile),
);
const cases = results.flatMap(r => r.cases);
const report: Report = { cases };

// Sections -----------------------------------------------------------------------------------------

function environment(): string {
	const out: string[] = [];
	for (const [index, r] of results.entries()) {
		const env = r.environment as Record<string, Record<string, unknown> | undefined>;
		const browser = env['browser'] ?? {};
		const machine = env['machine'] ?? {};
		const page = (env['page'] ?? {}) as Record<string, unknown>;
		const timer = (page['timer'] ?? {}) as Record<string, number>;
		const idle = (page['idleFrameInterval'] ?? {}) as Record<string, number>;
		const webgl = (page['webgl'] ?? {}) as Record<string, string>;
		const git = (env['git'] ?? {}) as Record<string, unknown>;
		const runner = (env['runner'] ?? {}) as Record<string, unknown>;
		const packages = (env['packages'] ?? {}) as Record<string, unknown>;
		const rows: string[][] = [
			['File', files[index] ?? ''],
			['Created', r.createdAt],
			['Runner arguments', `\`${((runner['arguments'] as string[] | undefined) ?? []).join(' ')}\``],
			['Run duration', `${Math.round(Number(runner['durationSeconds'] ?? 0) / 60)} min`],
			[
				'Browser',
				`Chromium ${String(browser['version'])} (${String(browser['channel'])}, ` +
					`${browser['headless'] === true ? 'headless' : 'headed'})`,
			],
			['User agent', String(page['userAgent'] ?? '')],
			['WebGL renderer', webgl['renderer'] ?? ''],
			[
				'Machine',
				`${String(machine['cpuModel'])}, ${String(machine['cpuCores'])} cores, ` +
					`${Math.round(Number(machine['totalMemoryBytes'] ?? 0) / 2 ** 30)} GiB, ` +
					`${String(machine['platform'])} ${String(machine['release'])}`,
			],
			['Power', String(machine['power'] ?? '')],
			[
				'Load average (1, 5, 15 min) at start / end',
				`${((machine['loadAverageStart'] as number[] | undefined) ?? []).map(v => v.toFixed(2)).join(', ')} / ` +
					`${((machine['loadAverageEnd'] as number[] | undefined) ?? []).map(v => v.toFixed(2)).join(', ')}`,
			],
			[
				'Viewport, DPR, chart',
				`${JSON.stringify(env['viewport'])}, ${String(page['devicePixelRatio'])}, ${JSON.stringify(page['chart'])}`,
			],
			[
				'Timer',
				`smallest step ${number((timer['minStepMs'] ?? 0) * 1000)} µs, median step ` +
					`${number((timer['medianStepMs'] ?? 0) * 1000)} µs, cross-origin isolated ${String(page['crossOriginIsolated'])}`,
			],
			['Idle frame interval', `p50 ${number(idle['p50'] ?? 0)} ms, p95 ${number(idle['p95'] ?? 0)} ms`],
			['Build', String(page['buildMode'] ?? '')],
			[
				'Packages',
				Object.entries(packages)
					.map(([k, v]) => `${k} ${String(v)}`)
					.join(', '),
			],
			['Git', `${String(git['commit'])}${git['dirty'] === true ? ' (uncommitted changes)' : ''}`],
		];
		out.push(table(['', ''], rows));
	}
	return out.join('\n');
}
function failures(): string {
	const lines: string[] = [];
	for (const c of cases) {
		for (const [i, run] of c.runs.entries()) {
			if (run.status === 'failed') {
				const message = run.message.split('\n')[0] ?? '';
				lines.push(
					`- ${c.caseId} ${c.adapter} run ${i + 1}: ${run.reason} after ${number(run.durationMs / 1000)} s: ${message}`,
				);
			}
		}
	}
	return lines.length === 0 ? 'None.\n' : `${lines.join('\n')}\n`;
}

/** Adapters the runner left out of cases they are known to fail on. */
function skippedCases(): string {
	const lines: string[] = [];
	for (const r of results) {
		const runner = (r.environment['runner'] ?? {}) as { skipped?: SkippedCase[] };
		for (const { caseId, adapter, reason } of runner.skipped ?? []) {
			lines.push(`- ${caseId} ${adapter}: ${reason}`);
		}
	}
	return lines.length === 0 ? 'None.\n' : `${lines.join('\n')}\n`;
}

// The sections of the scenarios in the scenarios' order, except where a section has an order of its
// own. A section is left out when the results have no case of its scenario.
const scenarioSections = scenarios.flatMap(scenario =>
	scenario.sections.map(section => ({ ...section, order: section.order ?? scenario.order, scenario: scenario.name })),
);
scenarioSections.sort((a, b) => a.order - b.order);
const sections: [string, () => string, string?][] = [
	['Environment', environment],
	...scenarioSections.map((section): [string, () => string, string] => [
		section.title,
		() => section.render(report),
		section.scenario,
	]),
	['Failed runs', failures],
	['Skipped cases', skippedCases],
];
for (const [title, render, scenario] of sections) {
	if (scenario === undefined || caseIds(report, scenario).length > 0) {
		process.stdout.write(`## ${title}\n\nValues: median over runs (min–max).\n\n${render()}\n`);
	}
}
