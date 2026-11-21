import { INVALIDATE_CURSOR, INVALIDATE_LIGHT, type Invalidation } from '../model/invalidation';
import type { TimeScale } from '../model/time-scale';

/**
 * Takes presses that land on something it edits (a drawing) instead of panning. Positions are CSS
 * pixels in the pane. Its calls come from `Interaction.resolve`, in the read phase of a frame.
 */
export interface PointerDelegate {
	/** Whether a press should wait for the next frame to learn whether it pans or is taken. */
	readonly active: boolean;
	/** A press; returns true to take the gesture, false to let it pan. */
	press(x: number, y: number, pointerType: string): boolean;
	/** The pointer of a taken gesture moved. */
	drag(x: number, y: number): void;
	/** The pointer of a taken gesture was released. */
	release(x: number, y: number): void;
	/** A taken gesture was cancelled by the browser. */
	cancelGesture(): void;
}

export interface InteractionHost {
	/** The time scale that panning and zooming act on. */
	readonly scale: TimeScale;
	/** Left edge of the pane in the chart element, in CSS pixels. */
	paneLeft(): number;
	/** Size of the pane in CSS pixels. */
	paneWidth(): number;
	paneHeight(): number;
	invalidate(level: Invalidation): void;
	/** Position of the crosshair in CSS pixels relative to the pane, or hidden. */
	setCrosshair(x: number, y: number, visible: boolean): void;
	/** Whether anyone listens for clicks; without listeners they are not looked for. */
	clicksWanted(): boolean;
	/** A click or tap in the pane that no drawing took, in CSS pixels relative to the pane. */
	click(x: number, y: number): void;
	/** The price axis drawn on `target` (the element under the pointer), or null. */
	priceAxisAt(target: EventTarget | null): AxisTarget | null;
	/** Moves the price scales that do not autoscale with a drag of `dy` CSS pixels. */
	scrollPrices(dy: number, y: number): void;
	/** What takes presses before they pan, if anything. */
	pointerDelegate(): PointerDelegate | null;
}

/** A price axis the pointer can act on. */
export interface AxisTarget {
	/** Scales the axis for a drag of `dy` CSS pixels, down showing more. */
	dragBy(dy: number): void;
	/** Turns autoscale back on. */
	resetScale(): void;
}

/** Slowest release speed that starts kinetic scrolling, in CSS pixels per millisecond. */
const KINETIC_MIN_SPEED = 0.2;
/** Speed at which kinetic scrolling stops. */
const KINETIC_STOP_SPEED = 0.02;
/** Fraction of the speed kept after each millisecond. */
const KINETIC_DAMPING = 0.997;
/** Movement older than this does not count toward the release speed, in milliseconds. */
const KINETIC_WINDOW = 100;
const WHEEL_ZOOM_RATE = 0.002;
const PINCH_ZOOM_RATE = 0.01;
const LINE_HEIGHT = 16;
/**
 * Farthest a press may move, in CSS pixels, and still be a click when released: as far as a press
 * on a drawing may move and still select it rather than drag it.
 */
const CLICK_SLOP_MOUSE = 3;
const CLICK_SLOP_TOUCH = 8;

/** Kinds of pending input, see `Interaction._ops`. */
const OP_PAN = 0;
const OP_WHEEL_ZOOM = 1;
const OP_PINCH_ZOOM = 2;
const OP_PRICE_PAN = 3;
const OP_STRIDE = 3;

/** Kinds of gesture input waiting for the frame, see `Interaction._gestures`. */
const GESTURE_PRESS = 0;
const GESTURE_MOVE = 1;
const GESTURE_RELEASE = 2;
const GESTURE_CANCEL = 3;
const GESTURE_STRIDE = 4;

/**
 * Pointer and wheel input: dragging pans, the wheel and two-finger pinch zoom around the pointer,
 * a touch release keeps scrolling with decaying speed, and a hovering mouse moves the crosshair.
 * Dragging a price axis scales it and a double click on one resets it; dragging the pane up or down
 * moves the price scales that do not autoscale. The axis under the pointer is the element the
 * event targets, which needs no layout read.
 *
 * Events carry positions in the viewport, and turning one into a position in the chart needs the
 * chart's place in the viewport, a layout read that can force a synchronous layout. The handlers
 * therefore only store what the event says; `resolve` reads the element's rectangle once and
 * applies everything stored, in the read phase of the next frame. The rectangle is never kept: it
 * changes whenever the page scrolls, without any resize.
 */
