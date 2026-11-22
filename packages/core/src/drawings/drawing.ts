import {
	type AutoscaleRange,
	type DrawTarget,
	HIT_BODY,
	HIT_NONE,
	type PanePrimitive,
	type PaneView,
	type PrimitiveBounds,
	type PrimitiveHost,
} from '../primitives';
import { NO_DASH, dashPattern } from '../render/chrome';
import { clipLine, crisp, nearSegment } from './geometry';
import {
	DEFAULT_PRICE_SCALE_ID,
	DRAWING_STATE_VERSION,
	type DrawingApi,
	type DrawingOptions,
	type DrawingPoint,
	type DrawingState,
	type DrawingType,
	POINT_COUNTS,
	drawingOptions,
} from './types';

/** Radius of a point's handle, in CSS pixels. */
export const HANDLE_RADIUS = 5;
/** Space between a label and what it labels, in CSS pixels. */
const LABEL_PAD = 4;
/** Handles of a box: its four corners, then the middles of its four edges. */
const BOX_HANDLES = 8;
/** A side of a box has a handle in its middle from this length on, so it stays clear of the corners'. */
const MIN_EDGE = 4 * HANDLE_RADIUS;

/** What every drawing of a chart shares: how handles look and how text is measured. */
export interface DrawingStyle {
	/** Fill of handles: the pane background. */
	handleFill: string;
	fontFamily: string;
	/** Width of `text` in `font` (a CSS font with a size in CSS pixels), in CSS pixels. */
	measure(text: string, font: string): number;
}

/** What a drawing tells the chart's drawings. */
export interface DrawingOwner {
	readonly style: DrawingStyle;
	/** Points or options changed through the API. */
	changed(drawing: Drawing): void;
	reorder(drawing: Drawing): void;
	remove(drawing: Drawing): void;
	/** Highest and lowest `zIndex` among the drawings. */
	zRange(): { min: number; max: number };
}

// Layout of `Drawing.geometry`, CSS pixels in the pane.
/** Points: x and y of each. */
const G_POINTS = 0;
/** The visible segment of a line, the box of a rectangle, range or text: four numbers. */
const G_A = 6;
/** The parallel line of a channel. */
const G_B = 10;
/** The middle line of a channel. */
const G_C = 14;
/** Where a label goes. */
const G_LABEL = 18;
/** Handles of a box (see `BOX_HANDLES`): x and y of each, NaN for one that is left out. */
const G_HANDLES = 20;
const G_SIZE = G_HANDLES + 2 * BOX_HANDLES;

/** Shared by drawings without Fibonacci levels, which is most of them. */
const NO_ROWS = new Float64Array(0);

let nextId = 0;

/** A new id, unique enough to tell drawings apart across saves and restores. */
function newId(): string {
	const random =
		typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
			? crypto.randomUUID().slice(0, 8)
			: Math.floor(Math.random() * 0xffffffff).toString(16);
	return `d-${Date.now().toString(36)}-${random}-${(nextId++).toString(36)}`;
}

function empty(bounds: PrimitiveBounds): void {
	bounds.left = Infinity;
	bounds.right = -Infinity;
}

/**
 * A built-in drawing: points stored as times and prices, drawn as a pane primitive in the drawings
 * layer. The logical positions of the points are cached until the timeline changes, and the screen
 * geometry until the view or the drawing does, so hit tests and redraws read plain numbers.
 */
export class Drawing implements PanePrimitive, DrawingApi {
	public readonly zOrder = 'normal';
	public readonly id: string;
	public readonly type: DrawingType;
	public readonly pane: number;
	public readonly priceScaleId: string;
	public zIndex: number;
	/** Number of points. */
	public readonly count: number;
	/**
	 * Number of handles: one per point, and for a box (rectangle, price range) its four corners and
	 * the middles of its four edges, all derived from its two points.
	 */
	public readonly handleCount: number;
	public readonly times: Float64Array;
	public readonly prices: Float64Array;
	/** Logical positions of the points, as of `_timeline`. */
	public readonly logical: Float64Array;
	/** Screen geometry, see the `G_` offsets. */
	public readonly geometry: Float64Array;
	/** Whether the last `update` found it in the pane. */
	public onScreen = false;
	public host: PrimitiveHost | null = null;
	/** False once removed. */
	public alive = true;
	/** `PanePrimitive.autoscale`: there while the `autoscale` option is on, so only then is it asked. */
	public autoscale: PanePrimitive['autoscale'];

	private _options: DrawingOptions;
	private readonly _owner: DrawingOwner;
	/** A rectangle or a price range: two points that are opposite corners. */
	private readonly _box: boolean;
	private _timeline = -1;
	private _pointsChanged = true;
	/** Changes with every change of the points, for the label cache. */
	private _pointsVersion = 0;
	/** Rows of the Fibonacci levels. */
	private _levelY = NO_ROWS;
	/** Labels: of the Fibonacci levels, or the price range's one, and what they were made for. */
	private _labels: string[] = [];
	private _labelPoints = -1;
	private _labelFormat = -1;
	private _labelWidth = 0;
	private _labelTimeline = -1;
	/** Lines of `options.text`, and the width of the widest in CSS pixels, with what it was measured for. */
	private _lines: string[] = [];
	private _linesText = '';
	private _textWidth = 0;
	private _measuredText: string | null = null;
	private _measuredSize = 0;
	private _measuredFamily = '';
	/** Font in device pixels, and what it was made for. */
	private _font = '';
	private _fontSize = 0;
	private _fontFamily = '';

