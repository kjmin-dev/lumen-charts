import { DEFAULT_PRICE_SCALE_ID, type LineStyle } from '../options';

/** The built-in drawing tools. */
export type DrawingType =
	| 'trendLine'
	| 'ray'
	| 'extendedLine'
	| 'horizontalLine'
	| 'verticalLine'
	| 'rectangle'
	| 'parallelChannel'
	| 'fibRetracement'
	| 'text'
	| 'priceRange';

export const DRAWING_TYPES: readonly DrawingType[] = [
	'trendLine',
	'ray',
	'extendedLine',
	'horizontalLine',
	'verticalLine',
	'rectangle',
	'parallelChannel',
	'fibRetracement',
	'text',
	'priceRange',
];

/** Number of points of each tool. */
export const POINT_COUNTS: Readonly<Record<DrawingType, number>> = {
	trendLine: 2,
	ray: 2,
	extendedLine: 2,
	horizontalLine: 1,
	verticalLine: 1,
	rectangle: 2,
	parallelChannel: 3,
	fibRetracement: 2,
	text: 1,
	priceRange: 2,
};

/**
 * One point of a drawing: a time (UTC milliseconds) and a price. Times need not be times of bars: a
 * time between two bars sits between them, and a time past the last bar sits in the future at the
 * spacing of the last bars, so a drawing keeps its place through prepends, deletions and changes of
 * resolution.
 */
export interface DrawingPoint {
	time: number;
	price: number;
}

/** Style and flags of a drawing. Every tool takes all of them and ignores what it has no use for. */
export interface DrawingOptions {
	/** Color of lines and borders. */
	color: string;
	/** Width of lines in CSS pixels. */
	lineWidth: number;
	lineStyle: LineStyle;
	/** Fill of rectangles, channels, Fibonacci levels, price ranges and text backgrounds; '' for none. */
	fillColor: string;
	/** Text of a text drawing, or a label on a line; '' for none. Lines are separated by `\n`. */
	text: string;
	textColor: string;
	/** Font size in CSS pixels; the family is the chart's `layout.fontFamily`. */
	fontSize: number;
	/** Levels of a Fibonacci retracement: 0 at the second point, 1 at the first. */
	levels: number[];
	visible: boolean;
	/** A locked drawing can be selected but not moved, edited or deleted with the keyboard. */
	locked: boolean;
	/**
	 * Whether the autoscale of its price scale keeps the drawing in view while its points' time span
	 * overlaps the pane (a horizontal line: always): the prices of its points, with every Fibonacci
	 * level and both lines of a channel. Default false: drawings leave the scale to the series.
	 */
	autoscale: boolean;
}

/** Version of `DrawingState`. A state of another version is refused by `DrawingsApi.add`. */
export const DRAWING_STATE_VERSION = 1;

/**
 * Plain-JSON state of a drawing: what `toJSON` returns and `DrawingsApi.add` takes back. Stable
 * across versions of the library while `version` is the same.
 */
export interface DrawingState {
	version: typeof DRAWING_STATE_VERSION;
	id: string;
	type: DrawingType;
	points: DrawingPoint[];
	options: DrawingOptions;
	/** Order among drawings: higher is drawn on top; equal ones in the order they were added. */
	zIndex: number;
	/** Pane it is drawn on; 0, the price pane. */
	pane: number;
	/**
	 * Id of the price scale its prices are on: `default`, or the id of another scale (see
	 * `ChartOptions.priceScales`). On a percentage or indexed scale prices map with the scale's base,
	 * as the crosshair reads them.
	 */
	priceScaleId: string;
}

/** What `DrawingsApi.add` takes: a state, with everything but the type and points optional. */
export interface DrawingInput {
	type: DrawingType;
	points: readonly DrawingPoint[];
	options?: Partial<DrawingOptions>;
	/** Kept if given and unused, otherwise a new one is made. */
	id?: string;
	zIndex?: number;
	pane?: number;
	priceScaleId?: string;
	version?: number;
}

export { DEFAULT_PRICE_SCALE_ID };

const BLUE = '#2962ff';

export const DEFAULT_FIB_LEVELS: readonly number[] = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

const BASE_OPTIONS: DrawingOptions = {
	color: BLUE,
	lineWidth: 2,
	lineStyle: 'solid',
	fillColor: '',
	text: '',
	textColor: BLUE,
	fontSize: 12,
	levels: DEFAULT_FIB_LEVELS as number[],
	visible: true,
	locked: false,
	autoscale: false,
};