export class Interaction {
	private readonly _element: HTMLElement;
	private readonly _host: InteractionHost;
	private readonly _pointers = new Map<number, { x: number; y: number }>();
	private _pinchDistance = 0;
	private _velocity = 0;
	private _lastStep = 0;
	private _sampleTime = 0;
	private _sampleX = 0;
	private _previousTime = 0;
	private _previousX = 0;
	/**
	 * Input that waits for the element's rectangle, in arrival order: triples of a kind, the client
	 * x of the anchor and a zoom factor; for a pan that follows a waiting zoom, the distance.
	 */
	private _ops = new Float64Array(8 * OP_STRIDE);
	private _opCount = 0;
	/** Latest hover position in the viewport, when one waits to be applied. */
	private _hoverPending = false;
	private _hoverX = 0;
	private _hoverY = 0;
	/** The price axis being dragged, from the press of the first pointer. */
	private _axis: AxisTarget | null = null;
	/**
	 * Presses, moves and releases of the pointer pressed first, while a delegate is active: whether
	 * the delegate takes a gesture depends on where the press is in the pane, a layout read that
	 * waits for the frame. Until then they queue, in arrival order, as quadruples of a kind, the
	 * client position and whether the pointer is a mouse (0) or not (1); consecutive moves merge.
	 */
	private _gestures = new Float64Array(8 * GESTURE_STRIDE);
	private _gestureCount = 0;
	/** Pointer whose gesture queues, or -1; where its queued input starts, or -1 once answered. */
	private _gesturePointer = -1;
	private _gestureStart = -1;
	/** Whether the delegate took the gesture of `_gesturePointer` (known once its press is answered). */
	private _gestureTaken = false;
	/** Client position of the last queued input of a gesture answered not taken, which pans from there. */
	private _gestureX = 0;
	private _gestureY = 0;
	private _pressClientY = 0;
	private _delegatePressY = 0;
	/** The pointer whose press may still be a click, or -1; where it was pressed, and how far it may move. */
	private _clickPointer = -1;
	private _clickX = 0;
	private _clickY = 0;
	private _clickSlop = 0;
	/** Whether that press went to the delegate, which may take it. */
	private _clickDelegated = false;
	/** Whether the delegate took the last press it was asked about. */
	private _pressTaken = false;
	/** A click released and waiting for the element's rectangle, at its client position. */
	private _clickPending = false;
	private _clickPendingDelegated = false;
	private _clickPendingX = 0;
	private _clickPendingY = 0;

	public constructor(element: HTMLElement, host: InteractionHost) {
		this._element = element;
		this._host = host;
		element.style.touchAction = 'none';
		element.style.userSelect = 'none';
		element.style.cursor = 'crosshair';
		element.addEventListener('pointerdown', this._onDown);
		element.addEventListener('pointermove', this._onMove);
		element.addEventListener('pointerup', this._onUp);
		element.addEventListener('pointercancel', this._onUp);
		element.addEventListener('pointerleave', this._onLeave);
		element.addEventListener('wheel', this._onWheel, { passive: false });
		element.addEventListener('dblclick', this._onDoubleClick);
	}

	public destroy(): void {
		const element = this._element;
		element.removeEventListener('pointerdown', this._onDown);
		element.removeEventListener('pointermove', this._onMove);
		element.removeEventListener('pointerup', this._onUp);
		element.removeEventListener('pointercancel', this._onUp);
		element.removeEventListener('pointerleave', this._onLeave);
		element.removeEventListener('wheel', this._onWheel);
		element.removeEventListener('dblclick', this._onDoubleClick);
		this._pointers.clear();
		this._axis = null;
		this._velocity = 0;
		this._opCount = 0;
		this._hoverPending = false;
		this._gestureCount = 0;
		this._gesturePointer = -1;
		this._clickPointer = -1;
		this._clickPending = false;
	}