	public constructor(owner: DrawingOwner, state: Required<Omit<DrawingState, 'version'>>) {
		this._owner = owner;
		this.id = state.id;
		this.type = state.type;
		this.pane = state.pane;
		this.priceScaleId = state.priceScaleId;
		this.zIndex = state.zIndex;
		this.count = POINT_COUNTS[state.type];
		this._box = state.type === 'rectangle' || state.type === 'priceRange';
		this.handleCount = this._box ? BOX_HANDLES : this.count;
		this.geometry = new Float64Array(this._box ? G_SIZE : G_HANDLES);
		this.times = new Float64Array(this.count);
		this.prices = new Float64Array(this.count);
		this.logical = new Float64Array(this.count).fill(NaN);
		this._options = state.options;
		this.autoscale = state.options.autoscale ? this._priceRange : undefined;
		for (let k = 0; k < this.count; k++) {
			this.times[k] = state.points[k]!.time;
			this.prices[k] = state.points[k]!.price;
		}
	}

	/** State for a new drawing from what `DrawingsApi.add` was given. Throws for anything malformed. */
	public static stateOf(input: {
		type: DrawingType;
		points: readonly DrawingPoint[];
		options?: Partial<DrawingOptions>;
		id?: string;
		zIndex?: number;
		pane?: number;
		priceScaleId?: string;
		version?: number;
	}): Required<Omit<DrawingState, 'version'>> {
		const count = POINT_COUNTS[input.type];
		if (count === undefined) {
			throw new Error(`lumen-charts: unknown drawing type "${String(input.type)}"`);
		}
		if (input.version !== undefined && input.version !== DRAWING_STATE_VERSION) {
			throw new Error(`lumen-charts: drawing state version ${input.version} is not supported`);
		}
		checkPoints(input.points, count, input.type);
		return {
			id: input.id ?? newId(),
			type: input.type,
			points: input.points.map(point => ({ time: point.time, price: point.price })),
			options: drawingOptions(input.type, input.options),
			zIndex: input.zIndex ?? 0,
			pane: input.pane ?? 0,
			priceScaleId: input.priceScaleId ?? DEFAULT_PRICE_SCALE_ID,
		};
	}

	// DrawingApi

	public points(): DrawingPoint[] {
		const points: DrawingPoint[] = [];
		for (let k = 0; k < this.count; k++) {
			points.push({ time: this.times[k]!, price: this.prices[k]! });
		}
		return points;
	}

	public setPoints(points: readonly DrawingPoint[]): void {
		checkPoints(points, this.count, this.type);
		for (let k = 0; k < this.count; k++) {
			this.times[k] = points[k]!.time;
			this.prices[k] = points[k]!.price;
		}
		this.pointsChanged();
		this._owner.changed(this);
	}

	public options(): Readonly<DrawingOptions> {
		return this._options;
	}

	public applyOptions(options: Partial<DrawingOptions>): void {
		this._setOptions(drawingOptions(this.type, { ...this._options, ...definedOnly(options) }));
		this._owner.changed(this);
	}

	public setZIndex(zIndex: number): void {
		if (zIndex !== this.zIndex && Number.isFinite(zIndex)) {
			this.zIndex = zIndex;
			this._owner.reorder(this);
		}
	}

	public bringToFront(): void {
		const { max } = this._owner.zRange();
		if (this.zIndex <= max) {
			this.setZIndex(max + 1);
		}
	}

	public sendToBack(): void {
		const { min } = this._owner.zRange();
		if (this.zIndex >= min) {
			this.setZIndex(min - 1);
		}
	}

	public toJSON(): DrawingState {
		const options = this._options;
		return {
			version: DRAWING_STATE_VERSION,
			id: this.id,
			type: this.type,
			points: this.points(),
			options: { ...options, levels: [...options.levels] },
			zIndex: this.zIndex,
			pane: this.pane,
			priceScaleId: this.priceScaleId,
		};
	}

	public remove(): void {
		this._owner.remove(this);
	}

	/**
	 * Takes the points, options and z-index of a checked state with this drawing's id, type and price
	 * scale, for a restore. Returns whether any of them differed; what is the same is left as it is,
	 * with its positions and geometry. The owner is not told: it sends the one event.
	 */
	public restore(state: Required<Omit<DrawingState, 'version'>>): boolean {
		let changed = false;
		const points = state.points;
		for (let k = 0; k < this.count; k++) {
			const point = points[k]!;
			if (point.time !== this.times[k] || point.price !== this.prices[k]) {
				this.times[k] = point.time;
				this.prices[k] = point.price;
				changed = true;
			}
		}
		if (changed) {
			this.pointsChanged();
		}
		if (!sameOptions(this._options, state.options)) {
			this._setOptions(state.options);
			changed = true;
		}
		if (state.zIndex !== this.zIndex) {
			this.zIndex = state.zIndex;
			// Its entry reads the z-index again.
			this.host?.requestUpdate();
			changed = true;
		}
		return changed;
	}

	// Editing (the chart's pointer interaction)

	/** The points changed: positions and geometry are computed again. */
	public pointsChanged(): void {
		this._pointsChanged = true;
		this._pointsVersion++;
		this.host?.requestUpdate();
	}

	/** Moves point `k` to a time and price whose logical position the caller knows. */
	public setPoint(k: number, time: number, price: number): void {
		this.times[k] = time;
		this.prices[k] = price;
	}

	/**
	 * Moves handle `handle` to a time and price whose logical position the caller knows. A handle of a
	 * point moves the point. Of a box, a corner takes the time of one point and the price of the
	 * other, and the middle of an edge the time or the price of one point alone: whatever is dragged,
	 * the opposite corner or edge stays where it is.
	 */
	public moveHandle(handle: number, time: number, price: number): void {
		if (handle < this.count) {
			this.times[handle] = time;
			this.prices[handle] = price;
			return;
		}
		switch (handle) {
			case 2:
				this.times[0] = time;
				this.prices[1] = price;
				break;
			case 3:
				this.times[1] = time;
				this.prices[0] = price;
				break;
			case 4:
				this.times[0] = time;
				break;
			case 5:
				this.times[1] = time;
				break;
			case 6:
				this.prices[0] = price;
				break;
			case 7:
				this.prices[1] = price;
				break;
		}
	}

