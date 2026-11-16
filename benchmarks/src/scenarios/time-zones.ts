// The stage 4 scenarios of time zones and sessions: frames in a time zone with a session schedule,
// and changes of the time zone at run time.

import { type ChartAdapter, supports } from '../adapter.ts';
import { generateSeries } from '../data.ts';
import { ms } from '../format.ts';
import { type ChangeTimings, changeTimings, createSettled, prepare, timeChange } from '../harness/steps.ts';
import { type DatasetSpec, type JobBase, type JobCase, K, M, datasetLabel } from '../jobs.ts';
import { MS, type Report, casesOf, cell, eachCase, runsNote, table } from '../report.ts';
import { type Requirement, type RunContext, defineScenario } from '../scenario.ts';
import {
	type FramesJob,
	type FramesRun,
	MOTIONS,
	QUICK_FRAME_ZOOMS,
	type ZoomLevel,
	framesHeadline,
	framesSection,
	motionLabel,
	runFrames,
	zoomLabel,
} from './frames.ts';

/** A library that shows time zones and sessions. */
export interface TimeZoneAdapter {
	/**
	 * Shows times in `timeZone` (an IANA name), and with `sessions` gives the chart the extended hours
	 * of a New York equity exchange, with breaks and shaded extended hours.
	 */
	setTimeZone(timeZone: string, sessions: boolean): void;
	/** Changes an option unrelated to time (the text color), which redraws like any change of options. */
	repaint(): void;
}

const REQUIRES: Requirement = { capability: 'timeZones', reason: 'the library shows no time zones or sessions' };

/**
 * The frames scenario with the chart in a time zone and with a session schedule (stage 4): the
 * time axis follows the wall clock of `timeZone`, and with `sessions` the chart has the extended
 * hours of a New York equity exchange (pre-market from 04:00, regular hours 09:30 to 16:00,
 * post-market to 20:00, Monday to Friday) with breaks drawn and extended hours shaded.
 */
export interface TimeZoneFramesJob extends Omit<FramesJob, 'scenario'> {
	readonly scenario: 'tz-frames';
	readonly timeZone: string;
	readonly sessions: boolean;
}

/**
 * Changes of the time zone at run time, with the data set loaded and `zoom` bars in view: first to
 * each of `zones` once (the first change to a zone in a page builds its table of offsets), then
 * `changes` more through all of them, then `changes` changes of an option that has nothing to do
 * with time (the text color), which cost a redraw like any change of options.
 */
export interface ZoneChangeJob extends JobBase {
	readonly scenario: 'tz-change';
	readonly zoom: ZoomLevel;
	readonly zones: readonly string[];
	readonly changes: number;
}

export interface ZoneChangeRun {
	/** The first change to each zone in the page, which builds its table. */
	cold: ChangeTimings;
	/** Later changes, between zones whose tables exist. */
	warm: ChangeTimings;
	/** Changes of the text color: what any change of options costs. */
	baseline: ChangeTimings;
	visibleBars: number;
}

// Stage 4: 1M one-minute candles (almost two years, so two changes to and from summer time a year)
// in New York time with the extended hours of an equity exchange.
const TIME_ZONE_DATASETS: readonly DatasetSpec[] = [{ kind: 'candles', size: M }];
const QUICK_TIME_ZONE_DATASETS: readonly DatasetSpec[] = [{ kind: 'candles', size: 10 * K }];
const TIME_ZONE_FRAME_ZOOMS: readonly ZoomLevel[] = [200, 2_000, 20_000, 200_000, 'all'];
const ZONE_CHANGE_ZOOMS: readonly ZoomLevel[] = [200, 20_000, 'all'];
/** Zones a change cycles through: summer time north and south, half-hour offsets, none. */
const CHANGE_ZONES: readonly string[] = [
	'America/New_York',
	'Europe/London',
	'Asia/Kolkata',
	'Australia/Lord_Howe',
	'Asia/Tokyo',
	'UTC',
];

/** Puts a chart of a stage 4 job into its time zone, with its sessions. */
function withTimeZone(adapter: ChartAdapter, timeZone: string, sessions: boolean): void {
	if (!supports<Pick<TimeZoneAdapter, 'setTimeZone'>>(adapter, 'setTimeZone')) {
		throw new Error('This adapter cannot show time zones');
	}
	adapter.setTimeZone(timeZone, sessions);
}

async function runZoneChange(job: ZoneChangeJob, { factory, container }: RunContext): Promise<ZoneChangeRun> {
	const data = generateSeries(job.dataset.kind, { seed: job.seed, count: job.dataset.size });
	const adapter = await createSettled(factory, container, job.chart);
	try {
		if (!supports<TimeZoneAdapter>(adapter, 'setTimeZone', 'repaint')) {
			throw new Error('This adapter cannot show time zones');
		}
		adapter.setData(prepare(adapter, data));
		await adapter.settle();
		const n = data.length;
		const visibleBars = job.zoom === 'all' ? n : Math.min(job.zoom, n);
		// The middle of the history: both ends of the view have bars, and the window around it too.
		const from = Math.floor((n - visibleBars) / 2);
		adapter.setVisibleLogicalRange({ from, to: from + visibleBars - 1 });
		await adapter.settle();

		const setZone = (zone: string) => () => adapter.setTimeZone(zone, false);
		const cold: [number, number, number][] = [];
		for (const zone of job.zones) {
			// UTC needs no table: it is not a first change.
			if (zone !== 'UTC') {
				cold.push(await timeChange(adapter, setZone(zone)));
			}
		}
		const warm: [number, number, number][] = [];
		let current = job.zones[job.zones.length - 1];
		for (let i = 0; i < job.changes; i++) {
			const zone = job.zones[i % job.zones.length]!;
			// A change to the zone already shown would change nothing.
			if (zone === current) {
				continue;
			}
			warm.push(await timeChange(adapter, setZone(zone)));
			current = zone;
		}
		const baseline: [number, number, number][] = [];
		for (let i = 0; i < job.changes; i++) {
			baseline.push(await timeChange(adapter, () => adapter.repaint()));
		}
		return { cold: changeTimings(cold), warm: changeTimings(warm), baseline: changeTimings(baseline), visibleBars };
	} finally {
		adapter.destroy();
	}
}