	/**
	 * Applies the input stored since the last call, reading the element's rectangle at most once.
	 * Runs in the read phase of a frame, and before anything that depends on the view being current.
	 */
	public resolve(): void {
		if (this._opCount === 0 && !this._hoverPending && this._gestureCount === 0 && !this._clickPending) {
			return;
		}
		const host = this._host;
		const rect = this._element.getBoundingClientRect();
		const ops = this._ops;
		const end = this._opCount * OP_STRIDE;
		this._opCount = 0;
		for (let i = 0; i < end; i += OP_STRIDE) {
			const kind = ops[i]!;
			const value = ops[i + 2]!;
			if (kind === OP_PAN) {
				host.scale.scrollBy(value);
			} else if (kind === OP_PRICE_PAN) {
				host.scrollPrices(value, ops[i + 1]! - rect.top);
			} else {
				const x = ops[i + 1]! - rect.left;
				host.scale.zoomAt(kind === OP_WHEEL_ZOOM ? Math.min(host.paneWidth(), Math.max(0, x)) : x, value);
			}
		}
		if (this._gestureCount > 0) {
			this._resolveGestures(rect.left + host.paneLeft(), rect.top);
		}
		if (this._hoverPending) {
			this._hoverPending = false;
			const x = this._hoverX - rect.left - host.paneLeft();
			const y = this._hoverY - rect.top;
			const inside = x >= 0 && y >= 0 && x < host.paneWidth() && y < host.paneHeight();
			host.setCrosshair(x, y, inside);
		}
		if (this._clickPending) {
			this._clickPending = false;
			// The press it ended went to the delegate, which answered above at the latest.
			if (!this._clickPendingDelegated || !this._pressTaken) {
				const x = this._clickPendingX - rect.left - host.paneLeft();
				const y = this._clickPendingY - rect.top;
				if (x >= 0 && y >= 0 && x < host.paneWidth() && y < host.paneHeight()) {
					host.click(x, y);
				}
			}
		}
	}

	/**
	 * Hands the queued gesture input to the delegate in order: a press it takes sends it the moves
	 * and the release that follow; any other press pans by the moves that follow instead.
	 */
	private _resolveGestures(left: number, top: number): void {
		const host = this._host;
		const delegate = host.pointerDelegate();
		const gestures = this._gestures;
		const end = this._gestureCount * GESTURE_STRIDE;
		this._gestureCount = 0;
		let taken = this._gestureTaken;
		let lastX = this._gestureX;
		let lastY = this._gestureY;
		for (let i = 0; i < end; i += GESTURE_STRIDE) {
			const kind = gestures[i]!;
			const clientX = gestures[i + 1]!;
			const clientY = gestures[i + 2]!;
			const x = clientX - left;
			const y = clientY - top;
			if (kind === GESTURE_PRESS) {
				this._delegatePressY = clientY;
				taken = delegate !== null && delegate.press(x, y, gestures[i + 3] === 0 ? 'mouse' : 'touch');
				this._pressTaken = taken;
			} else if (taken && delegate !== null) {
				if (kind === GESTURE_MOVE) {
					delegate.drag(x, y);
				} else if (kind === GESTURE_RELEASE) {
					delegate.release(x, y);
				} else {
					delegate.cancelGesture();
				}
			} else {
				if (clientX !== lastX) {
					host.scale.scrollBy(clientX - lastX);
					host.invalidate(INVALIDATE_LIGHT);
				}
				if (clientY !== lastY) {
					host.scrollPrices(clientY - lastY, this._delegatePressY - top);
				}
			}
			lastX = clientX;
			lastY = clientY;
			if (kind === GESTURE_RELEASE || kind === GESTURE_CANCEL) {
				taken = false;
			}
		}
		this._gestureTaken = taken;
		this._gestureX = lastX;
		this._gestureY = lastY;
		if (this._gesturePointer >= 0) {
			// The gesture goes on: a taken one keeps queueing, any other pans as it moves from now on.
			this._gestureStart = -1;
			if (!taken) {
				this._gesturePointer = -1;
			}
		}
	}

	private _pushGesture(kind: number, event: PointerEvent): void {
		let gestures = this._gestures;
		let at = this._gestureCount * GESTURE_STRIDE;
		if (kind === GESTURE_MOVE && at > 0 && gestures[at - GESTURE_STRIDE] === GESTURE_MOVE) {
			// Only where the pointer went matters, not the way there.
			at -= GESTURE_STRIDE;
			this._gestureCount--;
		}
		if (at === gestures.length) {
			gestures = new Float64Array(gestures.length * 2);
			gestures.set(this._gestures);
			this._gestures = gestures;
		}
		gestures[at] = kind;
		gestures[at + 1] = event.clientX;
		gestures[at + 2] = event.clientY;
		gestures[at + 3] = event.pointerType === 'mouse' ? 0 : 1;
		this._gestureCount++;
		this._host.invalidate(INVALIDATE_CURSOR);
	}

	/** Advances kinetic scrolling to `now`. Returns true while it is still moving. */
	public step(now: number): boolean {
		if (this._velocity === 0) {
			return false;
		}
		const elapsed = Math.min(64, now - this._lastStep);
		this._lastStep = now;
		if (elapsed > 0) {
			this._host.scale.scrollBy(this._velocity * elapsed);
			this._velocity *= KINETIC_DAMPING ** elapsed;
		}
		if (Math.abs(this._velocity) < KINETIC_STOP_SPEED) {
			this._velocity = 0;
			return false;
		}
		return true;
	}

