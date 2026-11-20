import type { TimeIndex } from '../model/time-index';
import { type DrawTarget, HIT_BODY, HIT_NONE } from '../primitives';
import type { HitResult, PaneViewState, PrimitiveEntry, PrimitiveLayers } from '../render/primitive-host';
import { Drawing, type DrawingOwner, type DrawingStyle } from './drawing';
import {
	type DrawingApi,
	type DrawingEvent,
	type DrawingInput,
	type DrawingOptions,
	type DrawingState,
	type DrawingStateEvent,
	type DrawingType,
	type DrawingsApi,
	POINT_COUNTS,
} from './types';

/** Hit tolerance around lines and handles, in CSS pixels, for a mouse and for touch or a pen. */
export const MOUSE_TOLERANCE = 4;
export const TOUCH_TOLERANCE = 12;
/** Movement that turns a press into a drag, in CSS pixels; for touch, which is less precise, more. */
const MOUSE_SLOP = 3;
const TOUCH_SLOP = 8;

/** What the drawings need from the chart. */
export interface DrawingsHost {
	readonly layers: PrimitiveLayers;
	readonly times: TimeIndex;
	/** The view of a price scale, made with the scale if the chart has none of that id. */
	view(priceScaleId: string): PaneViewState;
	viewAt(y: number): PaneViewState;
	/** Left edge of the pane in the chart element, CSS pixels. */
	paneLeft(): number;
	/** The overlay must be drawn again. */
	invalidateOverlay(): void;
	/**
	 * The price a point placed at bar `index` and pane row `y` takes: with the crosshair in magnet
	 * mode, the open, high, low or close of the bar nearest to `y`; otherwise the price at `y`.
	 */
	snapPrice(index: number, y: number, view: PaneViewState): number;
	/** Reports an error thrown by an event handler without unwinding the chart. */
	report(error: unknown): void;
}

/** What the pointer is doing to drawings. */
const IDLE = 0;
/** A tool is started and waits for its first point. */
const ARMED = 1;
/** Some points of a new drawing are placed; the next follows the pointer. */
const PLACING = 2;
/** A drawing is pressed and may be dragged. */
const PRESSED = 3;
/** A drawing is being dragged. */
const DRAGGING = 4;

type Handler = (drawing: DrawingApi | null) => void;

/**
 * The drawings of a chart: the API, the events, and the pointer and keyboard interaction that
 * creates and edits them. Each drawing is a pane primitive in the drawings layer; the one being
 * created or dragged leaves that layer for the overlay, so editing it redraws nothing else.
 */
export class Drawings implements DrawingsApi, DrawingOwner {
	public readonly style: DrawingStyle;
	/** Cursor the chart should show, or '' for its own. */
	public cursor = '';
	private readonly _host: DrawingsHost;
	private readonly _byId = new Map<string, Drawing>();
	private readonly _handlers = new Map<string, Set<Handler>>();
	private readonly _hit: HitResult = { entry: null, hit: HIT_NONE };

	private _state = IDLE;
	private _tool: DrawingType | null = null;
	private _toolOptions: Partial<DrawingOptions> | undefined;
	/** The drawing being created or dragged; it is drawn on the overlay meanwhile. */
	private _editing: Drawing | null = null;
	/** Points of the new drawing placed so far. */
	private _placed = 0;
	private _selected: Drawing | null = null;
	/** Entry under the pointer and what part of it, for the highlight. */
	private _hovered: PrimitiveEntry | null = null;
	private _hoveredHit = HIT_NONE;
	private _tolerance = MOUSE_TOLERANCE;
	private _slop = MOUSE_SLOP;
	/** Press of the gesture in progress, pane CSS pixels, and whether it moved past the slop. */
	private _pressX = 0;
	private _pressY = 0;
	private _pressing = false;
	private _moved = false;
	/** The drawing pressed, and the handle being dragged (`1 + k`, see `Drawing.moveHandle`) or its body (0). */
	private _pressedDrawing: Drawing | null = null;
	private _dragHit = HIT_BODY;
	/** Points before the drag, to move from and to restore on Escape. */
	private _startTimes = new Float64Array(3);
	private _startPrices = new Float64Array(3);
	private _startLogical = new Float64Array(3);
	private _zMin = 0;
	private _zMax = 0;
	/** Index, time and price of the point under the pointer (see `_pointAt`). */
	private readonly _point = new Float64Array(3);

	public constructor(host: DrawingsHost, style: DrawingStyle) {
		this._host = host;
		this.style = style;
	}

