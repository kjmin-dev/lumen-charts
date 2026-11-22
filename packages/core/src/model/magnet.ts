import type { Series } from '../series';

/** What the magnet snapped the crosshair to: a series, its value, and the device row of the value. */
export interface MagnetSnap {
	series: Series | null;
	value: number;
	y: number;
}

/**
 * Snaps the crosshair's horizontal line to a value of the bar in row `row` of the window drawn.
 *
 * The candidates are the values of that bar of every visible series in the pane under the pointer
 * (the series whose price scale spans the pointer's `cssY`), each placed by the series' own price
 * scale as last drawn. With `ohlc` (`magnet` mode) a bar or candle offers its open, high, low and
 * close; otherwise (`nearest` mode) its close. A series of single values offers its value. Values
 * the pane does not show are left out. The value nearest to the pointer on screen, in pixels, wins;
 * at equal distances the series drawn first, and of one bar the open, high, low and close in that
 * order. Returns false, and leaves `snap` as it was, when no series has a value there.
 */
export function snapToBar(
	series: readonly Series[],
	row: number,
	cssY: number,
	ratio: number,
	ohlc: boolean,
	snap: MagnetSnap,
): boolean {
	const pointer = cssY * ratio;
	let distance = Infinity;
	for (let s = 0; s < series.length; s++) {
		const candidate = series[s]!;
		const scale = candidate.axis?.scale;
		if (
			scale === undefined ||
			!candidate.seriesOptions.visible ||
			!scale.hasRange ||
			!scale.contains(cssY) ||
			row < 0 ||
			row >= candidate.close.length
		) {
			continue;
		}
		const first = ohlc && candidate.kind === 'ohlcv' ? 0 : 3;
		for (let c = first; c < 4; c++) {
			const value = (c === 0 ? candidate.open : c === 1 ? candidate.high : c === 2 ? candidate.low : candidate.close)[
				row
			]!;
			const y = candidate.deviceY(value);
			// NaN (a gap, or a price the scale cannot show) fails both.
			if (!scale.contains(y / ratio)) {
				continue;
			}
			const d = Math.abs(y - pointer);
			if (d < distance) {
				distance = d;
				snap.series = candidate;
				snap.value = value;
				snap.y = y;
			}
		}
	}
	return distance < Infinity;
}
