// One ResizeObserver for every chart of the page. A browser batches the elements of one observer
// into one callback per frame; an observer per chart gives a callback per chart instead. It is
// created with the first element and dropped with the last one.

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