	/** Whether presses should wait for the frame to tell whether they hit a drawing. */
	public get active(): boolean {
		return this._tool !== null || this._host.layers.size > 0;
	}

	public get count(): number {
		return this._byId.size;
	}

	public get editing(): Drawing | null {
		return this._editing;
	}

	// DrawingsApi

	public add(input: DrawingInput): DrawingApi {
		const state = Drawing.stateOf(input);
		if (this._byId.has(state.id)) {
			throw new Error(`lumen-charts: a drawing with id "${state.id}" exists already`);
		}
		const view = this._viewOf(state.priceScaleId);
		const drawing = new Drawing(this, state);
		this._attach(drawing, view);
		this._emit('created', drawing);
		return drawing;
	}

	public get(id: string): DrawingApi | null {
		return this._byId.get(id) ?? null;
	}

	public list(): DrawingApi[] {
		const layer = this._host.layers.normal;
		layer.sort();
		const list: DrawingApi[] = [];
		for (const entry of layer.entries) {
			if (
				entry.owner === this &&
				(entry.primitive as Drawing).alive &&
				this._byId.has((entry.primitive as Drawing).id)
			) {
				list.push(entry.primitive as Drawing);
			}
		}
		return list;
	}

	public remove(drawing: DrawingApi | string): void {
		const target = typeof drawing === 'string' ? this._byId.get(drawing) : (drawing as Drawing);
		if (target === undefined || !target.alive || this._byId.get(target.id) !== target) {
			return;
		}
		if (this._editing === target) {
			this._endEdit(false);
		}
		if (this._pressedDrawing === target) {
			// Removed while pressed or dragged (by an event handler): the gesture ends with it.
			this._pressedDrawing = null;
			this._state = IDLE;
		}
		this._byId.delete(target.id);
		target.alive = false;
		this._host.layers.detach(target);
		if (this._hovered?.primitive === target) {
			this._setHovered(null, HIT_NONE);
		}
		if (this._selected === target) {
			this._select(null);
		}
		this._host.invalidateOverlay();
		this._emit('removed', target);
	}

	public clear(): void {
		this.cancelTool();
		// From the top down: the layer finds its last entry at once, so a thousand drawings go in a
		// thousand steps, not half a million.
		const drawings = this.list();
		for (let i = drawings.length - 1; i >= 0; i--) {
			this.remove(drawings[i]!);
		}
		for (const drawing of this._byId.values()) {
			this.remove(drawing);
		}
	}

	/**
	 * Makes the drawings those of checked states (see `Drawing.stateOf`), for a restore, matching
	 * them by id. A drawing whose state says what it is already is left alone: no event, and its
	 * positions and geometry stay. One that differs in points, options or z-index takes them in place,
	 * with one `changed`. A drawing no state names is removed (`removed`), as is one whose state has
	 * another type or price scale, which a drawing cannot change; the states without a drawing are
	 * added (`created`). The drawings end up in the order of the states, bottom to top. A tool or a
	 * drag in progress ends first; a selected drawing that stays, stays selected.
	 */
	public restore(states: readonly ConstructorParameters<typeof Drawing>[1][]): void {
		this.cancelTool();
		this._endDrag(false);
		const byId = this._byId;
		if (byId.size > 0) {
			const kept = new Set<Drawing>();
			for (const state of states) {
				const existing = byId.get(state.id);
				if (
					existing !== undefined &&
					existing.type === state.type &&
					existing.priceScaleId === state.priceScaleId &&
					existing.pane === state.pane
				) {
					kept.add(existing);
				}
			}
			if (kept.size < byId.size) {
				// From the top down, as in `clear`.
				const drawings = this.list();
				for (let i = drawings.length - 1; i >= 0; i--) {
					if (!kept.has(drawings[i] as Drawing)) {
						this.remove(drawings[i]!);
					}
				}
				for (const drawing of byId.values()) {
					if (!kept.has(drawing)) {
						this.remove(drawing);
					}
				}
			}
		}
		const layers = this._host.layers;
		// Equal z-indexes are drawn in attach order: it follows the order of the states.
		let last = -1;
		for (const state of states) {
			let drawing = byId.get(state.id);
			let entry: PrimitiveEntry | undefined;
			if (drawing === undefined) {
				drawing = new Drawing(this, state);
				entry = this._attach(drawing, this._viewOf(state.priceScaleId));
				this._emit('created', drawing);
			} else {
				if (drawing.restore(state)) {
					this._noteZ(drawing.zIndex);
					this.changed(drawing);
				}
				entry = layers.entryOf(drawing);
			}
			if (entry !== undefined) {
				if (entry.seq < last) {
					layers.resequence(entry);
				}
				last = entry.seq;
			}
		}
	}

