/// <reference types="node" />
/// <reference types="vite/client" />
// The scenarios of the harness. They are found, not listed: every module in this directory is
// loaded, and every scenario it exports (made with `defineScenario`) is taken. Adding a scenario is
// adding a module here; nothing else names it.
//
// The page and the tests are compiled by Vite, which resolves `import.meta.glob` when it compiles
// this module. The runner and the reports run in Node as they are, where the directory is read
// instead. Scenario modules must not import this module, or one that does (`plan.ts`,
// `headline.ts`, `adapters/index.ts`): it waits for them to load.

import { type Scenario, isScenario } from '../scenario.ts';

type Modules = Record<string, Record<string, unknown>>;

/** The modules of this directory, in Node. */
async function importDirectory(): Promise<Modules> {
	const { readdirSync } = process.getBuiltinModule('node:fs');
	const modules: Modules = {};
	for (const file of readdirSync(new URL('.', import.meta.url))) {
		if (file.endsWith('.ts') && file !== 'index.ts' && !file.endsWith('.test.ts') && !file.endsWith('.d.ts')) {
			modules[file] = (await import(/* @vite-ignore */ new URL(file, import.meta.url).href)) as Record<string, unknown>;
		}
	}
	return modules;
}

// Vite defines `import.meta.env`; Node does not.
const modules: Modules =
	import.meta.env === undefined
		? await importDirectory()
		: import.meta.glob(['./*.ts', '!./index.ts', '!./*.test.ts', '!./*.d.ts'], { eager: true });

function collect(found: Modules): Scenario[] {
	const list: Scenario[] = [];
	for (const [file, exports] of Object.entries(found)) {
		for (const value of Object.values(exports)) {
			if (!isScenario(value)) {
				continue;
			}
			if (list.some(scenario => scenario.name === value.name)) {
				throw new Error(`Two scenarios are named "${value.name}" (the second is in scenarios/${file})`);
			}
			list.push(value);
		}
	}
	// By `order`, and by name where two have the same, so the order does not depend on the file system.
	list.sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : 1));
	return list;
}

/** Every scenario, in the order they run and are listed. */
export const scenarios: readonly Scenario[] = collect(modules);

/** The names `--scenario` takes. */
export const SCENARIOS: readonly string[] = scenarios.map(scenario => scenario.name);

export function findScenario(name: string): Scenario {
	const scenario = scenarios.find(s => s.name === name);
	if (scenario === undefined) {
		throw new Error(`Unknown scenario "${name}". Known: ${SCENARIOS.join(', ')}`);
	}
	return scenario;
}
