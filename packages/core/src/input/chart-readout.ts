import type { ChartIndicators } from '../indicators';
import type { ChartMarks } from '../marks/chart-marks';
import type { FrameModel } from '../model/frame-model';
import type { TimeDisplay } from '../model/time-display';
import type { Series } from '../series';

function price(series: Series, value: number) {
	const { minMove, precision } = series.seriesOptions;
	return Number.isFinite(value) ? series.axis!.scale.formatPrice(value, minMove, precision) : 'unavailable';
}

/** Screen reader text comes from the same bound columns and LOD as the painted chart. */
export class ChartReadout {
	private readonly optionRefs: object[] = [];
	private readonly readers: { series: Series; name: string }[] = [];
	private inventory = '';
	private count = -1;
	private from = NaN;
	private to = NaN;
	private size = 0;
	private low = NaN;
	private high = NaN;
	constructor(
		private readonly model: FrameModel,
		private readonly time: TimeDisplay,
		private readonly series: readonly Series[],
		private readonly indicators: ChartIndicators,
		private readonly marks: ChartMarks,
	) {}

	private date(time: number) {
		return this.time.format.crosshair(time, this.model.timeTicks.dates ? time : this.time.zone.wall(time));
	}

	/** Detect additions, removals and option replacements without allocating on ticks. */
	updateInventory(): boolean {
		let n = 0;
		let changed = this.optionRefs.length !== this.series.length + this.marks.list.length;
		for (const s of this.series) {
			if (this.optionRefs[n] !== s.seriesOptions) changed = true;
			this.optionRefs[n++] = s.seriesOptions;
		}
		for (const mark of this.marks.list) {
			if (this.optionRefs[n] !== mark.seriesOptions) changed = true;
			this.optionRefs[n++] = mark.seriesOptions;
		}
		if (!changed && this.inventory) return false;
		this.optionRefs.length = n;
		this.readers.length = 0;
		for (const s of this.series) {
			if (!s.derived && s.seriesOptions.visible) this.readers.push({ series: s, name: s.id + ' ' + s.type });
		}
		for (const indicator of this.indicators.list) {
			for (const output of indicator.outputList) {
				if (output.series.seriesOptions.visible)
					this.readers.push({ series: output.series, name: indicator.id + ' ' + indicator.name + ' ' + output.name });
			}
		}
		const names = this.readers.map(reader => reader.name);
		for (const mark of this.marks.list) if (mark.seriesOptions.visible) names.push(mark.id + ' ' + mark.type);
		this.inventory = names.length ? 'Visible series include ' + names.join(', ') + '.' : 'No visible series.';
		return true;
	}

	/** Null when the passive description is already current. */
	summary(count: number, size: number, description: string, force: boolean): string | null {
		const { drawn, geometry } = this.model;
		const available = drawn && geometry.to > geometry.from && !drawn.stale;
		const from = available ? drawn.time[geometry.from - drawn.start]! : NaN;
		const to = available ? drawn.time[geometry.to - 1 - drawn.start]! : NaN;
		const main = this.readers[0];
		const low = main?.series.view.min ?? NaN,
			high = main?.series.view.max ?? NaN;
		if (
			!force &&
			this.count === count &&
			Object.is(this.from, from) &&
			Object.is(this.to, to) &&
			this.size === size &&
			Object.is(this.low, low) &&
			Object.is(this.high, high)
		)
			return null;
		this.from = from;
		this.to = to;
		this.count = count;
		this.size = size;
		this.low = low;
		this.high = high;
		const parts = [description, count ? count + (count === 1 ? ' bar.' : ' bars.') : 'No chart data.', this.inventory];
		if (Number.isFinite(from) && Number.isFinite(to)) {
			parts.push(
				(size === 1 ? 'Visible data' : 'Visible bucket start times') +
					' from ' +
					this.date(from) +
					' to ' +
					this.date(to) +
					'.',
			);
			if (main?.series.axis && Number.isFinite(low) && Number.isFinite(high))
				parts.push(main.name + ' ranges from ' + price(main.series, low) + ' to ' + price(main.series, high) + '.');
		}
		return parts.filter(Boolean).join(' ');
	}

	cursorY(row: number, ratio: number, fallback: number) {
		for (const { series } of this.readers) {
			const projected = series.deviceY(series.close[row]!);
			if (Number.isFinite(projected)) return projected / ratio;
		}
		return fallback;
	}

	sample(row: number, time: number, prefix: string, aggregated: boolean) {
		const parts = [prefix, this.date(time)];
		for (const { series: s, name } of this.readers) {
			const close = s.close[row];
			if (close === undefined || !Number.isFinite(close) || !s.axis) {
				parts.push(name + ', no value');
				continue;
			}
			if (s.type === 'candlestick') {
				parts.push(
					name +
						', open ' +
						price(s, s.open[row]!) +
						', high ' +
						price(s, s.high[row]!) +
						', low ' +
						price(s, s.low[row]!) +
						', close ' +
						price(s, close),
				);
			} else if (aggregated) {
				parts.push(
					name + ', low ' + price(s, s.low[row]!) + ', high ' + price(s, s.high[row]!) + ', last ' + price(s, close),
				);
			} else parts.push(name + ', ' + price(s, close));
		}
		const visible = parts.slice(1, 3).join('. ');
		for (const mark of this.marks.list) {
			if (!mark.seriesOptions.visible) continue;
			const w = mark.window;
			const count =
				w.level < 0
					? 'data unavailable'
					: mark.type === 'heatmap'
						? w.total + ' columns by ' + w.rows + ' price levels'
						: w.total + ' points';
			parts.push(mark.id + ' ' + mark.type + ', ' + count + (w.level > 0 ? ' at aggregated detail' : ''));
		}
		return { visible, spoken: parts.join('. ') };
	}
}