	public startTool(type: DrawingType, options?: Partial<DrawingOptions>): void {
		if (POINT_COUNTS[type] === undefined) {
			throw new Error(`lumen-charts: unknown drawing type "${String(type)}"`);
		}
		this.cancelTool();
		this._endDrag(false);
		this._tool = type;
		this._toolOptions = options;
		this._state = ARMED;
		this.cursor = 'crosshair';
		this._host.times.active = true;
		this._host.invalidateOverlay();
	}

	public cancelTool(): void {
		if (this._tool === null) {
			return;
		}
		if (this._state === PLACING) {
			this._endEdit(false);
		}
		this._tool = null;
		this._toolOptions = undefined;
		this._state = IDLE;
		this.cursor = '';
		this._host.invalidateOverlay();
	}

	public activeTool(): DrawingType | null {
		return this._tool;
	}

	public select(drawing: DrawingApi | string | null): void {
		const target = drawing === null ? null : typeof drawing === 'string' ? this._byId.get(drawing) : drawing;
		this._select(target === undefined ? null : (target as Drawing));
	}

	public selected(): DrawingApi | null {
		return this._selected;
	}

	public hovered(): DrawingApi | null {
		const primitive = this._hovered?.primitive;
		return primitive instanceof Drawing ? primitive : null;
	}

	public hitTest(x: number, y: number): DrawingApi | null {
		if (!this._hitTest(x - this._host.paneLeft(), y, this._tolerance)) {
			return null;
		}
		const primitive = this._hit.entry!.primitive;
		return primitive instanceof Drawing ? primitive : null;
	}

	public toJSON(): DrawingState[] {
		return this.list().map(drawing => drawing.toJSON());
	}

	public subscribe(event: DrawingEvent, handler: (drawing: DrawingApi) => void): () => void;
	public subscribe(event: DrawingStateEvent, handler: (drawing: DrawingApi | null) => void): () => void;
	public subscribe(event: DrawingEvent | DrawingStateEvent, handler: (drawing: DrawingApi) => void): () => void {
		let set = this._handlers.get(event);
		if (set === undefined) {
			set = new Set();
			this._handlers.set(event, set);
		}
		const stored = handler as Handler;
		set.add(stored);
		return () => {
			set.delete(stored);
		};
	}

	// DrawingOwner

	public changed(drawing: Drawing): void {
		if (drawing.alive) {
			this._host.invalidateOverlay();
			this._emit('changed', drawing);
		}
	}

	public reorder(drawing: Drawing): void {
		const entry = this._host.layers.entryOf(drawing);
		if (entry !== undefined) {
			entry.requestUpdate();
		}
		this._noteZ(drawing.zIndex);
		this._emit('changed', drawing);
	}

	public zRange(): { min: number; max: number } {
		return { min: this._zMin, max: this._zMax };
	}

	// Pointer and keyboard, called by the chart

	/**
	 * A press at `(x, y)`, pane CSS pixels, in the read phase of a frame. Returns true when drawings
	 * take it (a tool places a point, a drawing is pressed); otherwise the chart pans.
	 */
	public press(x: number, y: number, pointerType: string): boolean {
		const touch = pointerType !== 'mouse';
		this._tolerance = touch ? TOUCH_TOLERANCE : MOUSE_TOLERANCE;
		this._slop = touch ? TOUCH_SLOP : MOUSE_SLOP;
		this._pressX = x;
		this._pressY = y;
		this._pressing = true;
		this._moved = false;
		if (this._state === ARMED) {
			return this._startNew(x, y);
		}
		if (this._state === PLACING) {
			this._placePoint(x, y);
			return true;
		}
		if (!this._hitTest(x, y, this._tolerance)) {
			this._select(null);
			return false;
		}
		const entry = this._hit.entry!;
		const drawing = entry.primitive instanceof Drawing && entry.owner === this ? entry.primitive : null;
		if (drawing === null) {
			// Primitives of the application are hovered and highlighted, not edited.
			this._select(null);
			return false;
		}
		this._select(drawing);
		if (drawing.options().locked) {
			return false;
		}
		this._state = PRESSED;
		this._dragHit = this._hit.hit;
		this._editing = null;
		this._remember(drawing);
		this._pressedDrawing = drawing;
		return true;
	}