function zoneChangesSection(report: Report): string {
	const list = casesOf(report, 'tz-change');
	const rows: string[][] = [];
	for (const c of eachCase<ZoneChangeJob>(report, 'tz-change')) {
		const { adapter } = c;
		const zoom = c.job.zoom === 'all' ? `all ${datasetLabel(c.job.dataset)}` : String(c.job.zoom);
		for (const kind of ['cold', 'warm', 'baseline'] as const) {
			rows.push([
				zoom,
				adapter,
				kind === 'cold' ? 'first change to a zone' : kind === 'warm' ? 'later zone change' : 'text color change',
				cell(c, `${kind}.callMs.p50`, MS),
				cell(c, `${kind}.frameJsMs.p50`, MS),
				cell(c, `${kind}.workMs.p50`, MS),
				cell(c, `${kind}.workMs.max`, MS),
				cell(c, `${kind}.shownMs.p50`, MS),
				cell(c, `${kind}.workMs.count`),
			]);
		}
	}
	return (
		table(
			['Bars in view', 'Adapter', 'Change', 'Call p50', 'Frame JS p50', 'Work p50', 'Work max', 'Shown p50', 'Changes'],
			rows,
		) + `\nAll times in ms. Work is the call plus the JavaScript of the frames until drawn. ${runsNote(list)}\n`
	);
}

export const tzFrames = defineScenario<TimeZoneFramesJob, FramesRun>({
	name: 'tz-frames',
	order: 140,
	requires: REQUIRES,
	plan({ quick, chart, seed, budgetMs, warmupBudgetMs, keep }) {
		const timeZoneDatasets = (quick ? QUICK_TIME_ZONE_DATASETS : TIME_ZONE_DATASETS).filter(keep);
		const cases: JobCase<TimeZoneFramesJob>[] = [];
		for (const dataset of timeZoneDatasets) {
			for (const zoom of quick ? QUICK_FRAME_ZOOMS : TIME_ZONE_FRAME_ZOOMS) {
				if (zoom !== 'all' && zoom >= dataset.size) {
					continue;
				}
				for (const motion of MOTIONS) {
					cases.push({
						scenario: 'tz-frames',
						dataset,
						seed,
						chart,
						timeZone: 'America/New_York',
						sessions: true,
						zoom,
						motion,
						frames: quick ? 60 : 300,
						minFrames: quick ? 20 : 30,
						budgetMs,
						warmupFrames: quick ? 10 : 30,
						warmupBudgetMs,
					});
				}
			}
		}
		return cases;
	},
	caseParts: job => [motionLabel(job)],
	run: (job, context) => runFrames(job, context, adapter => withTimeZone(adapter, job.timeZone, job.sessions)),
	headline: framesHeadline,
	sections: [
		{ title: 'Time zone and sessions: pan and zoom frames', render: report => framesSection(report, 'tz-frames') },
	],
});

export const tzChange = defineScenario<ZoneChangeJob, ZoneChangeRun>({
	name: 'tz-change',
	order: 150,
	requires: REQUIRES,
	plan({ quick, chart, seed, keep }) {
		const timeZoneDatasets = (quick ? QUICK_TIME_ZONE_DATASETS : TIME_ZONE_DATASETS).filter(keep);
		const cases: JobCase<ZoneChangeJob>[] = [];
		for (const dataset of timeZoneDatasets) {
			for (const zoom of quick ? QUICK_FRAME_ZOOMS : ZONE_CHANGE_ZOOMS) {
				if (zoom !== 'all' && zoom >= dataset.size) {
					continue;
				}
				cases.push({
					scenario: 'tz-change',
					dataset,
					seed,
					chart,
					zoom,
					zones: CHANGE_ZONES,
					changes: quick ? 12 : 60,
				});
			}
		}
		return cases;
	},
	caseParts: job => [zoomLabel(job.zoom)],
	run: runZoneChange,
	headline(m) {
		return (
			`zone change work p50 ${ms(m('warm.workMs.p50'))} max ${ms(m('warm.workMs.max'))} ` +
			`(first to a zone p50 ${ms(m('cold.workMs.p50'))} max ${ms(m('cold.workMs.max'))}); ` +
			`other option change p50 ${ms(m('baseline.workMs.p50'))}; shown p50 ${ms(m('warm.shownMs.p50'))}`
		);
	},
	sections: [{ title: 'Time zone changes', render: zoneChangesSection }],
});
