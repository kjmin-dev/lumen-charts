// One ResizeObserver and one IntersectionObserver for every chart of the page. A browser batches
// the elements of one observer into one callback per frame; an observer per chart gives a callback
// per chart instead. Both are created with the first element and dropped with the last one.

/** Receives the size of an element's content box in CSS pixels, fractions included. */
export type SizeListener = (width: number, height: number) => void;

const sizeListeners = new Map<Element, SizeListener>();
let resizeObserver: ResizeObserver | null = null;

function onResize(entries: ResizeObserverEntry[]): void {
	for (const entry of entries) {
		// `contentRect` rather than `contentBoxSize`: it has physical axes, so a vertical writing mode
		// does not swap width and height. Both leave out padding, borders and CSS transforms.
		const rect = entry.contentRect;
		sizeListeners.get(entry.target)?.(rect.width, rect.height);
	}
}

/**
 * Reports the content box of `element` whenever it changes, and once after the next layout.
 * Returns false where `ResizeObserver` is missing; the caller then has to measure by itself.
 */
export function observeSize(element: Element, listener: SizeListener): boolean {
	if (typeof ResizeObserver === 'undefined') {
		return false;
	}
	resizeObserver ??= new ResizeObserver(onResize);
	sizeListeners.set(element, listener);
	resizeObserver.observe(element);
	return true;
}

export function unobserveSize(element: Element): void {
	if (!sizeListeners.delete(element) || resizeObserver === null) {
		return;
	}
	if (sizeListeners.size === 0) {
		resizeObserver.disconnect();
		resizeObserver = null;
	} else {
		resizeObserver.unobserve(element);
	}
}

/** Receives whether any part of an element is inside the viewport. */
export type VisibilityListener = (visible: boolean) => void;

const visibilityListeners = new Map<Element, VisibilityListener>();
let intersectionObserver: IntersectionObserver | null = null;

function onIntersection(entries: IntersectionObserverEntry[]): void {
	for (const entry of entries) {
		visibilityListeners.get(entry.target)?.(entry.isIntersecting);
	}
}

/**
 * Reports whether `element` is in the viewport: once after the next layout, then on every change.
 * An element scrolled out of view, clipped by a scrolling ancestor or not displayed is not visible.
 * Returns false where `IntersectionObserver` is missing; the element then counts as visible.
 */
export function observeVisibility(element: Element, listener: VisibilityListener): boolean {
	if (typeof IntersectionObserver === 'undefined') {
		return false;
	}
	intersectionObserver ??= new IntersectionObserver(onIntersection);
	visibilityListeners.set(element, listener);
	intersectionObserver.observe(element);
	return true;
}

export function unobserveVisibility(element: Element): void {
	if (!visibilityListeners.delete(element) || intersectionObserver === null) {
		return;
	}
	if (visibilityListeners.size === 0) {
		intersectionObserver.disconnect();
		intersectionObserver = null;
	} else {
		intersectionObserver.unobserve(element);
	}
}
