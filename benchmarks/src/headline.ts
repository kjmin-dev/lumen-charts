import type { CaseResult } from './results.ts';
import { scenarios } from './scenarios/index.ts';

/** One-line summary of a case: the median over runs of its main metrics. */
export function headline(result: CaseResult): string {
	if (result.status === 'failed') {
		const first = result.runs[0];
		return first?.status === 'failed' ? `failed (${first.reason})` : 'failed';
	}
	const scenario = scenarios.find(s => s.name === result.job.scenario);
	return scenario?.headline(path => result.summary[path]?.median) ?? '';
}