	/** The pressed pointer moved to `(x, y)`. */
	public drag(x: number, y: number): void {
		if (this._pressing && !this._moved) {
			const dx = x - this._pressX;
			const dy = y - this._pressY;
			this._moved = dx * dx + dy * dy > this._slop * this._slop;
		}
		if (this._state === PLACING) {
			this._follow(x, y);
			return;
		}
		if (this._state === PRESSED && this._moved) {
			const drawing = this._pressedDrawing!;
			this._state = DRAGGING;
			this._beginEdit(drawing);
		}
		if (this._state === DRAGGING) {
			this._dragTo(x, y);
		}
	}

	/** The pressed pointer was released at `(x, y)`. */
	public release(x: number, y: number): void {
		const moved = this._moved;
		this._pressing = false;
		if (this._state === PLACING) {
			// A press dragged to the next point places it on release; a click waits for the next click.
			if (moved && this._placed < this._editing!.count) {
				this._placePoint(x, y);
			}
			return;
		}
		if (this._state === DRAGGING) {
			this._dragTo(x, y);
			this._endDrag(true);
		} else if (this._state === PRESSED) {
			this._state = IDLE;
			this._pressedDrawing = null;
		}
	}

	/** The gesture was cancelled (pointercancel, Escape): a drag is undone, a new drawing dropped. */
	public cancelGesture(): void {
		this._pressing = false;
		if (this._state === DRAGGING || this._state === PRESSED) {
			this._endDrag(false);
		} else if (this._state === PLACING) {
			this.cancelTool();
		}
	}

	/**
	 * The pointer hovers `(x, y)` (pane CSS pixels), or left the pane. Called in the write phase of a
	 * frame after the geometry is current: the highlight follows the drawing under the pointer.
	 */
	public hover(x: number, y: number, inside: boolean): void {
		if (this._state === PLACING) {
			if (inside && !this._pressing) {
				this._follow(x, y);
			}
			return;
		}
		if (this._state === DRAGGING || this._state === PRESSED || this._state === ARMED) {
			return;
		}
		if (inside && this._hitTest(x, y, this._tolerance)) {
			this._setHovered(this._hit.entry, this._hit.hit);
		} else {
			this._setHovered(null, HIT_NONE);
		}
	}

	/** Keys while the chart has the focus. Returns true when the key was used. */
	public key(key: string): boolean {
		if (key === 'Escape') {
			if (this._state === DRAGGING || this._state === PRESSED) {
				this._endDrag(false);
				return true;
			}
			if (this._tool !== null) {
				this.cancelTool();
				return true;
			}
			if (this._selected !== null) {
				this._select(null);
				return true;
			}
			return false;
		}
		if ((key === 'Delete' || key === 'Backspace') && this._selected !== null && this._state === IDLE) {
			if (!this._selected.options().locked) {
				this.remove(this._selected);
			}
			return true;
		}
		return false;
	}

	/**
	 * Draws on the overlay: the drawing being edited, then the highlight of the hovered and the
	 * selected one.
	 */
	public drawOverlay(target: DrawTarget): void {
		const editing = this._editing;
		if (editing !== null && editing.alive) {
			const view = this._viewOf(editing.priceScaleId);
			const clipped = view.clip(target);
			editing.draw(target, view);
			editing.drawHighlight(target, view, false, true);
			if (clipped) target.context.restore();
		}
		const hovered = this._hovered;
		const selected = this._selected;
		if (hovered !== null && hovered.primitive !== editing) {
			const clipped = hovered.view.clip(target);
			hovered.primitive.drawHighlight?.(target, hovered.view, true, hovered.primitive === selected);
			if (clipped) target.context.restore();
		}
		if (selected !== null && selected !== editing && selected !== hovered?.primitive && selected.alive) {
			const view = this._viewOf(selected.priceScaleId);
			const clipped = view.clip(target);
			selected.drawHighlight(target, view, false, true);
			if (clipped) target.context.restore();
		}
	}

	/** Whether anything is drawn on the overlay. */
	public get overlayInUse(): boolean {
		return this._editing !== null || this._hovered !== null || this._selected !== null;
	}

	public destroy(): void {
		this._handlers.clear();
		this._byId.clear();
		this._editing = null;
		this._selected = null;
		this._hovered = null;
	}

	// Internals