	/** Cursor over handle `handle`: the middle of an edge moves along one axis only. */
	public handleCursor(handle: number): string {
		return this._box && handle >= 4 ? (handle < 6 ? 'ew-resize' : 'ns-resize') : 'move';
	}

	// PanePrimitive

	public attached(host: PrimitiveHost): void {
		this.host = host;
	}

	public detached(): void {
		this.host = null;
	}

	public update(view: PaneView, bounds: PrimitiveBounds): void {
		this.onScreen = false;
		const options = this._options;
		if (!options.visible) {
			empty(bounds);
			return;
		}
		const count = this.count;
		const logical = this._locate(view);
		const type = this.type;
		this._measureText(options);
		if (type === 'priceRange' || type === 'fibRetracement') {
			this._makeLabels(view, options);
		}

		// Filter by time first: a drawing whose time range is out of view needs nothing else.
		if (type !== 'horizontalLine') {
			let lo = Infinity;
			let hi = -Infinity;
			for (let k = 0; k < count; k++) {
				const position = logical[k]!;
				if (position !== position) {
					empty(bounds);
					return;
				}
				lo = Math.min(lo, position);
				hi = Math.max(hi, position);
			}
			if (type === 'ray') {
				if (logical[1]! >= logical[0]!) {
					hi = Infinity;
				}
				if (logical[1]! <= logical[0]!) {
					lo = -Infinity;
				}
			} else if (type === 'extendedLine' && logical[1] !== logical[0]) {
				lo = -Infinity;
				hi = Infinity;
			}
			const reach = HANDLE_RADIUS + options.lineWidth + this._textWidth + this._labelWidth;
			const pad = reach / view.barSpacing;
			if (hi < view.from - pad || lo > view.to + pad) {
				empty(bounds);
				return;
			}
		}

		const g = this.geometry;
		for (let k = 0; k < count; k++) {
			g[G_POINTS + 2 * k] = view.logicalToX(logical[k]!);
			const y = view.priceToY(this.prices[k]!);
			if (y !== y) {
				empty(bounds);
				return;
			}
			g[G_POINTS + 2 * k + 1] = y;
		}
		const width = view.width;
		const height = view.height;
		const x0 = g[0]!;
		const y0 = g[1]!;
		const x1 = g[2]!;
		const y1 = g[3]!;
		let left: number;
		let top: number;
		let right: number;
		let bottom: number;
		switch (type) {
			case 'trendLine':
			case 'ray':
			case 'extendedLine': {
				left = Math.min(x0, x1);
				right = Math.max(x0, x1);
				top = Math.min(y0, y1);
				bottom = Math.max(y0, y1);
				if (clipLine(x0, y0, x1, y1, type === 'extendedLine', type !== 'trendLine', width, height, g, G_A)) {
					left = Math.min(left, g[G_A]!, g[G_A + 2]!);
					right = Math.max(right, g[G_A]!, g[G_A + 2]!);
					top = Math.min(top, g[G_A + 1]!, g[G_A + 3]!);
					bottom = Math.max(bottom, g[G_A + 1]!, g[G_A + 3]!);
				} else {
					// Off the pane, but its points (and handles) may still be close enough to matter.
					g[G_A] = NaN;
				}
				g[G_LABEL] = x1;
				g[G_LABEL + 1] = y1;
				break;
			}
			case 'horizontalLine': {
				// The handle stays in the pane wherever the time of the point is.
				const x = x0 === x0 ? x0 : width / 2;
				g[0] = Math.min(Math.max(x, HANDLE_RADIUS), Math.max(HANDLE_RADIUS, width - HANDLE_RADIUS));
				left = 0;
				right = width;
				top = y0;
				bottom = y0;
				g[G_LABEL] = width;
				g[G_LABEL + 1] = y0;
				break;
			}
			case 'verticalLine': {
				g[1] = Math.min(Math.max(y0, HANDLE_RADIUS), Math.max(HANDLE_RADIUS, height - HANDLE_RADIUS));
				left = x0;
				right = x0;
				top = 0;
				bottom = height;
				g[G_LABEL] = x0;
				g[G_LABEL + 1] = 0;
				break;
			}
			case 'rectangle':
			case 'priceRange': {
				left = Math.min(x0, x1);
				right = Math.max(x0, x1);
				top = Math.min(y0, y1);
				bottom = Math.max(y0, y1);
				g[G_A] = left;
				g[G_A + 1] = top;
				g[G_A + 2] = right;
				g[G_A + 3] = bottom;
				// Corners: the two points, then the two the points do not name. Then the middles of the
				// edges at the first and second point's time, and at the first and second point's price.
				const middleX = right - left >= MIN_EDGE ? (x0 + x1) / 2 : NaN;
				const middleY = bottom - top >= MIN_EDGE ? (y0 + y1) / 2 : NaN;
				g[G_HANDLES] = x0;
				g[G_HANDLES + 1] = y0;
				g[G_HANDLES + 2] = x1;
				g[G_HANDLES + 3] = y1;
				g[G_HANDLES + 4] = x0;
				g[G_HANDLES + 5] = y1;
				g[G_HANDLES + 6] = x1;
				g[G_HANDLES + 7] = y0;
				g[G_HANDLES + 8] = x0;
				g[G_HANDLES + 9] = middleY;
				g[G_HANDLES + 10] = x1;
				g[G_HANDLES + 11] = middleY;
				g[G_HANDLES + 12] = middleX;
				g[G_HANDLES + 13] = y0;
				g[G_HANDLES + 14] = middleX;
				g[G_HANDLES + 15] = y1;
				if (type === 'priceRange') {
					// The label sits past the second point: below a fall, above a rise.
					const lineHeight = options.fontSize * 1.4;
					const labelY = y1 >= y0 ? bottom + LABEL_PAD : top - LABEL_PAD - lineHeight;
					g[G_LABEL] = (left + right) / 2;
					g[G_LABEL + 1] = labelY;
					const half = this._labelWidth / 2 + LABEL_PAD;
					left = Math.min(left, g[G_LABEL]! - half);
					right = Math.max(right, g[G_LABEL]! + half);
					top = Math.min(top, labelY);
					bottom = Math.max(bottom, labelY + lineHeight);
				}
				break;
			}
			case 'parallelChannel': {
				const x2 = g[4]!;
				const y2 = g[5]!;
				// The parallel line passes through the third point, at the same vertical distance everywhere.
				const along = x1 !== x0 ? y0 + ((y1 - y0) * (x2 - x0)) / (x1 - x0) : y0;
				const dy = y2 - along;
				g[G_A] = x0;
				g[G_A + 1] = y0;
				g[G_A + 2] = x1;
				g[G_A + 3] = y1;
				g[G_B] = x0;
				g[G_B + 1] = y0 + dy;
				g[G_B + 2] = x1;
				g[G_B + 3] = y1 + dy;
				g[G_C] = x0;
				g[G_C + 1] = y0 + dy / 2;
				g[G_C + 2] = x1;
				g[G_C + 3] = y1 + dy / 2;
				left = Math.min(x0, x1, x2);
				right = Math.max(x0, x1, x2);
				top = Math.min(y0, y1, y0 + dy, y1 + dy, y2);
				bottom = Math.max(y0, y1, y0 + dy, y1 + dy, y2);
				break;
			}
			case 'fibRetracement': {
				const levels = options.levels;
				if (this._levelY.length !== levels.length) {
					this._levelY = new Float64Array(levels.length);
				}
				const from = this.prices[1]!;
				const span = this.prices[0]! - from;
				top = Math.min(y0, y1);
				bottom = Math.max(y0, y1);
				for (let i = 0; i < levels.length; i++) {
					const y = view.priceToY(from + span * levels[i]!);
					this._levelY[i] = y;
					if (y === y) {
						top = Math.min(top, y);
						bottom = Math.max(bottom, y);
					}
				}
				left = Math.min(x0, x1);
				right = Math.max(x0, x1);
				g[G_A] = left;
				g[G_A + 2] = right;
				top -= options.fontSize * 1.4;
				break;
			}
			case 'text': {
				const lineHeight = options.fontSize * 1.25;
				const boxHeight = this._lines.length * lineHeight + 2 * LABEL_PAD;
				left = x0;
				right = x0 + this._textWidth + 2 * LABEL_PAD;
				top = y0 - boxHeight;
				bottom = y0;
				g[G_A] = left;
				g[G_A + 1] = top;
				g[G_A + 2] = right;
				g[G_A + 3] = bottom;
				break;
			}
		}
		const reach = HANDLE_RADIUS + options.lineWidth / 2;
		bounds.left = left - reach;
		bounds.top = top - reach;
		bounds.right = right + reach;
		bounds.bottom = bottom + reach;
		this.onScreen = true;
	}

