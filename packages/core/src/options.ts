export interface ChartOptions {
	/** Width in CSS pixels. Ignored while `autoSize` is on. */
	width: number;
	/** Height in CSS pixels. Ignored while `autoSize` is on. */
	height: number;
	/** Follow the size of the container element. */
	autoSize: boolean;
	/** Background color (any CSS color). */
	background: string;
	/** Color of axis labels. */
	textColor: string;
	/** Color of grid lines and axis borders. */
	gridColor: string;
	/** Color of the crosshair lines and its labels. */
	crosshairColor: string;
	/** Font size of axis labels in CSS pixels. */
	fontSize: number;
	fontFamily: string;
	/** Width of one bar in CSS pixels when data is first shown. */
	barSpacing: number;
	/** Empty space right of the last bar when data is first shown, in bars. */
	rightOffset: number;
	/**
	 * Where the data engine runs. `true` uses a worker and falls back to the main thread if the
	 * page blocks workers; `false` always uses the main thread; a function supplies the worker.
	 * Read once, when the first series is added.
	 */
	worker: boolean | (() => Worker);
}

export const DEFAULT_OPTIONS: ChartOptions = {
	width: 600,
	height: 300,
	autoSize: true,
	background: '#ffffff',
	textColor: '#4a5160',
	gridColor: '#eceef2',
	crosshairColor: '#6b7280',
	fontSize: 12,
	fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
	barSpacing: 6,
	rightOffset: 0,
	worker: true,
};

export interface CandlestickOptions {
	upColor: string;
	downColor: string;
	wickUpColor: string;
	wickDownColor: string;
	/** Show a line and an axis label at the latest close. */
	lastValueVisible: boolean;
}

export interface LineOptions {
	color: string;
	/** Line width in CSS pixels. */
	lineWidth: number;
	/** Show a line and an axis label at the latest value. */
	lastValueVisible: boolean;
}

export const DEFAULT_CANDLESTICK_OPTIONS: CandlestickOptions = {
	upColor: '#26a69a',
	downColor: '#ef5350',
	wickUpColor: '#26a69a',
	wickDownColor: '#ef5350',
	lastValueVisible: true,
};

export const DEFAULT_LINE_OPTIONS: LineOptions = {
	color: '#2962ff',
	lineWidth: 2,
	lastValueVisible: true,
};

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