const FILLS: Partial<Record<DrawingType, Partial<DrawingOptions>>> = {
	rectangle: { fillColor: 'rgba(41, 98, 255, 0.15)' },
	parallelChannel: { fillColor: 'rgba(41, 98, 255, 0.1)' },
	fibRetracement: { lineWidth: 1, fillColor: 'rgba(41, 98, 255, 0.06)' },
	priceRange: { lineWidth: 1, fillColor: 'rgba(41, 98, 255, 0.15)' },
	text: { text: 'Text', fontSize: 14 },
};

/** A drawing on the chart. */
export interface DrawingApi {
	readonly id: string;
	readonly type: DrawingType;
	/** Order among drawings: higher is drawn on top. */
	readonly zIndex: number;
	/** A copy of the points. */
	points(): DrawingPoint[];
	/** Replaces the points; as many as the tool has (see `POINT_COUNTS`). */
	setPoints(points: readonly DrawingPoint[]): void;
	options(): Readonly<DrawingOptions>;
	/** Merges options; values left out or undefined keep theirs. */
	applyOptions(options: Partial<DrawingOptions>): void;
	setZIndex(zIndex: number): void;
	/** Puts it above every other drawing. */
	bringToFront(): void;
	/** Puts it below every other drawing. */
	sendToBack(): void;
	/** Plain-JSON state, which `DrawingsApi.add` takes back. */
	toJSON(): DrawingState;
	remove(): void;
}

/** Events of `DrawingsApi.subscribe` with a drawing. */
export type DrawingEvent = 'created' | 'changed' | 'removed';
/** Events of `DrawingsApi.subscribe` with a drawing or null. */
export type DrawingStateEvent = 'selected' | 'hovered';

/**
 * The drawings of a chart, and the tools that create them with the pointer.
 *
 * With a tool started, clicks (or presses, drags and releases) place its points; the drawing is
 * created when the last one is placed, selected, and the tool ends. Without one, hovering a drawing
 * highlights it, pressing selects it, and dragging moves it, or one of its points by its handle.
 * Escape cancels a drawing being created or dragged and otherwise clears the selection; Delete and
 * Backspace remove the selected drawing unless it is locked. The chart takes keys once it has the
 * focus, which a click on it gives. With the crosshair in magnet mode, points placed or dragged by
 * a handle snap to the open, high, low or close of their bar.
 */
export interface DrawingsApi {
	/** Adds a drawing, also from the state another chart's `toJSON` returned. */
	add(drawing: DrawingInput): DrawingApi;
	get(id: string): DrawingApi | null;
	/** Every drawing, bottom to top. */
	list(): DrawingApi[];
	remove(drawing: DrawingApi | string): void;
	clear(): void;
	/** Starts creating a drawing with the pointer; `options` style it. Cancels a tool already started. */
	startTool(type: DrawingType, options?: Partial<DrawingOptions>): void;
	/** Stops the tool, dropping a drawing whose points are not all placed. */
	cancelTool(): void;
	activeTool(): DrawingType | null;
	select(drawing: DrawingApi | string | null): void;
	selected(): DrawingApi | null;
	hovered(): DrawingApi | null;
	/** The topmost drawing at `(x, y)`, CSS pixels from the chart element's top left corner. */
	hitTest(x: number, y: number): DrawingApi | null;
	/** The state of every drawing, bottom to top. */
	toJSON(): DrawingState[];
	/**
	 * Calls `handler` on an event; returns a function that stops it. `created` comes for drawings
	 * added through `add` too; `changed` for changes through the API, and once at the end of a drag.
	 */
	subscribe(event: DrawingEvent, handler: (drawing: DrawingApi) => void): () => void;
	subscribe(event: DrawingStateEvent, handler: (drawing: DrawingApi | null) => void): () => void;
}

/** Options of a new drawing of `type`: the defaults of its tool, then `options`. */
export function drawingOptions(type: DrawingType, options: Partial<DrawingOptions> | undefined): DrawingOptions {
	const merged: DrawingOptions = { ...BASE_OPTIONS, ...FILLS[type] };
	if (options !== undefined) {
		for (const key of Object.keys(options) as (keyof DrawingOptions)[]) {
			const value = options[key];
			if (value !== undefined) {
				(merged as unknown as Record<string, unknown>)[key] = key === 'levels' ? [...(value as number[])] : value;
			}
		}
	}
	return merged;
}