	private readonly _onDown = (event: PointerEvent): void => {
		if (event.pointerType === 'mouse' && event.button !== 0) {
			return;
		}
		this._velocity = 0;
		// A second pointer makes a pinch or a pan of the first, not a click.
		this._clickPointer = -1;
		if (this._pointers.size === 0) this._pressClientY = event.clientY;
		if (this._gesturePointer >= 0) {
			if (this._gestureStart < 0) {
				// The gesture in progress is taken: one pointer edits, others wait until it is released.
				return;
			}
			// A second finger before the press was answered: a pinch, which is never a drawing's. The
			// first finger's queued input goes, and it pans by what it moved.
			const first = this._pointers.get(this._gesturePointer);
			const at = this._gestureStart * GESTURE_STRIDE;
			const pressX = this._gestures[at + 1]!;
			const pressY = this._gestures[at + 2]!;
			this._gestureCount = this._gestureStart;
			this._gesturePointer = -1;
			this._gestureStart = -1;
			if (first !== undefined && first.x !== pressX) {
				this._pan(first.x - pressX);
				this._host.invalidate(INVALIDATE_LIGHT);
			}
			if (first !== undefined && first.y !== pressY) {
				this._push(OP_PRICE_PAN, pressY, first.y - pressY);
				this._host.invalidate(INVALIDATE_CURSOR);
			}
		} else if (this._pointers.size === 0 && this._host.priceAxisAt(event.target) === null) {
			// Not on a price axis, which the pointer scales whatever drawings there are.
			const delegate = this._host.pointerDelegate();
			if (delegate !== null && delegate.active) {
				this._gesturePointer = event.pointerId;
				this._gestureStart = this._gestureCount;
				this._pushGesture(GESTURE_PRESS, event);
			}
		}
		this._pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
		this._axis = this._pointers.size === 1 ? this._host.priceAxisAt(event.target) : null;
		if (this._pointers.size === 1 && this._axis === null) {
			this._clickPointer = event.pointerId;
			this._clickX = event.clientX;
			this._clickY = event.clientY;
			this._clickSlop = event.pointerType === 'mouse' ? CLICK_SLOP_MOUSE : CLICK_SLOP_TOUCH;
			this._clickDelegated = this._gesturePointer === event.pointerId;
		}
		this._element.setPointerCapture?.(event.pointerId);
		this._pinchDistance = this._distance();
		this._sampleTime = event.timeStamp;
		this._sampleX = event.clientX;
		this._previousTime = event.timeStamp;
		this._previousX = event.clientX;
	};

	private readonly _onMove = (event: PointerEvent): void => {
		const host = this._host;
		const pointer = this._pointers.get(event.pointerId);
		if (pointer === undefined) {
			if (event.pointerType !== 'touch') {
				this._hover(event);
			}
			return;
		}
		const dx = event.clientX - pointer.x;
		const dy = event.clientY - pointer.y;
		pointer.x = event.clientX;
		pointer.y = event.clientY;
		if (event.pointerId === this._clickPointer) {
			const fromX = event.clientX - this._clickX;
			const fromY = event.clientY - this._clickY;
			if (fromX * fromX + fromY * fromY > this._clickSlop * this._clickSlop) {
				// A drag.
				this._clickPointer = -1;
			}
		}
		if (event.pointerId === this._gesturePointer) {
			this._pushGesture(GESTURE_MOVE, event);
			if (event.pointerType !== 'touch') {
				this._hover(event);
			}
			return;
		}
		if (this._pointers.size >= 2) {
			const distance = this._distance();
			if (this._pinchDistance > 0 && distance > 0) {
				let middle = 0;
				for (const other of this._pointers.values()) {
					middle += other.x;
				}
				this._push(OP_PINCH_ZOOM, middle / this._pointers.size, distance / this._pinchDistance);
				host.invalidate(INVALIDATE_LIGHT);
			}
			this._pinchDistance = distance;
			return;
		}
		if (this._axis !== null) {
			this._axis.dragBy(dy);
			return;
		}
		if (dx !== 0) {
			this._pan(dx);
			host.invalidate(INVALIDATE_LIGHT);
		}
		if (dy !== 0) {
			this._push(OP_PRICE_PAN, this._pressClientY, dy);
			host.invalidate(INVALIDATE_CURSOR);
		}
		// Keep two samples at least a few milliseconds apart to measure the release speed from.
		if (event.timeStamp - this._sampleTime > KINETIC_WINDOW / 2) {
			this._previousTime = this._sampleTime;
			this._previousX = this._sampleX;
			this._sampleTime = event.timeStamp;
			this._sampleX = event.clientX;
		}
		if (event.pointerType !== 'touch') {
			this._hover(event);
		}
	};

