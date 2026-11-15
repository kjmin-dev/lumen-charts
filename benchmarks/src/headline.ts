import type { CaseResult } from './results.ts';

function ms(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value)) {
		return '–';
	}
	return value >= 100
		? `${value.toFixed(0)} ms`
		: value >= 1
			? `${value.toFixed(2)} ms`
			: `${(value * 1000).toFixed(1)} µs`;
}

function mb(value: number | undefined): string {
	return value === undefined || !Number.isFinite(value) ? '–' : `${(value / 2 ** 20).toFixed(1)} MiB`;
}

/** One-line summary of a case: the median over runs of its main metrics. */
export function headline(result: CaseResult): string {
	const m = (path: string): number | undefined => result.summary[path]?.median;
	if (result.status === 'failed') {
		const first = result.runs[0];
		return first?.status === 'failed' ? `failed (${first.reason})` : 'failed';
	}
	switch (result.job.scenario) {
		case 'load':
			return (
				`first frame ${ms(m('warm.firstFrameMs'))} (with conversion ${ms(m('warm.firstFrameWithConversionMs'))}, ` +
				`settled ${ms(m('warm.settledMs'))}, cold ${ms(m('cold.firstFrameMs'))}), ` +
				`retained ${mb(m('memory.retainedBytes'))} (page ${mb(m('memory.retainedPageBytes'))}, ` +
				`workers ${mb(m('memory.retainedWorkerBytes'))})`
			);
		case 'tick':
			return (
				`tick avg ${ms(m('sync.mean'))} p99 ${ms(m('sync.p99'))}; ` +
				`main thread incl. paint avg ${ms(m('mainThreadPerTick.mean'))} p99 ${ms(m('mainThreadPerTick.p99'))}; ` +
				`settle p99 ${ms(m('settle.p99'))}`
			);
		case 'frames':
			return (
				`JS p50 ${ms(m('jsTime.p50'))} p95 ${ms(m('jsTime.p95'))}; ` +
				`interval p50 ${ms(m('interval.p50'))} p95 ${ms(m('interval.p95'))}`
			);
		case 'prepend':
			return (
				`shown p50 ${ms(m('shownMs.p50'))} p95 ${ms(m('shownMs.p95'))} max ${ms(m('shownMs.max'))}; ` +
				`first frame p50 ${ms(m('firstFrameMs.p50'))}; call p50 ${ms(m('callMs.p50'))}; ` +
				`longest frame ${ms(m('longestFrameMs.max'))}; retained ${mb(m('memory.retainedBytes'))}`
			);
	}
}
