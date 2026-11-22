import { Drawing } from '../drawings/drawing';
import type { PanePrimitives } from '../drawings/pane-primitives';
import type { Crosshair } from '../model/crosshair';
import type { FrameModel } from '../model/frame-model';
import type { TimeDisplay } from '../model/time-display';
import type { TimeScale } from '../model/time-scale';
import type { CandlestickOptions, HistogramOptions, LineOptions, LineStyle } from '../options';
import { AXIS_PADDING, type PriceAxes, type PriceAxis } from '../price-axes';
import type { Series } from '../series';
import type { ChartSettings } from '../settings';
import {
	clipPricePane,
	dashPattern,
	drawColumn,
	drawRow,
	drawTag,
	isFaint,
	textColorOn,
	deviceThickness,
} from './chrome';
import type { ChartLayout } from './layout';

interface ValueTag {
	y: number;
	top: number;
	series: Series;
	color: string;
}
const byHeight = (a: ValueTag, b: ValueTag) => a.y - b.y;

/** A horizontal line: a price line, or the crosshair's. `a` y, `b` left, `c` width, `d` thickness, `text` its style. */
const ROW = 0;
/** A vertical line from the top: the crosshair's. `a` x, `b` height, `d` thickness, `text` its style. */
const COLUMN = 1;
/** A label on a price axis: `axis`, `a` top, `b` height, `color` background, `text`. */
const TAG = 2;
/** A dot where the crosshair crosses a line: `a` x, `b` y, `c` and `d` top and height of its scale (CSS), `e` radius, `color` the line's, `text` the ring's. */
const MARKER = 3;
/** The crosshair's time label: `a` left, `b` top, `c` width, `d` height, `color` background, `text`. */
const TIME = 4;

/**
 * One thing the overlay draws, with what it is drawn with and the box of device pixels it can color
 * (`[x0, x1) × [y0, y1)`). The overlay keeps what it drew, so that a frame in which only the
 * crosshair or the highlight of a drawing moved clears and draws again only where they were and are.
 */
class OverlayItem {
	public kind = ROW;
	public x0 = 0;
	public y0 = 0;
	public x1 = 0;
	public y1 = 0;
	public a = 0;
	public b = 0;
	public c = 0;
	public d = 0;
	public e = 0;
	public color = '';
	public text = '';
	public axis: PriceAxis | null = null;

	/** Whether `other` draws the same pixels. */
	public same(other: OverlayItem): boolean {
		return (
			this.kind === other.kind &&
			this.a === other.a &&
			this.b === other.b &&
			this.c === other.c &&
			this.d === other.d &&
			this.e === other.e &&
			this.color === other.color &&
			this.text === other.text &&
			this.axis === other.axis &&
			this.x0 === other.x0 &&
			this.y0 === other.y0 &&
			this.x1 === other.x1 &&
			this.y1 === other.y1
		);
	}
}

/** A list of items that keeps its items from frame to frame, so a frame allocates none. */
class ItemList {
	public readonly items: OverlayItem[] = [];
	public count = 0;

	public add(kind: number): OverlayItem {
		const item = (this.items[this.count] ??= new OverlayItem());
		this.count++;
		item.kind = kind;
		item.axis = null;
		item.e = 0;
		return item;
	}
}

/**
 * Dashes from which a line is copied from its strip rather than drawn dash by dash (see
 * `OverlayRenderer._strip`): a copy costs about as much as a few dozen rectangles in Chromium.
 */
const STRIP_LENGTH = 8;

/** Length of a dash and the gap after it, in device pixels; 0 for a solid line. */
function dashPeriod(item: OverlayItem): number {
	const pattern = dashPattern(item.text as LineStyle, item.d);
	return pattern.length === 0 ? 0 : pattern[0]! + pattern[1]!;
}

/** Highlight boxes of drawings at most: two drawings of eight handles. */
const MAX_BOXES = 2 * 8 * 4;

/**
 * Draws the layer above everything else: price lines and value labels of the series, primitives
 * and drawings on top, and the crosshair with its labels and markers.
 *
 * A frame draws only what changed. It compares the price lines and value labels (in frames that
 * may have changed them: `changed`), the crosshair's lines, markers and labels and the highlighted
 * drawings' handles with those it drew, clears the boxes of those that changed, the old and the
 * new, and draws everything that reaches into those boxes again, in the order of a full redraw, so
 * the layer ends up as a full redraw would leave it. A frame after the canvas was sized or the
 * options changed (`stale`) draws everything, and so does every frame while something cannot be
 * bounded: primitives on top, a drawing being edited, the highlight of a primitive of the
 * application.
 */