	public draw(target: DrawTarget, view: PaneView): void {
		if (!this.onScreen) {
			return;
		}
		const ctx = target.context;
		const ratio = target.pixelRatio;
		const options = this._options;
		const g = this.geometry;
		const lineWidth = Math.max(1, Math.round(options.lineWidth * ratio));
		ctx.lineWidth = lineWidth;
		ctx.strokeStyle = options.color;
		const dash = options.lineStyle !== 'solid';
		if (dash) {
			ctx.setLineDash(dashPattern(options.lineStyle, lineWidth) as number[]);
		}
		switch (this.type) {
			case 'trendLine':
			case 'ray':
			case 'extendedLine':
				if (g[G_A] === g[G_A]) {
					strokeSegment(ctx, g, G_A, ratio);
				}
				break;
			case 'horizontalLine': {
				const y = crisp(g[1]!, ratio, lineWidth);
				ctx.beginPath();
				ctx.moveTo(0, y);
				ctx.lineTo(target.width * ratio, y);
				ctx.stroke();
				break;
			}
			case 'verticalLine': {
				const x = crisp(g[0]!, ratio, lineWidth);
				ctx.beginPath();
				ctx.moveTo(x, 0);
				ctx.lineTo(x, target.height * ratio);
				ctx.stroke();
				break;
			}
			case 'rectangle': {
				const left = crisp(g[G_A]!, ratio, lineWidth);
				const top = crisp(g[G_A + 1]!, ratio, lineWidth);
				const right = crisp(g[G_A + 2]!, ratio, lineWidth);
				const bottom = crisp(g[G_A + 3]!, ratio, lineWidth);
				if (options.fillColor !== '') {
					ctx.fillStyle = options.fillColor;
					ctx.fillRect(left, top, right - left, bottom - top);
				}
				ctx.strokeRect(left, top, right - left, bottom - top);
				break;
			}
			case 'parallelChannel':
				this._drawChannel(ctx, ratio, options);
				break;
			case 'fibRetracement':
				this._drawFib(ctx, ratio, lineWidth, options, target);
				break;
			case 'priceRange':
				this._drawRange(ctx, ratio, lineWidth, options);
				break;
			case 'text':
				this._drawText(ctx, ratio, options);
				break;
		}
		if (dash) {
			ctx.setLineDash(NO_DASH as number[]);
		}
		if (options.text !== '' && this.type !== 'text') {
			this._drawLineLabel(ctx, ratio, options, view);
		}
	}