	private _emit(event: string, drawing: Drawing | null): void {
		const set = this._handlers.get(event);
		if (set === undefined) {
			return;
		}
		for (const handler of set) {
			try {
				handler(drawing);
			} catch (error) {
				this._host.report(error);
			}
		}
	}

	private _viewOf(priceScaleId: string): PaneViewState {
		return this._host.view(priceScaleId);
	}

	private _attach(drawing: Drawing, view: PaneViewState): PrimitiveEntry {
		this._byId.set(drawing.id, drawing);
		this._noteZ(drawing.zIndex);
		this._host.times.active = true;
		return this._host.layers.attach(drawing, view, this);
	}

	private _noteZ(zIndex: number): void {
		if (this._byId.size <= 1) {
			this._zMin = zIndex;
			this._zMax = zIndex;
		} else {
			this._zMin = Math.min(this._zMin, zIndex);
			this._zMax = Math.max(this._zMax, zIndex);
		}
	}

	private _hitTest(x: number, y: number, tolerance: number): boolean {
		const layers = this._host.layers;
		const hit = this._hit;
		hit.entry = null;
		hit.hit = HIT_NONE;
		return layers.top.hitTest(x, y, tolerance, hit) || layers.normal.hitTest(x, y, tolerance, hit);
	}

	private _setHovered(entry: PrimitiveEntry | null, hit: number): void {
		if (entry === this._hovered && hit === this._hoveredHit) {
			return;
		}
		const before = this._hovered;
		this._hovered = entry;
		this._hoveredHit = hit;
		if (entry === null) {
			this.cursor = this._tool !== null ? 'crosshair' : '';
		} else if (hit > HIT_BODY) {
			this.cursor = entry.primitive instanceof Drawing ? entry.primitive.handleCursor(hit - 1) : 'move';
		} else {
			this.cursor = 'pointer';
		}
		this._host.invalidateOverlay();
		if (entry !== before) {
			const drawing = entry !== null && entry.primitive instanceof Drawing ? entry.primitive : null;
			const previous = before !== null && before.primitive instanceof Drawing ? before.primitive : null;
			if (drawing !== previous) {
				this._emit('hovered', drawing);
			}
		}
	}

	private _select(drawing: Drawing | null): void {
		if (drawing === this._selected) {
			return;
		}
		this._selected = drawing;
		this._host.invalidateOverlay();
		this._emit('selected', drawing);
	}

	/** Index and price of a point placed at `(x, y)`: the bar under it, and its price or a magnet's. */
	private _pointAt(x: number, y: number, view: PaneViewState, snap: boolean, out: Float64Array, at: number): boolean {
		const index = Math.round(view.xToLogical(x));
		const time = view.logicalToTime(index);
		const price = snap ? this._host.snapPrice(index, y, view) : view.yToPrice(y);
		if (time !== time || price !== price) {
			return false;
		}
		out[at] = index;
		out[at + 1] = time;
		out[at + 2] = price;
		return true;
	}

	/** First point of a new drawing of the tool. */
	private _startNew(x: number, y: number): boolean {
		const type = this._tool!;
		const view = this._host.viewAt(y);
		const point = this._point;
		if (!this._pointAt(x, y, view, true, point, 0)) {
			// No bars there to place a point on: the press pans instead.
			return false;
		}
		const count = POINT_COUNTS[type];
		const points = [];
		for (let k = 0; k < count; k++) {
			points.push({ time: point[1]!, price: point[2]! });
		}
		this._host.times.seed(point[1]!, point[0]!);
		const state = Drawing.stateOf({
			type,
			points,
			priceScaleId: view.scaleId,
			options: this._toolOptions,
			zIndex: this._zMax + 1,
		});
		const drawing = new Drawing(this, state);
		this._placed = 1;
		this._state = PLACING;
		this._beginEdit(drawing, view);
		if (count === 1) {
			this._finishNew();
		}
		return true;
	}

	/** Places the next point of the new drawing at `(x, y)`. */
	private _placePoint(x: number, y: number): void {
		const drawing = this._editing!;
		this._follow(x, y);
		this._placed++;
		if (this._placed >= drawing.count) {
			this._finishNew();
			return;
		}
		// The points not placed yet start where the last one went, and follow the pointer from there.
		const k = this._placed - 1;
		for (let j = this._placed; j < drawing.count; j++) {
			drawing.setPoint(j, drawing.times[k]!, drawing.prices[k]!);
		}
		drawing.pointsChanged();
	}