export class OverlayRenderer {
	/**
	 * The canvas was sized or cleared, or the options changed: the next frame draws everything. Set
	 * by the chart.
	 */
	public stale = true;
	/**
	 * The price lines and value labels may have changed: the next frame compares them with those it
	 * drew. Set by the chart for frames that redraw the series.
	 */
	public changed = true;
	private readonly tags = new Map<PriceAxis, { items: ValueTag[]; count: number }>();
	private readonly _settings: ChartSettings;
	private readonly _layout: ChartLayout;
	private readonly _scale: TimeScale;
	private readonly _series: readonly Series[];
	private readonly _axes: PriceAxes;
	private readonly _model: FrameModel;
	private readonly _time: TimeDisplay;
	private readonly _primitives: PanePrimitives;
	private readonly _crosshair: Crosshair;
	/** Price lines and value labels as drawn, and the list a frame that compares them builds its own in. */
	private _static = new ItemList();
	private _nextStatic = new ItemList();
	/** The crosshair as drawn, and the list the next frame builds its own in. */
	private _drawn = new ItemList();
	private _next = new ItemList();
	/** Highlights of drawings as drawn: who, in which colors, and the boxes of their handles. */
	private _hover: unknown = null;
	private _selected: unknown = null;
	private _hoverColor = '';
	private _selectedColor = '';
	private _handleFill = '';
	private _boxes = new Float64Array(MAX_BOXES);
	private _boxCount = 0;
	private _nextBoxes = new Float64Array(MAX_BOXES);
	/** Boxes to clear and draw again, four numbers each. */
	private readonly _damage: number[] = [];
	/** Dashed lines by orientation, thickness, style and color (see `_strip`); null for a color that is not opaque. */
	private readonly _strips = new Map<string, HTMLCanvasElement | null>();
	/** Ranges along a line to draw, two numbers each (see `_drawLine`). */
	private readonly _ranges: number[] = [];
	/** Size and ratio of the layer as of the last full frame. */
	private _width = -1;
	private _height = -1;
	private _ratio = 0;
	/** The time label of the last time asked for, until the next full frame. */
	private _timeLabel = '';
	private _labelTime = NaN;
	private _labelDates = false;

	public constructor(
		settings: ChartSettings,
		layout: ChartLayout,
		scale: TimeScale,
		series: readonly Series[],
		axes: PriceAxes,
		model: FrameModel,
		time: TimeDisplay,
		primitives: PanePrimitives,
		crosshair: Crosshair,
	) {
		this._settings = settings;
		this._layout = layout;
		this._scale = scale;
		this._series = series;
		this._axes = axes;
		this._model = model;
		this._time = time;
		this._primitives = primitives;
		this._crosshair = crosshair;
	}

	/** Price lines, value labels and the crosshair, on a transparent canvas above everything else. */
	public render(): void {
		const layer = this._layout.overlay;
		const ctx = layer.ctx;
		if (ctx === null) {
			return;
		}
		const ratio = this._layout.pixelRatio;
		const drawings = this._primitives.drawings;
		// Who is highlighted, and the boxes of their handles; -1 when they cannot be bounded.
		const boxes = drawings === null ? 0 : drawings.highlightBoxes(ratio, this._nextBoxes);
		const hover = drawings?.hoveredPrimitive ?? null;
		const selected = drawings?.selectedDrawing ?? null;
		const hoverColor = hover instanceof Drawing ? hover.highlightColor : '';
		const selectedColor = selected?.highlightColor ?? '';
		const handleFill = drawings?.style.handleFill ?? '';
		if (
			this.stale ||
			boxes < 0 ||
			this._primitives.layers.top.entries.length > 0 ||
			ratio !== this._ratio ||
			layer.width !== this._width ||
			layer.height !== this._height
		) {
			this._renderFull(ctx);
		} else {
			const damage = this._damage;
			damage.length = 0;
			if (this.changed) {
				this.changed = false;
				this._staticItems(ctx, this._nextStatic);
				this._compare(this._static, this._nextStatic);
				const kept = this._static;
				this._static = this._nextStatic;
				this._nextStatic = kept;
			}
			this._crosshairItems(this._next);
			this._compare(this._drawn, this._next);
			let highlightChanged =
				hover !== this._hover ||
				selected !== this._selected ||
				hoverColor !== this._hoverColor ||
				selectedColor !== this._selectedColor ||
				handleFill !== this._handleFill ||
				boxes !== this._boxCount;
			for (let i = 0; i < boxes && !highlightChanged; i++) {
				highlightChanged = this._boxes[i] !== this._nextBoxes[i];
			}
			if (highlightChanged) {
				this._addBoxes(this._boxes, this._boxCount);
				this._addBoxes(this._nextBoxes, boxes);
			}
			if (damage.length > 0) {
				if (this._closeDamage(boxes)) {
					this._renderDamage(ctx, boxes);
				} else {
					this._renderFull(ctx);
				}
			}
		}
		// What this frame drew becomes what the next one compares with.
		const drawn = this._drawn;
		this._drawn = this._next;
		this._next = drawn;
		const kept = this._boxes;
		this._boxes = this._nextBoxes;
		this._nextBoxes = kept;
		this._boxCount = Math.max(0, boxes);
		this._hover = hover;
		this._selected = selected;
		this._hoverColor = hoverColor;
		this._selectedColor = selectedColor;
		this._handleFill = handleFill;
		if (boxes < 0 || this._primitives.layers.top.entries.length > 0) {
			// What was drawn cannot be bounded: the next frame clears it all.
			this.stale = true;
		}
	}

