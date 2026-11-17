import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adapters } from '../../src/adapters/index.ts';
import type { PlanOptions } from '../../src/jobs.ts';
import { planJobs } from '../../src/plan.ts';
import { SCENARIOS, findScenario, scenarios } from '../../src/scenarios/index.ts';

// Vitest runs from the repository.
const directory = resolve(process.cwd(), 'benchmarks/src/scenarios');

const options: PlanOptions = {
	scenarios: SCENARIOS,
	adapters: ['a'],
	sizes: [],
	kinds: [],
	repeats: 1,
	quick: false,
	chart: { width: 1200, height: 600 },
	seed: 1,
};

describe('scenario registry', () => {
	it('finds every scenario, each under a name of its own', () => {
		expect(SCENARIOS.length).toBeGreaterThan(0);
		expect(new Set(SCENARIOS).size).toBe(SCENARIOS.length);
		expect(SCENARIOS.filter(name => !/^[a-z][a-z0-9-]*$/.test(name))).toEqual([]);
		expect(SCENARIOS.map(name => findScenario(name).name)).toEqual(SCENARIOS);
		expect(() => findScenario('nope')).toThrow(/Unknown scenario/);
	});

	it('takes a scenario from every module of the directory', () => {
		const modules = import.meta.glob<Record<string, unknown>>(
			['../../src/scenarios/*.ts', '!../../src/scenarios/index.ts'],
			{ eager: true },
		);
		const files = readdirSync(directory).filter(file => file.endsWith('.ts') && file !== 'index.ts');
		expect(Object.keys(modules).map(path => path.slice(path.lastIndexOf('/') + 1))).toEqual(files);
		const known: readonly unknown[] = scenarios;
		const without = Object.entries(modules).filter(
			([, exports]) => !Object.values(exports).some(v => known.includes(v)),
		);
		expect(without.map(([path]) => path)).toEqual([]);
	});

	it('gives every scenario all its parts', () => {
		const incomplete = scenarios.filter(
			scenario =>
				!Number.isFinite(scenario.order) ||
				typeof scenario.plan !== 'function' ||
				typeof scenario.caseParts !== 'function' ||
				typeof scenario.run !== 'function' ||
				typeof scenario.headline !== 'function' ||
				// A summary of a case without metrics is still a line of text.
				typeof scenario.headline(() => undefined) !== 'string' ||
				scenario.sections.length === 0 ||
				scenario.sections.some(section => section.title === '' || typeof section.render !== 'function'),
		);
		expect(incomplete.map(scenario => scenario.name)).toEqual([]);
		const titles = scenarios.flatMap(scenario => scenario.sections.map(section => section.title));
		expect(new Set(titles).size).toBe(titles.length);
	});

	it('requires only what some adapter can do', () => {
		// A capability no adapter has is a misspelled one: the scenario would never run.
		const never = scenarios.filter(
			({ requires }) =>
				requires !== undefined &&
				(requires.reason === '' || !adapters.some(adapter => adapter.capabilities?.includes(requires.capability))),
		);
		expect(never.map(scenario => scenario.name)).toEqual([]);
	});

	it('orders the scenarios by their order, then by name', () => {
		const sorted = [...scenarios];
		sorted.sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : 1));
		expect(SCENARIOS).toEqual(sorted.map(scenario => scenario.name));
	});

	it.each([false, true])('plans cases for every scenario, named after it and its data set (quick: %s)', quick => {
		const { jobs } = planJobs({ ...options, quick });
		expect(new Set(jobs.map(p => p.id)).size).toBe(jobs.length);
		expect(SCENARIOS.filter(name => !jobs.some(p => p.job.scenario === name))).toEqual([]);
		const misnamed = jobs.filter(p => !p.caseId.startsWith(`${p.job.scenario}/${p.job.dataset.kind}-`));
		expect(misnamed.map(p => p.caseId)).toEqual([]);
	});

	it('finds the same scenarios in Node, which reads the directory, as under Vite', () => {
		// The runner and the reports run the sources in Node as they are.
		const script = "import { SCENARIOS } from './index.ts'; process.stdout.write(JSON.stringify(SCENARIOS));";
		const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
			cwd: directory,
			encoding: 'utf8',
		});
		expect(JSON.parse(output)).toEqual(SCENARIOS);
	});
});
