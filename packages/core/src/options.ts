/** Every key optional, at every level. Functions and arrays are taken as they are. */
export type DeepPartial<T> = T extends (...args: never[]) => unknown
	? T
	: T extends readonly unknown[]
		? T
		: T extends object
			? { [K in keyof T]?: DeepPartial<T[K]> }
			: T;

export type LineStyle = 'solid' | 'dotted' | 'dashed';

export type ThemeName = 'light' | 'dark';

export interface LayoutOptions {
	/** Background of the pane and the axes (any CSS color). */
	background: string;
	/** Color of axis labels. */
	textColor: string;
	/** Font size of axis labels in CSS pixels. */
	fontSize: number;
	fontFamily: string;
}

export interface GridLineOptions {
	visible: boolean;
	color: string;
	style: LineStyle;
}

export interface GridOptions {
	/** Lines at the time axis ticks. */
	vertLines: GridLineOptions;
	/** Lines at the price axis ticks. */
	horzLines: GridLineOptions;
}

/**
 * `normal` follows the pointer; `magnet` puts the horizontal line on the close of the bar under the
 * pointer; `hidden` shows no crosshair.
 */
export type CrosshairMode = 'normal' | 'magnet' | 'hidden';

export interface CrosshairLineOptions {
	visible: boolean;
	color: string;
	/** Width in CSS pixels. */
	width: number;
	style: LineStyle;
	/** Show the value of the line on its axis. */
	labelVisible: boolean;
	labelBackgroundColor: string;
}

export interface CrosshairOptions {
	mode: CrosshairMode;
	vertLine: CrosshairLineOptions;
	horzLine: CrosshairLineOptions;
}

export interface PriceScaleOptions {
	/** When hidden, the pane takes the full width and value labels are not shown. */
	visible: boolean;
	position: 'left' | 'right';
	borderVisible: boolean;
	borderColor: string;
	/**
	 * Empty space above and below the visible prices, as fractions of the pane height. Their sum is
	 * kept below 1.
	 */
	scaleMargins: { top: number; bottom: number };
}

export interface TimeScaleOptions {
	/** When hidden, the pane takes the full height and the crosshair shows no time label. */
	visible: boolean;
	borderVisible: boolean;
	borderColor: string;
	/** Width of one bar in CSS pixels when data is first shown. */
	barSpacing: number;
	/** Empty space right of the last bar when data is first shown, in bars. */
	rightOffset: number;
}

/** Text drawn behind the series, for example the symbol and interval. */
export interface WatermarkOptions {
	visible: boolean;
	/** Lines are separated by `\n`. */
	text: string;
	color: string;
	/** Font size in CSS pixels; the family is `layout.fontFamily`. */
	fontSize: number;
	horzAlign: 'left' | 'center' | 'right';
	vertAlign: 'top' | 'center' | 'bottom';
}

export interface ChartOptions {
	/** Width in CSS pixels. Ignored while `autoSize` is on. */
	width: number;
	/** Height in CSS pixels. Ignored while `autoSize` is on. */
	height: number;
	/** Follow the size of the container element. */
	autoSize: boolean;
	/**
	 * Color preset. Colors set explicitly take precedence and are kept when the theme changes.
	 * `auto` follows the system setting (`prefers-color-scheme`) and switches with it.
	 */
	theme: ThemeName | 'auto';
	layout: LayoutOptions;
	grid: GridOptions;
	crosshair: CrosshairOptions;
	priceScale: PriceScaleOptions;
	timeScale: TimeScaleOptions;
	watermark: WatermarkOptions;
	/**
	 * Where the data engine runs. `true` uses a worker and falls back to the main thread if the
	 * page blocks workers; `false` always uses the main thread; a function supplies the worker.
	 * Read once, when the first series is added.
	 *
	 * Charts share workers: the charts of a page run in at most `getMaxWorkers()` workers (see
	 * `setMaxWorkers`), each chart with a data engine of its own inside its worker. Charts given
	 * the same function share the workers it makes, and it is called once per worker; a chart given
	 * a function of its own has a worker of its own.
	 */
	worker: boolean | (() => Worker);
	/**
	 * Memory the data engine aims to stay under, in bytes. It applies to every series with a
	 * `datafeed`: bars far from the view are let go and fetched back from the datafeed when they are
	 * needed again, each chunk let go keeping a summary of its times to check them. The levels of
	 * detail always stay, so zoomed-out views keep drawing meanwhile. A series without a datafeed is
	 * never let go. Default: no limit.
	 */
	memoryLimit: number;
}