	public drawHighlight(target: DrawTarget, _view: PaneView, hovered: boolean, selected: boolean): void {
		if (!this.onScreen || (!hovered && !selected)) {
			return;
		}
		const ctx = target.context;
		const ratio = target.pixelRatio;
		const g = this.geometry;
		const radius = HANDLE_RADIUS * ratio;
		ctx.lineWidth = Math.max(1, Math.round(ratio));
		ctx.strokeStyle = this._options.color;
		ctx.fillStyle = this._owner.style.handleFill;
		const at = this._box ? G_HANDLES : G_POINTS;
		for (let k = 0; k < this.handleCount; k++) {
			const x = g[at + 2 * k]!;
			const y = g[at + 2 * k + 1]!;
			if (x !== x || y !== y) {
				continue;
			}
			ctx.beginPath();
			ctx.arc(x * ratio, y * ratio, radius, 0, 2 * Math.PI);
			ctx.fill();
			ctx.stroke();
		}
	}

	/**
	 * Boxes of the device pixels `drawHighlight` can color, in the pane's coordinates: left, top,
	 * right and bottom of each handle with its outline and a pixel of antialiasing, written to `out`
	 * from `at`. Returns where the next box goes. The overlay clears and draws again only there when
	 * a highlight comes, goes or moves.
	 */
	public highlightBoxes(ratio: number, out: Float64Array, at: number): number {
		if (!this.onScreen) {
			return at;
		}
		const g = this.geometry;
		const reach = HANDLE_RADIUS * ratio + Math.max(1, Math.round(ratio)) / 2 + 1;
		const first = this._box ? G_HANDLES : G_POINTS;
		for (let k = 0; k < this.handleCount; k++) {
			const x = g[first + 2 * k]! * ratio;
			const y = g[first + 2 * k + 1]! * ratio;
			if (x !== x || y !== y) {
				continue;
			}
			out[at++] = Math.floor(x - reach);
			out[at++] = Math.floor(y - reach);
			out[at++] = Math.ceil(x + reach);
			out[at++] = Math.ceil(y + reach);
		}
		return at;
	}

	/** The color `drawHighlight` outlines handles with. */
	public get highlightColor(): string {
		return this._options.color;
	}

	public hitTest(x: number, y: number, tolerance: number): number {
		if (!this.onScreen) {
			return HIT_NONE;
		}
		const g = this.geometry;
		const options = this._options;
		if (!options.locked) {
			const reach = HANDLE_RADIUS + tolerance;
			const at = this._box ? G_HANDLES : G_POINTS;
			const handles = this.handleCount;
			// Points and corners first, the last on top; then the middles of edges (NaN when left out).
			for (let k = Math.min(handles, 4) - 1; k >= 0; k--) {
				const dx = x - g[at + 2 * k]!;
				const dy = y - g[at + 2 * k + 1]!;
				if (dx * dx + dy * dy <= reach * reach) {
					return 1 + k;
				}
			}
			for (let k = 4; k < handles; k++) {
				const dx = x - g[at + 2 * k]!;
				const dy = y - g[at + 2 * k + 1]!;
				if (dx * dx + dy * dy <= reach * reach) {
					return 1 + k;
				}
			}
		}
		const near = tolerance + options.lineWidth / 2;
		const filled = options.fillColor !== '';
		switch (this.type) {
			case 'trendLine':
			case 'ray':
			case 'extendedLine':
				return g[G_A] === g[G_A] && nearSegment(x, y, g[G_A]!, g[G_A + 1]!, g[G_A + 2]!, g[G_A + 3]!, near)
					? HIT_BODY
					: HIT_NONE;
			case 'horizontalLine':
				return Math.abs(y - g[1]!) <= near ? HIT_BODY : HIT_NONE;
			case 'verticalLine':
				return Math.abs(x - g[0]!) <= near ? HIT_BODY : HIT_NONE;
			case 'rectangle':
				return hitBox(x, y, g, near, filled) ? HIT_BODY : HIT_NONE;
			case 'priceRange':
			case 'text':
				return hitBox(x, y, g, near, true) ? HIT_BODY : HIT_NONE;
			case 'parallelChannel': {
				if (
					nearSegment(x, y, g[G_A]!, g[G_A + 1]!, g[G_A + 2]!, g[G_A + 3]!, near) ||
					nearSegment(x, y, g[G_B]!, g[G_B + 1]!, g[G_B + 2]!, g[G_B + 3]!, near)
				) {
					return HIT_BODY;
				}
				return filled && insideChannel(x, y, g) ? HIT_BODY : HIT_NONE;
			}
			case 'fibRetracement': {
				const left = g[G_A]!;
				const right = g[G_A + 2]!;
				if (x >= left - near && x <= right + near) {
					const levels = this._levelY;
					for (let i = 0; i < levels.length; i++) {
						if (Math.abs(y - levels[i]!) <= near) {
							return HIT_BODY;
						}
					}
				}
				return nearSegment(x, y, g[0]!, g[1]!, g[2]!, g[3]!, near) ? HIT_BODY : HIT_NONE;
			}
		}
		return HIT_NONE;
	}

	/** Takes options over, with what follows from them. */
	private _setOptions(options: DrawingOptions): void {
		this._options = options;
		this.autoscale = options.autoscale ? this._priceRange : undefined;
		this._labelPoints = -1;
		this._measuredText = null;
		this.host?.requestUpdate();
	}

