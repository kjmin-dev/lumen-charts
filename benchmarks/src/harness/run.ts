import { findAdapter } from '../adapters/index.ts';
import type { AdapterInfo, Job, PageRunResult } from '../jobs.ts';
import type { Probes } from '../scenario.ts';
import { findScenario } from '../scenarios/index.ts';

export async function runJob(job: Job, container: HTMLElement, probes: Probes): Promise<PageRunResult> {
	let info: AdapterInfo | null = null;
	try {
		const factory = await findAdapter(job.adapter).load();
		info = { library: { ...factory.library }, options: { ...factory.options } };
		const result = await findScenario(job.scenario).run(job, { factory, container, probes });
		return { status: 'ok', adapter: info, result };
	} catch (error) {
		const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
		return { status: 'failed', adapter: info, message };
	} finally {
		container.replaceChildren();
	}
}