	/** Adds to the damage the boxes of the items that differ between two lists, in their order. */
	private _compare(last: ItemList, next: ItemList): void {
		for (let i = 0; i < last.count || i < next.count; i++) {
			const before = i < last.count ? last.items[i]! : null;
			const after = i < next.count ? next.items[i]! : null;
			if (before !== null && after !== null && before.same(after)) {
				continue;
			}
			if (before !== null) this._addDamage(before.x0, before.y0, before.x1, before.y1);
			if (after !== null) this._addDamage(after.x0, after.y0, after.x1, after.y1);
		}
	}

	/** Clears the layer and draws everything. */
	private _renderFull(ctx: CanvasRenderingContext2D): void {
		const layer = this._layout.overlay;
		ctx.clearRect(0, 0, layer.width, layer.height);
		this.stale = false;
		this.changed = false;
		this._width = layer.width;
		this._height = layer.height;
		this._ratio = this._layout.pixelRatio;
		this._labelTime = NaN;
		this._staticItems(ctx, this._static);
		const items = this._static;
		for (let i = 0; i < items.count; i++) {
			this._drawItem(ctx, items.items[i]!);
		}
		const drawings = this._primitives.drawings;
		if (this._primitives.layers.top.entries.length > 0 || (drawings !== null && drawings.overlayInUse)) {
			this._drawPaneGroup(ctx, true);
		}
		this._crosshairItems(this._next);
		const next = this._next;
		for (let i = 0; i < next.count; i++) {
			this._drawItem(ctx, next.items[i]!);
		}
	}

	/**
	 * Widens the damage until everything it reaches lies inside it: an item that reaches into it
	 * without lying inside one of its boxes adds its own box, and so do all the highlights when one
	 * of them reaches in (they are drawn at once), until nothing changes; a line needs only its
	 * thickness covered where boxes cross it. Everything is then drawn without a clip. A clip of
	 * several boxes would change how the browser rasterizes what is drawn through it: Chromium
	 * antialiases the edge of a circle or of text otherwise under it, by up to the whole value of a
	 * pixel, so a partial frame would differ from a full one.
	 */
	private _closeDamage(boxes: number): boolean {
		const paneLeft = Math.round(this._layout.paneLeft * this._ratio);
		const highlights = this._nextBoxes;
		for (let round = 0, changed = true; changed; round++) {
			if (round === 16) {
				// Not settled: the frame draws everything instead.
				return false;
			}
			changed = this._widen(this._static);
			if (this._widen(this._next)) changed = true;
			let reached = false;
			let inside = true;
			for (let i = 0; i < boxes; i += 4) {
				const x0 = highlights[i]! + paneLeft;
				const x1 = highlights[i + 2]! + paneLeft;
				reached ||= this._damaged(x0, highlights[i + 1]!, x1, highlights[i + 3]!);
				inside &&= this._within(x0, highlights[i + 1]!, x1, highlights[i + 3]!);
			}
			if (reached && !inside) {
				this._addBoxes(highlights, boxes);
				changed = true;
			}
		}
		return true;
	}

	/**
	 * Adds the box of each item of `list` that reaches into the damage without lying inside it (a
	 * line: without the boxes that cross it covering its thickness). Returns whether any was added.
	 */
	private _widen(list: ItemList): boolean {
		let changed = false;
		for (let i = 0; i < list.count; i++) {
			const item = list.items[i]!;
			if (
				this._damaged(item.x0, item.y0, item.x1, item.y1) &&
				!(item.kind === ROW || item.kind === COLUMN
					? this._across(item)
					: this._within(item.x0, item.y0, item.x1, item.y1))
			) {
				this._addDamage(item.x0, item.y0, item.x1, item.y1);
				changed = true;
			}
		}
		return changed;
	}