	/** The logical positions of the points, looked up again when the timeline or the points changed. */
	private _locate(view: PaneView): Float64Array {
		const logical = this.logical;
		if (this._timeline !== view.timelineVersion || this._pointsChanged) {
			this._timeline = view.timelineVersion;
			this._pointsChanged = false;
			for (let k = 0; k < this.count; k++) {
				logical[k] = view.timeToLogical(this.times[k]!);
			}
		}
		return logical;
	}

	/**
	 * `PanePrimitive.autoscale` of a drawing with the `autoscale` option: the prices of its points,
	 * to count while their time span overlaps the view. That does not depend on the view, so it gives
	 * the span with them and is asked again only when it or the timeline changed; the chart filters by
	 * the span, like a hit test by the bounds. With the points go what they imply: every Fibonacci
	 * level and the parallel line of a channel. A horizontal line is in view at any time, and a
	 * vertical line has no price to show.
	 */
	private _priceRange(range: AutoscaleRange, view: PaneView): boolean {
		const type = this.type;
		if (!this._options.visible || type === 'verticalLine') {
			range.spanFrom = Infinity;
			range.spanTo = -Infinity;
			return false;
		}
		const count = this.count;
		const prices = this.prices;
		const logical = this.logical;
		let lo = -Infinity;
		let hi = Infinity;
		if (type !== 'horizontalLine') {
			this._locate(view);
			lo = Infinity;
			hi = -Infinity;
			for (let k = 0; k < count; k++) {
				const position = logical[k]!;
				if (position !== position) {
					// Not known yet: asked again in the next frame, and when the answer is in.
					return false;
				}
				lo = Math.min(lo, position);
				hi = Math.max(hi, position);
			}
		}
		let low = prices[0]!;
		let high = low;
		for (let k = 1; k < count; k++) {
			low = Math.min(low, prices[k]!);
			high = Math.max(high, prices[k]!);
		}
		let known = true;
		if (type === 'fibRetracement') {
			const levels = this._options.levels;
			const from = prices[1]!;
			const span = prices[0]! - from;
			for (let i = 0; i < levels.length; i++) {
				const price = from + span * levels[i]!;
				low = Math.min(low, price);
				high = Math.max(high, price);
			}
		} else if (type === 'parallelChannel') {
			// As drawn: the parallel line is the base line moved in y. The mapping of the last frame
			// does for that, since rows are linear in the values of the scale whatever its range is.
			// Before the scale has a range the points alone count, and it is asked again.
			const y0 = view.priceToY(prices[0]!);
			const y1 = view.priceToY(prices[1]!);
			const run = logical[1]! - logical[0]!;
			const along = run !== 0 ? y0 + ((y1 - y0) * (logical[2]! - logical[0]!)) / run : y0;
			const dy = view.priceToY(prices[2]!) - along;
			const first = view.yToPrice(y0 + dy);
			const second = view.yToPrice(y1 + dy);
			known = first === first && second === second;
			if (known) {
				low = Math.min(low, first, second);
				high = Math.max(high, first, second);
			}
		}
		range.low = low;
		range.high = high;
		if (known) {
			range.spanFrom = lo;
			range.spanTo = hi;
			return true;
		}
		return !(hi < range.from || lo > range.to);
	}

	// Drawing helpers

	private _drawChannel(ctx: CanvasRenderingContext2D, ratio: number, options: DrawingOptions): void {
		const g = this.geometry;
		if (options.fillColor !== '') {
			ctx.fillStyle = options.fillColor;
			ctx.beginPath();
			ctx.moveTo(g[G_A]! * ratio, g[G_A + 1]! * ratio);
			ctx.lineTo(g[G_A + 2]! * ratio, g[G_A + 3]! * ratio);
			ctx.lineTo(g[G_B + 2]! * ratio, g[G_B + 3]! * ratio);
			ctx.lineTo(g[G_B]! * ratio, g[G_B + 1]! * ratio);
			ctx.closePath();
			ctx.fill();
		}
		strokeSegment(ctx, g, G_A, ratio);
		strokeSegment(ctx, g, G_B, ratio);
		const width = ctx.lineWidth;
		ctx.lineWidth = Math.max(1, Math.round(ratio));
		ctx.setLineDash(dashPattern('dashed', ctx.lineWidth) as number[]);
		strokeSegment(ctx, g, G_C, ratio);
		ctx.setLineDash(
			options.lineStyle === 'solid' ? (NO_DASH as number[]) : (dashPattern(options.lineStyle, width) as number[]),
		);
		ctx.lineWidth = width;
	}