	private readonly _onUp = (event: PointerEvent): void => {
		if (!this._pointers.delete(event.pointerId)) {
			return;
		}
		this._element.releasePointerCapture?.(event.pointerId);
		this._pinchDistance = this._distance();
		if (event.pointerId === this._clickPointer) {
			this._clickPointer = -1;
			if (event.type === 'pointerup' && this._host.clicksWanted()) {
				// Where it is in the pane, and whether a drawing took it, is known in the next frame.
				this._clickPending = true;
				this._clickPendingDelegated = this._clickDelegated;
				this._clickPendingX = event.clientX;
				this._clickPendingY = event.clientY;
				this._host.invalidate(INVALIDATE_CURSOR);
			}
		}
		if (event.pointerId === this._gesturePointer) {
			this._pushGesture(event.type === 'pointerup' ? GESTURE_RELEASE : GESTURE_CANCEL, event);
			this._gesturePointer = -1;
			this._gestureStart = -1;
			return;
		}
		const scaledAxis = this._axis !== null;
		if (this._pointers.size === 0) {
			this._axis = null;
		}
		if (event.type !== 'pointerup' || event.pointerType !== 'touch' || this._pointers.size > 0 || scaledAxis) {
			return;
		}
		const elapsed = event.timeStamp - this._previousTime;
		if (elapsed <= 0 || elapsed > KINETIC_WINDOW * 2) {
			return;
		}
		const velocity = (event.clientX - this._previousX) / elapsed;
		if (Math.abs(velocity) >= KINETIC_MIN_SPEED) {
			this._velocity = velocity;
			this._lastStep = event.timeStamp;
			this._host.invalidate(INVALIDATE_LIGHT);
		}
	};

	private readonly _onLeave = (event: PointerEvent): void => {
		if (!this._pointers.has(event.pointerId)) {
			this._hoverPending = false;
			this._host.setCrosshair(0, 0, false);
			this._host.invalidate(INVALIDATE_CURSOR);
		}
	};

	private readonly _onWheel = (event: WheelEvent): void => {
		event.preventDefault();
		const host = this._host;
		const unit = event.deltaMode === 1 ? LINE_HEIGHT : event.deltaMode === 2 ? host.paneHeight() : 1;
		const deltaX = event.deltaX * unit;
		const deltaY = event.deltaY * unit;
		this._velocity = 0;
		if (!event.ctrlKey && Math.abs(deltaX) > Math.abs(deltaY)) {
			this._pan(-deltaX);
		} else if (deltaY !== 0) {
			// Browsers report a trackpad pinch as a wheel event with the control key set and small deltas.
			const rate = event.ctrlKey ? PINCH_ZOOM_RATE : WHEEL_ZOOM_RATE;
			this._push(OP_WHEEL_ZOOM, event.clientX, Math.exp(-deltaY * rate));
		}
		host.invalidate(INVALIDATE_LIGHT);
	};

	private readonly _onDoubleClick = (event: MouseEvent): void => {
		this._host.priceAxisAt(event.target)?.resetScale();
	};

	private _hover(event: PointerEvent): void {
		this._hoverPending = true;
		this._hoverX = event.clientX;
		this._hoverY = event.clientY;
		this._host.invalidate(INVALIDATE_CURSOR);
	}

	/** Pans at once, or after the zooms that wait: a pan and a zoom do not commute. */
	private _pan(dx: number): void {
		if (this._opCount === 0) {
			this._host.scale.scrollBy(dx);
		} else {
			this._push(OP_PAN, 0, dx);
		}
	}

	private _push(kind: number, anchor: number, value: number): void {
		let ops = this._ops;
		let offset = this._opCount * OP_STRIDE;
		if (offset === ops.length) {
			ops = new Float64Array(ops.length * 2);
			ops.set(this._ops);
			this._ops = ops;
		}
		ops[offset++] = kind;
		ops[offset++] = anchor;
		ops[offset] = value;
		this._opCount++;
	}

	private _distance(): number {
		if (this._pointers.size < 2) {
			return 0;
		}
		let first: { x: number; y: number } | undefined;
		for (const pointer of this._pointers.values()) {
			if (first === undefined) {
				first = pointer;
			} else {
				return Math.hypot(pointer.x - first.x, pointer.y - first.y);
			}
		}
		return 0;
	}
}
