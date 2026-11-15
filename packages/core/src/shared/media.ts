// Media queries shared by the charts of a window: one list and one listener for the device pixel
// ratio, one for the system color scheme, whatever the number of charts. A list is created with its
// first listener and let go with its last one.

/** The part of `Window` media queries need; charts may live in a window other than this script's. */
type View = Window & typeof globalThis;

interface MediaWatch {
	query: MediaQueryList | null;
	readonly listeners: Set<() => void>;
	/** Bound once, so the same function is added to and removed from the list. */
	readonly onChange: () => void;
}

const ratioWatches = new Map<View, MediaWatch>();
const schemeWatches = new Map<View, MediaWatch>();

function notify(watch: MediaWatch): void {
	// A listener may unsubscribe (a chart destroyed from another chart's handler); a set tolerates
	// removal while it is iterated.
	for (const listener of watch.listeners) {
		listener();
	}
}

function watchResolution(view: View, watch: MediaWatch): void {
	watch.query?.removeEventListener?.('change', watch.onChange);
	// The query matches only the current ratio, so it is replaced whenever it stops matching.
	watch.query = view.matchMedia(`(resolution: ${view.devicePixelRatio}dppx)`);
	watch.query.addEventListener?.('change', watch.onChange);
}

/**
 * Adds `listener` to the watch of `view`, creating it first if needed. `update` runs once to start
 * watching, with `query` still null, and again whenever the query changes. Returns the unsubscriber.
 */
function subscribe(
	watches: Map<View, MediaWatch>,
	view: View,
	listener: () => void,
	update: (watch: MediaWatch) => void,
): () => void {
	let watch = watches.get(view);
	if (watch === undefined) {
		const created: MediaWatch = { query: null, listeners: new Set(), onChange: () => update(created) };
		watch = created;
		watches.set(view, watch);
		update(watch);
	}
	const entry = watch;
	entry.listeners.add(listener);
	return () => {
		if (entry.listeners.delete(listener) && entry.listeners.size === 0) {
			entry.query?.removeEventListener?.('change', entry.onChange);
			entry.query = null;
			watches.delete(view);
		}
	};
}

/**
 * Calls `listener` when the device pixel ratio of `view` changes: the window moved to another
 * screen, or the page was zoomed. Returns a function that stops it, or null where media queries
 * are missing.
 */
export function watchPixelRatio(view: View | null, listener: () => void): (() => void) | null {
	if (view === null || typeof view.matchMedia !== 'function') {
		return null;
	}
	return subscribe(ratioWatches, view, listener, watch => {
		const changed = watch.query !== null;
		watchResolution(view, watch);
		if (changed) {
			notify(watch);
		}
	});
}

/** The system color scheme of a window, watched for as long as it is not released. */
export interface ColorSchemeWatch {
	/** Whether the system asks for a dark scheme right now. */
	readonly dark: boolean;
	release(): void;
}

/**
 * Calls `listener` when the system color scheme of `view` changes. Returns null where media
 * queries are missing.
 */
export function watchColorScheme(view: View | null, listener: () => void): ColorSchemeWatch | null {
	if (view === null || typeof view.matchMedia !== 'function') {
		return null;
	}
	const release = subscribe(schemeWatches, view, listener, watch => {
		if (watch.query === null) {
			watch.query = view.matchMedia('(prefers-color-scheme: dark)');
			watch.query.addEventListener?.('change', watch.onChange);
		} else {
			notify(watch);
		}
	});
	const query = schemeWatches.get(view)!.query;
	return {
		get dark(): boolean {
			return query?.matches === true;
		},
		release,
	};
}
