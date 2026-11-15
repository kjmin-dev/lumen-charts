// Controls for running the benchmarks by hand, for example on a phone. The runner loads the page
// with `?auto` and skips all of this.

import type { ChartSize } from '../adapter.ts';
import { adapters } from '../adapters/index.ts';
import type { SeriesKind } from '../data.ts';
import { K, M, type PlannedJob, type RunOutcome, SCENARIOS, type ScenarioName, planJobs, sizeLabel } from '../jobs.ts';
import { type CompletedJob, RESULTS_SCHEMA_VERSION, type ResultsFile, aggregate } from '../results.ts';
import type { BenchApi } from './api.ts';
import { headline } from '../headline.ts';

const SIZES = [10 * K, 100 * K, 300 * K, M, 10 * M];
const KINDS: readonly SeriesKind[] = ['candles', 'line'];

function element<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	props: Partial<HTMLElementTagNameMap[K]> = {},
	...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
	const node = Object.assign(document.createElement(tag), props);
	node.append(...children);
	return node;
}

function checkboxes(name: string, values: readonly string[], checked: (value: string) => boolean): HTMLFieldSetElement {
	const set = element('fieldset', {}, element('legend', { textContent: name }));
	for (const value of values) {
		const input = element('input', { type: 'checkbox', name, value, checked: checked(value) });
		set.append(element('label', {}, input, ` ${value}`));
	}
	return set;
}

function checkedValues(form: HTMLFormElement, name: string): string[] {
	return [...form.querySelectorAll<HTMLInputElement>(`input[name="${name}"]:checked`)].map(input => input.value);
}

export function setupManualPage(bench: BenchApi, chart: ChartSize): void {
	const root = document.getElementById('controls');
	if (root === null) {
		return;
	}
	const form = element(
		'form',
		{},
		checkboxes(
			'adapter',
			adapters.map(a => a.id),
			() => true,
		),
		checkboxes('scenario', SCENARIOS, () => true),
		checkboxes('kind', KINDS, () => true),
		checkboxes('size', SIZES.map(sizeLabel), value => value !== '10m'),
		element(
			'label',
			{},
			'Repeats ',
			element('input', { type: 'number', name: 'repeats', value: '3', min: '1', max: '20' }),
		),
		element('label', {}, element('input', { type: 'checkbox', name: 'quick' }), ' Quick (small sizes, short runs)'),
		element('button', { type: 'submit', textContent: 'Run' }),
	);
	const status = element('p', {
		textContent: `Chart ${chart.width}×${chart.height} CSS px. Set ?width=&height= to change.`,
	});
	const table = element('table');
	const output = element('textarea', { readOnly: true, rows: 12, spellcheck: false });
	const download = element('a', { textContent: 'Download JSON', hidden: true });
	root.append(form, status, table, download, output);

	let running = false;
	form.addEventListener('submit', event => {
		event.preventDefault();
		if (running) {
			return;
		}
		running = true;
		const quick = form.querySelector<HTMLInputElement>('input[name="quick"]')?.checked ?? false;
		const repeats = Number(form.querySelector<HTMLInputElement>('input[name="repeats"]')?.value ?? '1');
		const plan = planJobs({
			scenarios: checkedValues(form, 'scenario') as ScenarioName[],
			adapters: checkedValues(form, 'adapter'),
			sizes: quick ? [] : checkedValues(form, 'size').map(label => SIZES.find(s => sizeLabel(s) === label) ?? 0),
			kinds: checkedValues(form, 'kind') as SeriesKind[],
			repeats: Number.isInteger(repeats) && repeats > 0 ? repeats : 1,
			quick,
			chart,
			seed: 1,
		});
		void runPlan(bench, plan, status, table, output, download).finally(() => {
			running = false;
		});
	});
}

async function runPlan(
	bench: BenchApi,
	plan: PlannedJob[],
	status: HTMLElement,
	table: HTMLTableElement,
	output: HTMLTextAreaElement,
	download: HTMLAnchorElement,
): Promise<void> {
	status.textContent = 'Measuring environment…';
	const environment = { source: 'manual page', page: await bench.environment() };
	const completed: CompletedJob[] = [];
	for (const [index, planned] of plan.entries()) {
		status.textContent = `${index + 1}/${plan.length}: ${planned.id}`;
		const started = performance.now();
		const result = await bench.run(planned.job);
		const durationMs = performance.now() - started;
		const outcome: RunOutcome =
			result.status === 'ok'
				? { status: 'ok', result: result.result, durationMs }
				: { status: 'failed', reason: 'error', message: result.message, durationMs };
		completed.push({ planned, outcome, library: result.adapter });
	}
	const file: ResultsFile = {
		schema: RESULTS_SCHEMA_VERSION,
		createdAt: new Date().toISOString(),
		environment,
		cases: aggregate(completed),
	};
	status.textContent = `Done: ${plan.length} runs.`;
	table.replaceChildren(
		element('tr', {}, ...['case', 'adapter', 'status', 'headline (median over runs)'].map(h => element('th', {}, h))),
		...file.cases.map(c =>
			element(
				'tr',
				{},
				element('td', {}, c.caseId),
				element('td', {}, c.adapter),
				element('td', {}, c.status),
				element('td', {}, headline(c)),
			),
		),
	);
	const json = JSON.stringify(file, null, '\t');
	output.value = json;
	URL.revokeObjectURL(download.href);
	download.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
	download.download = `bench-${file.createdAt.replace(/[:.]/g, '-')}.json`;
	download.hidden = false;
}