	private _drawFib(
		ctx: CanvasRenderingContext2D,
		ratio: number,
		lineWidth: number,
		options: DrawingOptions,
		target: DrawTarget,
	): void {
		const g = this.geometry;
		const left = Math.round(g[G_A]! * ratio);
		const right = Math.round(g[G_A + 2]! * ratio);
		const levels = this._levelY;
		if (options.fillColor !== '' && levels.length > 1) {
			let top = Infinity;
			let bottom = -Infinity;
			for (let i = 0; i < levels.length; i++) {
				const y = levels[i]!;
				if (y === y) {
					top = Math.min(top, y);
					bottom = Math.max(bottom, y);
				}
			}
			if (top < bottom) {
				ctx.fillStyle = options.fillColor;
				ctx.fillRect(left, Math.round(top * ratio), right - left, Math.round((bottom - top) * ratio));
			}
		}
		ctx.beginPath();
		for (let i = 0; i < levels.length; i++) {
			const y = levels[i]!;
			if (y === y && y >= -1 && y <= target.height + 1) {
				const row = crisp(y, ratio, lineWidth);
				ctx.moveTo(left, row);
				ctx.lineTo(right, row);
			}
		}
		ctx.stroke();
		// The trend the levels are taken from, thin and dashed.
		const width = Math.max(1, Math.round(ratio));
		ctx.lineWidth = width;
		ctx.setLineDash(dashPattern('dashed', width) as number[]);
		ctx.beginPath();
		ctx.moveTo(g[0]! * ratio, g[1]! * ratio);
		ctx.lineTo(g[2]! * ratio, g[3]! * ratio);
		ctx.stroke();
		ctx.setLineDash(NO_DASH as number[]);
		ctx.lineWidth = lineWidth;
		ctx.font = this._deviceFont(ratio, options);
		ctx.fillStyle = options.textColor;
		ctx.textAlign = 'left';
		ctx.textBaseline = 'bottom';
		const labels = this._labels;
		const x = left + LABEL_PAD * ratio;
		for (let i = 0; i < levels.length && i < labels.length; i++) {
			const y = levels[i]!;
			if (y === y && y >= 0 && y <= target.height + options.fontSize) {
				ctx.fillText(labels[i]!, x, Math.round(y * ratio) - 2 * ratio);
			}
		}
	}

	private _drawRange(ctx: CanvasRenderingContext2D, ratio: number, lineWidth: number, options: DrawingOptions): void {
		const g = this.geometry;
		const left = Math.round(g[G_A]! * ratio);
		const top = Math.round(g[G_A + 1]! * ratio);
		const right = Math.round(g[G_A + 2]! * ratio);
		const bottom = Math.round(g[G_A + 3]! * ratio);
		if (options.fillColor !== '') {
			ctx.fillStyle = options.fillColor;
			ctx.fillRect(left, top, right - left, bottom - top);
		}
		// An arrow from the first point's price to the second's, in the middle.
		const x = crisp((g[G_A]! + g[G_A + 2]!) / 2, ratio, lineWidth);
		const from = g[1]! * ratio;
		const to = g[3]! * ratio;
		const head = Math.min(6 * ratio, Math.abs(to - from) / 2);
		const direction = to >= from ? -1 : 1;
		ctx.beginPath();
		ctx.moveTo(x, from);
		ctx.lineTo(x, to);
		ctx.moveTo(x - head, to + direction * head);
		ctx.lineTo(x, to);
		ctx.lineTo(x + head, to + direction * head);
		ctx.stroke();
		const label = this._labels[0];
		if (label === undefined) {
			return;
		}
		const lineHeight = options.fontSize * 1.4;
		const boxWidth = (this._labelWidth + 2 * LABEL_PAD) * ratio;
		const boxLeft = Math.round(g[G_LABEL]! * ratio - boxWidth / 2);
		const boxTop = Math.round(g[G_LABEL + 1]! * ratio);
		ctx.fillStyle = options.color;
		ctx.fillRect(boxLeft, boxTop, Math.round(boxWidth), Math.round(lineHeight * ratio));
		ctx.font = this._deviceFont(ratio, options);
		ctx.fillStyle = '#ffffff';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillText(label, boxLeft + boxWidth / 2, boxTop + (lineHeight * ratio) / 2);
	}

	private _drawText(ctx: CanvasRenderingContext2D, ratio: number, options: DrawingOptions): void {
		const g = this.geometry;
		const left = Math.round(g[G_A]! * ratio);
		const top = Math.round(g[G_A + 1]! * ratio);
		if (options.fillColor !== '') {
			ctx.fillStyle = options.fillColor;
			ctx.fillRect(left, top, Math.round(g[G_A + 2]! * ratio) - left, Math.round(g[G_A + 3]! * ratio) - top);
		}
		ctx.font = this._deviceFont(ratio, options);
		ctx.fillStyle = options.textColor;
		ctx.textAlign = 'left';
		ctx.textBaseline = 'top';
		const lineHeight = options.fontSize * 1.25 * ratio;
		const x = left + LABEL_PAD * ratio;
		let y = top + LABEL_PAD * ratio;
		const lines = this._lines;
		for (let i = 0; i < lines.length; i++) {
			ctx.fillText(lines[i]!, x, y);
			y += lineHeight;
		}
	}

	/** The text option of a line, next to the line's end. */
	private _drawLineLabel(ctx: CanvasRenderingContext2D, ratio: number, options: DrawingOptions, view: PaneView): void {
		this._measureText(options);
		const g = this.geometry;
		let x = g[G_LABEL]!;
		let y = g[G_LABEL + 1]!;
		if (x !== x || y !== y) {
			return;
		}
		ctx.font = this._deviceFont(ratio, options);
		ctx.fillStyle = options.textColor;
		if (this.type === 'horizontalLine') {
			ctx.textAlign = 'right';
			ctx.textBaseline = 'bottom';
			x -= LABEL_PAD;
			y -= LABEL_PAD;
		} else if (this.type === 'verticalLine') {
			ctx.textAlign = 'left';
			ctx.textBaseline = 'top';
			x += LABEL_PAD;
			y += LABEL_PAD;
		} else {
			ctx.textAlign = 'left';
			ctx.textBaseline = 'bottom';
			x = Math.min(x + LABEL_PAD, view.width - this._textWidth - LABEL_PAD);
			y -= LABEL_PAD;
		}
		const lines = this._lines;
		for (let i = 0; i < lines.length; i++) {
			ctx.fillText(lines[i]!, x * ratio, (y - (lines.length - 1 - i) * options.fontSize * 1.25) * ratio);
		}
	}