/** The colors a theme sets. Everything else is the same in every theme. */
export interface ThemeColors {
	layout: { background: string; textColor: string };
	grid: { vertLines: { color: string }; horzLines: { color: string } };
	crosshair: {
		vertLine: { color: string; labelBackgroundColor: string };
		horzLine: { color: string; labelBackgroundColor: string };
	};
	priceScale: { borderColor: string };
	timeScale: { borderColor: string };
	watermark: { color: string };
}

function themeColors(
	background: string,
	text: string,
	grid: string,
	border: string,
	crosshair: string,
	label: string,
	watermark: string,
): ThemeColors {
	return {
		layout: { background, textColor: text },
		grid: { vertLines: { color: grid }, horzLines: { color: grid } },
		crosshair: {
			vertLine: { color: crosshair, labelBackgroundColor: label },
			horzLine: { color: crosshair, labelBackgroundColor: label },
		},
		priceScale: { borderColor: border },
		timeScale: { borderColor: border },
		watermark: { color: watermark },
	};
}

/** Built-in color presets, selected with the `theme` option. */
export const themes: Readonly<Record<ThemeName, ThemeColors>> = {
	light: themeColors('#ffffff', '#4a5160', '#eceef2', '#dcdfe5', '#6b7280', '#4a5160', 'rgba(74, 81, 96, 0.12)'),
	dark: themeColors('#0e1116', '#aab2c0', '#1c2230', '#2a3140', '#5c6578', '#363d4c', 'rgba(170, 178, 192, 0.1)'),
};

function crosshairLine(): CrosshairLineOptions {
	return { visible: true, color: '', width: 1, style: 'dashed', labelVisible: true, labelBackgroundColor: '' };
}

/** Defaults without colors; `resolveOptions` lays a theme over them. */
const BASE_OPTIONS: ChartOptions = {
	width: 600,
	height: 300,
	autoSize: true,
	theme: 'light',
	layout: {
		background: '',
		textColor: '',
		fontSize: 12,
		fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
	},
	grid: {
		vertLines: { visible: true, color: '', style: 'solid' },
		horzLines: { visible: true, color: '', style: 'solid' },
	},
	crosshair: { mode: 'normal', vertLine: crosshairLine(), horzLine: crosshairLine() },
	priceScale: {
		visible: true,
		position: 'right',
		borderVisible: true,
		borderColor: '',
		scaleMargins: { top: 0.1, bottom: 0.1 },
	},
	timeScale: { visible: true, borderVisible: true, borderColor: '', barSpacing: 6, rightOffset: 0 },
	watermark: { visible: false, text: '', color: '', fontSize: 48, horzAlign: 'center', vertAlign: 'center' },
	worker: true,
	memoryLimit: Infinity,
};

/**
 * Full options from what the user set: the defaults, then the colors of the theme, then `input`.
 * `dark` tells which theme `auto` stands for. Keys the options do not have are ignored.
 */
export function resolveOptions(input: DeepPartial<ChartOptions>, dark: boolean): ChartOptions {
	const theme = input.theme ?? BASE_OPTIONS.theme;
	const name: ThemeName = theme === 'auto' ? (dark ? 'dark' : 'light') : theme === 'dark' ? 'dark' : 'light';
	return mergeKnown<ChartOptions>(
		mergeKnown<ChartOptions>(BASE_OPTIONS, themes[name] as DeepPartial<ChartOptions>),
		input,
	);
}

export interface SeriesOptionsCommon {
	/** A hidden series is not drawn and does not take part in autoscaling. */
	visible: boolean;
	/** Show the latest value as a label on the price axis. */
	lastValueVisible: boolean;
	/** Show a horizontal line across the pane at the latest value. */
	priceLineVisible: boolean;
	/** Color of that line; empty takes the color of the series. */
	priceLineColor: string;
	/** Width of that line in CSS pixels. */
	priceLineWidth: number;
	priceLineStyle: LineStyle;
}

export interface CandlestickOptions extends SeriesOptionsCommon {
	upColor: string;
	downColor: string;
	wickVisible: boolean;
	wickUpColor: string;
	wickDownColor: string;
	/** Outline bodies. Bodies too narrow for an outline and a fill are drawn filled. */
	borderVisible: boolean;
	borderUpColor: string;
	borderDownColor: string;
}

