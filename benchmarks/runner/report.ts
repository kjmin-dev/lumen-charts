/// <reference types="node" />
// Prints Markdown tables from results files written by the runner, so write-ups quote the JSON
// instead of copying numbers by hand. Usage: pnpm bench:report <results.json>...

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatasetSpec } from '../src/jobs.ts';
import { datasetLabel } from '../src/jobs.ts';
import type { CaseResult, ResultsFile } from '../src/results.ts';
import { type RunSpread, spread } from '../src/stats.ts';

const files = process.argv.slice(2);
if (files.length === 0) {
	process.stderr.write('Usage: pnpm bench:report <results.json>...\n');
	process.exit(1);
}

const cwd = process.env['INIT_CWD'] ?? process.cwd();
const results = files.map(file => JSON.parse(readFileSync(resolve(cwd, file), 'utf8')) as ResultsFile);
const cases = results.flatMap(r => r.cases);

// Formatting ---------------------------------------------------------------------------------------

function number(value: number): string {
	const abs = Math.abs(value);
	const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : 3;
	return value.toFixed(digits);
}

/** "median (min–max)" of a metric, scaled. */
function cell(c: CaseResult | undefined, path: string, scale = 1): string {
	const s: RunSpread | undefined = c?.summary[path];
	if (c === undefined) {
		return '';
	}
	if (c.status === 'failed') {
		const first = c.runs[0];
		return first?.status === 'failed' ? `failed: ${first.reason}` : 'failed';
	}
	if (s === undefined || s.runs === 0) {
		return '–';
	}
	if (s.runs === 1) {
		return number(s.median * scale);
	}
	return `${number(s.median * scale)} (${number(s.min * scale)}–${number(s.max * scale)})`;
}

/** Share of CPU time the whole machine had idle during the case's runs: "median% (min–max%)". */
function hostIdle(c: CaseResult | undefined): string {
	const values = (c?.runs ?? []).flatMap(run => (run.host === undefined ? [] : [run.host.cpuIdle * 100]));
	if (values.length === 0) {
		return '–';
	}
	const s = spread(values);
	return s.runs === 1
		? `${s.median.toFixed(0)}%`
		: `${s.median.toFixed(0)}% (${s.min.toFixed(0)}–${s.max.toFixed(0)}%)`;
}

function median(c: CaseResult | undefined, path: string): number | undefined {
	return c?.summary[path]?.median;
}

