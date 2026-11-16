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
		case 'ind-load':
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
		case 'ind-frames':
		case 'axes-frames':
		case 'tz-frames':
			return (
				`JS p50 ${ms(m('jsTime.p50'))} p95 ${ms(m('jsTime.p95'))}; ` +
				`interval p50 ${ms(m('interval.p50'))} p95 ${ms(m('interval.p95'))}`
			);
		case 'prepend':
		case 'ind-prepend':
			return (
				`shown p50 ${ms(m('shownMs.p50'))} p95 ${ms(m('shownMs.p95'))} max ${ms(m('shownMs.max'))}; ` +
				`first frame p50 ${ms(m('firstFrameMs.p50'))}; call p50 ${ms(m('callMs.p50'))}; ` +
				`longest frame ${ms(m('longestFrameMs.max'))}; retained ${mb(m('memory.retainedBytes'))}`
			);
		case 'ind-apply':
			return (
				`tick to applied avg ${ms(m('applied.mean'))} p99 ${ms(m('applied.p99'))} max ${ms(m('applied.max'))}; ` +
				`sync avg ${ms(m('sync.mean'))} p99 ${ms(m('sync.p99'))}; ticks ${m('applied.count') ?? '–'}`
			);
		case 'refetch':
			return (
				`shown p50 ${ms(m('shownMs.p50'))} p95 ${ms(m('shownMs.p95'))} max ${ms(m('shownMs.max'))} ` +
				`(frames p50 ${m('shownFrames.p50') ?? '–'}); ` +
				`fetches per jump p50 ${m('fetches.p50') ?? '–'}; retained after load ${mb(m('memoryAfterLoad.retainedBytes'))}, ` +
				`after the jumps ${mb(m('memory.retainedBytes'))}` +
				(m('operations.resolutionMs') === undefined
					? ''
					: `; correct let go p50 ${ms(m('operations.correctLetGoMs.p50'))}, remove p50 ${ms(m('operations.removeMs.p50'))}, ` +
						`resolution ${ms(m('operations.resolutionMs'))}`)
			);
		case 'drawings':
			return (
				`frame JS p50 ${ms(m('frameJs.p50'))} p99 ${ms(m('frameJs.p99'))} max ${ms(m('frameJs.max'))}` +
				(m('hitTest.p99') === undefined
					? ''
					: `; hit test mean ${ms(m('hitTestMean'))} p99 ${ms(m('hitTest.p99'))}; ` +
						`redraw p50 ${ms(m('redraw.p50'))} p99 ${ms(m('redraw.p99'))}; hits ${m('hits') ?? '–'}`) +
				`; frames ${m('frames') ?? '–'}`
			);
		case 'state':
			return (
				`save p50 ${ms(m('saveMs.p50'))} max ${ms(m('saveMs.max'))}; JSON ${m('jsonLength') ?? '–'} characters, ` +
				`stringify p50 ${ms(m('stringifyMs.p50'))}, parse p50 ${ms(m('parseMs.p50'))}; ` +
				`restore work p50 ${ms(m('restore.workMs.p50'))} max ${ms(m('restore.workMs.max'))} ` +
				`(call p50 ${ms(m('restore.callMs.p50'))}, frames p50 ${m('restoreFrames.p50') ?? '–'}); ` +
				`into an emptied chart work p50 ${ms(m('restoreEmpty.workMs.p50'))}`
			);
		case 'multi':
			return (
				`${m('charts') ?? '–'} charts in ${m('workers') ?? '–'} workers; shown ${ms(m('shownMs'))} ` +
				`(create ${ms(m('createMs'))}); retained ${mb(m('memory.retainedBytes'))} ` +
				`(page ${mb(m('memory.retainedPageBytes'))}, workers ${mb(m('memory.retainedWorkerBytes'))}); ` +
				`tick round: frame JS p50 ${ms(m('frameJs.p50'))} p95 ${ms(m('frameJs.p95'))}, ` +
				`main thread ${ms(m('tickMainThread.taskMs'))}; per tick ${ms(m('mainThreadPerTick.mean'))}`
			);
		case 'tz-change':
			return (
				`zone change work p50 ${ms(m('warm.workMs.p50'))} max ${ms(m('warm.workMs.max'))} ` +
				`(first to a zone p50 ${ms(m('cold.workMs.p50'))} max ${ms(m('cold.workMs.max'))}); ` +
				`other option change p50 ${ms(m('baseline.workMs.p50'))}; shown p50 ${ms(m('warm.shownMs.p50'))}`
			);
	}
}