	private _deviceFont(ratio: number, options: DrawingOptions): string {
		const family = this._owner.style.fontFamily;
		const size = options.fontSize * ratio;
		// Made again only when the size, the ratio or the family changes.
		if (size !== this._fontSize || family !== this._fontFamily) {
			this._fontSize = size;
			this._fontFamily = family;
			this._font = `${size}px ${family}`;
		}
		return this._font;
	}

	/** Splits and measures the text option when it or the font changed. */
	private _measureText(options: DrawingOptions): void {
		const text = options.text;
		const style = this._owner.style;
		if (
			text === this._measuredText &&
			options.fontSize === this._measuredSize &&
			style.fontFamily === this._measuredFamily
		) {
			return;
		}
		this._measuredText = text;
		this._measuredSize = options.fontSize;
		this._measuredFamily = style.fontFamily;
		if (text !== this._linesText) {
			this._linesText = text;
			this._lines = text === '' ? [] : text.split('\n');
		}
		const font = `${options.fontSize}px ${style.fontFamily}`;
		let width = 0;
		for (const line of this._lines) {
			width = Math.max(width, style.measure(line, font));
		}
		this._textWidth = width;
	}

	/** Labels of a Fibonacci retracement or a price range, made again when the points or the format change. */
	private _makeLabels(view: PaneView, options: DrawingOptions): void {
		if (
			this._labelPoints === this._pointsVersion &&
			this._labelFormat === view.priceFormatVersion &&
			this._labelTimeline === this._timeline
		) {
			return;
		}
		this._labelPoints = this._pointsVersion;
		this._labelFormat = view.priceFormatVersion;
		this._labelTimeline = this._timeline;
		const style = this._owner.style;
		const font = `${options.fontSize}px ${style.fontFamily}`;
		const first = this.prices[0]!;
		const second = this.prices[1]!;
		if (this.type === 'fibRetracement') {
			const levels = options.levels;
			const labels: string[] = [];
			for (let i = 0; i < levels.length; i++) {
				const level = levels[i]!;
				labels.push(`${level} (${view.formatPrice(second + (first - second) * level)})`);
			}
			this._labels = labels;
			this._labelWidth = 0;
			return;
		}
		const change = second - first;
		const percent = first !== 0 ? (change / Math.abs(first)) * 100 : NaN;
		const bars = Math.round(this.logical[1]! - this.logical[0]!);
		const sign = change > 0 ? '+' : '';
		const label =
			`${sign}${view.formatPrice(change)}` +
			(percent === percent ? ` (${sign}${percent.toFixed(2)}%)` : '') +
			(bars === bars ? `, ${bars} bars` : '');
		this._labels = [label];
		this._labelWidth = style.measure(label, font);
	}
}

function strokeSegment(ctx: CanvasRenderingContext2D, g: Float64Array, at: number, ratio: number): void {
	ctx.beginPath();
	ctx.moveTo(g[at]! * ratio, g[at + 1]! * ratio);
	ctx.lineTo(g[at + 2]! * ratio, g[at + 3]! * ratio);
	ctx.stroke();
}

/** Inside the box at `G_A` (when filled), or within `near` of its border. */
function hitBox(x: number, y: number, g: Float64Array, near: number, filled: boolean): boolean {
	const left = g[G_A]!;
	const top = g[G_A + 1]!;
	const right = g[G_A + 2]!;
	const bottom = g[G_A + 3]!;
	if (x < left - near || x > right + near || y < top - near || y > bottom + near) {
		return false;
	}
	if (filled) {
		return true;
	}
	return (
		Math.abs(x - left) <= near ||
		Math.abs(x - right) <= near ||
		Math.abs(y - top) <= near ||
		Math.abs(y - bottom) <= near
	);
}

/** Between the two lines of a channel, within the time span of its points. */
function insideChannel(x: number, y: number, g: Float64Array): boolean {
	const x0 = g[G_A]!;
	const x1 = g[G_A + 2]!;
	if (x0 === x1 || x < Math.min(x0, x1) || x > Math.max(x0, x1)) {
		return false;
	}
	const t = (x - x0) / (x1 - x0);
	const base = g[G_A + 1]! + t * (g[G_A + 3]! - g[G_A + 1]!);
	const parallel = g[G_B + 1]! + t * (g[G_B + 3]! - g[G_B + 1]!);
	return y >= Math.min(base, parallel) && y <= Math.max(base, parallel);
}

/** Throws unless `points` are `count` points with a finite time and price each. */
export function checkPoints(points: readonly DrawingPoint[], count: number, type: DrawingType): void {
	if (!Array.isArray(points) || points.length !== count) {
		throw new Error(`lumen-charts: a ${type} drawing takes ${count} point${count === 1 ? '' : 's'}`);
	}
	for (const point of points) {
		if (!Number.isFinite(point?.time) || !Number.isFinite(point?.price)) {
			throw new Error('lumen-charts: drawing points need a finite time and price');
		}
	}
}

/** Whether two sets of options, each with every key, hold the same values. */
function sameOptions(a: DrawingOptions, b: DrawingOptions): boolean {
	for (const key in a) {
		const value = a[key as keyof DrawingOptions];
		const other = b[key as keyof DrawingOptions];
		if (value === other) {
			continue;
		}
		if (key !== 'levels') {
			return false;
		}
		const levels = value as number[];
		const others = other as number[];
		if (levels.length !== others.length) {
			return false;
		}
		for (let i = 0; i < levels.length; i++) {
			if (levels[i] !== others[i]) {
				return false;
			}
		}
	}
	return true;
}

function definedOnly<T extends object>(value: T): Partial<T> {
	const out: Partial<T> = {};
	for (const key of Object.keys(value) as (keyof T)[]) {
		if (value[key] !== undefined) {
			out[key] = value[key];
		}
	}
	return out;
}