function table(header: string[], rows: string[][]): string {
	const lines = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`];
	for (const row of rows) {
		lines.push(`| ${row.join(' | ')} |`);
	}
	return `${lines.join('\n')}\n`;
}

const MS = 1;
const US = 1000;
const MIB = 1 / 2 ** 20;

function adaptersOf(list: CaseResult[]): string[] {
	return [...new Set(list.map(c => c.adapter))];
}

function find(caseId: string, adapter: string): CaseResult | undefined {
	return cases.find(c => c.caseId === caseId && c.adapter === adapter);
}

function caseIds(scenario: string): string[] {
	return [...new Set(cases.filter(c => c.job.scenario === scenario).map(c => c.caseId))];
}

function runsNote(list: CaseResult[]): string {
	const counts = [...new Set(list.map(c => c.runs.length))];
	counts.sort((a, b) => a - b);
	return counts.length === 0 ? '' : `runs per row: ${counts.join(', ')}`;
}

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

function load(): string {
	const ids = caseIds('load');
	const list = cases.filter(c => c.job.scenario === 'load');
	const rows: string[][] = [];
	for (const id of ids) {
		for (const adapter of adaptersOf(list)) {
			const c = find(id, adapter);
			if (c === undefined) {
				continue;
			}
			rows.push([
				datasetLabel(c.job.dataset),
				adapter,
				cell(c, 'warm.firstFrameMs', MS),
				cell(c, 'warm.firstFrameWithConversionMs', MS),
				cell(c, 'warm.settledMs', MS),
				cell(c, 'warm.convertMs', MS),
				cell(c, 'warm.setDataMs', MS),
				cell(c, 'warm.frameJsMs', MS),
				cell(c, 'cold.firstFrameMs', MS),
				cell(c, 'generateMs', MS),
				hostIdle(c),
			]);
		}
	}
	return (
		table(
			[
				'Data set',
				'Adapter',
				'First frame (ms)',
				'+ conversion (ms)',
				'Settled (ms)',
				'Conversion (ms)',
				'setData (ms)',
				'Frame JS (ms)',
				'Cold first frame (ms)',
				'Generate (ms)',
				'Host CPU idle',
			],
			rows,
		) + `\n${runsNote(list)}\n`
	);
}

function memory(): string {
	const list = cases.filter(c => c.job.scenario === 'load');
	const rows: string[][] = [];
	for (const id of caseIds('load')) {
		for (const adapter of adaptersOf(list)) {
			const c = find(id, adapter);
			if (c === undefined) {
				continue;
			}
			const size = c.job.dataset.size;
			const retained = median(c, 'memory.retainedBytes');
			rows.push([
				datasetLabel(c.job.dataset),
				adapter,
				cell(c, 'memory.retainedBytes', MIB),
				retained === undefined ? '–' : number(retained / size),
				cell(c, 'memory.retainedJsHeapBytes', MIB),
				cell(c, 'memory.retainedBackingStoreBytes', MIB),
				cell(c, 'memory.retainedEmbedderHeapBytes', MIB),
				cell(c, 'memory.after.totalBytes', MIB),
			]);
		}
	}
	return table(
		[
			'Data set',
			'Adapter',
			'Retained (MiB)',
			'Bytes per point',
			'JS heap (MiB)',
			'Backing stores (MiB)',
			'Embedder heap (MiB)',
			'Page total after (MiB)',
		],
		rows,
	);
}

function tick(): string {
	const list = cases.filter(c => c.job.scenario === 'tick');
	const rows: string[][] = [];
	for (const id of caseIds('tick')) {
		for (const adapter of adaptersOf(list)) {
			const c = find(id, adapter);
			if (c === undefined || c.job.scenario !== 'tick') {
				continue;
			}
			rows.push([
				`${datasetLabel(c.job.dataset)} ${c.job.view}`,
				adapter,
				cell(c, 'sync.mean', US),
				cell(c, 'sync.p50', US),
				cell(c, 'sync.p99', US),
				cell(c, 'sync.max', MS),
				cell(c, 'syncPerRound.p99', US),
				cell(c, 'syncUpdate.mean', US),
				cell(c, 'syncNewBar.mean', US),
				cell(c, 'settleJs.mean', MS),
				cell(c, 'mainThreadPerTick.mean', US),
				cell(c, 'mainThreadPerTick.p99', US),
				cell(c, 'settle.p99', MS),
				hostIdle(c),
			]);
		}
	}
	return (
		table(
			[
				'Data set, view',
				'Adapter',
				'Sync avg (µs)',
				'Sync p50 (µs)',
				'Sync p99 (µs)',
				'Sync max (ms)',
				'Sub-batch p99 (µs)',
				'Update avg (µs)',
				'New bar avg (µs)',
				'Paint JS per round (ms)',
				'Main thread avg (µs)',
				'Main thread p99 (µs)',
				'Settle p99 (ms)',
				'Host CPU idle',
			],
			rows,
		) + `\n${runsNote(list)}\n`
	);
}

/** Tick cost against data set size, per adapter and view: the O(N) question. */
function scaling(): string {
	const list = cases.filter(c => c.job.scenario === 'tick');
	const columns: { adapter: string; view: string }[] = [];
	for (const c of list) {
		const view = c.job.scenario === 'tick' ? c.job.view : null;
		if (view !== null && !columns.some(k => k.adapter === c.adapter && k.view === view)) {
			columns.push({ adapter: c.adapter, view });
		}
	}
	const datasets: DatasetSpec[] = [];
	for (const c of list) {
		if (!datasets.some(d => d.kind === c.job.dataset.kind && d.size === c.job.dataset.size)) {
			datasets.push(c.job.dataset);
		}
	}
	datasets.sort((a, b) => a.size - b.size);
	const smallest = datasets[0];
	const rows = datasets.map(d => {
		const row = [datasetLabel(d)];
		for (const { adapter, view } of columns) {
			const c = list.find(
				x => x.adapter === adapter && x.job.scenario === 'tick' && x.job.view === view && x.job.dataset.size === d.size,
			);
			const base = list.find(
				x =>
					x.adapter === adapter &&
					x.job.scenario === 'tick' &&
					x.job.view === view &&
					x.job.dataset.size === smallest?.size,
			);
			const value = median(c, 'sync.mean');
			const baseValue = median(base, 'sync.mean');
			row.push(
				value === undefined || baseValue === undefined
					? '–'
					: `${number(value * US)} µs (×${number(value / baseValue)})`,
			);
		}
		return row;
	});
	return table(['Data set', ...columns.map(k => `${k.adapter} ${k.view}`)], rows);
}

function frames(): string {
	const list = cases.filter(c => c.job.scenario === 'frames');
	const rows: string[][] = [];
	for (const id of caseIds('frames')) {
		for (const adapter of adaptersOf(list)) {
			const c = find(id, adapter);
			if (c === undefined || c.job.scenario !== 'frames') {
				continue;
			}
			const zoom = c.job.zoom === 'all' ? `all ${datasetLabel(c.job.dataset)}` : String(c.job.zoom);
			rows.push([
				`${c.job.motion} ${zoom}`,
				adapter,
				cell(c, 'jsTime.mean', MS),
				cell(c, 'jsTime.p50', MS),
				cell(c, 'jsTime.p95', MS),
				cell(c, 'jsTime.p99', MS),
				cell(c, 'jsTime.max', MS),
				cell(c, 'interval.mean', MS),
				cell(c, 'interval.p50', MS),
				cell(c, 'interval.p95', MS),
				cell(c, 'interval.p99', MS),
				cell(c, 'interval.max', MS),
				cell(c, 'drawCalls.fillRect'),
				hostIdle(c),
			]);
		}
	}
	return (
		table(
			[
				'Motion, bars in view',
				'Adapter',
				'JS avg',
				'JS p50',
				'JS p95',
				'JS p99',
				'JS max',
				'Interval avg',
				'Interval p50',
				'Interval p95',
				'Interval p99',
				'Interval max',
				'fillRect per redraw',
				'Host CPU idle',
			],
			rows,
		) + `\nAll times in ms. ${runsNote(list)}\n`
	);
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

const sections: [string, () => string][] = [
	['Environment', environment],
	['Load', load],
	['Memory after load', memory],
	['Tick', tick],
	['Tick cost against data set size (sync avg, ratio to the smallest size)', scaling],
	['Pan and zoom frames', frames],
	['Failed runs', failures],
];
for (const [title, render] of sections) {
	process.stdout.write(`## ${title}\n\nValues: median over runs (min–max).\n\n${render()}\n`);
}