	/** Moves the points of the new drawing not placed yet to `(x, y)`. */
	private _follow(x: number, y: number): void {
		const drawing = this._editing;
		if (drawing === null) {
			return;
		}
		const view = this._viewOf(drawing.priceScaleId);
		const point = this._point;
		if (!this._pointAt(x, y, view, true, point, 0)) {
			return;
		}
		this._host.times.seed(point[1]!, point[0]!);
		for (let k = this._placed; k < drawing.count; k++) {
			drawing.setPoint(k, point[1]!, point[2]!);
		}
		drawing.pointsChanged();
		this._host.invalidateOverlay();
	}

	private _finishNew(): void {
		const drawing = this._editing!;
		this._endEdit(true);
		this._tool = null;
		this._toolOptions = undefined;
		this._state = IDLE;
		this.cursor = '';
		this._select(drawing);
		this._emit('created', drawing);
	}

	/** Takes a drawing out of the drawings layer onto the overlay while it is edited. */
	private _beginEdit(drawing: Drawing, view?: PaneViewState): void {
		this._editing = drawing;
		const layers = this._host.layers;
		let entry = layers.entryOf(drawing);
		if (entry === undefined) {
			// A new drawing: attached hidden, so it gets its geometry with the others but is drawn here.
			entry = layers.attach(drawing, view ?? this._viewOf(drawing.priceScaleId), this);
			this._host.times.active = true;
		}
		layers.setHidden(entry, true);
		this._host.invalidateOverlay();
	}

	/** Puts the edited drawing back into its layer (`keep`), or drops a new one. */
	private _endEdit(keep: boolean): void {
		const drawing = this._editing;
		this._editing = null;
		if (drawing === null) {
			return;
		}
		const layers = this._host.layers;
		const entry = layers.entryOf(drawing);
		const isNew = !this._byId.has(drawing.id);
		if (keep && entry !== undefined) {
			if (isNew) {
				this._byId.set(drawing.id, drawing);
				this._noteZ(drawing.zIndex);
			}
			layers.setHidden(entry, false);
		} else if (isNew) {
			drawing.alive = false;
			layers.detach(drawing);
		} else if (entry !== undefined) {
			layers.setHidden(entry, false);
		}
		this._host.invalidateOverlay();
	}

	private _remember(drawing: Drawing): void {
		for (let k = 0; k < drawing.count; k++) {
			this._startTimes[k] = drawing.times[k]!;
			this._startPrices[k] = drawing.prices[k]!;
			this._startLogical[k] = drawing.logical[k]!;
		}
	}

	/** Moves the dragged drawing, or its dragged point, for the pointer at `(x, y)`. */
	private _dragTo(x: number, y: number): void {
		const drawing = this._editing;
		if (drawing === null) {
			return;
		}
		const view = this._viewOf(drawing.priceScaleId);
		const times = this._host.times;
		if (this._dragHit > HIT_BODY) {
			const point = this._point;
			if (!this._pointAt(x, y, view, true, point, 0)) {
				return;
			}
			times.seed(point[1]!, point[0]!);
			drawing.moveHandle(this._dragHit - 1, point[1]!, point[2]!);
		} else {
			// The whole drawing moves by whole bars, and by the pointer's distance on the price axis.
			const shift = Math.round(view.xToLogical(x) - view.xToLogical(this._pressX));
			const dy = y - this._pressY;
			for (let k = 0; k < drawing.count; k++) {
				const start = this._startLogical[k]!;
				const position = start + shift;
				const time = shift === 0 ? this._startTimes[k]! : view.logicalToTime(position);
				const price = view.yToPrice(view.priceToY(this._startPrices[k]!) + dy);
				if (time !== time || price !== price) {
					return;
				}
				times.seed(time, position);
				drawing.setPoint(k, time, price);
			}
		}
		drawing.pointsChanged();
		this._host.invalidateOverlay();
	}

	/** Ends a press or drag: the moved drawing goes back to its layer (`commit`), or to where it was. */
	private _endDrag(commit: boolean): void {
		const drawing = this._pressedDrawing;
		const state = this._state;
		this._pressedDrawing = null;
		if (state !== DRAGGING && state !== PRESSED) {
			return;
		}
		this._state = IDLE;
		if (drawing === null || state === PRESSED) {
			return;
		}
		if (!commit) {
			for (let k = 0; k < drawing.count; k++) {
				drawing.setPoint(k, this._startTimes[k]!, this._startPrices[k]!);
			}
			drawing.pointsChanged();
		}
		this._endEdit(true);
		if (commit) {
			this._emit('changed', drawing);
		}
	}
}
