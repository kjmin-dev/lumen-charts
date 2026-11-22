import { DEFAULT_PRICE_SCALE_ID } from '../options';
import type { Palette } from './palette';

/** What heatmap and scatter series have in common. */
export interface MarkSeriesOptionsCommon {
	/** A hidden series is not drawn and does not take part in autoscaling. */
	visible: boolean;
	/** Id of the price scale the series is drawn on (see `SeriesOptionsCommon.priceScaleId`). */
	priceScaleId: string;
	/**
	 * Whether the prices in view take part in the autoscaling of the price scale: the points of a
	 * scatter in view, the whole grid of a heatmap. Off, the series follows the other series of the
	 * scale and is clipped where it leaves the pane.
	 */
	autoscale: boolean;
	/**
	 * Colors of the values, from the lowest to the highest: the name of a built-in palette (`viridis`,
	 * `inferno`, `turbo`, `greys`, `heat`, `blue-red`) or an array of CSS colors spaced evenly, written
	 * as `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()` or `transparent`. A color may be translucent.
	 */
	palette: Palette;
	/**
	 * The values that get the first and the last color of the palette; values beyond take those too.
	 * `null` (the default) takes the lowest or highest value the series has held since its last
	 * `setData`, so colors do not shift while the view moves.
	 */
	valueMin: number | null;
	valueMax: number | null;
	/** `log` spreads the palette over the logarithm of the values: for sizes that span magnitudes. */
	valueScale: 'linear' | 'log';
	/** Opacity of the whole series, 0 to 1. */
	opacity: number;
	/**
	 * The most marks (scatter points, heatmap cells) a frame draws from. A view that holds more is
	 * drawn from a coarser level of detail, whose marks are then wider than a pixel: the frame keeps
	 * its time and the picture loses detail. The default is what a frame can afford (see the
	 * measurements in the documentation); it applies from the next rows the view asks for.
	 */
	maxMarks: number;
}

/** Options of a heatmap series. Its price grid comes with its data (see `HeatmapData`). */
export interface HeatmapOptions extends MarkSeriesOptionsCommon {}

/** Options of a scatter series. */
export interface ScatterOptions extends MarkSeriesOptionsCommon {
	/** Color of points without a value, written like a palette color. */
	color: string;
	/**
	 * Width and height of a point in CSS pixels, for the points without a `size` of their own. A point
	 * is drawn whole device pixels wide, at least one and at most 256.
	 */
	pointSize: number;
	/** A `circle` needs a few pixels to look like one: below 3 device pixels points are squares. */
	shape: 'square' | 'circle';
	/**
	 * Where a point is drawn across the bar its time falls in. `center`: a point at a bar's time is at
	 * the middle of the bar, like the point of a line series, and later times lie toward the middle of
	 * the next bar. `start`: a point at a bar's time is at the bar's left edge, so the points of one
	 * bar's period spread over the width of that bar, as trades inside their candle.
	 */
	barAlign: 'center' | 'start';
	/**
	 * What a point's color shows. `value`: the palette's color for the point's value (`color` without
	 * one). `density`: the number of points that cover a device pixel, a mark of a coarse level of
	 * detail counting the points it holds, so the picture stays the same as the level changes. The
	 * palette then spans from 1 to the largest number in the frame, unless `valueMin` and `valueMax`
	 * fix it; `valueScale: 'log'` applies, and pixels without a point stay transparent.
	 */
	colorBy: 'value' | 'density';
}

const COMMON: MarkSeriesOptionsCommon = {
	visible: true,
	priceScaleId: DEFAULT_PRICE_SCALE_ID,
	autoscale: true,
	palette: 'viridis',
	valueMin: null,
	valueMax: null,
	valueScale: 'linear',
	opacity: 1,
	maxMarks: 1_000_000,
};

export const DEFAULT_HEATMAP_OPTIONS: HeatmapOptions = {
	...COMMON,
	palette: 'heat',
	autoscale: false,
	maxMarks: 2_000_000,
};

export const DEFAULT_SCATTER_OPTIONS: ScatterOptions = {
	...COMMON,
	color: '#2962ff',
	pointSize: 3,
	shape: 'square',
	barAlign: 'center',
	colorBy: 'value',
};

/** The two kinds of series drawn through a pixel buffer. */
export type MarkSeriesType = 'heatmap' | 'scatter';

export interface MarkSeriesOptionsMap {
	heatmap: HeatmapOptions;
	scatter: ScatterOptions;
}

export type AnyMarkOptions = HeatmapOptions | ScatterOptions;

export function defaultMarkOptions(type: MarkSeriesType): AnyMarkOptions {
	return type === 'heatmap' ? DEFAULT_HEATMAP_OPTIONS : DEFAULT_SCATTER_OPTIONS;
}
