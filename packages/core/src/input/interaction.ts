import { INVALIDATE_CURSOR, INVALIDATE_LIGHT, type Invalidation } from '../model/invalidation';
import type { TimeScale } from '../model/time-scale';

export interface InteractionHost {
	/** The time scale that panning and zooming act on. */
	readonly scale: TimeScale;
	/** Size of the pane in CSS pixels. */
	paneWidth(): number;
	paneHeight(): number;
	invalidate(level: Invalidation): void;
	/** Position of the crosshair in CSS pixels relative to the pane, or hidden. */
	setCrosshair(x: number, y: number, visible: boolean): void;
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
 * Pointer and wheel input: dragging pans, the wheel and two-finger pinch zoom around the pointer,
 * a touch release keeps scrolling with decaying speed, and a hovering mouse moves the crosshair.
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
	}

	public destroy(): void {
		const element = this._element;
		element.removeEventListener('pointerdown', this._onDown);
		element.removeEventListener('pointermove', this._onMove);
		element.removeEventListener('pointerup', this._onUp);
		element.removeEventListener('pointercancel', this._onUp);
		element.removeEventListener('pointerleave', this._onLeave);
		element.removeEventListener('wheel', this._onWheel);
		this._pointers.clear();
		this._velocity = 0;
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
		this._pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
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
		pointer.x = event.clientX;
		pointer.y = event.clientY;
		if (this._pointers.size >= 2) {
			const distance = this._distance();
			if (this._pinchDistance > 0 && distance > 0) {
				const rect = this._element.getBoundingClientRect();
				let middle = 0;
				for (const other of this._pointers.values()) {
					middle += other.x;
				}
				host.scale.zoomAt(middle / this._pointers.size - rect.left, distance / this._pinchDistance);
				host.invalidate(INVALIDATE_LIGHT);
			}
			this._pinchDistance = distance;
			return;
		}
		if (dx !== 0) {
			host.scale.scrollBy(dx);
			host.invalidate(INVALIDATE_LIGHT);
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
		if (event.type !== 'pointerup' || event.pointerType !== 'touch' || this._pointers.size > 0) {
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
			host.scale.scrollBy(-deltaX);
		} else if (deltaY !== 0) {
			// Browsers report a trackpad pinch as a wheel event with the control key set and small deltas.
			const rate = event.ctrlKey ? PINCH_ZOOM_RATE : WHEEL_ZOOM_RATE;
			const rect = this._element.getBoundingClientRect();
			const x = Math.min(host.paneWidth(), Math.max(0, event.clientX - rect.left));
			host.scale.zoomAt(x, Math.exp(-deltaY * rate));
		}
		host.invalidate(INVALIDATE_LIGHT);
	};

	private _hover(event: PointerEvent): void {
		const host = this._host;
		const rect = this._element.getBoundingClientRect();
		const x = event.clientX - rect.left;
		const y = event.clientY - rect.top;
		const inside = x >= 0 && y >= 0 && x < host.paneWidth() && y < host.paneHeight();
		host.setCrosshair(x, y, inside);
		host.invalidate(INVALIDATE_CURSOR);
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