export interface LineOptions extends SeriesOptionsCommon {
	color: string;
	/** Line width in CSS pixels. */
	lineWidth: number;
	lineStyle: LineStyle;
	/** `step` holds each value until the next bar, then jumps. */
	lineType: 'simple' | 'step';
	/** Show a dot on the line under the crosshair. */
	crosshairMarkerVisible: boolean;
	/** Radius of that dot in CSS pixels. */
	crosshairMarkerRadius: number;
}

/** A bar per point from `base` to the value, for volume or an oscillator's histogram. */
export interface HistogramOptions extends SeriesOptionsCommon {
	/** Color of bars at or above the base. */
	color: string;
	/** Color of bars below the base; empty takes `color`. */
	negativeColor: string;
	/** Value the bars start from. Autoscale always includes it. */
	base: number;
}

const COMMON_SERIES_OPTIONS: SeriesOptionsCommon = {
	visible: true,
	lastValueVisible: true,
	priceLineVisible: true,
	priceLineColor: '',
	priceLineWidth: 1,
	priceLineStyle: 'dashed',
};

export const DEFAULT_CANDLESTICK_OPTIONS: CandlestickOptions = {
	...COMMON_SERIES_OPTIONS,
	upColor: '#26a69a',
	downColor: '#ef5350',
	wickVisible: true,
	wickUpColor: '#26a69a',
	wickDownColor: '#ef5350',
	borderVisible: false,
	borderUpColor: '#26a69a',
	borderDownColor: '#ef5350',
};

export const DEFAULT_LINE_OPTIONS: LineOptions = {
	...COMMON_SERIES_OPTIONS,
	color: '#2962ff',
	lineWidth: 2,
	lineStyle: 'solid',
	lineType: 'simple',
	crosshairMarkerVisible: true,
	crosshairMarkerRadius: 4,
};

export const DEFAULT_HISTOGRAM_OPTIONS: HistogramOptions = {
	...COMMON_SERIES_OPTIONS,
	priceLineVisible: false,
	color: '#26a69a',
	negativeColor: '',
	base: 0,
};

type Plain = Record<string, unknown>;

function isPlain(value: unknown): value is Plain {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Copy of `base` with the defined values of `patch` merged in, recursing into nested objects.
 * Keys that `base` lacks are added, so a patch can be accumulated onto another patch.
 */
export function mergeOptions<T extends object>(base: T, patch: DeepPartial<T> | undefined): T {
	return merge(base, patch, false);
}

/** Like `mergeOptions`, but keys that `base` lacks are ignored. */
function mergeKnown<T extends object>(base: T, patch: DeepPartial<T> | undefined): T {
	return merge(base, patch, true);
}

function merge<T extends object>(base: T, patch: unknown, knownOnly: boolean): T {
	if (!isPlain(patch)) {
		return base;
	}
	const result: Plain = { ...(base as Plain) };
	for (const key of Object.keys(patch)) {
		const value = patch[key];
		if (value === undefined || (knownOnly && !(key in result))) {
			continue;
		}
		const current = result[key];
		if (isPlain(value)) {
			if (isPlain(current)) {
				result[key] = merge(current, value, knownOnly);
			} else if (!knownOnly) {
				// A copy, so the caller changing its object later does not change the options.
				result[key] = merge({}, value, false);
			}
		} else if (!knownOnly || !isPlain(current)) {
			result[key] = value;
		}
	}
	return result as T;
}

/** Structural equality of option values. */
export function optionsEqual(a: unknown, b: unknown): boolean {
	if (a === b) {
		return true;
	}
	if (!isPlain(a) || !isPlain(b)) {
		return false;
	}
	const keys = Object.keys(a);
	if (keys.length !== Object.keys(b).length) {
		return false;
	}
	for (const key of keys) {
		if (!optionsEqual(a[key], b[key])) {
			return false;
		}
	}
	return true;
}

/** Copy of `value` without the keys whose value is undefined. */
export function definedOnly<T extends object>(value: Partial<T>): Partial<T> {
	const result: Partial<T> = {};
	for (const key of Object.keys(value) as (keyof T)[]) {
		if (value[key] !== undefined) {
			result[key] = value[key];
		}
	}
	return result;
}

export function shallowEqual<T extends object>(a: T, b: T): boolean {
	for (const key of Object.keys(a) as (keyof T)[]) {
		if (a[key] !== b[key]) {
			return false;
		}
	}
	return true;
}