	/**
	 * Whether the damage takes a line in as pieces: one box holds all of it, or every box that
	 * reaches it covers its whole thickness, within the layer.
	 */
	private _across(item: OverlayItem): boolean {
		if (this._within(item.x0, item.y0, item.x1, item.y1)) {
			return true;
		}
		const damage = this._damage;
		const row = item.kind === ROW;
		const near = Math.max(0, row ? item.y0 : item.x0);
		const far = Math.min(row ? this._height : this._width, row ? item.y1 : item.x1);
		for (let i = 0; i < damage.length; i += 4) {
			if (
				damage[i]! >= item.x1 ||
				damage[i + 2]! <= item.x0 ||
				damage[i + 1]! >= item.y1 ||
				damage[i + 3]! <= item.y0
			) {
				continue;
			}
			if ((row ? damage[i + 1]! : damage[i]!) > near || (row ? damage[i + 3]! : damage[i + 2]!) < far) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Clears the boxes of `_damage` and draws again everything that reaches into them, in the order
	 * of a full frame. `boxes` is the number of highlight box numbers of this frame. After
	 * `_closeDamage` all of it lies inside the damage: lines are drawn as the pieces of their dashes
	 * inside the boxes, everything else as it is.
	 */
	private _renderDamage(ctx: CanvasRenderingContext2D, boxes: number): void {
		const damage = this._damage;
		for (let i = 0; i < damage.length; i += 4) {
			ctx.clearRect(damage[i]!, damage[i + 1]!, damage[i + 2]! - damage[i]!, damage[i + 3]! - damage[i + 1]!);
		}
		const fixed = this._static;
		for (let i = 0; i < fixed.count; i++) {
			this._drawDamaged(ctx, fixed.items[i]!);
		}
		const paneLeft = Math.round(this._layout.paneLeft * this._ratio);
		const highlights = this._nextBoxes;
		for (let i = 0; i < boxes; i += 4) {
			if (
				this._damaged(highlights[i]! + paneLeft, highlights[i + 1]!, highlights[i + 2]! + paneLeft, highlights[i + 3]!)
			) {
				// The drawings draw every highlight at once; `_closeDamage` put all of them inside.
				this._drawPaneGroup(ctx, false);
				break;
			}
		}
		const next = this._next;
		for (let i = 0; i < next.count; i++) {
			this._drawDamaged(ctx, next.items[i]!);
		}
	}

	/** Primitives on top and what the drawings show on the overlay, in pane coordinates and clipped to the pane. */
	private _drawPaneGroup(ctx: CanvasRenderingContext2D, top: boolean): void {
		const ratio = this._layout.pixelRatio;
		const paneLeft = Math.round(this._layout.paneLeft * ratio);
		ctx.save();
		ctx.beginPath();
		ctx.rect(paneLeft, 0, this._layout.pane.width, this._layout.pane.height);
		ctx.clip();
		ctx.translate(paneLeft, 0);
		const target = this._primitives.targetOf(ctx);
		if (top) {
			this._primitives.layers.top.draw(target);
		}
		this._primitives.drawings?.drawOverlay(target);
		ctx.restore();
	}

	/**
	 * Adds a box to the damage, within the layer. An empty box adds nothing, nor does one inside a box
	 * of the damage already (the strip under the pane, which an old and a new time label share).
	 */
	private _addDamage(x0: number, y0: number, x1: number, y1: number): void {
		const left = Math.max(0, x0);
		const top = Math.max(0, y0);
		const right = Math.min(this._width, x1);
		const bottom = Math.min(this._height, y1);
		if (right <= left || bottom <= top) {
			return;
		}
		const damage = this._damage;
		for (let i = 0; i < damage.length; i += 4) {
			if (left >= damage[i]! && top >= damage[i + 1]! && right <= damage[i + 2]! && bottom <= damage[i + 3]!) {
				return;
			}
		}
		damage.push(left, top, right, bottom);
	}

	/** Adds highlight boxes, in pane coordinates, to the damage. */
	private _addBoxes(boxes: Float64Array, count: number): void {
		const paneLeft = Math.round(this._layout.paneLeft * this._ratio);
		for (let i = 0; i < count; i += 4) {
			this._addDamage(boxes[i]! + paneLeft, boxes[i + 1]!, boxes[i + 2]! + paneLeft, boxes[i + 3]!);
		}
	}

	/** Whether a box overlaps the damage. */
	private _damaged(x0: number, y0: number, x1: number, y1: number): boolean {
		const damage = this._damage;
		for (let i = 0; i < damage.length; i += 4) {
			if (x0 < damage[i + 2]! && x1 > damage[i]! && y0 < damage[i + 3]! && y1 > damage[i + 1]!) {
				return true;
			}
		}
		return false;
	}

	/** Whether a box, within the layer, lies inside one box of the damage. */
	private _within(x0: number, y0: number, x1: number, y1: number): boolean {
		const damage = this._damage;
		const left = Math.max(0, x0);
		const top = Math.max(0, y0);
		const right = Math.min(this._width, x1);
		const bottom = Math.min(this._height, y1);
		for (let i = 0; i < damage.length; i += 4) {
			if (left >= damage[i]! && top >= damage[i + 1]! && right <= damage[i + 2]! && bottom <= damage[i + 3]!) {
				return true;
			}
		}
		return false;
	}

	/** Draws an item where it reaches into the damage, each pixel of it once. */
	private _drawDamaged(ctx: CanvasRenderingContext2D, item: OverlayItem): void {
		if ((item.kind === ROW || item.kind === COLUMN) && !this._within(item.x0, item.y0, item.x1, item.y1)) {
			this._drawLine(ctx, item);
		} else if (this._damaged(item.x0, item.y0, item.x1, item.y1)) {
			// `_closeDamage` put it inside the damage.
			this._drawItem(ctx, item);
		}
	}

	/**
	 * Draws a line where the damage covers it: the pieces of its dashes inside the boxes, as a full
	 * line has them, counted from its start. A long dashed line is one rectangle per dash, and the
	 * damage crosses a price line or the crosshair in a few places only. Where boxes overlap along
	 * the line, a piece is drawn once, as a semi-transparent color would show a second coat. The
	 * pieces are whole device pixels of whole rectangles, so they color those pixels as the dashes
	 * do. The boxes that cross the line cover its thickness (`_closeDamage`).
	 */
	private _drawLine(ctx: CanvasRenderingContext2D, item: OverlayItem): void {
		const damage = this._damage;
		const row = item.kind === ROW;
		// Along the line `[from, to)`, across it `[near, far)`.
		const from = row ? item.x0 : item.y0;
		const to = row ? item.x1 : item.y1;
		const near = row ? item.y0 : item.x0;
		const far = row ? item.y1 : item.x1;
		const ranges = this._ranges;
		ranges.length = 0;
		for (let i = 0; i < damage.length; i += 4) {
			const a = Math.max(from, row ? damage[i]! : damage[i + 1]!);
			const b = Math.min(to, row ? damage[i + 2]! : damage[i + 3]!);
			const c = row ? damage[i + 1]! : damage[i]!;
			const d = row ? damage[i + 3]! : damage[i + 2]!;
			if (b <= a || c >= far || d <= near) {
				continue;
			}
			// In order of `a`.
			let at = ranges.length;
			ranges.push(a, b);
			while (at > 0 && ranges[at - 2]! > a) {
				ranges[at] = ranges[at - 2]!;
				ranges[at + 1] = ranges[at - 1]!;
				ranges[at - 2] = a;
				ranges[at - 1] = b;
				at -= 2;
			}
		}
		if (ranges.length === 0) {
			return;
		}
		const thickness = item.d;
		const pattern = dashPattern(item.text as LineStyle, thickness);
		const dash = pattern.length === 0 ? 0 : pattern[0]!;
		const period = dash + (pattern[1] ?? 0);
		// Where the dashes are counted from, as `drawRow` and `drawColumn` count them.
		const start = row ? item.b : 0;
		const strip = this._strip(ctx, item);
		ctx.fillStyle = item.color;
		let i = 0;
		while (i < ranges.length) {
			const a = ranges[i]!;
			let b = ranges[i + 1]!;
			i += 2;
			while (i < ranges.length && ranges[i]! <= b) {
				b = Math.max(b, ranges[i + 1]!);
				i += 2;
			}
			if (strip !== null && b - a >= STRIP_LENGTH * period) {
				this._copyStrip(ctx, strip, row, a - start, a, b - a, near, thickness);
				continue;
			}
			if (period === 0) {
				this._piece(ctx, row, a, b, near, thickness);
				continue;
			}
			for (let k = Math.floor((a - start) / period); start + k * period < b; k++) {
				const dashStart = start + k * period;
				const left = Math.max(a, dashStart);
				const right = Math.min(b, dashStart + dash, to);
				if (right > left) {
					this._piece(ctx, row, left, right, near, thickness);
				}
			}
		}
	}

	/**
	 * The dashes of a dashed line in an opaque color, drawn once on a canvas of their own from its
	 * start; null for a solid line or a color that is not opaque. A dashed line is then one copy
	 * from it instead of a rectangle per dash, hundreds across a wide pane. The copy colors the same
	 * pixels the same: the dashes are whole pixels of an opaque color, which a copy places as it is,
	 * and the gaps are transparent, which leaves what is below. (A color that is not opaque would
	 * blend in rounded once more, so its dashes stay rectangles.)
	 */
	private _strip(ctx: CanvasRenderingContext2D, item: OverlayItem): HTMLCanvasElement | null {
		const style = item.text as LineStyle;
		const thickness = item.d;
		const pattern = dashPattern(style, thickness);
		if (pattern.length === 0) {
			return null;
		}
		const row = item.kind === ROW;
		const length = row ? item.c : item.b;
		const key = `${row ? 'row' : 'column'}|${thickness}|${style}|${item.color}`;
		let strip = this._strips.get(key);
		if (strip !== undefined && (strip === null || (row ? strip.width : strip.height) >= length)) {
			return strip;
		}
		// Opaque colors read back as `#rrggbb`, others as `rgba(...)`.
		ctx.fillStyle = '#000000';
		ctx.fillStyle = item.color;
		strip = null;
		if (String(ctx.fillStyle).startsWith('#')) {
			strip = this._layout.overlay.canvas.ownerDocument.createElement('canvas');
			strip.width = row ? length : thickness;
			strip.height = row ? thickness : length;
			const target = strip.getContext('2d');
			if (target === null) {
				strip = null;
			} else if (row) {
				drawRow(target, thickness >> 1, 0, length, item.color, thickness, style);
			} else {
				drawColumn(target, thickness >> 1, length, item.color, thickness, style);
			}
		}
		if (this._strips.size >= 16) {
			this._strips.clear();
		}
		this._strips.set(key, strip);
		return strip;
	}

	/** Copies `[from, from + length)` along a strip to `at` along the line, `near` across it. */
	private _copyStrip(
		ctx: CanvasRenderingContext2D,
		strip: HTMLCanvasElement,
		row: boolean,
		from: number,
		at: number,
		length: number,
		near: number,
		thickness: number,
	): void {
		ctx.imageSmoothingEnabled = false;
		if (row) {
			ctx.drawImage(strip, from, 0, length, thickness, at, near, length, thickness);
		} else {
			ctx.drawImage(strip, 0, from, thickness, length, near, at, thickness, length);
		}
		ctx.imageSmoothingEnabled = true;
	}

	/** A piece of a line, `[a, b)` along it and `thickness` across from `near`. */
	private _piece(ctx: CanvasRenderingContext2D, row: boolean, a: number, b: number, near: number, thickness: number) {
		if (row) {
			ctx.fillRect(a, near, b - a, thickness);
		} else {
			ctx.fillRect(near, a, thickness, b - a);
		}
	}

	private _drawItem(ctx: CanvasRenderingContext2D, item: OverlayItem): void {
		switch (item.kind) {
			case ROW: {
				const strip = this._strip(ctx, item);
				if (strip !== null && item.c >= STRIP_LENGTH * dashPeriod(item)) {
					this._copyStrip(ctx, strip, true, 0, item.b, item.c, item.y0, item.d);
				} else {
					drawRow(ctx, item.a, item.b, item.c, item.color, item.d, item.text as LineStyle);
				}
				break;
			}
			case COLUMN: {
				const strip = this._strip(ctx, item);
				if (strip !== null && item.b >= STRIP_LENGTH * dashPeriod(item)) {
					this._copyStrip(ctx, strip, false, 0, 0, item.b, item.x0, item.d);
				} else {
					drawColumn(ctx, item.a, item.b, item.color, item.d, item.text as LineStyle);
				}
				break;
			}
			case TAG:
				this._axisTag(ctx, item.axis!, item.a, item.b, item.color, item.text);
				break;
			case MARKER: {
				const ratio = this._layout.pixelRatio;
				const clipped = clipPricePane(ctx, this._layout.overlay.width, ratio, item.c, item.d, this._layout.paneHeight);
				ctx.fillStyle = item.text;
				ctx.beginPath();
				ctx.arc(item.a, item.b, item.e + ratio, 0, 2 * Math.PI);
				ctx.fill();
				ctx.fillStyle = item.color;
				ctx.beginPath();
				ctx.arc(item.a, item.b, item.e, 0, 2 * Math.PI);
				ctx.fill();
				if (clipped) ctx.restore();
				break;
			}
			case TIME:
				drawTag(
					ctx,
					item.a,
					item.b,
					item.c,
					item.d,
					item.color,
					textColorOn(ctx, item.color),
					item.text,
					item.a + item.c / 2,
					'center',
					this._layout.font,
				);
				break;
		}
	}

	/** A horizontal line from `left`, as `drawRow` draws it. */
	private _row(
		list: ItemList,
		y: number,
		left: number,
		width: number,
		color: string,
		thickness: number,
		style: LineStyle,
	): void {
		const item = list.add(ROW);
		item.a = y;
		item.b = left;
		item.c = width;
		item.d = thickness;
		item.color = color;
		item.text = style;
		item.x0 = left;
		item.x1 = left + width;
		item.y0 = y - (thickness >> 1);
		item.y1 = item.y0 + thickness;
	}

	/**
	 * A label on a price axis. Its box takes in its text wherever the text may reach: to the outer
	 * edge of the layer beside the axis, and above and below the label as far as glyphs reach from
	 * its middle (see `_inkMargin`).
	 */
	private _tag(list: ItemList, axis: PriceAxis, top: number, height: number, background: string, text: string): void {
		const ratio = this._layout.pixelRatio;
		const item = list.add(TAG);
		item.axis = axis;
		item.a = top;
		item.b = height;
		item.c = 0;
		item.d = 0;
		item.color = background;
		item.text = text;
		const margin = this._inkMargin(height);
		if (axis.settings.position === 'left') {
			item.x0 = 0;
			item.x1 = Math.round((axis.axisLeft + axis.axisWidth) * ratio);
		} else {
			item.x0 = Math.round(axis.axisLeft * ratio);
			item.x1 = this._layout.overlay.width;
		}
		item.y0 = top - margin;
		item.y1 = top + height + margin;
	}

	/**
	 * How far the text of a label `height` device pixels high may reach above or below it, in device
	 * pixels. Text is drawn on the middle of the label; the glyphs of a font reach less than 0.8 of
	 * its size from the middle of its em square, accents included.
	 */
	private _inkMargin(height: number): number {
		const reach = 0.8 * this._settings.options.layout.fontSize * this._layout.pixelRatio;
		return Math.max(0, Math.ceil(reach - height / 2));
	}

	/** The price lines and value labels of the series, in the order they are drawn, into `list`. */
	private _staticItems(ctx: CanvasRenderingContext2D, list: ItemList): void {
		list.count = 0;
		const ratio = this._layout.pixelRatio;
		const options = this._settings.options;
		const paneLeft = Math.round(this._layout.paneLeft * ratio);
		const paneWidth = this._layout.pane.width;
		const tagHeight = Math.round((options.layout.fontSize + 8) * ratio);
		// Value labels of overlays go on the default scale's axis, or on the first visible one.
		let overlayAxis: PriceAxis | null = null;
		for (const axis of this._axes.list) {
			if (axis.settings.visible && !axis.separatePane) {
				overlayAxis = axis;
				break;
			}
		}

		for (const group of this.tags.values()) group.count = 0;
		for (const series of this._series) {
			const seriesOptions = series.seriesOptions;
			const value = series.lastValue;
			const axis = series.axis;
			if (value !== value || !seriesOptions.visible || axis === null) {
				continue;
			}
			const labelAxis = axis.settings.visible
				? axis
				: !axis.separatePane && overlayAxis?.scale.top === 0
					? overlayAxis
					: null;
			const showLine = seriesOptions.priceLineVisible;
			const showLabel = seriesOptions.lastValueVisible && labelAxis !== null;
			if (!showLine && !showLabel) {
				continue;
			}
			const y = Math.round(series.deviceY(value));
			// NaN (a value the scale cannot show) fails too.
			if (!axis.scale.contains(y / ratio)) {
				continue;
			}
			const color = seriesColor(ctx, series);
			if (showLine) {
				this._row(
					list,
					y,
					paneLeft,
					paneWidth,
					seriesOptions.priceLineColor !== '' ? seriesOptions.priceLineColor : color,
					deviceThickness(seriesOptions.priceLineWidth, ratio),
					seriesOptions.priceLineStyle,
				);
			}
			if (showLabel && labelAxis) {
				let group = this.tags.get(labelAxis);
				if (!group) this.tags.set(labelAxis, (group = { items: [], count: 0 }));
				const tag = (group.items[group.count] ??= { y, top: 0, series, color });
				tag.y = y;
				tag.series = series;
				tag.color = color;
				group.count++;
			}
		}

		for (const [axis, group] of this.tags) {
			const items = group.items;
			items.length = group.count;
			if (!items.length) continue;
			items.sort(byHeight);
			const top = Math.round(axis.scale.top * ratio);
			const bottom = Math.round((axis.scale.top + axis.scale.height) * ratio);
			const count = Math.min(items.length, tagHeight > 0 ? Math.floor((bottom - top) / tagHeight) : 0);
			let next = top;
			for (let i = 0; i < count; i++) {
				const tag = items[i]!;
				tag.top = Math.min(bottom - (count - i) * tagHeight, Math.max(next, tag.y - (tagHeight >> 1)));
				next = tag.top + tagHeight;
				this._tag(
					list,
					axis,
					tag.top,
					tagHeight,
					tag.color,
					tag.series.valueLabel(tag.series.axis!.scale, tag.series.lastValue),
				);
			}
		}
	}

	/** The crosshair: its lines, markers and labels, in the order they are drawn, into `list`. */
	private _crosshairItems(list: ItemList): void {
		list.count = 0;
		const options = this._settings.options;
		const crosshair = options.crosshair;
		const scale = this._scale;
		if (!this._crosshair.visible || scale.isEmpty || crosshair.mode === 'hidden') {
			return;
		}
		const layer = this._layout.overlay;
		const ratio = this._layout.pixelRatio;
		const paneLeft = Math.round(this._layout.paneLeft * ratio);
		const paneWidth = this._layout.pane.width;
		const paneHeight = this._layout.pane.height;
		const tagHeight = Math.round((options.layout.fontSize + 8) * ratio);
		const geometry = this._model.geometry;
		const index = Math.min(scale.end - 1, Math.max(scale.first, Math.round(scale.xToLogical(this._crosshair.x))));
		const x = paneLeft + Math.round(geometry.origin + index * geometry.spacing);
		const drawn = this._model.drawn;
		const row = drawn === null ? -1 : Math.floor(index / 2 ** drawn.shift) - drawn.start;
		const inCache = drawn !== null && row >= 0 && row < drawn.count;
		let cssY = this._crosshair.y;
		let magnet: Series | null = null;
		if ((crosshair.mode === 'magnet' || crosshair.mode === 'nearest') && inCache) {
			magnet = this._magnetSeries(row, cssY, ratio, crosshair.mode === 'nearest');
			const snapped = magnet === null ? Number.NaN : magnet.deviceY(magnet.close[row]!);
			if (Number.isFinite(snapped)) {
				cssY = snapped / ratio;
			} else {
				magnet = null;
			}
		}
		const y = Math.round(cssY * ratio);
		const { vertLine, horzLine } = crosshair;
		if (vertLine.visible) {
			const thickness = deviceThickness(vertLine.width, ratio);
			const item = list.add(COLUMN);
			item.a = x;
			item.b = paneHeight;
			item.c = 0;
			item.d = thickness;
			item.color = vertLine.color;
			item.text = vertLine.style;
			item.x0 = x - (thickness >> 1);
			item.x1 = item.x0 + thickness;
			item.y0 = 0;
			item.y1 = paneHeight;
		}
		const yInPane = y >= 0 && y < paneHeight;
		if (horzLine.visible && yInPane) {
			this._row(list, y, paneLeft, paneWidth, horzLine.color, deviceThickness(horzLine.width, ratio), horzLine.style);
		}
		if (inCache) {
			this._markers(list, x, row);
		}
		if (horzLine.labelVisible && yInPane) {
			// A label on every axis with something on it, each in its own values.
			const background = horzLine.labelBackgroundColor;
			const top = y - (tagHeight >> 1);
			for (const axis of this._axes.list) {
				const priceScale = axis.scale;
				if (
					!axis.settings.visible ||
					axis.count === 0 ||
					!priceScale.hasRange ||
					!priceScale.contains(cssY) ||
					priceScale.height * ratio < tagHeight
				) {
					continue;
				}
				const text =
					magnet !== null && magnet.axis === axis
						? priceScale.format(
								magnet.close[row]!,
								magnet.base,
								magnet.seriesOptions.minMove,
								magnet.seriesOptions.precision,
							)
						: priceScale.formatValue(priceScale.yToValue(cssY));
				this._tag(
					list,
					axis,
					Math.max(
						Math.round(priceScale.top * ratio),
						Math.min(top, Math.round((priceScale.top + priceScale.height) * ratio) - tagHeight),
					),
					tagHeight,
					background,
					text,
				);
			}
		}
		if (vertLine.labelVisible && options.timeScale.visible && inCache) {
			const time = drawn!.time[row]!;
			const dates = this._model.timeTicks.dates;
			if (time !== this._labelTime || dates !== this._labelDates) {
				// Daily bars are dates, shown as they are (see `TimeTicks.dates`).
				this._timeLabel = this._time.format.crosshair(time, dates ? time : this._time.zone.wall(time));
				this._labelTime = time;
				this._labelDates = dates;
			}
			const label = this._timeLabel;
			const width = Math.ceil((label.length * this._layout.digitWidth + 2 * AXIS_PADDING) * ratio);
			const left = Math.min(Math.max(paneLeft, x - (width >> 1)), Math.max(paneLeft, paneLeft + paneWidth - width));
			const item = list.add(TIME);
			item.a = left;
			item.b = paneHeight;
			item.c = width;
			item.d = layer.height - paneHeight;
			item.color = vertLine.labelBackgroundColor;
			item.text = label;
			// The text may be wider than its estimate: the whole strip under the pane.
			item.x0 = 0;
			item.x1 = layer.width;
			item.y0 = paneHeight - this._inkMargin(item.d);
			item.y1 = layer.height;
		}
	}

	/** A label on a price axis, `top` and `height` in device pixels. */
	private _axisTag(
		ctx: CanvasRenderingContext2D,
		axis: PriceAxis,
		top: number,
		height: number,
		background: string,
		text: string,
	): void {
		const ratio = this._layout.pixelRatio;
		const left = Math.round(axis.axisLeft * ratio);
		const width = Math.round((axis.axisLeft + axis.axisWidth) * ratio) - left;
		const onLeft = axis.settings.position === 'left';
		const padding = AXIS_PADDING * ratio;
		drawTag(
			ctx,
			left,
			top,
			width,
			height,
			background,
			textColorOn(ctx, background),
			text,
			onLeft ? left + width - padding : left + padding,
			onLeft ? 'right' : 'left',
			this._layout.font,
		);
	}

	private _magnetSeries(row: number, cssY: number, ratio: number, nearest: boolean): Series | null {
		let best: Series | null = null,
			distance = Infinity;
		for (const series of this._series) {
			const scale = series.axis?.scale;
			if (!scale?.contains(cssY) || !series.seriesOptions.visible) continue;
			const y = series.deviceY(series.close[row]!);
			if (!Number.isFinite(y) || (this._layout.split && !scale.contains(y / ratio))) continue;
			if (!nearest) return series;
			const d = Math.abs(y - cssY * ratio);
			if (d < distance) {
				best = series;
				distance = d;
			}
		}
		return best;
	}

	/** Dots where the crosshair crosses line series, ringed in the background color. */
	private _markers(list: ItemList, x: number, row: number): void {
		const ratio = this._layout.pixelRatio;
		const background = this._settings.options.layout.background;
		for (const series of this._series) {
			if (series.type !== 'line' || row >= series.close.length) {
				continue;
			}
			const line = series.seriesOptions as LineOptions;
			const value = series.close[row]!;
			if (!line.visible || !line.crosshairMarkerVisible || value !== value) {
				continue;
			}
			const y = series.deviceY(value);
			if (!Number.isFinite(y) || !series.axis?.scale.contains(y / ratio)) {
				continue;
			}
			const radius = line.crosshairMarkerRadius * ratio;
			const scale = series.axis.scale;
			const item = list.add(MARKER);
			item.a = x;
			item.b = y;
			item.c = scale.top;
			item.d = scale.height;
			item.e = radius;
			item.color = line.color;
			item.text = background;
			// The ring's radius, and a pixel of antialiasing.
			const reach = radius + ratio;
			item.x0 = Math.floor(x - reach) - 1;
			item.y0 = Math.floor(y - reach) - 1;
			item.x1 = Math.ceil(x + reach) + 1;
			item.y1 = Math.ceil(y + reach) + 1;
		}
	}
}

/**
 * Color of the latest value: the line color, or the body color of the last bar's direction. A
 * hollow body (a faint color with an outline) gives way to its outline color.
 */
function seriesColor(ctx: CanvasRenderingContext2D, series: Series): string {
	if (series.type === 'histogram') {
		const histogram = series.seriesOptions as HistogramOptions;
		return series.lastValue < histogram.base && histogram.negativeColor !== ''
			? histogram.negativeColor
			: histogram.color;
	}
	if (series.kind !== 'ohlcv') {
		return (series.seriesOptions as LineOptions).color;
	}
	const candle = series.seriesOptions as CandlestickOptions;
	const body = series.lastUp ? candle.upColor : candle.downColor;
	if (candle.borderVisible && isFaint(ctx, body)) {
		return series.lastUp ? candle.borderUpColor : candle.borderDownColor;
	}
	return body;
}
